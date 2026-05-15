'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { Campaign, InstagramAccount, MediaItem, PostJob } from '@automacao/shared';
import { connectSse } from '@/lib/sse';
import { formatDateTime } from '@/lib/utils';
import { Plus, RotateCcw, Trash2, Layers } from 'lucide-react';

type JobWithRefs = PostJob & {
  account?: { id: string; username: string };
  media?: { id: string; type: string; filePath: string };
};

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'info' | 'default' | 'secondary'> = {
  queued: 'info',
  running: 'default',
  done: 'success',
  retry: 'warning',
  failed: 'destructive',
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobWithRefs[]>([]);
  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [accountId, setAccountId] = useState('');
  const [mediaId, setMediaId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // bulk
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAccountIds, setBulkAccountIds] = useState<string[]>([]);
  const [bulkMediaIds, setBulkMediaIds] = useState<string[]>([]);
  const [bulkSpread, setBulkSpread] = useState<'now' | 'hour' | 'today' | '24h' | 'campaign'>('today');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkFilterGroup, setBulkFilterGroup] = useState<string>('');
  // FIX 20: filtro de campanha em "Agendar lote" pra acelerar selecao quando
  // user tem ~25 contas distribuidas em varias campanhas.
  const [bulkFilterCampaignId, setBulkFilterCampaignId] = useState<string>('');
  const [bulkFilterTag, setBulkFilterTag] = useState<string>('');
  // FIX 24.1: indicador de "tem jobs hoje?" na lista de Agendar lote.
  // accounts/progress retorna { [accountId]: { today: { done }, totalToday, cycleState } }
  const [progress, setProgress] = useState<Record<string, { today: { done: number }; totalToday: number; cycleState: string }>>({});

  async function load() {
    const [j, a, m, c, p] = await Promise.all([
      api<JobWithRefs[]>('/api/jobs?limit=200'),
      api<InstagramAccount[]>('/api/accounts'),
      api<MediaItem[]>('/api/media'),
      api<Campaign[]>('/api/campaigns'),
      api<Record<string, { today: { done: number }; totalToday: number; cycleState: string }>>('/api/accounts/progress').catch(() => ({})),
    ]);
    setJobs(j);
    setAccounts(a);
    setMedia(m);
    setCampaigns(c);
    setProgress(p);
  }

  useEffect(() => {
    load();
    const off = connectSse((event) => {
      if (event.type === 'job-update') load();
    });
    return () => off();
  }, []);

  async function schedule(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/jobs/schedule', { method: 'POST', body: { accountId, mediaId } });
      setAccountId('');
      setMediaId('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  }

  async function retry(id: string) {
    await api(`/api/jobs/${id}/retry`, { method: 'POST' });
    load();
  }

  async function remove(id: string) {
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
    load();
  }

  async function clearDone() {
    const doneCount = jobs.filter((j) => j.status === 'done').length;
    if (doneCount === 0) return;
    if (!confirm(`Apagar ${doneCount} job${doneCount > 1 ? 's' : ''} concluido${doneCount > 1 ? 's' : ''}?`)) return;
    const r = await api<{ count: number }>('/api/jobs?status=done', { method: 'DELETE' });
    alert(`${r.count} job(s) apagado(s)`);
    load();
  }

  async function submitBulk() {
    if (bulkAccountIds.length === 0 || bulkMediaIds.length === 0) return;
    setBulkBusy(true);
    try {
      // Se 1 conta, usa endpoint single (mais simples). Se 2+, usa multi.
      if (bulkAccountIds.length === 1) {
        await api('/api/jobs/schedule-bulk', {
          method: 'POST',
          body: {
            accountId: bulkAccountIds[0],
            mediaIds: bulkMediaIds,
            spreadOver: bulkSpread,
          },
        });
      } else {
        await api('/api/jobs/schedule-bulk-multi', {
          method: 'POST',
          body: {
            accountIds: bulkAccountIds,
            mediaIds: bulkMediaIds,
            spreadOver: bulkSpread,
          },
        });
      }
      setBulkOpen(false);
      setBulkAccountIds([]);
      setBulkMediaIds([]);
      setBulkSpread('today');
      setBulkFilterGroup('');
      setBulkFilterTag('');
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro no bulk');
    } finally {
      setBulkBusy(false);
    }
  }

  function toggleBulkMedia(id: string) {
    setBulkMediaIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleBulkAccount(id: string) {
    setBulkAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Fila de jobs</h2>
          <p className="text-sm text-muted-foreground">
            Agendamentos de postagem. Worker processa em ordem com retry automático.
          </p>
        </div>
        <Button variant="outline" onClick={() => setBulkOpen(true)}>
          <Layers className="h-4 w-4" /> Agendar lote
        </Button>
      </header>

      {bulkOpen && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle>Agendar lote</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Label>Contas ({bulkAccountIds.length} selecionada{bulkAccountIds.length !== 1 ? 's' : ''})</Label>
                <div className="flex gap-2 items-center flex-wrap">
                  <select
                    className="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                    value={bulkFilterGroup}
                    onChange={(e) => setBulkFilterGroup(e.target.value)}
                  >
                    <option value="">Todos os grupos</option>
                    {Array.from(new Set(accounts.map((a) => a.groupName).filter(Boolean) as string[]))
                      .sort()
                      .map((g) => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                  </select>
                  <select
                    className="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                    value={bulkFilterCampaignId}
                    onChange={(e) => setBulkFilterCampaignId(e.target.value)}
                  >
                    <option value="">Todas as campanhas</option>
                    {campaigns
                      .slice()
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      const filtered = accounts.filter(
                        (a) =>
                          (!bulkFilterGroup || a.groupName === bulkFilterGroup) &&
                          (!bulkFilterCampaignId || a.campaignId === bulkFilterCampaignId)
                      );
                      const allIds = filtered.map((a) => a.id);
                      const allSelected = allIds.every((id) => bulkAccountIds.includes(id));
                      if (allSelected) {
                        setBulkAccountIds((prev) => prev.filter((id) => !allIds.includes(id)));
                      } else {
                        setBulkAccountIds((prev) => Array.from(new Set([...prev, ...allIds])));
                      }
                    }}
                  >
                    {accounts.length > 0 && bulkAccountIds.length === accounts.length ? 'Desmarcar todas' : 'Marcar todas'}
                  </button>
                </div>
              </div>
              <div className="border rounded-md max-h-48 overflow-auto">
                {accounts
                  .filter(
                    (a) =>
                      (!bulkFilterGroup || a.groupName === bulkFilterGroup) &&
                      (!bulkFilterCampaignId || a.campaignId === bulkFilterCampaignId)
                  )
                  .map((a) => {
                  const checked = bulkAccountIds.includes(a.id);
                  // FIX 24.1: badge com status de jobs hoje (rodando/concluido/sem jobs)
                  const p = progress[a.id];
                  let jobBadge: React.ReactNode = null;
                  if (!p || p.totalToday === 0) {
                    jobBadge = <Badge variant="secondary" className="text-xs">sem jobs</Badge>;
                  } else if (p.cycleState === 'concluido') {
                    jobBadge = <Badge variant="success" className="text-xs">concluido {p.today.done}/{p.totalToday}</Badge>;
                  } else {
                    jobBadge = <Badge variant="info" className="text-xs">rodando {p.today.done}/{p.totalToday}</Badge>;
                  }
                  return (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-accent cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBulkAccount(a.id)}
                      />
                      <span className="font-medium">@{a.username}</span>
                      {a.groupName && (
                        <Badge variant="secondary" className="text-xs">{a.groupName}</Badge>
                      )}
                      <span className="text-muted-foreground text-xs flex-1 truncate">
                        {a.campaign?.name ?? 'sem campanha'}
                      </span>
                      {jobBadge}
                    </label>
                  );
                })}
                {!accounts.length && (
                  <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                    Nenhuma conta cadastrada.
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <Label>Mídias ({bulkMediaIds.length} selecionadas)</Label>
                <div className="flex gap-2 items-center">
                  <select
                    className="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                    value={bulkFilterTag}
                    onChange={(e) => setBulkFilterTag(e.target.value)}
                  >
                    <option value="">Todas as tags</option>
                    {Array.from(new Set(media.map((m) => m.tag).filter(Boolean) as string[]))
                      .sort()
                      .map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      const filtered = bulkFilterTag
                        ? media.filter((m) => m.tag === bulkFilterTag)
                        : media;
                      const allIds = filtered.map((m) => m.id);
                      const allSelected = allIds.length > 0 && allIds.every((id) => bulkMediaIds.includes(id));
                      if (allSelected) {
                        setBulkMediaIds((prev) => prev.filter((id) => !allIds.includes(id)));
                      } else {
                        setBulkMediaIds((prev) => Array.from(new Set([...prev, ...allIds])));
                      }
                    }}
                  >
                    {(() => {
                      const filtered = bulkFilterTag ? media.filter((m) => m.tag === bulkFilterTag) : media;
                      const allIds = filtered.map((m) => m.id);
                      const allSelected = allIds.length > 0 && allIds.every((id) => bulkMediaIds.includes(id));
                      return allSelected ? 'Desmarcar todas' : 'Marcar todas';
                    })()}
                  </button>
                </div>
              </div>
              <div className="border rounded-md max-h-64 overflow-auto">
                {(bulkFilterTag ? media.filter((m) => m.tag === bulkFilterTag) : media).map((m) => {
                  const checked = bulkMediaIds.includes(m.id);
                  return (
                    <label
                      key={m.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-accent cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBulkMedia(m.id)}
                      />
                      <Badge variant={m.type === 'reel' ? 'default' : 'secondary'}>{m.type}</Badge>
                      {m.tag && <Badge variant="outline" className="text-xs">{m.tag}</Badge>}
                      <span className="font-mono text-xs flex-1 truncate">{m.filePath}</span>
                      {m.caption && (
                        <span className="text-xs text-muted-foreground truncate max-w-xs">
                          {m.caption}
                        </span>
                      )}
                    </label>
                  );
                })}
                {!media.length && (
                  <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                    Nenhuma mídia disponível.
                  </p>
                )}
              </div>
            </div>
            {bulkAccountIds.length > 0 && bulkMediaIds.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Total: <strong>{bulkAccountIds.length} contas × {bulkMediaIds.length} mídias = {bulkAccountIds.length * bulkMediaIds.length} jobs</strong>
              </p>
            )}
            <div className="space-y-1">
              <Label>Distribuição</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={bulkSpread}
                onChange={(e) =>
                  setBulkSpread(e.target.value as 'now' | 'hour' | 'today' | '24h' | 'campaign')
                }
              >
                <option value="now">Agora (todos imediatos)</option>
                <option value="hour">Espalhar pela próxima 1 hora</option>
                <option value="today">Espalhar até o final do dia</option>
                <option value="24h">Espalhar pelas próximas 24 horas</option>
                <option value="campaign">Horários fixos da campanha (usa o que tá na campanha de cada conta)</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setBulkOpen(false)}>
                Cancelar
              </Button>
              <Button
                onClick={submitBulk}
                disabled={bulkBusy || bulkAccountIds.length === 0 || bulkMediaIds.length === 0}
              >
                {bulkBusy
                  ? 'Agendando...'
                  : `Agendar ${bulkAccountIds.length * bulkMediaIds.length} jobs`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Agendar postagem
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={schedule} className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div className="space-y-1">
              <Label>Conta</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                required
              >
                <option value="">— escolha —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username} ({a.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Mídia</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={mediaId}
                onChange={(e) => setMediaId(e.target.value)}
                required
              >
                <option value="">— escolha —</option>
                {media.map((m) => (
                  <option key={m.id} value={m.id}>
                    [{m.type}] {m.filePath} {m.caption ? `— ${m.caption.slice(0, 40)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {error && <p className="text-destructive text-sm md:col-span-2">{error}</p>}
            <div className="md:col-span-2 flex justify-end">
              <Button type="submit" disabled={!accountId || !mediaId}>
                Agendar agora
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>Jobs</span>
            {jobs.some((j) => j.status === 'done') && (
              <Button size="sm" variant="outline" onClick={clearDone}>
                <Trash2 className="h-4 w-4" /> Limpar concluidos ({jobs.filter((j) => j.status === 'done').length})
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Conta</TableHead>
                <TableHead>Mídia</TableHead>
                <TableHead>Agendado p/</TableHead>
                <TableHead>Tent.</TableHead>
                <TableHead>Erro</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[j.status] ?? 'secondary'}>{j.status}</Badge>
                  </TableCell>
                  <TableCell>{j.type}</TableCell>
                  <TableCell>@{j.account?.username ?? '?'}</TableCell>
                  <TableCell className="font-mono text-xs">{j.media?.filePath?.slice(0, 12)}…</TableCell>
                  <TableCell>{formatDateTime(j.scheduledFor)}</TableCell>
                  <TableCell>{j.attempts}</TableCell>
                  <TableCell className="text-destructive text-xs max-w-xs truncate">
                    {j.errorMessage ?? '—'}
                  </TableCell>
                  <TableCell className="flex gap-1">
                    {(j.status === 'failed' || j.status === 'retry') && (
                      <Button size="icon" variant="ghost" onClick={() => retry(j.id)}>
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                    {j.status !== 'running' && (
                      <Button size="icon" variant="ghost" onClick={() => remove(j.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!jobs.length && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    Sem jobs ainda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
