import type { FastifyInstance } from 'fastify';
import { settingUpdateSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { env } from '../../env.js';

// Whitelist de chaves AppSetting validas. Evita poluicao do DB com chaves
// arbitrarias via PUT (ex: __proto__, constructor, typo). Adicione aqui ao
// criar novas configuracoes runtime.
const ALLOWED_SETTING_KEYS = new Set([
  'MAX_ACTIVE_ACCOUNTS',
  'MAX_CONCURRENT_PROFILES',
]);

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/settings', async () => {
    const all = await prisma.appSetting.findMany();
    return {
      runtime: {
        AUTOMATION_MODE: env.AUTOMATION_MODE,
        MAX_CONCURRENT_PROFILES: env.MAX_CONCURRENT_PROFILES,
        MAX_JOB_ATTEMPTS: env.MAX_JOB_ATTEMPTS,
        WORKER_POLL_INTERVAL_MS: env.WORKER_POLL_INTERVAL_MS,
      },
      stored: all,
    };
  });

  app.put('/settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      return reply.status(400).send({
        error: 'unknown_setting_key',
        allowed: Array.from(ALLOWED_SETTING_KEYS),
      });
    }
    const parsed = settingUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_input' });
    return prisma.appSetting.upsert({
      where: { key },
      update: { value: parsed.data.value },
      create: { key, value: parsed.data.value },
    });
  });

  // FIX 26: permite zerar/resetar uma setting (volta ao default do env).
  // Usado pelo botao "Resetar (rodar todas)" no card MAX_ACTIVE_ACCOUNTS.
  app.delete('/settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!ALLOWED_SETTING_KEYS.has(key)) {
      return reply.status(400).send({
        error: 'unknown_setting_key',
        allowed: Array.from(ALLOWED_SETTING_KEYS),
      });
    }
    await prisma.appSetting.deleteMany({ where: { key } });
    return { ok: true, key };
  });
}
