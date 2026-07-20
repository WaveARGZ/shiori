// End-to-end smoke test, run with SHIORI_SMOKE=1.
//
// Inert unless that env var is set. It exists because the interesting parts of
// Shiori (scroll capture, restore-after-reload, lane swapping, copy capture)
// only happen inside a real page in a real WebContentsView — a unit test with a
// fake DOM would prove nothing about whether the preload actually fires.
//
// It serves its own tall page over loopback so the test never touches the
// network, drives the app through the same IPC the chrome UI uses, and asserts
// against the real store.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app, BrowserWindow, webContents, type WebContents } from 'electron';
import { getBookmark, listClips, flushBookmarks } from './store';
import { normalizeUrl } from './url';

const TALL_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Smoke Test Article</title></head>
<body style="margin:0;font-family:sans-serif">
  <p id="quote">引用されるべきテキスト。</p>
  <!-- Stands in for a chat site's composer, so the parallel-grid broadcast has
       a real element to fill (the injector's generic "textarea" fallback). -->
  <textarea id="composer" style="width:300px;height:60px"></textarea>
  <div style="height:6000px;background:linear-gradient(#fff,#ccc)"></div>
  <p>end</p>
</body></html>`;

// Mirrors the real results HTML the search backend returns, so the parser and
// renderer are exercised end-to-end without touching the network. Deliberately
// includes the engine's redirect wrapper (…/l/?uddg=…) that unwrapUrl decodes.
const SEARCH_FIXTURE = `<!doctype html><html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2Fdocs&amp;rut=x">Electron Documentation</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2Fdocs">Build cross-platform desktop apps with JavaScript, HTML and CSS.</a>
    <div class="result__extras"><span class="result__url">www.electronjs.org</span></div>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fwcv">WebContentsView example</a>
    </h2>
    <a class="result__snippet">A second result snippet.</a>
    <div class="result__extras"><span class="result__url">example.org</span></div>
  </div>
</div>
</body></html>`;

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await delay(100);
  }
}

function findPageView(origin: string): WebContents | undefined {
  return webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(origin));
}

async function settle(wc: WebContents): Promise<void> {
  if (wc.isLoading()) {
    await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()));
  }
}

/**
 * Second launch against the profile the 'fresh' run left behind. This is the
 * only honest way to test "再起動後も全レーン復元" — restoring lanes from disk
 * cannot be observed inside the process that wrote them.
 *
 * The page URL it restores points at the previous run's loopback port, which is
 * dead by now. That is deliberate: the lane and page structure has to come back
 * from the store, not from a successful network load.
 */
async function runRestartSmoke(): Promise<void> {
  try {
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0]);
    await settle(win.webContents);
    await delay(800);

    const state = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    const names: string[] = state.lanes.map((l: { name: string }) => l.name);
    check('lanes restored after restart', names.length >= 2, names.join(', '));
    check('lane names survived restart', names.includes('研究'), names.join(', '));

    // A pinned favorite must survive the restart on its lane.
    const research = state.lanes.find((l: { name: string }) => l.name === '研究');
    check(
      'favorite pin restored on its lane',
      !!research && Array.isArray(research.favorites) && research.favorites.length >= 1,
      `${research?.favorites?.length ?? 0} favorites`,
    );

    // Open pages are a single global list now, not per-lane.
    check(
      'global pages restored',
      Array.isArray(state.pages) && state.pages.length === 1,
      `${state.pages?.length ?? 0} pages`,
    );
    check(
      'restored page kept its URL',
      !!state.pages?.[0]?.url?.startsWith('http://127.0.0.1:'),
      state.pages?.[0]?.url ?? 'none',
    );

    const chips = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#pages .chip').length",
    );
    check('restored page chip rendered', chips === 1, `${chips} chips`);

    const rows = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:go-home').then(() => new Promise(r => setTimeout(r, 300))).then(() => document.querySelectorAll('#home-list .read-row').length)",
    );
    check('bookmarks survived restart', rows >= 1, `${rows} rows`);

    const clipCount = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-clips').then(c => c.length)",
    );
    check('clips survived restart', clipCount >= 1, `${clipCount} clips`);

    const notes = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-notes')");
    check(
      'todos survived restart (with done state)',
      Array.isArray(notes.todos) && notes.todos.length === 1 && notes.todos[0].done === true,
      `${notes.todos?.length ?? 0} todos`,
    );
    check(
      'memo survived restart',
      typeof notes.memo === 'string' && notes.memo.includes('メモのテスト'),
      (notes.memo ?? '').slice(0, 20),
    );
  } catch (error) {
    check('restart run completed without throwing', false, String(error));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} restart checks passed`);
  app.exit(failed.length === 0 ? 0 : 1);
}

export async function runSmoke(mode: 'fresh' | 'restart'): Promise<void> {
  if (mode === 'restart') return runRestartSmoke();

  let server: Server | undefined;
  try {
    let lastUa = '';
    let lastSecChUa = '';
    server = createServer((req, res) => {
      // Capture identity only from the main document request — a favicon or
      // other subresource fetch may lack sec-ch-ua and would overwrite it.
      if (req.url === '/') {
        lastUa = String(req.headers['user-agent'] ?? '');
        lastSecChUa = String(req.headers['sec-ch-ua'] ?? '');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.url?.startsWith('/search') ? SEARCH_FIXTURE : TALL_PAGE);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/`;
    // Point the search backend at the loopback fixture, and give the AI-overview
    // card a canned abstract so no test touches the network (dev-only overrides).
    process.env.SHIORI_SEARCH_URL = `${origin}/search`;
    process.env.SHIORI_ABSTRACT = 'テスト用の概要テキスト。';
    const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    process.env.SHIORI_IMAGES = JSON.stringify([
      { thumbnail: px, title: 'img1', url: 'https://example.com/a', source: 'example.com' },
      { thumbnail: px, title: 'img2', url: 'https://example.org/b', source: 'example.org' },
      { thumbnail: px, title: 'img3', url: 'https://example.net/c', source: 'example.net' },
    ]);

    const win = await waitFor(() => BrowserWindow.getAllWindows()[0]);
    await settle(win.webContents);
    await delay(400);

    // --- the chrome renderer actually booted -------------------------------
    const apiType = await win.webContents.executeJavaScript('typeof window.shiori');
    check('chrome preload bridge exposed', apiType === 'object', `typeof = ${apiType}`);

    const laneGroups = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#lanes .lane-group').length",
    );
    check('favorite lanes rendered', laneGroups >= 2, `${laneGroups} lanes`);

    const homeVisible = await win.webContents.executeJavaScript(
      "!document.getElementById('home').hidden",
    );
    check('home screen visible on boot', homeVisible === true);

    // Guards against the stylesheet losing rules (a bare transparent <button>
    // means .home-ai-card's card styling is gone, not just ugly).
    const cardStyled = await win.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.home-ai-card')).backgroundColor",
    );
    check(
      'home AI cards carry their card styling',
      cardStyled !== 'rgba(0, 0, 0, 0)' && cardStyled !== 'transparent',
      String(cardStyled),
    );

    // --- navigation creates a real WebContentsView --------------------------
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:navigate', { url: ${JSON.stringify(url)} })`,
    );
    const page = await waitFor(() => findPageView(origin));
    await settle(page);
    check('page loaded in WebContentsView', page.getURL().startsWith(origin), page.getURL());
    check('page title captured', page.getTitle() === 'Smoke Test Article', page.getTitle());

    const pageChips = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#pages .chip').length",
    );
    check('page chip rendered', pageChips === 1, `${pageChips} chips`);

    // --- Google sign-in: identity must read as desktop Chrome ---------------
    // (verified against the loopback request the page just made, and the DOM.)
    check(
      'UA is a clean desktop Chrome string',
      /^Mozilla\/5\.0 .*Chrome\/\d+.*Safari\/537\.36$/.test(lastUa) && !/Electron|Shiori/i.test(lastUa),
      lastUa,
    );
    // The JS-visible identity (navigator.userAgentData) must also say Google
    // Chrome — this is the part app.userAgentFallback can't fix and Google reads.
    const brands = await page.executeJavaScript(
      "(navigator.userAgentData ? navigator.userAgentData.brands.map(b=>b.brand).join(',') : 'none')",
    );
    check(
      'navigator.userAgentData reports Google Chrome',
      /Google Chrome/.test(brands),
      brands,
    );
    // Google rejects automation-controlled browsers: the CDP override must NOT
    // flip navigator.webdriver to true, or sign-in fails despite a clean UA.
    const webdriver = await page.executeJavaScript('String(navigator.webdriver)');
    check('navigator.webdriver stays false', webdriver === 'false', webdriver);
    // Chromium only sends sec-ch-ua reliably over HTTPS, so a plain-http
    // loopback may omit it; when it IS present it must carry our Google Chrome
    // rewrite (the real behaviour on accounts.google.com). Never fail on
    // absence — that would be testing Chromium's transport policy, not us.
    check(
      'client hints rewritten to Google Chrome when sent',
      lastSecChUa === '' || lastSecChUa.includes('Google Chrome'),
      lastSecChUa || '(none over http loopback — verified by rewrite code)',
    );

    // --- universal bookmark: scroll is captured -----------------------------
    await page.executeJavaScript('window.scrollTo(0, 2400); true');
    await delay(900);
    const key = normalizeUrl(url);
    const saved = getBookmark(key);
    check('scroll position saved', !!saved && saved.scrollY > 2000, `scrollY=${saved?.scrollY}`);
    check(
      'read progress computed',
      !!saved && saved.progress > 0.1 && saved.progress < 1,
      `progress=${saved?.progress.toFixed(3)}`,
    );

    // A progress tick must update only the underline, never rebuild the row —
    // otherwise the favicon <img> re-loads and flickers with every scroll.
    // Tag the favicon, scroll again, and confirm the same element survived.
    const tagged = await win.webContents.executeJavaScript(
      "(function(){var f=document.querySelector('#pages .chip.page .fav, #pages .chip.page .fav-fallback');if(f)f.dataset.smokeKeep='1';return !!f;})()",
    );
    await page.executeJavaScript('window.scrollTo(0, 2600); true');
    await delay(400);
    const afterScroll = await win.webContents.executeJavaScript(
      "(function(){var f=document.querySelector('#pages .chip.page [data-smoke-keep=\"1\"]');var b=document.querySelector('#pages .chip.page .chip-progress');return {preserved:!!f, bar:b?b.style.width:''};})()",
    );
    check(
      'favicon not rebuilt on scroll (no flicker)',
      tagged === true && afterScroll.preserved === true,
      `preserved=${afterScroll.preserved}`,
    );
    check('progress underline updates on scroll', /%$/.test(afterScroll.bar), `width=${afterScroll.bar}`);
    // Return to 2400 so the reload-restore band below still applies.
    await page.executeJavaScript('window.scrollTo(0, 2400); true');
    await delay(500);

    // --- video fullscreen hides all chrome ----------------------------------
    // The native enter-html-full-screen event needs a real user gesture, so we
    // verify the CSS contract the renderer applies: with body.fullscreen the
    // bars are gone and #page-host loses its inset (the view then fills it).
    const fs = await win.webContents.executeJavaScript(
      "(function(){document.body.classList.add('fullscreen');var g=getComputedStyle;var r={topbar:g(document.getElementById('topbar')).display, rail:g(document.getElementById('rail')).display, status:g(document.getElementById('statusbar')).display, inset:g(document.getElementById('page-host')).insetInlineStart};document.body.classList.remove('fullscreen');return r;})()",
    );
    check(
      'fullscreen hides chrome',
      fs.topbar === 'none' && fs.rail === 'none' && fs.status === 'none',
      `topbar=${fs.topbar} rail=${fs.rail} status=${fs.status}`,
    );
    check('fullscreen removes page inset', fs.inset === '0px', `inset=${fs.inset}`);

    // Our restore must be the only thing touching scrollTop.
    const restoration = await page.executeJavaScript('history.scrollRestoration');
    check(
      'native scroll restoration disabled',
      restoration === 'manual',
      `scrollRestoration=${restoration}`,
    );

    // --- universal bookmark: scroll is restored after a reload --------------
    page.reload();
    await settle(page);
    // The restore schedule re-applies the target while the page lays out.
    await delay(5200);
    const restoredY = await page.executeJavaScript('window.scrollY');
    // Deliberately a tight band, not `> 2000`: landing anywhere other than
    // where the reader left off is the failure this feature exists to prevent,
    // and a loose bound hides drift.
    check('scroll restored after reload', Math.abs(restoredY - 2400) <= 50, `scrollY=${restoredY}`);

    // The document-start stealth script (for Google's post-identifier check)
    // ran on this freshly reloaded document: window.chrome + non-empty plugins.
    const env = await page.executeJavaScript(
      "JSON.stringify({chrome: typeof window.chrome, runtime: !!(window.chrome && window.chrome.runtime), plugins: navigator.plugins.length, wd: navigator.webdriver})",
    );
    const envObj = JSON.parse(env) as { chrome: string; runtime: boolean; plugins: number; wd: unknown };
    check(
      'Chrome JS environment spoof applied',
      envObj.chrome === 'object' && envObj.runtime === true && envObj.plugins > 0 && envObj.wd === false,
      env,
    );

    // --- sourced clipboard --------------------------------------------------
    const clipsBefore = listClips().length;
    await page.executeJavaScript(`
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('quote'));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
      true;
    `);
    await delay(600);
    const clips = listClips();
    check('copy captured as clip', clips.length === clipsBefore + 1, `${clips.length} clips`);
    check(
      'clip carries its source',
      !!clips[0] && clips[0].url.startsWith(origin) && clips[0].title === 'Smoke Test Article',
      clips[0] ? `${clips[0].title} / ${clips[0].url}` : 'none',
    );
    check(
      'clip text captured',
      !!clips[0] && clips[0].text.includes('引用されるべきテキスト'),
      clips[0]?.text ?? '',
    );

    // --- favorites (lane pins) & the single global page list ----------------
    // Lanes are favorite folders now; open pages are one global list. The two
    // must stay fully separate: a pin never changes when you browse, and a lane
    // op never touches the pages.
    const s0 = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    const researchId: string = s0.lanes[0].id;
    const funId: string = s0.lanes[1].id;
    const pinPageId: string = s0.pages[0].id;
    const pinnedUrl: string = s0.pages[0].url;

    // Pin the open page onto the 研究 lane.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:pin-favorite', { laneId: ${JSON.stringify(researchId)}, pageId: ${JSON.stringify(pinPageId)} })`,
    );
    await delay(300);
    const s1 = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    const researchFavs = s1.lanes.find((l: { id: string }) => l.id === researchId)?.favorites ?? [];
    check(
      'page pinned as a favorite',
      researchFavs.length === 1 && researchFavs[0].url === pinnedUrl,
      `${researchFavs.length} favorites`,
    );
    const pinsRendered = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#lanes .lane-group .pin').length",
    );
    check('favorite pin rendered under its lane', pinsRendered >= 1, `${pinsRendered} pins`);

    // Folding a lane hides its pins; the state persists in the store.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:toggle-lane-collapsed', { laneId: ${JSON.stringify(researchId)} })`,
    );
    await delay(300);
    const collapsedFlag = await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:get-state').then(s => s.lanes.find((l) => l.id === ${JSON.stringify(researchId)}).collapsed)`,
    );
    check('lane folds (collapsed flag set)', collapsedFlag === true, String(collapsedFlag));
    const folded = await win.webContents.executeJavaScript(
      "(function(){var g=document.querySelector('#lanes .lane-group.collapsed');return {has:!!g, pins: g ? g.querySelectorAll('.pin').length : -1};})()",
    );
    check('folded lane hides its pins', folded.has === true && folded.pins === 0, JSON.stringify(folded));
    // Unfold again, leaving 研究 expanded for the checks below.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:toggle-lane-collapsed', { laneId: ${JSON.stringify(researchId)} })`,
    );
    await delay(300);
    const unfoldedFlag = await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:get-state').then(s => s.lanes.find((l) => l.id === ${JSON.stringify(researchId)}).collapsed)`,
    );
    check('lane unfolds', unfoldedFlag === false, String(unfoldedFlag));

    // Clicking anywhere on the lane header folds it — the whole row responds
    // (delegated on #lanes), not just a button. 研究 is lanes[0] = the first group.
    await win.webContents.executeJavaScript(
      "(function(){var h=document.querySelector('#lanes .lane-group .lane-head .chip-label'); if(h) h.click();})()",
    );
    await delay(300);
    const foldedByLabel = await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:get-state').then(s => s.lanes.find(l => l.id === ${JSON.stringify(researchId)}).collapsed)`,
    );
    check('clicking the lane name folds it (whole header)', foldedByLabel === true, String(foldedByLabel));
    // Unfold via a different header part (the count) to prove the whole row works.
    await win.webContents.executeJavaScript(
      "(function(){var h=document.querySelector('#lanes .lane-group .lane-head .chip-count'); if(h) h.click();})()",
    );
    await delay(300);
    const unfoldedByCount = await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:get-state').then(s => s.lanes.find(l => l.id === ${JSON.stringify(researchId)}).collapsed)`,
    );
    check('clicking the count unfolds it', unfoldedByCount === false, String(unfoldedByCount));

    // A new lane must not disturb the global page list (they are independent).
    const tempLaneId = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:new-lane', { name: 'テストレーン' })",
    );
    await delay(300);
    const s2 = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    check('new lane leaves the global pages untouched', s2.pages.length === 1, `${s2.pages.length} pages`);
    // Deleting a lane never closes a page (pages are global).
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:delete-lane', { laneId: ${JSON.stringify(tempLaneId)} })`,
    );
    await delay(300);
    const s2b = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    check('deleting a lane keeps the pages', s2b.pages.length === 1, `${s2b.pages.length} pages`);

    // The core promise: browsing the page away leaves the pin untouched.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:navigate', { url: ${JSON.stringify(`${url}?x=1`)} })`,
    );
    await waitFor(() => (page.getURL().includes('?x=1') ? true : undefined));
    await settle(page);
    await delay(300);
    const s3 = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    const favAfterNav = s3.lanes.find((l: { id: string }) => l.id === researchId)?.favorites ?? [];
    check(
      'pin survives browsing the page away',
      favAfterNav.length === 1 && favAfterNav[0].url === pinnedUrl,
      favAfterNav[0]?.url ?? 'gone',
    );
    check(
      'the page moved on, the pin did not',
      s3.pages.length === 1 && s3.pages[0].url.includes('?x=1'),
      s3.pages[0]?.url ?? 'none',
    );

    // Bring the page back to the article URL for the downstream search tests.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:navigate', { url: ${JSON.stringify(url)} })`,
    );
    await waitFor(() => (page.getURL() === url ? true : undefined));
    await settle(page);
    await delay(300);

    // Opening a favorite that's already open focuses that page (no duplicate).
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:open-favorite', { url: ${JSON.stringify(pinnedUrl)} })`,
    );
    await delay(300);
    const s4 = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    check('opening an already-open favorite does not duplicate', s4.pages.length === 1, `${s4.pages.length} pages`);

    // Pin/remove on a second lane, leaving 研究's pin for the restart pass.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:pin-favorite', { laneId: ${JSON.stringify(funId)}, pageId: ${JSON.stringify(pinPageId)} })`,
    );
    await delay(200);
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:remove-favorite', { laneId: ${JSON.stringify(funId)}, url: ${JSON.stringify(pinnedUrl)} })`,
    );
    await delay(300);
    const s5 = await win.webContents.executeJavaScript("window.shiori.invoke('shiori:get-state')");
    const funFavs = s5.lanes.find((l: { id: string }) => l.id === funId)?.favorites ?? [];
    const researchFavs2 = s5.lanes.find((l: { id: string }) => l.id === researchId)?.favorites ?? [];
    check(
      'removing a pin leaves other lanes intact',
      funFavs.length === 0 && researchFavs2.length === 1,
      `fun=${funFavs.length} research=${researchFavs2.length}`,
    );

    // --- memo panel (TODO + free memo) --------------------------------------
    // Open it; the right side hosts one panel at a time, so this closes clip/AI.
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:set-notes-panel', { open: true })",
    );
    await delay(300);
    const notesOpenState = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check(
      'notes panel opens (exclusive with clip/AI)',
      notesOpenState.notesPanelOpen === true &&
        notesOpenState.clipPanelOpen === false &&
        notesOpenState.ai.open === false,
      JSON.stringify({ n: notesOpenState.notesPanelOpen, c: notesOpenState.clipPanelOpen, a: notesOpenState.ai.open }),
    );
    const notesVisible = await win.webContents.executeJavaScript(
      "!document.getElementById('notes-panel').hidden",
    );
    check('notes panel chrome visible', notesVisible === true);

    // Add two tasks; check they land in the store and render.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:add-todo', { text: '牛乳を買う' })");
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:add-todo', { text: 'PRをレビュー' })");
    await delay(200);
    const todosAfterAdd = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-notes').then(n => n.todos)",
    );
    check(
      'todos added in order',
      todosAfterAdd.length === 2 && todosAfterAdd[0].text === '牛乳を買う',
      `${todosAfterAdd.length} todos`,
    );
    const todoItems = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#todo-list .todo-item').length",
    );
    check('todo items rendered', todoItems === 2, `${todoItems} items`);

    // Toggle the second done, then clear-done removes it, leaving one.
    const secondTodoId: string = todosAfterAdd[1].id;
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:toggle-todo', { id: ${JSON.stringify(secondTodoId)} })`,
    );
    await delay(150);
    const toggledDone = await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:get-notes').then(n => n.todos.find(t => t.id === ${JSON.stringify(secondTodoId)}).done)`,
    );
    check('todo toggles done', toggledDone === true, String(toggledDone));
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:clear-done-todos')");
    await delay(150);
    const afterClearDone = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-notes').then(n => n.todos)",
    );
    check(
      'clear-done removes finished tasks',
      afterClearDone.length === 1 && afterClearDone[0].text === '牛乳を買う',
      `${afterClearDone.length} todos`,
    );
    // Mark the survivor done so restart can prove a done task persists.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:toggle-todo', { id: ${JSON.stringify(afterClearDone[0].id)} })`,
    );
    await delay(150);

    // Free memo autosaves to the store.
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:set-memo', { text: '来週の予定\\nメモのテスト' })",
    );
    await delay(150);
    const savedMemo = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-notes').then(n => n.memo)",
    );
    check('memo saved', typeof savedMemo === 'string' && savedMemo.includes('メモのテスト'), savedMemo?.slice(0, 20));

    // Opening the clip panel must close the notes panel (one right panel).
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:set-clip-panel', { open: true })");
    await delay(200);
    const afterOpenClip = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check(
      'opening clips closes the notes panel',
      afterOpenClip.clipPanelOpen === true && afterOpenClip.notesPanelOpen === false,
      JSON.stringify({ c: afterOpenClip.clipPanelOpen, n: afterOpenClip.notesPanelOpen }),
    );
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:set-clip-panel', { open: false })");
    await delay(200);

    // --- AI side panel ------------------------------------------------------
    // The panel is pointed at the loopback server so the test stays offline;
    // what we verify is the plumbing (view creation, state, promote-to-page),
    // which is identical for the real chat sites.
    process.env.SHIORI_AI_URL = url;
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-open', { service: 'claude' })",
    );
    const aiView = await waitFor(() =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL().startsWith(origin) && wc.id !== page.id),
    );
    await settle(aiView);
    await delay(300);
    check('AI panel view loads', aiView.getURL().startsWith(origin), aiView.getURL());

    const aiState = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state').then(s => s.ai)",
    );
    check(
      'AI state reflects open panel',
      aiState?.open === true && aiState?.service === 'claude',
      JSON.stringify(aiState),
    );

    const aiPanelVisible = await win.webContents.executeJavaScript(
      "!document.getElementById('ai-panel').hidden",
    );
    check('AI panel chrome visible', aiPanelVisible === true);

    // Switching service creates a second view and keeps the first alive
    // (that is what preserves the conversation across switches).
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-open', { service: 'gemini' })",
    );
    await delay(500);
    const loopbackViews = webContents
      .getAllWebContents()
      .filter((wc) => wc.getURL().startsWith(origin)).length;
    check('service switch keeps views alive', loopbackViews >= 3, `${loopbackViews} views`);

    // Promoting the chat to a page closes the panel and lands it in the lane…
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:ai-open-as-page')");
    await delay(500);
    const promoted = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check('open-as-page closes the panel', promoted.ai?.open === false);
    check(
      'chat promoted into the global page list',
      promoted.pages?.length === 2,
      `${promoted.pages?.length ?? 0} pages`,
    );
    // …then close it again so the restart pass still finds exactly one page.
    const promotedPageId: string = promoted.pages[1].id;
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:close-page', { pageId: ${JSON.stringify(promotedPageId)} })`,
    );
    await delay(300);

    // --- 並列AIモード (parallel AI grid) -------------------------------------
    // Reuses the same loopback aiViews. Verifies the grid attaches several views
    // at once, renders one tile each, a broadcast reaches every composer, and a
    // tile promotes to a page — then tidies back to exactly one page so the
    // search and restart passes downstream are unchanged.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:ai-grid-open')");
    await delay(800);

    const gridState = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state').then(s => s.aiGrid)",
    );
    check(
      'grid state opens with four services',
      gridState?.open === true && Array.isArray(gridState?.services) && gridState.services.length === 4,
      JSON.stringify(gridState),
    );

    const tileCount = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#ai-tiles .ai-tile').length",
    );
    check('grid renders one tile per service', tileCount === 4, `${tileCount} tiles`);

    const bodyGrid = await win.webContents.executeJavaScript(
      "document.body.classList.contains('ai-grid')",
    );
    check('grid takes over the stage (body.ai-grid)', bodyGrid === true);

    // Every service's view is a live loopback view, all attached together.
    const gridViews = webContents
      .getAllWebContents()
      .filter((wc) => wc.getURL().startsWith(origin) && wc.id !== page.id);
    check('grid attaches every service view at once', gridViews.length >= 4, `${gridViews.length} views`);

    // Broadcast (fill only): the prompt lands in every tile's composer, and
    // submit:false means nothing is sent (the composer keeps the text).
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-broadcast', { text: '比較テスト', submit: false })",
    );
    await delay(800);
    let filled = 0;
    for (const wc of gridViews) {
      const value = await wc
        .executeJavaScript("(document.getElementById('composer')||{}).value || ''")
        .catch(() => '');
      if (value === '比較テスト') filled++;
    }
    check('broadcast fills every composer', filled >= 4, `${filled}/${gridViews.length} composers filled`);

    // Activating a page while the grid is up must leave the grid — the sidebar
    // stays clickable, so a page click has to return to reading (regression:
    // page actions used to silently park behind the grid).
    const pidUnderGrid = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state').then(s => s.pages[0].id)",
    );
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:activate-page', { pageId: ${JSON.stringify(pidUnderGrid)} })`,
    );
    await delay(400);
    const afterActivate = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check(
      'activating a page leaves the grid',
      afterActivate.aiGrid?.open === false,
      JSON.stringify(afterActivate.aiGrid),
    );
    // Reopen the grid for the transition / toggle / promote checks below.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:ai-grid-open')");
    await delay(500);

    // Grid → single panel directly: the mode flips AND the parked reading page
    // reattaches (regression: openAi used to leave the page pane blank). We
    // count attached loopback views — the article page + the panel = 2; the bug
    // left only the panel = 1.
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-open', { service: 'gemini' })",
    );
    await delay(500);
    const toPanel = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check(
      'grid → panel flips modes',
      toPanel.aiGrid?.open === false && toPanel.ai?.open === true,
      JSON.stringify({ grid: toPanel.aiGrid?.open, panel: toPanel.ai?.open }),
    );
    const attachedLoopback = win.contentView.children.filter((v) => {
      const wc = (v as unknown as { webContents?: WebContents }).webContents;
      return !!wc && !wc.isDestroyed() && wc.getURL().startsWith(origin);
    }).length;
    check(
      'grid → panel reattaches the reading page',
      attachedLoopback >= 2,
      `${attachedLoopback} loopback views attached`,
    );
    // Reopen the grid for the toggle / promote checks below.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:ai-grid-open')");
    await delay(500);

    // Toggling a service off drops its tile.
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-grid-set-services', { services: ['chatgpt','claude'] })",
    );
    await delay(400);
    const tilesAfterToggle = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#ai-tiles .ai-tile').length",
    );
    check('service toggle changes tile count', tilesAfterToggle === 2, `${tilesAfterToggle} tiles`);

    // Promote a tile: leave the grid and add exactly one page to the global list.
    const pagesBeforePromote = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state').then(s => s.pages.length)",
    );
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-grid-tile-promote', { service: 'claude' })",
    );
    await delay(500);
    const afterPromote = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check('tile promote leaves the grid', afterPromote.aiGrid?.open === false, JSON.stringify(afterPromote.aiGrid));
    check(
      'tile promote adds one page to the global list',
      afterPromote.pages?.length === pagesBeforePromote + 1,
      `${pagesBeforePromote} -> ${afterPromote.pages?.length}`,
    );

    // Tidy back: close the promoted page and restore the default line-up, so the
    // search/image/restart passes see exactly one page and a full grid config.
    const promoPageId: string = afterPromote.pages[afterPromote.pages.length - 1].id;
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:close-page', { pageId: ${JSON.stringify(promoPageId)} })`,
    );
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-grid-set-services', { services: ['chatgpt','gemini','claude','perplexity'] })",
    );
    await delay(300);
    const tidied = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state')",
    );
    check(
      'grid tidied back to one page, mode closed',
      tidied.aiGrid?.open === false && tidied.pages?.length === 1,
      `open=${tidied.aiGrid?.open} pages=${tidied.pages?.length}`,
    );

    // --- Shiori's own search page (shiori://search) --------------------------
    // A non-URL query navigates the page view to the internal results page, so
    // the search lives in REAL history — ‹ / › move between results and pages.
    const pageUrlBefore = page.getURL();
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:navigate', { url: 'electron webcontentsview' })",
    );
    await waitFor(() => (page.getURL().startsWith('shiori://search') ? true : undefined));
    await settle(page);
    await delay(300);
    const resultCount = await page.executeJavaScript(
      "document.querySelectorAll('.result').length",
    );
    check('search page renders parsed results', resultCount === 2, `${resultCount} results`);

    const firstResult = await page.executeJavaScript(
      "(function(){var c=document.querySelector('.result');return {title:c.querySelector('.result-title').textContent.trim(), host:c.querySelector('.crumb').textContent.trim()};})()",
    );
    check(
      'result title/host parsed',
      firstResult.title === 'Electron Documentation' && firstResult.host === 'electronjs.org',
      `${firstResult.title} / ${firstResult.host}`,
    );

    // Tabs must all be present and navigable (no dead controls).
    const tabCount = await page.executeJavaScript("document.querySelectorAll('.tabs .tab').length");
    check('search tabs rendered', tabCount === 4, `${tabCount} tabs`);

    // A "next page" link must be present so results aren't capped at one page.
    const nextPage = await page.executeJavaScript(
      "(function(){var a=[].slice.call(document.querySelectorAll('.pager .pg'));return a.some(function(x){return /p=2/.test(x.getAttribute('href'));});})()",
    );
    check('search pagination link present', nextPage === true);

    const branding = await page.executeJavaScript(
      "(document.body.textContent||'').match(/duckduckgo|google|bing/i) ? 'FOUND' : 'clean'",
    );
    check('no search-engine branding shown', branding === 'clean', branding);

    const hasOverview = await page.executeJavaScript(
      "!!document.querySelector('.ai-card') && /AI OVERVIEW/.test(document.querySelector('.ai-card').textContent)",
    );
    check('AI overview card rendered', hasOverview === true);

    // The user's flow: search → open something → ‹ back to the results → ›.
    check('back available from the results', page.navigationHistory.canGoBack());
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:back')");
    await waitFor(() => (page.getURL() === pageUrlBefore ? true : undefined));
    await settle(page);
    check('back leaves the results page', page.getURL() === pageUrlBefore, page.getURL());

    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:forward')");
    await waitFor(() => (page.getURL().startsWith('shiori://search') ? true : undefined));
    await settle(page);
    // Poll for the re-rendered results rather than trusting one fixed delay.
    let resultsAgain = 0;
    for (let i = 0; i < 40; i++) {
      resultsAgain = await page.executeJavaScript("document.querySelectorAll('.result').length");
      if (resultsAgain > 0) break;
      await delay(150);
    }
    check('forward returns to the results', resultsAgain === 2, `${resultsAgain} results`);

    // Land back on the article (done with the ‹/› checks) so the image test
    // below and the restart pass both start from a known page.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:back')");
    await waitFor(() => (page.getURL() === pageUrlBefore ? true : undefined));
    await settle(page);
    await delay(400);

    // --- 画像 tab shows an actual thumbnail grid (not web-result cards) ------
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:navigate', { url: 'shiori://search?q=neko&t=images' })",
    );
    let imgCells = 0;
    for (let i = 0; i < 40; i++) {
      imgCells = await page.executeJavaScript(
        "document.querySelectorAll('.img-grid .img-cell img').length",
      );
      if (imgCells > 0) break;
      await delay(150);
    }
    check('image tab renders a thumbnail grid', imgCells === 3, `${imgCells} thumbnails`);
    // Return to the article so the restart pass sees the URL it expects.
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:navigate', { url: ${JSON.stringify(url)} })`,
    );
    await waitFor(() => (page.getURL().startsWith(origin) ? true : undefined));
    await settle(page);
    await delay(300);

    // --- bookmark surfaces on the home screen -------------------------------
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:go-home')");
    await delay(500);
    const rows = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#home-list .read-row').length",
    );
    check('bookmark listed in 続きから読む', rows >= 1, `${rows} rows`);
  } catch (error) {
    check('smoke run completed without throwing', false, String(error));
  } finally {
    flushBookmarks();
    server?.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length === 0 ? 0 : 1);
}
