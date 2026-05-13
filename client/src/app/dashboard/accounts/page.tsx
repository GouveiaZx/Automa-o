'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { AdsPowerProfile, Campaign, InstagramAccount } from '@automacao/shared';
import { Trash2, Plus, Play, Pause, RefreshCw, Loader2, CheckCircle2, RotateCw } from 'lucide-react';
import { connectSse } from '@/lib/sse';

interface AccountProgress {
  id: string;
  username: string;
  status: string;
  today: { done: number; queued: number; running: number; retry: number; failed: number };
  totalToday: number;
  cycleState: 'idle' | 'running' | 'completed' | 'failures';
}

const CYCLE_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'default'> = {
  completed: 'success',
  running: 'default',
  failures: 'warning',
  idle: 'secondary',
};
const CYCLE_LABEL: Record<string, string> = {
  completed: 'concluído',
  running: 'rodando',
  failures: 'falhas',
  idle: 'sem jobs',
};

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  active: 'success',
  paused: 'destructive',
  needs_login: 'warning',
  error: 'destructive',
};

export default function AccountsPage() {
  const [items, setItems] = useState<InstagramAccount[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [profiles, setProfiles] = useState<AdsPowerProfile[]>([]);
  const [form, setForm] = useState({ username: '', displayName: '', bio: '', groupName: '', campaignId: '', adsPowerProfileId: '' });
  const [filterGroup, setFilterGroup] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [bulkValidating, setBulkValidating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, AccountProgress>>({});
  const [restartingId, setRestartingId] = useState<string | null>(null);

  async function load() {
    const [a, c, p, pg] = await Promise.all([
      api<InstagramAccount[]>('/api/accounts'),
      api<Campaign[]>('/api/campaigns'),
      api<AdsPowerProfile[]>('/api/adspower-profiles'),
      api<AccountProgress[]>('/api/accounts/progress').catch(() => [] as AccountProgress[]),
    ]);
    setItems(a);
    setCampaigns(c);
    setProfiles(p);
    const map: Record<string, AccountProgress> = {};
    for (const x of pg) map[x.id] = x;
    setProgress(map);
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    const off = connectSse((event) => {
      if (event.type === 'account-update' || event.type === 'job-update') load();
    });
    return () => {
      clearInterval(interval);
      off();
    };
  }, []);

  async function restartCycle(id: string, username: string) {
    if (!confirm(`Reagendar ciclo de @${username}?\n\nIsso apaga jobs queued/retry/failed dessa conta e cria jobs novos com base na campanha.`)) return;
    setRestartingId(id);
    try {
      const r = await api<{ deleted: number }>(`/api/accounts/${id}/restart-cycle`, { method: 'POST' });
      alert(`${r.deleted} job(s) apagado(s). Ciclo reagendado.`);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro ao reagendar');
    } finally {
      setRestartingId(null);
    }
  }

  const [bulkRestarting, setBulkRestarting] = useState(false);
  const [bulkRestartProgress, setBulkRestartProgress] = useState<{ done: number; total: number } | null>(null);

  async function bulkRestartCycle() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Reagendar ciclo de ${ids.length} conta${ids.length > 1 ? 's' : ''} selecionada${ids.length > 1 ? 's' : ''}?\n\nIsso apaga jobs queued/retry/failed dessas contas e cria jobs novos com base nas campanhas.`)) return;
    setBulkRestarting(true);
    setBulkRestartProgress({ done: 0, total: ids.length });
    let totalDeleted = 0;
    const failures: string[] = [];
    let done = 0;
    // Processa serialmente pra nao floodar o scheduler nem gerar SSE storm
    for (const id of ids) {
      const acc = items.find((x) => x.id === id);
      try {
        const r = await api<{ deleted: number }>(`/api/accounts/${id}/restart-cycle`, { method: 'POST' });
        totalDeleted += r.deleted;
      } catch (err) {
        failures.push(`@${acc?.username ?? id}: ${err instanceof Error ? err.message : 'erro'}`);
      }
      done++;
      setBulkRestartProgress({ done, total: ids.length });
    }
    setBulkRestarting(false);
    setBulkRestartProgress(null);
    setSelected(new Set());
    if (failures.length > 0) {
      alert(`${ids.length - failures.length} de ${ids.length} reagendadas. ${totalDeleted} job(s) apagado(s).\n\nFalhas:\n${failures.join('\n')}`);
    } else {
      alert(`${ids.length} conta(s) reagendada(s). ${totalDeleted} job(s) apagado(s).`);
    }
    load();
  }

  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function bulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      !confirm(
        `EXCLUIR ${ids.length} conta${ids.length > 1 ? 's' : ''} Instagram do painel?\n\nIsso apaga as contas e todos os jobs/historico delas. NAO afeta o IG nem o AdsPower — so remove do painel. Acao IRREVERSIVEL.`
      )
    )
      return;
    setBulkDeleting(true);
    try {
      const r = await api<{ ok: boolean; deleted: number }>('/api/accounts/bulk-delete', {
        method: 'POST',
        body: { ids },
      });
      alert(`${r.deleted} conta(s) excluida(s).`);
      setSelected(new Set());
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro ao excluir');
    } finally {
      setBulkDeleting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/accounts', {
        method: 'POST',
        body: {
          username: form.username,
          displayName: form.displayName || null,
          bio: form.bio || null,
          groupName: form.groupName || null,
          campaignId: form.campaignId || null,
          adsPowerProfileId: form.adsPowerProfileId || null,
        },
      });
      setForm({ username: '', displayName: '', bio: '', groupName: '', campaignId: '', adsPowerProfileId: '' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  }

  async function setStatus(id: string, status: 'active' | 'paused') {
    await api(`/api/accounts/${id}/status`, { method: 'PATCH', body: { status } });
    load();
  }

  async function remove(id: string) {
    if (!confirm('Excluir conta?')) return;
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    load();
  }

  async function validateAccount(account: InstagramAccount): Promise<{ ok: boolean; reason?: string }> {
    if (!account.adsPowerProfile) {
      return { ok: false, reason: 'sem perfil AdsPower' };
    }
    try {
      const r = await api<{ ok: boolean; logged: boolean; reason?: string }>(
        `/api/diagnostics/test-profile/${account.adsPowerProfile.id}`,
        { method: 'POST' }
      );
      return { ok: r.logged === true, reason: r.reason };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'erro' };
    }
  }

  async function validateOne(account: InstagramAccount) {
    if (!confirm(`Abrir AdsPower de @${account.username} e validar login no Instagram?\n\nDemora 30-60s.`)) return;
    setValidatingId(account.id);
    const r = await validateAccount(account);
    setValidatingId(null);
    if (r.ok) {
      alert(`✓ @${account.username} esta logado no IG`);
    } else {
      alert(`✗ @${account.username}: ${r.reason ?? 'falha desconhecida'}`);
    }
    load();
  }

  async function bulkValidate() {
    const selectedAccounts = items.filter((a) => selected.has(a.id));
    if (selectedAccounts.length === 0) return;
    if (!confirm(`Validar ${selectedAccounts.length} contas? Demora ~30-60s POR conta (sequencial).`)) return;
    setBulkValidating(true);
    const results: { username: string; ok: boolean; reason?: string }[] = [];
    for (const acc of selectedAccounts) {
      const r = await validateAccount(acc);
      results.push({ username: acc.username, ok: r.ok, reason: r.reason });
    }
    setBulkValidating(false);
    setSelected(new Set());
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    let msg = `${okCount} de ${results.length} contas OK`;
    if (failed.length > 0) {
      msg += `\n\nFalhas:\n` + failed.map((f) => `  ✗ @${f.username}: ${f.reason ?? 'erro'}`).join('\n');
    }
    alert(msg);
    load();
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleAll() {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((a) => a.id)));
  }

  async function syncBio(id: string, username: string) {
    if (!confirm(`Sincronizar bio + site no perfil IG @${username}?\n\nO sistema vai abrir o AdsPower e atualizar pelos campos cadastrados aqui.`)) return;
    setSyncingId(id);
    try {
      await api<{ ok: boolean }>(`/api/accounts/${id}/sync-bio`, {
        method: 'POST',
        body: {},
      });
      alert(`Bio de @${username} sincronizada com sucesso ✓`);
    } catch (err) {
      alert(`Falha ao sincronizar bio: ${err instanceof Error ? err.message : 'erro'}\n\nVerifique screenshots em server/media/debug/`);
    } finally {
      setSyncingId(null);
      load();
    }
  }

  const freeProfiles = profiles.filter((p) => !p.account);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Contas Instagram</h2>
        <p className="text-sm text-muted-foreground">
          Vincule cada conta a um perfil AdsPower e a uma campanha.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Nova conta
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Username (sem @)</Label>
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Bio (texto a ser configurado no perfil)</Label>
              <Textarea
                value={form.bio}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
                rows={2}
                placeholder="Texto da bio do perfil IG"
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Grupo (opcional, pra organizar contas)</Label>
              <Input
                placeholder="Ex: Modelo A, Vazadas BR, Conjunto Premium"
                value={form.groupName}
                onChange={(e) => setForm({ ...form, groupName: e.target.value })}
                maxLength={80}
              />
              <p className="text-xs text-muted-foreground">
                Filtra contas por grupo na lista abaixo. Pode usar pra agrupar modelos.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Campanha</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={form.campaignId}
                onChange={(e) => setForm({ ...form, campaignId: e.target.value })}
              >
                <option value="">— sem campanha —</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Perfil AdsPower</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={form.adsPowerProfileId}
                onChange={(e) => setForm({ ...form, adsPowerProfileId: e.target.value })}
              >
                <option value="">— sem perfil —</option>
                {freeProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.adsPowerId})
                  </option>
                ))}
              </select>
            </div>
            {error && <p className="text-destructive text-sm md:col-span-2">{error}</p>}
            <div className="md:col-span-2 flex justify-end">
              <Button type="submit">Criar</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
            <span>Existentes</span>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                value={filterGroup}
                onChange={(e) => {
                  setFilterGroup(e.target.value);
                  setSelected(new Set());
                }}
              >
                <option value="">Todos os grupos</option>
                {Array.from(new Set(items.map((i) => i.groupName).filter(Boolean) as string[]))
                  .sort()
                  .map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
              </select>
              {selected.size > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={bulkValidate}
                  disabled={bulkValidating || bulkRestarting}
                >
                  {bulkValidating ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Validando {selected.size}...</>
                  ) : (
                    <><CheckCircle2 className="h-4 w-4 mr-2" /> Validar {selected.size} selecionada{selected.size > 1 ? 's' : ''}</>
                  )}
                </Button>
              )}
              {selected.size > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={bulkRestartCycle}
                  disabled={bulkRestarting || bulkValidating}
                >
                  {bulkRestarting && bulkRestartProgress ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reagendando {bulkRestartProgress.done}/{bulkRestartProgress.total}...</>
                  ) : (
                    <><RotateCw className="h-4 w-4 mr-2" /> Reagendar {selected.size} ciclo{selected.size > 1 ? 's' : ''}</>
                  )}
                </Button>
              )}
              {selected.size > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={bulkDelete}
                  disabled={bulkDeleting || bulkRestarting || bulkValidating}
                >
                  {bulkDeleting ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Excluindo...</>
                  ) : (
                    <><Trash2 className="h-4 w-4 mr-2" /> Excluir {selected.size} selecionada{selected.size > 1 ? 's' : ''}</>
                  )}
                </Button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={items.length > 0 && selected.size === items.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && selected.size < items.length;
                    }}
                    onChange={toggleAll}
                    aria-label="Selecionar todas"
                  />
                </TableHead>
                <TableHead>Conta</TableHead>
                <TableHead>Grupo</TableHead>
                <TableHead>Campanha</TableHead>
                <TableHead>Perfil AdsPower</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progresso hoje</TableHead>
                <TableHead>Ciclo</TableHead>
                <TableHead>Falhas</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(filterGroup ? items.filter((a) => a.groupName === filterGroup) : items).map((a) => (
                <TableRow key={a.id} data-state={selected.has(a.id) ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggleSelect(a.id)}
                      aria-label={`Selecionar @${a.username}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">@{a.username}</div>
                    {a.displayName && (
                      <div className="text-xs text-muted-foreground">{a.displayName}</div>
                    )}
                    {a.bio && (
                      <div className="text-xs text-muted-foreground italic max-w-xs truncate">
                        {a.bio}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {a.groupName ? <Badge variant="secondary">{a.groupName}</Badge> : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell>{a.campaign?.name ?? '—'}</TableCell>
                  <TableCell>{a.adsPowerProfile?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[a.status] ?? 'secondary'}>{a.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const p = progress[a.id];
                      if (!p || p.totalToday === 0) {
                        return <span className="text-xs text-muted-foreground">—</span>;
                      }
                      const pct = Math.round((p.today.done / p.totalToday) * 100);
                      return (
                        <div className="space-y-1 min-w-[110px]">
                          <div className="text-xs">
                            <span className="font-medium">{p.today.done}</span>
                            <span className="text-muted-foreground"> / {p.totalToday}</span>
                            <span className="text-muted-foreground ml-1">({pct}%)</span>
                          </div>
                          <div className="h-1.5 w-full bg-muted rounded overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          {(p.today.retry > 0 || p.today.failed > 0) && (
                            <div className="text-[10px] text-amber-500">
                              {p.today.retry > 0 && `${p.today.retry} retry`}
                              {p.today.retry > 0 && p.today.failed > 0 && ' · '}
                              {p.today.failed > 0 && `${p.today.failed} fail`}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const p = progress[a.id];
                      if (!p) return <span className="text-xs text-muted-foreground">—</span>;
                      return (
                        <Badge variant={CYCLE_VARIANT[p.cycleState] ?? 'secondary'}>
                          {CYCLE_LABEL[p.cycleState] ?? p.cycleState}
                        </Badge>
                      );
                    })()}
                  </TableCell>
                  <TableCell>{a.consecutiveFails}</TableCell>
                  <TableCell className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Validar login no IG (abre AdsPower)"
                      disabled={validatingId === a.id || !a.adsPowerProfileId}
                      onClick={() => validateOne(a)}
                    >
                      {validatingId === a.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Sincronizar bio no IG"
                      disabled={syncingId === a.id || !a.bio || !a.adsPowerProfileId}
                      onClick={() => syncBio(a.id, a.username)}
                    >
                      {syncingId === a.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Reagendar ciclo (apaga jobs queued/retry/failed e cria novos)"
                      disabled={restartingId === a.id || !a.campaignId}
                      onClick={() => restartCycle(a.id, a.username)}
                    >
                      {restartingId === a.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCw className="h-4 w-4" />
                      )}
                    </Button>
                    {a.status === 'active' ? (
                      <Button size="icon" variant="ghost" onClick={() => setStatus(a.id, 'paused')}>
                        <Pause className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button size="icon" variant="ghost" onClick={() => setStatus(a.id, 'active')}>
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => remove(a.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!items.length && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-6">
                    Nenhuma conta cadastrada.
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
