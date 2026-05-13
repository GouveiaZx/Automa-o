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
 * FIX 12: navega pro perfil do user e retorna o URL do post mais recente
 * (primeiro item da grid). Usado pra verificar se um post foi pro ar quando
 * Step 7 estoura HARD_CEILING_MS com last=in_progress.
 *
 * Captura BEFORE no inicio do flow, AFTER na timeout. Se URL diferente, post
 * foi pro ar mesmo sem confirmacao visual no /create/.
 *
 * Retorna null se nao conseguir carregar o perfil ou se a conta nao tem posts.
 */
async function getLatestPostUrl(page: Page, igUsername: string): Promise<string | null> {
  try {
    await page.goto(`https://www.instagram.com/${igUsername}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await humanDelay(1500, 2500);
    return await page.evaluate(() => {
      // Procura primeiro link de post na grid. IG profile renderiza posts
      // sorted por data (newest first).
      const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const postLink = links.find((a) => /\/(p|reel|reels)\/[A-Za-z0-9_-]+/.test(a.href));
      return postLink ? postLink.href : null;
    });
  } catch {
    return null;
  }
}

/**
 * Detecta se a pagina atual eh um checkpoint/CAPTCHA do Instagram.
 * Verifica:
 *   1. URL contem /challenge/, /auth_platform/, /accounts/suspended/
 *   2. Texto da pagina tem frases conhecidas (PT/EN/DE)
 *
 * Retorna string descritiva do tipo detectado, ou null se nao for checkpoint.
 * Permite que o processor pause a conta IMEDIATAMENTE sem gastar retries
 * (cada retry de checkpoint perde 10-20min e nao resolve nada — IG so libera
 * apos resolucao manual).
 *
 * Codex P2-5: faz 3 verificacoes espacadas em 1s pra cobrir caso onde a pagina
 * esta no meio de um redirect pra /challenge/. Custo de ~2s no caso negativo
 * (sem checkpoint), zero overhead no positivo (retorna no primeiro hit).
 */
async function detectCheckpoint(page: Page): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await detectCheckpointOnce(page);
    if (result) return result;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function detectCheckpointOnce(page: Page): Promise<string | null> {
  const url = page.url();
  if (/\/challenge\//.test(url)) return 'url:challenge';
  if (/\/auth_platform\//.test(url)) return 'url:auth_platform';
  if (/\/accounts\/suspended\//.test(url)) return 'url:suspended';

  // Texto da pagina — substrings em lowercase, multilingual
  const found = await page.evaluate(() => {
    const txt = (document.body?.innerText || '').toLowerCase();
    const phrases = [
      // PT
      'confirme que você é humano',
      'confirme que voce e humano',
      'confirme sua identidade',
      'sua conta foi suspensa',
      // EN
      "confirm that you're human",
      'confirm that you are human',
      "help us confirm it's you",
      'we just need to confirm',
      'your account has been suspended',
      // DE
      'bestätige, dass du ein mensch bist',
      'bestatige, dass du ein mensch bist',
      'weise nach, dass du kein bot bist',
      'dein konto wurde gesperrt',
    ];
    for (const p of phrases) {
      if (txt.includes(p)) return p;
    }
    return null;
  }).catch(() => null);

  return found ? `text:${found.slice(0, 40)}` : null;
}

/**
 * Fecha modais informativos que o IG mostra eventualmente (ex: "Agora os posts
 * de video sao compartilhados como reels"). Sao popups com botao "OK" no centro
 * da tela que travam o fluxo. Sai sem erro se nao achar nada (no-op).
 */
async function dismissInfoModal(page: Page, depth = 0): Promise<void> {
  // Limita profundidade pra evitar recursao infinita se popup nao fecha
  // (Codex audit #1: click podia falhar silent + recursive sem condicao de parada).
  if (depth >= 4) return;

  const labels = [
    // PT
    'OK', 'Ok',
    'Entendi', 'Got it',
    'Continuar', 'Continue',
    'Permitir', 'Allow',
    'Sim', 'Yes',
    'Concluir', 'Done', 'Concluído', 'Concluido',
    // DE
    'Verstanden',
    'Erlauben', 'Zulassen',
    'Ja',
    'Fertig', 'Schließen', 'Schliessen',
    'Weiter',
  ];
  const okSelectors: string[] = [];
  for (const label of labels) {
    okSelectors.push(`div[role="dialog"] button:has-text("${label}")`);
    okSelectors.push(`div[role="dialog"] div[role="button"]:has-text("${label}")`);
  }
  for (const sel of okSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        // Snapshot do dialog ANTES do click pra detectar se realmente fechou
        const beforeText = await page.evaluate(() => {
          const d = document.querySelector('div[role="dialog"]');
          return d ? (d.textContent || '').slice(0, 100) : '';
        }).catch(() => '');

        const clicked = await btn.click({ timeout: 2000 }).then(() => true).catch(() => false);
        await humanDelay(500, 1000);

        // So recurse se click foi bem-sucedido E o dialog mudou
        if (clicked) {
          const afterText = await page.evaluate(() => {
            const d = document.querySelector('div[role="dialog"]');
            return d ? (d.textContent || '').slice(0, 100) : '';
          }).catch(() => '');
          if (afterText !== beforeText) {
            await dismissInfoModal(page, depth + 1);
          }
        }
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
      // Desktop UI - generico (PT/EN/DE)
      'button:has-text("Compartilhar")',
      'button:has-text("Share")',
      'button:has-text("Publicar")',
      'button:has-text("Post")',
      'button:has-text("Teilen")',
      'button:has-text("Posten")',
      'div[role="button"]:has-text("Compartilhar")',
      'div[role="button"]:has-text("Share")',
      'div[role="button"]:has-text("Publicar")',
      'div[role="button"]:has-text("Post")',
      'div[role="button"]:has-text("Teilen")',
      'div[role="button"]:has-text("Posten")',
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

    // FIX 12: captura URL do post mais recente ANTES do flow comecar.
    // Usado depois no Step 7 pra detectar se um post novo apareceu mesmo
    // que IG nao tenha mostrado confirmacao visual no /create/.
    // Sem igUsername, skip (compat com chamadas legadas).
    let beforeLatestPostUrl: string | null = null;
    if (args.igUsername) {
      beforeLatestPostUrl = await getLatestPostUrl(page, args.igUsername);
    }

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 4500);

    // Step 1: Click "+" (Novo post / Criar / Create / Neuer Beitrag)
    //
    // FIX 11 (12/05/2026): refactor pra multi-strategy + multi-locale. Antes era
    // 1 selector rigido (a:has(svg[aria-label="Novo post"])), que nao casava em
    // variantes onde IG mostra "Criar"/"Create" no aria-label, ou onde envolve
    // o icone em <button> ou <div role="button"> em vez de <a>. Detectado quando
    // 1-2 contas de 9 sempre falhavam (provavel A/B test do IG).
    //
    // Tambem inclui diagnostico enriquecido: quando todas estrategias falham,
    // loga lista de SVGs visiveis com seus aria-labels pra eu identificar o
    // que IG esta mostrando sem precisar de print novo.
    const NAME_RE = /^(Novo post|New post|Criar|Create|Neuer Beitrag|Neuer Post|Erstellen)$/i;
    const clickCreateButton = async (): Promise<boolean> => {
      // Estrategia 1: getByRole link (cobre <a> com aria-label/text)
      try {
        const roleLink = page.getByRole('link', { name: NAME_RE }).first();
        if (await roleLink.isVisible({ timeout: 2000 }).catch(() => false)) {
          await roleLink.click({ timeout: 5000 });
          return true;
        }
      } catch { /* fallthrough */ }

      // Estrategia 2: getByRole button (cobre <button> e [role=button])
      try {
        const roleBtn = page.getByRole('button', { name: NAME_RE }).first();
        if (await roleBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await roleBtn.click({ timeout: 5000 });
          return true;
        }
      } catch { /* fallthrough */ }

      // Estrategia 3: CSS selectors com SVG aria-label em a/button/[role=button]
      const candidates = [
        'a:has(svg[aria-label="Novo post"])',
        'a:has(svg[aria-label="New post"])',
        'a:has(svg[aria-label="Criar"])',
        'a:has(svg[aria-label="Create"])',
        'button:has(svg[aria-label="Novo post"])',
        'button:has(svg[aria-label="New post"])',
        'button:has(svg[aria-label="Criar"])',
        'button:has(svg[aria-label="Create"])',
        '[role="button"]:has(svg[aria-label="Novo post"])',
        '[role="button"]:has(svg[aria-label="New post"])',
        '[role="button"]:has(svg[aria-label="Criar"])',
        '[role="button"]:has(svg[aria-label="Create"])',
        ':is(a,button,[role="button"]):has(svg[aria-label*="Neuer" i])',
        ':is(a,button,[role="button"]):has(svg[aria-label*="Erstellen" i])',
      ];
      const cssBtn = await findAny(page, candidates, 4000);
      if (cssBtn) {
        try {
          await cssBtn.click({ timeout: 5000 });
          return true;
        } catch { /* fallthrough */ }
        try {
          await cssBtn.click({ force: true, timeout: 3000 });
          return true;
        } catch { /* fallthrough */ }
      }

      // Estrategia 4: JS scoped no nav/sidebar — busca SVG aria-label que
      // contenha keywords e dispara sequencia real de eventos no clicavel pai.
      try {
        return await page.evaluate(() => {
          const RE = /post|criar|create|beitrag|erstellen|posten/i;
          const navs = Array.from(document.querySelectorAll('nav, [role="navigation"], aside'));
          const containers: Element[] = navs.length ? navs : [document.body];
          for (const root of containers) {
            const svgs = Array.from(root.querySelectorAll('svg[aria-label]'));
            for (const svg of svgs) {
              const label = svg.getAttribute('aria-label') || '';
              if (!RE.test(label)) continue;
              const target = svg.closest('a,button,[role="button"]') as HTMLElement | null;
              if (!target) continue;
              const r = target.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const x = r.x + r.width / 2;
              const y = r.y + r.height / 2;
              const opts: MouseEventInit = {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: 1,
              };
              try {
                target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
              } catch { /* PointerEvent indisponivel */ }
              target.dispatchEvent(new MouseEvent('click', opts));
              target.click();
              return true;
            }
          }
          return false;
        });
      } catch {
        return false;
      }
    };

    if (!(await clickCreateButton())) {
      // FIX 11: diagnostico enriquecido — lista SVGs visiveis com aria-labels
      // pra eu identificar o que IG esta mostrando nessas contas problematicas.
      const dbg = await captureDebug(page, 'create-no-plus');
      const svgList = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('svg[aria-label]')).map((s) => {
          const r = (s as SVGElement).getBoundingClientRect();
          return {
            label: s.getAttribute('aria-label'),
            visible: r.width > 0 && r.height > 0,
          };
        }).slice(0, 30);
      }).catch(() => [] as Array<{ label: string | null; visible: boolean }>);
      await appLog({
        source: 'driver',
        level: 'warn',
        message: `[create-no-plus] svgs visiveis: ${JSON.stringify(svgList)}`,
      });
      return { ok: false, reason: `create_button_not_found ${dbg.screenshot ?? ''}` };
    }
    await humanDelay(2000, 3000);

    // Step 1.5: Em alguns layouts (IG novo, perfil com extensao Inssist instalada,
    // etc) o "+" abre um submenu (Postar / Video ao vivo / Anuncio) em vez de abrir
    // direto o dialog de upload. Se for esse caso, clica "Postar" pra abrir o dialog.
    // Se "+" ja abriu o dialog direto, esse step e no-op (selector nao acha "Postar"
    // num timeout curto e segue).
    const dialogReady = await page
      .getByRole('dialog')
      .filter({ hasText: /Selecionar do computador|Select from computer|Vom Computer auswählen|Vom Computer auswahlen/i })
      .first()
      .isVisible({ timeout: 800 })
      .catch(() => false);
    if (!dialogReady) {
      try {
        await page
          .getByRole('link', { name: /^Postar$|^Post$|^Beitrag$|^Posten$/i })
          .or(page.getByRole('button', { name: /^Postar$|^Post$|^Beitrag$|^Posten$/i }))
          .first()
          .click({ timeout: 3000 });
        await humanDelay(1500, 2500);
      } catch {
        /* sem submenu — continua, Step 2 vai capturar se realmente quebrou */
      }
    }

    // Step 2: Modal "Criar novo post" → click "Selecionar do computador" + setFiles
    try {
      const dialogBtn = page
        .getByRole('dialog')
        .getByRole('button', { name: /Selecionar do computador|Select from computer|Vom Computer auswählen|Vom Computer auswahlen/i })
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
            const advanceBtn = btns.find((b) => /^(Avançar|Next|Weiter)$/i.test(b.textContent?.trim() || ''));
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

    // Helper: clica Avançar/Next com estrategia robusta.
    //
    // Descoberta confirmada via teste real (inspect-ig.mjs): no IG novo o botao
    // eh `<div role="button" aria-label="" class="...">Avançar</div>` —
    // aria-label VAZIO, role=button, text exato. NAO eh um <button> nativo.
    // `page.getByRole('button', { name: 'Avançar' })` cobre esse caso direto.
    //
    // Estrategias em ordem:
    //   1. getByRole (Playwright nativo, cobre IG novo + classico)
    //   2. findAny CSS selectors fallback (cobre versoes antigas)
    //   3. JS global search no DOM (incluindo Shadow DOM + iframes)
    //      com sequencia real de eventos (pointer + mouse + click)
    const clickAdvance = async (timeoutMs: number) => {
      // Estrategia 1: getByRole nativo do Playwright — pega `<button>` ou `[role="button"]`
      // com texto/aria-label "Avançar" ou "Next". Confirmado funcional via inspect-ig.mjs.
      try {
        const roleBtn = page.getByRole('button', { name: /^(Avançar|Next|Weiter)$/i }).first();
        if (await roleBtn.isVisible({ timeout: Math.min(timeoutMs, 3000) }).catch(() => false)) {
          try {
            await roleBtn.click({ timeout: 5000 });
            return true;
          } catch { /* tenta force */ }
          try {
            await roleBtn.click({ force: true, timeout: 3000 });
            return true;
          } catch { /* fallthrough */ }
        }
      } catch { /* fallthrough */ }

      // Estrategia 2: findAny CSS selectors (fallback pra versoes antigas) — PT/EN/DE
      const btn = await findAny(
        page,
        [
          'div[role="dialog"] [role="button"]:has-text("Avançar")',
          'div[role="dialog"] [role="button"]:has-text("Next")',
          'div[role="dialog"] [role="button"]:has-text("Weiter")',
          'div[role="dialog"] button:has-text("Avançar")',
          'div[role="dialog"] button:has-text("Next")',
          'div[role="dialog"] button:has-text("Weiter")',
          '[role="button"]:has-text("Avançar")',
          '[role="button"]:has-text("Next")',
          '[role="button"]:has-text("Weiter")',
          'button:has-text("Avançar")',
          'button:has-text("Next")',
          'button:has-text("Weiter")',
          'a:has-text("Avançar")',
          'a:has-text("Next")',
          'a:has-text("Weiter")',
        ],
        Math.min(timeoutMs, 4000)
      );

      // Estrategia 1+2+3: usa o btn encontrado pelo findAny, se houver
      if (btn) {
        try {
          await btn.click({ timeout: 5000 });
          return true;
        } catch { /* estrategia 2 */ }
        try {
          await btn.click({ force: true, timeout: 3000 });
          return true;
        } catch { /* estrategia 3 */ }
        try {
          await btn.evaluate((el: HTMLElement) => {
            const target = (el.closest('button,[role="button"],a') ?? el) as HTMLElement;
            target.click();
          });
          return true;
        } catch { /* fallthrough pra estrategia 4 */ }
      }

      // Estrategia 4: JS search SCOPED no dialog ativo (Codex audit #2: antes
      // varria DOM inteiro e podia clicar "Continue"/"Continuar" de popup
      // diferente). Agora escopa em div[role=dialog] ativo + remove labels
      // ambiguas (continuar/continue) — so avancar/next/proximo.
      try {
        const clickedGlobal = await page.evaluate(() => {
          const RE = /^\s*(avancar|avançar|next|proximo|próximo|weiter|vorwärts|vorwarts)\s*$/i;

          // Acha o dialog ativo (visivel) — preferencia pelo de "Criar novo post"
          // ou Editar; senao pega o primeiro visivel.
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
          const visibleDialogs = dialogs.filter((d) => {
            const r = (d as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (visibleDialogs.length === 0) return false;

          // Coleta elementos APENAS de dialogs visiveis (incluindo Shadow DOM
          // dentro do dialog, mas nao do resto da pagina).
          function collectAll(root: Element | ShadowRoot): Element[] {
            const result: Element[] = [];
            const all = root.querySelectorAll('*');
            for (const el of Array.from(all)) {
              result.push(el);
              const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
              if (sr) result.push(...collectAll(sr));
            }
            return result;
          }
          const elements: Element[] = [];
          for (const d of visibleDialogs) elements.push(...collectAll(d));

          // Procura primeiro elemento visivel cujo texto/aria-label case com regex
          for (const el of elements) {
            const r = (el as HTMLElement).getBoundingClientRect?.();
            if (!r || r.width === 0 || r.height === 0) continue;
            // Limpa zero-width spaces e NBSP do texto
            const txtRaw = el.textContent?.replace(/[​-‍﻿ ]/g, ' ') || '';
            const aria = (el.getAttribute('aria-label') || '');
            if (RE.test(txtRaw.trim()) || RE.test(aria.trim())) {
              const target = (el.closest('button,[role="button"],a') ?? el) as HTMLElement;
              // Estrategia 5: simular sequencia de eventos REAL (pointer + mouse + click)
              // pra cobrir componentes React que usam onPointerDown.
              const tr = target.getBoundingClientRect();
              const x = tr.x + tr.width / 2;
              const y = tr.y + tr.height / 2;
              const opts: MouseEventInit = {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: 1,
              };
              try {
                target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
              } catch { /* PointerEvent pode nao estar disponivel */ }
              target.dispatchEvent(new MouseEvent('click', opts));
              // Tambem chama .click() nativo como reforco
              target.click();
              return true;
            }
          }
          return false;
        });
        if (clickedGlobal) return true;
      } catch { /* falhou tudo */ }

      return false;
    };

    // Helper: na tela de Filtros do IG, clica em "Original" (filtro neutro).
    // Por que: IG entra na tela com algum filtro default selecionado (ex: Reyes)
    // com slider em 100, deixando a foto desbotada. Plus: enquanto IG aplica esse
    // filtro default em background, o botao "Avancar" pode ficar temporariamente
    // disabled, fazendo o bot travar. Clicar Original neutraliza o filtro E
    // sincroniza o IG antes do proximo Avancar.
    //
    // Se nao estamos na tela de Filtros (Original nao visivel), retorna false
    // sem efeito — no-op silencioso.
    const clickOriginalFilter = async (): Promise<boolean> => {
      try {
        return await page.evaluate(() => {
          // Busca elemento visivel com texto EXATO "Original" (filtro)
          const RE = /^\s*Original\s*$/;
          const all = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
          // Defesa: precisa ter pelo menos 2 outros nomes de filtro visiveis
          // pra confirmar que estamos na tela de Filtros (evita falso positivo
          // em outras telas que tenham texto "Original" em outro contexto).
          const FILTER_NAMES = ['Aden', 'Clarendon', 'Crema', 'Gingham', 'Juno', 'Lark', 'Ludwig', 'Moon', 'Perpetua', 'Reyes', 'Slumber'];
          let filterCount = 0;
          for (const el of all) {
            const r = (el as HTMLElement).getBoundingClientRect?.();
            if (!r || r.width === 0 || r.height === 0) continue;
            const txt = (el.textContent || '').trim();
            if (FILTER_NAMES.includes(txt)) filterCount++;
            if (filterCount >= 2) break;
          }
          if (filterCount < 2) return false; // nao estamos na tela de Filtros

          // Clica Original — APENAS se achou um ancestor button/role=button
          // legitimo (Codex audit #5: antes retornava true mesmo clicando em
          // span decorativo, marcava flag e nunca retentava).
          for (const el of all) {
            const r = (el as HTMLElement).getBoundingClientRect?.();
            if (!r || r.width === 0 || r.height === 0) continue;
            const txt = (el.textContent || '').trim();
            if (RE.test(txt)) {
              const ancestor = el.matches('button,[role="button"]')
                ? el
                : el.closest('button,[role="button"]');
              if (!ancestor) {
                // Sem ancestor clickable — nao confiavel. Pula esse match e
                // tenta o proximo elemento (caso haja varios "Original" no DOM).
                continue;
              }
              const target = ancestor as HTMLElement;
              const tr = target.getBoundingClientRect();
              const opts: MouseEventInit = {
                bubbles: true, cancelable: true, view: window,
                clientX: tr.x + tr.width / 2, clientY: tr.y + tr.height / 2,
                button: 0, buttons: 1,
              };
              try {
                target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
              } catch { /* PointerEvent indisponivel */ }
              target.dispatchEvent(new MouseEvent('click', opts));
              target.click();
              return true;
            }
          }
          return false;
        });
      } catch {
        return false;
      }
    };

    // Detecta se IG mostrou modal de erro do upload (ex: "Não foi possível
    // carregar o arquivo"). Confirmado via teste real: arquivos invalidos/pequenos
    // sao rejeitados pelo IG com modal cujo aria-label do dialog contem essa
    // mensagem. Sem detectar, bot fica preso esperando Avancar inexistente.
    const uploadErrorVisible = await page.evaluate(() => {
      // Codex audit #4: ler tambem textContent do dialog (nao so aria-label).
      // IG as vezes nao tem aria-label util, mas tem o texto na UI.
      const PHRASES = [
        'não foi possível carregar',
        'nao foi possivel carregar',
        "couldn't upload",
        'unable to upload',
        'error uploading',
      ];
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
      for (const d of dialogs) {
        const lbl = (d.getAttribute('aria-label') || '').toLowerCase();
        const txt = (d.textContent || '').toLowerCase();
        for (const p of PHRASES) {
          if (lbl.includes(p) || txt.includes(p)) {
            return lbl || txt.slice(0, 100);
          }
        }
      }
      return null;
    }).catch(() => null);
    if (uploadErrorVisible) {
      const dbg = await captureDebug(page, 'upload-rejected-by-ig');
      return {
        ok: false,
        reason: `upload_rejected_by_ig: "${uploadErrorVisible}" — arquivo provavelmente invalido (formato/size/codec). ${dbg.screenshot ?? ''}`,
      };
    }

    // Step 3-4: loop adaptativo de "Avancar". O IG tem fluxos diferentes:
    //   - Foto: Cortar -> Filtros -> Caption (2 cliques)
    //   - Video: Cortar -> Editar (cover/trim) -> Filtros -> Caption (3 cliques)
    //   - As vezes pula Filtros (1-2 cliques)
    // Em vez de fixed 2 cliques, loop ate detectar tela de Caption (campo
    // de legenda + botao Compartilhar visiveis simultaneamente — co-presenca
    // pra evitar false-positive em telas intermediarias). Max 5 tentativas.
    const captionSelectors =
      'div[contenteditable="true"][aria-label*="legenda" i],' +
      'div[contenteditable="true"][aria-label*="caption" i],' +
      'div[contenteditable="true"][aria-label*="bildunterschrift" i],' +
      'textarea[aria-label*="legenda" i],' +
      'textarea[aria-label*="caption" i],' +
      'textarea[aria-label*="bildunterschrift" i]';
    const shareTextSelector =
      'div[role="dialog"] :is(button, [role="button"], a, div):has-text("Compartilhar"),' +
      'div[role="dialog"] :is(button, [role="button"], a, div):has-text("Share"),' +
      'div[role="dialog"] :is(button, [role="button"], a, div):has-text("Publicar"),' +
      'div[role="dialog"] :is(button, [role="button"], a, div):has-text("Post"),' +
      'div[role="dialog"] :is(button, [role="button"], a, div):has-text("Teilen"),' +
      'div[role="dialog"] :is(button, [role="button"], a, div):has-text("Posten")';

    const isOnCaptionScreen = async () => {
      const captionField = await page
        .locator(captionSelectors)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!captionField) return false;
      const shareVisible = await page
        .locator(shareTextSelector)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      return shareVisible;
    };

    let advanceClicks = 0;
    let stuckAfterAdvance = false;
    let originalClickedThisJob = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      await dismissInfoModal(page);

      // Sai do loop quando chegou na tela de Caption (caption + share visiveis)
      if (await isOnCaptionScreen()) break;

      // Se estamos na tela de Filtros, clica "Original" UMA UNICA vez por job.
      // Bug anterior: clickOriginalFilter rodava a cada iteracao, e se o IG
      // resetasse pra Reyes (filtro default), o bot ficava num loop visivel
      // de "fantasma click" disputando com o usuario.
      if (!originalClickedThisJob) {
        const clickedOriginal = await clickOriginalFilter();
        if (clickedOriginal) {
          originalClickedThisJob = true;
          await appLog({
            source: 'driver',
            level: 'info',
            message: `[real] filtro "Original" aplicado pra desfazer filtro default do IG`,
          });
          await humanDelay(1500, 2500); // tempo pra IG aplicar
        }
      }

      const ok = await clickAdvance(attempt === 0 ? 12_000 : 6_000);
      if (!ok) {
        // Tenta fechar modal e clicar de novo
        await dismissInfoModal(page);
        if (!(await clickAdvance(4_000))) {
          // Nao achou Avancar mesmo apos 4 estrategias e retry — captura
          // estado atual pra investigar e falha (so se for o 1o click;
          // senao deixa Step 5/6 tentarem).
          if (advanceClicks === 0) {
            const dbg = await captureDebug(page, 'no-advance-1-all-strategies-failed');
            return { ok: false, reason: `no_advance_after_upload ${dbg.screenshot ?? ''}` };
          }
          stuckAfterAdvance = true;
          break;
        }
      }
      advanceClicks++;
      await humanDelay(2500, 4000);
    }

    // Se loop fez progresso mas nao chegou em caption, captura debug pra
    // investigar (sem falhar — Step 5/6 ainda tentam).
    if ((stuckAfterAdvance || advanceClicks >= 5) && !(await isOnCaptionScreen())) {
      void captureDebug(page, 'stuck-after-advance').catch(() => undefined);
    }

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

    // Step 6: Click "Compartilhar" (com fallbacks pra IG trocar label).
    // Cobre 4 labels (PT/EN: Compartilhar, Share, Publicar, Post) em 4
    // tipos de elemento (button, [role=button], <a>, <div> folha).
    const shareSelectors = [
      // [role=button] (mais comum no IG novo)
      'div[role="dialog"] [role="button"]:has-text("Compartilhar")',
      'div[role="dialog"] [role="button"]:has-text("Share")',
      'div[role="dialog"] [role="button"]:has-text("Publicar")',
      'div[role="dialog"] [role="button"]:has-text("Post")',
      'div[role="dialog"] [role="button"]:has-text("Teilen")',
      'div[role="dialog"] [role="button"]:has-text("Posten")',
      // <button> nativo
      'div[role="dialog"] button:has-text("Compartilhar")',
      'div[role="dialog"] button:has-text("Share")',
      'div[role="dialog"] button:has-text("Publicar")',
      'div[role="dialog"] button:has-text("Post")',
      'div[role="dialog"] button:has-text("Teilen")',
      'div[role="dialog"] button:has-text("Posten")',
      // <a> (algumas versoes)
      'div[role="dialog"] a:has-text("Compartilhar")',
      'div[role="dialog"] a:has-text("Share")',
      'div[role="dialog"] a:has-text("Publicar")',
      'div[role="dialog"] a:has-text("Post")',
      'div[role="dialog"] a:has-text("Teilen")',
      'div[role="dialog"] a:has-text("Posten")',
      // <div> folha (sem filhos) — fallback de elemento generico clickable
      'div[role="dialog"] div:has-text("Compartilhar"):not(:has(*))',
      'div[role="dialog"] div:has-text("Share"):not(:has(*))',
      'div[role="dialog"] div:has-text("Publicar"):not(:has(*))',
      'div[role="dialog"] div:has-text("Post"):not(:has(*))',
      'div[role="dialog"] div:has-text("Teilen"):not(:has(*))',
      'div[role="dialog"] div:has-text("Posten"):not(:has(*))',
    ];

    // Auto-recovery: se Step 6 nao achar Compartilhar, eh provavel que
    // ainda esta numa tela intermediaria (Filtros/Editar). Tenta mais 1
    // Avancar e re-tenta. So 1 retry pra nao loop infinito.
    let shareBtn = await findAny(page, shareSelectors, 8000);
    if (!shareBtn) {
      await dismissInfoModal(page);
      await clickAdvance(4000);
      await humanDelay(2000, 3000);
      shareBtn = await findAny(page, shareSelectors, 6000);
    }

    // Helper de click multi-estrategia (mesmo padrao do clickAdvance):
    // 1. Click normal -> 2. Force -> 3. JS evaluate no btn ->
    // 4. JS GLOBAL search com sequencia de eventos real (pointer + mouse + click).
    const clickShareMultiStrategy = async (): Promise<boolean> => {
      if (shareBtn) {
        try {
          await shareBtn.click({ timeout: 10000 });
          return true;
        } catch { /* estrategia 2 */ }
        try {
          await shareBtn.click({ force: true, timeout: 5000 });
          return true;
        } catch { /* estrategia 3 */ }
        try {
          await shareBtn.evaluate((el: HTMLElement) => {
            const target = (el.closest('button,[role="button"],a') ?? el) as HTMLElement;
            target.click();
          });
          return true;
        } catch { /* estrategia 4 */ }
      }

      // Estrategia 4: JS global search no DOM (incluindo Shadow DOM e iframes
      // mesmo-origem) com regex Compartilhar/Share/Publicar/Post/Enviar +
      // sequencia real de eventos (pointer + mouse + click).
      try {
        return await page.evaluate(() => {
          // SCOPED no dialog ativo (Codex audit #3: antes varria DOM inteiro
          // e podia clicar Post/Share fora do composer — ex: nav, popup, etc).
          // PT/EN/DE: compartilhar|share|publicar|post|enviar|teilen|posten
          const RE = /^\s*(compartilhar|share|publicar|post|enviar|teilen|posten)\s*$/i;
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
          const visibleDialogs = dialogs.filter((d) => {
            const r = (d as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (visibleDialogs.length === 0) return false;

          function collectAll(root: Element | ShadowRoot): Element[] {
            const result: Element[] = [];
            for (const el of Array.from(root.querySelectorAll('*'))) {
              result.push(el);
              const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
              if (sr) result.push(...collectAll(sr));
            }
            return result;
          }
          const elements: Element[] = [];
          for (const d of visibleDialogs) elements.push(...collectAll(d));
          for (const el of elements) {
            const r = (el as HTMLElement).getBoundingClientRect?.();
            if (!r || r.width === 0 || r.height === 0) continue;
            const txt = (el.textContent || '').replace(/[​-‍﻿ ]/g, ' ').trim();
            const aria = (el.getAttribute('aria-label') || '').trim();
            if (RE.test(txt) || RE.test(aria)) {
              const target = (el.closest('button,[role="button"],a') ?? el) as HTMLElement;
              const tr = target.getBoundingClientRect();
              const x = tr.x + tr.width / 2;
              const y = tr.y + tr.height / 2;
              const opts: MouseEventInit = {
                bubbles: true, cancelable: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: 1,
              };
              try {
                target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
              } catch { /* PointerEvent indisponivel */ }
              target.dispatchEvent(new MouseEvent('click', opts));
              target.click();
              return true;
            }
          }
          return false;
        });
      } catch {
        return false;
      }
    };

    // FIX 9 (Codex P2 #2): capturar beforeShareUrl ANTES do click, nao depois.
    // Antes era capturado apos clickShareMultiStrategy + 2x dismissInfoModal,
    // e nesse meio tempo o IG ja podia ter saido de /create/, fazendo o gate
    // wasOnCreate falhar mesmo em sucesso legitimo.
    const beforeShareUrl = page.url();

    if (!(await clickShareMultiStrategy())) {
      const dbg = await captureDebug(page, 'no-share-btn');
      return { ok: false, reason: `share_button_not_found ${dbg.screenshot ?? ''}` };
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
    // CRITICO — fallback negativo REMOVIDO (bug do Gustavo: 7/31 "done"
    // mas IG so com 2 posts reais). Agora trabalha com 3 estados em vez de 2:
    //
    //   SUCCESS (positivo final → confirmed = true):
    //     1. Dialog aria-label "Post compartilhado" / "Post shared"
    //        ou texto "Seu post foi compartilhado" / "your post has been shared"
    //     2. URL mudou pra /p/<id>, /reel/<id> ou /reels/<id>
    //
    //   IN_PROGRESS (IG ainda processando → reseta o timeout, espera mais):
    //     3. Dialog aria-label "Sharing" / "Compartilhando" / "Publicando" / "Posting"
    //        COM spinner visivel dentro
    //
    //   TIMEOUT (nada visto na janela → confirmed = false → share_unconfirmed):
    //     - Sem sinal POSITIVO nem PROGRESSO em 90s (video) / 30s (foto) corridos
    //     - Teto absoluto: 5min (video) / 1.5min (foto) pra evitar travar worker
    //
    // Por que importa o IN_PROGRESS: bug original (DYIO61gDNpQ etc) tinha
    // o IG mostrando dialog "Sharing" com spinner aos 90s, ainda processando
    // o upload. O bot dava timeout e marcava falha mesmo o post podendo
    // completar 30-60s depois. Agora reseta o timer enquanto vê progresso.
    // (beforeShareUrl ja capturado ANTES do click — FIX 9 Codex P2 #2)
    // PROGRESS_RESET_MS: janela sem nenhum sinal antes de marcar timeout.
    // Se durante essa janela a gente ver dialog "Sharing"/"Compartilhando"
    // (IG processando upload), reseta o timer e espera mais uma janela.
    // HARD_CEILING_MS: teto absoluto pra nao travar o worker eternamente.
    // Vidoes >5min ou fotos >1.5min muito provavelmente sao IG com problema
    // serio - o retry posterior decide.
    const PROGRESS_RESET_MS = isVideo ? 90_000 : 30_000;
    const HARD_CEILING_MS = isVideo ? 300_000 : 90_000;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let confirmed = false;
    let lastSignal: string | null = null;
    let pageClosed = false;
    // FIX 8: snippet do erro do IG quando SINAL 4 detecta toast/modal de falha.
    // Permite bailtar em segundos com reason ig_share_error em vez de esperar
    // o teto de 5min (HARD_CEILING_MS) com share_unconfirmed.
    let igErrorDetail: string | null = null;

    while (Date.now() - startedAt < HARD_CEILING_MS) {
      const elapsedSinceProgress = Date.now() - lastProgressAt;
      const remainingMs = Math.max(1000, PROGRESS_RESET_MS - elapsedSinceProgress);
      let handle: Awaited<ReturnType<Page['waitForFunction']>> | null = null;
      try {
        handle = await page.waitForFunction(
          (urlBefore: string) => {
            // SINAL 1 (success): dialog "Post compartilhado" / "Post shared" visivel
            // PT/EN/DE
            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
            const successDialog = dialogs.find((d) => {
              const lbl = (d.getAttribute('aria-label') || '').toLowerCase();
              const txt = (d.textContent || '').toLowerCase();
              return (
                lbl.includes('post compartilhado') ||
                lbl.includes('post shared') ||
                lbl.includes('publicação compartilhada') ||
                lbl.includes('beitrag geteilt') ||
                lbl.includes('post geteilt') ||
                txt.includes('seu post foi compartilhado') ||
                txt.includes('your post has been shared') ||
                txt.includes('sua publicação foi compartilhada') ||
                txt.includes('dein beitrag wurde geteilt') ||
                txt.includes('dein post wurde geteilt')
              );
            });
            if (successDialog) return 'success_dialog';

            // SINAL 2 (success): URL mudou pra um post (IG redireciona apos publicar)
            //
            // FIX 9: regex original /\/(p|reel|reels)\// matchava /reels/ (feed
            // home) sem requirir ID — IG redireciona pra /reels/ as vezes em
            // falha, e bot marcava como sucesso sem post real. Causou regressao
            // em 12/05/2026 com 5 contas marcando "done" sem nenhum post.
            //
            // Codex P1: regex revisada nao bastava — /reels/explore/ ainda
            // matchava porque "explore" eh alfanumerico. Solucao definitiva:
            // parse URL real, exigir pathname ESTRITO /p|reel|reels/<id>/
            // sem nada depois, com blacklist de palavras conhecidas.
            //
            // Regra:
            //   1. URL mudou de antes do share
            //   2. pathname casa exato /^\/(p|reel|reels)\/<id>\/?$/ (sem
            //      sub-paths como /audio/, /explore/ depois)
            //   3. id NAO eh palavra IG conhecida (explore, audio, feed, etc)
            //   4. urlBefore tava em /create/ — confirma transicao de criacao
            const url = location.href;
            if (url !== urlBefore) {
              let isPostPage = false;
              try {
                const u = new URL(url);
                const m = u.pathname.match(/^\/(p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/);
                if (m) {
                  const idLower = m[2].toLowerCase();
                  const excluded = ['explore', 'audio', 'feed', 'hide', 'trending', 'tagged', 'reels'];
                  isPostPage = !excluded.includes(idLower);
                }
              } catch {
                /* URL invalida — mantem isPostPage = false */
              }
              const wasOnCreate = /\/create\//.test(urlBefore);
              if (isPostPage && wasOnCreate) return 'success_url';
            }

            // SINAL 3 (in_progress): dialog "Sharing"/"Compartilhando" com spinner.
            // IG ainda esta processando o upload server-side. NAO eh sucesso nem
            // falha - significa "ainda esta tentando, espera mais".
            //
            // Selectors tolerantes (Codex P2): IG pode usar variantes como
            // "Sharing", "Sharing...", "Sharing post", "Compartilhando…".
            // Por isso: \b apos a palavra (cobre fim de string, espaço, pontuação)
            // em vez de === exato.
            // PT/EN/DE: sharing|compartilhando|publicando|posting|wird geteilt|wird gepostet
            const SHARING_RE = /^(sharing|compartilhando|publicando|posting|wird (geteilt|gepostet))\b/;
            // FIX 10 (12/05/2026): gate hasSpinner removido. Bug detectado por
            // evidencia direta — IG mostrava dialog "Compartilhando" com spinner
            // SVG animado SEM aria-label "loading" SEM alt="Spinner" SEM
            // role=progressbar (animacao puramente CSS de stroke-dasharray na
            // SVG do brand IG). Resultado: post real ia pro ar (1 post no perfil
            // confirmado pelo user), mas bot nunca via in_progress, timeoutava
            // em 90s e marcava failed → retry → potencial duplicata.
            //
            // Trust no title: dialog visivel em div[role="dialog"] com label/title
            // comecando em "compartilhando|sharing|publicando|posting|wird
            // (geteilt|gepostet)" eh sinal forte de share em andamento. Risco
            // de false positive eh baixissimo — qualquer dialog informativo com
            // esse titulo ja foi limpado pelo dismissInfoModal (Step 6.5) antes
            // do Step 7 comecar. Pior caso de false positive: bot espera ate
            // HARD_CEILING_MS (5min) em vez de timeoutar em 90s. Aceitavel
            // contra o bug original de marcar failed em quase todo post.
            const progressDialog = dialogs.find((d) => {
              const r = (d as HTMLElement).getBoundingClientRect?.();
              if (!r || r.width === 0 || r.height === 0) return false;
              const lbl = (d.getAttribute('aria-label') || '').trim().toLowerCase();
              const txt = (d.textContent || '').trim().toLowerCase().slice(0, 60);
              return SHARING_RE.test(lbl) || SHARING_RE.test(txt);
            });
            if (progressDialog) return 'in_progress';

            // SINAL 4 (error_toast): IG mostrou erro explicito apos click em
            // Compartilhar (ex: "Algo deu errado tente novamente"). Sem isso,
            // o bot espera 5min/1.5min ate share_unconfirmed; com isso, bailta
            // em segundos com reason ig_share_error e o texto do erro.
            // PT/EN/DE.
            //
            // Ordem importa: vem DEPOIS de success_dialog/success_url/in_progress.
            // Se IG mostrar erro E sucesso simultaneamente (improvavel), sucesso
            // ganha. Se mostrar erro DURANTE o "Sharing", in_progress ganha por
            // 1 ciclo, depois progressDialog some e error_toast pega.
            const ERROR_RE = /algo deu errado|n[ãa]o foi poss[ií]vel (compartilhar|publicar)|problema(s)? para (compartilhar|publicar)|something went wrong|couldn'?t (share|post)|please try again|etwas ist schiefgelaufen|konnte nicht (geteilt|gepostet) werden|erneut versuchen/i;
            const errorContainers = Array.from(document.querySelectorAll(
              'div[role="alert"], div[role="status"], [data-testid*="toast" i], [data-testid*="snack" i], div[role="dialog"]'
            ));
            const errorEl = errorContainers.find((el) => {
              const r = (el as HTMLElement).getBoundingClientRect?.();
              if (!r || r.width === 0 || r.height === 0) return false;
              const txt = (el.textContent || '').slice(0, 200);
              return ERROR_RE.test(txt);
            });
            if (errorEl) {
              const snippet = (errorEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
              return 'error_toast:' + snippet;
            }

            return false;
          },
          beforeShareUrl,
          { timeout: remainingMs, polling: 1000 }
        );
        // Codex P1 (re-review): nao usar .catch(() => null) silencioso aqui.
        // Se a pagina fechou entre o waitForFunction resolver e o jsonValue,
        // precisamos detectar e marcar pageClosed (em vez de mascarar como
        // share_unconfirmed).
        let value: string | null = null;
        try {
          value = (await handle.jsonValue()) as string | null;
        } catch {
          if (page.isClosed()) {
            pageClosed = true;
            break;
          }
          // jsonValue falhou mas page ainda existe: trata como sinal nulo
          // (provavelmente o handle foi descartado por outro motivo).
          value = null;
        }
        lastSignal = value;
        if (value === 'success_dialog' || value === 'success_url') {
          confirmed = true;
          break;
        }
        if (value === 'in_progress') {
          // IG ainda processando — reseta janela e da mais tempo
          lastProgressAt = Date.now();
          await humanDelay(2000, 4000);
          continue;
        }
        if (typeof value === 'string' && value.startsWith('error_toast:')) {
          // FIX 8: IG mostrou erro explicito — bailta sem esperar mais.
          // Codex P2: gate de 5s pra evitar bailtar em toast residual (ex:
          // toast de "upload demorando" que sobrou da fase anterior). Posts
          // legitimos que falham levam pelo menos 2-5s pra IG mostrar erro,
          // entao gate de 5s nao atrapalha caso real.
          if (Date.now() - startedAt < 5000) {
            // Reseta progressAt pra nao desistir prematuro se acabar sendo
            // toast persistente; revisita no proximo ciclo de polling.
            lastProgressAt = Date.now();
            await humanDelay(1500, 2500);
            continue;
          }
          // Salva o snippet pra usar como reason apos sair do loop.
          igErrorDetail = value.slice('error_toast:'.length);
          break;
        }
        // Sinal desconhecido (não deveria acontecer): trata como timeout
        break;
      } catch {
        // Timeout OU page closed/disconnected. Codex P1: distinguir os dois,
        // page closed nao eh share_unconfirmed (nao tem como o post ter dado
        // certo se a aba sumiu — eh erro de infra do AdsPower/Playwright).
        if (page.isClosed()) {
          pageClosed = true;
        }
        // Em qualquer caso, sai do loop. confirmed continua false.
        break;
      } finally {
        // Codex P1: descartar JSHandle pra evitar leak no isolated world
        // do Playwright (mesmo com catch, o handle pode ter sido criado).
        if (handle) {
          await handle.dispose().catch(() => undefined);
        }
      }
    }

    // FIX 12 (12/05/2026): se bailou por timeout com last=in_progress, IG estava
    // processando mas nao confirmou via dialog/URL. Verifica diretamente no perfil
    // se um post novo apareceu — IG as vezes completa o share mas nao mostra
    // confirmacao visual nem redireciona.
    //
    // Cenario que provocou o fix: job cmp33qoku0001yc4sc0yqgeop bailou em 332s
    // (last=in_progress) e foi marcado falha. Nao sabemos se post foi pro ar ou nao.
    // Com essa verificacao, se post foi pro ar, marcamos done e evitamos retry +
    // duplicata.
    if (
      !confirmed &&
      !pageClosed &&
      !igErrorDetail &&
      lastSignal === 'in_progress' &&
      args.igUsername
    ) {
      const afterLatestPostUrl = await getLatestPostUrl(page, args.igUsername);
      const newPostDetected = afterLatestPostUrl && afterLatestPostUrl !== beforeLatestPostUrl;
      await appLog({
        source: 'worker',
        level: 'info',
        message:
          `[fix12-verify] @${args.igUsername} timeout com in_progress — ` +
          `before=${beforeLatestPostUrl ?? 'null'} after=${afterLatestPostUrl ?? 'null'} ` +
          `newPost=${newPostDetected ? 'YES' : 'NO'}`,
      }).catch(() => undefined);
      if (newPostDetected) {
        confirmed = true;
        lastSignal = 'profile_verified';
      }
    }

    if (confirmed) {
      // FIX 9 (Codex P2 #3): captura RAPIDA do estado pre-Done (URL + dialogs)
      // antes de clicar Done — dialog de sucesso pode sumir apos o click. O
      // page.evaluate aqui eh ~100-200ms, ok pra nao atrasar o Done click.
      // O captureDebug + appLog (mais lentos) acontecem DEPOIS do Done click.
      const auditInfo = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        const visible = dialogs.filter((d) => {
          const r = (d as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        return {
          url: location.href,
          dialogCount: visible.length,
          dialogTexts: visible.map((d) => ({
            aria: (d.getAttribute('aria-label') || '').slice(0, 80),
            text: (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          })),
        };
      }).catch(() => ({ url: 'evaluate_failed', dialogCount: 0, dialogTexts: [] as Array<{aria: string; text: string}> }));

      // Apos confirmar, tenta clicar "Concluir" / "Done" pra fechar o
      // dialog de sucesso (limpa estado pro proximo job).
      await page.evaluate(() => {
        const RE = /^(Concluir|Concluído|Done|OK|Ok|Pronto|Fertig|Schließen)$/i;
        const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const el of all) {
          const r = (el as HTMLElement).getBoundingClientRect?.();
          if (!r || r.width === 0 || r.height === 0) continue;
          const txt = (el.textContent || '').trim();
          if (RE.test(txt)) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }).catch(() => undefined);
      await humanDelay(800, 1500);

      // FIX 9: parte LENTA do audit (captureDebug + appLog) — depois do Done
      // click pra nao atrasar a UX do click. auditInfo ja tem URL e dialog
      // text capturados ANTES do Done click. Try/catch swallow eh aceitavel
      // porque a decisao de "done" ja esta tomada nesse ponto.
      try {
        const auditTag = `done-audit-${Date.now()}`;
        const dbg = await captureDebug(page, auditTag);
        await appLog({
          source: 'worker',
          level: 'info',
          message:
            `[done-audit] signal=${lastSignal} url=${auditInfo.url} ` +
            `dialogs=${auditInfo.dialogCount} ` +
            `texts=${JSON.stringify(auditInfo.dialogTexts)} ` +
            `screenshot=${dbg.screenshot ?? 'none'}`,
        });
      } catch (err) {
        // nit do Codex: log warn em vez de swallow silente
        await appLog({
          source: 'worker',
          level: 'warn',
          message: `[done-audit] falha ao gravar audit: ${err instanceof Error ? err.message : 'unknown'}`,
        }).catch(() => undefined);
      }
    }

    if (!confirmed) {
      // Codex P1: distinguir page_closed de share_unconfirmed.
      // Page closed = aba sumiu durante o wait (AdsPower fechou, Playwright
      // perdeu conexao, navegador crashou). Nao tem como o post ter saido
      // — eh problema de infra, nao de IG processando devagar.
      if (pageClosed) {
        return {
          ok: false,
          reason: `page_closed_during_share elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
        };
      }
      // FIX 8: IG mostrou erro explicito (toast/modal "Algo deu errado", etc).
      // Bailtamos cedo com reason ig_share_error em vez de share_unconfirmed
      // (que sugere timeout). User no painel ve o texto do erro do proprio IG.
      if (igErrorDetail) {
        const dbg = await captureDebug(page, 'ig-share-error');
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        return {
          ok: false,
          reason: `ig_share_error: ${igErrorDetail} elapsed=${elapsed}s ${dbg.screenshot ?? ''}`.trim(),
        };
      }
      const dbg = await captureDebug(page, 'share-unconfirmed');
      // Inclui o ultimo sinal observado pra ajudar diagnostico:
      // - "in_progress": IG estava processando mas estourou o teto de 5min
      // - "null" / outro: timeout puro, nem progresso o bot viu
      const detail = lastSignal ? ` last=${lastSignal}` : '';
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      return {
        ok: false,
        reason: `share_unconfirmed${detail} elapsed=${elapsed}s ${dbg.screenshot ?? ''}`.trim(),
      };
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
      const prev = sessions.get(adsPowerId);
      if (prev) {
        // FIX 13 (13/05/2026): se KEEP_PROFILES_OPEN ativo, testa healthcheck
        // e REUSA sessao em vez de close+reopen. Antes desse fix,
        // KEEP_PROFILES_OPEN era meaningless: processor pulava o close no fim
        // do job, mas openProfile no inicio do proximo job sempre matava
        // tudo (closeSession + adsPowerClient.stopBrowser). Resultado:
        // bot sempre abria/fechava AdsPower entre jobs mesmo com a flag ativa.
        if (env.KEEP_PROFILES_OPEN) {
          // Codex P1: healthcheck com timeout explicito. Sem isso, se CDP
          // entrar em estado half-dead (nao desconectado mas hang), evaluate
          // poderia segurar o withProfileLock indefinidamente, bloqueando
          // openProfile/closeProfile futuros pra esse perfil.
          let healthy = false;
          try {
            await Promise.race([
              prev.page.evaluate(() => 1),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('healthcheck_timeout')), 3000)
              ),
            ]);
            healthy = true;
          } catch {
            // Codex P2: catch escopado SO no evaluate/timeout. appLog separado
            // abaixo com seu proprio .catch — log nao deve afetar a decisao
            // de reuso vs cleanup.
            healthy = false;
          }
          if (healthy) {
            await appLog({
              source: 'driver',
              level: 'info',
              message: `[real] perfil ${adsPowerId} REUSADO (KEEP_PROFILES_OPEN)`,
            }).catch(() => undefined);
            return { ok: true };
          }
          // Sessao stale (CDP caiu OU healthcheck timeoutou) — segue pro
          // path de cleanup+reopen abaixo pra recriar fresh.
        }
        // Cleanup previo (sob o mesmo lock — sem race com outras chamadas).
        // Path tomado quando: KEEP_PROFILES_OPEN=false (default), OU sessao
        // stale, OU healthcheck falhou.
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

      // AdsPower retorna o ws endpoint mas as vezes o servidor WebSocket
      // ainda esta inicializando. Da uma folga antes de conectar pra
      // evitar timeout em "ws connecting". Sem isso, com 8 perfis abrindo
      // em paralelo, alguns dao Timeout 30000ms exceeded.
      await new Promise((r) => setTimeout(r, 1500));

      // Retry de connectOverCDP com timeout maior — ws pode estar lento
      // se hardware sobrecarregado (8+ perfis paralelos).
      let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        try {
          browser = await chromium.connectOverCDP(wsEndpoint, {
            slowMo: env.PLAYWRIGHT_SLOW_MO_MS || undefined,
            timeout: 60_000, // 60s (era 30s default)
          });
          break;
        } catch (e) {
          lastErr = e;
          if (i < 2) {
            await new Promise((r) => setTimeout(r, 2000 * (i + 1))); // backoff 2s, 4s
          }
        }
      }
      if (!browser) {
        const msg = lastErr instanceof Error ? lastErr.message : 'unknown';
        await appLog({
          source: 'driver',
          level: 'error',
          message: `[real] connectOverCDP falhou apos 3 tentativas: ${msg}`,
        });
        await adsPowerClient.stopBrowser(adsPowerId).catch(() => undefined);
        return { ok: false, reason: `cdp_connect_timeout: ${msg}` };
      }

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

      // Tela de consentimento LGPD/Meta (1ª etapa) — PT/EN/DE
      try {
        await page
          .getByRole('button', { name: /Começar|Get started|Continue|Loslegen|Weiter/i })
          .first()
          .click({ timeout: 3000 });
        await humanDelay(800, 1500);
      } catch {
        /* sem consent */
      }

      // Tela de cookies/permitir — PT/EN/DE
      try {
        await page
          .getByRole('button', {
            name: /Permitir todos|Allow all|Aceitar|Accept|Concordar|Agree|Alle akzeptieren|Akzeptieren|Zustimmen/i,
          })
          .first()
          .click({ timeout: 2000 });
        await humanDelay();
      } catch {
        /* sem cookies */
      }

      // Pop-ups de salvar info / notificações ("Agora não" / "Not now" / "Jetzt nicht")
      for (let i = 0; i < 2; i++) {
        try {
          await page
            .getByRole('button', { name: /^Agora não$|^Not now$|^Jetzt nicht$/i })
            .first()
            .click({ timeout: 2000 });
          await humanDelay();
        } catch {
          break;
        }
      }

      // Detecta CHECKPOINT do IG (CAPTCHA / "Confirme que voce eh humano").
      // Detectado por URL (/challenge/, /auth_platform/) OU texto na pagina
      // em PT/EN/DE. Lanca erro especifico account_in_checkpoint pro processor
      // pausar a conta sem queimar 2 retries (cada retry = 10-20min perdidos).
      const checkpointInfo = await detectCheckpoint(page);
      if (checkpointInfo) {
        await captureDebug(page, `checkpoint-${igUsername}`);
        throw new Error(`account_in_checkpoint:${checkpointInfo}`);
      }

      // Detecta tela de login (campos username/password) — selectors PT/EN/DE
      const loginField = await findAny(
        page,
        [
          'input[name="username"]',
          'input[aria-label*="Telefone" i]',
          'input[aria-label*="username" i]',
          'input[aria-label*="Benutzername" i]',
          'input[aria-label*="Mobilnummer" i]',
        ],
        2000
      );
      if (loginField) {
        await captureDebug(page, `login-needed-${igUsername}`);
        return false;
      }

      // Confirma logado pelo svg "Página inicial" no sidebar — PT/EN/DE
      const home = await findAny(
        page,
        [
          'svg[aria-label="Página inicial"]',
          'svg[aria-label="Home"]',
          'svg[aria-label="Início"]',
          'svg[aria-label="Startseite"]',
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
      // Re-throw checkpoint sem captureDebug duplicado (ja capturou la em cima)
      // Codex P2-2: usa ":" pra match exato do prefixo, evita colisao com erros futuros
      if (err instanceof Error && err.message.startsWith('account_in_checkpoint:')) {
        throw err;
      }
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
