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
import type { Campaign } from '@automacao/shared';
import { Trash2, Plus } from 'lucide-react';

const empty = {
  name: '',
  description: '',
  windowStart: '08:00',
  windowEnd: '22:00',
  minIntervalMin: 90,
  maxIntervalMin: 240,
  storiesPerDay: 3,
  reelsPerDay: 1,
  active: true,
};

export default function CampaignsPage() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setItems(await api<Campaign[]>('/api/campaigns'));
  }

  useEffect(() => {
    load();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/campaigns', {
        method: 'POST',
        body: {
          ...form,
          description: form.description || null,
        },
      });
      setForm(empty);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Excluir esta campanha?')) return;
    await api(`/api/campaigns/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Campanhas</h2>
        <p className="text-sm text-muted-foreground">
          Modelos com janela, cadência e quantidade de stories/reels por dia.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Nova campanha
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Descrição</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
              />
            </div>
            <Grid>
              <Field label="Janela início (HH:MM)">
                <Input
                  value={form.windowStart}
                  onChange={(e) => setForm({ ...form, windowStart: e.target.value })}
                />
              </Field>
              <Field label="Janela fim (HH:MM)">
                <Input
                  value={form.windowEnd}
                  onChange={(e) => setForm({ ...form, windowEnd: e.target.value })}
                />
              </Field>
            </Grid>
            <Grid>
              <Field label="Intervalo mín (min)">
                <Input
                  type="number"
                  value={form.minIntervalMin}
                  onChange={(e) => setForm({ ...form, minIntervalMin: Number(e.target.value) })}
                />
              </Field>
              <Field label="Intervalo máx (min)">
                <Input
                  type="number"
                  value={form.maxIntervalMin}
                  onChange={(e) => setForm({ ...form, maxIntervalMin: Number(e.target.value) })}
                />
              </Field>
            </Grid>
            <Grid>
              <Field label="Stories/dia">
                <Input
                  type="number"
                  value={form.storiesPerDay}
                  onChange={(e) => setForm({ ...form, storiesPerDay: Number(e.target.value) })}
                />
              </Field>
              <Field label="Reels/dia">
                <Input
                  type="number"
                  value={form.reelsPerDay}
                  onChange={(e) => setForm({ ...form, reelsPerDay: Number(e.target.value) })}
                />
              </Field>
            </Grid>
            {error && <p className="text-destructive text-sm md:col-span-2">{error}</p>}
            <div className="md:col-span-2 flex justify-end">
              <Button type="submit" disabled={busy}>
                {busy ? 'Salvando...' : 'Criar'}
              </Button>
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
                <TableHead>Janela</TableHead>
                <TableHead>Intervalo</TableHead>
                <TableHead>Stories/Reels</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    {c.windowStart} – {c.windowEnd}
                  </TableCell>
                  <TableCell>
                    {c.minIntervalMin}–{c.maxIntervalMin} min
                  </TableCell>
                  <TableCell>
                    {c.storiesPerDay} / {c.reelsPerDay}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.active ? 'success' : 'secondary'}>
                      {c.active ? 'ativa' : 'pausada'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => remove(c.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!items.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    Nenhuma campanha ainda.
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

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 md:col-span-2 md:grid-cols-2">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
