import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Locator } from 'playwright';

export const DEBUG_DIR = join(process.cwd(), 'media', 'debug');

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
): Promise<{ screenshot: string | null; html: string | null }> {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTag = tag.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    const pngName = `${safeTag}-${ts}.png`;
    const htmlName = `${safeTag}-${ts}.html`;
    const pngPath = join(DEBUG_DIR, pngName);
    const htmlPath = join(DEBUG_DIR, htmlName);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined);
    const html = await page.content().catch(() => '');
    if (html) await writeFile(htmlPath, html, 'utf8').catch(() => undefined);
    return { screenshot: `/media-files/debug/${pngName}`, html: `/media-files/debug/${htmlName}` };
  } catch {
    return { screenshot: null, html: null };
  }
}
