'use client';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3010';
const TOKEN_KEY = 'auth_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(TOKEN_KEY);
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(public status: number, public payload: unknown) {
    super(typeof payload === 'object' && payload && 'error' in payload ? String((payload as { error: string }).error) : 'api_error');
  }
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    signal: options.signal,
  };
  if (options.formData) {
    init.body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/login')) {
      clearToken();
      window.location.href = '/login';
    }
    throw new ApiError(res.status, payload);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const apiBaseUrl = API_URL;
