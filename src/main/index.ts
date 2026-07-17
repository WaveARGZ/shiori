import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { Browser } from './browser';
import { registerIpc } from './ipc';
import { flushBookmarks } from './store';

const browser = new Browser();

/** SHIORI_SMOKE=1 runs the end-to-end pass; =restart re-opens its profile. */
const smokeMode: 'fresh' | 'restart' | null =
  process.env.SHIORI_SMOKE === '1'
    ? 'fresh'
    : process.env.SHIORI_SMOKE === 'restart'
      ? 'restart'
      : null;

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Shiori',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: '新しいページ',
          accelerator: 'CmdOrCtrl+T',
          click: () => browser.goHome(),
        },
        {
          label: '新しいレーン',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => browser.newLane(''),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    // Without a real Edit menu, Cmd+C / Cmd+V do not work anywhere on macOS.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'アドレスバーへ移動',
          accelerator: 'CmdOrCtrl+L',
          click: () => browser.focusUrlBar(),
        },
        {
          label: '再読み込み',
          accelerator: 'CmdOrCtrl+R',
          click: () => browser.reload(),
        },
        { type: 'separator' },
        {
          label: '戻る',
          accelerator: 'CmdOrCtrl+[',
          click: () => browser.back(),
        },
        {
          label: '進む',
          accelerator: 'CmdOrCtrl+]',
          click: () => browser.forward(),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A second copy of Shiori would fight the first one over the same store file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Keep smoke runs out of the real profile. The 'fresh' run starts from an
    // empty one so its counts have a known-zero baseline; the 'restart' run
    // deliberately keeps it, because reopening what the previous launch wrote
    // is the whole point of that pass. Safe here only because the store is
    // built lazily, on first access inside browser.create().
    if (smokeMode) {
      const profile = join(app.getPath('temp'), 'shiori-smoke-profile');
      if (smokeMode === 'fresh') rmSync(profile, { recursive: true, force: true });
      app.setPath('userData', profile);
    }

    registerIpc(browser);
    buildMenu();
    browser.create();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) browser.create();
    });

    if (smokeMode) {
      void import('./smoke').then((m) => m.runSmoke(smokeMode));
    }
  });
}

app.on('window-all-closed', () => {
  flushBookmarks();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  flushBookmarks();
});
