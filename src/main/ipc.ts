import { ipcMain } from 'electron';
import { isAiService } from './ai';
import type { Browser } from './browser';
import type {
  AiGridRect,
  CopyReport,
  InvokeChannel,
  PageRect,
  ScrollReport,
} from '../shared/types';

function handle(channel: InvokeChannel, fn: (payload: any) => unknown): void {
  ipcMain.handle(channel, (_event, payload) => fn(payload));
}

/** Geometry arrives from the renderer's isolated world; never trust its shape. */
function isRect(value: unknown): value is PageRect {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  );
}

export function registerIpc(browser: Browser): void {
  handle('shiori:get-state', () => browser.state());
  handle('shiori:get-bookmarks', () => browser.bookmarks());
  handle('shiori:get-clips', () => browser.clips());

  handle('shiori:navigate', (p: { url: string }) => browser.navigate(p.url));
  handle('shiori:back', () => browser.back());
  handle('shiori:forward', () => browser.forward());
  handle('shiori:reload', () => browser.reload());
  handle('shiori:stop', () => browser.stop());

  handle('shiori:new-page', (p?: { url?: string }) => browser.newPage(p?.url));
  handle('shiori:close-page', (p: { pageId: string }) => browser.closePage(p.pageId));
  handle('shiori:activate-page', (p: { pageId: string }) => browser.activatePage(p.pageId));
  handle('shiori:move-page', (p: { pageId: string; beforePageId?: string | null }) => {
    if (typeof p?.pageId === 'string') {
      browser.movePage(p.pageId, typeof p.beforePageId === 'string' ? p.beforePageId : null);
    }
  });
  handle('shiori:go-home', () => browser.goHome());

  handle('shiori:new-lane', (p: { name: string }) => browser.newLane(p.name));
  handle('shiori:rename-lane', (p: { laneId: string; name: string }) =>
    browser.renameLane(p.laneId, p.name),
  );
  handle('shiori:delete-lane', (p: { laneId: string }) => browser.deleteLane(p.laneId));
  handle('shiori:toggle-lane-collapsed', (p: { laneId?: string }) => {
    if (typeof p?.laneId === 'string') browser.toggleLaneCollapsed(p.laneId);
  });

  // Favorites (lane pins).
  handle('shiori:pin-favorite', (p: { laneId?: string; pageId?: string }) => {
    if (typeof p?.laneId === 'string' && typeof p?.pageId === 'string') {
      browser.pinFavorite(p.laneId, p.pageId);
    }
  });
  handle('shiori:open-favorite', (p: { url?: string }) => {
    if (typeof p?.url === 'string') browser.openFavorite(p.url);
  });
  handle('shiori:remove-favorite', (p: { laneId?: string; url?: string }) => {
    if (typeof p?.laneId === 'string' && typeof p?.url === 'string') {
      browser.removeFavorite(p.laneId, p.url);
    }
  });
  handle(
    'shiori:move-favorite',
    (p: { laneId?: string; url?: string; targetLaneId?: string; beforeUrl?: string | null }) => {
      if (
        typeof p?.laneId === 'string' &&
        typeof p?.url === 'string' &&
        typeof p?.targetLaneId === 'string'
      ) {
        browser.moveFavorite(p.laneId, p.url, p.targetLaneId, typeof p.beforeUrl === 'string' ? p.beforeUrl : null);
      }
    },
  );

  handle('shiori:open-bookmark', (p: { url: string }) => browser.openBookmark(p.url));
  handle('shiori:delete-bookmark', (p: { url: string }) => browser.deleteBookmark(p.url));

  handle('shiori:copy-clip', (p: { id: string }) => browser.copyClip(p.id));
  handle('shiori:copy-all-clips', () => browser.copyAllClips());
  handle('shiori:delete-clip', (p: { id: string }) => browser.deleteClip(p.id));
  handle('shiori:clear-clips', () => browser.clearClips());
  handle('shiori:set-clip-panel', (p: { open: boolean }) => browser.setClipPanel(p.open));

  // Memo panel (TODO + free-form memo).
  handle('shiori:get-notes', () => browser.notes());
  handle('shiori:set-notes-panel', (p: { open?: boolean }) => browser.setNotesPanel(!!p?.open));
  handle('shiori:add-todo', (p: { text?: unknown }) =>
    browser.addTodo(typeof p?.text === 'string' ? p.text : ''),
  );
  handle('shiori:toggle-todo', (p: { id?: unknown }) =>
    typeof p?.id === 'string' ? browser.toggleTodo(p.id) : browser.notes().todos,
  );
  handle('shiori:delete-todo', (p: { id?: unknown }) =>
    typeof p?.id === 'string' ? browser.deleteTodo(p.id) : browser.notes().todos,
  );
  handle('shiori:clear-done-todos', () => browser.clearDoneTodos());
  handle('shiori:set-memo', (p: { text?: unknown }) =>
    browser.setMemo(typeof p?.text === 'string' ? p.text : ''),
  );
  handle('shiori:set-sidebar', (p: { collapsed: boolean }) => browser.setSidebar(!!p?.collapsed));

  handle('shiori:ai-open', (p: { service?: unknown }) => {
    if (isAiService(p?.service)) browser.openAi(p.service);
  });
  handle('shiori:ai-close', () => browser.closeAi());
  handle('shiori:ai-reload', () => browser.reloadAi());
  handle('shiori:ai-open-as-page', () => browser.openAiAsPage());
  handle('shiori:ai-resize', (p: { phase?: unknown; width?: unknown }) => {
    if (p?.phase === 'start' || p?.phase === 'end' || p?.phase === 'cancel') {
      browser.aiResize(p.phase, typeof p.width === 'number' ? p.width : undefined);
    }
  });

  // Parallel AI grid.
  const cleanServices = (value: unknown) =>
    Array.isArray(value) ? value.filter(isAiService) : [];
  handle('shiori:ai-grid-open', (p?: { services?: unknown }) =>
    browser.openAiGrid(cleanServices(p?.services)),
  );
  handle('shiori:ai-grid-close', () => browser.closeAiGrid());
  handle('shiori:ai-grid-toggle', () => browser.toggleAiGrid());
  handle('shiori:ai-grid-set-services', (p: { services?: unknown }) =>
    browser.setAiGridServices(cleanServices(p?.services)),
  );
  handle('shiori:ai-grid-set-submit', (p: { submit?: unknown }) =>
    browser.setBroadcastSubmit(!!p?.submit),
  );
  handle('shiori:ai-grid-tile-reload', (p: { service?: unknown }) => {
    if (isAiService(p?.service)) browser.reloadAiTile(p.service);
  });
  handle('shiori:ai-grid-tile-promote', (p: { service?: unknown }) => {
    if (isAiService(p?.service)) browser.promoteAiTile(p.service);
  });
  handle('shiori:ai-broadcast', (p: { text?: unknown; submit?: unknown }) => {
    if (typeof p?.text === 'string') return browser.broadcast(p.text, !!p.submit);
  });

  // The chrome renderer measures its own layout and tells us where the page
  // belongs, so CSS stays the single source of truth for the geometry.
  ipcMain.on('shiori:page-rect', (_event, rect: unknown) => {
    if (isRect(rect)) browser.setRect(rect);
  });
  ipcMain.on('shiori:ai-rect', (_event, rect: unknown) => {
    if (isRect(rect)) browser.setAiRect(rect);
  });
  // One message carries every visible tile's box; validate each entry.
  ipcMain.on('shiori:ai-grid-rects', (_event, payload: unknown) => {
    if (!Array.isArray(payload)) return;
    const list: AiGridRect[] = [];
    for (const entry of payload) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        if (isAiService(e.service) && isRect(e.rect)) list.push({ service: e.service, rect: e.rect });
      }
    }
    if (list.length > 0) browser.setAiGridRects(list);
  });

  // Reports from page preloads. These arrive from untrusted web content's
  // isolated world, so they are matched back to a view by sender identity.
  ipcMain.on('shiori-page:scroll', (event, report: ScrollReport) => {
    browser.handleScroll(event.sender, report);
  });
  ipcMain.on('shiori-page:copy', (event, report: CopyReport) => {
    browser.handleCopy(event.sender, report);
  });
}
