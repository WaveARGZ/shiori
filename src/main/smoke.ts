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
  <div style="height:6000px;background:linear-gradient(#fff,#ccc)"></div>
  <p>end</p>
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

    const active = state.lanes.find((l: { id: string }) => l.id === state.activeLaneId);
    check('active lane restored', !!active, active?.name ?? 'none');
    check(
      'pages restored into their lane',
      !!active && active.pages.length === 1,
      `${active?.pages.length ?? 0} pages`,
    );
    check(
      'restored page kept its URL',
      !!active?.pages[0]?.url?.startsWith('http://127.0.0.1:'),
      active?.pages[0]?.url ?? 'none',
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
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TALL_PAGE);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/`;

    const win = await waitFor(() => BrowserWindow.getAllWindows()[0]);
    await settle(win.webContents);
    await delay(400);

    // --- the chrome renderer actually booted -------------------------------
    const apiType = await win.webContents.executeJavaScript('typeof window.shiori');
    check('chrome preload bridge exposed', apiType === 'object', `typeof = ${apiType}`);

    const laneChips = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#lanes .chip, #lanes .chip-input').length",
    );
    check('lane chips rendered', laneChips >= 2, `${laneChips} chips`);

    const homeVisible = await win.webContents.executeJavaScript(
      "!document.getElementById('home').hidden",
    );
    check('home screen visible on boot', homeVisible === true);

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

    // --- context lanes: switching swaps the whole page set -------------------
    const laneId = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:new-lane', { name: '娯楽テスト' })",
    );
    await delay(500);
    const pagesInNewLane = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#pages .chip').length",
    );
    check('new lane starts empty', pagesInNewLane === 0, `${pagesInNewLane} chips`);

    const homeAfterSwitch = await win.webContents.executeJavaScript(
      "!document.getElementById('home').hidden",
    );
    check('empty lane shows home screen', homeAfterSwitch === true);

    // Switch back: the original lane's page must still be there.
    const firstLaneId = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-state').then(s => s.lanes[0].id)",
    );
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:activate-lane', { laneId: ${JSON.stringify(firstLaneId)} })`,
    );
    await delay(600);
    const pagesBack = await win.webContents.executeJavaScript(
      "document.querySelectorAll('#pages .chip').length",
    );
    check('switching back restores the lane page set', pagesBack === 1, `${pagesBack} chips`);

    // The live view was kept alive, so scroll survives a lane round-trip
    // without a reload.
    const scrollAfterSwitch = await page.executeJavaScript('window.scrollY');
    check(
      'scroll survives lane round-trip (no reload)',
      Math.abs(scrollAfterSwitch - 2400) <= 50,
      `scrollY=${scrollAfterSwitch}`,
    );

    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:delete-lane', { laneId: ${JSON.stringify(laneId)} })`,
    );
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
