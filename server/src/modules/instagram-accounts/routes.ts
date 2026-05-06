import type { FastifyInstance } from 'fastify';
import { instagramAccountInputSchema, accountStatusUpdateSchema, syncBioSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { bus } from '../../events.js';
import { getDriver } from '../../automation/driver.js';
import { appLog } from '../../logger.js';

export async function instagramAccountRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/accounts', async () =>
    prisma.instagramAccount.findMany({
      include: { campaign: true, adsPowerProfile: true },
      orderBy: { username: 'asc' },
    })
  );

  app.get('/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = await prisma.instagramAccount.findUnique({
      where: { id },
      include: { campaign: true, adsPowerProfile: true, jobs: { take: 20, orderBy: { createdAt: 'desc' } } },
    });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    return item;
  });

  app.post('/accounts', async (req, reply) => {
    const parsed = instagramAccountInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    try {
      return await prisma.instagramAccount.create({
        data: {
          username: parsed.data.username,
          displayName: parsed.data.displayName ?? null,
          bio: parsed.data.bio ?? null,
          websiteUrl: parsed.data.websiteUrl ?? null,
          groupName: parsed.data.groupName ?? null,
          campaignId: parsed.data.campaignId ?? null,
          adsPowerProfileId: parsed.data.adsPowerProfileId ?? null,
        },
        include: { campaign: true, adsPowerProfile: true },
      });
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { target?: string[] } };
      if (e.code === 'P2002') {
        return reply.status(409).send({ error: 'duplicate', target: e.meta?.target });
      }
      throw err;
    }
  });

  app.put('/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = instagramAccountInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    try {
      const updated = await prisma.instagramAccount.update({
        where: { id },
        data: parsed.data,
        include: { campaign: true, adsPowerProfile: true },
      });
      bus.emitEvent({
        type: 'account-update',
        payload: serializeAccount(updated),
      });
      return updated;
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });

  app.patch('/accounts/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = accountStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input' });
    }
    try {
      const updated = await prisma.instagramAccount.update({
        where: { id },
        data: {
          status: parsed.data.status,
          consecutiveFails: parsed.data.status === 'active' ? 0 : undefined,
        },
        include: { campaign: true, adsPowerProfile: true },
      });
      bus.emitEvent({
        type: 'account-update',
        payload: serializeAccount(updated),
      });
      return updated;
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });

  app.post('/accounts/:id/sync-bio', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = syncBioSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_input', details: parsed.error.flatten() });
    }
    const account = await prisma.instagramAccount.findUnique({
      where: { id },
      include: { adsPowerProfile: true },
    });
    if (!account) return reply.status(404).send({ error: 'account_not_found' });
    if (!account.adsPowerProfile) {
      return reply.status(400).send({ error: 'account_without_profile' });
    }

    const bioFinal = parsed.data.bio !== undefined ? parsed.data.bio : account.bio;
    const websiteUrlFinal =
      parsed.data.websiteUrl !== undefined ? parsed.data.websiteUrl : account.websiteUrl;

    if (!bioFinal && !websiteUrlFinal) {
      return reply.status(400).send({ error: 'nothing_to_sync', hint: 'Cadastre bio ou websiteUrl primeiro' });
    }

    const driver = getDriver();
    const adsId = account.adsPowerProfile.adsPowerId;

    await appLog({
      source: 'api',
      level: 'info',
      message: `Sincronizando bio de @${account.username}`,
      accountId: account.id,
    });

    try {
      const opened = await driver.openProfile(adsId);
      if (!opened.ok) return reply.status(502).send({ ok: false, step: 'open', reason: opened.reason });

      const result = await driver.updateBio({
        adsPowerId: adsId,
        bio: bioFinal,
        websiteUrl: websiteUrlFinal,
      });

      await driver.closeProfile(adsId).catch(() => undefined);

      if (!result.ok) {
        await appLog({
          source: 'api',
          level: 'error',
          message: `Sync bio falhou: ${result.reason ?? 'unknown'}`,
          accountId: account.id,
        });
        return reply.status(502).send({ ok: false, step: 'updateBio', reason: result.reason });
      }

      // Persistir o que foi enviado (caso tenha vindo via override)
      await prisma.instagramAccount.update({
        where: { id },
        data: {
          bio: bioFinal ?? null,
          websiteUrl: websiteUrlFinal ?? null,
        },
      });

      await appLog({
        source: 'api',
        level: 'info',
        message: `Bio sincronizada com sucesso em @${account.username}`,
        accountId: account.id,
      });

      return { ok: true };
    } catch (err) {
      await driver.closeProfile(adsId).catch(() => undefined);
      const reason = err instanceof Error ? err.message : 'unknown';
      return reply.status(500).send({ ok: false, reason });
    }
  });

  app.delete('/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await prisma.instagramAccount.delete({ where: { id } });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'not_found' });
    }
  });
}

function serializeAccount(a: {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  websiteUrl: string | null;
  groupName: string | null;
  status: string;
  lastFailureAt: Date | null;
  consecutiveFails: number;
  campaignId: string | null;
  adsPowerProfileId: string | null;
}) {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    bio: a.bio,
    websiteUrl: a.websiteUrl,
    groupName: a.groupName,
    status: a.status as 'active' | 'paused' | 'needs_login' | 'error',
    lastFailureAt: a.lastFailureAt ? a.lastFailureAt.toISOString() : null,
    consecutiveFails: a.consecutiveFails,
    campaignId: a.campaignId,
    adsPowerProfileId: a.adsPowerProfileId,
  };
}
