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
  const [maxConcurrent, setMaxConcurrent] = useState('');
  const [activeAccountsCount, setActiveAccountsCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function load() {
    const r = await api<SettingsResponse>('/api/settings');
    setData(r);
    const cur = r.stored.find((s) => s.key === 'MAX_ACTIVE_ACCOUNTS');
    if (cur) setMaxActive(cur.value);
    else setMaxActive('');
    const concurrent = r.stored.find((s) => s.key === 'MAX_CONCURRENT_PROFILES');
    if (concurrent) setMaxConcurrent(concurrent.value);
    else setMaxConcurrent(String(r.runtime.MAX_CONCURRENT_PROFILES));
    // FIX 26: conta contas active pra detectar cap < total e mostrar warning
    try {
      const accounts = await api<{ status: string }[]>('/api/accounts');
      setActiveAccountsCount(accounts.filter((a) => a.status === 'active').length);
    } catch {
      /* ignore */
    }
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

  async function resetMaxActive() {
    if (!confirm('Apagar limite? Todas as contas ativas voltam a ser elegiveis.')) return;
    setSaving(true);
    try {
      await api('/api/settings/MAX_ACTIVE_ACCOUNTS', { method: 'DELETE' });
      setSavedAt(Date.now());
      load();
    } finally {
      setSaving(false);
    }
  }

  async function saveMaxConcurrent() {
    setSaving(true);
    try {
      await api('/api/settings/MAX_CONCURRENT_PROFILES', {
        method: 'PUT',
        body: { value: maxConcurrent },
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
          <CardTitle>Performance</CardTitle>
          <CardDescription>
            Quantos perfis AdsPower o worker abre em paralelo. Mais = mais velocidade,
            mas consome mais RAM (~300-500MB cada perfil aberto). Aumente se seu PC aguenta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>MAX_CONCURRENT_PROFILES</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                max={50}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)}
                className="max-w-32"
              />
              <Button onClick={saveMaxConcurrent} disabled={saving}>
                {saving ? 'Salvando...' : 'Salvar'}
              </Button>
              {savedAt && Date.now() - savedAt < 3000 && (
                <span className="self-center text-xs text-emerald-500">salvo ✓</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Worker reflete a mudança no próximo ciclo (~5s). Valor salvo no banco
              tem precedência sobre o .env.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limite de contas elegíveis (avançado)</CardTitle>
          <CardDescription>
            <strong className="text-amber-500">⚠️ Este NÃO é o limite de paralelismo</strong>{' '}
            (esse é o card &quot;Performance&quot; acima). Aqui você limita QUAIS contas o worker
            sequer considera (top N por ordem alfabética). As demais ficam IGNORADAS na fila.
            Deixe vazio = todas as contas ativas rodam.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>MAX_ACTIVE_ACCOUNTS</Label>
            <div className="flex gap-2 flex-wrap">
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
              <Button
                variant="outline"
                onClick={resetMaxActive}
                disabled={saving || !maxActive}
              >
                Resetar (rodar todas)
              </Button>
              {savedAt && Date.now() - savedAt < 3000 && (
                <span className="self-center text-xs text-emerald-500">salvo ✓</span>
              )}
            </div>
            {(() => {
              const capNum = parseInt(maxActive, 10);
              if (
                Number.isFinite(capNum) &&
                capNum > 0 &&
                activeAccountsCount > capNum
              ) {
                return (
                  <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                    ⚠️ Cap = {capNum} mas você tem {activeAccountsCount} contas ativas.{' '}
                    <strong>{activeAccountsCount - capNum} contas estão sendo IGNORADAS</strong>{' '}
                    pelo worker. Aumente o valor ou clique em &quot;Resetar&quot; pra rodar todas.
                  </div>
                );
              }
              return null;
            })()}
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
