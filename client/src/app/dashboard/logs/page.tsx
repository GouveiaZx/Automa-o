'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { AutomationLog } from '@automacao/shared';
import { connectSse } from '@/lib/sse';
import { formatDateTime } from '@/lib/utils';

const LEVEL_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  info: 'secondary',
  warn: 'warning',
  error: 'destructive',
};

export default function LogsPage() {
  const [logs, setLogs] = useState<AutomationLog[]>([]);

  async function load() {
    setLogs(await api<AutomationLog[]>('/api/logs?limit=300'));
  }

  useEffect(() => {
    load();
    const off = connectSse((event) => {
      if (event.type === 'log') {
        setLogs((prev) => [event.payload, ...prev].slice(0, 300));
      }
    });
    return () => off();
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">Logs</h2>
        <p className="text-sm text-muted-foreground">Stream em tempo real (worker, driver, api).</p>
      </header>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Quando</TableHead>
                <TableHead className="w-20">Level</TableHead>
                <TableHead className="w-24">Source</TableHead>
                <TableHead>Mensagem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(l.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={LEVEL_VARIANT[l.level] ?? 'secondary'}>{l.level}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{l.source}</TableCell>
                  <TableCell className="font-mono text-xs">{l.message}</TableCell>
                </TableRow>
              ))}
              {!logs.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                    Nenhum log ainda.
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
