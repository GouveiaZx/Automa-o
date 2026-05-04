import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { adsPowerClient } from './adspower-client.js';
import { captureDebug, findAny, humanDelay } from './playwright-helpers.js';
import { appLog } from '../logger.js';
import { env } from '../env.js';
import type { AutomationDriver, BioArgs, DriverResult, PostArgs } from './driver.js';

interface OpenSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const sessions = new Map<string, OpenSession>();

// Mutex por adsPowerId: serializa openProfile/closeProfile concorrentes pro
// MESMO perfil. Sem isso, 2 calls simultaneas (worker + diagnostico, ou 2 jobs)
// podem abrir 2 browsers AdsPower e perder uma referencia → Chromium orfao.
const profileMutex = new Map<string, Promise<unknown>>();

function withProfileLock<T>(adsPowerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = profileMutex.get(adsPowerId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // roda fn mesmo se prev rejeitou
  // mantem o lock ate fn terminar; remove se for o ultimo
  profileMutex.set(
    adsPowerId,
    next.finally(() => {
      if (profileMutex.get(adsPowerId) === next) profileMutex.delete(adsPowerId);
    })
  );
  return next;
}

// Fecha browser/context/page com timeout para evitar deadlock do Playwright/CDP.
async function closeSession(s: OpenSession, timeoutMs = 10_000): Promise<void> {
  const closeAll = (async () => {
    await s.page.close().catch(() => undefined);
    await s.context.close().catch(() => undefined);
    await s.browser.close().catch(() => undefined);
  })();
  await Promise.race([
    closeAll,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function getPage(adsPowerId: string): Promise<Page> {
  const s = sessions.get(adsPowerId);
  if (!s) throw new Error(`session_not_open:${adsPowerId}`);
  // Health check: se browser caiu (AdsPower restart, CDP perdeu conexao),
  // a sessao guardada eh stale. evaluate() falha rapido nesse caso.
  try {
    await s.page.evaluate(() => 1);
    return s.page;
  } catch {
    sessions.delete(adsPowerId);
    throw new Error(`session_stale:${adsPowerId}`);
  }
}

/**
 * Flow unificado: clicar "+" → upload → Avançar 2x → caption → Compartilhar.
 * Funciona para POST regular (foto/vídeo no feed). IG Web em conta nova não
 * expõe criador de Story, por isso postStory usa esse mesmo flow (= post no feed).
 */
async function postViaCreateModal(args: PostArgs): Promise<DriverResult> {
  const page = await getPage(args.adsPowerId);
  try {
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 4500);

    // Step 1: Click "+" (Novo post)
    try {
      await page
        .locator('a:has(svg[aria-label="Novo post"]), a:has(svg[aria-label="New post"])')
        .first()
        .click({ timeout: 8000 });
    } catch {
      const dbg = await captureDebug(page, 'create-no-plus');
      return { ok: false, reason: `create_button_not_found ${dbg.screenshot ?? ''}` };
    }
    await humanDelay(2000, 3000);

    // Step 2: Modal "Criar novo post" → click "Selecionar do computador" + setFiles
    try {
      const dialogBtn = page
        .getByRole('dialog')
        .getByRole('button', { name: /Selecionar do computador|Select from computer/i })
        .first();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        dialogBtn.click({ timeout: 5000 }),
      ]);
      await chooser.setFiles(args.filePath);
    } catch {
      // fallback: setInputFiles direto no input hidden
      try {
        await page.locator('input[type="file"]').first().setInputFiles(args.filePath);
      } catch {
        const dbg = await captureDebug(page, 'upload-failed');
        return { ok: false, reason: `upload_failed ${dbg.screenshot ?? ''}` };
      }
    }
    await humanDelay(5000, 8000);

    // Step 3: tela "Cortar" → click "Avançar"
    try {
      await page.getByRole('button', { name: /^Avançar$|^Next$/i }).first().click({ timeout: 12000 });
    } catch {
      const dbg = await captureDebug(page, 'no-advance-1');
      return { ok: false, reason: `no_advance_after_upload ${dbg.screenshot ?? ''}` };
    }
    await humanDelay(2500, 4000);

    // Step 4: tela "Editar" (filtros) → click "Avançar"
    try {
      await page.getByRole('button', { name: /^Avançar$|^Next$/i }).first().click({ timeout: 12000 });
    } catch {
      const dbg = await captureDebug(page, 'no-advance-2');
      return { ok: false, reason: `no_advance_after_filters ${dbg.screenshot ?? ''}` };
    }
    await humanDelay(2500, 4000);

    // Step 5: caption (opcional). Se houver linkUrl, concatena ao final
    // (IG não permite link clicável na caption de post, mas o operador
    // pode copiar o texto. Assim o link fica visível pelo menos.)
    const captionFinal = [args.caption, args.linkUrl ? `🔗 ${args.linkUrl}` : null]
      .filter(Boolean)
      .join('\n\n');
    if (captionFinal) {
      try {
        const captionField = await findAny(
          page,
          [
            'div[contenteditable="true"][aria-label*="legenda" i]',
            'textarea[aria-label*="legenda" i]',
            'div[contenteditable="true"][aria-label*="caption" i]',
            'textarea[aria-label*="caption" i]',
            'div[role="dialog"] div[contenteditable="true"]',
            'div[contenteditable="true"]',
          ],
          8000
        );
        if (captionField) {
          await captionField.click();
          await humanDelay(200, 500);
          const captionText = captionFinal.slice(0, 2200);
          // textarea: usa fill (preserva escape de aspas/emojis sem quirks de keyboard).
          // contenteditable: precisa de keyboard.type pra disparar onInput do React.
          const tagName = await captionField.evaluate((el) => el.tagName).catch(() => '');
          if (tagName === 'TEXTAREA') {
            await captionField.fill(captionText);
          } else {
            await page.keyboard.type(captionText, { delay: 15 });
          }
        }
      } catch {
        /* segue mesmo sem caption */
      }
    }
    await humanDelay(800, 1500);

    // Step 6: Click "Compartilhar" (com fallbacks pra IG trocar label)
    let shareClicked = false;
    const shareSelectors = [
      'div[role="dialog"] div[role="button"]:has-text("Compartilhar")',
      'div[role="dialog"] div[role="button"]:has-text("Share")',
      'div[role="dialog"] div[role="button"]:has-text("Publicar")',
      'div[role="dialog"] div[role="button"]:has-text("Post")',
      'div[role="dialog"] button:has-text("Compartilhar")',
      'div[role="dialog"] button:has-text("Share")',
      'div[role="dialog"] button:has-text("Publicar")',
      'div[role="dialog"] button:has-text("Post")',
    ];
    try {
      const shareBtn = await findAny(page, shareSelectors, 8000);
      if (shareBtn) {
        await shareBtn.click({ timeout: 10000 });
        shareClicked = true;
      } else {
        // ultimo fallback: getByRole com regex ampla
        await page
          .getByRole('button', { name: /^(Compartilhar|Share|Publicar|Post|Enviar)$/i })
          .first()
          .click({ timeout: 8000 });
        shareClicked = true;
      }
    } catch {
      const dbg = await captureDebug(page, 'no-share-btn');
      return { ok: false, reason: `share_button_not_found ${dbg.screenshot ?? ''}` };
    }
    if (!shareClicked) {
      const dbg = await captureDebug(page, 'no-share-btn');
      return { ok: false, reason: `share_button_not_clicked ${dbg.screenshot ?? ''}` };
    }

    // Step 7: aguarda confirmação de sucesso. Critérios (qualquer um basta):
    //  a) Toast com "compartilhado"/"shared"/"publicado"/"posted" como FRASE específica
    //  b) Modal "Criar novo post" desaparece (sucesso UI fechou)
    //  c) Modal mostra "Sua publicação foi compartilhada" / "Your post has been shared"
    let confirmed = false;
    try {
      await Promise.race([
        page.getByText(/Sua publica[çc][ãa]o foi compartilhada|Your post has been shared|Publica[çc][ãa]o compartilhada|Post shared/i, { exact: false }).first().waitFor({ timeout: 25_000 }),
        page.waitForFunction(
          () => !document.querySelector('div[role="dialog"] [aria-label="Criar novo post"], div[role="dialog"] header:has-text("Criar novo post")'),
          undefined,
          { timeout: 25_000 }
        ),
      ]);
      confirmed = true;
    } catch {
      // último critério: dialog Criar novo post sumiu = post fechou
      const stillOpen = await page
        .locator('div[role="dialog"]:has-text("Criar novo post")')
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false);
      confirmed = !stillOpen;
    }

    if (!confirmed) {
      const dbg = await captureDebug(page, 'post-uncertain');
      return { ok: false, reason: `post_not_confirmed ${dbg.screenshot ?? ''}` };
    }
    await humanDelay(2000, 3500);
    return { ok: true };
  } catch (err) {
    const dbg = await captureDebug(page, 'post-error');
    return {
      ok: false,
      reason: `${err instanceof Error ? err.message : 'unknown'} ${dbg.screenshot ?? ''}`,
    };
  }
}

export const realDriver: AutomationDriver = {
  async openProfile(adsPowerId: string): Promise<DriverResult> {
    return withProfileLock(adsPowerId, async () => {
      // Cleanup previo (sob o mesmo lock — sem race com outras chamadas)
      const prev = sessions.get(adsPowerId);
      if (prev) {
        sessions.delete(adsPowerId);
        await closeSession(prev);
        await adsPowerClient.stopBrowser(adsPowerId).catch(() => undefined);
      }
    try {
      const start = await withRetries(() => adsPowerClient.startBrowser(adsPowerId));
      const wsEndpoint = start.ws.puppeteer;
      if (!wsEndpoint) {
        return { ok: false, reason: 'adspower_no_ws_endpoint' };
      }

      const browser = await chromium.connectOverCDP(wsEndpoint, {
        slowMo: env.PLAYWRIGHT_SLOW_MO_MS || undefined,
      });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(30_000);
      page.setDefaultNavigationTimeout(45_000);

      sessions.set(adsPowerId, { browser, context, page });
      await appLog({
        source: 'driver',
        level: 'info',
        message: `[real] perfil ${adsPowerId} aberto via AdsPower`,
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      await appLog({
        source: 'driver',
        level: 'error',
        message: `[real] falha abrindo perfil ${adsPowerId}: ${msg}`,
      });
      return { ok: false, reason: msg };
    }
    });
  },

  async ensureLoggedIn(adsPowerId: string, igUsername: string): Promise<boolean> {
    const page = await getPage(adsPowerId);
    try {
      await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
      await humanDelay(2000, 3500);

      // Tela de consentimento LGPD/Meta (1ª etapa)
      try {
        await page
          .getByRole('button', { name: /Começar|Get started|Continue/i })
          .first()
          .click({ timeout: 3000 });
        await humanDelay(800, 1500);
      } catch {
        /* sem consent */
      }

      // Tela de cookies/permitir
      try {
        await page
          .getByRole('button', { name: /Permitir todos|Allow all|Aceitar|Accept|Concordar|Agree/i })
          .first()
          .click({ timeout: 2000 });
        await humanDelay();
      } catch {
        /* sem cookies */
      }

      // Pop-ups de salvar info / notificações ("Agora não")
      for (let i = 0; i < 2; i++) {
        try {
          await page
            .getByRole('button', { name: /^Agora não$|^Not now$/i })
            .first()
            .click({ timeout: 2000 });
          await humanDelay();
        } catch {
          break;
        }
      }

      // Detecta tela de login (campos username/password)
      const loginField = await findAny(
        page,
        ['input[name="username"]', 'input[aria-label*="Telefone" i]', 'input[aria-label*="username" i]'],
        2000
      );
      if (loginField) {
        await captureDebug(page, `login-needed-${igUsername}`);
        return false;
      }

      // Confirma logado pelo svg "Página inicial" no sidebar
      const home = await findAny(
        page,
        [
          'svg[aria-label="Página inicial"]',
          'svg[aria-label="Home"]',
          'svg[aria-label="Início"]',
          `[role=link][href="/${igUsername}/"]`,
        ],
        8000
      );
      if (!home) {
        await captureDebug(page, `unsure-${igUsername}`);
        return false;
      }
      return true;
    } catch (err) {
      await captureDebug(page, `ensure-error-${igUsername}`);
      throw err;
    }
  },

  async postStory(args: PostArgs): Promise<DriverResult> {
    // IG Web em conta nova não expõe criador de Story; flow único de post no feed
    return postViaCreateModal(args);
  },

  async postReel(args: PostArgs): Promise<DriverResult> {
    return postViaCreateModal(args);
  },

  async updateBio(args: BioArgs): Promise<DriverResult> {
    const page = await getPage(args.adsPowerId);
    try {
      await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
      await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded' });
      await humanDelay(3000, 4500);

      // Tela pode redirecionar pra "/accounts/edit/" ou pra mobile equivalente
      // Campos: "Site" (input URL) e "Bio" (textarea)
      let touched = false;

      if (args.websiteUrl !== undefined && args.websiteUrl !== null) {
        const siteInput = await findAny(
          page,
          [
            'input[aria-label*="Site" i]',
            'input[aria-label*="Website" i]',
            'input[name="external_url"]',
            'input[placeholder*="site" i]',
          ],
          5000
        );
        if (siteInput) {
          await siteInput.click();
          await page.keyboard.press('Control+A').catch(() => undefined);
          await page.keyboard.press('Delete').catch(() => undefined);
          await humanDelay(150, 300);
          await page.keyboard.type(args.websiteUrl, { delay: 20 });
          touched = true;
        }
      }

      if (args.bio !== undefined && args.bio !== null) {
        const bioField = await findAny(
          page,
          [
            'textarea[aria-label*="Bio" i]',
            'textarea[name="biography"]',
            'textarea[placeholder*="bio" i]',
          ],
          5000
        );
        if (bioField) {
          await bioField.click();
          await page.keyboard.press('Control+A').catch(() => undefined);
          await page.keyboard.press('Delete').catch(() => undefined);
          await humanDelay(150, 300);
          await page.keyboard.type(args.bio.slice(0, 150), { delay: 25 });
          touched = true;
        }
      }

      if (!touched) {
        const dbg = await captureDebug(page, 'bio-no-fields');
        return { ok: false, reason: `bio_fields_not_found ${dbg.screenshot ?? ''}` };
      }

      await humanDelay(800, 1500);

      // Clicar "Enviar" / "Submit" / "Salvar"
      try {
        await page
          .getByRole('button', { name: /^Enviar$|^Submit$|^Salvar$|^Save$/i })
          .first()
          .click({ timeout: 8000 });
      } catch {
        const dbg = await captureDebug(page, 'bio-no-submit');
        return { ok: false, reason: `bio_submit_button_not_found ${dbg.screenshot ?? ''}` };
      }

      // Aguarda confirmação: ou toast, ou navegar pra outro lugar, ou ficar na mesma página estável
      await page.waitForTimeout(5000);
      return { ok: true };
    } catch (err) {
      const dbg = await captureDebug(page, 'bio-error');
      return {
        ok: false,
        reason: `${err instanceof Error ? err.message : 'unknown'} ${dbg.screenshot ?? ''}`,
      };
    }
  },

  async closeProfile(adsPowerId: string): Promise<void> {
    return withProfileLock(adsPowerId, async () => {
      const s = sessions.get(adsPowerId);
      sessions.delete(adsPowerId);
      if (s) await closeSession(s); // com timeout 10s
      await adsPowerClient.stopBrowser(adsPowerId).catch(() => undefined);
    });
  },

  getOpenSessionIds(): string[] {
    return Array.from(sessions.keys());
  },
};
