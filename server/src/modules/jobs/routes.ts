import type { FastifyInstance } from 'fastify';
import { scheduleJobSchema, scheduleBulkSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { bus } from '../../events.js';
import { appLog } from '../../logger.js';

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/jobs', async (req) => {
    const q = req.query as {
      status?: string;
      accountId?: string;
      from?: string;
      to?: string;
      limit?: string;
    };
    const limit = Math.min(Number(q.limit ?? 200), 500);
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (q.from) {
      const d = new Date(q.from);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (q.to) {
      const d = new Date(q.to);
      if (!isNaN(d.getTime())) dateFilter.lte = d;
    }
    return prisma.postJob.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.accountId ? { accountId: q.accountId } : {}),
        ...(Object.keys(dateFilter).length ? { scheduledFor: dateFilter } : {}),
      },
      include: { account: true, media: true },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
      take: limit,
    });
  });

  app.post('/jobs/schedule', async (req, reply) => {
    const parsed = scheduleJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const account = await prisma.instagramAccount.findUnique({
      where: { id: parsed.data.accountId },
      include: { adsPowerProfile: true },
    });
    if (!account) return reply.status(404).send({ error: 'account_not_found' });
    if (!account.adsPowerProfileId) {
      return reply.status(400).send({ error: 'account_without_profile' });
    }
    const media = await prisma.mediaItem.findUnique({ where: { id: parsed.data.mediaId } });
    if (!media) return reply.status(404).send({ error: 'media_not_found' });

    const scheduledFor = parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : new Date();
    const job = await prisma.postJob.create({
      data: {
        accountId: account.id,
        mediaId: media.id,
        type: media.type,
        status: 'queued',
        scheduledFor,
      },
      include: { account: true, media: true },
    });

    bus.emitEvent({ type: 'job-update', payload: serializeJob(job) });
    await appLog({
      level: 'info',
      source: 'api',
      message: `Job agendado: ${media.type} para @${account.username}`,
      accountId: account.id,
      jobId: job.id,
    });
    return job;
  });

  app.post('/jobs/schedule-bulk', async (req, reply) => {
    const parsed = scheduleBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const account = await prisma.instagramAccount.findUnique({
      where: { id: parsed.data.accountId },
      include: { campaign: true },
    });
    if (!account) return reply.status(404).send({ error: 'account_not_found' });
    if (!account.adsPowerProfileId) {
      return reply.status(400).send({ error: 'account_without_profile' });
    }
    const medias = await prisma.mediaItem.findMany({
      where: { id: { in: parsed.data.mediaIds } },
    });
    if (medias.length !== parsed.data.mediaIds.length) {
      return reply.status(404).send({ error: 'some_media_not_found' });
    }

    const now = Date.now();
    const windowMs = (() => {
      switch (parsed.data.spreadOver) {
        case 'now':
          return 0;
        case 'hour':
          return 60 * 60 * 1000;
        case '24h':
          return 24 * 60 * 60 * 1000;
        case 'today':
        default: {
          const end = new Date();
          end.setHours(23, 59, 0, 0);
          return Math.max(end.getTime() - now, 60 * 60 * 1000);
        }
      }
    })();

    const slots = medias.length;
    const created = [];
    for (let i = 0; i < slots; i++) {
      const offset = slots === 1 ? 0 : (windowMs / slots) * i;
      const scheduledFor = new Date(now + offset);
      const job = await prisma.postJob.create({
        data: {
          accountId: account.id,
          mediaId: medias[i].id,
          type: medias[i].type,
          status: 'queued',
          scheduledFor,
        },
        include: { account: true, media: true },
      });
      created.push(job);
      bus.emitEvent({ type: 'job-update', payload: serializeJob(job) });
    }
    await appLog({
      source: 'api',
      level: 'info',
      message: `Bulk scheduled ${created.length} job(s) para @${account.username} (spread=${parsed.data.spreadOver})`,
      accountId: account.id,
    });
    return { count: created.length, jobs: created };
  });

  app.post('/jobs/:id/retry', {
    // Evita spam de retry no mesmo job (UI ou script). 30/min eh folgado pra uso normal.
    config: { rateLimit: { max: 30, timeWindow: '1 minute', allowList: () => false } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.postJob.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: 'not_found' });
    if (existing.status === 'running') return reply.status(409).send({ error: 'job_running' });

    const job = await prisma.postJob.update({
      where: { id },
      data: {
        status: 'queued',
        scheduledFor: new Date(),
        attempts: 0,
        errorMessage: null,
      },
      include: { account: true, media: true },
    });
    bus.emitEvent({ type: 'job-update', payload: serializeJob(job) });
    return job;
  });

  app.delete('/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.postJob.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: 'not_found' });
    if (existing.status === 'running') return reply.status(409).send({ error: 'job_running' });
    await prisma.postJob.delete({ where: { id } });
    return { ok: true };
  });
}

function serializeJob(j: {
  id: string;
  accountId: string;
  mediaId: string;
  type: string;
  status: string;
  attempts: number;
  scheduledFor: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    id: j.id,
    accountId: j.accountId,
    mediaId: j.mediaId,
    type: j.type as 'story' | 'reel',
    status: j.status as 'queued' | 'running' | 'done' | 'failed' | 'retry',
    attempts: j.attempts,
    scheduledFor: j.scheduledFor.toISOString(),
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    errorMessage: j.errorMessage,
    createdAt: j.createdAt.toISOString(),
  };
}
