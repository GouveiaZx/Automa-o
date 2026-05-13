import { join } from 'node:path';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { bus } from '../events.js';
import { appLog } from '../logger.js';
import { getDriver } from '../automation/driver.js';
import { scheduleNextForAccount } from '../automation/scheduler.js';

const MEDIA_DIR = join(process.cwd(), 'media');

export async function processJob(jobId: string): Promise<void> {
  const job = await prisma.postJob.findUnique({
    where: { id: jobId },
    include: {
      account: { include: { adsPowerProfile: true } },
      media: true,
    },
  });
  if (!job) return;
  if (!job.account.adsPowerProfile) {
    await markFailed(job.id, 'account_without_profile', job.attempts);
    return;
  }
  if (job.account.status !== 'active') {
    await appLog({
      source: 'worker',
      level: 'warn',
      message: `Job ${job.id} ignorado: conta @${job.account.username} status=${job.account.status}`,
      jobId: job.id,
      accountId: job.accountId,
    });
    await prisma.postJob.update({
      where: { id: job.id },
      data: { status: 'queued', scheduledFor: new Date(Date.now() + 5 * 60 * 1000) },
    });
    return;
  }

  const driver = getDriver();
  const adsId = job.account.adsPowerProfile.adsPowerId;
  const filePath = join(MEDIA_DIR, job.media.filePath);

  await emitJob(job.id);
  await appLog({
    source: 'worker',
    level: 'info',
    message: `Processando job ${job.id} (${job.type}) @${job.account.username}`,
    jobId: job.id,
    accountId: job.accountId,
  });

  try {
    const opened = await driver.openProfile(adsId);
    if (!opened.ok) {
      throw new Error(opened.reason ?? 'openProfile_failed');
    }

    const logged = await driver.ensureLoggedIn(adsId, job.account.username);
    if (!logged) {
      await prisma.instagramAccount.update({
        where: { id: job.accountId },
        data: { status: 'needs_login' },
      });
      bus.emitEvent({
        type: 'alert',
        payload: {
          severity: 'warn',
          message: `@${job.account.username} precisa de login manual no AdsPower`,
          sound: true,
        },
      });
      throw new Error('not_logged_in');
    }

    const result =
      job.type === 'story'
        ? await driver.postStory({
            adsPowerId: adsId,
            filePath,
            caption: job.media.caption,
            linkUrl: job.media.linkUrl,
            igUsername: job.account.username,
          })
        : await driver.postReel({
            adsPowerId: adsId,
            filePath,
            caption: job.media.caption,
            igUsername: job.account.username,
          });

    // Story usa mobile UA spoof via initScript que CONTAMINA o contexto.
    // Forca closeProfile depois de story mesmo com KEEP_PROFILES_OPEN=true,
    // pra proximo job (feed/reel) abrir contexto fresh sem o spoof grudado.
    const storyContaminatedContext = job.type === 'story';
    if (!env.KEEP_PROFILES_OPEN || storyContaminatedContext) {
      await driver.closeProfile(adsId).catch(() => undefined);
    }

    if (!result.ok) throw new Error(result.reason ?? 'post_failed');

    await prisma.$transaction([
      prisma.postJob.update({
        where: { id: job.id },
        data: { status: 'done', finishedAt: new Date(), errorMessage: null },
      }),
      prisma.mediaItem.update({
        where: { id: job.mediaId },
        data: { publishedAt: new Date(), usedCount: { increment: 1 } },
      }),
      prisma.instagramAccount.update({
        where: { id: job.accountId },
        data: { consecutiveFails: 0 },
      }),
    ]);

    await emitJob(job.id);
    await appLog({
      source: 'worker',
      level: 'info',
      message: `Job ${job.id} concluído com sucesso`,
      jobId: job.id,
      accountId: job.accountId,
    });

    await scheduleNextForAccount(job.accountId).catch((err) =>
      appLog({
        source: 'worker',
        level: 'warn',
        message: `Falha ao reagendar próximos jobs: ${String(err)}`,
        accountId: job.accountId,
      })
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown_error';

    // Codex P2-1: persiste status no DB ANTES de closeProfile, fechando a
    // janela onde um crash deixaria a conta em status='active' inconsistente
    // com a falha que ja aconteceu.

    // Checkpoint do IG: pausa a conta IMEDIATAMENTE sem gastar retries.
    // Cada retry perderia 10-20min sem resolver nada (IG so libera apos
    // resolucao manual no AdsPower). Marca o job como failed na hora e
    // alerta o user pra resolver na mao.
    // Codex P2-2: usa ":" no startsWith pra evitar colisao com erros futuros
    // que comecem com "account_in_checkpoint" sem ser checkpoint de fato.
    if (reason.startsWith('account_in_checkpoint:')) {
      await markCheckpoint(job.id, reason, job.attempts, job.accountId, job.account.username);
    } else {
      await onFailure(job.id, reason, job.attempts, job.accountId);
    }

    // FIX 15 (13/05/2026): respeita KEEP_PROFILES_OPEN tambem no error path.
    // Antes fechava sempre "pra evitar sessao zumbi", mas o healthcheck do
    // openProfile (FIX 13) ja detecta sessao broken no proximo job e reabre
    // se necessario — entao o close aqui era defesa redundante.
    // User pediu pra deixar perfis sempre online ("vc nao quer deixar os
    // perfis online direto? Cara eu acho melhor").
    if (!env.KEEP_PROFILES_OPEN) {
      await driver.closeProfile(adsId).catch(() => undefined);
    }
  }
}

async function markCheckpoint(
  jobId: string,
  reason: string,
  attempts: number,
  accountId: string,
  username: string
): Promise<void> {
  await prisma.$transaction([
    prisma.postJob.update({
      where: { id: jobId },
      data: { status: 'failed', errorMessage: reason, finishedAt: new Date(), attempts },
    }),
    prisma.instagramAccount.update({
      where: { id: accountId },
      data: {
        status: 'needs_login',
        lastFailureAt: new Date(),
        consecutiveFails: { increment: 1 },
      },
    }),
  ]);
  bus.emitEvent({
    type: 'alert',
    payload: {
      severity: 'error',
      message: `@${username} em CHECKPOINT do IG (${reason}). Abre AdsPower, resolve o desafio manual e despausa a conta.`,
      sound: true,
    },
  });
  await appLog({
    source: 'worker',
    level: 'error',
    message: `Job ${jobId} cancelado: @${username} em checkpoint do IG (${reason}). Conta pausada — exige resolucao manual.`,
    jobId,
    accountId,
  });
  await emitJob(jobId);
}

async function onFailure(
  jobId: string,
  reason: string,
  attempts: number,
  accountId: string
): Promise<void> {
  const max = env.MAX_JOB_ATTEMPTS;
  if (attempts >= max) {
    await prisma.$transaction([
      prisma.postJob.update({
        where: { id: jobId },
        data: { status: 'failed', errorMessage: reason, finishedAt: new Date(), attempts },
      }),
      prisma.instagramAccount.update({
        where: { id: accountId },
        data: {
          status: 'paused',
          lastFailureAt: new Date(),
          consecutiveFails: { increment: 1 },
        },
      }),
    ]);
    bus.emitEvent({
      type: 'alert',
      payload: {
        severity: 'error',
        message: `Conta pausada após ${attempts} falhas: ${reason}`,
        sound: true,
      },
    });
    await appLog({
      source: 'worker',
      level: 'error',
      message: `Job ${jobId} falhou definitivamente após ${attempts} tentativas (${reason}). Conta pausada.`,
      jobId,
      accountId,
    });
  } else {
    const delayMs = Math.pow(2, attempts) * 5 * 60 * 1000;
    await prisma.postJob.update({
      where: { id: jobId },
      data: {
        status: 'retry',
        attempts,
        errorMessage: reason,
        scheduledFor: new Date(Date.now() + delayMs),
      },
    });
    await appLog({
      source: 'worker',
      level: 'warn',
      message: `Job ${jobId} falhou (tentativa ${attempts}/${max}) — retry em ${Math.round(delayMs / 60000)}min: ${reason}`,
      jobId,
      accountId,
    });
  }
  await emitJob(jobId);
}

async function markFailed(jobId: string, reason: string, attempts: number): Promise<void> {
  await prisma.postJob.update({
    where: { id: jobId },
    data: { status: 'failed', errorMessage: reason, finishedAt: new Date(), attempts },
  });
  await emitJob(jobId);
}

async function emitJob(jobId: string): Promise<void> {
  const j = await prisma.postJob.findUnique({ where: { id: jobId } });
  if (!j) return;
  bus.emitEvent({
    type: 'job-update',
    payload: {
      id: j.id,
      accountId: j.accountId,
      mediaId: j.mediaId,
      type: j.type as 'story' | 'reel' | 'photo',
      status: j.status as 'queued' | 'running' | 'done' | 'failed' | 'retry',
      attempts: j.attempts,
      scheduledFor: j.scheduledFor.toISOString(),
      startedAt: j.startedAt ? j.startedAt.toISOString() : null,
      finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
      errorMessage: j.errorMessage,
      createdAt: j.createdAt.toISOString(),
    },
  });
}
