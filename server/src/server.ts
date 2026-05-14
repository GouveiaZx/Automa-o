import { buildApp } from './app.js';
import { env } from './env.js';
import { ensureMigrationsOrExit } from './db-init.js';

async function main() {
  // FIX 19: aplica migrations pendentes ANTES de buildApp (que carrega Prisma
  // client). Defesa em profundidade: cobre caso de update.bat ter falhado
  // silente ou user ter pulado o update.
  await ensureMigrationsOrExit('server');

  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`API rodando em http://${env.HOST}:${env.PORT} (mode=${env.AUTOMATION_MODE})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
