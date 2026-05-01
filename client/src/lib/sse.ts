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

  es.onerror = () => {
    /* reconexão automática do EventSource */
  };

  return () => es.close();
}
