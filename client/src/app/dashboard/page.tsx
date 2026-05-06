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

interface WorkerDiag {
  worker: { alive: boolean; lastTickSecondsAgo: number | null; tickCount: number };
  jobs: { queuedReadyNow: number; runningInDb: number; runningInMemory: number };
  accounts: Record<string, number>;
  cap: { configured: number | null; hint: string | null };
}

export default function DashboardHomePage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineJob[]>([]);
  const [workerDiag, setWorkerDiag] = useState<WorkerDiag | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<number | null>(null);

  async function load() {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);
      const [s, t, w] = await Promise.all([
        api<DashboardSummary>('/api/dashboard/summary'),
        api<TimelineJob[]>(
          `/api/jobs?from=${startOfDay.toISOString()}&to=${endOfDay.toISOString()}&limit=200`
        ),
        api<WorkerDiag>('/api/diagnostics/worker').catch(() => null),
      ]);
      setSummary(s);
      setTimeline(t);
      if (w) setWorkerDiag(w);
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
      } else if (event.type === 'worker-heartbeat') {
        setLastHeartbeat(event.payload.at);
      }
    });
    return () => {
      clearInterval(interval);
      off();
    };
  }, []);

  // Considera worker "vivo" se heartbeat foi nos ultimos 30s
  const heartbeatSecondsAgo = lastHeartbeat ? Math.round((Date.now() - lastHeartbeat) / 1000) : null;
  const workerAlive =
    (heartbeatSecondsAgo !== null && heartbeatSecondsAgo < 30) || workerDiag?.worker.alive === true;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Visão geral da operação em tempo real</p>
      </header>

      {/* Status do Worker — vital pra saber se sistema ta processando jobs */}
      <Card className={workerAlive ? 'border-green-700' : 'border-red-700'}>
        <CardContent className="flex items-center gap-4 py-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                workerAlive ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="font-medium text-sm">
              Worker: {workerAlive ? 'ativo' : 'NÃO está respondendo'}
            </span>
            {workerDiag?.worker.lastTickSecondsAgo !== null &&
              workerDiag?.worker.lastTickSecondsAgo !== undefined && (
                <span className="text-xs text-muted-foreground">
                  (último ciclo há {workerDiag.worker.lastTickSecondsAgo}s)
                </span>
              )}
          </div>
          {workerDiag && (
            <div className="text-xs text-muted-foreground flex gap-4">
              <span>{workerDiag.jobs.queuedReadyNow} fila prontos</span>
              <span>{workerDiag.jobs.runningInDb} rodando agora</span>
              {workerDiag.cap.configured !== null && (
                <span>Cap: {workerDiag.cap.configured}</span>
              )}
            </div>
          )}
          {workerDiag?.cap.hint && (
            <div className="w-full text-xs text-yellow-500">⚠ {workerDiag.cap.hint}</div>
          )}
          {!workerAlive && (
            <div className="w-full text-xs text-red-500">
              Worker não está rodando. Feche as 3 janelas do sistema e abra de novo o atalho da área de trabalho.
            </div>
          )}
        </CardContent>
      </Card>

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
