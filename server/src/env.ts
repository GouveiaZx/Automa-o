import { z } from 'zod';

const schema = z.object({
  AUTOMATION_MODE: z.enum(['mock', 'real']).default('mock'),
  DATABASE_URL: z.string().default('file:./dev.db'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter pelo menos 16 chars'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  ADMIN_EMAIL: z.string().min(3).default('admin@local'),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(6).default('admin123'),
  MAX_CONCURRENT_PROFILES: z.coerce.number().int().positive().default(3),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  MAX_JOB_ATTEMPTS: z.coerce.number().int().positive().default(2),
  AUTOMATION_MOCK_FAIL_RATE: z.coerce.number().min(0).max(1).default(0.1),
  AUTOMATION_MOCK_MIN_DELAY: z.coerce.number().int().nonnegative().default(2000),
  AUTOMATION_MOCK_MAX_DELAY: z.coerce.number().int().nonnegative().default(8000),
  ADSPOWER_API_URL: z.string().default('http://local.adspower.net:50325'),
  ADSPOWER_API_KEY: z.string().optional(),
  PLAYWRIGHT_HEADLESS: z.string().default('false'),
  PLAYWRIGHT_SLOW_MO_MS: z.coerce.number().int().nonnegative().default(0),
  // Quando true, NAO fecha o navegador entre jobs (perfis ficam abertos).
  // Trade-off: mais RAM (~300-500MB por perfil) vs nao precisa abrir/fechar AdsPower toda vez.
  // Ao fechar a janela do worker, todos os perfis abertos sao fechados via SIGTERM handler.
  KEEP_PROFILES_OPEN: z.coerce.boolean().default(false),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] Variáveis inválidas:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export const env: Env = new Proxy({} as Env, {
  get(_t, prop) {
    return loadEnv()[prop as keyof Env];
  },
});
