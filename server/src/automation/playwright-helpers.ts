import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Locator } from 'playwright';

export const DEBUG_DIR = join(process.cwd(), 'media', 'debug');

const DEBUG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // no maximo 1x/hora

export async function cleanupOldDebug(retentionMs = DEBUG_RETENTION_MS): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(DEBUG_DIR);
    const cutoff = Date.now() - retentionMs;
    for (const name of entries) {
      const full = join(DEBUG_DIR, name);
      try {
        const st = await stat(full);
        if (st.isFile() && st.mtimeMs < cutoff) {
          await unlink(full);
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* pasta pode nao existir, ok */
  }
  return removed;
}

export async function humanDelay(min = 300, max = 1200): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Tenta uma lista de selectors em ordem. Retorna o primeiro que existe e está visível.
 * Selectors em ordem de robustez sugerida:
 *   1. Acessibilidade: `[aria-label="..."]`, `[role=button][name="..."]`
 *   2. Texto: `text="..."` (Playwright trata exato vs parcial)
 *   3. CSS específico (último recurso)
 */
export async function findAny(
  page: Page,
  selectors: string[],
  timeoutMs = 8000
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
          return loc;
        }
      } catch {
        /* tenta o próximo */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function clickAny(
  page: Page,
  selectors: string[],
  timeoutMs = 8000
): Promise<boolean> {
  // Primeiro tenta com isVisible check (caminho normal)
  const loc = await findAny(page, selectors, Math.min(timeoutMs, 4000));
  if (loc) {
    await humanDelay(200, 500);
    try {
      await loc.click({ timeout: 5000 });
      return true;
    } catch {
      // tenta force click no mesmo
      try {
        await loc.click({ timeout: 3000, force: true });
        return true;
      } catch {
        /* cai pro force-click direto */
      }
    }
  }
  // Fallback: tenta force-click direto sem checar visibility
  // Importante para SVGs e elementos obscured pelo Playwright auto-wait
  for (const sel of selectors) {
    try {
      const target = page.locator(sel).first();
      if ((await target.count()) === 0) continue;
      await humanDelay(150, 300);
      await target.click({ timeout: 2000, force: true });
      return true;
    } catch {
      /* tenta o próximo */
    }
  }
  return false;
}

export async function captureDebug(
  page: Page,
  tag: string
): Promise<{ screenshot: string | null; html: string | null; diag: string | null }> {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    // Cleanup oportunista: 1x por hora, apaga screenshots > 7 dias
    if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      void cleanupOldDebug();
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTag = tag.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    const pngName = `${safeTag}-${ts}.png`;
    const htmlName = `${safeTag}-${ts}.html`;
    const diagName = `${safeTag}-${ts}.diag.txt`;
    const pngPath = join(DEBUG_DIR, pngName);
    const htmlPath = join(DEBUG_DIR, htmlName);
    const diagPath = join(DEBUG_DIR, diagName);

    // Captura cada artefato de forma independente. Importante: NAO engolir
    // erros silenciosamente (bug anterior — captureDebug retornava paths que
    // nao existiam em disco quando a page ja tinha fechado, deixando o
    // usuario sem evidencia pra diagnosticar share_unconfirmed).
    let pngOk = false;
    let htmlOk = false;
    let diagOk = false;

    try {
      await page.screenshot({ path: pngPath, fullPage: true });
      pngOk = true;
    } catch (err) {
      console.warn(`[debug] screenshot failed for ${pngName}: ${err instanceof Error ? err.message : err}`);
    }

    let html = '';
    try {
      html = await page.content();
    } catch (err) {
      console.warn(`[debug] page.content() failed for ${htmlName}: ${err instanceof Error ? err.message : err}`);
    }
    if (html) {
      try {
        await writeFile(htmlPath, html, 'utf8');
        htmlOk = true;
      } catch (err) {
        console.warn(`[debug] writeFile failed for ${htmlName}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Dump diagnostico compacto: URL + lista de elementos visiveis com texto
    // ou aria-label contendo palavras chave do flow ("avancar", "next",
    // "compartilhar", "share", etc). Arquivo .txt eh pequeno (~5-50KB), facil
    // de mandar via Workana, e me da TUDO que preciso pra ajustar selectors.
    try {
      const diag = await page.evaluate(() => {
        const KEYWORDS = ['avancar', 'avançar', 'next', 'proximo', 'próximo', 'continuar', 'continue', 'compartilhar', 'share', 'publicar', 'post', 'enviar', 'original', 'cortar', 'crop', 'editar', 'edit', 'filtros', 'filters'];
        function collectAll(root: Document | ShadowRoot): Element[] {
          const result: Element[] = [];
          for (const el of Array.from(root.querySelectorAll('*'))) {
            result.push(el);
            const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (sr) result.push(...collectAll(sr));
          }
          return result;
        }
        const elements: Element[] = collectAll(document);
        for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
          try {
            const doc = (iframe as HTMLIFrameElement).contentDocument;
            if (doc) elements.push(...collectAll(doc));
          } catch { /* cross-origin */ }
        }
        const matches: string[] = [];
        for (const el of elements) {
          const r = (el as HTMLElement).getBoundingClientRect?.();
          if (!r || r.width === 0 || r.height === 0) continue;
          const txt = (el.textContent || '').trim().slice(0, 80).toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const hit = KEYWORDS.some((k) => txt === k || aria === k || (txt.length < 30 && txt.includes(k)) || aria.includes(k));
          if (!hit) continue;
          const role = el.getAttribute('role') || '';
          const cls = (el.getAttribute('class') || '').slice(0, 60);
          matches.push(`${el.tagName}[role="${role}"][aria-label="${aria}"][class="${cls}"] text="${txt}"`);
          if (matches.length >= 100) break;
        }
        return [
          `URL: ${location.href}`,
          `Title: ${document.title}`,
          `Match count: ${matches.length}`,
          '',
          ...matches,
        ].join('\n');
      });
      if (diag) {
        try {
          await writeFile(diagPath, diag, 'utf8');
          diagOk = true;
        } catch (err) {
          console.warn(`[debug] writeFile failed for ${diagName}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.warn(`[debug] page.evaluate(diag) failed for ${diagName}: ${err instanceof Error ? err.message : err}`);
    }

    // Verifica em disco antes de logar/retornar. Se algum artefato falhou,
    // loga e retorna null pra esse campo (em vez de retornar path fantasma).
    const verify = async (path: string, ok: boolean) => {
      if (!ok) return false;
      try {
        const st = await stat(path);
        return st.isFile() && st.size > 0;
      } catch {
        return false;
      }
    };
    const [pngOnDisk, htmlOnDisk, diagOnDisk] = await Promise.all([
      verify(pngPath, pngOk),
      verify(htmlPath, htmlOk),
      verify(diagPath, diagOk),
    ]);

    // Loga caminho ABSOLUTO no console pra usuario achar facil. So loga
    // os que existem de verdade.
    if (pngOnDisk) console.log(`[debug] saved: ${pngPath}`);
    if (htmlOnDisk) console.log(`[debug] saved: ${htmlPath}`);
    if (diagOnDisk) console.log(`[debug] saved: ${diagPath}`);
    if (!pngOnDisk && !htmlOnDisk && !diagOnDisk) {
      console.warn(`[debug] captureDebug(${tag}): nenhum artefato escrito em disco — page provavelmente fechou antes da captura.`);
    }

    return {
      screenshot: pngOnDisk ? `/media-files/debug/${pngName}` : null,
      html: htmlOnDisk ? `/media-files/debug/${htmlName}` : null,
      diag: diagOnDisk ? `/media-files/debug/${diagName}` : null,
    };
  } catch (err) {
    console.warn(`[debug] captureDebug(${tag}) erro fatal: ${err instanceof Error ? err.message : err}`);
    return { screenshot: null, html: null, diag: null };
  }
}
