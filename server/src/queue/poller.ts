import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { bus } from '../events.js';
import { appLog, cleanupOldLogs } from '../logger.js';
import { processJob } from './processor.js';

const inFlight = new Set<string>();
const accountInFlight = new Set<string>();
let stopped = false;
let lastLogCleanupAt = 0;
let lastTickAt = 0;
let tickCount = 0;
let lastSkipReport = 0;
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x/dia
const SKIP_REPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 min entre reports de "jobs pulados pelo cap"
const SET_RECONCILE_INTERVAL_TICKS = 12; // ~1 min em ticks de 5s

// Estado exportado pra endpoint de diagnostico
export function getWorkerState() {
  return {
    running: !stopped,
    lastTickAt,
    tickCount,
    inFlight: Array.from(inFlight),
    accountInFlight: Array.from(accountInFlight),
    config: {
      maxConcurrentProfiles: env.MAX_CONCURRENT_PROFILES,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      keepProfilesOpen: env.KEEP_PROFILES_OPEN,
    },
  };
}

export async function startWorker(): Promise<void> {
  // Recovery de jobs orfaos: se o processo crashou enquanto um job estava 'running'
  // ele fica preso pra sempre. Aqui devolvemos ao 'queued' qualquer job que ficou
  // 'running' por mais de 30 min (post real completo dura < 5 min, com folga).
  const ORPHAN_THRESHOLD_MS = 30 * 60 * 1000;
  const orphans = await prisma.postJob.updateMany({
    where: {
      status: 'running',
      startedAt: { lte: new Date(Date.now() - ORPHAN_THRESHOLD_MS) },
    },
    data: { status: 'queued', startedAt: null },
  });
  if (orphans.count > 0) {
    await appLog({
      source: 'worker',
      level: 'warn',
      message: `Recovery: ${orphans.count} job(s) orfaos voltaram para 'queued' (provavel crash anterior)`,
    });
  }

  // Auto-elevacao do MAX_ACTIVE_ACCOUNTS: se o setting esta com o valor padrao
  // antigo "1" (vindo do seed da Etapa 4 que era pra teste progressivo) MAS o
  // cliente ja tem mais de 1 conta active no banco, eleva pro total automatico
  // pra evitar que jobs fiquem queued indefinidamente sem sinalizar.
  await autoFixActiveAccountsCap();

  await appLog({
    source: 'worker',
    level: 'info',
    message: `Worker iniciado (modo=${env.AUTOMATION_MODE}, max_concurrent=${env.MAX_CONCURRENT_PROFILES}, keep_open=${env.KEEP_PROFILES_OPEN})`,
  });

  const tick = async () => {
    if (stopped) return;
    try {
      await processOnce();
    } catch (err) {
      console.error('[worker] tick error', err);
    }
    lastTickAt = Date.now();
    tickCount++;
    // Heartbeat via SSE bus pro frontend mostrar status do worker
    bus.emitEvent({
      type: 'worker-heartbeat',
      payload: { at: lastTickAt, tickCount, inFlight: inFlight.size },
    });
    setTimeout(tick, env.WORKER_POLL_INTERVAL_MS);
  };
  tick();
}

async function autoFixActiveAccountsCap(): Promise<void> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: 'MAX_ACTIVE_ACCOUNTS' },
  });
  if (!setting) return; // sem cap = OK
  const cap = parseInt(setting.value, 10);
  if (!Number.isFinite(cap) || cap <= 0) return;
  const activeCount = await prisma.instagramAccount.count({ where: { status: 'active' } });
  if (activeCount > cap && cap === 1) {
    // Cap default antigo (1) com mais contas — eleva
    const newValue = String(activeCount);
    await prisma.appSetting.update({
      where: { key: 'MAX_ACTIVE_ACCOUNTS' },
      data: { value: newValue },
    });
    await appLog({
      source: 'worker',
      level: 'warn',
      message: `MAX_ACTIVE_ACCOUNTS estava em 1 mas voce tem ${activeCount} conta(s) ativa(s). Elevei pro total automaticamente. Ajuste em Configuracoes se quiser limitar.`,
    });
  }
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
  // Cleanup oportunista de logs antigos (1x/dia)
  if (Date.now() - lastLogCleanupAt > LOG_CLEANUP_INTERVAL_MS) {
    lastLogCleanupAt = Date.now();
    void cleanupOldLogs()
      .then((n) => {
        if (n > 0) console.log(`[worker] cleanup: ${n} log(s) antigo(s) apagado(s)`);
      })
      .catch((e) => console.error('[worker] cleanup logs falhou:', e));
  }

  // Reconcile defensivo (a cada N ticks): valida inFlight contra DB.
  // Se um job esta no Set mas nao mais 'running' no DB, remove (zumbi).
  // Cobre caso raro de processJob terminar sem disparar finally (process.exit).
  if (tickCount % SET_RECONCILE_INTERVAL_TICKS === 0 && inFlight.size > 0) {
    await reconcileSets();
  }

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
      // Evita pegar jobs de contas paused/needs_login/error: o processor
      // reagendaria pra 5 min depois, gerando loop infinito de re-queue.
      account: { status: 'active' },
    },
    orderBy: { scheduledFor: 'asc' },
    take: slots * 5,
    include: { account: true },
  });

  // Visibilidade: contadores de quantos jobs foram pulados e por que motivo.
  // Reportado a cada 5 min se houver "stuck" pra evitar polui o console.
  let skippedByCap = 0;
  let skippedByAccountInFlight = 0;
  let skippedByClaim = 0;
  let claimed = 0;

  for (const job of candidates) {
    if (inFlight.size >= env.MAX_CONCURRENT_PROFILES) break;
    if (accountInFlight.has(job.accountId)) {
      skippedByAccountInFlight++;
      continue;
    }
    if (allowedIds && !allowedIds.has(job.accountId)) {
      skippedByCap++;
      continue;
    }

    const claimResult = await prisma.postJob.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimResult.count === 0) {
      skippedByClaim++;
      continue;
    }

    inFlight.add(job.id);
    accountInFlight.add(job.accountId);
    claimed++;

    void processJob(job.id).finally(() => {
      inFlight.delete(job.id);
      accountInFlight.delete(job.accountId);
    });
  }

  // Report de jobs presos pelo cap (sinalizar que precisa ajustar)
  if (skippedByCap > 0 && Date.now() - lastSkipReport > SKIP_REPORT_INTERVAL_MS) {
    lastSkipReport = Date.now();
    await appLog({
      source: 'worker',
      level: 'warn',
      message: `${skippedByCap} job(s) sendo pulados pelo MAX_ACTIVE_ACCOUNTS=${cap}. Aumente em Configuracoes pra processar mais contas em paralelo.`,
    });
  }
}

async function reconcileSets(): Promise<void> {
  if (inFlight.size === 0) return;
  const ids = Array.from(inFlight);
  const stillRunning = await prisma.postJob.findMany({
    where: { id: { in: ids }, status: 'running' },
    select: { id: true, accountId: true },
  });
  const stillRunningIds = new Set(stillRunning.map((j) => j.id));
  const stillRunningAccountIds = new Set(stillRunning.map((j) => j.accountId));

  let removed = 0;
  for (const id of ids) {
    if (!stillRunningIds.has(id)) {
      inFlight.delete(id);
      removed++;
    }
  }
  // Reconcilia accountInFlight: so mantem os accountIds que ainda tem jobs running
  for (const accId of Array.from(accountInFlight)) {
    if (!stillRunningAccountIds.has(accId)) {
      accountInFlight.delete(accId);
    }
  }
  if (removed > 0) {
    await appLog({
      source: 'worker',
      level: 'warn',
      message: `Reconcile: removidos ${removed} job(s) zumbis dos sets in-memory (job nao estava mais running no DB)`,
    });
  }
}
