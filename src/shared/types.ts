// Shared type contract between main, preload and renderer.
//
// IMPORTANT: this file must stay types-only (no runtime values). The renderer is
// loaded as a classic script with no bundler, so every `import type` from here
// has to be fully erased at emit. A single `const` or `enum` would emit a real
// import statement and break the renderer at load time.

/** A page currently open inside a lane. */
export interface PageRef {
  id: string;
  url: string;
  title: string;
  /** Favicon URL as reported by the page; attacker-controlled, render-only. */
  favicon?: string;
}

/** The AI chat services reachable from the quick-access dock. */
export type AiService = 'chatgpt' | 'gemini' | 'claude' | 'perplexity';

/** State of the AI side panel (Edge-Copilot-style docked chat). */
export interface AiState {
  open: boolean;
  service: AiService;
  width: number;
}

/**
 * State of the parallel AI mode: several chat services tiled across the whole
 * stage at once, so the same question can be broadcast to all of them and the
 * answers compared side by side. Still not an agent — every tile is the same
 * live web session that the side panel uses, just several on screen together.
 */
export interface AiGridState {
  open: boolean;
  /** Which services occupy the grid, in tile order (1–4, de-duped). */
  services: AiService[];
  /**
   * Whether the broadcast bar submits after filling each composer (⌘↵ sends to
   * every tile), or only fills the composer and lets the user press Enter.
   */
  broadcastSubmit: boolean;
}

/** A pinned favorite site inside a lane. Persistent — unlike a page, navigating
 *  never changes it, so a lane keeps its YouTube pin even as you browse away. */
export interface Favorite {
  url: string;
  title: string;
  /** Favicon URL captured when pinned; attacker-controlled, render-only. */
  favicon?: string;
}

/** A lane: a genre folder of favorite pins. Lanes no longer contain live pages —
 *  the open pages are one global list (see LaneState.pages), kept separate so a
 *  lane's pins stay put while you browse. */
export interface Lane {
  id: string;
  name: string;
  color: string;
  favorites: Favorite[];
  /** Folded in the sidebar: its pins are hidden until expanded. */
  collapsed?: boolean;
}

/** The universal bookmark: reading state remembered per URL, forever. */
export interface Bookmark {
  url: string;
  title: string;
  scrollY: number;
  /** Where the reader was when they left, 0..1. */
  progress: number;
  /** Furthest point ever reached, 0..1. This is the 読了率 we display. */
  maxProgress: number;
  lastVisited: number;
  /** Total scrollable height at last measure; used to detect layout changes. */
  docHeight: number;
}

/** A copied excerpt with its provenance attached. */
export interface Clip {
  id: string;
  text: string;
  url: string;
  title: string;
  createdAt: number;
}

/** A single task in the memo panel's TODO list. */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

/** The memo panel's contents: a TODO list plus a free-form scratchpad. */
export interface NotesState {
  todos: TodoItem[];
  memo: string;
}

export interface NavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

/** Sidebar state: the favorite lanes plus the single global list of open pages. */
export interface LaneState {
  lanes: Lane[];
  pages: PageRef[];
  activePageId: string | null;
}

export interface ChromeState {
  lanes: Lane[];
  pages: PageRef[];
  activePageId: string | null;
  clipPanelOpen: boolean;
  notesPanelOpen: boolean;
  sidebarCollapsed: boolean;
  ai: AiState;
  aiGrid: AiGridState;
}

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One tile's measured box in the parallel AI grid, keyed by service. */
export interface AiGridRect {
  service: AiService;
  rect: PageRect;
}

/** Per-tile outcome of a broadcast, surfaced back to the chrome as a pill. */
export interface BroadcastResult {
  service: AiService;
  /** 'filled' = text went in; 'sent' = also submitted; 'missed' = no composer. */
  status: 'filled' | 'sent' | 'missed';
}

/** Live reading-progress tick pushed to the chrome while scrolling. */
export interface ProgressTick {
  pageId: string;
  progress: number;
  maxProgress: number;
}

/** Payload sent by the page preload as the user scrolls. */
export interface ScrollReport {
  scrollY: number;
  progress: number;
  docHeight: number;
}

/** Payload sent by the page preload when the user copies a selection. */
export interface CopyReport {
  text: string;
}

/**
 * Channel names are unions rather than runtime constants so that the renderer
 * gets compile-time checking without importing anything at runtime.
 */
export type InvokeChannel =
  | 'shiori:get-state'
  | 'shiori:get-bookmarks'
  | 'shiori:get-clips'
  | 'shiori:navigate'
  | 'shiori:back'
  | 'shiori:forward'
  | 'shiori:reload'
  | 'shiori:stop'
  | 'shiori:new-page'
  | 'shiori:close-page'
  | 'shiori:activate-page'
  | 'shiori:move-page'
  | 'shiori:go-home'
  | 'shiori:new-lane'
  | 'shiori:rename-lane'
  | 'shiori:delete-lane'
  | 'shiori:toggle-lane-collapsed'
  | 'shiori:pin-favorite'
  | 'shiori:open-favorite'
  | 'shiori:remove-favorite'
  | 'shiori:move-favorite'
  | 'shiori:open-bookmark'
  | 'shiori:delete-bookmark'
  | 'shiori:copy-clip'
  | 'shiori:copy-all-clips'
  | 'shiori:delete-clip'
  | 'shiori:clear-clips'
  | 'shiori:set-clip-panel'
  | 'shiori:get-notes'
  | 'shiori:set-notes-panel'
  | 'shiori:add-todo'
  | 'shiori:toggle-todo'
  | 'shiori:delete-todo'
  | 'shiori:clear-done-todos'
  | 'shiori:set-memo'
  | 'shiori:set-sidebar'
  | 'shiori:ai-open'
  | 'shiori:ai-close'
  | 'shiori:ai-reload'
  | 'shiori:ai-open-as-page'
  | 'shiori:ai-resize'
  | 'shiori:ai-grid-open'
  | 'shiori:ai-grid-close'
  | 'shiori:ai-grid-toggle'
  | 'shiori:ai-grid-set-services'
  | 'shiori:ai-grid-tile-reload'
  | 'shiori:ai-grid-tile-promote'
  | 'shiori:ai-grid-set-submit'
  | 'shiori:ai-broadcast';

export type SendChannel = 'shiori:page-rect' | 'shiori:ai-rect' | 'shiori:ai-grid-rects';

export type EventChannel =
  | 'shiori:lanes'
  | 'shiori:nav'
  | 'shiori:bookmarks'
  | 'shiori:clips'
  | 'shiori:clip-panel'
  | 'shiori:notes-panel'
  | 'shiori:todos'
  | 'shiori:sidebar'
  | 'shiori:ai'
  | 'shiori:ai-grid'
  | 'shiori:ai-broadcast-result'
  | 'shiori:fullscreen'
  | 'shiori:progress'
  | 'shiori:focus-urlbar';

export interface ShioriApi {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T>;
  send(channel: SendChannel, payload?: unknown): void;
  on<T = any>(channel: EventChannel, listener: (payload: T) => void): () => void;
}
