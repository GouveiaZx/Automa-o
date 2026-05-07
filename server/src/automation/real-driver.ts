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
 * Fecha modais informativos que o IG mostra eventualmente (ex: "Agora os posts
 * de video sao compartilhados como reels"). Sao popups com botao "OK" no centro
 * da tela que travam o fluxo. Sai sem erro se nao achar nada (no-op).
 */
async function dismissInfoModal(page: Page): Promise<void> {
  // Tenta varios labels comuns em ambos: <button> e <div role=button>.
  // IG moderno usa role=button em divs. Timeout curto pra nao demorar quando nao tem modal.
  // CRITICO: nao incluir "Compartilhar", "Share", "Avançar", "Next" aqui — esses sao
  // botoes de acao primaria do fluxo (cada Step clica eles na hora certa).
  // Se incluidos, o dismissInfoModal cascateia pelas telas (Cortar→Filtros→Caption→Sharing)
  // e quebra o fluxo, gerando no_advance_after_upload com screenshot da Sharing.
  const labels = [
    'OK', 'Ok',
    'Entendi', 'Got it',
    'Continuar', 'Continue',
    'Permitir', 'Allow',
    'Sim', 'Yes',
    'Concluir', 'Done', 'Concluído', 'Concluido',
  ];
  // Gera selectors pra cada label em ambos formatos
  const okSelectors: string[] = [];
  for (const label of labels) {
    okSelectors.push(`div[role="dialog"] button:has-text("${label}")`);
    okSelectors.push(`div[role="dialog"] div[role="button"]:has-text("${label}")`);
  }
  for (const sel of okSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => undefined);
        await humanDelay(500, 1000);
        // Tenta DE NOVO recursivamente caso aparece outro modal em sequencia
        await dismissInfoModal(page);
        return;
      }
    } catch { /* tenta proximo */ }
  }
}

/**
 * Tenta postar como STORY de verdade (24h) via /stories/create/.
 * Retorna:
 *  - { ok: true } se postou
 *  - { ok: false, reason: 'story_not_available' } se IG nao deu acesso (conta nova/sem permissao)
 *  - { ok: false, reason: '...' } com detalhes se foi outro erro
 */
// User-Agent iPhone real (Safari iOS 17.5). Usado pra spoofar mobile e
// destravar o criador de Story do IG, que so funciona em mobile web.
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

async function applyMobileSpoof(page: Page): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  // Layer 1: HTTP headers
  try {
    await page.context().setExtraHTTPHeaders({ 'User-Agent': IPHONE_UA });
  } catch (e) {
    failures.push(`http_headers: ${e instanceof Error ? e.message : 'unknown'}`);
  }
  // Layer 2: JS navigator (initScript aplica em todas as paginas futuras do contexto)
  try {
    await page.context().addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', configurable: true });
        Object.defineProperty(navigator, 'platform', { get: () => 'iPhone', configurable: true });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
        Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.', configurable: true });
      } catch { /* ignore */ }
    });
  } catch (e) {
    failures.push(`init_script: ${e instanceof Error ? e.message : 'unknown'}`);
  }
  // Layer 3: viewport mobile
  try {
    await page.setViewportSize({ width: 390, height: 844 });
  } catch (e) {
    failures.push(`viewport: ${e instanceof Error ? e.message : 'unknown'}`);
  }
  if (failures.length > 0) {
    await appLog({
      source: 'driver',
      level: 'warn',
      message: `[real] mobile spoof aplicado parcialmente: ${failures.join(' | ')}`,
    });
  }
  return { ok: failures.length === 0, failures };
}

async function revertMobileSpoof(page: Page): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'User-Agent': DESKTOP_UA }).catch(() => undefined);
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  // initScript fica injetado pra paginas FUTURAS — pra reverter o JS spoof,
  // precisa criar contexto novo. Como perfil eh AdsPower (1 contexto), reload da pagina
  // limpa o spoof JS aplicado nesta sessao.
}

async function tryPostRealStory(args: PostArgs): Promise<DriverResult> {
  const page = await getPage(args.adsPowerId);
  try {
    // Aplica spoof mobile (UA + viewport + JS navigator override)
    await applyMobileSpoof(page);
    await page.goto('https://www.instagram.com/stories/create/', { waitUntil: 'domcontentloaded' });
    await humanDelay(2500, 4000);

    // Detectar se IG redirecionou pra fora do criador de story.
    // IG mobile pode redirecionar pra: /stories/create, /create/story, /sh/..., /create/...
    // Se ficou em qualquer URL com "create" ou "story", consideramos OK.
    const finalUrl = page.url();
    const onCreator = /\/(stories?\/create|create\/story|sh\/|create\/)/.test(finalUrl);
    if (!onCreator) {
      // Reverter spoof antes de retornar pro fallback do feed
      await revertMobileSpoof(page);
      return { ok: false, reason: 'story_not_available' };
    }

    // Procura input de upload — se nao tiver, story create nao carregou
    let uploaded = false;
    try {
      const inputFile = page.locator('input[type="file"]').first();
      await inputFile.waitFor({ timeout: 8000, state: 'attached' });
      await inputFile.setInputFiles(args.filePath);
      uploaded = true;
    } catch {
      // Tenta via filechooser (alguns layouts pedem clique antes)
      try {
        const addBtn = await findAny(
          page,
          [
            'button:has-text("Adicionar")',
            'button:has-text("Add")',
            'div[role="button"]:has-text("Adicionar")',
            'div[role="button"]:has-text("Add")',
          ],
          5000
        );
        if (addBtn) {
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }),
            addBtn.click({ timeout: 5000 }),
          ]);
          await chooser.setFiles(args.filePath);
          uploaded = true;
        }
      } catch { /* segue */ }
    }

    if (!uploaded) {
      return { ok: false, reason: 'story_not_available' };
    }

    await humanDelay(4000, 7000);

    // Se houver linkUrl, tenta adicionar sticker de Link (otima feature do IG story)
    if (args.linkUrl) {
      try {
        const stickerBtn = await findAny(
          page,
          [
            'button[aria-label*="Adesivo" i]',
            'button[aria-label*="Sticker" i]',
            'svg[aria-label*="Adesivo" i]',
            'svg[aria-label*="Sticker" i]',
          ],
          4000
        );
        if (stickerBtn) {
          await stickerBtn.click().catch(() => undefined);
          await humanDelay(800, 1500);
          const linkOption = await findAny(
            page,
            [
              'button:has-text("Link")',
              'div[role="button"]:has-text("Link")',
            ],
            3000
          );
          if (linkOption) {
            await linkOption.click().catch(() => undefined);
            await humanDelay(800, 1500);
            const urlInput = await findAny(
              page,
              [
                'input[placeholder*="URL" i]',
                'input[placeholder*="link" i]',
                'input[type="url"]',
              ],
              3000
            );
            if (urlInput) {
              await urlInput.fill(args.linkUrl).catch(() => undefined);
              const okBtn = await findAny(
                page,
                [
                  'button:has-text("Concluido")',
                  'button:has-text("Concluído")',
                  'button:has-text("Done")',
                  'button:has-text("OK")',
                ],
                3000
              );
              if (okBtn) await okBtn.click().catch(() => undefined);
              await humanDelay(800, 1500);
            }
          }
        }
      } catch { /* link sticker eh opcional */ }
    }

    // Botao pra postar story. Inclui selectors desktop E mobile UI:
    //   Desktop: "Compartilhar" / "Share"
    //   Mobile:  "Sua story" / "Adicionar a sua story" / "Add to your story" / "Publicar" / "Post"
    const shareSelectors = [
      // Mobile UI - prioridade alta (texto especifico de story)
      'button:has-text("Sua story")',
      'button:has-text("Your story")',
      'button:has-text("Adicionar a sua story")',
      'button:has-text("Adicionar à sua story")',
      'button:has-text("Add to your story")',
      'div[role="button"]:has-text("Sua story")',
      'div[role="button"]:has-text("Your story")',
      'div[role="button"]:has-text("Adicionar a sua story")',
      'div[role="button"]:has-text("Adicionar à sua story")',
      'div[role="button"]:has-text("Add to your story")',
      // Desktop UI - generico
      'button:has-text("Compartilhar")',
      'button:has-text("Share")',
      'button:has-text("Publicar")',
      'button:has-text("Post")',
      'div[role="button"]:has-text("Compartilhar")',
      'div[role="button"]:has-text("Share")',
      'div[role="button"]:has-text("Publicar")',
      'div[role="button"]:has-text("Post")',
    ];
    const shareBtn = await findAny(page, shareSelectors, 8000);
    if (!shareBtn) {
      const dbg = await captureDebug(page, 'story-no-share');
      await revertMobileSpoof(page);
      return { ok: false, reason: `story_no_share_button ${dbg.screenshot ?? ''}` };
    }
    await shareBtn.click({ timeout: 8000 });
    await humanDelay(2500, 4000);

    // Em alguns fluxos aparece confirmacao "Adicionar a sua story" → click final
    try {
      const confirmBtn = await findAny(
        page,
        [
          'button:has-text("Adicionar a sua story")',
          'button:has-text("Add to your story")',
          'div[role="button"]:has-text("Adicionar a sua story")',
          'div[role="button"]:has-text("Add to your story")',
        ],
        5000
      );
      if (confirmBtn) {
        await confirmBtn.click({ timeout: 5000 });
        await humanDelay(2000, 3000);
      }
    } catch { /* segue */ }

    // Aguarda redirect/confirmacao
    try {
      await page.waitForURL(/\/(?!stories\/create)/, { timeout: 15_000 });
    } catch {
      // Sem redirect, mas se sumiu o input file e nao tem erro visivel, considera OK
      const stillOnCreate = page.url().includes('/stories/create');
      if (stillOnCreate) {
        const dbg = await captureDebug(page, 'story-uncertain');
        await revertMobileSpoof(page);
        return { ok: false, reason: `story_post_uncertain ${dbg.screenshot ?? ''}` };
      }
    }

    await appLog({
      source: 'driver',
      level: 'info',
      message: `[real] story postado via web pra ${args.adsPowerId}`,
    });
    // Reverte UA pra desktop pra proximos jobs (feed, bio) funcionarem normal
    await revertMobileSpoof(page);
    return { ok: true };
  } catch (err) {
    const dbg = await captureDebug(page, 'story-error');
    await revertMobileSpoof(page).catch(() => undefined);
    return {
      ok: false,
      reason: `${err instanceof Error ? err.message : 'unknown'} ${dbg.screenshot ?? ''}`,
    };
  }
}

/**
 * Flow unificado: clicar "+" → upload → Avançar 2x → caption → Compartilhar.
 * Funciona para POST regular (foto/vídeo no feed).
 * Usado tambem como fallback quando postStory nao consegue acessar /stories/create/.
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
    // Detecta se eh video (precisa esperar IG processar — pode demorar)
    const isVideo = /\.(mp4|mov|webm|m4v|avi)$/i.test(args.filePath);

    if (isVideo) {
      // Pra video: SEMPRE da delay minimo de 8s (video precisa processar mesmo)
      // + waitForFunction esperando IG sair de estado de "processando" como guardrail.
      // O delay minimo evita falso positivo se o botao Avancar ja estava enabled.
      await humanDelay(8000, 12000);
      try {
        // Espera ate 60s a mais por: spinner de processamento sumir OU
        // botao Avancar ficar enabled (qualquer um indica IG terminou de processar).
        await page.waitForFunction(
          () => {
            // Se tem spinner/loading visivel, ainda processando
            const spinners = document.querySelectorAll('[role="progressbar"], svg[aria-label*="Carregando" i], svg[aria-label*="Loading" i]');
            for (const s of spinners) {
              const rect = (s as HTMLElement).getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return false; // ainda processando
            }
            // Sem spinner: confere se Avancar ta enabled
            const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const advanceBtn = btns.find((b) => /^(Avançar|Next)$/i.test(b.textContent?.trim() || ''));
            if (!advanceBtn) return false;
            const disabled = (advanceBtn as HTMLButtonElement).disabled || advanceBtn.getAttribute('aria-disabled') === 'true';
            return !disabled;
          },
          undefined,
          { timeout: 60_000, polling: 1000 }
        );
      } catch {
        // Nao detectou conclusao — da delay extra defensivo
        await humanDelay(10000, 15000);
      }
    } else {
      await humanDelay(5000, 8000);
    }

    // Step 2.5: o IG abre modal informativo "Agora os posts de video sao compartilhados como reels"
    // (so pra videos). Precisa clicar OK pra prosseguir, senao trava na tela "Cortar".
    await dismissInfoModal(page);

    // Step 3: tela "Cortar" → click "Avançar"
    try {
      await page.getByRole('button', { name: /^Avançar$|^Next$/i }).first().click({ timeout: 12000 });
    } catch {
      // Tenta de novo apos fechar qualquer modal residual
      await dismissInfoModal(page);
      try {
        await page.getByRole('button', { name: /^Avançar$|^Next$/i }).first().click({ timeout: 6000 });
      } catch {
        const dbg = await captureDebug(page, 'no-advance-1');
        return { ok: false, reason: `no_advance_after_upload ${dbg.screenshot ?? ''}` };
      }
    }
    await humanDelay(2500, 4000);

    // Step 3.5: pode aparecer outro modal entre as telas (ex: "Compartilhar como Reels"
    // tem confirmacoes secundarias). Fecha qualquer popup informativo.
    await dismissInfoModal(page);

    // Step 4: tela "Editar" (filtros) → click "Avançar"
    try {
      await page.getByRole('button', { name: /^Avançar$|^Next$/i }).first().click({ timeout: 12000 });
    } catch {
      await dismissInfoModal(page);
      try {
        await page.getByRole('button', { name: /^Avançar$|^Next$/i }).first().click({ timeout: 6000 });
      } catch {
        const dbg = await captureDebug(page, 'no-advance-2');
        return { ok: false, reason: `no_advance_after_filters ${dbg.screenshot ?? ''}` };
      }
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

    // Step 6.5: APOS clicar Compartilhar o IG pode mostrar popup informativo
    // (ex: "Agora posts de video sao compartilhados como reels", confirmacao
    // de privacidade, etc). Sem fechar esse popup, o sistema fica preso 90s
    // ate timeout. Chamamos dismissInfoModal varias vezes pra cobrir popups
    // que aparecem em sequencia.
    await humanDelay(2000, 3500);
    await dismissInfoModal(page);
    await humanDelay(1500, 2500);
    await dismissInfoModal(page);

    // Step 7: aguarda confirmação de sucesso REAL (upload terminou no servidor IG).
    //
    // Bug antigo: confiava em "Criar novo post" sumir, mas IG mostra tela "Sharing"
    // com spinner DEPOIS do dialog sumir — sistema fechava antes do upload terminar.
    //
    // Agora: aguarda TODAS as condicoes simultaneas:
    //   - Dialog "Criar novo post" nao esta visivel
    //   - Texto "Sharing"/"Compartilhando"/"Enviando" nao esta visivel
    //   - Sem spinner/progressbar ativo dentro de qualquer dialog
    //
    // Timeout: 90s pra video (reel pode demorar pra processar+upload),
    // 30s pra foto. Em caso de timeout, checa URL: se mudou pra /reels/, /p/,
    // ou perfil → considera OK (IG redirecionou apos sucesso).
    const finalTimeout = isVideo ? 90_000 : 30_000;
    let confirmed = false;
    try {
      await page.waitForFunction(
        () => {
          // 1. Dialog "Criar novo post" ainda aberto?
          const stillOnCreate = document.querySelector(
            'div[role="dialog"] [aria-label="Criar novo post"]'
          );
          if (stillOnCreate) return false;
          // Tambem checa header com texto
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
          for (const d of dialogs) {
            const headers = d.querySelectorAll('header, h1, h2');
            for (const h of headers) {
              if (/Criar novo post|Create new post/i.test(h.textContent?.trim() || '')) {
                return false;
              }
            }
          }
          // 2. Tela "Sharing"/"Compartilhando"/"Enviando" visivel?
          const sharingTexts = ['Sharing', 'Compartilhando', 'Enviando', 'Publicando', 'Posting'];
          const allTextEls = Array.from(document.querySelectorAll('div, span, header'));
          for (const t of sharingTexts) {
            if (allTextEls.some((el) => {
              const txt = el.textContent?.trim() || '';
              return txt === t && (el as HTMLElement).offsetParent !== null;
            })) {
              return false;
            }
          }
          // 3. Spinner ativo dentro de dialog?
          const spinners = document.querySelectorAll(
            'div[role="dialog"] [role="progressbar"], div[role="dialog"] svg[aria-label*="Carregando" i], div[role="dialog"] svg[aria-label*="Loading" i]'
          );
          for (const s of spinners) {
            const r = (s as HTMLElement).getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return false;
          }
          return true;
        },
        undefined,
        { timeout: finalTimeout, polling: 1000 }
      );
      confirmed = true;
    } catch {
      // Timeout — confere se URL mudou (IG redireciona apos publicar com sucesso)
      const url = page.url();
      const successUrl = /\/(reels?|p\/|stories\/highlights|[^/]+\/?$)/.test(url) && !url.includes('/create');
      if (successUrl) {
        confirmed = true;
      } else {
        // Ultima checagem: dialog "Criar novo post" ainda visivel?
        const stillOpen = await page
          .locator('div[role="dialog"]:has-text("Criar novo post"), div[role="dialog"]:has-text("Create new post")')
          .first()
          .isVisible({ timeout: 1500 })
          .catch(() => false);
        // Tambem checa se ainda tem "Sharing" visivel
        const stillSharing = await page
          .getByText(/^(Sharing|Compartilhando|Enviando|Publicando|Posting)$/)
          .first()
          .isVisible({ timeout: 1500 })
          .catch(() => false);
        confirmed = !stillOpen && !stillSharing;
      }
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
    // Tenta postar STORY de verdade via /stories/create/.
    // Se a conta nao tiver permissao (IG bloqueia em contas novas),
    // faz fallback pro flow de post no feed (postViaCreateModal).
    const storyResult = await tryPostRealStory(args);
    if (storyResult.ok) return storyResult;
    if (storyResult.reason === 'story_not_available') {
      // Conta sem permissao web pra story → cai pra post no feed
      await appLog({
        source: 'driver',
        level: 'warn',
        message: `[real] story nao disponivel via web pra essa conta, postando no feed como foto/video`,
      });
      return postViaCreateModal(args);
    }
    // Erro real (nao "indisponivel"): retorna o erro tal como veio
    return storyResult;
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

      // IMPORTANTE: o Instagram BLOQUEIA edicao do campo Site via web.
      // A pagina mostra "Somente eh possivel editar os links no celular".
      // O input existe mas eh disabled/readonly. Nao adianta tentar digitar.
      // Aqui detectamos isso e logamos pro operador saber que precisa atualizar
      // manualmente pelo app mobile.
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
          const isDisabled = await siteInput.isDisabled().catch(() => false);
          const isReadonly = await siteInput.evaluate((el) => (el as HTMLInputElement).readOnly).catch(() => false);
          if (isDisabled || isReadonly) {
            await appLog({
              source: 'driver',
              level: 'warn',
              message: `[real] campo Site nao editavel via web pra ${args.adsPowerId}. Atualize pelo app mobile do Instagram (Editar perfil -> Site).`,
            });
            // nao seta touched=true pelo site, mas segue pro bio (essa parte funciona)
          } else {
            await siteInput.click();
            await page.keyboard.press('Control+A').catch(() => undefined);
            await page.keyboard.press('Delete').catch(() => undefined);
            await humanDelay(150, 300);
            await page.keyboard.type(args.websiteUrl, { delay: 20 });
            touched = true;
          }
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
