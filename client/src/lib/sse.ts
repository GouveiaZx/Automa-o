'use client';

import type { SseEvent } from '@automacao/shared';
import { apiBaseUrl, getToken } from './api';

export type SseListener = (event: SseEvent) => void;

export function connectSse(onEvent: SseListener): () => void {
  const token = getToken();
  if (!token) return () => undefined;
  const url = `${apiBaseUrl}/api/events?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);

  const dispatch = (type: SseEvent['type']) => (e: MessageEvent) => {
    try {
      const payload = JSON.parse(e.data);
      onEvent({ type, payload } as SseEvent);
    } catch {
      /* ignore parse error */
    }
  };

  es.addEventListener('log', dispatch('log'));
  es.addEventListener('job-update', dispatch('job-update'));
  es.addEventListener('account-update', dispatch('account-update'));
  es.addEventListener('alert', dispatch('alert'));

  // Se a conexao falhar repetidamente, normalmente eh token expirado (7 dias).
  // EventSource tenta reconectar automaticamente, mas com token velho continua falhando.
  // Detectamos: 5 falhas seguidas em < 30s = provavel auth invalido → forca re-login.
  let errorBurst = 0;
  let firstErrorAt = 0;
  es.onerror = () => {
    const now = Date.now();
    if (now - firstErrorAt > 30_000) {
      errorBurst = 0;
      firstErrorAt = now;
    }
    errorBurst++;
    if (errorBurst >= 5 && es.readyState === EventSource.CLOSED) {
      // Sessao provavelmente expirou — limpa token e manda pro login
      try {
        localStorage.removeItem('jwt');
      } catch {}
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
  };

  return () => es.close();
}
