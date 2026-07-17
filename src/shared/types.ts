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
}

/** A context lane: replaces the tab strip as the top-level grouping. */
export interface Lane {
  id: string;
  name: string;
  color: string;
  pages: PageRef[];
  /** null means the lane is showing the home / "continue reading" screen. */
  activePageId: string | null;
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

export interface NavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

export interface LaneState {
  lanes: Lane[];
  activeLaneId: string;
}

export interface ChromeState {
  lanes: Lane[];
  activeLaneId: string;
  clipPanelOpen: boolean;
}

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  | 'shiori:go-home'
  | 'shiori:new-lane'
  | 'shiori:rename-lane'
  | 'shiori:delete-lane'
  | 'shiori:activate-lane'
  | 'shiori:open-bookmark'
  | 'shiori:delete-bookmark'
  | 'shiori:copy-clip'
  | 'shiori:copy-all-clips'
  | 'shiori:delete-clip'
  | 'shiori:clear-clips'
  | 'shiori:set-clip-panel';

export type SendChannel = 'shiori:page-rect';

export type EventChannel =
  | 'shiori:lanes'
  | 'shiori:nav'
  | 'shiori:bookmarks'
  | 'shiori:clips'
  | 'shiori:clip-panel'
  | 'shiori:progress'
  | 'shiori:focus-urlbar';

export interface ShioriApi {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T>;
  send(channel: SendChannel, payload?: unknown): void;
  on<T = any>(channel: EventChannel, listener: (payload: T) => void): () => void;
}
