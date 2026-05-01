'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';

interface SettingsResponse {
  runtime: {
    AUTOMATION_MODE: string;
    MAX_CONCURRENT_PROFILES: number;
    MAX_JOB_ATTEMPTS: number;
    WORKER_POLL_INTERVAL_MS: number;
  };
  stored: { key: string; value: string }[];
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [maxActive, setMaxActive] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function load() {
    const r = await api<SettingsResponse>('/api/settings');
    setData(r);
    const cur = r.stored.find((s) => s.key === 'MAX_ACTIVE_ACCOUNTS');
    if (cur) setMaxActive(cur.value);
  }

  useEffect(() => {
    load();
  }, []);

  async function saveMaxActive() {
    setSaving(true);
    try {
      await api('/api/settings/MAX_ACTIVE_ACCOUNTS', {
        method: 'PUT',
        body: { value: maxActive },
      });
      setSavedAt(Date.now());
      load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Configurações</h2>
        <p className="text-sm text-muted-foreground">
          Limites operacionais. Validação progressiva conforme spec (1 → 3 → 7 → 10 → 20).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Validação progressiva</CardTitle>
          <CardDescription>
            Limita quantas contas o worker processa simultaneamente. Use para subir cliente em
            produção: comece com 1, valide, suba para 3, depois 7, 10, 20.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>MAX_ACTIVE_ACCOUNTS</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={0}
                max={100}
                value={maxActive}
                onChange={(e) => setMaxActive(e.target.value)}
                className="max-w-32"
              />
              <Button onClick={saveMaxActive} disabled={saving}>
                {saving ? 'Salvando...' : 'Salvar'}
              </Button>
              {savedAt && Date.now() - savedAt < 3000 && (
                <span className="self-center text-xs text-emerald-500">salvo ✓</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              0 ou vazio = sem limite. Worker reflete a mudança no próximo ciclo (~5s).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runtime</CardTitle>
          <CardDescription>
            Variáveis em uso pelo backend. Para alterar, edite o <code>.env</code> do server e
            reinicie.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variável</TableHead>
                <TableHead>Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data &&
                Object.entries(data.runtime).map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className="font-mono text-xs">{k}</TableCell>
                    <TableCell>
                      {k === 'AUTOMATION_MODE' ? (
                        <Badge variant={v === 'real' ? 'destructive' : 'info'}>{String(v)}</Badge>
                      ) : (
                        String(v)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Armazenadas (DB)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chave</TableHead>
                <TableHead>Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.stored.map((s) => (
                <TableRow key={s.key}>
                  <TableCell className="font-mono text-xs">{s.key}</TableCell>
                  <TableCell>{s.value}</TableCell>
                </TableRow>
              ))}
              {!data?.stored.length && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-muted-foreground py-6">
                    Nada armazenado.
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
