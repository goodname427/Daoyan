/**
 * Electron 主进程。
 *
 * 开发：DAOYAN_DEV_URL 指向 Vite dev server（由 scripts/desktop.mjs 拉起）
 * 生产：加载 dist/index.html（由 npm run build 产出）
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const url = require('url');

/** 外部元法术目录：打包后在 exe 旁的 metas/，开发期在项目根 metas/ */
function metaDir() {
  return app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'metas')
    : path.join(__dirname, '..', 'metas');
}

ipcMain.handle('daoyan:listMetaFiles', () => {
  const dir = metaDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => url.pathToFileURL(path.join(dir, f)).href);
  } catch (e) {
    console.error('[metas] 扫描失败', e);
    return [];
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1000,
    minHeight: 700,
    title: '道衍 · 推演台',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.DAOYAN_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
