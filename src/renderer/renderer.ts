// Chrome UI for Shiori.
//
// Loaded as a CLASSIC script: no bundler, no module loader. This file must
// therefore contain NO top-level import/export at all — a single `import type`
// would still mark it as a module, and tsc would emit a bare `export {};` to
// preserve that, which is a SyntaxError in a classic script. Shared types are
// pulled in through `import(...)` type queries instead, which erase completely.
// `npm run check:renderer` fails the build if this ever regresses.
//
// All web-page derived strings (titles, URLs, clip text) are inserted with
// textContent — never innerHTML — because they are attacker-controlled.
type Bookmark = import('../shared/types').Bookmark;
type ChromeState = import('../shared/types').ChromeState;
type Clip = import('../shared/types').Clip;
type Lane = import('../shared/types').Lane;
type LaneState = import('../shared/types').LaneState;
type NavState = import('../shared/types').NavState;
type ProgressTick = import('../shared/types').ProgressTick;

const api = window.shiori;

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Shiori: missing #${id}`);
  return node as T;
}

const els = {
  back: need<HTMLButtonElement>('btn-back'),
  forward: need<HTMLButtonElement>('btn-forward'),
  reload: need<HTMLButtonElement>('btn-reload'),
  home: need<HTMLButtonElement>('btn-home'),
  url: need<HTMLInputElement>('url'),
  urlProgress: need<HTMLSpanElement>('url-progress'),
  clipsBtn: need<HTMLButtonElement>('btn-clips'),
  clipCount: need<HTMLSpanElement>('clip-count'),
  lanes: need<HTMLDivElement>('lanes'),
  newLane: need<HTMLButtonElement>('btn-new-lane'),
  pages: need<HTMLDivElement>('pages'),
  newPage: need<HTMLButtonElement>('btn-new-page'),
  stage: need<HTMLElement>('stage'),
  homeScreen: need<HTMLDivElement>('home'),
  homeList: need<HTMLUListElement>('home-list'),
  homeCount: need<HTMLSpanElement>('home-count'),
  homeEmpty: need<HTMLParagraphElement>('home-empty'),
  clipPanel: need<HTMLElement>('clip-panel'),
  clipList: need<HTMLUListElement>('clip-list'),
  clipEmpty: need<HTMLParagraphElement>('clip-empty'),
  copyAll: need<HTMLButtonElement>('btn-copy-all'),
  clearClips: need<HTMLButtonElement>('btn-clear-clips'),
  closePanel: need<HTMLButtonElement>('btn-close-panel'),
};

let lanes: Lane[] = [];
let activeLaneId = '';
let nav: NavState | null = null;
let bookmarks: Bookmark[] = [];
let clips: Clip[] = [];
let renamingLaneId: string | null = null;
/** Live progress per page id, so a chip can show progress before it's stored. */
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

function activeLane(): Lane | undefined {
  return lanes.find((l) => l.id === activeLaneId);
}

// ---------------------------------------------------------------------------
// Page rect: CSS owns the layout, the main process just follows it.
// ---------------------------------------------------------------------------

function reportRect(): void {
  const r = els.stage.getBoundingClientRect();
  api.send('shiori:page-rect', { x: r.left, y: r.top, width: r.width, height: r.height });
}

new ResizeObserver(reportRect).observe(els.stage);
window.addEventListener('resize', reportRect);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderLanes(): void {
  els.lanes.replaceChildren();
  for (const lane of lanes) {
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
      els.lanes.append(input);
      input.focus();
      input.select();
      continue;
    }

    const chip = el('button', 'chip lane');
    if (lane.id === activeLaneId) chip.classList.add('active');

    const dot = el('span', 'chip-dot');
    dot.style.background = lane.color;
    chip.append(dot, el('span', 'chip-label', lane.name));

    if (lane.pages.length > 0) {
      chip.append(el('span', 'chip-count', String(lane.pages.length)));
    }

    chip.addEventListener('click', () => void api.invoke('shiori:activate-lane', { laneId: lane.id }));
    chip.addEventListener('dblclick', () => {
      renamingLaneId = lane.id;
      renderLanes();
    });

    if (lanes.length > 1) {
      const x = el('span', 'chip-x', '×');
      x.addEventListener('click', (event) => {
        event.stopPropagation();
        void api.invoke('shiori:delete-lane', { laneId: lane.id });
      });
      chip.append(x);
    }

    els.lanes.append(chip);
  }
}

function renderPages(): void {
  els.pages.replaceChildren();
  const lane = activeLane();
  if (!lane) return;

  for (const page of lane.pages) {
    const chip = el('button', 'chip page');
    if (page.id === lane.activePageId) chip.classList.add('active');

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

    chip.addEventListener('click', () => void api.invoke('shiori:activate-page', { pageId: page.id }));
    els.pages.append(chip);
  }
}

function renderNav(): void {
  const lane = activeLane();
  const showingHome = !lane?.activePageId;

  els.homeScreen.hidden = !showingHome;
  els.home.classList.toggle('active', showingHome);

  els.back.disabled = !nav?.canGoBack;
  els.forward.disabled = !nav?.canGoForward;
  els.reload.disabled = !nav;
  els.reload.textContent = nav?.isLoading ? '×' : '⟳';

  if (document.activeElement !== els.url) {
    els.url.value = showingHome ? '' : (nav?.url ?? '');
  }
  els.url.placeholder = showingHome ? '開きたい URL または 検索' : 'URL または 検索';

  // Read-progress badge for the page currently on screen.
  const current = lane?.activePageId ? progressByPage.get(lane.activePageId) : undefined;
  if (!showingHome && current !== undefined) {
    els.urlProgress.hidden = false;
    els.urlProgress.textContent = `読了 ${pct(current)}%`;
  } else {
    els.urlProgress.hidden = true;
  }
}

function renderHome(): void {
  els.homeList.replaceChildren();
  els.homeCount.textContent = bookmarks.length > 0 ? `${bookmarks.length} 件` : '';
  els.homeEmpty.hidden = bookmarks.length > 0;

  for (const mark of bookmarks) {
    const row = el('li', 'read-row');

    const ring = el('div', 'read-ring');
    const percent = pct(mark.maxProgress);
    ring.style.background = `conic-gradient(var(--accent) ${percent}%, #262a3d 0)`;
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
  if (persist) void api.invoke('shiori:set-clip-panel', { open });
  // The panel changes the stage width; ResizeObserver will report the new rect.
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

els.back.addEventListener('click', () => void api.invoke('shiori:back'));
els.forward.addEventListener('click', () => void api.invoke('shiori:forward'));
els.reload.addEventListener('click', () => {
  void api.invoke(nav?.isLoading ? 'shiori:stop' : 'shiori:reload');
});
els.home.addEventListener('click', () => void api.invoke('shiori:go-home'));
els.newPage.addEventListener('click', () => void api.invoke('shiori:go-home'));

els.newLane.addEventListener('click', async () => {
  const laneId = await api.invoke<string>('shiori:new-lane', { name: '' });
  renamingLaneId = laneId;
  renderLanes();
});

els.url.addEventListener('focus', () => els.url.select());
els.url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const value = els.url.value.trim();
    if (value) void api.invoke('shiori:navigate', { url: value });
    els.url.blur();
  } else if (event.key === 'Escape') {
    els.url.value = nav?.url ?? '';
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

api.on<LaneState>('shiori:lanes', (state) => {
  lanes = state.lanes;
  activeLaneId = state.activeLaneId;
  renderLanes();
  renderPages();
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

api.on<ProgressTick>('shiori:progress', (tick) => {
  const previous = progressByPage.get(tick.pageId);
  progressByPage.set(tick.pageId, tick.progress);
  // Chips only need a repaint when the visible width actually moves.
  if (previous === undefined || Math.abs(previous - tick.progress) > 0.005) renderPages();
  renderNav();
});

api.on('shiori:focus-urlbar', () => {
  els.url.focus();
  els.url.select();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const state = await api.invoke<ChromeState>('shiori:get-state');
  lanes = state.lanes;
  activeLaneId = state.activeLaneId;
  bookmarks = await api.invoke<Bookmark[]>('shiori:get-bookmarks');
  clips = await api.invoke<Clip[]>('shiori:get-clips');

  setClipPanel(state.clipPanelOpen, false);
  renderLanes();
  renderPages();
  renderNav();
  renderHome();
  renderClips();
  reportRect();
}

void boot();
