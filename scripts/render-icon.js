// Renders the Shiori app icon to build/icon-raw.png with alpha, via a
// transparent offscreen window.
//
//   npx electron scripts/render-icon.js
//
// Design ("Outline"): a cream rounded tile with a thick espresso outline and a
// solid espresso bookmark (栞) mark centered inside. The wordmark is omitted so
// the mark stays legible at Dock/Finder sizes. Keep the bookmark path in sync
// with the in-app symbol (#i-logo) and search.ts (LOGO_SVG).
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const INK = '#45372a';
const PAPER = '#f2ece0';

const MARK = `<svg viewBox="0 0 120 150" xmlns="http://www.w3.org/2000/svg">
  <path d="M22 24 Q22 12 34 12 L86 12 Q98 12 98 24 L98 134 L60 102 L22 134 Z" fill="${INK}"/>
</svg>`;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1024px; height: 1024px; background: transparent; }
  .tile {
    position: absolute; left: 100px; top: 100px; width: 824px; height: 824px;
    border-radius: 184px;
    background: ${PAPER};
    border: 30px solid ${INK};
    box-shadow: 0 18px 40px rgba(50, 38, 24, 0.18);
    display: flex; align-items: center; justify-content: center;
  }
  svg { width: 300px; height: 375px; display: block; }
</style></head>
<body>
  <div class="tile">${MARK}</div>
</body></html>`;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 1024,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true },
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.capturePage();
    const out = join(__dirname, '..', 'build');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'icon-raw.png'), img.toPNG());
    const size = img.getSize();
    console.log(`ICON RENDERED ${size.width}x${size.height}`);
    app.exit(0);
  } catch (error) {
    console.error('icon render failed:', error);
    app.exit(1);
  }
});
