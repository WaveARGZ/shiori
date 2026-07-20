// Chrome UI for Shiori.
//
// Loaded as a CLASSIC script: no bundler, no module loader. This file must
// therefore contain NO top-level import/export at all — a single `import type`
// would still mark it as a module, and tsc would emit a bare `export {};` to
// preserve that, which is a SyntaxError in a classic script. Shared types are
// pulled in through `import(...)` type queries instead, which erase completely.
// `npm run check:renderer` fails the build if this ever regresses.
//
// All web-page derived strings (titles, URLs, favicons, clip text) are inserted
// with textContent / validated attribute values — never innerHTML — because
// they are attacker-controlled.
type AiService = import('../shared/types').AiService;
type AiState = import('../shared/types').AiState;
type AiGridState = import('../shared/types').AiGridState;
type BroadcastResult = import('../shared/types').BroadcastResult;
type Bookmark = import('../shared/types').Bookmark;
type ChromeState = import('../shared/types').ChromeState;
type Clip = import('../shared/types').Clip;
type Favorite = import('../shared/types').Favorite;
type Lane = import('../shared/types').Lane;
type LaneState = import('../shared/types').LaneState;
type PageRef = import('../shared/types').PageRef;
type NavState = import('../shared/types').NavState;
type NotesState = import('../shared/types').NotesState;
type TodoItem = import('../shared/types').TodoItem;
type ProgressTick = import('../shared/types').ProgressTick;

const api = window.shiori;

// Platform-specific chrome: the traffic-light spacer only makes sense on
// macOS (titleBarStyle: hiddenInset); Windows has a native frame instead.
const IS_MAC_UI = navigator.platform.startsWith('Mac');
if (!IS_MAC_UI) document.body.classList.add('not-mac');

/** Tooltip shortcut text: mac symbols as-is, Ctrl/Alt/Shift words elsewhere. */
function formatKeys(text: string): string {
  if (IS_MAC_UI) return text;
  return text.replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+');
}

// The static tooltips/placeholders in index.html are written with mac symbols;
// rewrite them once at startup on other platforms (dynamic ones go through
// formatKeys).
if (!IS_MAC_UI) {
  for (const node of document.querySelectorAll<HTMLElement>('[title]')) {
    if (/[⌘⌥⇧]/.test(node.title)) node.title = formatKeys(node.title);
  }
  for (const node of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[placeholder], textarea[placeholder]',
  )) {
    if (/[⌘⌥⇧]/.test(node.placeholder)) node.placeholder = formatKeys(node.placeholder);
  }
}

const AI_LABELS: Record<AiService, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  perplexity: 'Perplexity',
};

/** The icon symbol id in index.html for each service. */
const AI_ICONS: Record<AiService, string> = {
  chatgpt: '#i-chatgpt',
  gemini: '#i-gemini',
  claude: '#i-claude',
  perplexity: '#i-perplexity',
};

/** Canonical tile order for the parallel grid. */
const ALL_SERVICES: AiService[] = ['chatgpt', 'gemini', 'claude', 'perplexity'];

const SVG_NS = 'http://www.w3.org/2000/svg';

const AI_MIN_W = 300;
const AI_MAX_W = 680;

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Shiori: missing #${id}`);
  return node as T;
}

const els = {
  back: need<HTMLButtonElement>('btn-back'),
  forward: need<HTMLButtonElement>('btn-forward'),
  reload: need<HTMLButtonElement>('btn-reload'),
  icReload: need<HTMLElement>('ic-reload'),
  icStop: need<HTMLElement>('ic-stop'),
  home: need<HTMLButtonElement>('btn-home'),
  sidebarBtn: need<HTMLButtonElement>('btn-sidebar'),
  railClips: need<HTMLButtonElement>('rail-clips'),
  railAi: need<HTMLButtonElement>('rail-ai'),
  railHistory: need<HTMLButtonElement>('rail-history'),
  railSettings: need<HTMLButtonElement>('rail-settings'),
  laneCount: need<HTMLSpanElement>('lane-count'),
  pageCount: need<HTMLSpanElement>('page-count'),
  statusbar: need<HTMLElement>('statusbar'),
  statusConn: need<HTMLSpanElement>('status-conn'),
  statusCounts: need<HTMLSpanElement>('status-counts'),
  statusRead: need<HTMLSpanElement>('status-read'),
  url: need<HTMLInputElement>('url'),
  urlProgress: need<HTMLSpanElement>('url-progress'),
  clipsBtn: need<HTMLButtonElement>('btn-clips'),
  clipCount: need<HTMLSpanElement>('clip-count'),
  lanes: need<HTMLDivElement>('lanes'),
  newLane: need<HTMLButtonElement>('btn-new-lane'),
  pages: need<HTMLDivElement>('pages'),
  pageHost: need<HTMLDivElement>('page-host'),
  homeScreen: need<HTMLDivElement>('home'),
  homeSearchForm: need<HTMLFormElement>('home-search-form'),
  homeSearch: need<HTMLInputElement>('home-search'),
  homeList: need<HTMLUListElement>('home-list'),
  homeCount: need<HTMLSpanElement>('home-count'),
  homeEmpty: need<HTMLParagraphElement>('home-empty'),
  clipPanel: need<HTMLElement>('clip-panel'),
  clipList: need<HTMLUListElement>('clip-list'),
  clipEmpty: need<HTMLParagraphElement>('clip-empty'),
  railNotes: need<HTMLButtonElement>('rail-notes'),
  notesPanel: need<HTMLElement>('notes-panel'),
  notesClose: need<HTMLButtonElement>('btn-notes-close'),
  notesTodo: need<HTMLDivElement>('notes-todo'),
  notesMemo: need<HTMLDivElement>('notes-memo'),
  todoForm: need<HTMLFormElement>('todo-form'),
  todoInput: need<HTMLInputElement>('todo-input'),
  todoList: need<HTMLUListElement>('todo-list'),
  todoEmpty: need<HTMLParagraphElement>('todo-empty'),
  todoCount: need<HTMLSpanElement>('todo-count'),
  clearDone: need<HTMLButtonElement>('btn-clear-done'),
  memoInput: need<HTMLTextAreaElement>('memo-input'),
  copyAll: need<HTMLButtonElement>('btn-copy-all'),
  clearClips: need<HTMLButtonElement>('btn-clear-clips'),
  closePanel: need<HTMLButtonElement>('btn-close-panel'),
  aiPanel: need<HTMLElement>('ai-panel'),
  aiStage: need<HTMLDivElement>('ai-stage'),
  aiResizer: need<HTMLDivElement>('ai-resizer'),
  aiTitle: need<HTMLSpanElement>('ai-title'),
  aiReload: need<HTMLButtonElement>('btn-ai-reload'),
  aiPage: need<HTMLButtonElement>('btn-ai-page'),
  aiClose: need<HTMLButtonElement>('btn-ai-close'),
  aiGridBtn: need<HTMLButtonElement>('btn-ai-grid'),
  railGrid: need<HTMLButtonElement>('rail-grid'),
  homeGridBtn: need<HTMLButtonElement>('home-grid-btn'),
  aiGrid: need<HTMLDivElement>('ai-grid'),
  aiTiles: need<HTMLDivElement>('ai-tiles'),
  gridServices: need<HTMLDivElement>('grid-services'),
  gridClose: need<HTMLButtonElement>('grid-close'),
  broadcastForm: need<HTMLFormElement>('ai-broadcast'),
  broadcastInput: need<HTMLInputElement>('broadcast-input'),
  broadcastSubmit: need<HTMLInputElement>('broadcast-submit'),
  broadcastSend: need<HTMLButtonElement>('broadcast-send'),
};

const aiDockButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.ai-btn'));
const aiTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.ai-tab'));
const notesTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.notes-tab'));
const homeAiCards = Array.from(document.querySelectorAll<HTMLButtonElement>('.home-ai-card'));

let lanes: Lane[] = [];
let pages: PageRef[] = [];
let activePageId: string | null = null;
let nav: NavState | null = null;
let bookmarks: Bookmark[] = [];
let clips: Clip[] = [];
let todos: TodoItem[] = [];
let memo = '';
let notesOpen = false;
let notesTab: 'todo' | 'memo' = 'todo';
let memoSaveTimer: number | null = null;
let renamingLaneId: string | null = null;
let aiOpen = false;
let aiService: AiService = 'chatgpt';
let aiWidth = 400;
let aiGridOpen = false;
let aiGridServices: AiService[] = [...ALL_SERVICES];
let aiGridBroadcastSubmit = true;
let sidebarCollapsed = false;
/** Live progress per page id, so a row can show progress before it's stored. */
const progressByPage = new Map<string, number>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

function pct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  return new Date(ts).toLocaleDateString('ja-JP');
}

function isAiService(value: unknown): value is AiService {
  // hasOwnProperty, not `in`: `'toString' in AI_LABELS` is true via the prototype.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_LABELS, value);
}

// ---------------------------------------------------------------------------
// View rects: CSS owns the layout, the main process just follows it.
// ---------------------------------------------------------------------------

function reportRect(): void {
  const r = els.pageHost.getBoundingClientRect();
  api.send('shiori:page-rect', { x: r.left, y: r.top, width: r.width, height: r.height });
}

function reportAiRect(): void {
  const r = els.aiStage.getBoundingClientRect();
  api.send('shiori:ai-rect', { x: r.left, y: r.top, width: r.width, height: r.height });
}

/** Measure every tile's stage box and hand the whole set to the main process. */
function reportGridRects(): void {
  if (!aiGridOpen) return;
  const stages = els.aiTiles.querySelectorAll<HTMLElement>('.ai-tile-stage[data-service]');
  const rects: { service: AiService; rect: { x: number; y: number; width: number; height: number } }[] = [];
  stages.forEach((stage) => {
    const service = stage.dataset.service;
    if (!isAiService(service)) return;
    const r = stage.getBoundingClientRect();
    rects.push({ service, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  });
  if (rects.length > 0) api.send('shiori:ai-grid-rects', rects);
}

new ResizeObserver(reportRect).observe(els.pageHost);
new ResizeObserver(reportAiRect).observe(els.aiStage);
new ResizeObserver(reportGridRects).observe(els.aiTiles);
window.addEventListener('resize', () => {
  reportRect();
  reportAiRect();
  reportGridRects();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderLanes(): void {
  els.lanes.replaceChildren();
  els.laneCount.textContent = String(lanes.length);
  let renameInput: HTMLInputElement | null = null;

  for (const lane of lanes) {
    const group = el('div', 'lane-group');
    group.style.setProperty('--lane-color', lane.color);
    group.dataset.laneId = lane.id;
    if (lane.collapsed) group.classList.add('collapsed');

    // --- lane header (caret / name / count / delete / rename) ---
    if (lane.id === renamingLaneId) {
      const input = el('input', 'chip-input');
      input.value = lane.name;
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          void api.invoke('shiori:rename-lane', { laneId: lane.id, name: input.value });
          renamingLaneId = null;
        } else if (event.key === 'Escape') {
          renamingLaneId = null;
          renderLanes();
        }
      });
      input.addEventListener('blur', () => {
        if (renamingLaneId !== lane.id) return;
        void api.invoke('shiori:rename-lane', { laneId: lane.id, name: input.value });
        renamingLaneId = null;
        renderLanes();
      });
      group.append(input);
      renameInput = input;
    } else {
      const head = el('div', 'lane-head');

      // Disclosure caret: folds/unfolds the lane's pins. Purely visual — the
      // whole header toggles via the delegated click handler on #lanes below,
      // so clicking anywhere on the row (name, count, caret, empty space) folds
      // it, robustly across re-renders (double-click on the name renames).
      const caret = el('button', 'lane-caret');
      caret.title = lane.collapsed ? 'レーンを開く' : 'レーンを畳む';
      caret.append(svgIcon('#i-caret', 'ic sm'));

      const dot = el('span', 'chip-dot');
      dot.style.background = lane.color;
      head.append(caret, dot, el('span', 'chip-label', lane.name));
      head.append(el('span', 'chip-count', String(lane.favorites.length).padStart(2, '0')));

      if (lanes.length > 1) {
        const x = el('span', 'chip-x', '×');
        x.title = 'このレーンを削除';
        x.addEventListener('click', (event) => {
          event.stopPropagation();
          void api.invoke('shiori:delete-lane', { laneId: lane.id });
        });
        head.append(x);
      }
      group.append(head);
    }

    // --- pins (hidden while folded) ---
    if (!lane.collapsed) {
      const pinsBox = el('div', 'lane-pins');
      for (const fav of lane.favorites) pinsBox.append(renderPin(lane, fav));
      if (lane.favorites.length === 0) {
        pinsBox.append(el('span', 'lane-empty', 'ページをここへドラッグしてピン留め'));
      }
      group.append(pinsBox);
    }

    wireLaneDrop(group, lane);
    els.lanes.append(group);
  }

  if (renameInput) {
    renameInput.focus();
    renameInput.select();
  }
}

/** One favorite pin: click opens it as a page, × removes it, drag reorders/moves. */
function renderPin(lane: Lane, fav: Favorite): HTMLButtonElement {
  const pin = el('button', 'pin');
  pin.dataset.url = fav.url;
  pin.draggable = true;
  pin.append(faviconFor(fav.url, fav.favicon));
  pin.append(el('span', 'pin-label', fav.title || hostOf(fav.url)));

  const x = el('span', 'chip-x', '×');
  x.title = 'ピンを外す';
  x.addEventListener('click', (event) => {
    event.stopPropagation();
    void api.invoke('shiori:remove-favorite', { laneId: lane.id, url: fav.url });
  });
  pin.append(x);

  pin.addEventListener('click', () => {
    if (draggingFav) return;
    void api.invoke('shiori:open-favorite', { url: fav.url });
  });

  pin.addEventListener('dragstart', (event) => {
    draggingFav = { laneId: lane.id, url: fav.url };
    pin.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.setData(DRAG_FAV, JSON.stringify(draggingFav));
      event.dataTransfer.effectAllowed = 'move';
    }
    event.stopPropagation();
  });
  pin.addEventListener('dragend', () => {
    draggingFav = null;
    pin.classList.remove('dragging');
    clearDropMarks();
    flushSidebar();
  });
  // Reorder: drop another pin in front of this one.
  pin.addEventListener('dragover', (event) => {
    if (!isFavDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    pin.classList.add('drop-before');
  });
  pin.addEventListener('drop', (event) => {
    if (!isFavDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const data = parseFav(event);
    clearDropMarks();
    if (data) {
      void api.invoke('shiori:move-favorite', {
        laneId: data.laneId,
        url: data.url,
        targetLaneId: lane.id,
        beforeUrl: fav.url,
      });
    }
  });
  return pin;
}

/** Let a lane accept a page drop (pin it) or a favorite drop (move it here). */
function wireLaneDrop(group: HTMLElement, lane: Lane): void {
  group.addEventListener('dragover', (event) => {
    if (!isPageDrag(event) && !isFavDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = isPageDrag(event) ? 'copy' : 'move';
    if (!group.classList.contains('drop-target')) {
      clearDropMarks();
      group.classList.add('drop-target');
    }
  });
  group.addEventListener('dragleave', (event) => {
    if (!group.contains(event.relatedTarget as Node | null)) group.classList.remove('drop-target');
  });
  group.addEventListener('drop', (event) => {
    if (isPageDrag(event)) {
      event.preventDefault();
      const pageId = event.dataTransfer!.getData(DRAG_MIME);
      clearDropMarks();
      if (pageId) void api.invoke('shiori:pin-favorite', { laneId: lane.id, pageId });
    } else if (isFavDrag(event)) {
      event.preventDefault();
      const data = parseFav(event);
      clearDropMarks();
      if (data) {
        void api.invoke('shiori:move-favorite', {
          laneId: data.laneId,
          url: data.url,
          targetLaneId: lane.id,
          beforeUrl: null,
        });
      }
    }
  });
}

/** A stable, pleasant hue for a host, so the letter fallback isn't flat grey. */
function hueForHost(host: string): number {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360;
  return h;
}

/** Favicon image if the page reported a sane one, tinted letter otherwise. */
function faviconFor(pageUrl: string, favicon?: string): HTMLElement {
  const fallback = (): HTMLSpanElement => {
    const host = hostOf(pageUrl);
    const span = el('span', 'fav-fallback', (host[0] ?? '•').toUpperCase());
    const hue = hueForHost(host);
    span.style.background = `linear-gradient(140deg, hsl(${hue} 62% 62%), hsl(${(hue + 34) % 360} 60% 52%))`;
    span.style.color = '#fff';
    return span;
  };
  if (!favicon || !/^https?:\/\//i.test(favicon)) return fallback();
  const img = el('img', 'fav') as HTMLImageElement;
  img.src = favicon;
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

// ---------------------------------------------------------------------------
// Drag & drop: pull a page into another lane, or reorder within one.
// ---------------------------------------------------------------------------

const DRAG_MIME = 'application/x-shiori-page';
const DRAG_FAV = 'application/x-shiori-fav';
let draggingPageId: string | null = null;
let draggingFav: { laneId: string; url: string } | null = null;

function clearDropMarks(): void {
  for (const node of document.querySelectorAll('.drop-before, .drop-after, .drop-target')) {
    node.classList.remove('drop-before', 'drop-after', 'drop-target');
  }
}

function isPageDrag(event: DragEvent): boolean {
  return !!event.dataTransfer && event.dataTransfer.types.includes(DRAG_MIME);
}

function isFavDrag(event: DragEvent): boolean {
  return !!event.dataTransfer && event.dataTransfer.types.includes(DRAG_FAV);
}

function parseFav(event: DragEvent): { laneId: string; url: string } | null {
  try {
    const parsed = JSON.parse(event.dataTransfer!.getData(DRAG_FAV)) as unknown;
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (typeof o.laneId === 'string' && typeof o.url === 'string') {
        return { laneId: o.laneId, url: o.url };
      }
    }
  } catch {
    /* malformed drag payload */
  }
  return null;
}

// Rebuilding the sidebar mid-drag would destroy the element being dragged and
// strand draggingPageId/draggingFav (Chromium can skip dragend when the source
// node is removed). A background page's favicon/title update repaints the whole
// sidebar now that pages ride the same event, so defer the rebuild until the
// drag ends.
let sidebarRenderPending = false;

function renderSidebar(): void {
  if (draggingPageId || draggingFav) {
    sidebarRenderPending = true;
    return;
  }
  renderLanes();
  renderPages();
}

function flushSidebar(): void {
  if (!sidebarRenderPending) return;
  sidebarRenderPending = false;
  renderLanes();
  renderPages();
}

function renderPages(): void {
  els.pages.replaceChildren();
  els.pageCount.textContent = pages.length > 0 ? String(pages.length) : '';

  for (const page of pages) {
    const chip = el('button', 'chip page');
    if (page.id === activePageId) chip.classList.add('active');
    chip.draggable = true;
    chip.dataset.pageId = page.id;

    chip.append(faviconFor(page.url, page.favicon));
    chip.append(el('span', 'chip-label', page.title || hostOf(page.url)));

    const progress = progressByPage.get(page.id);
    if (progress !== undefined && progress > 0) {
      const bar = el('span', 'chip-progress');
      bar.style.width = `${pct(progress)}%`;
      chip.append(bar);
    }

    const x = el('span', 'chip-x', '×');
    x.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.invoke('shiori:close-page', { pageId: page.id });
    });
    chip.append(x);

    chip.addEventListener('click', () => {
      if (draggingPageId) return; // a drag that ended on this chip isn't a click
      void api.invoke('shiori:activate-page', { pageId: page.id });
    });

    chip.addEventListener('dragstart', (event) => {
      draggingPageId = page.id;
      chip.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.setData(DRAG_MIME, page.id);
        // Reorder within the list (move) or drop on a lane to pin (copy).
        event.dataTransfer.effectAllowed = 'copyMove';
      }
    });
    chip.addEventListener('dragend', () => {
      draggingPageId = null;
      chip.classList.remove('dragging');
      clearDropMarks();
      flushSidebar();
    });

    // Reorder within the global list: drop before/after by the pointer half.
    chip.addEventListener('dragover', (event) => {
      if (!isPageDrag(event) || page.id === draggingPageId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = chip.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      clearDropMarks();
      chip.classList.add(after ? 'drop-after' : 'drop-before');
    });
    chip.addEventListener('drop', (event) => {
      if (!isPageDrag(event)) return;
      event.preventDefault();
      const pageId = event.dataTransfer!.getData(DRAG_MIME);
      const rect = chip.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const idx = pages.findIndex((p) => p.id === page.id);
      const before = after ? (pages[idx + 1]?.id ?? null) : page.id;
      clearDropMarks();
      if (pageId) void api.invoke('shiori:move-page', { pageId, beforePageId: before });
    });

    els.pages.append(chip);
  }

  // The "+ 新しいページ" row lives at the end of the list, so it always sits
  // right under the last page (not pinned to the far bottom of the sidebar).
  const add = el('button', 'new-page-row');
  add.title = formatKeys('新しいページ (⌘T)');
  add.append(svgIcon('#i-plus', 'ic sm'), el('span', '', '新しいページ'));
  add.addEventListener('click', goHomeAndFocus);
  els.pages.append(add);
}

/**
 * Update only the read-progress underline on one page chip. Scroll ticks arrive
 * several times a second; rebuilding the whole row (renderPages) would recreate
 * each favicon <img> and make them flicker in step with the scroll, so on a
 * progress tick we touch nothing but the bar's width.
 */
function updatePageProgress(pageId: string, progress: number): void {
  const chip = els.pages.querySelector<HTMLElement>(`.chip.page[data-page-id="${CSS.escape(pageId)}"]`);
  if (!chip) return;
  let bar = chip.querySelector<HTMLSpanElement>('.chip-progress');
  if (progress > 0) {
    if (!bar) {
      bar = el('span', 'chip-progress');
      chip.append(bar);
    }
    bar.style.width = `${pct(progress)}%`;
  } else if (bar) {
    bar.remove();
  }
}

/** What the URL bar should show: the query for Shiori's own search pages. */
function displayUrl(raw: string): string {
  if (raw.startsWith('shiori://search')) {
    try {
      return new URL(raw).searchParams.get('q') ?? raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

function renderNav(): void {
  const showingHome = !activePageId;

  els.homeScreen.hidden = !showingHome;
  els.home.classList.toggle('active', showingHome);
  // Catch up on bookmark changes that arrived while home was hidden.
  if (showingHome && homeDirty) renderHome();

  els.back.disabled = !nav?.canGoBack;
  els.forward.disabled = !nav?.canGoForward;
  els.reload.disabled = !nav;
  const loading = !!nav?.isLoading;
  els.icReload.classList.toggle('hide', loading);
  els.icStop.classList.toggle('hide', !loading);

  if (document.activeElement !== els.url) {
    els.url.value = showingHome ? '' : displayUrl(nav?.url ?? '');
  }
  els.url.placeholder = showingHome ? '開きたい URL または 検索' : 'URL または 検索';

  // Read-progress badge for the page currently on screen.
  const current = activePageId ? progressByPage.get(activePageId) : undefined;
  if (!showingHome && current !== undefined) {
    els.urlProgress.hidden = false;
    els.urlProgress.textContent = `${pct(current)}%`;
  } else {
    els.urlProgress.hidden = true;
  }

  renderStatus();
}

/** The bottom status bar: connection, lane/page counts, current read %. */
function renderStatus(): void {
  const pageCount = pages.length;
  const laneWord = lanes.length === 1 ? 'lane' : 'lanes';
  const pageWord = pageCount === 1 ? 'page' : 'pages';
  els.statusCounts.textContent = `${lanes.length} ${laneWord} · ${pageCount} ${pageWord}`;

  const current = activePageId ? progressByPage.get(activePageId) : undefined;
  els.statusRead.textContent = `読了 ${current === undefined ? 0 : pct(current)}%`;
}

function renderConnection(): void {
  const online = navigator.onLine;
  els.statusbar.classList.toggle('offline', !online);
  els.statusConn.replaceChildren();
  const dot = el('span', 'status-dot');
  els.statusConn.append(dot, document.createTextNode(online ? '接続済み' : 'オフライン'));
}

/** Set when bookmarks changed while the home screen was hidden (no point
    rebuilding DOM nobody can see — every page load broadcasts bookmarks). */
let homeDirty = false;

function renderHome(): void {
  if (els.homeScreen.hidden) {
    homeDirty = true;
    return;
  }
  homeDirty = false;
  els.homeList.replaceChildren();
  els.homeCount.textContent = bookmarks.length > 0 ? `${bookmarks.length} 件` : '';
  els.homeEmpty.hidden = bookmarks.length > 0;

  for (const mark of bookmarks) {
    const row = el('li', 'read-row');

    const ring = el('div', 'read-ring');
    const percent = pct(mark.maxProgress);
    ring.style.background = `conic-gradient(var(--accent) ${percent}%, var(--ring-track) 0)`;
    ring.append(el('span', 'read-ring-inner', String(percent)));

    const main = el('div', 'read-main');
    main.append(el('div', 'read-title', mark.title || mark.url));
    const meta = el('div', 'read-meta');
    meta.append(
      el('span', 'read-host', hostOf(mark.url)),
      el('span', 'read-url', mark.url),
      el('span', '', relTime(mark.lastVisited)),
    );
    main.append(meta);

    const remove = el('button', 'read-x', '×');
    remove.title = 'この栞を削除';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.invoke('shiori:delete-bookmark', { url: mark.url });
    });

    row.append(ring, main, remove);
    row.addEventListener('click', () => void api.invoke('shiori:open-bookmark', { url: mark.url }));
    els.homeList.append(row);
  }
}

function renderClips(): void {
  els.clipCount.hidden = clips.length === 0;
  els.clipCount.textContent = String(clips.length);
  els.clipEmpty.hidden = clips.length > 0;
  els.clipList.replaceChildren();

  for (const clip of clips) {
    const card = el('li', 'clip-card');
    card.append(el('div', 'clip-text', clip.text));

    const src = el('div', 'clip-src');
    src.append(el('span', 'clip-src-title', clip.title || hostOf(clip.url)));
    src.append(el('span', '', ` — ${hostOf(clip.url)}`));
    card.append(src);

    const foot = el('div', 'clip-foot');
    foot.append(el('span', 'clip-time', relTime(clip.createdAt)));

    const buttons = el('div', 'clip-buttons');
    const copy = el('button', 'text-btn', 'Markdown引用でコピー');
    copy.addEventListener('click', async () => {
      await api.invoke('shiori:copy-clip', { id: clip.id });
      copy.textContent = 'コピーしました';
      copy.classList.add('copied');
      setTimeout(() => {
        copy.textContent = 'Markdown引用でコピー';
        copy.classList.remove('copied');
      }, 1400);
    });
    const del = el('button', 'text-btn danger', '×');
    del.addEventListener('click', () => void api.invoke('shiori:delete-clip', { id: clip.id }));
    buttons.append(copy, del);

    foot.append(buttons);
    card.append(foot);
    els.clipList.append(card);
  }
}

function setClipPanel(open: boolean, persist: boolean): void {
  els.clipPanel.hidden = !open;
  els.clipsBtn.classList.toggle('active', open);
  els.railClips.classList.toggle('active', open);
  if (persist) void api.invoke('shiori:set-clip-panel', { open });
  // The panel changes the page-host width; ResizeObserver reports the new rect.
}

// ---------------------------------------------------------------------------
// Memo panel: TODO list + free-form memo
// ---------------------------------------------------------------------------

function renderTodos(): void {
  els.todoList.replaceChildren();
  const remaining = todos.filter((t) => !t.done).length;
  els.todoCount.textContent = todos.length === 0 ? '' : `残り ${remaining} / ${todos.length}`;
  els.todoEmpty.hidden = todos.length > 0;
  els.clearDone.hidden = !todos.some((t) => t.done);

  for (const todo of todos) {
    const li = el('li', 'todo-item');
    if (todo.done) li.classList.add('done');

    const check = el('button', 'todo-check');
    check.setAttribute('aria-label', todo.done ? '未完了に戻す' : '完了にする');
    check.addEventListener('click', () => void api.invoke('shiori:toggle-todo', { id: todo.id }));

    // web-derived? No — this is the user's own text, but textContent keeps the
    // same no-innerHTML discipline as the rest of the chrome.
    const text = el('span', 'todo-text', todo.text);

    const del = el('button', 'todo-del', '×');
    del.title = '削除';
    del.addEventListener('click', () => void api.invoke('shiori:delete-todo', { id: todo.id }));

    li.append(check, text, del);
    els.todoList.append(li);
  }
}

function setNotesTab(tab: 'todo' | 'memo'): void {
  notesTab = tab;
  els.notesTodo.hidden = tab !== 'todo';
  els.notesMemo.hidden = tab !== 'memo';
  for (const btn of notesTabButtons) btn.classList.toggle('active', btn.dataset.tab === tab);
  if (!notesOpen) return;
  if (tab === 'todo') els.todoInput.focus();
  else els.memoInput.focus();
}

function setNotesPanel(open: boolean, persist: boolean): void {
  // Closing the panel commits any pending memo edit right away.
  if (!open) flushMemo();
  notesOpen = open;
  els.notesPanel.hidden = !open;
  els.railNotes.classList.toggle('active', open);
  if (persist) void api.invoke('shiori:set-notes-panel', { open });
  // The panel changes the stage width; ResizeObserver reports the new rects.
  reportRect();
  reportAiRect();
  reportGridRects();
  if (open) setNotesTab(notesTab);
}

function flushMemo(): void {
  // Only when there is an unsaved edit pending — otherwise flushing would push a
  // possibly-stale textarea value over the stored memo (e.g. on a bare close).
  if (memoSaveTimer === null) return;
  clearTimeout(memoSaveTimer);
  memoSaveTimer = null;
  void api.invoke('shiori:set-memo', { text: els.memoInput.value });
}

function renderAi(): void {
  document.documentElement.style.setProperty('--ai-w', `${aiWidth}px`);
  els.aiPanel.hidden = !aiOpen;
  els.aiTitle.textContent = AI_LABELS[aiService];
  els.railAi.classList.toggle('active', aiOpen);
  for (const btn of aiDockButtons) {
    btn.classList.toggle('active', aiOpen && btn.dataset.service === aiService);
  }
  for (const btn of aiTabButtons) {
    btn.classList.toggle('active', btn.dataset.service === aiService);
  }
  // Visibility changes move both the page and the panel stage.
  reportRect();
  reportAiRect();
}

function applySidebar(): void {
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
}

// ---------------------------------------------------------------------------
// Parallel AI grid
// ---------------------------------------------------------------------------

/** An <svg><use href="#symbol"/></svg> icon (createElementNS: SVG needs the ns). */
function svgIcon(symbol: string, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', symbol);
  svg.appendChild(use);
  return svg;
}

/** Change which services occupy the grid, keeping canonical order and ≥1 tile. */
function setGridServices(next: AiService[]): void {
  const ordered = ALL_SERVICES.filter((s) => next.includes(s));
  if (ordered.length === 0) return;
  void api.invoke('shiori:ai-grid-set-services', { services: ordered });
}

function toggleGridService(service: AiService): void {
  const on = aiGridServices.includes(service);
  if (on && aiGridServices.length <= 1) return; // never empty the grid
  setGridServices(on ? aiGridServices.filter((s) => s !== service) : [...aiGridServices, service]);
}

/** The service-toggle chips in the toolbar (all four, active = in the grid). */
function renderGridServices(): void {
  els.gridServices.replaceChildren();
  for (const service of ALL_SERVICES) {
    const chip = el('button', 'grid-service-chip');
    chip.classList.toggle('on', aiGridServices.includes(service));
    chip.dataset.service = service;
    chip.style.setProperty('--svc', `var(--c-${service})`);
    chip.append(svgIcon(AI_ICONS[service], 'ai-ic'), el('span', '', AI_LABELS[service]));
    chip.addEventListener('click', () => toggleGridService(service));
    els.gridServices.append(chip);
  }
}

function tileActionButton(
  act: 'reload' | 'promote' | 'remove',
  symbol: string,
  title: string,
  service: AiService,
): HTMLButtonElement {
  const btn = el('button', 'tile-btn');
  btn.title = title;
  btn.append(svgIcon(symbol, 'ic sm'));
  btn.addEventListener('click', () => {
    if (act === 'reload') void api.invoke('shiori:ai-grid-tile-reload', { service });
    else if (act === 'promote') void api.invoke('shiori:ai-grid-tile-promote', { service });
    else if (act === 'remove') toggleGridService(service);
  });
  return btn;
}

/** Rebuild the tiles from the current service line-up (web strings never used). */
function renderTiles(): void {
  els.aiTiles.replaceChildren();
  els.aiTiles.dataset.count = String(aiGridServices.length);
  for (const service of aiGridServices) {
    const tile = el('div', 'ai-tile');
    tile.dataset.service = service;
    tile.style.setProperty('--svc', `var(--c-${service})`);

    const head = el('div', 'ai-tile-head');
    head.append(svgIcon(AI_ICONS[service], 'ai-ic'), el('span', 'ai-tile-name', AI_LABELS[service]));
    const actions = el('div', 'ai-tile-actions');
    actions.append(
      tileActionButton('reload', '#i-reload', '再読み込み', service),
      tileActionButton('promote', '#i-external', 'ページに昇格', service),
      tileActionButton('remove', '#i-close', 'グリッドから外す', service),
    );
    head.append(actions);

    const stage = el('div', 'ai-tile-stage');
    stage.dataset.service = service;
    stage.append(el('p', 'ai-hint', '読み込み中…'));

    tile.append(head, stage);
    els.aiTiles.append(tile);
  }
}

function renderAiGrid(): void {
  document.body.classList.toggle('ai-grid', aiGridOpen);
  els.railGrid.classList.toggle('active', aiGridOpen);
  els.aiGridBtn.classList.toggle('active', aiGridOpen);
  els.broadcastSubmit.checked = aiGridBroadcastSubmit;
  els.broadcastForm.classList.toggle('fill-only', !aiGridBroadcastSubmit);
  els.broadcastSend.textContent = aiGridBroadcastSubmit ? '全AIへ送信' : '全AIに入力';
  renderGridServices();
  renderTiles();
  // Both the page and the panel stages change visibility with the grid.
  reportRect();
  reportAiRect();
  reportGridRects();
}

/** Flash how many tiles took the broadcast, on the send button. */
function showBroadcastResult(list: BroadcastResult[]): void {
  const delivered = list.filter((r) => r.status !== 'missed').length;
  els.broadcastSend.textContent = `${delivered}/${list.length} に届きました`;
  els.broadcastSend.classList.add('copied');
  setTimeout(() => {
    els.broadcastSend.classList.remove('copied');
    els.broadcastSend.textContent = aiGridBroadcastSubmit ? '全AIへ送信' : '全AIに入力';
  }, 1600);
}

// ---------------------------------------------------------------------------
// AI panel resize.
//
// While dragging, the main process lifts the native views off the window (they
// would otherwise swallow every mousemove), so the chrome sees the whole drag.
// ---------------------------------------------------------------------------

let resizeDrag: { startX: number; startW: number; lastW: number } | null = null;

function aiClampW(width: number): number {
  const max = Math.min(AI_MAX_W, Math.max(AI_MIN_W, window.innerWidth - 420));
  return Math.min(max, Math.max(AI_MIN_W, Math.round(width)));
}

function endAiResize(commit: boolean): void {
  if (!resizeDrag) return;
  const width = commit ? resizeDrag.lastW : resizeDrag.startW;
  resizeDrag = null;
  document.body.classList.remove('resizing');
  aiWidth = width;
  document.documentElement.style.setProperty('--ai-w', `${width}px`);
  // Send fresh rects first so the views reattach at their final bounds.
  reportRect();
  reportAiRect();
  void api.invoke('shiori:ai-resize', { phase: commit ? 'end' : 'cancel', width });
}

els.aiResizer.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !aiOpen) return;
  event.preventDefault();
  resizeDrag = { startX: event.clientX, startW: aiWidth, lastW: aiWidth };
  document.body.classList.add('resizing');
  void api.invoke('shiori:ai-resize', { phase: 'start' });
});

window.addEventListener('mousemove', (event) => {
  if (!resizeDrag) return;
  if (event.buttons === 0) {
    // The release happened before we saw it; commit what we have.
    endAiResize(true);
    return;
  }
  const width = aiClampW(resizeDrag.startW + (resizeDrag.startX - event.clientX));
  resizeDrag.lastW = width;
  document.documentElement.style.setProperty('--ai-w', `${width}px`);
});

window.addEventListener('mouseup', () => endAiResize(true));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && resizeDrag) endAiResize(false);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

els.back.addEventListener('click', () => void api.invoke('shiori:back'));
els.forward.addEventListener('click', () => void api.invoke('shiori:forward'));
els.reload.addEventListener('click', () => {
  void api.invoke(nav?.isLoading ? 'shiori:stop' : 'shiori:reload');
});
function goHomeAndFocus(): void {
  void api.invoke('shiori:go-home');
  // The lanes event repaints; focus the hero search once it's on screen.
  setTimeout(() => {
    if (!els.homeScreen.hidden) els.homeSearch.focus();
  }, 60);
}
els.home.addEventListener('click', goHomeAndFocus);
els.railHistory.addEventListener('click', goHomeAndFocus);
els.sidebarBtn.addEventListener('click', () => {
  void api.invoke('shiori:set-sidebar', { collapsed: !sidebarCollapsed });
});
els.railClips.addEventListener('click', () => setClipPanel(els.clipPanel.hidden, true));
els.railAi.addEventListener('click', () => {
  void api.invoke(aiOpen ? 'shiori:ai-close' : 'shiori:ai-open', { service: aiService });
});
// The settings gear is a placeholder for now; toggling the sidebar is the one
// safe "layout" action it can own without inventing a new surface.
els.railSettings.addEventListener('click', () => {
  void api.invoke('shiori:set-sidebar', { collapsed: !sidebarCollapsed });
});

els.newLane.addEventListener('click', async () => {
  const laneId = await api.invoke<string>('shiori:new-lane', { name: '' });
  renamingLaneId = laneId;
  renderLanes();
});

// Fold/unfold a lane by clicking anywhere on its header. Delegated on the #lanes
// container (not per-element) so the whole row responds and it survives the
// sidebar being re-rendered mid-interaction. The delete × stops propagation, and
// pins / the rename input aren't inside .lane-head, so they're naturally excluded.
function laneIdFromHeader(event: Event): string | null {
  const head = (event.target as HTMLElement).closest('.lane-head');
  if (!head) return null;
  const group = head.closest('.lane-group') as HTMLElement | null;
  return group?.dataset.laneId ?? null;
}
els.lanes.addEventListener('click', (event) => {
  const laneId = laneIdFromHeader(event);
  if (laneId) void api.invoke('shiori:toggle-lane-collapsed', { laneId });
});
els.lanes.addEventListener('dblclick', (event) => {
  // Double-click the name (not the caret) to rename.
  if ((event.target as HTMLElement).closest('.lane-caret')) return;
  const laneId = laneIdFromHeader(event);
  if (!laneId) return;
  renamingLaneId = laneId;
  renderLanes();
});

// The home hero's big search box: same behaviour as the URL bar (URL → open,
// anything else → Shiori's search page).
els.homeSearchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = els.homeSearch.value.trim();
  if (value) void api.invoke('shiori:navigate', { url: value });
  els.homeSearch.value = '';
});
els.homeSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') els.homeSearch.blur();
});

els.url.addEventListener('focus', () => els.url.select());
els.url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const value = els.url.value.trim();
    if (value) void api.invoke('shiori:navigate', { url: value });
    els.url.blur();
  } else if (event.key === 'Escape') {
    els.url.value = displayUrl(nav?.url ?? '');
    els.url.blur();
  }
});

els.clipsBtn.addEventListener('click', () => setClipPanel(els.clipPanel.hidden, true));
els.closePanel.addEventListener('click', () => setClipPanel(false, true));
els.copyAll.addEventListener('click', async () => {
  await api.invoke('shiori:copy-all-clips');
  els.copyAll.textContent = 'コピーしました';
  els.copyAll.classList.add('copied');
  setTimeout(() => {
    els.copyAll.textContent = '全部コピー';
    els.copyAll.classList.remove('copied');
  }, 1400);
});
els.clearClips.addEventListener('click', () => void api.invoke('shiori:clear-clips'));

// Memo panel: toggle, tabs, todo add/clear, memo autosave.
els.railNotes.addEventListener('click', () => setNotesPanel(els.notesPanel.hidden, true));
els.notesClose.addEventListener('click', () => setNotesPanel(false, true));
for (const btn of notesTabButtons) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === 'todo' || tab === 'memo') setNotesTab(tab);
  });
}
els.todoForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.todoInput.value.trim();
  if (!text) return;
  void api.invoke('shiori:add-todo', { text });
  els.todoInput.value = '';
});
els.clearDone.addEventListener('click', () => void api.invoke('shiori:clear-done-todos'));
els.memoInput.addEventListener('input', () => {
  memo = els.memoInput.value;
  if (memoSaveTimer !== null) clearTimeout(memoSaveTimer);
  memoSaveTimer = window.setTimeout(() => {
    memoSaveTimer = null;
    void api.invoke('shiori:set-memo', { text: memo });
  }, 400);
});
els.memoInput.addEventListener('blur', flushMemo);
// Persist the last keystrokes when the window is closing/quitting, where a
// pending 400ms debounce would otherwise be dropped with the renderer.
window.addEventListener('pagehide', flushMemo);

// AI quick access: dock buttons toggle, tabs and home cards open/switch.
for (const btn of aiDockButtons) {
  btn.addEventListener('click', () => {
    const service = btn.dataset.service;
    if (!isAiService(service)) return;
    if (aiOpen && aiService === service) {
      void api.invoke('shiori:ai-close');
    } else {
      void api.invoke('shiori:ai-open', { service });
    }
  });
}
for (const btn of [...aiTabButtons, ...homeAiCards]) {
  btn.addEventListener('click', () => {
    const service = btn.dataset.service;
    if (isAiService(service)) void api.invoke('shiori:ai-open', { service });
  });
}
els.aiClose.addEventListener('click', () => void api.invoke('shiori:ai-close'));
els.aiReload.addEventListener('click', () => void api.invoke('shiori:ai-reload'));
els.aiPage.addEventListener('click', () => void api.invoke('shiori:ai-open-as-page'));

// Parallel AI grid: rail toggles, panel/home open it, toolbar closes it.
els.railGrid.addEventListener('click', () => {
  void api.invoke(aiGridOpen ? 'shiori:ai-grid-close' : 'shiori:ai-grid-open');
});
els.gridClose.addEventListener('click', () => void api.invoke('shiori:ai-grid-close'));
els.aiGridBtn.addEventListener('click', () => void api.invoke('shiori:ai-grid-open'));
els.homeGridBtn.addEventListener('click', () => void api.invoke('shiori:ai-grid-open'));

els.broadcastForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.broadcastInput.value.trim();
  if (!text) return;
  void api.invoke('shiori:ai-broadcast', { text, submit: aiGridBroadcastSubmit });
  els.broadcastInput.value = '';
});
els.broadcastSubmit.addEventListener('change', () => {
  void api.invoke('shiori:ai-grid-set-submit', { submit: els.broadcastSubmit.checked });
});
els.broadcastInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') els.broadcastInput.blur();
});
// Esc anywhere else in the grid leaves the mode (but not while typing a prompt).
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !aiGridOpen || resizeDrag) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  void api.invoke('shiori:ai-grid-close');
});

api.on<LaneState>('shiori:lanes', (state) => {
  lanes = state.lanes;
  pages = state.pages;
  activePageId = state.activePageId;
  // Drop progress entries for pages that are gone, so the map stays bounded.
  const liveIds = new Set(pages.map((p) => p.id));
  for (const id of progressByPage.keys()) {
    if (!liveIds.has(id)) progressByPage.delete(id);
  }
  renderSidebar();
  renderNav();
});

api.on<NavState | null>('shiori:nav', (state) => {
  nav = state;
  renderNav();
});

api.on<Bookmark[]>('shiori:bookmarks', (list) => {
  bookmarks = list;
  renderHome();
});

api.on<Clip[]>('shiori:clips', (list) => {
  clips = list;
  renderClips();
});

api.on<boolean>('shiori:clip-panel', (open) => setClipPanel(open, false));
api.on<boolean>('shiori:notes-panel', (open) => setNotesPanel(open, false));
api.on<TodoItem[]>('shiori:todos', (list) => {
  todos = list;
  renderTodos();
});

api.on<boolean>('shiori:sidebar', (collapsed) => {
  sidebarCollapsed = collapsed;
  applySidebar();
});

api.on<AiState>('shiori:ai', (state) => {
  aiOpen = state.open;
  aiService = state.service;
  aiWidth = state.width;
  renderAi();
});

api.on<AiGridState>('shiori:ai-grid', (state) => {
  aiGridOpen = state.open;
  aiGridServices = state.services;
  aiGridBroadcastSubmit = state.broadcastSubmit;
  renderAiGrid();
});

api.on<BroadcastResult[]>('shiori:ai-broadcast-result', (list) => showBroadcastResult(list));

api.on<ProgressTick>('shiori:progress', (tick) => {
  progressByPage.set(tick.pageId, tick.progress);
  // Only nudge the underline (and the URL-bar / status read-outs) — never
  // rebuild the row (favicon flicker) and never run the whole renderNav
  // (ticks arrive ~4×/sec while scrolling; rewriting the URL bar, button
  // states and placeholders on each would invalidate styles for nothing).
  updatePageProgress(tick.pageId, tick.progress);
  if (tick.pageId === activePageId) {
    els.urlProgress.hidden = false;
    els.urlProgress.textContent = `${pct(tick.progress)}%`;
    els.statusRead.textContent = `読了 ${pct(tick.progress)}%`;
  }
});

api.on('shiori:focus-urlbar', () => {
  els.url.focus();
  els.url.select();
});

window.addEventListener('online', renderConnection);
window.addEventListener('offline', renderConnection);

// Page (video) fullscreen: hide all chrome so the WebContentsView, which
// follows #page-host, expands to cover the whole window.
api.on<boolean>('shiori:fullscreen', (on) => {
  document.body.classList.toggle('fullscreen', on);
  reportRect();
  reportAiRect();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const state = await api.invoke<ChromeState>('shiori:get-state');
  lanes = state.lanes;
  pages = state.pages;
  activePageId = state.activePageId;
  bookmarks = await api.invoke<Bookmark[]>('shiori:get-bookmarks');
  clips = await api.invoke<Clip[]>('shiori:get-clips');
  const notes = await api.invoke<NotesState>('shiori:get-notes');
  todos = notes.todos;
  memo = notes.memo;

  sidebarCollapsed = state.sidebarCollapsed;
  aiOpen = state.ai.open;
  aiService = state.ai.service;
  aiWidth = state.ai.width;
  aiGridOpen = state.aiGrid.open;
  aiGridServices = state.aiGrid.services;
  aiGridBroadcastSubmit = state.aiGrid.broadcastSubmit;

  applySidebar();
  setClipPanel(state.clipPanelOpen, false);
  els.memoInput.value = memo;
  renderTodos();
  setNotesTab('todo');
  setNotesPanel(state.notesPanelOpen, false);
  renderAi();
  renderAiGrid();
  renderLanes();
  renderPages();
  renderNav();
  renderHome();
  renderClips();
  renderConnection();
  reportRect();
  reportAiRect();

  // Start on the hero search when the app opens to the home screen.
  if (!els.homeScreen.hidden) els.homeSearch.focus();
}

void boot();
