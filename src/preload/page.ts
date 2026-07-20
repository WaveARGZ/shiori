// Injected into every web page inside a WebContentsView.
//
// Runs in the isolated world: it shares the DOM with the page but not its
// JavaScript context, and it exposes nothing to the page via contextBridge —
// the site can neither see nor tamper with the measurements.
import { ipcRenderer } from 'electron';
import type { CopyReport, ScrollReport } from '../shared/types';

const REPORT_INTERVAL_MS = 250;

/**
 * Restoring a scroll position is a race against the page's own layout: images
 * load, fonts swap, frameworks hydrate, and the document grows under us. So we
 * re-apply the target on a decaying schedule rather than once.
 */
const RESTORE_SCHEDULE_MS = [0, 60, 120, 250, 400, 600, 900, 1300, 1800, 2400, 3200, 4200];

let restoreToken = 0;
let restoring = false;
let lastReportAt = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;

// Chromium restores scroll position on reload and back/forward on its own. Left
// enabled, that races our own restore for control of the same scrollTop and the
// landing position becomes nondeterministic. Ours is the mechanism that knows
// about 栞 (and fires for the bookmarked URL on back/forward too), so it takes
// exclusive ownership.
try {
  history.scrollRestoration = 'manual';
} catch {
  // Not supported here; our restore still runs, just with a rival.
}

function measure(): ScrollReport {
  const doc = document.documentElement;
  const body = document.body;
  const scrollY = Math.max(0, window.scrollY || doc.scrollTop || 0);
  const viewport = window.innerHeight || doc.clientHeight || 0;
  const docHeight = Math.max(doc.scrollHeight || 0, body ? body.scrollHeight : 0, viewport);
  const scrollable = Math.max(0, docHeight - viewport);
  // A page that fits on one screen has, by definition, been read to the end.
  const progress = scrollable <= 0 ? 1 : Math.min(1, Math.max(0, scrollY / scrollable));
  return { scrollY, progress, docHeight };
}

let lastSent: ScrollReport | null = null;

function report(): void {
  // While restoring, the document is still growing and window.scrollY is
  // clamped to a too-small maximum. Reporting now would overwrite the very
  // position we are trying to return to.
  if (restoring) return;
  lastReportAt = Date.now();
  const m = measure();
  // Inner-element scrolling (chat panes, code blocks) bubbles here in the
  // capture phase without moving window.scrollY at all; an identical report
  // would only cost an IPC round-trip + a store upsert for nothing.
  if (
    lastSent &&
    lastSent.scrollY === m.scrollY &&
    lastSent.progress === m.progress &&
    lastSent.docHeight === m.docHeight
  ) {
    return;
  }
  lastSent = m;
  ipcRenderer.send('shiori-page:scroll', m);
}

function onScroll(): void {
  if (trailing) return;
  const elapsed = Date.now() - lastReportAt;
  if (elapsed >= REPORT_INTERVAL_MS) {
    report();
    return;
  }
  trailing = setTimeout(() => {
    trailing = null;
    report();
  }, REPORT_INTERVAL_MS - elapsed);
}

window.addEventListener('scroll', onScroll, { passive: true, capture: true });
window.addEventListener('resize', onScroll, { passive: true });
// Last chance to record where the reader actually stopped.
window.addEventListener('pagehide', () => {
  restoring = false;
  report();
});

ipcRenderer.on('shiori-page:restore', (_event, targetY: number) => {
  if (!Number.isFinite(targetY) || targetY <= 0) return;

  const token = ++restoreToken;
  restoring = true;

  const stop = (): void => {
    // Always drop this restore's own listeners first: if a newer restore has
    // already taken over (token advanced), returning early before removal
    // would leak these four capture listeners on every reload.
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
      window.removeEventListener(type, stop, true);
    }
    if (token !== restoreToken) return;
    restoring = false;
    report();
  };

  // Any deliberate input means the reader has taken over; stop fighting them.
  for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
    window.addEventListener(type, stop, { passive: true, capture: true });
  }

  let step = 0;
  const tick = (): void => {
    if (token !== restoreToken || !restoring) return;
    window.scrollTo(0, targetY);
    step += 1;
    if (step < RESTORE_SCHEDULE_MS.length) {
      setTimeout(tick, RESTORE_SCHEDULE_MS[step]);
    } else {
      stop();
    }
  };
  setTimeout(tick, RESTORE_SCHEDULE_MS[0]);
});

// Capture phase, so we still see the selection on pages that swallow the event.
document.addEventListener(
  'copy',
  () => {
    const text = (window.getSelection()?.toString() ?? '').trim();
    if (!text) return;
    const payload: CopyReport = { text };
    ipcRenderer.send('shiori-page:copy', payload);
  },
  true,
);
