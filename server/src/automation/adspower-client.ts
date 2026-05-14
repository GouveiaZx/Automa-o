import { env } from '../env.js';

interface AdsPowerResponse<T> {
  code: number;
  msg: string;
  data: T;
}

interface StartBrowserData {
  ws: { puppeteer: string; selenium: string };
  debug_port: string;
  webdriver: string;
}

interface ProfileData {
  user_id: string;
  name: string;
  group_name?: string;
  remark?: string;
  // FIX 20: AdsPower retorna country/ip_country dependendo da versao.
  // Capturamos ambos pra cobrir variacoes da API.
  country?: string;
  ip_country?: string;
}

interface ProfileListData {
  list: ProfileData[];
  page: number;
  page_size: number;
}

export class AdsPowerError extends Error {
  constructor(public code: number, message: string) {
    super(`[AdsPower] ${message} (code ${code})`);
    this.name = 'AdsPowerError';
  }
}

// AdsPower local API tem limite hard de 1 req/segundo. Serializamos todas as
// chamadas e garantimos um gap mínimo entre elas, independente de quem chame.
const MIN_GAP_MS = 1100;
let lastCallAt = 0;
let chain: Promise<unknown> = Promise.resolve();

async function throttle(): Promise<void> {
  const next = chain.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  chain = next.catch(() => undefined);
  await next;
}

async function call<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, env.ADSPOWER_API_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  if (env.ADSPOWER_API_KEY) {
    url.searchParams.set('api_key', env.ADSPOWER_API_KEY);
  }

  await throttle();

  let res: Response;
  try {
    res = await fetch(url.toString(), { method: 'GET' });
  } catch (err) {
    throw new AdsPowerError(
      -1,
      `Falha ao conectar em ${env.ADSPOWER_API_URL}: ${err instanceof Error ? err.message : 'unknown'}. AdsPower está rodando?`
    );
  }
  if (!res.ok) throw new AdsPowerError(res.status, `HTTP ${res.status}`);

  const json = (await res.json()) as AdsPowerResponse<T>;
  if (json.code !== 0) {
    const msg = json.msg || 'erro desconhecido do AdsPower';
    // Erros conhecidos do AdsPower que merecem tratamento especial
    if (/daily limit|limite di[áa]rio/i.test(msg)) {
      throw new AdsPowerError(
        json.code,
        `${msg} — A versão grátis do AdsPower limita aberturas/dia. Use plano pago ou aguarde 24h.`
      );
    }
    if (/profile does not exist|user.*does not exist/i.test(msg)) {
      throw new AdsPowerError(
        json.code,
        `${msg} — Confirme o user_id no AdsPower (perfil pode ter sido excluído).`
      );
    }
    if (/too many request/i.test(msg)) {
      throw new AdsPowerError(
        json.code,
        `${msg} — Rate limit do AdsPower (1 req/s). Sistema já throttla mas pode ter conflito.`
      );
    }
    throw new AdsPowerError(json.code, msg);
  }
  return json.data;
}

export const adsPowerClient = {
  async health(): Promise<{ ok: boolean; reachable: boolean; error?: string }> {
    try {
      await throttle();
      await fetch(new URL('/status', env.ADSPOWER_API_URL).toString(), { method: 'GET' });
      return { ok: true, reachable: true };
    } catch (err) {
      return {
        ok: false,
        reachable: false,
        error: err instanceof Error ? err.message : 'unknown',
      };
    }
  },

  async listProfiles(page = 1, pageSize = 100): Promise<ProfileData[]> {
    const data = await call<ProfileListData>('/api/v1/user/list', {
      page: String(page),
      page_size: String(pageSize),
    });
    return data.list ?? [];
  },

  async startBrowser(userId: string): Promise<StartBrowserData> {
    return call<StartBrowserData>('/api/v1/browser/start', {
      user_id: userId,
      headless: '0',
      open_tabs: '0',
    });
  },

  async stopBrowser(userId: string): Promise<void> {
    await call<unknown>('/api/v1/browser/stop', { user_id: userId });
  },

  async browserStatus(userId: string): Promise<'Active' | 'Inactive'> {
    const data = await call<{ status: string }>('/api/v1/browser/active', { user_id: userId });
    return data.status === 'Active' ? 'Active' : 'Inactive';
  },
};
