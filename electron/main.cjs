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
const desktops = require('./desktops.cjs');
const settingsFile = require('./settingsFile.cjs');
const overlay = require('./overlay.cjs');
globalThis.__hgOverlay = overlay.current; // for scripts/verify-desktop.mjs

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
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // the on/off sound plays without a click first
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
/** What the page last said was running (camera, mouse control): resumed after a crash. */
let runState = { camera: false, control: false };
/** Times the page was reloaded after crashing; stops trying if it keeps crashing. */
const crashReloads = [];
let hangTimer = null;
/** A page that has not answered for this long is hung: restart it. */
const HANG_MS = 20000;
const PING_MS = 5000;
let lastAnswer = Date.now();

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
    overlay.destroy();
    win = null;
  });
  // Long-run safety: if the page crashes, reload it and carry on; if it hangs for 15 s, end it (which
  // reloads it). Mouse buttons are released either way.
  win.webContents.on('render-process-gone', (_e, details) => {
    input.releaseAll();
    overlay.update({ show: false });
    clearTimeout(hangTimer);
    if (details.reason === 'clean-exit' || !win) return;
    console.warn(`[health] page gone (${details.reason}), reloading`);
    reloadAndResume();
  });
  win.webContents.on('unresponsive', () => {
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      console.warn('[health] page hung for 15 s, restarting it');
      input.releaseAll();
      win?.webContents.forcefullyCrashRenderer();
    }, 15000);
  });
  win.webContents.on('responsive', () => clearTimeout(hangTimer));
  win.webContents.on('did-start-loading', () => { lastAnswer = Date.now(); });
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

function reloadAndResume() {
  const now = Date.now();
  while (crashReloads.length && now - crashReloads[0] > 120000) crashReloads.shift();
  crashReloads.push(now);
  if (crashReloads.length > 3) return; // crashing in a loop: leave it for the user
  const parts = [runState.camera && 'camera', runState.control && 'control'].filter(Boolean);
  const q = parts.length ? `?resume=${parts.join(',')}` : '';
  win.loadURL(DEV_URL ? `${DEV_URL}${q}` : `${APP_ORIGIN}/index.html${q}`);
}

function registerIpc() {
  const guard = (fn) => (event, ...args) => {
    if (!event.senderFrame || !isOurPage(event.senderFrame.url)) return;
    return fn(...args);
  };
  ipcMain.on('app:state', guard((st) => { runState = { camera: !!st?.camera, control: !!st?.control }; }));
  ipcMain.on('input:move', guard((x, y, snap) => input.moveTo(x, y, !!snap)));
  ipcMain.handle('input:area', guard((mode) => input.setArea(mode)));
  ipcMain.on('input:button', guard((which, down) => input.button(which, down)));
  ipcMain.on('input:click', guard((which) => input.click(which)));
  ipcMain.on('input:scroll', guard((n) => input.scroll(n)));
  ipcMain.on('input:release', guard(() => input.releaseAll()));
  ipcMain.on('window:minimize-foreground', guard(() => input.minimizeForeground()));
  ipcMain.on('window:toggle-desktop', guard(() => input.toggleDesktop()));
  ipcMain.on('input:keys', guard((combo) => input.sendKeys(combo)));
  // Settings file: read synchronously at start-up (before the page loads any setting).
  ipcMain.on('settings:read', (event) => {
    event.returnValue = event.senderFrame && isOurPage(event.senderFrame.url) ? settingsFile.read() : null;
  });
  ipcMain.on('settings:write', guard((settings) => { settingsFile.write(settings); }));
  ipcMain.on('settings:write-now', (event, settings) => {
    event.returnValue = event.senderFrame && isOurPage(event.senderFrame.url) ? settingsFile.write(settings) : false;
  });
  ipcMain.handle('settings:path', guard(() => settingsFile.filePath()));
  ipcMain.on('settings:reveal', guard(() => shell.showItemInFolder(settingsFile.filePath())));
  ipcMain.on('desktop:switch', guard((which) => {
    void desktops.switchDesktop(which).then(() => setTimeout(overlay.reattach, 450));
  }));
  ipcMain.on('overlay:update', guard((state) => overlay.update(state)));
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

  // Hang watch. Electron only notices a hung page when it ignores keyboard or mouse input, and this
  // app is often used without touching its window. So every few seconds the page is asked to run a
  // tiny script: a busy page answers at once (even minimised), a hung one never does.
  setInterval(() => {
    const wc = win?.webContents;
    if (!wc || wc.isCrashed() || wc.isLoading()) { lastAnswer = Date.now(); return; }
    wc.executeJavaScript('1').then(() => { lastAnswer = Date.now(); }).catch(() => {});
    if (Date.now() - lastAnswer < HANG_MS) return;
    lastAnswer = Date.now();
    console.warn(`[health] page did not answer for ${HANG_MS / 1000} s, restarting it`);
    input.releaseAll();
    wc.forcefullyCrashRenderer(); // → render-process-gone → reloadAndResume
  }, PING_MS);

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
