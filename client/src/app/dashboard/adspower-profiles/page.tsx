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
import { Trash2, Plus } from 'lucide-react';

export default function AdsPowerProfilesPage() {
  const [items, setItems] = useState<AdsPowerProfile[]>([]);
  const [form, setForm] = useState({ adsPowerId: '', name: '', notes: '' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setItems(await api<AdsPowerProfile[]>('/api/adspower-profiles'));
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
          <CardTitle>Existentes</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>AdsPower ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Conta vinculada</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id}>
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
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
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
