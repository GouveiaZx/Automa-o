import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { instagramAccountInputSchema, accountStatusUpdateSchema, syncBioSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { bus } from '../../events.js';
import { getDriver } from '../../automation/driver.js';
import { adsPowerClient, AdsPowerError } from '../../automation/adspower-client.js';
import { appLog } from '../../logger.js';
import { scheduleNextForAccount } from '../../automation/scheduler.js';

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
    // FIX 23: opt-in cascade — query ?cascadeAdsPower=true tambem deleta o
    // perfil AdsPower vinculado (no DB local + no proprio app AdsPower).
    // Default false pra preservar compat e evitar destrutivo acidental.
    const q = req.query as { cascadeAdsPower?: string };
    const cascadeAdsPower = q.cascadeAdsPower === 'true' || q.cascadeAdsPower === '1';

    const account = await prisma.instagramAccount.findUnique({
      where: { id },
      include: { adsPowerProfile: true },
    });
    if (!account) return reply.status(404).send({ error: 'not_found' });

    let adsPowerDeletedAt: 'app' | 'app_failed' | 'db_only' | 'no_profile' = 'no_profile';
    if (cascadeAdsPower && account.adsPowerProfile) {
      const adsPowerId = account.adsPowerProfile.adsPowerId;
      // Tenta deletar do AdsPower app primeiro (irreversivel). Se falhar,
      // ainda deleta do DB pra nao deixar orfao.
      try {
        await adsPowerClient.deleteProfile(adsPowerId);
        adsPowerDeletedAt = 'app';
      } catch (err) {
        adsPowerDeletedAt = 'app_failed';
        await appLog({
          source: 'api',
          level: 'warn',
          message: `AdsPower deleteProfile falhou pra ${adsPowerId}: ${err instanceof Error ? err.message : 'unknown'}. Deletando so do DB local.`,
          accountId: id,
        });
      }
      // Deleta do DB local (independente do resultado AdsPower app)
      await prisma.adsPowerProfile.delete({ where: { id: account.adsPowerProfile.id } }).catch(() => undefined);
      if (adsPowerDeletedAt === 'app_failed') adsPowerDeletedAt = 'db_only';
    }

    await prisma.instagramAccount.delete({ where: { id } });
    return { ok: true, adsPower: adsPowerDeletedAt };
  });

  // Auto-link (FIX 18): vincula contas IG SEM perfil AdsPower aos perfis
  // disponiveis usando match exato case-insensitive entre username e
  // adsPowerProfile.name. Reduz click-fadiga quando o user importou perfis
  // em lote (FIX 17) e quer associar 1-pra-1 com as contas IG.
  // Skipa ambiguous (multiplos perfis com mesmo nome) e no_match.
  app.post('/accounts/auto-link', async () => {
    const orphanAccounts = await prisma.instagramAccount.findMany({
      where: { adsPowerProfileId: null },
    });
    const freeProfiles = await prisma.adsPowerProfile.findMany({
      where: { account: { is: null } },
    });

    let linked = 0;
    const ambiguous: string[] = [];
    const noMatch: string[] = [];

    for (const acc of orphanAccounts) {
      const u = acc.username.toLowerCase();
      const matches = freeProfiles.filter((p) => p.name.toLowerCase() === u);
      if (matches.length === 1) {
        // Codex P2 (TOCTOU): usa updateMany com guard `adsPowerProfileId: null`
        // pra nao sobrescrever vinculo manual feito entre as 2 queries acima.
        // Se profile ja foi vinculado por outro lado (P2002), ignora silenciosamente.
        try {
          const r = await prisma.instagramAccount.updateMany({
            where: { id: acc.id, adsPowerProfileId: null },
            data: { adsPowerProfileId: matches[0].id },
          });
          if (r.count > 0) {
            const idx = freeProfiles.indexOf(matches[0]);
            if (idx >= 0) freeProfiles.splice(idx, 1);
            linked++;
          }
          // r.count === 0 = conta ja foi vinculada entre as queries; skip silent
        } catch (err: unknown) {
          // P2002 = unique constraint violation (perfil ja vinculado em outra conta).
          // Outros erros: log e segue.
          const code = (err as { code?: string }).code;
          if (code !== 'P2002') {
            // segue, conta fica skipped
          }
        }
      } else if (matches.length > 1) {
        ambiguous.push(`@${acc.username} (${matches.length} perfis com mesmo nome)`);
      } else {
        noMatch.push(`@${acc.username}`);
      }
    }

    return {
      ok: true,
      linked,
      ambiguousCount: ambiguous.length,
      noMatchCount: noMatch.length,
      ambiguous: ambiguous.slice(0, 10),
      noMatch: noMatch.slice(0, 10),
    };
  });

  // Sync followers (FIX 21): itera sobre contas IG com perfil AdsPower
  // vinculado, abre cada perfil sequencialmente, le followers count, fecha.
  // Lento (1 conta por vez), mas roda em background — UI mostra spinner.
  app.post('/accounts/sync-followers', async () => {
    const accounts = await prisma.instagramAccount.findMany({
      where: { adsPowerProfileId: { not: null } },
      include: { adsPowerProfile: true },
      orderBy: { username: 'asc' },
    });

    const driver = getDriver();
    let updated = 0;
    const failed: string[] = [];

    for (const acc of accounts) {
      const adsId = acc.adsPowerProfile?.adsPowerId;
      if (!adsId) continue;
      try {
        const opened = await driver.openProfile(adsId);
        if (!opened.ok) {
          failed.push(`@${acc.username}: ${opened.reason ?? 'open falhou'}`);
          continue;
        }
        const logged = await driver.ensureLoggedIn(adsId, acc.username);
        if (!logged) {
          failed.push(`@${acc.username}: nao logado`);
          await driver.closeProfile(adsId).catch(() => undefined);
          continue;
        }
        const count = driver.getFollowers
          ? await driver.getFollowers(adsId, acc.username).catch(() => null)
          : null;
        await driver.closeProfile(adsId).catch(() => undefined);
        if (count !== null) {
          await prisma.instagramAccount.update({
            where: { id: acc.id },
            data: { followersCount: count, followersUpdatedAt: new Date() },
          });
          updated++;
        } else {
          failed.push(`@${acc.username}: nao conseguiu ler followers`);
        }
      } catch (err) {
        failed.push(`@${acc.username}: ${err instanceof Error ? err.message : 'erro'}`);
        await driver.closeProfile(adsId).catch(() => undefined);
      }
    }

    return { ok: true, total: accounts.length, updated, failedCount: failed.length, failed: failed.slice(0, 20) };
  });

  // Auto-create from AdsPower profiles (FIX 20): pra cada perfil AdsPower
  // SEM conta IG vinculada, cria uma conta IG nova com username = nome do
  // perfil (lowercase), vinculando o adsPowerProfileId. Aceita campanha e
  // grupo padrao opcionais (user pode editar conta-por-conta depois).
  // Reduz copy/paste manual quando user importou 20+ perfis (FIX 17) e
  // precisa criar contas IG correspondentes.
  app.post('/accounts/auto-create-from-profiles', async (req, reply) => {
    const parsed = z.object({
      campaignId: z.string().optional().nullable(),
      groupName: z.string().optional().nullable(),
      // FIX 23.1: opcional — se fornecido, restringe a esses perfis especificos.
      // Default = todos perfis sem conta vinculada (comportamento antigo).
      profileIds: z.array(z.string()).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
    }
    const defaults = parsed.data;

    // FIX 22.1: valida campaignId existe ANTES de iterar — evita 25 erros
    // identicos de FK violation se user passou id invalido.
    if (defaults.campaignId) {
      const exists = await prisma.campaign.findUnique({ where: { id: defaults.campaignId } });
      if (!exists) {
        return reply.status(400).send({
          error: 'campaign_not_found',
          message: `Campanha id=${defaults.campaignId} nao existe`,
        });
      }
    }

    const orphanProfiles = await prisma.adsPowerProfile.findMany({
      where: {
        account: { is: null },
        // FIX 23.1: se profileIds passados, filtra so os escolhidos pelo user
        ...(defaults.profileIds && defaults.profileIds.length > 0
          ? { id: { in: defaults.profileIds } }
          : {}),
      },
    });

    let created = 0;
    let linkedExisting = 0;
    const skipped: string[] = [];

    for (const p of orphanProfiles) {
      const usernameRaw = p.name.trim().toLowerCase();
      if (!usernameRaw) {
        skipped.push(`${p.adsPowerId}: nome do perfil vazio`);
        continue;
      }
      const existing = await prisma.instagramAccount.findUnique({
        where: { username: usernameRaw },
      });
      if (existing) {
        // Conta ja existe — vincula se ainda esta sem perfil (idempotente)
        if (!existing.adsPowerProfileId) {
          try {
            await prisma.instagramAccount.update({
              where: { id: existing.id },
              data: { adsPowerProfileId: p.id },
            });
            linkedExisting++;
          } catch {
            skipped.push(`@${usernameRaw}: erro ao vincular conta existente`);
          }
        } else {
          skipped.push(`@${usernameRaw}: ja existia (vinculada a outro perfil)`);
        }
        continue;
      }
      try {
        await prisma.instagramAccount.create({
          data: {
            username: usernameRaw,
            campaignId: defaults.campaignId ?? null,
            groupName: defaults.groupName ?? null,
            adsPowerProfileId: p.id,
          },
        });
        created++;
      } catch (err: unknown) {
        // FIX 22.1: inclui codigo real do Prisma + mensagem pra debug.
        // Antes era so "erro ao criar" generico que ofuscava P2003 (FK
        // violation pra campaignId invalido), constraint violations, etc.
        const code = (err as { code?: string }).code;
        const meta = (err as { meta?: { field_name?: string; target?: string[] } }).meta;
        const msg = err instanceof Error ? err.message : 'unknown';
        let label: string;
        if (code === 'P2002') {
          label = `conflito unique (${meta?.target?.join(',') ?? '?'})`;
        } else if (code === 'P2003') {
          label = `FK violation (${meta?.field_name ?? '?'})`;
        } else if (code) {
          label = `${code}: ${msg.slice(0, 80)}`;
        } else {
          label = `erro: ${msg.slice(0, 80)}`;
        }
        skipped.push(`@${usernameRaw}: ${label}`);
      }
    }

    return {
      ok: true,
      created,
      linkedExisting,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 20),
    };
  });

  // Bulk delete (FIX 14): exclui N contas IG de uma vez. Usa deleteMany numa
  // transacao implicita do Prisma — atomico. Jobs/media relacionados sao
  // tratados pelas FKs do schema (cascade onde definido).
  // FIX 23: cascadeAdsPower: boolean — opt-in pra tambem deletar perfis
  // AdsPower vinculados (DB local + app AdsPower). Default false (defensivo).
  app.post('/accounts/bulk-delete', async (req, reply) => {
    const parsed = z.object({
      ids: z.array(z.string()).min(1),
      cascadeAdsPower: z.boolean().optional().default(false),
    }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { ids, cascadeAdsPower } = parsed.data;

    let adsPowerAppDeleted = 0;
    let adsPowerAppFailed = 0;
    const adsPowerErrors: string[] = [];

    if (cascadeAdsPower) {
      // Pega perfis AdsPower vinculados ANTES de deletar contas (Prisma SetNull
      // limparia adsPowerProfileId no delete da conta, perdendo a referencia).
      const accountsWithProfile = await prisma.instagramAccount.findMany({
        where: { id: { in: ids }, adsPowerProfileId: { not: null } },
        include: { adsPowerProfile: true },
      });
      // Deleta de cada AdsPower app sequencialmente (rate-limit 1 req/s).
      for (const acc of accountsWithProfile) {
        if (!acc.adsPowerProfile) continue;
        try {
          await adsPowerClient.deleteProfile(acc.adsPowerProfile.adsPowerId);
          adsPowerAppDeleted++;
        } catch (err) {
          adsPowerAppFailed++;
          adsPowerErrors.push(
            `@${acc.username}: ${err instanceof Error ? err.message.slice(0, 80) : 'erro'}`
          );
        }
      }
      // Deleta os perfis do DB local (independente do resultado AdsPower app)
      const profileIds = accountsWithProfile
        .map((a) => a.adsPowerProfile?.id)
        .filter(Boolean) as string[];
      if (profileIds.length > 0) {
        await prisma.adsPowerProfile.deleteMany({
          where: { id: { in: profileIds } },
        });
      }
    }

    const result = await prisma.instagramAccount.deleteMany({
      where: { id: { in: ids } },
    });
    return {
      ok: true,
      deleted: result.count,
      adsPowerAppDeleted,
      adsPowerAppFailed,
      adsPowerErrors: adsPowerErrors.slice(0, 20),
    };
  });

  // Progresso por conta — agregado de jobs do dia (queued/running/retry/failed/done).
  // Usado pra mostrar barra "5/10 ✓" e estado (rodando/concluido/sem jobs) na UI.
  app.get('/accounts/progress', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const accounts = await prisma.instagramAccount.findMany({
      orderBy: { username: 'asc' },
      select: { id: true, username: true, status: true },
    });

    // Agrega jobs do dia por account+status numa unica query.
    const jobs = await prisma.postJob.groupBy({
      by: ['accountId', 'status'],
      where: {
        scheduledFor: { gte: startOfDay, lt: endOfDay },
      },
      _count: { _all: true },
    });

    const byAccount: Record<string, { done: number; queued: number; running: number; retry: number; failed: number }> = {};
    for (const j of jobs) {
      if (!byAccount[j.accountId]) {
        byAccount[j.accountId] = { done: 0, queued: 0, running: 0, retry: 0, failed: 0 };
      }
      const slot = byAccount[j.accountId];
      if (j.status === 'done') slot.done = j._count._all;
      else if (j.status === 'queued') slot.queued = j._count._all;
      else if (j.status === 'running') slot.running = j._count._all;
      else if (j.status === 'retry') slot.retry = j._count._all;
      else if (j.status === 'failed') slot.failed = j._count._all;
    }

    return accounts.map((a) => {
      const t = byAccount[a.id] ?? { done: 0, queued: 0, running: 0, retry: 0, failed: 0 };
      const totalToday = t.done + t.queued + t.running + t.retry + t.failed;
      const pending = t.queued + t.running + t.retry;
      let cycleState: 'idle' | 'running' | 'completed' | 'failures';
      if (totalToday === 0) cycleState = 'idle';
      else if (pending > 0) cycleState = 'running';
      else if (t.failed > 0 && t.done === 0) cycleState = 'failures';
      else cycleState = 'completed';
      return {
        id: a.id,
        username: a.username,
        status: a.status,
        today: t,
        totalToday,
        cycleState,
      };
    });
  });

  // Reagendar ciclo: apaga jobs nao-done dessa conta + chama scheduler pra
  // criar jobs novos. Util quando conta concluiu o ciclo do dia e Gustavo
  // quer comecar novo ciclo manual (sem esperar scheduler natural).
  app.post('/accounts/:id/restart-cycle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await prisma.instagramAccount.findUnique({ where: { id } });
    if (!account) return reply.status(404).send({ error: 'not_found' });
    // So apaga queued/retry/failed (nao toca em running/done — running pode estar
    // processando agora; done eh historico).
    const deleted = await prisma.postJob.deleteMany({
      where: { accountId: id, status: { in: ['queued', 'retry', 'failed'] } },
    });
    // Reagenda pelo scheduler com base na campanha
    await scheduleNextForAccount(id);
    await appLog({
      source: 'api',
      level: 'info',
      message: `Reagendar ciclo: ${deleted.count} job(s) apagado(s) e reagendados pra @${account.username}`,
      accountId: id,
    });
    return { ok: true, deleted: deleted.count };
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
  autoPaused: boolean;
  followersCount: number | null;
  followersUpdatedAt: Date | null;
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
    autoPaused: a.autoPaused,
    followersCount: a.followersCount,
    followersUpdatedAt: a.followersUpdatedAt ? a.followersUpdatedAt.toISOString() : null,
    campaignId: a.campaignId,
    adsPowerProfileId: a.adsPowerProfileId,
  };
}
