/**
 * Electron main process: creates the window, serves the built app over a private app://
 * scheme (a secure origin, so the camera and WebAssembly work), grants camera access, and
 * performs mouse actions requested by the page through the preload bridge.
 *
 * Env:
 *   VITE_DEV_SERVER_URL  load the Vite dev server instead of the built files (npm run desktop)
 *   HG_DRY_RUN=1         log mouse actions instead of performing them
 *   HG_START_QUERY       query string appended to the start URL (e.g. "source=/x.jpg")
 *   HG_USER_DATA         separate profile folder (tests use one so they never touch your settings)
 */
'use strict';
const { app, BrowserWindow, globalShortcut, ipcMain, protocol, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const input = require('./input.cjs');
const apps = require('./apps.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || '';
const START_QUERY = process.env.HG_START_QUERY ? `?${process.env.HG_START_QUERY}` : '';
const DIST = path.join(__dirname, '..', 'dist');
const APP_ORIGIN = 'app://bundle';
const TOGGLE_SHORTCUT = 'CommandOrControl+Alt+H';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (process.env.HG_USER_DATA) app.setPath('userData', process.env.HG_USER_DATA);
// Mouse control must keep full speed while you use other apps: keep Chromium from slowing the
// page down when the window is minimised, covered or in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function isOurPage(frameUrl) {
  return frameUrl.startsWith(`${APP_ORIGIN}/`) || (DEV_URL && frameUrl.startsWith(DEV_URL));
}

async function serveApp(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
  try {
    const body = request.method === 'HEAD' ? null : await fs.readFile(file);
    if (body === null) await fs.access(file);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    title: 'HandGestures',
    backgroundColor: '#a69f98',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep tracking (and mouse control) running while the window is in the background.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    input.releaseAll();
    win = null;
  });
  win.webContents.on('render-process-gone', () => input.releaseAll());
  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isOurPage(url)) e.preventDefault();
  });
  win.loadURL(DEV_URL ? `${DEV_URL}${START_QUERY}` : `${APP_ORIGIN}/index.html${START_QUERY}`);
}

function registerIpc() {
  const guard = (fn) => (event, ...args) => {
    if (!event.senderFrame || !isOurPage(event.senderFrame.url)) return;
    return fn(...args);
  };
  ipcMain.on('input:move', guard((x, y) => input.moveTo(x, y)));
  ipcMain.on('input:button', guard((which, down) => input.button(which, down)));
  ipcMain.on('input:click', guard((which) => input.click(which)));
  ipcMain.on('input:scroll', guard((n) => input.scroll(n)));
  ipcMain.on('input:release', guard(() => input.releaseAll()));
  ipcMain.on('window:minimize-foreground', guard(() => input.minimizeForeground()));
  ipcMain.on('window:toggle-desktop', guard(() => input.toggleDesktop()));
  ipcMain.on('input:keys', guard((combo) => input.sendKeys(combo)));
  ipcMain.handle('apps:list', guard(() => apps.listApps()));
  ipcMain.handle('apps:pick', guard(() => apps.pickProgram(win)));
  ipcMain.on('apps:open', guard((app) => { void apps.openApp(app); }));
  ipcMain.on('window:on-top', guard((on) => win?.setAlwaysOnTop(!!on, 'floating')));
  ipcMain.handle('input:info', guard(() => ({
    available: input.available,
    dryRun: input.dryRun,
    error: input.loadError,
    screen: input.screenSize(),
    shortcut: TOGGLE_SHORTCUT.replace('CommandOrControl', 'Ctrl'),
  })));
}

app.whenReady().then(() => {
  protocol.handle('app', serveApp);

  const allow = new Set(['media', 'mediaKeySystem']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allow.has(permission) && isOurPage(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => allow.has(permission) && isOurPage(`${origin}/`));

  registerIpc();
  createWindow();

  // Works even when another app is focused: turns mouse control off/on.
  globalShortcut.register(TOGGLE_SHORTCUT, () => win?.webContents.send('control:toggle'));
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  input.releaseAll();
});
app.on('window-all-closed', () => app.quit());
