'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, apiBaseUrl } from '@/lib/api';
import type { AdsPowerProfile } from '@automacao/shared';
import { CheckCircle2, XCircle, Loader2, RefreshCw, Activity } from 'lucide-react';

interface AdsPowerStatus {
  ok: boolean;
  reachable: boolean;
  baseUrl: string;
  error?: string;
  hint?: string;
  profiles?: { adsPowerId: string; name: string; group: string | null }[];
}

interface PlaywrightStatus {
  ok: boolean;
  mode: string;
  chromiumPath?: string;
  error?: string;
  hint?: string;
  note?: string;
}

interface ProfileTestResult {
  ok: boolean;
  step?: string;
  reason?: string;
  logged?: boolean;
  screenshot?: string | null;
}

export default function DiagnosticsPage() {
  const [ads, setAds] = useState<AdsPowerStatus | null>(null);
  const [pw, setPw] = useState<PlaywrightStatus | null>(null);
  const [profiles, setProfiles] = useState<AdsPowerProfile[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ProfileTestResult>>({});

  async function loadAll() {
    setAds(null);
    setPw(null);
    const [a, p, ps] = await Promise.allSettled([
      api<AdsPowerStatus>('/api/diagnostics/adspower'),
      api<PlaywrightStatus>('/api/diagnostics/playwright'),
      api<AdsPowerProfile[]>('/api/adspower-profiles'),
    ]);
    if (a.status === 'fulfilled') setAds(a.value);
    else setAds({ ok: false, reachable: false, baseUrl: '?', error: String(a.reason) });
    if (p.status === 'fulfilled') setPw(p.value);
    if (ps.status === 'fulfilled') setProfiles(ps.value);
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function testProfile(profileId: string) {
    setTesting(profileId);
    try {
      const r = await api<ProfileTestResult>(`/api/diagnostics/test-profile/${profileId}`, {
        method: 'POST',
      });
      setResults((prev) => ({ ...prev, [profileId]: r }));
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [profileId]: { ok: false, reason: err instanceof Error ? err.message : 'unknown' },
      }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Diagnóstico</h2>
          <p className="text-sm text-muted-foreground">
            Valide AdsPower, Playwright e perfis individuais antes de rodar a fila em modo real.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAll}>
          <RefreshCw className="h-4 w-4" /> Recarregar
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" /> AdsPower API
          </CardTitle>
          <CardDescription>{ads?.baseUrl}</CardDescription>
        </CardHeader>
        <CardContent>
          {!ads ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Verificando...
            </div>
          ) : ads.ok ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Conectado. {ads.profiles?.length ?? 0} perfil(is) encontrado(s) no AdsPower.
              </div>
              {ads.profiles && ads.profiles.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  IDs disponíveis: {ads.profiles.map((p) => p.adsPowerId).join(', ')}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4" />
                {ads.error}
              </div>
              {ads.hint && <p className="text-xs text-muted-foreground">{ads.hint}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Playwright</CardTitle>
          <CardDescription>Engine de automação para o modo real</CardDescription>
        </CardHeader>
        <CardContent>
          {!pw ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Verificando...
            </div>
          ) : pw.ok ? (
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                modo: <Badge variant="info">{pw.mode}</Badge>
              </div>
              {pw.note && <p className="text-xs text-muted-foreground">{pw.note}</p>}
              {pw.chromiumPath && (
                <p className="text-xs text-muted-foreground font-mono">{pw.chromiumPath}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="h-4 w-4" />
                {pw.error}
              </div>
              {pw.hint && <p className="text-xs text-muted-foreground">{pw.hint}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verificar login dos perfis</CardTitle>
          <CardDescription>
            Abre o perfil AdsPower, navega no Instagram e confirma se está logado. Não posta nada.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Perfil</TableHead>
                <TableHead>AdsPower ID</TableHead>
                <TableHead>Conta</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => {
                const r = results[p.id];
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs">{p.adsPowerId}</TableCell>
                    <TableCell>{p.account ? `@${p.account.username}` : '—'}</TableCell>
                    <TableCell>
                      {!r ? (
                        <span className="text-xs text-muted-foreground">não testado</span>
                      ) : r.ok ? (
                        <Badge variant={r.logged ? 'success' : 'warning'}>
                          {r.logged ? 'logado ✓' : 'NÃO logado'}
                        </Badge>
                      ) : (
                        <Badge variant="destructive" title={r.reason}>
                          erro: {r.step ?? ''}
                        </Badge>
                      )}
                      {r?.screenshot && (
                        <a
                          href={`${apiBaseUrl}${r.screenshot}`}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-2 text-xs text-blue-400 hover:underline"
                        >
                          screenshot
                        </a>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={testing === p.id}
                        onClick={() => testProfile(p.id)}
                      >
                        {testing === p.id ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" /> testando
                          </>
                        ) : (
                          'Testar'
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!profiles.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    Nenhum perfil cadastrado. Vá em &quot;Perfis AdsPower&quot;.
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
