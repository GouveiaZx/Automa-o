import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';

export async function logRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/logs', async (req) => {
    const q = req.query as { level?: string; source?: string; accountId?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 200), 1000);
    return prisma.automationLog.findMany({
      where: {
        ...(q.level ? { level: q.level } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(q.accountId ? { accountId: q.accountId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  });

  app.delete('/logs', async () => {
    const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const r = await prisma.automationLog.deleteMany({ where: { createdAt: { lt: before } } });
    return { deleted: r.count };
  });
}
