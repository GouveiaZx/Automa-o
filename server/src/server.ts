import { buildApp } from './app.js';
import { env } from './env.js';

async function main() {
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
