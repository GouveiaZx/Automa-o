import type { FastifyInstance } from 'fastify';
import { scheduleJobSchema, scheduleBulkSchema, scheduleBulkMultiSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { bus } from '../../events.js';
import { appLog } from '../../logger.js';
import { nextSlots } from '../../automation/scheduler.js';

// Fisher-Yates shuffle in-place. Usado no bulk pra ordem aleatoria de midias
// (mistura foto + video pra ficar mais natural, em vez de postar tudo em
// ordem de createdAt).
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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

    // Embaralha pra mistura natural (ex: foto + video alternando) em vez
    // de sair tudo na ordem de createdAt.
    shuffleInPlace(medias);

    const now = Date.now();
    const created = [];

    // Modo "campaign": usa fixedTimes/intervalo da propria campanha pra distribuir.
    // Se a conta nao tem campanha, cai pro fallback de janela 'today'.
    const useCampaign = parsed.data.spreadOver === 'campaign' && account.campaign;
    const slotDates = useCampaign
      ? nextSlots(
          {
            minIntervalMin: account.campaign!.minIntervalMin,
            maxIntervalMin: account.campaign!.maxIntervalMin,
            windowStart: account.campaign!.windowStart,
            windowEnd: account.campaign!.windowEnd,
            fixedTimes: account.campaign!.fixedTimes,
          },
          medias.length,
          new Date(now)
        )
      : (() => {
          const windowMs = (() => {
            switch (parsed.data.spreadOver) {
              case 'now':
                return 0;
              case 'hour':
                return 60 * 60 * 1000;
              case '24h':
                return 24 * 60 * 60 * 1000;
              case 'today':
              case 'campaign':
              default: {
                const end = new Date();
                end.setHours(23, 59, 0, 0);
                return Math.max(end.getTime() - now, 60 * 60 * 1000);
              }
            }
          })();
          return medias.map((_, i) => {
            const offset = medias.length === 1 ? 0 : (windowMs / medias.length) * i;
            return new Date(now + offset);
          });
        })();

    for (let i = 0; i < medias.length; i++) {
      const job = await prisma.postJob.create({
        data: {
          accountId: account.id,
          mediaId: medias[i].id,
          type: medias[i].type,
          status: 'queued',
          scheduledFor: slotDates[i],
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

  // Schedule-bulk-multi: agenda as MESMAS midias em N contas (loop sobre cada conta).
  // Cada conta recebe N jobs (1 por midia). Total: contas x midias jobs.
  app.post('/jobs/schedule-bulk-multi', async (req, reply) => {
    const parsed = scheduleBulkMultiSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const accounts = await prisma.instagramAccount.findMany({
      where: { id: { in: parsed.data.accountIds } },
      include: { adsPowerProfile: true, campaign: true },
    });
    if (accounts.length !== parsed.data.accountIds.length) {
      return reply.status(404).send({ error: 'some_account_not_found' });
    }
    const accountsWithoutProfile = accounts.filter((a) => !a.adsPowerProfileId);
    if (accountsWithoutProfile.length > 0) {
      return reply.status(400).send({
        error: 'some_account_without_profile',
        usernames: accountsWithoutProfile.map((a) => a.username),
      });
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
        case 'campaign':
        default: {
          const end = new Date();
          end.setHours(23, 59, 0, 0);
          return Math.max(end.getTime() - now, 60 * 60 * 1000);
        }
      }
    })();

    let totalCreated = 0;
    for (const account of accounts) {
      // Modo "campaign": cada conta usa fixedTimes da SUA campanha. Se conta nao tem campanha,
      // cai pra janela 'today'. Cada conta tem seus proprios slots.
      const useCampaign = parsed.data.spreadOver === 'campaign' && account.campaign;
      const slotDates = useCampaign
        ? nextSlots(
            {
              minIntervalMin: account.campaign!.minIntervalMin,
              maxIntervalMin: account.campaign!.maxIntervalMin,
              windowStart: account.campaign!.windowStart,
              windowEnd: account.campaign!.windowEnd,
              fixedTimes: account.campaign!.fixedTimes,
            },
            medias.length,
            new Date(now)
          )
        : medias.map((_, i) => {
            const offset = medias.length === 1 ? 0 : (windowMs / medias.length) * i;
            // Jitter pra nao postar todas no mesmo segundo entre contas
            const accountJitter = Math.floor(Math.random() * 60_000);
            return new Date(now + offset + accountJitter);
          });

      // Embaralha midias POR CONTA — cada conta posta na ordem dela
      // (foto e video alternando aleatorio em vez de todas igual).
      const shuffledMedias = shuffleInPlace([...medias]);

      for (let i = 0; i < shuffledMedias.length; i++) {
        const job = await prisma.postJob.create({
          data: {
            accountId: account.id,
            mediaId: shuffledMedias[i].id,
            type: shuffledMedias[i].type,
            status: 'queued',
            scheduledFor: slotDates[i],
          },
          include: { account: true, media: true },
        });
        totalCreated++;
        bus.emitEvent({ type: 'job-update', payload: serializeJob(job) });
      }
    }

    await appLog({
      source: 'api',
      level: 'info',
      message: `Bulk-multi scheduled ${totalCreated} job(s) em ${accounts.length} conta(s) com ${medias.length} midia(s) (spread=${parsed.data.spreadOver})`,
    });
    return { count: totalCreated, accounts: accounts.length, medias: medias.length };
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

  // Apaga em lote jobs com status especifico (default: done).
  // Util pra limpar fila de concluidos sem precisar deletar 1 por 1.
  app.delete('/jobs', async (req) => {
    const q = req.query as { status?: string };
    const status = q.status ?? 'done';
    // Por seguranca, nunca apaga jobs running em batch.
    if (status === 'running') {
      return { count: 0, error: 'cannot_bulk_delete_running' };
    }
    const result = await prisma.postJob.deleteMany({ where: { status } });
    await appLog({
      source: 'api',
      level: 'info',
      message: `Bulk delete: ${result.count} job(s) com status=${status} apagado(s)`,
    });
    return { count: result.count };
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
    type: j.type as 'story' | 'reel' | 'photo',
    status: j.status as 'queued' | 'running' | 'done' | 'failed' | 'retry',
    attempts: j.attempts,
    scheduledFor: j.scheduledFor.toISOString(),
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    errorMessage: j.errorMessage,
    createdAt: j.createdAt.toISOString(),
  };
}
