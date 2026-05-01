import type { FastifyInstance } from 'fastify';
import { settingUpdateSchema } from '@automacao/shared';
import { prisma } from '../../prisma.js';
import { env } from '../../env.js';

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
    const parsed = settingUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_input' });
    return prisma.appSetting.upsert({
      where: { key },
      update: { value: parsed.data.value },
      create: { key, value: parsed.data.value },
    });
  });
}
