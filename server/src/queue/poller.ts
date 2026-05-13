import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { bus } from '../events.js';
import { appLog, cleanupOldLogs } from '../logger.js';
import { processJob } from './processor.js';

const inFlight = new Set<string>();
const accountInFlight = new Set<string>();
let stopped = false;
let lastLogCleanupAt = 0;
let lastOrphanRecoveryAt = 0;
let lastTickAt = 0;
let tickCount = 0;
let lastSkipReport = 0;
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x/dia
const ORPHAN_RECOVERY_INTERVAL_MS = 10 * 60 * 1000; // 10 min — recupera jobs travados sem precisar reiniciar worker
const ORPHAN_THRESHOLD_MS = 30 * 60 * 1000; // job 'running' ha > 30 min eh considerado orfao
const STUCK_QUEUED_DIAGNOSE_INTERVAL_MS = 2 * 60 * 1000; // 2 min — diagnostica jobs queued presos
const STUCK_QUEUED_THRESHOLD_MS = 10 * 60 * 1000; // job queued ha > 10min apos scheduledFor eh "preso"
const SKIP_REPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 min entre reports de "jobs pulados pelo cap"
const SET_RECONCILE_INTERVAL_TICKS = 12; // ~1 min em ticks de 5s
const AUTO_UNPAUSE_INTERVAL_MS = 5 * 60 * 1000; // 5 min — checa contas pra despausar
let lastStuckDiagnoseAt = 0;
let lastAutoUnpauseAt = 0;

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

// Diagnostica jobs queued ha > 10 min apos scheduledFor e popula errorMessage
// com motivo provavel. Sem isso, o job fica preso na fila sem feedback visual.
//
// Causas comuns:
//   - Conta nao-active (paused, needs_login, error) — bloqueada pelo filtro do worker
//   - Conta sem perfil AdsPower vinculado
//   - Cap MAX_ACTIVE_ACCOUNTS limitando (conta fora do top N alfabetico)
//   - accountInFlight bloqueado (outro job da mesma conta rodando ha muito tempo)
async function diagnoseStuckQueued(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_QUEUED_THRESHOLD_MS);
  const stuck = await prisma.postJob.findMany({
    where: {
      status: 'queued',
      scheduledFor: { lte: cutoff },
    },
    include: {
      account: { select: { id: true, username: true, status: true, adsPowerProfileId: true } },
    },
    take: 50,
  });
  if (stuck.length === 0) return;

  const cap = await getActiveAccountCap();
  const allowedIds = cap !== null ? await getAllowedAccountIds(cap) : null;

  for (const job of stuck) {
    let reason: string | null = null;
    const acc = job.account;
    if (!acc) {
      reason = 'conta nao encontrada (deletada?)';
    } else if (acc.status === 'paused') {
      reason = `conta @${acc.username} esta PAUSADA — reative em Contas Instagram`;
    } else if (acc.status === 'needs_login') {
      reason = `conta @${acc.username} deslogou do Instagram — abra AdsPower e relogue manual`;
    } else if (acc.status === 'error') {
      reason = `conta @${acc.username} esta em ERRO — verifique logs`;
    } else if (!acc.adsPowerProfileId) {
      reason = `conta @${acc.username} sem perfil AdsPower vinculado — vincule em Contas Instagram`;
    } else if (allowedIds && !allowedIds.has(acc.id)) {
      reason = `cap MAX_ACTIVE_ACCOUNTS=${cap} — conta @${acc.username} fora do top ${cap}. Aumente em Configuracoes`;
    } else if (accountInFlight.has(acc.id)) {
      reason = `outro job da mesma conta @${acc.username} rodando — aguarde ou apague o running travado`;
    }

    // So atualiza se tem reason novo (evita rewrite desnecessario)
    if (reason && job.errorMessage !== reason) {
      await prisma.postJob.update({
        where: { id: job.id },
        data: { errorMessage: reason },
      }).catch(() => undefined);
    }
  }
}

// Recupera jobs travados em 'running' ha mais de 30 min. Roda no startup +
// periodicamente (a cada 10 min) durante a vida do worker, pra cobrir 2 cenarios:
// 1. Worker crashou no meio de um job (recupera no proximo startup)
// 2. Driver pendurou (Playwright zumbi, AdsPower fechou perfil sem callback)
//    e o worker continua rodando — recovery periodico destrava sem reiniciar.
async function recoverOrphans(): Promise<string[]> {
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS);
  // Pega IDs primeiro pra poder limpar do Set inFlight depois
  const orphanRows = await prisma.postJob.findMany({
    where: { status: 'running', startedAt: { lte: cutoff } },
    select: { id: true, accountId: true },
  });
  if (orphanRows.length === 0) return [];
  await prisma.postJob.updateMany({
    where: { status: 'running', startedAt: { lte: cutoff } },
    data: { status: 'queued', startedAt: null },
  });
  // Limpa do Set local (se estavam) — evita race com novo run pelo lock atomico
  for (const o of orphanRows) {
    inFlight.delete(o.id);
    accountInFlight.delete(o.accountId);
  }
  await appLog({
    source: 'worker',
    level: 'warn',
    message: `Recovery: ${orphanRows.length} job(s) orfao(s) voltaram para 'queued' (running ha > 30min)`,
  });
  return orphanRows.map((o) => o.id);
}

export async function startWorker(): Promise<void> {
  // Recovery de jobs orfaos no startup (cobre crash do worker)
  await recoverOrphans();

  // Auto-elevacao do MAX_ACTIVE_ACCOUNTS: se o setting esta com o valor padrao
  // antigo "1" (vindo do seed da Etapa 4 que era pra teste progressivo) MAS o
  // cliente ja tem mais de 1 conta active no banco, eleva pro total automatico
  // pra evitar que jobs fiquem queued indefinidamente sem sinalizar.
  await autoFixActiveAccountsCap();
  // Auto-elevacao do MAX_CONCURRENT_PROFILES: clientes antigos tem env=3 no .env.
  // Se nao tem setting no DB, criamos um com 20 pra desbloquear paralelismo.
  await autoFixMaxConcurrent();

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

async function autoFixMaxConcurrent(): Promise<void> {
  // Se o env.MAX_CONCURRENT_PROFILES eh baixo (<=3, era o default antigo) E o
  // setting do banco nao existe ou tambem eh baixo, cria/atualiza pra 20.
  // Cliente que ja ajustou manualmente pra valor especifico nao eh tocado
  // (so se for menor ou igual a 3).
  if (env.MAX_CONCURRENT_PROFILES > 3) return; // env ja foi atualizado, OK
  const setting = await prisma.appSetting.findUnique({
    where: { key: 'MAX_CONCURRENT_PROFILES' },
  });
  if (setting) {
    const current = parseInt(setting.value, 10);
    if (Number.isFinite(current) && current > 3) return; // user ja configurou maior
  }
  await prisma.appSetting.upsert({
    where: { key: 'MAX_CONCURRENT_PROFILES' },
    update: { value: '20' },
    create: { key: 'MAX_CONCURRENT_PROFILES', value: '20' },
  });
  cachedMaxConcurrent = null; // invalida cache
  await appLog({
    source: 'worker',
    level: 'warn',
    message: `MAX_CONCURRENT_PROFILES estava em ${env.MAX_CONCURRENT_PROFILES} (default antigo). Elevei pra 20 automaticamente. Ajuste em Configuracoes -> Performance se quiser outro valor.`,
  });
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

// Cache em memoria do MAX_CONCURRENT_PROFILES pra nao bater no DB toda iteracao.
let cachedMaxConcurrent: { value: number; at: number } | null = null;
const MAX_CONCURRENT_CACHE_MS = 5000;

async function getMaxConcurrent(): Promise<number> {
  if (cachedMaxConcurrent && Date.now() - cachedMaxConcurrent.at < MAX_CONCURRENT_CACHE_MS) {
    return cachedMaxConcurrent.value;
  }
  let value = env.MAX_CONCURRENT_PROFILES;
  try {
    const setting = await prisma.appSetting.findUnique({
      where: { key: 'MAX_CONCURRENT_PROFILES' },
    });
    if (setting) {
      const n = parseInt(setting.value, 10);
      if (Number.isFinite(n) && n > 0) value = n;
    }
  } catch {
    /* DB indisponivel — cai pro env */
  }
  cachedMaxConcurrent = { value, at: Date.now() };
  return value;
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

// FIX 18: despausa contas que ficaram paused por mais de
// AUTO_UNPAUSE_AFTER_HOURS desde o lastFailureAt. Default 0 = desligado
// (comportamento antigo, user despausa manual). Reset consecutiveFails
// pra dar fresh start.
async function autoUnpauseAccounts(): Promise<void> {
  if (env.AUTO_UNPAUSE_AFTER_HOURS <= 0) return;
  const cutoff = new Date(Date.now() - env.AUTO_UNPAUSE_AFTER_HOURS * 3600_000);
  const result = await prisma.instagramAccount.updateMany({
    where: {
      status: 'paused',
      // Codex P2: SO auto-unpause as que foram auto-pausadas pelo worker.
      // Pausa manual via UI mantem autoPaused=false e nao eh tocada.
      autoPaused: true,
      lastFailureAt: { lt: cutoff },
    },
    data: {
      status: 'active',
      consecutiveFails: 0,
      autoPaused: false,
    },
  });
  if (result.count > 0) {
    await appLog({
      source: 'worker',
      level: 'info',
      message: `[auto-unpause] ${result.count} conta(s) despausada(s) apos ${env.AUTO_UNPAUSE_AFTER_HOURS}h sem nova falha`,
    });
  }
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

  // Recovery periodico de jobs orfaos (a cada 10 min). Cobre caso de driver
  // travado (Playwright pendurado, AdsPower fechou perfil sem callback) sem
  // precisar reiniciar o worker.
  if (Date.now() - lastOrphanRecoveryAt > ORPHAN_RECOVERY_INTERVAL_MS) {
    lastOrphanRecoveryAt = Date.now();
    void recoverOrphans().catch((e) => console.error('[worker] recovery falhou:', e));
  }

  // Diagnostico periodico de jobs queued presos (a cada 2 min). Popula
  // errorMessage com motivo provavel pra Gustavo ver na coluna "Erro" da
  // fila — sem isso o job fica queued indefinitivamente sem indicacao
  // de por que nao roda.
  if (Date.now() - lastStuckDiagnoseAt > STUCK_QUEUED_DIAGNOSE_INTERVAL_MS) {
    lastStuckDiagnoseAt = Date.now();
    void diagnoseStuckQueued().catch((e) => console.error('[worker] diagnose stuck falhou:', e));
  }

  // FIX 18: auto-unpause periodico (a cada 5 min). No-op se
  // AUTO_UNPAUSE_AFTER_HOURS=0 (default).
  if (Date.now() - lastAutoUnpauseAt > AUTO_UNPAUSE_INTERVAL_MS) {
    lastAutoUnpauseAt = Date.now();
    void autoUnpauseAccounts().catch((e) => console.error('[worker] auto-unpause falhou:', e));
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

  const maxConcurrent = await getMaxConcurrent();
  const slots = maxConcurrent - inFlight.size;
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
    if (inFlight.size >= maxConcurrent) break;
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
