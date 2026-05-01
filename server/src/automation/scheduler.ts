import { prisma } from '../prisma.js';
import { appLog } from '../logger.js';
import type { MediaType } from '@automacao/shared';

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Converte "HH:MM" + uma data base para um Date no mesmo dia.
 */
function timeOnDate(hhmm: string, base: Date): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Próximo horário válido dentro da janela da campanha.
 * Se o candidato estiver fora da janela, joga para o início da janela do próximo dia.
 */
function clampToWindow(
  candidate: Date,
  windowStart: string,
  windowEnd: string
): Date {
  const startToday = timeOnDate(windowStart, candidate);
  const endToday = timeOnDate(windowEnd, candidate);
  if (candidate < startToday) return startToday;
  if (candidate <= endToday) return candidate;
  const tomorrow = new Date(candidate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return timeOnDate(windowStart, tomorrow);
}

/**
 * Reagenda próximos jobs para uma conta após uma postagem bem-sucedida.
 * Respeita storiesPerDay/reelsPerDay da campanha (não cria além do que já está agendado para hoje).
 */
export async function scheduleNextForAccount(accountId: string): Promise<void> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    include: { campaign: true },
  });
  if (!account || !account.campaign || account.status !== 'active') return;
  const c = account.campaign;
  if (!c.active) return;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const jobsToday = await prisma.postJob.findMany({
    where: {
      accountId,
      scheduledFor: { gte: startOfDay, lt: endOfDay },
      status: { in: ['queued', 'running', 'retry', 'done'] },
    },
  });

  const counts = { story: 0, reel: 0 };
  let lastScheduled: Date = new Date();
  for (const j of jobsToday) {
    if (j.type === 'story') counts.story++;
    else if (j.type === 'reel') counts.reel++;
    if (j.scheduledFor > lastScheduled) lastScheduled = j.scheduledFor;
  }

  await maybeScheduleType('story', c.storiesPerDay - counts.story, accountId, c, lastScheduled);
  await maybeScheduleType('reel', c.reelsPerDay - counts.reel, accountId, c, lastScheduled);
}

async function maybeScheduleType(
  type: MediaType,
  remaining: number,
  accountId: string,
  campaign: {
    id: string;
    minIntervalMin: number;
    maxIntervalMin: number;
    windowStart: string;
    windowEnd: string;
  },
  lastScheduled: Date
): Promise<void> {
  if (remaining <= 0) return;

  const candidates = await prisma.mediaItem.findMany({
    where: {
      type,
      campaignId: campaign.id,
    },
    orderBy: [{ usedCount: 'asc' }, { createdAt: 'asc' }],
    take: remaining,
  });
  if (!candidates.length) return;

  let next = lastScheduled;
  for (const media of candidates) {
    const delta = rand(campaign.minIntervalMin, campaign.maxIntervalMin) * 60 * 1000;
    next = new Date(next.getTime() + delta);
    next = clampToWindow(next, campaign.windowStart, campaign.windowEnd);

    await prisma.postJob.create({
      data: {
        accountId,
        mediaId: media.id,
        type,
        status: 'queued',
        scheduledFor: next,
      },
    });
    await appLog({
      source: 'worker',
      level: 'info',
      message: `Próximo ${type} agendado para ${next.toISOString()}`,
      accountId,
    });
  }
}
