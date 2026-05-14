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
import { Trash2, Plus, Play, Pause, RefreshCw, Loader2, CheckCircle2, RotateCw, Link2 } from 'lucide-react';
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
  // FIX 20: filtro por pais (vindo do AdsPower profile vinculado)
  const [filterCountry, setFilterCountry] = useState<string>('');
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
  const [autoLinking, setAutoLinking] = useState(false);
  const [autoCreating, setAutoCreating] = useState(false);
  // FIX 22.1: modal inline pra "Criar contas dos perfis" (substitui prompts feios
  // que pediam id de campanha — user colava nome e dava "erro ao criar" generico)
  const [autoCreateOpen, setAutoCreateOpen] = useState(false);
  const [autoCreateCampaignId, setAutoCreateCampaignId] = useState<string>('');
  const [autoCreateGroupName, setAutoCreateGroupName] = useState<string>('');
  const [syncingFollowers, setSyncingFollowers] = useState(false);

  async function syncFollowers() {
    if (syncingFollowers) return;
    if (!confirm('Sincronizar seguidores de TODAS as contas com perfil vinculado?\n\nLento (1 conta por vez, ~10s cada). Pode demorar varios minutos se voce tiver muitas contas.')) return;
    setSyncingFollowers(true);
    try {
      const r = await api<{
        ok: boolean;
        total: number;
        updated: number;
        failedCount: number;
        failed: string[];
      }>('/api/accounts/sync-followers', { method: 'POST' });
      const lines = [
        `${r.updated} de ${r.total} conta(s) atualizada(s)`,
      ];
      if (r.failedCount > 0) {
        lines.push(`${r.failedCount} falha(s):`);
        lines.push(...r.failed);
      }
      alert(lines.join('\n'));
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro ao sincronizar');
    } finally {
      setSyncingFollowers(false);
    }
  }

  // Botao "Criar contas dos perfis" agora abre o modal inline em vez de
  // disparar 2 prompts de browser. Modal tem select real de campanha,
  // input de grupo, e botao Criar.
  function openAutoCreate() {
    if (autoCreating) return;
    setAutoCreateCampaignId('');
    setAutoCreateGroupName('');
    setAutoCreateOpen(true);
  }

  async function autoCreateFromProfiles() {
    if (autoCreating) return;
    setAutoCreating(true);
    try {
      const r = await api<{
        ok: boolean;
        created: number;
        linkedExisting: number;
        skippedCount: number;
        skipped: string[];
      }>('/api/accounts/auto-create-from-profiles', {
        method: 'POST',
        body: {
          campaignId: autoCreateCampaignId || null,
          groupName: autoCreateGroupName.trim() || null,
        },
      });
      const lines = [
        `${r.created} conta(s) IG criada(s)`,
        `${r.linkedExisting} conta(s) ja existentes vinculadas a perfis`,
      ];
      if (r.skippedCount > 0) {
        lines.push(`${r.skippedCount} pulada(s):`);
        lines.push(...r.skipped);
      }
      alert(lines.join('\n'));
      setAutoCreateOpen(false);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro ao criar contas');
    } finally {
      setAutoCreating(false);
    }
  }

  async function autoLinkProfiles() {
    if (autoLinking) return;
    setAutoLinking(true);
    try {
      const r = await api<{
        ok: boolean;
        linked: number;
        ambiguousCount: number;
        noMatchCount: number;
        ambiguous: string[];
        noMatch: string[];
      }>('/api/accounts/auto-link', { method: 'POST' });
      const lines = [
        `${r.linked} conta(s) vinculada(s) automaticamente`,
      ];
      if (r.ambiguousCount > 0) {
        lines.push(`\n${r.ambiguousCount} ambigua(s) (perfis com mesmo nome):`);
        lines.push(...r.ambiguous);
      }
      if (r.noMatchCount > 0) {
        lines.push(`\n${r.noMatchCount} sem perfil correspondente:`);
        lines.push(...r.noMatch);
      }
      alert(lines.join('\n'));
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro ao vincular');
    } finally {
      setAutoLinking(false);
    }
  }

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

      {autoCreateOpen && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4" /> Criar contas dos perfis AdsPower
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Pra cada perfil AdsPower SEM conta IG vinculada, cria 1 conta IG nova com username =
              nome do perfil. Defina (opcional) campanha e grupo padrao pras novas contas.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Campanha padrao (opcional)</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={autoCreateCampaignId}
                  onChange={(e) => setAutoCreateCampaignId(e.target.value)}
                  disabled={autoCreating}
                >
                  <option value="">— sem campanha —</option>
                  {campaigns
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Grupo padrao (opcional)</Label>
                <Input
                  placeholder="ex: GARI, MANU"
                  value={autoCreateGroupName}
                  onChange={(e) => setAutoCreateGroupName(e.target.value)}
                  disabled={autoCreating}
                />
              </div>
              <div className="md:col-span-2 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAutoCreateOpen(false)}
                  disabled={autoCreating}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  onClick={autoCreateFromProfiles}
                  disabled={autoCreating}
                >
                  {autoCreating ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Criando...</>
                  ) : (
                    <><Plus className="h-4 w-4 mr-2" /> Criar contas</>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
              <select
                className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                value={filterCountry}
                onChange={(e) => {
                  setFilterCountry(e.target.value);
                  setSelected(new Set());
                }}
              >
                <option value="">Todos os paises</option>
                {Array.from(
                  new Set(
                    items
                      .map((i) => i.adsPowerProfile?.country)
                      .filter(Boolean) as string[]
                  )
                )
                  .sort()
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={openAutoCreate}
                disabled={autoCreating}
                title="Pra cada perfil AdsPower SEM conta IG, cria uma nova conta com username = nome do perfil"
              >
                {autoCreating ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Criando...</>
                ) : (
                  <><Plus className="h-4 w-4 mr-2" /> Criar contas dos perfis</>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={autoLinkProfiles}
                disabled={autoLinking}
                title="Vincula automaticamente cada conta IG sem perfil ao perfil AdsPower com mesmo nome"
              >
                {autoLinking ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Vinculando...</>
                ) : (
                  <><Link2 className="h-4 w-4 mr-2" /> Vincular automaticamente</>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={syncFollowers}
                disabled={syncingFollowers}
                title="Le followers de cada conta abrindo o perfil sequencialmente. Lento."
              >
                {syncingFollowers ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sincronizando...</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-2" /> Sincronizar seguidores</>
                )}
              </Button>
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
                <TableHead>Seguidores</TableHead>
                <TableHead>Progresso hoje</TableHead>
                <TableHead>Ciclo</TableHead>
                <TableHead>Falhas</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items
                .filter(
                  (a) =>
                    (!filterGroup || a.groupName === filterGroup) &&
                    (!filterCountry || a.adsPowerProfile?.country === filterCountry)
                )
                .map((a) => (
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
                    {a.followersCount !== null && a.followersCount !== undefined ? (
                      <span
                        className="text-sm"
                        title={a.followersUpdatedAt ? `atualizado em ${new Date(a.followersUpdatedAt).toLocaleString('pt-BR')}` : ''}
                      >
                        {formatFollowers(a.followersCount)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
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

// FIX 21: formata contador de seguidores em forma curta (ex: 1.2K, 3.5M).
function formatFollowers(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  if (n < 10_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  return Math.round(n / 1_000_000) + 'M';
}
