import type { FastifyInstance } from 'fastify';
import { prisma } from '../../prisma.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/dashboard/summary', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [queued, running, retry, failed, doneToday, accounts, recentErrors] = await Promise.all([
      prisma.postJob.count({ where: { status: 'queued' } }),
      prisma.postJob.count({ where: { status: 'running' } }),
      prisma.postJob.count({ where: { status: 'retry' } }),
      prisma.postJob.count({ where: { status: 'failed' } }),
      prisma.postJob.count({ where: { status: 'done', finishedAt: { gte: startOfDay } } }),
      prisma.instagramAccount.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.automationLog.findMany({
        where: { level: { in: ['warn', 'error'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const accountCounts = { active: 0, paused: 0, needsLogin: 0, error: 0 };
    for (const a of accounts) {
      if (a.status === 'active') accountCounts.active = a._count._all;
      else if (a.status === 'paused') accountCounts.paused = a._count._all;
      else if (a.status === 'needs_login') accountCounts.needsLogin = a._count._all;
      else if (a.status === 'error') accountCounts.error = a._count._all;
    }

    return {
      jobs: { queued, running, retry, failed, doneToday },
      accounts: accountCounts,
      alerts: recentErrors.map((l) => ({
        id: l.id,
        severity: l.level === 'error' ? 'error' : 'warn',
        message: l.message,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  });
}
