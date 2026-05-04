import { prisma } from './prisma.js';
import { bus } from './events.js';
import type { LogLevel, LogSource } from '@automacao/shared';

interface LogInput {
  level: LogLevel;
  source: LogSource;
  message: string;
  accountId?: string | null;
  jobId?: string | null;
  metadata?: unknown;
}

export async function appLog(input: LogInput): Promise<void> {
  // Sempre loga no console primeiro — esse caminho NUNCA deve crashar caller
  // (ex: se DB esta locked, nao queremos derrubar o worker mid-job).
  const tag = `[${input.source}/${input.level}]`;
  if (input.level === 'error') console.error(tag, input.message, input.metadata ?? '');
  else if (input.level === 'warn') console.warn(tag, input.message, input.metadata ?? '');
  else console.log(tag, input.message);

  try {
    const created = await prisma.automationLog.create({
      data: {
        level: input.level,
        source: input.source,
        message: input.message,
        accountId: input.accountId ?? null,
        jobId: input.jobId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    });

    const formatted = {
      id: created.id,
      level: created.level as LogLevel,
      source: created.source as LogSource,
      accountId: created.accountId,
      jobId: created.jobId,
      message: created.message,
      metadata: created.metadata ? safeJson(created.metadata) : null,
      createdAt: created.createdAt.toISOString(),
    };

    bus.emitEvent({ type: 'log', payload: formatted });
  } catch (err) {
    // DB indisponivel ou bus.emit falhou — nao propaga, ja temos console fallback
    console.error('[logger] falha persistindo log (DB?):', err instanceof Error ? err.message : err);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

export async function cleanupOldLogs(retentionMs = LOG_RETENTION_MS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const r = await prisma.automationLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return r.count;
}
