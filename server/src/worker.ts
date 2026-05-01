import { startWorker, stopWorker } from './queue/poller.js';
import { prisma } from './prisma.js';

async function main() {
  await startWorker();
  const shutdown = async () => {
    stopWorker();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[worker] erro fatal', err);
  process.exit(1);
});
