import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { appLog } from '../logger.js';
import { processJob } from './processor.js';

const inFlight = new Set<string>();
const accountInFlight = new Set<string>();
let stopped = false;

export async function startWorker(): Promise<void> {
  await appLog({
    source: 'worker',
    level: 'info',
    message: `Worker iniciado (modo=${env.AUTOMATION_MODE}, max_concurrent=${env.MAX_CONCURRENT_PROFILES})`,
  });

  const tick = async () => {
    if (stopped) return;
    try {
      await processOnce();
    } catch (err) {
      console.error('[worker] tick error', err);
    }
    setTimeout(tick, env.WORKER_POLL_INTERVAL_MS);
  };
  tick();
}

export function stopWorker(): void {
  stopped = true;
}

async function getActiveAccountCap(): Promise<number | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: 'MAX_ACTIVE_ACCOUNTS' } });
  if (!setting) return null;
  const n = parseInt(setting.value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getAllowedAccountIds(cap: number): Promise<Set<string>> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { status: 'active' },
    orderBy: { username: 'asc' },
    take: cap,
    select: { id: true },
  });
  return new Set(accounts.map((a) => a.id));
}

async function processOnce(): Promise<void> {
  // promove jobs em retry cujo scheduledFor já passou
  await prisma.postJob.updateMany({
    where: { status: 'retry', scheduledFor: { lte: new Date() } },
    data: { status: 'queued' },
  });

  const slots = env.MAX_CONCURRENT_PROFILES - inFlight.size;
  if (slots <= 0) return;

  // Etapa 4: limitar contas ativas conforme MAX_ACTIVE_ACCOUNTS
  const cap = await getActiveAccountCap();
  const allowedIds = cap !== null ? await getAllowedAccountIds(cap) : null;

  const candidates = await prisma.postJob.findMany({
    where: {
      status: 'queued',
      scheduledFor: { lte: new Date() },
      accountId: { notIn: Array.from(accountInFlight) },
    },
    orderBy: { scheduledFor: 'asc' },
    take: slots * 5,
    include: { account: true },
  });

  for (const job of candidates) {
    if (inFlight.size >= env.MAX_CONCURRENT_PROFILES) break;
    if (accountInFlight.has(job.accountId)) continue;
    if (allowedIds && !allowedIds.has(job.accountId)) continue; // fora do cap progressivo

    const claimed = await prisma.postJob.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    inFlight.add(job.id);
    accountInFlight.add(job.accountId);

    void processJob(job.id).finally(() => {
      inFlight.delete(job.id);
      accountInFlight.delete(job.accountId);
    });
  }
}
