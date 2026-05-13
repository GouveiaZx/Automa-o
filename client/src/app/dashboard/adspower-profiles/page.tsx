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
import type { AdsPowerProfile } from '@automacao/shared';
import { Trash2, Plus, Loader2 } from 'lucide-react';

type AdsPowerProfileWithAccount = AdsPowerProfile & {
  account?: { id: string; username: string } | null;
};

export default function AdsPowerProfilesPage() {
  const [items, setItems] = useState<AdsPowerProfileWithAccount[]>([]);
  const [form, setForm] = useState({ adsPowerId: '', name: '', notes: '' });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  async function load() {
    setItems(await api<AdsPowerProfileWithAccount[]>('/api/adspower-profiles'));
  }

  useEffect(() => {
    load();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/adspower-profiles', {
        method: 'POST',
        body: { ...form, notes: form.notes || null },
      });
      setForm({ adsPowerId: '', name: '', notes: '' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  }

  async function remove(id: string) {
    if (!confirm('Excluir perfil?')) return;
    await api(`/api/adspower-profiles/${id}`, { method: 'DELETE' });
    load();
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((p) => p.id)));
  }

  async function bulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const linked = items.filter((p) => ids.includes(p.id) && p.account).length;
    const warnLinked = linked > 0
      ? `\n\nATENCAO: ${linked} perfil(is) tem conta Instagram vinculada. As contas IG NAO sao deletadas — so ficam SEM perfil (precisa vincular a outro depois ou deletar a conta tambem).`
      : '';
    if (!confirm(`EXCLUIR ${ids.length} perfil(is) AdsPower do painel?${warnLinked}\n\nAcao IRREVERSIVEL.`)) return;
    setBulkDeleting(true);
    try {
      const r = await api<{ ok: boolean; deleted: number }>('/api/adspower-profiles/bulk-delete', {
        method: 'POST',
        body: { ids },
      });
      alert(`${r.deleted} perfil(is) excluido(s).`);
      setSelected(new Set());
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'erro ao excluir');
    } finally {
      setBulkDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Perfis AdsPower</h2>
        <p className="text-sm text-muted-foreground">
          Cada perfil representa um navegador AdsPower já configurado/logado pelo operador.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Novo perfil
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>AdsPower user_id</Label>
              <Input
                value={form.adsPowerId}
                onChange={(e) => setForm({ ...form, adsPowerId: e.target.value })}
                placeholder="ex: ks7d8h2"
                required
              />
            </div>
            <div className="space-y-1">
              <Label>Nome de referência</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="ex: Perfil 01"
                required
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Notas</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
              />
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
          <CardTitle className="flex items-center justify-between">
            <span>Existentes</span>
            {selected.size > 0 && (
              <Button
                size="sm"
                variant="destructive"
                onClick={bulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Excluindo...</>
                ) : (
                  <><Trash2 className="h-4 w-4 mr-2" /> Excluir {selected.size} selecionado{selected.size > 1 ? 's' : ''}</>
                )}
              </Button>
            )}
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
                    aria-label="Selecionar todos"
                  />
                </TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>AdsPower ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Conta vinculada</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id} data-state={selected.has(p.id) ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      aria-label={`Selecionar ${p.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="font-mono text-xs">{p.adsPowerId}</TableCell>
                  <TableCell>
                    <Badge variant={p.status === 'idle' ? 'secondary' : p.status === 'running' ? 'info' : 'destructive'}>
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{p.account ? `@${p.account.username}` : '—'}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => remove(p.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!items.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    Nenhum perfil cadastrado.
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
