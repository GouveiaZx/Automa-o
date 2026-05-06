'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, apiBaseUrl } from '@/lib/api';
import type { Campaign, InstagramAccount, MediaItem } from '@automacao/shared';
import { formatDateTime } from '@/lib/utils';
import { Trash2, Upload } from 'lucide-react';

const MAX_FILES_PER_BATCH = 10;

export default function MediaPage() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [filterCampaignId, setFilterCampaignId] = useState<string>('');
  const [filterTag, setFilterTag] = useState<string>('');
  const [caption, setCaption] = useState('');
  const [tag, setTag] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [m, c, a] = await Promise.all([
      api<MediaItem[]>('/api/media'),
      api<Campaign[]>('/api/campaigns'),
      api<InstagramAccount[]>('/api/accounts'),
    ]);
    setItems(m);
    setCampaigns(c);
    setAccounts(a);
  }

  useEffect(() => {
    load();
  }, []);

  // Deriva campanhas unicas a partir das contas selecionadas (deduplica
  // se 2 contas usam mesma campanha — sobe so 1 vez nessa campanha).
  function uniqueCampaignIdsFromSelection(): string[] {
    const set = new Set<string>();
    for (const accId of selectedAccounts) {
      const acc = accounts.find((a) => a.id === accId);
      if (acc?.campaignId) set.add(acc.campaignId);
    }
    return Array.from(set);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const campaignIds = uniqueCampaignIdsFromSelection();
    if (files.length === 0 || campaignIds.length === 0) return;
    if (files.length > MAX_FILES_PER_BATCH) {
      setError(`Maximo ${MAX_FILES_PER_BATCH} arquivos por vez (voce selecionou ${files.length})`);
      return;
    }
    setBusy(true);
    setError(null);
    const total = files.length * campaignIds.length;
    setProgress({ done: 0, total });

    const failures: { name: string; err: string }[] = [];
    let done = 0;
    for (const file of files) {
      for (const campaignId of campaignIds) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('type', 'reel'); // Story removido do UI; sistema posta tudo no feed
          fd.append('campaignId', campaignId);
          if (caption) fd.append('caption', caption);
          if (tag) fd.append('tag', tag);
          await api('/api/media', { method: 'POST', formData: fd });
        } catch (err) {
          failures.push({
            name: `${file.name} → campanha ${campaignId.slice(0, 6)}`,
            err: err instanceof Error ? err.message : 'erro',
          });
        }
        done++;
        setProgress({ done, total });
      }
    }

    if (failures.length > 0) {
      setError(
        `${total - failures.length} de ${total} enviados. Falhas:\n` +
          failures.map((f) => `  - ${f.name}: ${f.err}`).join('\n')
      );
    } else {
      setFiles([]);
      setCaption('');
      setTag('');
      setSelectedAccounts(new Set());
    }
    setBusy(false);
    setProgress(null);
    load();
  }

  async function remove(id: string) {
    if (!confirm('Excluir mídia?')) return;
    await api(`/api/media/${id}`, { method: 'DELETE' });
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    load();
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  function toggleAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((m) => m.id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Excluir ${selected.size} mídia${selected.size > 1 ? 's' : ''} selecionada${selected.size > 1 ? 's' : ''}?`)) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    let okCount = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await api(`/api/media/${id}`, { method: 'DELETE' });
        okCount++;
      } catch (err) {
        failures.push(`${id}: ${err instanceof Error ? err.message : 'erro'}`);
      }
    }
    setSelected(new Set());
    setBulkBusy(false);
    if (failures.length > 0) {
      alert(`${okCount} de ${ids.length} excluídas. Falhas:\n${failures.join('\n')}`);
    }
    load();
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Mídia</h2>
        <p className="text-sm text-muted-foreground">
          Upload de Stories e Reels (mp4/mov/jpg/png, máx 200MB).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" /> Upload
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid grid-cols-1 gap-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>
                  Contas (selecione 1 ou mais — sobe a midia em todas)
                </Label>
                {accounts.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      if (selectedAccounts.size === accounts.length) {
                        setSelectedAccounts(new Set());
                      } else {
                        setSelectedAccounts(new Set(accounts.map((a) => a.id)));
                      }
                    }}
                  >
                    {selectedAccounts.size === accounts.length ? 'Desmarcar todas' : 'Marcar todas'}
                  </button>
                )}
              </div>
              <div className="border border-input rounded-md p-2 max-h-48 overflow-y-auto space-y-1">
                {accounts.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">
                    Nenhuma conta cadastrada. Cadastre em &quot;Contas Instagram&quot; primeiro.
                  </p>
                )}
                {accounts.map((a) => {
                  const camp = campaigns.find((c) => c.id === a.campaignId);
                  const noCamp = !a.campaignId;
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-accent cursor-pointer ${noCamp ? 'opacity-50' : ''}`}
                      title={noCamp ? 'Conta sem campanha — vincule uma campanha primeiro' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={selectedAccounts.has(a.id)}
                        disabled={noCamp}
                        onChange={() => {
                          setSelectedAccounts((s) => {
                            const n = new Set(s);
                            if (n.has(a.id)) n.delete(a.id);
                            else n.add(a.id);
                            return n;
                          });
                        }}
                      />
                      <span className="font-medium">@{a.username}</span>
                      <span className="text-muted-foreground">
                        — {noCamp ? 'sem campanha' : camp?.name ?? 'campanha desconhecida'}
                      </span>
                    </label>
                  );
                })}
              </div>
              {selectedAccounts.size > 0 && files.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {files.length} arquivo{files.length > 1 ? 's' : ''} × {uniqueCampaignIdsFromSelection().length} campanha{uniqueCampaignIdsFromSelection().length > 1 ? 's' : ''} = <strong>{files.length * uniqueCampaignIdsFromSelection().length} mídia{files.length * uniqueCampaignIdsFromSelection().length > 1 ? 's' : ''}</strong> serão criadas
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Caption (mesma para todas as midias)</Label>
              <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1">
              <Label>Tag (opcional, pra organizar)</Label>
              <Input
                placeholder="Ex: Vazadas, Modelo X, Promo Junho"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                maxLength={80}
              />
              <p className="text-xs text-muted-foreground">
                Mesma tag eh aplicada em todas as midias do lote. Filtra no Acervo abaixo.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Arquivos (selecione ate {MAX_FILES_PER_BATCH} videos de uma vez)</Label>
              <Input
                type="file"
                accept=".mp4,.mov,.webm,.m4v"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                required
              />
              {files.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {files.length} arquivo{files.length > 1 ? 's' : ''} selecionado{files.length > 1 ? 's' : ''}
                </p>
              )}
            </div>
            {progress && (
              <p className="text-sm text-muted-foreground">
                Enviando {progress.done} de {progress.total}...
              </p>
            )}
            {error && <p className="text-destructive text-sm whitespace-pre-line">{error}</p>}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={busy || files.length === 0 || selectedAccounts.size === 0}
              >
                {busy
                  ? 'Enviando...'
                  : files.length > 0 && selectedAccounts.size > 0
                    ? `Enviar (${files.length * uniqueCampaignIdsFromSelection().length} mídias)`
                    : 'Enviar'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 flex-wrap">
            <span>Acervo</span>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                value={filterCampaignId}
                onChange={(e) => {
                  setFilterCampaignId(e.target.value);
                  setSelected(new Set()); // limpa selecao ao filtrar
                }}
              >
                <option value="">Todas as campanhas</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                value={filterTag}
                onChange={(e) => {
                  setFilterTag(e.target.value);
                  setSelected(new Set());
                }}
              >
                <option value="">Todas as tags</option>
                {Array.from(new Set(items.map((i) => i.tag).filter(Boolean) as string[]))
                  .sort()
                  .map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
              </select>
              {selected.size > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={bulkDelete}
                  disabled={bulkBusy}
                >
                  {bulkBusy ? 'Excluindo...' : `Excluir ${selected.size} selecionada${selected.size > 1 ? 's' : ''}`}
                </Button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            const filteredItems = items.filter((m) => {
              if (filterCampaignId && m.campaignId !== filterCampaignId) return false;
              if (filterTag && m.tag !== filterTag) return false;
              return true;
            });
            return (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={filteredItems.length > 0 && filteredItems.every((m) => selected.has(m.id))}
                    ref={(el) => {
                      if (el) {
                        const allSelected = filteredItems.length > 0 && filteredItems.every((m) => selected.has(m.id));
                        const someSelected = filteredItems.some((m) => selected.has(m.id));
                        el.indeterminate = !allSelected && someSelected;
                      }
                    }}
                    onChange={() => {
                      const allSelected = filteredItems.length > 0 && filteredItems.every((m) => selected.has(m.id));
                      if (allSelected) {
                        setSelected((s) => {
                          const n = new Set(s);
                          filteredItems.forEach((m) => n.delete(m.id));
                          return n;
                        });
                      } else {
                        setSelected((s) => {
                          const n = new Set(s);
                          filteredItems.forEach((m) => n.add(m.id));
                          return n;
                        });
                      }
                    }}
                    aria-label="Selecionar todas"
                  />
                </TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Arquivo</TableHead>
                <TableHead>Tag</TableHead>
                <TableHead>Caption</TableHead>
                <TableHead>Usos</TableHead>
                <TableHead>Publicado</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((m) => (
                <TableRow key={m.id} data-state={selected.has(m.id) ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => toggleOne(m.id)}
                      aria-label={`Selecionar ${m.filePath}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.type === 'reel' ? 'default' : 'secondary'}>{m.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <a
                      className="text-primary underline-offset-2 hover:underline text-xs"
                      href={`${apiBaseUrl}/media-files/${m.filePath}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {m.filePath}
                    </a>
                  </TableCell>
                  <TableCell>
                    {m.tag ? <Badge variant="secondary">{m.tag}</Badge> : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell className="max-w-xs truncate">
                    <div>{m.caption ?? '—'}</div>
                  </TableCell>
                  <TableCell>{m.usedCount}</TableCell>
                  <TableCell>{formatDateTime(m.publishedAt)}</TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" onClick={() => remove(m.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!filteredItems.length && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    {items.length === 0
                      ? 'Nenhuma mídia cadastrada.'
                      : 'Nenhuma mídia bate com os filtros. Tire pra ver outras.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}
