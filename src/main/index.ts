import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  protocol,
  session,
  type MenuItemConstructorOptions,
} from 'electron';
import { AI_SERVICES } from './ai';
import { Browser, CHROME_UA } from './browser';
import { registerIpc } from './ipc';
import {
  buildSearchPage,
  dedupeResults,
  fetchAbstract,
  fetchImages,
  fetchSearchHtml,
  parseSearchResults,
  type SearchTab,
} from './search';
import { flushBookmarks } from './store';
import type { AiService } from '../shared/types';

// Shiori's internal pages (the search results live on shiori://search so they
// sit in the page view's real navigation history — that is what makes the
// back/forward buttons work between results and an opened result).
// Must be registered before app "ready".
protocol.registerSchemesAsPrivileged([
  { scheme: 'shiori', privileges: { standard: true, secure: true } },
]);

const browser = new Browser();

/** SHIORI_SMOKE=1 runs the end-to-end pass; =restart re-opens its profile.
    Dev-only: the packaged app does not even ship smoke/shot code, so the env
    vars must not put a user's install into a half-initialized state. */
const smokeMode: 'fresh' | 'restart' | null = app.isPackaged
  ? null
  : process.env.SHIORI_SMOKE === '1'
    ? 'fresh'
    : process.env.SHIORI_SMOKE === 'restart'
      ? 'restart'
      : null;

/** SHIORI_SHOT=1 boots a seeded profile, captures the chrome to PNG, exits. */
const shotMode = process.env.SHIORI_SHOT === '1' && !app.isPackaged;

// Chromium coalesces scroll-event dispatch (and timers) on a window that isn't
// foreground. That makes the smoke's scroll-timing assertions flaky when the
// test window runs behind others. Disable the throttling for smoke runs only —
// this is dev/test infrastructure and never affects a packaged build.
if (smokeMode) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

// Google refuses sign-in from anything it reads as an embedded browser —
// "このブラウザまたはアプリは安全でない可能性があります" / disallowed_useragent.
// The fix is to look byte-for-byte like desktop Chrome: a canonical Chrome UA
// for the platform we run on (built in browser.ts with our real bundled
// Chromium version, so it stays valid across upgrades and matches the client
// hints below and the CDP override).
const CHROME_VERSION = process.versions.chrome;
app.userAgentFallback = CHROME_UA;

// Shiori's chrome is a light glass design; forcing the app-level appearance
// keeps the vibrancy material light even on dark-mode systems.
nativeTheme.themeSource = 'light';

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    // The app menu (hide/unhide) exists only on macOS; Windows gets quit in File.
    ...(isMac
      ? [
          {
            label: 'Shiori',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: '新しいページ',
          accelerator: 'CmdOrCtrl+T',
          click: () => browser.goHome(),
        },
        {
          label: '新しいレーン',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => browser.newLane(''),
        },
        { type: 'separator' },
        // Windows: role 'close' defaults to Ctrl+W, and closing the only
        // window quits the app there — a muscle-memory "close tab" would kill
        // the whole browser. Chrome's close-window shortcut (Ctrl+Shift+W)
        // frees Ctrl+W. macOS keeps the stock Cmd+W behavior.
        isMac ? { role: 'close' } : { role: 'close', accelerator: 'Ctrl+Shift+W' },
        ...(isMac ? [] : [{ role: 'quit' } satisfies MenuItemConstructorOptions]),
      ],
    },
    // Without a real Edit menu, Cmd+C / Cmd+V do not work anywhere on macOS.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'アドレスバーへ移動',
          accelerator: 'CmdOrCtrl+L',
          click: () => browser.focusUrlBar(),
        },
        {
          label: '再読み込み',
          accelerator: 'CmdOrCtrl+R',
          click: () => browser.reload(),
        },
        { type: 'separator' },
        {
          label: '戻る',
          accelerator: 'CmdOrCtrl+[',
          click: () => browser.back(),
        },
        {
          label: '進む',
          accelerator: 'CmdOrCtrl+]',
          click: () => browser.forward(),
        },
        { type: 'separator' },
        {
          label: 'サイドバーを表示/隠す',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => browser.toggleSidebar(),
        },
        {
          label: 'メモ',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => browser.toggleNotesPanel(),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'AI',
      submenu: [
        {
          label: 'AIパネルを開閉',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => browser.toggleAi(),
        },
        {
          label: '並列AIモード',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => browser.toggleAiGrid(),
        },
        { type: 'separator' },
        ...(Object.keys(AI_SERVICES) as AiService[]).map((service, index) => ({
          label: AI_SERVICES[service].label,
          accelerator: `Alt+CmdOrCtrl+${index + 1}`,
          click: () => browser.openAi(service),
        })),
      ],
    },
    {
      label: 'Window',
      // zoom / front are macOS-only roles; Windows gets minimize / close.
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Windows groups taskbar entries (and attributes notifications) by AppUserModelID;
// it must match electron-builder's appId or pinned shortcuts break.
if (process.platform === 'win32') app.setAppUserModelId('com.shiori.browser');

// A second copy of Shiori would fight the first one over the same store file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      // Dev convenience: `npm start` while the app is already open just re-runs
      // `electron .`, whose new instance dies on the single-instance lock and
      // hands off here. Without this, the running window keeps its OLD renderer
      // even though the build refreshed dist — so UI changes appear to "not
      // apply". Reload it (dev only) so the freshly-built renderer takes effect.
      // Packaged apps never reload a user's window from a second launch.
      if (!app.isPackaged) win.webContents.reload();
    }
  });

  app.whenReady().then(() => {
    // Keep smoke runs out of the real profile. The 'fresh' run starts from an
    // empty one so its counts have a known-zero baseline; the 'restart' run
    // deliberately keeps it, because reopening what the previous launch wrote
    // is the whole point of that pass. Safe here only because the store is
    // built lazily, on first access inside browser.create().
    if (smokeMode) {
      const profile = join(app.getPath('temp'), 'shiori-smoke-profile');
      if (smokeMode === 'fresh') rmSync(profile, { recursive: true, force: true });
      app.setPath('userData', profile);
    }
    if (shotMode) {
      const profile = join(app.getPath('temp'), 'shiori-shot-profile');
      rmSync(profile, { recursive: true, force: true });
      app.setPath('userData', profile);
      // Seed lanes/bookmarks before create() reads the store, so the capture
      // shows a lived-in UI rather than an empty one.
      const shot = require('./shot') as typeof import('./shot');
      shot.seed();
    }

    // Match the UA with the client hints Chromium sends: by default Electron
    // brands itself "Chromium", which Google reads as a non-Chrome browser even
    // when the UA string says Chrome. Rewriting Sec-CH-UA to include
    // "Google Chrome" keeps the whole identity consistent, which is what
    // accounts.google.com's "secure browser" check actually inspects.
    const chromeMajor = CHROME_VERSION.split('.')[0];
    const brandList = `"Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}", "Not?A_Brand";v="24"`;
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'sec-ch-ua') headers[key] = brandList;
      }
      callback({ requestHeaders: headers });
    });

    // Back/forward re-issues the request to this handler (custom-protocol pages
    // aren't kept in the back-forward cache), so navigating next→prev would
    // re-fetch DuckDuckGo every time and could get throttled, leaving the
    // previous page suddenly empty. Cache each successfully built page by its
    // canonical (q, tab, p) key so history navigation returns the exact same
    // results instantly without hitting the network again. Only successful
    // pages are cached — a transient failure must never be pinned.
    const searchCache = new Map<string, string>();
    const SEARCH_CACHE_MAX = 40;
    const rememberPage = (key: string, html: string): string => {
      if (searchCache.has(key)) searchCache.delete(key);
      searchCache.set(key, html);
      while (searchCache.size > SEARCH_CACHE_MAX) {
        const oldest = searchCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        searchCache.delete(oldest);
      }
      return html;
    };

    protocol.handle('shiori', async (request) => {
      const u = new URL(request.url);
      if (u.host === 'search') {
        const query = (u.searchParams.get('q') ?? '').trim();
        const tabParam = u.searchParams.get('t');
        const tab: SearchTab =
          tabParam === 'images' || tabParam === 'videos' || tabParam === 'news' ? tabParam : 'all';
        const page = Math.max(1, Number.parseInt(u.searchParams.get('p') ?? '1', 10) || 1);
        const cacheKey = `${tab}|${page}|${query}`;
        const html = (body: string) =>
          new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

        const cached = searchCache.get(cacheKey);
        if (cached !== undefined) return html(cached);

        // Images tab shows actual thumbnails, not "sites that have images".
        if (tab === 'images') {
          const images = await fetchImages(query);
          const body = buildSearchPage(query, null, null, 'images', images);
          // Only cache once we actually got thumbnails.
          if (images.length > 0) rememberPage(cacheKey, body);
          return html(body);
        }

        // Videos / news re-search with a category keyword (no separate media
        // API), so they return real web results and none is a dead control.
        const bias = tab === 'news' ? ' ニュース' : tab === 'videos' ? ' 動画' : '';
        // Fetch several offset batches per page and merge them, so each page
        // shows plenty of results instead of a single short DuckDuckGo page.
        const start = (page - 1) * 60;
        const batches = await Promise.all([
          fetchSearchHtml(query + bias, start),
          fetchSearchHtml(query + bias, start + 20),
          fetchSearchHtml(query + bias, start + 40),
        ]);
        const abstract = page === 1 ? await fetchAbstract(query) : null;
        const anyOk = batches.some((b) => b.ok);
        const results = anyOk
          ? dedupeResults(batches.map((b) => (b.ok && b.html ? parseSearchResults(b.html) : [])))
          : null;
        const body = buildSearchPage(query, results, abstract, tab, [], page);
        // Cache only real, non-empty result pages, so a throttled/failed fetch
        // is retried next time instead of being served empty forever.
        if (results !== null && results.length > 0) rememberPage(cacheKey, body);
        return html(body);
      }
      return new Response('Not found', { status: 404 });
    });

    // Packaged builds get the bundle icon from build/icon.icns; in dev the
    // dock would otherwise show the stock Electron icon.
    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
      const devIcon = join(__dirname, '..', '..', 'build', 'icon-1024.png');
      if (existsSync(devIcon)) app.dock.setIcon(devIcon);
    }

    registerIpc(browser);
    buildMenu();
    browser.create();

    app.on('activate', () => {
      // Reopen when the main window is gone — even if a stray OAuth popup is
      // still counted by BrowserWindow.getAllWindows().
      if (!browser.hasWindow()) browser.create();
    });

    if (smokeMode) {
      void import('./smoke').then((m) => m.runSmoke(smokeMode));
    }
    if (shotMode) {
      void import('./shot').then((m) => m.runShot());
    }
  });
}

app.on('window-all-closed', () => {
  flushBookmarks();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  flushBookmarks();
  // Chromium flushes cookies lazily; quitting right after signing in to an AI
  // service would otherwise lose the fresh login cookies.
  void session.defaultSession.cookies.flushStore();
});
