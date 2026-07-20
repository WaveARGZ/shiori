// Design-verification screenshots, run with SHIORI_SHOT=1.
//
// Boots against a throwaway seeded profile, captures the chrome webContents to
// PNG (the WebContentsView layers are separate native surfaces and do not
// appear — which is fine: it is the chrome design we are checking), and exits.
// Output goes to SHIORI_SHOT_DIR (default: cwd).
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { setLanes, setPages, setActivePageId, upsertBookmark, flushBookmarks } from './store';

const SEARCH_FIXTURE = `<!doctype html><html><body>
${[
  ['https://www.electronjs.org/docs', 'Electron ドキュメント — クロスプラットフォームのデスクトップアプリ', 'JavaScript、HTML、CSS でデスクトップアプリを作る。WebContentsView や BrowserWindow の API リファレンス。', 'www.electronjs.org'],
  ['https://developer.mozilla.org/ja/docs/Web/API/Drag_and_Drop_API', 'HTML ドラッグ&ドロップ API | MDN', 'draggable 属性と dragstart / dragover / drop イベントで、要素のドラッグ操作を実装する方法。', 'developer.mozilla.org'],
  ['https://ja.wikipedia.org/wiki/栞', '栞 - Wikipedia', '書物のページの間に挟んで、読みかけの位置を示すために用いる道具。しおり。', 'ja.wikipedia.org'],
  ['https://zenn.dev/topics/electron', 'Electron の記事一覧 - Zenn', 'Electron に関する日本語の技術記事。実装の落とし穴やパフォーマンスの知見。', 'zenn.dev'],
]
  .map(
    ([url, title, snip, host]) =>
      `<div class="result results_links results_links_deep web-result"><div class="result__body">
        <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">${title}</a></h2>
        <a class="result__snippet">${snip}</a>
        <div class="result__extras"><span class="result__url">${host}</span></div>
      </div></div>`,
  )
  .join('\n')}
</body></html>`;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fake but plausible content so the capture shows a lived-in UI. */
export function seed(): void {
  // Lanes are favorite folders: genre-organized pins that never change.
  const lanes = [
    {
      id: 'lane-research',
      name: '研究',
      color: '#7c9cff',
      favorites: [
        { url: 'https://arxiv.org/', title: 'arXiv' },
        { url: 'https://developer.mozilla.org/', title: 'MDN' },
        { url: 'https://zenn.dev/', title: 'Zenn' },
      ],
    },
    {
      id: 'lane-fun',
      name: '娯楽',
      color: '#ffb86c',
      favorites: [
        { url: 'https://www.youtube.com/', title: 'YouTube' },
        { url: 'https://www.aozora.gr.jp/', title: '青空文庫' },
      ],
    },
    {
      id: 'lane-shopping',
      name: '買い物',
      color: '#7ee787',
      favorites: [{ url: 'https://www.amazon.co.jp/', title: 'Amazon' }],
    },
  ];
  setLanes(lanes);
  // Open pages are a single global list, separate from lanes.
  setPages([
    { id: 'p1', url: 'https://arxiv.org/abs/2401.00001', title: 'Attention Is All You Need — 再読' },
    { id: 'p2', url: 'https://developer.mozilla.org/ja/docs/Web/API', title: 'Web API リファレンス | MDN' },
    { id: 'p3', url: 'https://zenn.dev/articles/electron-tips', title: 'Electron 実践 Tips 集' },
  ]);
  setActivePageId(null);

  const now = Date.now();
  upsertBookmark('https://arxiv.org/abs/2401.00001', {
    title: 'Attention Is All You Need — 再読',
    scrollY: 3200,
    progress: 0.42,
    maxProgress: 0.42,
    docHeight: 9000,
    lastVisited: now - 10 * 60 * 1000,
  });
  upsertBookmark('https://developer.mozilla.org/ja/docs/Web/API', {
    title: 'Web API リファレンス | MDN',
    scrollY: 800,
    progress: 0.88,
    maxProgress: 0.88,
    docHeight: 4000,
    lastVisited: now - 2 * 60 * 60 * 1000,
  });
  upsertBookmark('https://www.aozora.gr.jp/cards/000148/card773.html', {
    title: 'こころ — 夏目漱石(青空文庫)',
    scrollY: 12000,
    progress: 0.63,
    maxProgress: 0.63,
    docHeight: 30000,
    lastVisited: now - 26 * 60 * 60 * 1000,
  });
  flushBookmarks();
}

export async function runShot(): Promise<void> {
  const dir = process.env.SHIORI_SHOT_DIR || process.cwd();
  // Keep the panel off the network: the capture only shows chrome anyway.
  process.env.SHIORI_AI_URL = 'about:blank';

  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    if (win.webContents.isLoading()) {
      await new Promise<void>((r) => win.webContents.once('did-stop-loading', () => r()));
    }
    await delay(1200);

    // Fold one lane so the capture shows the collapse feature (娯楽 pins hidden).
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:toggle-lane-collapsed', { laneId: 'lane-fun' })",
    );
    await delay(300);

    const home = await win.webContents.capturePage();
    writeFileSync(join(dir, 'shot-home.png'), home.toPNG());

    // Memo panel: a TODO list (with one item done) beside the reading area.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:set-notes-panel', { open: true })");
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:add-todo', { text: '論文の続きを読む' })");
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:add-todo', { text: 'PR #42 をレビュー' })");
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:add-todo', { text: 'Electron 43 の変更点を確認' })");
    const firstTodoId = await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:get-notes').then((n) => n.todos[0].id)",
    );
    await win.webContents.executeJavaScript(
      `window.shiori.invoke('shiori:toggle-todo', { id: ${JSON.stringify(firstTodoId)} })`,
    );
    await delay(400);
    const notes = await win.webContents.capturePage();
    writeFileSync(join(dir, 'shot-notes.png'), notes.toPNG());
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:set-notes-panel', { open: false })");
    await delay(300);

    // Parallel AI grid: the tiled comparison stage and its broadcast bar. The
    // tile stages are native views (blank in the capture), so the shot verifies
    // exactly the chrome we designed — toolbar, service-accented tile heads, and
    // the broadcast composer with a sample prompt typed in.
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:ai-grid-open')");
    await delay(1000);
    await win.webContents.executeJavaScript(
      "(function(){var i=document.getElementById('broadcast-input'); if(i){i.value='この設計の長所と短所を、それぞれ3点で挙げて。';} })(); true",
    );
    await delay(150);
    const grid = await win.webContents.capturePage();
    writeFileSync(join(dir, 'shot-grid.png'), grid.toPNG());
    await win.webContents.executeJavaScript("window.shiori.invoke('shiori:ai-grid-close')");
    await delay(500);

    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:ai-open', { service: 'claude' })",
    );
    await delay(900);
    const ai = await win.webContents.capturePage();
    writeFileSync(join(dir, 'shot-ai.png'), ai.toPNG());

    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:set-clip-panel', { open: true })",
    );
    await delay(600);
    const clips = await win.webContents.capturePage();
    writeFileSync(join(dir, 'shot-clips.png'), clips.toPNG());

    // Freeze-frame of a page being dragged onto another lane, so the drop
    // feedback (source page dimmed, target lane lit, insertion line) is visible
    // in a still. This mirrors the classes the real dragover handlers apply.
    await win.webContents.executeJavaScript(`
      window.shiori.invoke('shiori:set-clip-panel', { open: false });
      (function () {
        const pages = document.querySelectorAll('#pages .chip');
        const lanes = document.querySelectorAll('#lanes .chip');
        if (pages[0]) pages[0].classList.add('dragging');
        if (pages[2]) pages[2].classList.add('drop-before');
        if (lanes[1]) lanes[1].classList.add('drop-target');
      })();
      true;
    `);
    await delay(400);
    const drag = await win.webContents.capturePage();
    writeFileSync(join(dir, 'shot-drag.png'), drag.toPNG());

    // Shiori's own search page (shiori://search), fed by a loopback fixture —
    // it renders inside the page view, so capture THAT webContents.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SEARCH_FIXTURE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    process.env.SHIORI_SEARCH_URL = `http://127.0.0.1:${port}/search`;
    process.env.SHIORI_ABSTRACT =
      'Electron は Web 技術（JavaScript・HTML・CSS）でクロスプラットフォームのデスクトップアプリを作るためのフレームワーク。Chromium と Node.js を同梱し、macOS・Windows・Linux で動作する。';
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:navigate', { url: 'electron ドラッグ 実装' })",
    );
    const { webContents } = await import('electron');
    let searchWc: Electron.WebContents | undefined;
    for (let i = 0; i < 40; i++) {
      searchWc = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL().startsWith('shiori://search'));
      if (searchWc && !searchWc.isLoading()) break;
      await delay(150);
    }
    if (searchWc) {
      await delay(400);
      const search = await searchWc.capturePage();
      writeFileSync(join(dir, 'shot-search.png'), search.toPNG());
    }

    // Image tab: a masonry thumbnail grid. Placeholder warm-toned tiles of
    // varying heights stand in for the real DuckDuckGo image results.
    const palette = ['c9a06a', 'b0764a', '8a9a5b', 'a86b4c', '6b8ea3', 'c98f6a', '7a8b57', 'bb7d55'];
    const tiles = Array.from({ length: 12 }, (_, i) => {
      const h = 130 + ((i * 47) % 130);
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='${h}'><rect width='100%' height='100%' fill='%23${palette[i % palette.length]}'/></svg>`;
      return {
        thumbnail: `data:image/svg+xml,${svg}`,
        title: `画像 ${i + 1}`,
        url: `https://example.com/photo/${i + 1}`,
        source: `example${i % 3 === 0 ? '.com' : i % 3 === 1 ? '.org' : '.net'}`,
      };
    });
    process.env.SHIORI_IMAGES = JSON.stringify(tiles);
    await win.webContents.executeJavaScript(
      "window.shiori.invoke('shiori:navigate', { url: 'shiori://search?q=neko&t=images' })",
    );
    for (let i = 0; i < 40; i++) {
      const n = searchWc
        ? await searchWc.executeJavaScript("document.querySelectorAll('.img-cell').length")
        : 0;
      if (n > 0) break;
      await delay(150);
    }
    if (searchWc) {
      await delay(500);
      const images = await searchWc.capturePage();
      writeFileSync(join(dir, 'shot-images.png'), images.toPNG());
    }
    server.close();

    console.log(`SHOTS WRITTEN: ${dir}`);
    app.exit(0);
  } catch (error) {
    console.error('shot failed:', error);
    app.exit(1);
  }
}
