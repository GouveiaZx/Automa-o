import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';
import { adsPowerClient } from '../../automation/adspower-client.js';
import { realDriver } from '../../automation/real-driver.js';
import { mockDriver } from '../../automation/mock-driver.js';
import { env } from '../../env.js';
import { captureDebug } from '../../automation/playwright-helpers.js';
import { chromium } from 'playwright';

export async function diagnosticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/diagnostics/adspower', async () => {
    const health = await adsPowerClient.health();
    if (!health.reachable) {
      return {
        ok: false,
        reachable: false,
        baseUrl: env.ADSPOWER_API_URL,
        error: health.error,
        hint: 'Confirme que o AdsPower está aberto e rodando. URL padrão: http://local.adspower.net:50325',
      };
    }
    try {
      const profiles = await adsPowerClient.listProfiles();
      return {
        ok: true,
        reachable: true,
        baseUrl: env.ADSPOWER_API_URL,
        profiles: profiles.map((p) => ({
          adsPowerId: p.user_id,
          name: p.name,
          group: p.group_name ?? null,
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      let hint =
        'AdsPower respondeu mas a API rejeitou. Pode precisar de API key (ADSPOWER_API_KEY no .env).';
      if (/daily limit/i.test(msg)) {
        hint =
          '⚠️ Limite diário da versão GRÁTIS do AdsPower atingido (5 aberturas/dia em alguns planos). Aguarde 24h ou use a versão paga.';
      }
      return {
        ok: false,
        reachable: true,
        baseUrl: env.ADSPOWER_API_URL,
        error: msg,
        hint,
      };
    }
  });

  app.post('/diagnostics/test-profile/:profileId', {
    // Operacao cara (abre AdsPower, conecta CDP, navega IG). 5/min eh suficiente.
    // allowList false: aplica mesmo de localhost (evita spam acidental via UI).
    config: { rateLimit: { max: 5, timeWindow: '1 minute', allowList: () => false } },
  }, async (req, reply) => {
    const { profileId } = req.params as { profileId: string };
    const profile = await prisma.adsPowerProfile.findUnique({
      where: { id: profileId },
      include: { account: true },
    });
    if (!profile) return reply.status(404).send({ error: 'profile_not_found' });

    const driver = env.AUTOMATION_MODE === 'real' ? realDriver : mockDriver;
    const username = profile.account?.username ?? 'unknown';

    const opened = await driver.openProfile(profile.adsPowerId);
    if (!opened.ok) {
      return { ok: false, step: 'open', reason: opened.reason };
    }
    let logged = false;
    let screenshot: string | null = null;
    let hint: string | null = null;
    try {
      logged = await driver.ensureLoggedIn(profile.adsPowerId, username);
    } catch (err) {
      return {
        ok: false,
        step: 'ensureLoggedIn',
        reason: err instanceof Error ? err.message : 'unknown',
      };
    } finally {
      await driver.closeProfile(profile.adsPowerId).catch(() => undefined);
    }
    if (!logged) {
      // pega o screenshot mais recente em media/debug que comece com login-needed/unsure pra esse username
      try {
        const { readdir } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const dir = join(process.cwd(), 'media', 'debug');
        const files = await readdir(dir).catch(() => [] as string[]);
        const matching = files
          .filter((f) => f.endsWith('.png') && f.includes(username))
          .sort()
          .reverse();
        if (matching.length > 0) {
          screenshot = `/media-files/debug/${matching[0]}`;
        }
      } catch {
        /* sem screenshot */
      }
      hint =
        'Não detectou login. Pode ser: tela de consentimento do Meta (LGPD/Ads), checkpoint, ou conta deslogada. Veja o screenshot e resolva manualmente abrindo o perfil pelo AdsPower.';
    }
    return { ok: true, logged, screenshot, hint };
  });

  // Endpoint utilitário: lista perfis disponíveis no AdsPower que ainda não foram cadastrados
  app.get('/diagnostics/adspower-unregistered', async () => {
    const adsProfiles = await adsPowerClient.listProfiles().catch(() => []);
    const registered = await prisma.adsPowerProfile.findMany({
      select: { adsPowerId: true },
    });
    const set = new Set(registered.map((r) => r.adsPowerId));
    return adsProfiles.filter((p) => !set.has(p.user_id));
  });

  // Sanity check de Playwright no modo real
  app.get('/diagnostics/playwright', async () => {
    if (env.AUTOMATION_MODE !== 'real') {
      return { ok: true, mode: env.AUTOMATION_MODE, note: 'modo mock — Playwright não usado' };
    }
    try {
      const v = chromium.executablePath();
      return { ok: true, mode: 'real', chromiumPath: v };
    } catch (err) {
      return {
        ok: false,
        mode: 'real',
        error: err instanceof Error ? err.message : 'unknown',
        hint: 'Rode `npx playwright install chromium` no terminal do server.',
      };
    }
  });
}
