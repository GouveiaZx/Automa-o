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
import { Trash2, Plus, Play, Pause, RefreshCw, Loader2 } from 'lucide-react';
import { connectSse } from '@/lib/sse';

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
  const [form, setForm] = useState({ username: '', displayName: '', bio: '', websiteUrl: '', campaignId: '', adsPowerProfileId: '' });
  const [error, setError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  async function load() {
    const [a, c, p] = await Promise.all([
      api<InstagramAccount[]>('/api/accounts'),
      api<Campaign[]>('/api/campaigns'),
      api<AdsPowerProfile[]>('/api/adspower-profiles'),
    ]);
    setItems(a);
    setCampaigns(c);
    setProfiles(p);
  }

  useEffect(() => {
    load();
    const off = connectSse((event) => {
      if (event.type === 'account-update') load();
    });
    return () => off();
  }, []);

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
          websiteUrl: form.websiteUrl || null,
          campaignId: form.campaignId || null,
          adsPowerProfileId: form.adsPowerProfileId || null,
        },
      });
      setForm({ username: '', displayName: '', bio: '', websiteUrl: '', campaignId: '', adsPowerProfileId: '' });
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
              <Label>Site (link clicável da bio)</Label>
              <Input
                type="url"
                value={form.websiteUrl}
                onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })}
                placeholder="https://link.bioexclusiva.com/b/secretinha"
              />
              <p className="text-xs text-muted-foreground">
                Aparece como link clicável no perfil IG (campo &quot;Site&quot;).
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
          <CardTitle>Existentes</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Conta</TableHead>
                <TableHead>Campanha</TableHead>
                <TableHead>Perfil AdsPower</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Falhas</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
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
                    {a.websiteUrl && (
                      <div className="text-xs text-blue-400 max-w-xs truncate">
                        🔗 {a.websiteUrl}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{a.campaign?.name ?? '—'}</TableCell>
                  <TableCell>{a.adsPowerProfile?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[a.status] ?? 'secondary'}>{a.status}</Badge>
                  </TableCell>
                  <TableCell>{a.consecutiveFails}</TableCell>
                  <TableCell className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Sincronizar bio + site no IG"
                      disabled={syncingId === a.id || (!a.bio && !a.websiteUrl) || !a.adsPowerProfileId}
                      onClick={() => syncBio(a.id, a.username)}
                    >
                      {syncingId === a.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
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
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
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
