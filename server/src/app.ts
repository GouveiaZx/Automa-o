import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './modules/auth/routes.js';
import { campaignRoutes } from './modules/campaigns/routes.js';
import { adsPowerProfileRoutes } from './modules/adspower-profiles/routes.js';
import { instagramAccountRoutes } from './modules/instagram-accounts/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { logRoutes } from './modules/logs/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { sseRoutes } from './modules/sse/routes.js';
import { diagnosticsRoutes } from './modules/diagnostics/routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
    bodyLimit: 250 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(multipart, {
    limits: { fileSize: 250 * 1024 * 1024 },
  });

  // Rate limit global frouxo (300 req/min por IP) — endpoints sensiveis aplicam
  // limites mais apertados via { config: { rateLimit: { max, timeWindow } } } na rota.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
    keyGenerator: (req) => (req.headers['x-forwarded-for'] as string) || req.ip,
  });

  await app.register(authPlugin);

  const mediaDir = join(process.cwd(), 'media');
  await mkdir(mediaDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: '/media-files/',
    decorateReply: false,
  });

  app.get('/health', async () => ({ ok: true, mode: env.AUTOMATION_MODE }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(campaignRoutes);
      await api.register(adsPowerProfileRoutes);
      await api.register(instagramAccountRoutes);
      await api.register(mediaRoutes);
      await api.register(jobRoutes);
      await api.register(logRoutes);
      await api.register(settingsRoutes);
      await api.register(dashboardRoutes);
      await api.register(sseRoutes);
      await api.register(diagnosticsRoutes);
    },
    { prefix: '/api' }
  );

  return app;
}
