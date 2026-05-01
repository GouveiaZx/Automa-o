'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { connectSse } from '@/lib/sse';
import type { DashboardSummary, PostJob } from '@automacao/shared';
import { formatDateTime } from '@/lib/utils';

type TimelineJob = PostJob & {
  account?: { id: string; username: string };
  media?: { id: string; type: string; filePath: string };
};

export default function DashboardHomePage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineJob[]>([]);

  async function load() {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);
      const [s, t] = await Promise.all([
        api<DashboardSummary>('/api/dashboard/summary'),
        api<TimelineJob[]>(
          `/api/jobs?from=${startOfDay.toISOString()}&to=${endOfDay.toISOString()}&limit=200`
        ),
      ]);
      setSummary(s);
      setTimeline(t);
    } catch {
      /* api error already handled (redirect on 401) */
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    const off = connectSse((event) => {
      if (event.type === 'job-update' || event.type === 'account-update' || event.type === 'log') {
        load();
      }
    });
    return () => {
      clearInterval(interval);
      off();
    };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Visão geral da operação em tempo real</p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat title="Na fila" value={summary?.jobs.queued ?? 0} variant="info" />
        <Stat title="Rodando" value={summary?.jobs.running ?? 0} variant="default" />
        <Stat title="Em retry" value={summary?.jobs.retry ?? 0} variant="warning" />
        <Stat title="Falhou" value={summary?.jobs.failed ?? 0} variant="destructive" />
        <Stat title="Concluídos hoje" value={summary?.jobs.doneToday ?? 0} variant="success" />
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat title="Contas ativas" value={summary?.accounts.active ?? 0} variant="success" />
        <Stat title="Pausadas" value={summary?.accounts.paused ?? 0} variant="destructive" />
        <Stat title="Sem login" value={summary?.accounts.needsLogin ?? 0} variant="warning" />
        <Stat title="Erro" value={summary?.accounts.error ?? 0} variant="destructive" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Linha do tempo de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <DailyTimeline jobs={timeline} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alertas recentes</CardTitle>
        </CardHeader>
        <CardContent>
          {!summary?.alerts.length ? (
            <p className="text-sm text-muted-foreground">Sem alertas. Operação em ordem.</p>
          ) : (
            <ul className="space-y-2">
              {summary.alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-3 text-sm">
                  <Badge variant={a.severity === 'error' ? 'destructive' : 'warning'}>
                    {a.severity}
                  </Badge>
                  <span className="flex-1">{a.message}</span>
                  <span className="text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DailyTimeline({ jobs }: { jobs: TimelineJob[] }) {
  if (!jobs.length) {
    return <p className="text-sm text-muted-foreground">Nenhum job programado para hoje.</p>;
  }
  const colorByStatus: Record<string, string> = {
    queued: 'bg-blue-500',
    running: 'bg-purple-500 animate-pulse',
    done: 'bg-emerald-500',
    retry: 'bg-amber-500',
    failed: 'bg-red-500',
  };
  return (
    <div className="space-y-3">
      <div className="relative h-12 w-full rounded-md border bg-muted/40 overflow-hidden">
        {Array.from({ length: 25 }).map((_, h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 border-l border-border/40"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            <span className="absolute -top-4 -translate-x-1/2 text-[10px] text-muted-foreground">
              {h}h
            </span>
          </div>
        ))}
        {jobs.map((j) => {
          const d = new Date(j.scheduledFor);
          const minute = d.getHours() * 60 + d.getMinutes();
          const left = (minute / (24 * 60)) * 100;
          return (
            <div
              key={j.id}
              title={`@${j.account?.username} ${j.type} ${j.status} ${formatDateTime(j.scheduledFor)}`}
              className={`absolute top-1 bottom-1 w-1.5 rounded ${colorByStatus[j.status] ?? 'bg-gray-500'}`}
              style={{ left: `${left}%` }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Legend color="bg-blue-500" label="queued" />
        <Legend color="bg-purple-500" label="running" />
        <Legend color="bg-emerald-500" label="done" />
        <Legend color="bg-amber-500" label="retry" />
        <Legend color="bg-red-500" label="failed" />
        <span className="text-muted-foreground ml-auto">{jobs.length} jobs hoje</span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block w-3 h-3 rounded ${color}`} />
      {label}
    </span>
  );
}

function Stat({
  title,
  value,
  variant,
}: {
  title: string;
  value: number;
  variant: 'default' | 'destructive' | 'success' | 'warning' | 'info';
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-semibold">{value}</span>
          <Badge variant={variant} className="opacity-70">
            {variant}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
