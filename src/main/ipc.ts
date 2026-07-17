import { ipcMain } from 'electron';
import type { Browser } from './browser';
import type { CopyReport, InvokeChannel, PageRect, ScrollReport } from '../shared/types';

function handle(channel: InvokeChannel, fn: (payload: any) => unknown): void {
  ipcMain.handle(channel, (_event, payload) => fn(payload));
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
  handle('shiori:go-home', () => browser.goHome());

  handle('shiori:new-lane', (p: { name: string }) => browser.newLane(p.name));
  handle('shiori:rename-lane', (p: { laneId: string; name: string }) =>
    browser.renameLane(p.laneId, p.name),
  );
  handle('shiori:delete-lane', (p: { laneId: string }) => browser.deleteLane(p.laneId));
  handle('shiori:activate-lane', (p: { laneId: string }) => browser.activateLane(p.laneId));

  handle('shiori:open-bookmark', (p: { url: string }) => browser.openBookmark(p.url));
  handle('shiori:delete-bookmark', (p: { url: string }) => browser.deleteBookmark(p.url));

  handle('shiori:copy-clip', (p: { id: string }) => browser.copyClip(p.id));
  handle('shiori:copy-all-clips', () => browser.copyAllClips());
  handle('shiori:delete-clip', (p: { id: string }) => browser.deleteClip(p.id));
  handle('shiori:clear-clips', () => browser.clearClips());
  handle('shiori:set-clip-panel', (p: { open: boolean }) => browser.setClipPanel(p.open));

  // The chrome renderer measures its own layout and tells us where the page
  // belongs, so CSS stays the single source of truth for the geometry.
  ipcMain.on('shiori:page-rect', (_event, rect: PageRect) => browser.setRect(rect));

  // Reports from page preloads. These arrive from untrusted web content's
  // isolated world, so they are matched back to a view by sender identity.
  ipcMain.on('shiori-page:scroll', (event, report: ScrollReport) => {
    browser.handleScroll(event.sender, report);
  });
  ipcMain.on('shiori-page:copy', (event, report: CopyReport) => {
    browser.handleCopy(event.sender, report);
  });
}
