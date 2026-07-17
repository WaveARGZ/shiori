import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, WebContentsView, clipboard, type WebContents } from 'electron';
import * as store from './store';
import { isBookmarkable, normalizeUrl, toNavigableUrl } from './url';
import type {
  Bookmark,
  ChromeState,
  Clip,
  CopyReport,
  EventChannel,
  Lane,
  NavState,
  PageRect,
  PageRef,
  ScrollReport,
} from '../shared/types';

const LANE_COLORS = ['#7c9cff', '#ffb86c', '#7ee787', '#ff7b9c', '#c4a6ff', '#66d9e8'];

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
  private lanes: Lane[] = [];
  private activeLaneId = '';

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  create(): BrowserWindow {
    this.lanes = store.getLanes();
    this.activeLaneId = store.getActiveLaneId();

    const saved = store.getWindowBounds();
    this.win = new BrowserWindow({
      width: saved?.width ?? 1280,
      height: saved?.height ?? 860,
      ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: 900,
      minHeight: 560,
      backgroundColor: '#101118',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
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
      this.emitLanes();
      this.emitNav();
    });

    this.win.on('resize', () => this.persistBounds());
    this.win.on('move', () => this.persistBounds());

    this.win.on('closed', () => {
      store.flushBookmarks();
      this.views.clear();
      this.attached = null;
      this.win = null;
    });

    return this.win;
  }

  private persistBounds(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    store.setWindowBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }

  private persistLanes(): void {
    store.setLanes(this.lanes);
    store.setActiveLaneId(this.activeLaneId);
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
      activeLaneId: this.activeLaneId,
      clipPanelOpen: store.getClipPanelOpen(),
    };
  }

  private emitLanes(): void {
    this.send('shiori:lanes', { lanes: this.lanes, activeLaneId: this.activeLaneId });
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
  // Lane / page lookup
  // -------------------------------------------------------------------------

  private activeLane(): Lane {
    const lane = this.lanes.find((l) => l.id === this.activeLaneId);
    if (lane) return lane;
    // Defensive: never let the app end up with no active lane.
    const first = this.lanes[0]!;
    this.activeLaneId = first.id;
    return first;
  }

  private findPage(pageId: string): { lane: Lane; page: PageRef } | null {
    for (const lane of this.lanes) {
      const page = lane.pages.find((p) => p.id === pageId);
      if (page) return { lane, page };
    }
    return null;
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
    if (existing && !existing.view.webContents.isDestroyed()) return existing;

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
    void view.webContents.loadURL(page.url);
    return live;
  }

  private wireView(live: LiveView): void {
    const wc = live.view.webContents;

    // Shiori has no tabs and no popups: everything becomes a page in the lane.
    wc.setWindowOpenHandler(({ url }) => {
      this.newPage(url);
      return { action: 'deny' };
    });

    wc.on('page-title-updated', (_event, title) => {
      const found = this.findPage(live.pageId);
      if (!found) return;
      found.page.title = title;
      this.persistLanes();
      this.emitLanes();
      if (this.attached === live) this.emitNav();
      if (isBookmarkable(live.normalizedUrl)) {
        store.upsertBookmark(live.normalizedUrl, { title });
      }
    });

    wc.on('did-navigate', (_event, url) => this.onNavigated(live, url));

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // SPA route changes count as a new location, but we deliberately do not
      // re-restore scroll here — that would hijack in-page anchor links.
      if (isMainFrame) this.onNavigated(live, url, false);
    });

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

  private onNavigated(live: LiveView, url: string, _isFullLoad = true): void {
    live.normalizedUrl = normalizeUrl(url);
    const found = this.findPage(live.pageId);
    if (found) {
      found.page.url = url;
      const title = live.view.webContents.getTitle();
      if (title) found.page.title = title;
      this.persistLanes();
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

  private detach(): void {
    if (!this.attached) return;
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.removeChildView(this.attached.view);
    }
    this.attached = null;
  }

  /** Bring the current lane's active page (or the home screen) on screen. */
  private syncActivePage(): void {
    const lane = this.activeLane();
    const pageId = lane.activePageId;

    if (!pageId) {
      this.detach();
      this.emitNav();
      return;
    }

    const page = lane.pages.find((p) => p.id === pageId);
    if (!page) {
      lane.activePageId = null;
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
    this.emitNav();
  }

  // -------------------------------------------------------------------------
  // Commands from the chrome
  // -------------------------------------------------------------------------

  navigate(input: string): void {
    const url = toNavigableUrl(input);
    if (!url) return;
    const lane = this.activeLane();
    // Navigating with the home screen up opens a new page rather than
    // hijacking whatever was last active.
    if (!lane.activePageId) {
      this.newPage(url);
      return;
    }
    const live = this.views.get(lane.activePageId);
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
    const lane = this.activeLane();
    const page: PageRef = { id: randomUUID(), url: target, title: target };
    lane.pages.push(page);
    lane.activePageId = page.id;
    this.persistLanes();
    this.emitLanes();
    this.syncActivePage();
  }

  activatePage(pageId: string): void {
    const found = this.findPage(pageId);
    if (!found) return;
    if (found.lane.id !== this.activeLaneId) {
      this.activeLaneId = found.lane.id;
    }
    found.lane.activePageId = pageId;
    this.persistLanes();
    this.emitLanes();
    this.syncActivePage();
  }

  closePage(pageId: string): void {
    const found = this.findPage(pageId);
    if (!found) return;
    const { lane, page } = found;
    const index = lane.pages.indexOf(page);
    lane.pages.splice(index, 1);
    this.destroyView(pageId);

    if (lane.activePageId === pageId) {
      const next = lane.pages[index] ?? lane.pages[index - 1] ?? null;
      lane.activePageId = next ? next.id : null;
    }
    this.persistLanes();
    this.emitLanes();
    if (lane.id === this.activeLaneId) this.syncActivePage();
  }

  goHome(): void {
    const lane = this.activeLane();
    lane.activePageId = null;
    this.persistLanes();
    this.emitLanes();
    this.syncActivePage();
    this.send('shiori:bookmarks', store.listBookmarks());
  }

  // -------------------------------------------------------------------------
  // Lanes
  // -------------------------------------------------------------------------

  /** Returns the new lane's id so the chrome can drop it straight into rename mode. */
  newLane(name: string): string {
    const clean = name.trim() || `レーン ${this.lanes.length + 1}`;
    const lane: Lane = {
      id: randomUUID(),
      name: clean,
      color: LANE_COLORS[this.lanes.length % LANE_COLORS.length]!,
      pages: [],
      activePageId: null,
    };
    this.lanes.push(lane);
    this.activeLaneId = lane.id;
    this.persistLanes();
    this.emitLanes();
    this.syncActivePage();
    return lane.id;
  }

  renameLane(laneId: string, name: string): void {
    const lane = this.lanes.find((l) => l.id === laneId);
    if (!lane) return;
    const clean = name.trim();
    if (!clean) return;
    lane.name = clean;
    this.persistLanes();
    this.emitLanes();
  }

  deleteLane(laneId: string): void {
    if (this.lanes.length <= 1) return; // always keep one lane alive
    const lane = this.lanes.find((l) => l.id === laneId);
    if (!lane) return;
    for (const page of lane.pages) this.destroyView(page.id);
    this.lanes = this.lanes.filter((l) => l.id !== laneId);
    if (this.activeLaneId === laneId) {
      this.activeLaneId = this.lanes[0]!.id;
    }
    this.persistLanes();
    this.emitLanes();
    this.syncActivePage();
  }

  activateLane(laneId: string): void {
    if (!this.lanes.some((l) => l.id === laneId)) return;
    if (this.activeLaneId === laneId) return;
    this.activeLaneId = laneId;
    this.persistLanes();
    this.emitLanes();
    this.syncActivePage();
  }

  // -------------------------------------------------------------------------
  // Bookmarks
  // -------------------------------------------------------------------------

  openBookmark(url: string): void {
    const lane = this.activeLane();
    const key = normalizeUrl(url);
    // If this lane already has the page open, just go to it.
    const existing = lane.pages.find((p) => normalizeUrl(p.url) === key);
    if (existing) {
      this.activatePage(existing.id);
      return;
    }
    this.newPage(url);
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
    const found = this.findPage(live.pageId);
    const mark = store.upsertBookmark(live.normalizedUrl, {
      title: found?.page.title || sender.getTitle(),
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
    if (!store.getClipPanelOpen()) this.setClipPanel(true);
  }

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------

  setClipPanel(open: boolean): void {
    store.setClipPanelOpen(open);
    // The renderer owns panel layout; it will report a new page rect once the
    // panel has actually resized, which is what moves the WebContentsView.
    this.send('shiori:clip-panel', open);
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

/** A blockquote plus its provenance — the whole point of the clip panel. */
export function markdownQuote(clip: Clip): string {
  const body = clip.text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
  const when = new Date(clip.createdAt).toLocaleString('ja-JP');
  return `${body}\n>\n> — [${clip.title}](${clip.url}) — ${when}\n`;
}
