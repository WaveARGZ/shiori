import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  clipboard,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import * as store from './store';
import { AI_COMPOSERS, AI_SERVICES, isAuthPopupUrl } from './ai';
import { classifyInput, isBookmarkable, normalizeUrl, toNavigableUrl } from './url';
import type {
  AiGridRect,
  AiGridState,
  AiService,
  AiState,
  Bookmark,
  BroadcastResult,
  ChromeState,
  Clip,
  CopyReport,
  EventChannel,
  Lane,
  NavState,
  NotesState,
  PageRect,
  PageRef,
  ScrollReport,
  TodoItem,
} from '../shared/types';

const LANE_COLORS = ['#7c9cff', '#ffb86c', '#7ee787', '#ff7b9c', '#c4a6ff', '#66d9e8'];

/**
 * How many DETACHED page views stay alive alongside the attached one. Each
 * WebContentsView is a full renderer process (easily 100–300 MB), so an
 * unbounded "keep every page alive forever" grows without limit as pages pile
 * up. Beyond this cap the least-recently-used background view is destroyed —
 * safe, because the universal bookmark holds every page's reading position:
 * re-activating the page recreates the view, loads its last URL and restores
 * the saved scroll (the exact restart-restore path). Views currently playing
 * audio are exempt so background music/videos never cut out.
 */
const MAX_DETACHED_VIEWS = 5;

// A complete "desktop Google Chrome" identity for the CDP override below.
// Google's sign-in gate checks not just the UA string and Sec-CH-UA header but
// also navigator.userAgentData (JS) — which app.userAgentFallback does NOT
// change. Overriding via CDP's userAgentMetadata makes all three consistent, so
// the page reads as real Chrome and "Couldn't sign you in" goes away.
// The identity must match the OS we actually run on (a macOS UA coming from a
// Windows TLS/network fingerprint reads as spoofed), so it is per-platform.
const CHROME_FULL = process.versions.chrome;
const CHROME_MAJOR = CHROME_FULL.split('.')[0]!;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// Present as the Chrome of whatever OS we actually run on — a UA that disagrees
// with the real TLS/network fingerprint reads as spoofed. Linux Chrome is a
// legitimate, common client, so Linux presents as itself (not Windows).
const UA_OS_TOKEN = IS_MAC
  ? 'Macintosh; Intel Mac OS X 10_15_7'
  : IS_WIN
    ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
export const CHROME_UA = `Mozilla/5.0 (${UA_OS_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;
// navigator.platform value real Chrome reports per OS.
const NAV_PLATFORM = IS_MAC ? 'macOS' : IS_WIN ? 'Win32' : 'Linux x86_64';
// Sec-CH-UA-Platform + its version (Chrome sends an empty version on Linux).
const CH_PLATFORM = IS_MAC ? 'macOS' : IS_WIN ? 'Windows' : 'Linux';
const CH_PLATFORM_VERSION = IS_MAC ? '14.6.0' : IS_WIN ? '15.0.0' : '';
const UA_OVERRIDE = {
  userAgent: CHROME_UA,
  acceptLanguage: 'ja,en;q=0.9',
  // Top-level platform sets navigator.platform. (The macOS value predates this
  // and is battle-tested against Google's sign-in checks — leave it untouched.)
  platform: NAV_PLATFORM,
  userAgentMetadata: {
    brands: [
      { brand: 'Not?A_Brand', version: '24' },
      { brand: 'Chromium', version: CHROME_MAJOR },
      { brand: 'Google Chrome', version: CHROME_MAJOR },
    ],
    fullVersionList: [
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
      { brand: 'Chromium', version: CHROME_FULL },
      { brand: 'Google Chrome', version: CHROME_FULL },
    ],
    fullVersion: CHROME_FULL,
    platform: CH_PLATFORM,
    platformVersion: CH_PLATFORM_VERSION,
    architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  },
};

// Injected into every document BEFORE its own scripts run. Google's sign-in
// rejects embedded browsers after the "next" step by probing JS environment
// signals (not just the UA) — a missing window.chrome, empty navigator.plugins,
// etc. This fills those in so the page reads as real desktop Chrome.
const STEALTH_JS = `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
  try {
    const w = window;
    w.chrome = w.chrome || {};
    w.chrome.runtime = w.chrome.runtime || {};
    w.chrome.loadTimes = w.chrome.loadTimes || function () { return {}; };
    w.chrome.csi = w.chrome.csi || function () { return {}; };
    w.chrome.app = w.chrome.app || { isInstalled: false, InstallState: {}, RunningState: {} };
  } catch (e) {}
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
        configurable: true,
      });
    }
  } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'], configurable: true }); } catch (e) {}
})();`;

/**
 * Make a web view present as desktop Google Chrome across every signal Google
 * inspects: the UA string, client hints, navigator.userAgentData (via CDP's
 * userAgentMetadata), and the JS environment (via a document-start script).
 *
 * Fire-and-forget from the caller: loadURL spins up the renderer these CDP
 * commands need, so awaiting before load would deadlock. The overrides land
 * before the page's own scripts run. Always resolves (best-effort).
 */
async function applyChromeIdentity(wc: WebContents): Promise<void> {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    // While the Network domain is enabled Chromium retains response bodies for
    // Network.getResponseBody — which we never call. Views live for a long
    // time here, so cap the retention buffers to almost nothing; fall back to
    // a plain enable if this Chromium rejects the (long-standing) params.
    try {
      await wc.debugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 1_000_000,
        maxResourceBufferSize: 500_000,
      });
    } catch {
      await wc.debugger.sendCommand('Network.enable');
    }
    await wc.debugger.sendCommand('Network.setUserAgentOverride', UA_OVERRIDE);
    await wc.debugger.sendCommand('Page.enable');
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });
  } catch {
    /* debugger unavailable (e.g. DevTools open) — UA fallback still applies */
  }
}

/**
 * A page whose WebContentsView actually exists. Views are created lazily (only
 * when a page is first activated) and then kept alive even while detached —
 * that is what makes a lane switch restore live scroll state instantly instead
 * of reloading everything.
 */
interface LiveView {
  pageId: string;
  view: WebContentsView;
  /** Bookmark key for whatever this view is currently showing. */
  normalizedUrl: string;
}

export class Browser {
  private win: BrowserWindow | null = null;
  private views = new Map<string, LiveView>();
  private attached: LiveView | null = null;
  private rect: PageRect = { x: 0, y: 116, width: 1280, height: 700 };
  /** Favorite folders (pins). Lanes no longer own live pages. */
  private lanes: Lane[] = [];
  /** The single global list of open pages, and which one is on screen. */
  private pages: PageRef[] = [];
  private activePageId: string | null = null;

  /**
   * AI side panel: one live view per service, kept alive while detached so the
   * conversation (and login) survives closing and reopening the panel.
   */
  private aiViews = new Map<AiService, WebContentsView>();
  private aiAttached: AiService | null = null;
  private aiRect: PageRect = { x: 880, y: 50, width: 400, height: 700 };
  /** True while the user is dragging the panel resizer (views are lifted off). */
  private resizing = false;

  /**
   * Parallel AI grid: several of the same aiViews attached at once, one per
   * tile, positioned from the renderer's measured tile rects. Reuses the exact
   * views the side panel uses, so a conversation survives moving between the
   * side panel and the grid.
   */
  private aiGridAttached = new Set<AiService>();
  private aiGridRects = new Map<AiService, PageRect>();
  /** Reserved for a future tile splitter (mirrors `resizing` for the panel). */
  private gridResizing = false;
  /** True while a page has an HTML element (e.g. a video) in fullscreen. */
  private htmlFullscreen = false;
  /** Whether *we* put the window into OS fullscreen for the video. */
  private ownedWindowFullscreen = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  create(): BrowserWindow {
    this.lanes = store.getLanes();
    this.pages = store.getPages();
    this.activePageId = store.getActivePageId();

    const saved = store.getWindowBounds();
    this.win = new BrowserWindow({
      width: saved?.width ?? 1280,
      height: saved?.height ?? 860,
      ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: 900,
      minHeight: 560,
      // macOS: fully transparent paint background so the vibrancy material
      // shows through the chrome. The page itself sits in an opaque
      // WebContentsView, so only the sidebar / bars / panels get the glass
      // treatment. With themeSource forced to light, 'sidebar' renders as
      // bright frosted glass.
      // Windows / Linux: no vibrancy exists, so paint a solid warm paper
      // behind the same rgba() tints — the CSS is designed to read as a cream
      // theme without the glass. A native frame supplies the window controls.
      ...(IS_MAC
        ? {
            backgroundColor: '#00000000',
            vibrancy: 'sidebar' as const,
            visualEffectState: 'active' as const,
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 16, y: 17 },
          }
        : {
            backgroundColor: '#ede6d8',
            // Dev-time window/taskbar icon; packaged builds embed it in the
            // exe (build/ is not shipped inside the asar).
            ...(app.isPackaged
              ? {}
              : { icon: join(__dirname, '..', '..', 'build', 'icon-1024.png') }),
          }),
      show: false,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

    // The chrome is a local file:// page and must never navigate anywhere.
    // A stray link there would replace the whole UI with a web page.
    this.win.webContents.on('will-navigate', (event) => event.preventDefault());
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.newPage(url);
      return { action: 'deny' };
    });

    this.win.once('ready-to-show', () => this.win?.show());

    // Materialize the previously active page only once the chrome is on screen.
    this.win.webContents.on('did-finish-load', () => {
      this.syncActivePage();
      this.syncAi();
      this.syncAiGrid();
      this.emitLanes();
      this.emitNav();
      this.emitAi();
      this.emitAiGrid();
    });

    this.win.on('resize', () => this.persistBounds());
    this.win.on('move', () => this.persistBounds());

    this.win.on('closed', () => {
      store.flushBookmarks();
      // Detached views are not owned by the window, so closing it does not free
      // them. On macOS the app outlives the window (reopened via dock), so
      // without this every close would leak its page and AI chat renderers.
      for (const live of this.views.values()) {
        if (!live.view.webContents.isDestroyed()) live.view.webContents.close();
      }
      for (const view of this.aiViews.values()) {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }
      this.views.clear();
      this.aiViews.clear();
      this.attached = null;
      this.aiAttached = null;
      this.aiGridAttached.clear();
      // A drag in progress when the window closed must not leave syncAi/syncAiGrid
      // wedged off for the next window.
      this.resizing = false;
      this.gridResizing = false;
      this.win = null;
    });

    return this.win;
  }

  /** True while the main chrome window is alive (OAuth popups don't count). */
  hasWindow(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  private persistBounds(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    store.setWindowBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }

  private persistLanes(): void {
    store.setLanes(this.lanes);
  }

  private persistPages(): void {
    store.setPages(this.pages);
    store.setActivePageId(this.activePageId);
  }

  // -------------------------------------------------------------------------
  // Emitting state to the chrome renderer
  // -------------------------------------------------------------------------

  private send(channel: EventChannel, payload: unknown): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  state(): ChromeState {
    return {
      lanes: this.lanes,
      pages: this.pages,
      activePageId: this.activePageId,
      clipPanelOpen: store.getClipPanelOpen(),
      notesPanelOpen: store.getNotesPanelOpen(),
      sidebarCollapsed: store.getSidebarCollapsed(),
      ai: this.aiState(),
      aiGrid: this.aiGridState(),
    };
  }

  private aiState(): AiState {
    return {
      open: store.getAiPanelOpen(),
      service: store.getAiService(),
      width: store.getAiPanelWidth(),
    };
  }

  private aiGridState(): AiGridState {
    return {
      open: store.getAiGridOpen(),
      services: store.getAiGridServices(),
      broadcastSubmit: store.getAiGridBroadcastSubmit(),
    };
  }

  private emitLanes(): void {
    this.send('shiori:lanes', {
      lanes: this.lanes,
      pages: this.pages,
      activePageId: this.activePageId,
    });
  }

  private emitAi(): void {
    this.send('shiori:ai', this.aiState());
  }

  private emitAiGrid(): void {
    this.send('shiori:ai-grid', this.aiGridState());
  }

  private emitNav(): void {
    const live = this.attached;
    if (!live || live.view.webContents.isDestroyed()) {
      this.send('shiori:nav', null);
      return;
    }
    const wc = live.view.webContents;
    const nav: NavState = {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      isLoading: wc.isLoading(),
    };
    this.send('shiori:nav', nav);
  }

  private emitClips(clips: Clip[]): void {
    this.send('shiori:clips', clips);
  }

  bookmarks(): Bookmark[] {
    return store.listBookmarks();
  }

  clips(): Clip[] {
    return store.listClips();
  }

  // -------------------------------------------------------------------------
  // Page / lane lookup
  // -------------------------------------------------------------------------

  private findPage(pageId: string): PageRef | null {
    return this.pages.find((p) => p.id === pageId) ?? null;
  }

  private findLane(laneId: string): Lane | null {
    return this.lanes.find((l) => l.id === laneId) ?? null;
  }

  private findLive(wc: WebContents): LiveView | null {
    for (const live of this.views.values()) {
      if (!live.view.webContents.isDestroyed() && live.view.webContents.id === wc.id) return live;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // View plumbing
  // -------------------------------------------------------------------------

  setRect(rect: PageRect): void {
    // While the grid owns the stage, #page-host is display:none and reports a
    // 0×0 box; ignoring it keeps the parked page's real rect so it reattaches
    // at the right size when the grid closes (mirrors setAiRect's guard).
    if (store.getAiGridOpen()) return;
    this.rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    if (this.attached && !this.attached.view.webContents.isDestroyed()) {
      this.attached.view.setBounds(this.rect);
    }
  }

  private ensureView(page: PageRef): LiveView {
    const existing = this.views.get(page.id);
    if (existing && !existing.view.webContents.isDestroyed()) {
      // Refresh LRU recency: Map preserves insertion order, so re-inserting
      // moves this view to the "newest" end (pruneViews evicts from the front).
      this.views.delete(page.id);
      this.views.set(page.id, existing);
      return existing;
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'page.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.setBackgroundColor('#ffffff');

    const live: LiveView = { pageId: page.id, view, normalizedUrl: normalizeUrl(page.url) };
    this.views.set(page.id, live);
    this.wireView(live);
    // Fire-and-forget: loadURL spins up the renderer the CDP commands need, and
    // the override lands before the page's JS runs (awaiting here would deadlock
    // — CDP waits for the process, the process waits for loadURL).
    void applyChromeIdentity(view.webContents);
    void view.webContents.loadURL(page.url);
    return live;
  }

  /**
   * Window-open policy shared by page views and AI views. A login window
   * (OAuth/OIDC/SAML, IdP, IAM Identity Center…) must stay a real child window
   * so its `window.opener` survives and the provider can post the result back
   * or close the popup — turning it into a standalone page silently breaks
   * sign-in. Everything else Shiori opens as a page (no tabs, no stray popups).
   */
  private authAwareWindowOpen(url: string): Electron.WindowOpenHandlerResponse {
    if (isAuthPopupUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:/i.test(url)) this.newPage(url);
    return { action: 'deny' };
  }

  /**
   * Set up a login popup window: it must present as Chrome too (or providers
   * reject it), and some IdPs bounce through a second popup, so give the child
   * the same identity and the same window-open policy.
   */
  private wireAuthPopup(child: BrowserWindow): void {
    const cwc = child.webContents;
    void applyChromeIdentity(cwc);
    cwc.setWindowOpenHandler(({ url }) => this.authAwareWindowOpen(url));
  }

  private wireView(live: LiveView): void {
    const wc = live.view.webContents;

    // No tabs and no stray popups: a normal window.open becomes an open page,
    // but a login window (OAuth/SSO) stays a real child window so its opener
    // survives and the sign-in callback works.
    wc.setWindowOpenHandler(({ url }) => this.authAwareWindowOpen(url));
    wc.on('did-create-window', (child) => this.wireAuthPopup(child));

    wc.on('page-title-updated', (_event, title) => {
      const page = this.findPage(live.pageId);
      if (!page) return;
      // Sites that tick a counter/clock into an unchanged title must not cost
      // a store write + full sidebar rebuild every second (favicon has the
      // same guard below).
      if (page.title === title) return;
      page.title = title;
      this.persistPages();
      this.emitLanes();
      if (this.attached === live) this.emitNav();
      if (isBookmarkable(live.normalizedUrl)) {
        store.upsertBookmark(live.normalizedUrl, { title });
      }
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      const page = this.findPage(live.pageId);
      const icon = favicons.find((f) => /^https?:/i.test(f));
      if (!page || !icon || page.favicon === icon) return;
      page.favicon = icon;
      this.persistPages();
      this.emitLanes();
    });

    wc.on('did-navigate', (_event, url) => this.onNavigated(live, url));

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // SPA route changes count as a new location, but we deliberately do not
      // re-restore scroll here — that would hijack in-page anchor links.
      if (isMainFrame) this.onNavigated(live, url, false);
    });

    // Right-click menu: save/copy images, open/copy links, copy/paste text.
    wc.on('context-menu', (_event, params) => this.showContextMenu(wc, params));

    // Video fullscreen (YouTube etc.): hide the chrome and let the page fill the
    // whole window, and take the window into OS fullscreen for a true full view.
    wc.on('enter-html-full-screen', () => this.setHtmlFullscreen(true));
    wc.on('leave-html-full-screen', () => this.setHtmlFullscreen(false));

    wc.on('did-start-loading', () => {
      if (this.attached === live) this.emitNav();
    });
    wc.on('did-stop-loading', () => {
      if (this.attached === live) this.emitNav();
    });

    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      live.normalizedUrl = normalizeUrl(url);
      if (!isBookmarkable(url)) return;
      store.upsertBookmark(live.normalizedUrl, { title: wc.getTitle(), lastVisited: Date.now() });
      const mark = store.getBookmark(live.normalizedUrl);
      if (mark && mark.scrollY > 0) {
        wc.send('shiori-page:restore', mark.scrollY);
      }
      this.send('shiori:bookmarks', store.listBookmarks());
    });
  }

  /** Native right-click menu for a page/search view. Image save lives here. */
  private showContextMenu(wc: WebContents, params: Electron.ContextMenuParams): void {
    const items: MenuItemConstructorOptions[] = [];

    if (params.mediaType === 'image' && params.srcURL) {
      const src = params.srcURL;
      items.push(
        { label: '画像を保存…', click: () => !wc.isDestroyed() && wc.downloadURL(src) },
        { label: '画像をコピー', click: () => !wc.isDestroyed() && wc.copyImageAt(params.x, params.y) },
        { type: 'separator' },
      );
    }
    if (params.linkURL) {
      const link = params.linkURL;
      items.push(
        { label: 'リンクを新しいページで開く', click: () => this.newPage(link) },
        { label: 'リンクをコピー', click: () => clipboard.writeText(link) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ label: 'コピー', role: 'copy' });
    }

    if (items.length > 0 && items[items.length - 1]?.type !== 'separator') {
      items.push({ type: 'separator' });
    }
    items.push({ label: '再読み込み', click: () => !wc.isDestroyed() && wc.reload() });

    Menu.buildFromTemplate(items).popup();
  }

  private onNavigated(live: LiveView, url: string, isFullLoad = true): void {
    live.normalizedUrl = normalizeUrl(url);
    const page = this.findPage(live.pageId);
    if (page) {
      page.url = url;
      const title = live.view.webContents.getTitle();
      if (title) page.title = title;
      // A full navigation means the old site's favicon no longer applies;
      // page-favicon-updated will supply the new one shortly.
      if (isFullLoad) page.favicon = undefined;
      this.persistPages();
      this.emitLanes();
    }
    if (this.attached === live) this.emitNav();
  }

  private destroyView(pageId: string): void {
    const live = this.views.get(pageId);
    if (!live) return;
    if (this.attached === live) {
      this.detach();
    }
    this.views.delete(pageId);
    if (!live.view.webContents.isDestroyed()) {
      live.view.webContents.close();
    }
  }

  /**
   * Evict least-recently-used detached views beyond MAX_DETACHED_VIEWS. The
   * page entry itself is untouched — only its renderer process is released;
   * re-activating recreates the view and the bookmark restores the position.
   */
  private pruneViews(): void {
    let detached = 0;
    for (const live of this.views.values()) if (live !== this.attached) detached++;
    if (detached <= MAX_DETACHED_VIEWS) return;
    for (const [pageId, live] of this.views) {
      if (detached <= MAX_DETACHED_VIEWS) break;
      if (live === this.attached) continue;
      // Never evict the active page even if it is momentarily unattached
      // (resize/grid transitions detach without deactivating).
      if (pageId === this.activePageId) continue;
      const wc = live.view.webContents;
      if (wc.isDestroyed()) {
        // Already dead — just drop the stale entry.
        this.views.delete(pageId);
        detached--;
        continue;
      }
      // A page playing sound in the background is being *used*; keep it live.
      if (wc.isCurrentlyAudible()) continue;
      // Only bookmarkable pages restore their scroll on recreation; internal
      // pages (shiori://search) would come back at the top, so keep them.
      if (!isBookmarkable(live.normalizedUrl)) continue;
      this.views.delete(pageId);
      wc.close();
      detached--;
    }
  }

  private detach(): void {
    if (!this.attached) return;
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.removeChildView(this.attached.view);
    }
    this.attached = null;
  }

  /** Bring the active page (or the home screen) on screen. */
  private syncActivePage(): void {
    // The parallel grid owns the whole stage; keep the page view parked (but
    // alive) until the grid closes, whatever the page list does underneath.
    if (store.getAiGridOpen()) {
      this.detach();
      return;
    }
    const pageId = this.activePageId;

    if (!pageId) {
      this.detach();
      this.emitNav();
      return;
    }

    const page = this.findPage(pageId);
    if (!page) {
      this.activePageId = null;
      this.detach();
      this.emitNav();
      return;
    }

    const live = this.ensureView(page);
    if (this.attached === live) {
      live.view.setBounds(this.rect);
      return;
    }
    this.detach();
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.addChildView(live.view);
      live.view.setBounds(this.rect);
      this.attached = live;
    }
    // Activation is the one funnel where recency changes; evict LRU extras now.
    this.pruneViews();
    this.emitNav();
  }

  // -------------------------------------------------------------------------
  // Commands from the chrome
  // -------------------------------------------------------------------------

  navigate(input: string): void {
    const intent = classifyInput(input);
    if (!intent) return;
    // A query becomes a real navigation to Shiori's internal results page, so
    // the whole search flow lives in ordinary page history (‹ / › just work).
    const url =
      intent.kind === 'search'
        ? `shiori://search/?q=${encodeURIComponent(intent.query)}`
        : intent.url;
    // If the grid is up, the URL bar navigation returns to a single page.
    const wasGrid = store.getAiGridOpen();
    this.leaveGrid();
    // After leaving the grid, re-materialize/attach the active page's view so
    // the load below has a live view to target (grid mode skips ensureView).
    if (wasGrid) this.syncActivePage();
    // Navigating with the home screen up opens a new page rather than
    // hijacking whatever was last active.
    if (!this.activePageId) {
      this.newPage(url);
      return;
    }
    const live = this.views.get(this.activePageId);
    if (!live || live.view.webContents.isDestroyed()) {
      this.newPage(url);
      return;
    }
    void live.view.webContents.loadURL(url);
  }

  back(): void {
    const wc = this.attached?.view.webContents;
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(): void {
    const wc = this.attached?.view.webContents;
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  reload(): void {
    const wc = this.attached?.view.webContents;
    if (wc && !wc.isDestroyed()) wc.reload();
  }

  stop(): void {
    const wc = this.attached?.view.webContents;
    if (wc && !wc.isDestroyed()) wc.stop();
  }

  newPage(url?: string): void {
    const target = url ? toNavigableUrl(url) : null;
    if (!target) {
      // "New page" with no URL means: show me the home screen.
      this.goHome();
      return;
    }
    this.leaveGrid();
    const page: PageRef = { id: randomUUID(), url: target, title: target };
    this.pages.push(page);
    this.activePageId = page.id;
    this.persistPages();
    this.emitLanes();
    this.syncActivePage();
  }

  activatePage(pageId: string): void {
    if (!this.findPage(pageId)) return;
    this.leaveGrid();
    this.activePageId = pageId;
    this.persistPages();
    this.emitLanes();
    this.syncActivePage();
  }

  closePage(pageId: string): void {
    const index = this.pages.findIndex((p) => p.id === pageId);
    if (index < 0) return;
    this.pages.splice(index, 1);
    this.destroyView(pageId);

    if (this.activePageId === pageId) {
      const next = this.pages[index] ?? this.pages[index - 1] ?? null;
      this.activePageId = next ? next.id : null;
    }
    this.persistPages();
    this.emitLanes();
    this.syncActivePage();
  }

  /**
   * Reorder a page within the global list. The view is keyed by page id, so the
   * live WebContentsView (and its scroll state) rides along untouched.
   * `beforePageId` is the page to drop in front of (null = append); id-based so
   * it stays correct after the source removal shifts indices.
   */
  movePage(pageId: string, beforePageId: string | null): void {
    if (pageId === beforePageId) return;
    const fromIndex = this.pages.findIndex((p) => p.id === pageId);
    if (fromIndex < 0) return;
    const [page] = this.pages.splice(fromIndex, 1);

    let idx = this.pages.length;
    if (beforePageId) {
      const at = this.pages.findIndex((p) => p.id === beforePageId);
      if (at >= 0) idx = at;
    }
    this.pages.splice(idx, 0, page!);

    this.persistPages();
    this.emitLanes();
  }

  goHome(): void {
    this.leaveGrid();
    this.activePageId = null;
    this.persistPages();
    this.emitLanes();
    this.syncActivePage();
    this.send('shiori:bookmarks', store.listBookmarks());
  }

  // -------------------------------------------------------------------------
  // Lanes (favorite folders) and their pins
  //
  // A lane groups favorite sites by genre. Pins are persistent snapshots — they
  // are never overwritten by navigation, because the pages you browse live in a
  // separate global list. Opening a pin launches (or focuses) a page.
  // -------------------------------------------------------------------------

  /** Returns the new lane's id so the chrome can drop it straight into rename mode. */
  newLane(name: string): string {
    const clean = name.trim() || `レーン ${this.lanes.length + 1}`;
    const lane: Lane = {
      id: randomUUID(),
      name: clean,
      color: LANE_COLORS[this.lanes.length % LANE_COLORS.length]!,
      favorites: [],
    };
    this.lanes.push(lane);
    this.persistLanes();
    this.emitLanes();
    return lane.id;
  }

  renameLane(laneId: string, name: string): void {
    const lane = this.findLane(laneId);
    if (!lane) return;
    const clean = name.trim();
    if (!clean) return;
    lane.name = clean;
    this.persistLanes();
    this.emitLanes();
  }

  deleteLane(laneId: string): void {
    if (this.lanes.length <= 1) return; // always keep one lane alive
    if (!this.findLane(laneId)) return;
    // Pages are global now, so deleting a favorite folder never closes a page.
    this.lanes = this.lanes.filter((l) => l.id !== laneId);
    this.persistLanes();
    this.emitLanes();
  }

  /** Fold or unfold a lane, hiding/showing its pins. */
  toggleLaneCollapsed(laneId: string): void {
    const lane = this.findLane(laneId);
    if (!lane) return;
    lane.collapsed = !lane.collapsed;
    this.persistLanes();
    this.emitLanes();
  }

  /** Pin an open page's current URL into a lane as a favorite (a snapshot). */
  pinFavorite(laneId: string, pageId: string): void {
    const lane = this.findLane(laneId);
    const page = this.findPage(pageId);
    if (!lane || !page) return;
    const key = normalizeUrl(page.url);
    if (lane.favorites.some((f) => normalizeUrl(f.url) === key)) return; // no dupes
    lane.favorites.push({ url: page.url, title: page.title || page.url, favicon: page.favicon });
    // Unfold the lane so the freshly pinned favorite is actually visible.
    lane.collapsed = false;
    this.persistLanes();
    this.emitLanes();
  }

  /** Open a pinned favorite as a page — focusing an existing one if present. */
  openFavorite(url: string): void {
    const key = normalizeUrl(url);
    const existing = this.pages.find((p) => normalizeUrl(p.url) === key);
    if (existing) {
      this.activatePage(existing.id);
      return;
    }
    this.newPage(url);
  }

  removeFavorite(laneId: string, url: string): void {
    const lane = this.findLane(laneId);
    if (!lane) return;
    const key = normalizeUrl(url);
    lane.favorites = lane.favorites.filter((f) => normalizeUrl(f.url) !== key);
    this.persistLanes();
    this.emitLanes();
  }

  /** Reorder a pin within its lane, or move it to another lane. */
  moveFavorite(laneId: string, url: string, targetLaneId: string, beforeUrl: string | null): void {
    // Dropping a pin onto itself is a no-op (mirrors movePage's self guard).
    if (laneId === targetLaneId && normalizeUrl(url) === normalizeUrl(beforeUrl ?? '')) return;
    const from = this.findLane(laneId);
    const to = this.findLane(targetLaneId);
    if (!from || !to) return;
    const key = normalizeUrl(url);
    const fromIndex = from.favorites.findIndex((f) => normalizeUrl(f.url) === key);
    if (fromIndex < 0) return;
    const [fav] = from.favorites.splice(fromIndex, 1);
    // Moving into a lane that already has this URL would duplicate it — drop.
    if (from.id !== to.id && to.favorites.some((f) => normalizeUrl(f.url) === key)) {
      this.persistLanes();
      this.emitLanes();
      return;
    }
    let idx = to.favorites.length;
    if (beforeUrl) {
      const at = to.favorites.findIndex((f) => normalizeUrl(f.url) === normalizeUrl(beforeUrl));
      if (at >= 0) idx = at;
    }
    to.favorites.splice(idx, 0, fav!);
    this.persistLanes();
    this.emitLanes();
  }

  // -------------------------------------------------------------------------
  // AI side panel
  //
  // Not an agent: each service is a plain, logged-in web session to the
  // official chat site, docked next to the page. Views are kept alive while
  // detached so the conversation survives closing the panel.
  // -------------------------------------------------------------------------

  setAiRect(rect: PageRect): void {
    // In grid mode the same views are positioned by setAiGridRects; a stale
    // single-panel rect must not yank one of them back to the side.
    if (store.getAiGridOpen()) return;
    this.aiRect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    if (this.aiAttached && !this.resizing) {
      const view = this.aiViews.get(this.aiAttached);
      if (view && !view.webContents.isDestroyed()) view.setBounds(this.aiRect);
    }
  }

  private ensureAiView(service: AiService): WebContentsView {
    const existing = this.aiViews.get(service);
    if (existing && !existing.webContents.isDestroyed()) return existing;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.setBackgroundColor('#ffffff');

    const wc = view.webContents;
    // Same policy as page views: login windows stay real popups (with a live
    // opener), everything else a chat answer links to lands in a reading page.
    wc.setWindowOpenHandler(({ url }) => this.authAwareWindowOpen(url));
    wc.on('did-create-window', (child) => this.wireAuthPopup(child));

    // Smoke/shot runs point the panel at a loopback (or about:blank) instead of
    // the network. Honored only in development: a packaged app must never let an
    // env var redirect "ChatGPT" at an arbitrary page (phishing).
    const override = process.env.SHIORI_AI_URL;
    const url = override && !app.isPackaged ? override : AI_SERVICES[service].url;
    void applyChromeIdentity(wc);
    void wc.loadURL(url);
    this.aiViews.set(service, view);
    return view;
  }

  private detachAi(): void {
    if (!this.aiAttached) return;
    const view = this.aiViews.get(this.aiAttached);
    if (view && this.win && !this.win.isDestroyed()) {
      this.win.contentView.removeChildView(view);
    }
    this.aiAttached = null;
  }

  /** Bring the stored panel state on screen (or take it off). */
  private syncAi(): void {
    if (this.resizing) return;
    if (!this.win || this.win.isDestroyed()) return;
    if (!store.getAiPanelOpen()) {
      this.detachAi();
      return;
    }
    const service = store.getAiService();
    const view = this.ensureAiView(service);
    if (this.aiAttached === service) {
      view.setBounds(this.aiRect);
      return;
    }
    this.detachAi();
    this.win.contentView.addChildView(view);
    view.setBounds(this.aiRect);
    this.aiAttached = service;
  }

  openAi(service: AiService): void {
    if (!Object.prototype.hasOwnProperty.call(AI_SERVICES, service)) return;
    // The single panel and the grid fight over the same view; leave the grid
    // and bring the parked reading page back (syncAi only handles the panel).
    if (store.getAiGridOpen()) {
      store.setAiGridOpen(false);
      this.syncAiGrid();
      this.syncActivePage();
      this.emitAiGrid();
    }
    store.setAiService(service);
    store.setAiPanelOpen(true);
    // The right side hosts one panel at a time.
    if (store.getClipPanelOpen()) this.setClipPanel(false);
    this.closeNotesPanel();
    this.syncAi();
    this.emitAi();
  }

  closeAi(): void {
    store.setAiPanelOpen(false);
    this.syncAi();
    this.emitAi();
  }

  toggleAi(): void {
    if (store.getAiPanelOpen()) {
      this.closeAi();
    } else {
      this.openAi(store.getAiService());
    }
  }

  reloadAi(): void {
    const view = this.aiViews.get(store.getAiService());
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
  }

  /** Open one service's live chat as a normal page in the active lane. */
  private promoteAiService(service: AiService): void {
    const view = this.aiViews.get(service);
    const current = view && !view.webContents.isDestroyed() ? view.webContents.getURL() : '';
    const url = /^https?:/i.test(current) ? current : AI_SERVICES[service].url;
    this.newPage(url);
  }

  /** Promote the docked chat to a normal page in the active lane. */
  openAiAsPage(): void {
    const service = store.getAiService();
    this.closeAi();
    this.promoteAiService(service);
  }

  /**
   * Panel resize is a drag in the chrome, but native WebContentsViews float
   * above the chrome and eat mouse events. So for the duration of the drag both
   * views are lifted off; the renderer then sees every mousemove, and the views
   * come back at their new bounds on release.
   */
  aiResize(phase: 'start' | 'end' | 'cancel', width?: number): void {
    if (phase === 'start') {
      this.resizing = true;
      this.detach();
      this.detachAi();
      return;
    }
    this.resizing = false;
    if (phase === 'end' && typeof width === 'number' && Number.isFinite(width)) {
      store.setAiPanelWidth(width);
    }
    this.syncActivePage();
    this.syncAi();
    this.emitAi();
  }

  // -------------------------------------------------------------------------
  // Parallel AI grid
  //
  // Several chat services tiled across the whole stage at once. The tiles are
  // the very same aiViews the side panel uses (so a conversation carries over),
  // just several attached together and positioned from the renderer's measured
  // tile rects. The broadcast bar fans one prompt out to every composer — a
  // user keystroke multiplied, not an agent: no reply is ever read back.
  // -------------------------------------------------------------------------

  /**
   * Bring the grid on screen (or take it off). Attaches one view per service in
   * `aiGridServices`; bounds are set from the renderer's tile rects that arrive
   * right after (setAiGridRects). Idempotent — safe to call on every change.
   */
  private syncAiGrid(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.gridResizing) return;

    const detachAll = (): void => {
      for (const service of this.aiGridAttached) {
        const view = this.aiViews.get(service);
        if (view && this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      }
      this.aiGridAttached.clear();
    };

    if (!store.getAiGridOpen()) {
      detachAll();
      return;
    }

    // The grid takes the whole stage: park the page and the single panel (both
    // stay alive), and drop the single-panel flag so it doesn't fight for a view.
    this.detach();
    this.detachAi();
    if (store.getAiPanelOpen()) {
      store.setAiPanelOpen(false);
      this.emitAi();
    }

    const desired = store.getAiGridServices();
    const desiredSet = new Set(desired);
    // Remove tiles no longer wanted.
    for (const service of [...this.aiGridAttached]) {
      if (desiredSet.has(service)) continue;
      const view = this.aiViews.get(service);
      if (view && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      this.aiGridAttached.delete(service);
    }
    // Add newly-wanted tiles at their last-known rect (0-size until measured).
    for (const service of desired) {
      if (this.aiGridAttached.has(service)) continue;
      const view = this.ensureAiView(service);
      this.win.contentView.addChildView(view);
      view.setBounds(this.aiGridRects.get(service) ?? { x: 0, y: 0, width: 0, height: 0 });
      this.aiGridAttached.add(service);
    }
  }

  /** Position each attached tile over its measured DOM box (rect-following). */
  setAiGridRects(list: AiGridRect[]): void {
    for (const entry of list) {
      this.aiGridRects.set(entry.service, {
        x: Math.round(entry.rect.x),
        y: Math.round(entry.rect.y),
        width: Math.max(0, Math.round(entry.rect.width)),
        height: Math.max(0, Math.round(entry.rect.height)),
      });
    }
    if (!store.getAiGridOpen() || this.gridResizing) return;
    if (!this.win || this.win.isDestroyed()) return;
    for (const entry of list) {
      if (!this.aiGridAttached.has(entry.service)) continue;
      const view = this.aiViews.get(entry.service);
      const rect = this.aiGridRects.get(entry.service);
      if (view && rect && !view.webContents.isDestroyed()) view.setBounds(rect);
    }
  }

  openAiGrid(services?: AiService[]): void {
    if (services && services.length > 0) store.setAiGridServices(services);
    store.setAiGridOpen(true);
    // The grid owns the stage; the clip panel steps aside (setClipPanel also
    // closes the single AI panel, and syncAiGrid drops it too).
    if (store.getClipPanelOpen()) this.setClipPanel(false);
    this.syncAiGrid();
    this.emitAiGrid();
  }

  closeAiGrid(): void {
    store.setAiGridOpen(false);
    this.syncAiGrid();
    // Give the reading stage back (the parked page or the home screen).
    this.syncActivePage();
    this.emitNav();
    this.emitAiGrid();
  }

  /**
   * Leave the grid so a page can take the stage. Used by the page-action paths
   * (open a page/pin, new page, navigate, home): with the grid covering the
   * whole stage, activating a page would otherwise just park it invisibly.
   * The caller runs syncActivePage afterwards to attach the page.
   */
  private leaveGrid(): void {
    if (!store.getAiGridOpen()) return;
    store.setAiGridOpen(false);
    this.syncAiGrid();
    this.emitAiGrid();
  }

  toggleAiGrid(): void {
    if (store.getAiGridOpen()) this.closeAiGrid();
    else this.openAiGrid();
  }

  setAiGridServices(services: AiService[]): void {
    store.setAiGridServices(services);
    if (store.getAiGridOpen()) this.syncAiGrid();
    this.emitAiGrid();
  }

  reloadAiTile(service: AiService): void {
    if (!Object.prototype.hasOwnProperty.call(AI_SERVICES, service)) return;
    const view = this.aiViews.get(service);
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
  }

  /** Promote one tile's chat to a page and leave the grid (done comparing). */
  promoteAiTile(service: AiService): void {
    if (!Object.prototype.hasOwnProperty.call(AI_SERVICES, service)) return;
    this.closeAiGrid();
    this.promoteAiService(service);
  }

  setBroadcastSubmit(submit: boolean): void {
    store.setAiGridBroadcastSubmit(submit);
    this.emitAiGrid();
  }

  /**
   * Fan the user's prompt out to every tile: focus each composer and type the
   * text in (via insertText, so it lands in React-controlled inputs), then —
   * only if `submit` — press the site's send. Best-effort and silent on
   * failure: a changed selector falls back to a generic composer, then to
   * merely focusing the tile. The text is inserted, never interpolated into
   * page script, so there is no injection surface.
   */
  async broadcast(text: string, submit: boolean): Promise<void> {
    if (!text.trim()) return;
    const results: BroadcastResult[] = [];
    for (const service of store.getAiGridServices()) {
      const view = this.aiViews.get(service);
      if (!view || view.webContents.isDestroyed()) {
        results.push({ service, status: 'missed' });
        continue;
      }
      const wc = view.webContents;
      const spec = AI_COMPOSERS[service];
      try {
        const focused = await wc.executeJavaScript(focusComposerSource(spec.composer), true);
        if (!focused) {
          results.push({ service, status: 'missed' });
          continue;
        }
        await wc.insertText(text);
        if (submit) {
          const clicked = await wc
            .executeJavaScript(clickSubmitSource(spec.submit), true)
            .catch(() => false);
          if (!clicked) this.sendEnter(wc);
          results.push({ service, status: 'sent' });
        } else {
          results.push({ service, status: 'filled' });
        }
      } catch {
        results.push({ service, status: 'missed' });
      }
    }
    this.send('shiori:ai-broadcast-result', results);
  }

  private sendEnter(wc: WebContents): void {
    if (wc.isDestroyed()) return;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  }

  // -------------------------------------------------------------------------
  // Sidebar
  // -------------------------------------------------------------------------

  setSidebar(collapsed: boolean): void {
    store.setSidebarCollapsed(collapsed);
    this.send('shiori:sidebar', collapsed);
  }

  /**
   * Enter/leave page fullscreen. The renderer hides all chrome and drops the
   * page-host inset to 0, which (via the usual rect-following) makes the active
   * WebContentsView cover the whole window. We also take the window itself into
   * OS fullscreen — but only restore it on exit if we were the ones who set it,
   * so we never yank the user out of a fullscreen they chose themselves.
   */
  private setHtmlFullscreen(on: boolean): void {
    if (this.htmlFullscreen === on) return;
    this.htmlFullscreen = on;
    this.send('shiori:fullscreen', on);
    if (!this.win || this.win.isDestroyed()) return;
    if (on) {
      if (!this.win.isFullScreen()) {
        this.ownedWindowFullscreen = true;
        this.win.setFullScreen(true);
      }
    } else if (this.ownedWindowFullscreen) {
      this.ownedWindowFullscreen = false;
      this.win.setFullScreen(false);
    }
  }

  toggleSidebar(): void {
    this.setSidebar(!store.getSidebarCollapsed());
  }

  // -------------------------------------------------------------------------
  // Bookmarks
  // -------------------------------------------------------------------------

  openBookmark(url: string): void {
    // Same behaviour as opening a favorite: focus the page if it's already open.
    this.openFavorite(url);
  }

  deleteBookmark(url: string): void {
    store.deleteBookmark(url);
    this.send('shiori:bookmarks', store.listBookmarks());
  }

  // -------------------------------------------------------------------------
  // Reports from page preloads
  // -------------------------------------------------------------------------

  handleScroll(sender: WebContents, report: ScrollReport): void {
    const live = this.findLive(sender);
    if (!live || !isBookmarkable(live.normalizedUrl)) return;
    const page = this.findPage(live.pageId);
    const mark = store.upsertBookmark(live.normalizedUrl, {
      title: page?.title || sender.getTitle(),
      scrollY: report.scrollY,
      progress: report.progress,
      docHeight: report.docHeight,
      lastVisited: Date.now(),
    });
    this.send('shiori:progress', {
      pageId: live.pageId,
      progress: mark.progress,
      maxProgress: mark.maxProgress,
    });
  }

  handleCopy(sender: WebContents, report: CopyReport): void {
    const live = this.findLive(sender);
    if (!live) return;
    const clip: Clip = {
      id: randomUUID(),
      text: report.text,
      url: sender.getURL(),
      title: sender.getTitle() || sender.getURL(),
      createdAt: Date.now(),
    };
    const clips = store.addClip(clip);
    this.emitClips(clips);
    // A clip you can't see isn't obviously a feature — surface the panel.
    // Unless another right panel (AI or memo) is in use: stealing it mid-task
    // would be worse, so the badge on the ❝ button carries the news instead.
    if (!store.getClipPanelOpen() && !store.getAiPanelOpen() && !store.getNotesPanelOpen()) {
      this.setClipPanel(true);
    }
  }

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------

  setClipPanel(open: boolean): void {
    // Opening the clip panel leaves the grid and restores the reading stage.
    if (open && store.getAiGridOpen()) {
      store.setAiGridOpen(false);
      this.syncAiGrid();
      this.syncActivePage();
      this.emitAiGrid();
    }
    store.setClipPanelOpen(open);
    // The right side hosts one panel at a time.
    if (open && store.getAiPanelOpen()) {
      store.setAiPanelOpen(false);
      this.syncAi();
      this.emitAi();
    }
    if (open) this.closeNotesPanel();
    // The renderer owns panel layout; it will report a new page rect once the
    // panel has actually resized, which is what moves the WebContentsView.
    this.send('shiori:clip-panel', open);
  }

  // -------------------------------------------------------------------------
  // Memo panel: TODO list + free-form memo
  //
  // Pure chrome (no WebContentsView) — a scratchpad that lives beside whatever
  // you are reading. Shares the "one right panel at a time" rule with clips/AI.
  // -------------------------------------------------------------------------

  notes(): NotesState {
    return { todos: store.listTodos(), memo: store.getMemo() };
  }

  private closeNotesPanel(): void {
    if (!store.getNotesPanelOpen()) return;
    store.setNotesPanelOpen(false);
    this.send('shiori:notes-panel', false);
  }

  setNotesPanel(open: boolean): void {
    store.setNotesPanelOpen(open);
    if (open) {
      // The right side hosts one panel at a time (the grid is orthogonal).
      if (store.getClipPanelOpen()) this.setClipPanel(false);
      if (store.getAiPanelOpen()) this.closeAi();
    }
    this.send('shiori:notes-panel', open);
  }

  toggleNotesPanel(): void {
    this.setNotesPanel(!store.getNotesPanelOpen());
  }

  /** Persist a new todo list and push it to the chrome, so the panel repaints
   *  no matter where the change came from. */
  private commitTodos(next: TodoItem[]): TodoItem[] {
    store.setTodos(next);
    this.send('shiori:todos', next);
    return next;
  }

  addTodo(text: string): TodoItem[] {
    const clean = text.trim();
    if (!clean) return store.listTodos();
    const todo: TodoItem = { id: randomUUID(), text: clean, done: false, createdAt: Date.now() };
    // Newest at the bottom; cap so a runaway list can't bloat the store.
    return this.commitTodos([...store.listTodos(), todo].slice(-500));
  }

  toggleTodo(id: string): TodoItem[] {
    return this.commitTodos(store.listTodos().map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  deleteTodo(id: string): TodoItem[] {
    return this.commitTodos(store.listTodos().filter((t) => t.id !== id));
  }

  clearDoneTodos(): TodoItem[] {
    return this.commitTodos(store.listTodos().filter((t) => !t.done));
  }

  setMemo(text: string): void {
    store.setMemo(typeof text === 'string' ? text : '');
  }

  copyClip(id: string): void {
    const clip = store.listClips().find((c) => c.id === id);
    if (!clip) return;
    clipboard.writeText(markdownQuote(clip));
  }

  copyAllClips(): void {
    const clips = store.listClips();
    if (clips.length === 0) return;
    clipboard.writeText(clips.map(markdownQuote).join('\n'));
  }

  deleteClip(id: string): void {
    this.emitClips(store.deleteClip(id));
  }

  clearClips(): void {
    this.emitClips(store.clearClips());
  }

  focusUrlBar(): void {
    this.send('shiori:focus-urlbar', null);
  }
}

/**
 * Page-side script that finds a chat site's composer, focuses it, and selects
 * any existing draft so the subsequent insertText replaces rather than appends.
 * Returns true if a composer was found. Selectors are injected as a JSON array
 * literal; the prompt text never enters this string (it goes via insertText).
 */
function focusComposerSource(selectors: string[]): string {
  return `(function(sels){
    function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>4 && r.height>4 && s.visibility!=='hidden' && s.display!=='none'; }
    var el=null;
    for(var i=0;i<sels.length && !el;i++){ var list=document.querySelectorAll(sels[i]); for(var j=0;j<list.length;j++){ if(vis(list[j])){ el=list[j]; break; } } }
    if(!el) return false;
    try { el.focus(); } catch(e){}
    try {
      if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){ el.select(); }
      else { var r=document.createRange(); r.selectNodeContents(el); var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    } catch(e){}
    return true;
  })(${JSON.stringify(selectors)})`;
}

/** Page-side script that clicks the first visible, enabled send button. */
function clickSubmitSource(selectors: string[]): string {
  return `(function(sels){
    function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; }
    for(var i=0;i<sels.length;i++){ var list=document.querySelectorAll(sels[i]); for(var j=0;j<list.length;j++){ var b=list[j]; if(vis(b) && !b.disabled){ b.click(); return true; } } }
    return false;
  })(${JSON.stringify(selectors)})`;
}

/** A blockquote plus its provenance — the whole point of the clip panel. */
export function markdownQuote(clip: Clip): string {
  const body = clip.text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
  const when = new Date(clip.createdAt).toLocaleString('ja-JP');
  return `${body}\n>\n> — [${clip.title}](${clip.url}) — ${when}\n`;
}
