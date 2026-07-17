import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import type { Bookmark, Clip, Lane } from '../shared/types';

interface Schema {
  lanes: Lane[];
  activeLaneId: string;
  /** Keyed by normalized URL. */
  bookmarks: Record<string, Bookmark>;
  clips: Clip[];
  clipPanelOpen: boolean;
  windowBounds: { x?: number; y?: number; width: number; height: number } | null;
}

const MAX_CLIPS = 500;

function seedLanes(): Lane[] {
  return [
    { id: randomUUID(), name: '研究', color: '#7c9cff', pages: [], activePageId: null },
    { id: randomUUID(), name: '娯楽', color: '#ffb86c', pages: [], activePageId: null },
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
      activeLaneId: seeded[0]!.id,
      bookmarks: {},
      clips: [],
      clipPanelOpen: false,
      windowBounds: null,
    },
  });
  return instance;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export function getLanes(): Lane[] {
  const lanes = store().get('lanes');
  if (!Array.isArray(lanes) || lanes.length === 0) {
    const fresh = seedLanes();
    store().set('lanes', fresh);
    store().set('activeLaneId', fresh[0]!.id);
    return fresh;
  }
  return lanes;
}

export function setLanes(lanes: Lane[]): void {
  store().set('lanes', lanes);
}

export function getActiveLaneId(): string {
  const lanes = getLanes();
  const id = store().get('activeLaneId');
  if (lanes.some((l) => l.id === id)) return id;
  const fallback = lanes[0]!.id;
  store().set('activeLaneId', fallback);
  return fallback;
}

export function setActiveLaneId(id: string): void {
  store().set('activeLaneId', id);
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
 * flush on a debounce (and unconditionally on quit).
 */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (bookmarkCache) store().set('bookmarks', bookmarkCache);
  }, 1000);
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
// Misc window / UI state
// ---------------------------------------------------------------------------

export function getClipPanelOpen(): boolean {
  return store().get('clipPanelOpen') ?? false;
}

export function setClipPanelOpen(open: boolean): void {
  store().set('clipPanelOpen', open);
}

export function getWindowBounds(): Schema['windowBounds'] {
  return store().get('windowBounds') ?? null;
}

export function setWindowBounds(bounds: NonNullable<Schema['windowBounds']>): void {
  store().set('windowBounds', bounds);
}
