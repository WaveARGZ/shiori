import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import type { AiService, Bookmark, Clip, Favorite, Lane, PageRef, TodoItem } from '../shared/types';
import { AI_SERVICE_ORDER, isAiService } from './ai';

interface Schema {
  /** Lanes are now favorite folders (no live pages). */
  lanes: Lane[];
  /** The single global list of open pages (was per-lane). */
  pages: PageRef[];
  /** The page currently on screen; null = the home screen. */
  activePageId: string | null;
  /** Keyed by normalized URL. */
  bookmarks: Record<string, Bookmark>;
  clips: Clip[];
  clipPanelOpen: boolean;
  /** Memo panel: TODO list, free-form memo, and whether the panel is open. */
  todos: TodoItem[];
  memo: string;
  notesPanelOpen: boolean;
  sidebarCollapsed: boolean;
  aiPanelOpen: boolean;
  aiService: AiService;
  aiPanelWidth: number;
  /** Parallel AI mode: whether the tiled grid is showing. */
  aiGridOpen: boolean;
  /** Which services occupy the grid (1–4, in tile order). */
  aiGridServices: AiService[];
  /** Whether the broadcast bar submits after filling, or only fills. */
  aiGridBroadcastSubmit: boolean;
  windowBounds: { x?: number; y?: number; width: number; height: number } | null;
}

export const AI_PANEL_MIN_W = 300;
export const AI_PANEL_MAX_W = 680;
export const AI_PANEL_DEFAULT_W = 400;

const MAX_CLIPS = 500;

function seedLanes(): Lane[] {
  return [
    { id: randomUUID(), name: '研究', color: '#7c9cff', favorites: [] },
    { id: randomUUID(), name: '娯楽', color: '#ffb86c', favorites: [] },
  ];
}

let instance: Store<Schema> | null = null;

/**
 * Constructed lazily. electron-store resolves app.getPath('userData') in its
 * constructor, so building it at import time would lock the storage location
 * before app startup gets a chance to redirect it.
 */
function store(): Store<Schema> {
  if (instance) return instance;
  const seeded = seedLanes();
  instance = new Store<Schema>({
    name: 'shiori',
    defaults: {
      lanes: seeded,
      pages: [],
      activePageId: null,
      bookmarks: {},
      clips: [],
      clipPanelOpen: false,
      todos: [],
      memo: '',
      notesPanelOpen: false,
      sidebarCollapsed: false,
      aiPanelOpen: false,
      aiService: 'chatgpt',
      aiPanelWidth: AI_PANEL_DEFAULT_W,
      aiGridOpen: false,
      aiGridServices: [...AI_SERVICE_ORDER],
      aiGridBroadcastSubmit: true,
      windowBounds: null,
    },
  });
  migrate(instance);
  return instance;
}

/**
 * One-time upgrade from the old model where each lane carried its own live
 * pages. Flatten every lane's pages into the single global list (preserving the
 * user's open tabs), pick the previously-active page, and turn lanes into empty
 * favorite folders. Idempotent: on the new shape it does nothing.
 */
function migrate(st: Store<Schema>): void {
  const rawLanes = st.get('lanes') as unknown;
  if (!Array.isArray(rawLanes)) return;
  type OldLane = { id: string; name: string; color: string; pages?: PageRef[]; activePageId?: string | null; favorites?: Favorite[] };
  const old = rawLanes as OldLane[];
  const needsMigration = old.some((l) => l && Array.isArray(l.pages));
  if (!needsMigration) return;

  const pages: PageRef[] = [];
  const seen = new Set<string>();
  const oldActiveLaneId = st.get('activeLaneId' as keyof Schema) as unknown as string | undefined;
  let activePageId: string | null = null;

  for (const l of old) {
    for (const p of l.pages ?? []) {
      if (p && typeof p.id === 'string' && !seen.has(p.id)) {
        seen.add(p.id);
        pages.push({ id: p.id, url: p.url, title: p.title, favicon: p.favicon });
      }
    }
    if (l.id === oldActiveLaneId && typeof l.activePageId === 'string') activePageId = l.activePageId;
  }

  const lanes: Lane[] = old.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
    favorites: Array.isArray(l.favorites) ? l.favorites : [],
  }));

  st.set('lanes', lanes);
  st.set('pages', pages);
  st.set('activePageId', activePageId && seen.has(activePageId) ? activePageId : null);
  // @ts-expect-error legacy key removed from the schema
  st.delete('activeLaneId');
}

// ---------------------------------------------------------------------------
// Lanes (favorite folders) and the global page list
// ---------------------------------------------------------------------------

export function getLanes(): Lane[] {
  const lanes = store().get('lanes');
  if (!Array.isArray(lanes) || lanes.length === 0) {
    const fresh = seedLanes();
    store().set('lanes', fresh);
    return fresh;
  }
  // Defensive: an old-shape lane that slipped through migration still gets a
  // favorites array so the renderer never sees undefined.
  return lanes.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
    favorites: Array.isArray(l.favorites) ? l.favorites : [],
    collapsed: l.collapsed === true,
  }));
}

export function setLanes(lanes: Lane[]): void {
  store().set('lanes', lanes);
}

export function getPages(): PageRef[] {
  const pages = store().get('pages');
  return Array.isArray(pages) ? pages : [];
}

export function setPages(pages: PageRef[]): void {
  store().set('pages', pages);
}

export function getActivePageId(): string | null {
  const id = store().get('activePageId');
  return typeof id === 'string' ? id : null;
}

export function setActivePageId(id: string | null): void {
  store().set('activePageId', id);
}

// ---------------------------------------------------------------------------
// Bookmarks
//
// NOTE: bookmarks are read/written as one whole object. electron-store treats
// "." in a key as a nested path, and every URL is full of dots, so a
// store().get(`bookmarks.${url}`) would silently build a nested mess.
// ---------------------------------------------------------------------------

let bookmarkCache: Record<string, Bookmark> | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function bookmarks(): Record<string, Bookmark> {
  if (!bookmarkCache) bookmarkCache = store().get('bookmarks') ?? {};
  return bookmarkCache;
}

/**
 * Scroll ticks arrive several times a second; electron-store writes the whole
 * JSON file synchronously on every set(). So we keep bookmarks in memory and
 * flush on a trailing debounce: continuous scrolling keeps pushing the write
 * out (instead of paying a full-file synchronous write every second), and a
 * max-wait bound guarantees the file is never more than a few seconds stale.
 * Quit/close still flush unconditionally via flushBookmarks().
 */
const FLUSH_QUIET_MS = 3000;
const FLUSH_MAX_WAIT_MS = 15_000;
let oldestPendingAt = 0;

function scheduleFlush(): void {
  const now = Date.now();
  if (flushTimer) clearTimeout(flushTimer);
  else oldestPendingAt = now;
  const wait = Math.min(FLUSH_QUIET_MS, Math.max(0, oldestPendingAt + FLUSH_MAX_WAIT_MS - now));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (bookmarkCache) store().set('bookmarks', bookmarkCache);
  }, wait);
}

export function flushBookmarks(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (bookmarkCache) store().set('bookmarks', bookmarkCache);
}

export function getBookmark(url: string): Bookmark | undefined {
  return bookmarks()[url];
}

export function upsertBookmark(url: string, patch: Partial<Bookmark>): Bookmark {
  const all = bookmarks();
  const prev = all[url];
  const next: Bookmark = {
    url,
    title: patch.title ?? prev?.title ?? url,
    scrollY: patch.scrollY ?? prev?.scrollY ?? 0,
    progress: patch.progress ?? prev?.progress ?? 0,
    maxProgress: Math.max(patch.maxProgress ?? 0, patch.progress ?? 0, prev?.maxProgress ?? 0),
    lastVisited: patch.lastVisited ?? Date.now(),
    docHeight: patch.docHeight ?? prev?.docHeight ?? 0,
  };
  all[url] = next;
  scheduleFlush();
  return next;
}

export function deleteBookmark(url: string): void {
  delete bookmarks()[url];
  scheduleFlush();
}

/** Most recently read first — this is the "続きから読む" ordering. */
export function listBookmarks(): Bookmark[] {
  return Object.values(bookmarks()).sort((a, b) => b.lastVisited - a.lastVisited);
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export function listClips(): Clip[] {
  return store().get('clips') ?? [];
}

export function addClip(clip: Clip): Clip[] {
  const next = [clip, ...listClips()].slice(0, MAX_CLIPS);
  store().set('clips', next);
  return next;
}

export function deleteClip(id: string): Clip[] {
  const next = listClips().filter((c) => c.id !== id);
  store().set('clips', next);
  return next;
}

export function clearClips(): Clip[] {
  store().set('clips', []);
  return [];
}

// ---------------------------------------------------------------------------
// Memo panel: TODO list + free-form memo
// ---------------------------------------------------------------------------

export function listTodos(): TodoItem[] {
  const todos = store().get('todos');
  return Array.isArray(todos) ? todos : [];
}

export function setTodos(todos: TodoItem[]): void {
  store().set('todos', todos);
}

export function getMemo(): string {
  const memo = store().get('memo');
  return typeof memo === 'string' ? memo : '';
}

export function setMemo(text: string): void {
  store().set('memo', typeof text === 'string' ? text : '');
}

export function getNotesPanelOpen(): boolean {
  return store().get('notesPanelOpen') ?? false;
}

export function setNotesPanelOpen(open: boolean): void {
  store().set('notesPanelOpen', open);
}

// ---------------------------------------------------------------------------
// Misc window / UI state
// ---------------------------------------------------------------------------

export function getClipPanelOpen(): boolean {
  return store().get('clipPanelOpen') ?? false;
}

export function setClipPanelOpen(open: boolean): void {
  store().set('clipPanelOpen', open);
}

export function getSidebarCollapsed(): boolean {
  return store().get('sidebarCollapsed') ?? false;
}

export function setSidebarCollapsed(collapsed: boolean): void {
  store().set('sidebarCollapsed', collapsed);
}

export function getAiPanelOpen(): boolean {
  return store().get('aiPanelOpen') ?? false;
}

export function setAiPanelOpen(open: boolean): void {
  store().set('aiPanelOpen', open);
}

export function getAiService(): AiService {
  const value = store().get('aiService');
  return isAiService(value) ? value : 'chatgpt';
}

export function setAiService(service: AiService): void {
  store().set('aiService', service);
}

export function getAiPanelWidth(): number {
  const value = store().get('aiPanelWidth');
  if (typeof value !== 'number' || !Number.isFinite(value)) return AI_PANEL_DEFAULT_W;
  return Math.min(AI_PANEL_MAX_W, Math.max(AI_PANEL_MIN_W, Math.round(value)));
}

export function setAiPanelWidth(width: number): void {
  store().set('aiPanelWidth', Math.min(AI_PANEL_MAX_W, Math.max(AI_PANEL_MIN_W, Math.round(width))));
}

// ---------------------------------------------------------------------------
// Parallel AI grid
// ---------------------------------------------------------------------------

export function getAiGridOpen(): boolean {
  return store().get('aiGridOpen') ?? false;
}

export function setAiGridOpen(open: boolean): void {
  store().set('aiGridOpen', open);
}

/** Sanitize a services list: keep only real services, de-dupe, cap at 4. */
function cleanServices(value: unknown): AiService[] {
  const list = Array.isArray(value) ? value.filter(isAiService) : [];
  const seen = new Set<AiService>();
  const deduped = list.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  return deduped.slice(0, 4);
}

/** Never returns empty: a stored empty/garbage list falls back to all four. */
export function getAiGridServices(): AiService[] {
  const clean = cleanServices(store().get('aiGridServices'));
  return clean.length > 0 ? clean : [...AI_SERVICE_ORDER];
}

export function setAiGridServices(services: AiService[]): void {
  const clean = cleanServices(services);
  store().set('aiGridServices', clean.length > 0 ? clean : [...AI_SERVICE_ORDER]);
}

export function getAiGridBroadcastSubmit(): boolean {
  return store().get('aiGridBroadcastSubmit') ?? true;
}

export function setAiGridBroadcastSubmit(submit: boolean): void {
  store().set('aiGridBroadcastSubmit', submit);
}

export function getWindowBounds(): Schema['windowBounds'] {
  return store().get('windowBounds') ?? null;
}

export function setWindowBounds(bounds: NonNullable<Schema['windowBounds']>): void {
  store().set('windowBounds', bounds);
}
