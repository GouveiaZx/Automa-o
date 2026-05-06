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
import type { Campaign, MediaItem } from '@automacao/shared';
import { formatDateTime } from '@/lib/utils';
import { Trash2, Upload } from 'lucide-react';

const MAX_FILES_PER_BATCH = 10;

export default function MediaPage() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [caption, setCaption] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [m, c] = await Promise.all([
      api<MediaItem[]>('/api/media'),
      api<Campaign[]>('/api/campaigns'),
    ]);
    setItems(m);
    setCampaigns(c);
    if (!campaignId && c.length > 0) setCampaignId(c[0].id);
  }

  useEffect(() => {
    load();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0 || !campaignId) return;
    if (files.length > MAX_FILES_PER_BATCH) {
      setError(`Maximo ${MAX_FILES_PER_BATCH} arquivos por vez (voce selecionou ${files.length})`);
      return;
    }
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: files.length });

    const failures: { name: string; err: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('type', 'reel'); // Story removido do UI; sistema posta tudo no feed
        fd.append('campaignId', campaignId);
        if (caption) fd.append('caption', caption);
        await api('/api/media', { method: 'POST', formData: fd });
      } catch (err) {
        failures.push({ name: file.name, err: err instanceof Error ? err.message : 'erro' });
      }
      setProgress({ done: i + 1, total: files.length });
    }

    if (failures.length > 0) {
      setError(
        `${files.length - failures.length} de ${files.length} enviados. Falhas:\n` +
          failures.map((f) => `  - ${f.name}: ${f.err}`).join('\n')
      );
    } else {
      setFiles([]);
      setCaption('');
    }
    setBusy(false);
    setProgress(null);
    load();
  }

  async function remove(id: string) {
    if (!confirm('Excluir mídia?')) return;
    await api(`/api/media/${id}`, { method: 'DELETE' });
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
              <Label>Campanha</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                required
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Caption (mesma para todas as midias selecionadas)</Label>
              <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} />
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
              <Button type="submit" disabled={busy || files.length === 0}>
                {busy ? 'Enviando...' : `Enviar ${files.length > 0 ? `(${files.length})` : ''}`}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Acervo</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Arquivo</TableHead>
                <TableHead>Caption</TableHead>
                <TableHead>Usos</TableHead>
                <TableHead>Publicado</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((m) => (
                <TableRow key={m.id}>
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
              {!items.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    Nenhuma mídia cadastrada.
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
