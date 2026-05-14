import net from 'node:net';
import { startWorker, stopWorker } from './queue/poller.js';
import { prisma } from './prisma.js';
import { getDriver } from './automation/driver.js';
import { env } from './env.js';
import { ensureMigrationsOrExit } from './db-init.js';

const WORKER_LOCK_PORT = 39102; // porta loopback usada como mutex cross-platform

function acquireLock(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref(); // nao bloqueia exit do processo
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            'Outro worker ja esta rodando (lock em 127.0.0.1:' +
              WORKER_LOCK_PORT +
              '). Feche a janela antiga antes de abrir uma nova.'
          )
        );
      } else {
        reject(err);
      }
    });
    srv.listen(WORKER_LOCK_PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  let lock: net.Server;
  try {
    lock = await acquireLock();
  } catch (err) {
    console.error('[worker] ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // FIX 19: aplica migrations pendentes antes de startWorker (que vai
  // emitir queries Prisma). Defesa em profundidade contra schema/db mismatch.
  await ensureMigrationsOrExit('worker');

  await startWorker();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWorker();
    // FIX 15 (13/05/2026): se KEEP_PROFILES_OPEN ativo, NAO fecha as sessoes
    // — deixa os browsers AdsPower abertos entre reinicios do worker. User
    // gerencia AdsPower manualmente (pediu pra deixar online direto).
    // Se flag desativa: fecha qualquer perfil AdsPower / browser Playwright
    // aberto para evitar Chromium zumbi consumindo RAM ate reboot.
    const driver = getDriver();
    if (!env.KEEP_PROFILES_OPEN) {
      const openIds = driver.getOpenSessionIds?.() ?? [];
      if (openIds.length > 0) {
        console.log(`[worker] fechando ${openIds.length} sessao(oes) AdsPower abertas...`);
        await Promise.all(
          openIds.map((id) =>
            driver.closeProfile(id).catch((err) => {
              console.error(`[worker] erro fechando perfil ${id}:`, err);
            })
          )
        );
      }
    } else {
      console.log('[worker] KEEP_PROFILES_OPEN=true — deixando sessoes AdsPower abertas');
    }
    await prisma.$disconnect();
    lock.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows: quando usuario clica X na janela do worker, Node mapeia
  // CTRL_CLOSE_EVENT pra SIGHUP. Sem esse handler, perfis AdsPower abertos
  // ficam zumbi consumindo RAM ate reboot. SIGBREAK eh CTRL+BREAK no Windows.
  process.on('SIGHUP', shutdown);
  process.on('SIGBREAK', shutdown);
}

main().catch((err) => {
  console.error('[worker] erro fatal', err);
  process.exit(1);
});
