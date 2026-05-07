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

/**
 * Calcula proximos N horarios baseado na campanha:
 * - Se fixedTimes setado (ex: "00:00,03:00,06:00,12:00,18:00"), usa esses horarios
 * - Caso contrario, usa intervalo aleatorio min/max dentro da janela
 */
export function nextSlots(
  campaign: {
    minIntervalMin: number;
    maxIntervalMin: number;
    windowStart: string;
    windowEnd: string;
    fixedTimes: string | null;
  },
  count: number,
  lastScheduled: Date
): Date[] {
  const slots: Date[] = [];

  // Modo horarios fixos: usa lista CSV de "HH:MM"
  if (campaign.fixedTimes && campaign.fixedTimes.trim().length > 0) {
    const times = campaign.fixedTimes
      .split(',')
      .map((t) => t.trim())
      .filter((t) => /^\d{2}:\d{2}$/.test(t));
    if (times.length > 0) {
      // Distribui count nos horarios fixos. Se count > times.length,
      // gera N posts por horario com offset de FIXED_TIME_OFFSET_MIN minutos
      // entre eles (default 3 min — mais natural, evita parecer spam).
      // Ex: count=30, times=5 → 6 posts por slot (00:00, 00:03, 00:06, 00:09, 00:12, 00:15)
      const FIXED_TIME_OFFSET_MIN = 3;
      const postsPerSlot = Math.max(1, Math.ceil(count / times.length));
      const sortedTimes = [...times].sort();
      let cursor = new Date(lastScheduled);
      cursor.setHours(0, 0, 0, 0);

      while (slots.length < count) {
        for (const t of sortedTimes) {
          const base = timeOnDate(t, cursor);
          for (let i = 0; i < postsPerSlot; i++) {
            if (slots.length >= count) break;
            const slot = new Date(base.getTime() + i * FIXED_TIME_OFFSET_MIN * 60 * 1000);
            if (slot > lastScheduled) {
              slots.push(slot);
            }
          }
          if (slots.length >= count) break;
        }
        cursor = new Date(cursor);
        cursor.setDate(cursor.getDate() + 1);
      }
      return slots;
    }
  }

  // Modo intervalo aleatorio (comportamento padrao)
  let next = lastScheduled;
  for (let i = 0; i < count; i++) {
    const delta = rand(campaign.minIntervalMin, campaign.maxIntervalMin) * 60 * 1000;
    next = new Date(next.getTime() + delta);
    next = clampToWindow(next, campaign.windowStart, campaign.windowEnd);
    slots.push(next);
  }
  return slots;
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
    fixedTimes: string | null;
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

  const slots = nextSlots(campaign, candidates.length, lastScheduled);

  for (let i = 0; i < candidates.length; i++) {
    const media = candidates[i];
    const next = slots[i];
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
