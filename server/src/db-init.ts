import { spawn } from 'node:child_process';

/**
 * FIX 19: aplica migrations pendentes ao subir o server/worker.
 * Idempotente — se tudo ja aplicado, eh no-op rapido (~500ms-1s).
 *
 * Cobre o caso de update.bat ter falhado silenciosamente OU do usuario
 * ter pulado update.bat. Sem isso, queries Prisma com schema/db mismatch
 * retornam 500 ate o user investigar a causa.
 *
 * Em qualquer falha, levanta — caller decide se exit ou continua.
 */
export async function ensureMigrations(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      shell: true, // necessario no Windows pra resolver npx via PATH
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

/**
 * Wrapper que chama ensureMigrations e exit limpo se falhar.
 * Use isso no startup de server.ts e worker.ts pra garantir DB consistente
 * antes de aceitar requests / processar jobs.
 */
export async function ensureMigrationsOrExit(processName: string): Promise<void> {
  try {
    await ensureMigrations();
  } catch (err) {
    console.error('================================');
    console.error(`ERRO CRITICO no startup do ${processName}: prisma migrate deploy falhou.`);
    console.error('Sem isso, queries Prisma vao retornar 500 (Internal Server Error).');
    console.error('Detalhes:', err instanceof Error ? err.message : err);
    console.error('');
    console.error('Solucao manual: cd server && npx prisma migrate deploy');
    console.error('================================');
    process.exit(1);
  }
}
