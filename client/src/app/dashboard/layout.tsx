'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { clearToken, getToken } from '@/lib/api';
import { connectSse } from '@/lib/sse';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Megaphone,
  Chrome,
  Instagram,
  Film,
  ListTodo,
  ScrollText,
  Settings,
  Stethoscope,
  LogOut,
} from 'lucide-react';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/campaigns', label: 'Campanhas', icon: Megaphone },
  { href: '/dashboard/adspower-profiles', label: 'Perfis AdsPower', icon: Chrome },
  { href: '/dashboard/accounts', label: 'Contas Instagram', icon: Instagram },
  { href: '/dashboard/media', label: 'Mídia', icon: Film },
  { href: '/dashboard/jobs', label: 'Fila de jobs', icon: ListTodo },
  { href: '/dashboard/logs', label: 'Logs', icon: ScrollText },
  { href: '/dashboard/diagnostics', label: 'Diagnóstico', icon: Stethoscope },
  { href: '/dashboard/settings', label: 'Configurações', icon: Settings },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setReady(true);
    const off = connectSse((event) => {
      if (event.type === 'alert') {
        setAlertMsg(event.payload.message);
        if (event.payload.sound) playAlert();
        setTimeout(() => setAlertMsg(null), 8000);
      }
    });
    return () => off();
  }, [router]);

  function logout() {
    clearToken();
    router.replace('/login');
  }

  if (!ready) return null;

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 border-r bg-card hidden md:flex flex-col">
        <div className="px-4 py-5 border-b">
          <h1 className="font-semibold text-sm">Instagram Automation</h1>
          <p className="text-xs text-muted-foreground">Painel admin</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent text-muted-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}>
            <LogOut className="h-4 w-4" />
            Sair
          </Button>
        </div>
      </aside>
      <main className="flex-1 flex flex-col">
        {alertMsg && (
          <div className="bg-amber-500/20 border-b border-amber-500/40 text-amber-100 px-4 py-2 text-sm flex items-center gap-2">
            ⚠ {alertMsg}
          </div>
        )}
        <div className="flex-1 p-6 overflow-auto">{children}</div>
      </main>
    </div>
  );
}

function playAlert() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const beep = (freq: number, dur: number, when: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + dur);
      o.start(ctx.currentTime + when);
      o.stop(ctx.currentTime + when + dur);
    };
    beep(880, 0.18, 0);
    beep(660, 0.18, 0.22);
    beep(880, 0.18, 0.44);
  } catch {
    /* sem audio */
  }
}
