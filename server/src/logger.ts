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

  const tag = `[${input.source}/${input.level}]`;
  if (input.level === 'error') console.error(tag, input.message, input.metadata ?? '');
  else if (input.level === 'warn') console.warn(tag, input.message, input.metadata ?? '');
  else console.log(tag, input.message);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
