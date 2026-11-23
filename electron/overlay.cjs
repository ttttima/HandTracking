/**
 * A small status badge that follows the mouse pointer while PC control is on: the sign your hand
 * is making and what it does, a ring that fills while a pinch becomes a drag (or a sign is held),
 * "Dragging", and "Control on / off". It is a transparent window that ignores the mouse
 * completely, so clicks always go to whatever is under it.
 *
 * The page (overlay.html) only draws what the main window sends; this module places the window
 * next to the real cursor about 60 times a second while there is something to show.
 */
'use strict';
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

const W = 280;
const H = 60;
const OFFSET = 18;
const FOLLOW_MS = 16;
/** After the page fades the badge out, hide the window (no work at all while idle). */
const HIDE_AFTER_MS = 260;
const TONES = ['on', 'off', 'drag', 'pinch', 'sign'];

let win = null;
let followTimer = null;
let hideTimer = null;
let lastBounds = '';
let lastState = null;
let shown = false;

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'HandGestures pointer status',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('did-finish-load', () => { if (lastState) win?.webContents.send('overlay:state', lastState); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; shown = false; stopFollow(); });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  return win;
}

/** Next to the cursor (below right), flipped to stay on the screen the cursor is on. */
function place() {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).workArea;
  let x = p.x + OFFSET;
  let y = p.y + OFFSET;
  if (x + W > area.x + area.width) x = p.x - OFFSET - W;
  if (y + H > area.y + area.height) y = p.y - OFFSET - H;
  const bounds = { x: Math.round(x), y: Math.round(y), width: W, height: H };
  const key = `${bounds.x},${bounds.y}`;
  if (key === lastBounds) return;
  lastBounds = key;
  // setBounds (not setPosition) keeps the size right when moving between screens with different scaling.
  win.setBounds(bounds);
}

function startFollow() {
  if (!followTimer) followTimer = setInterval(place, FOLLOW_MS);
}
function stopFollow() {
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
}

/** @param {{ show: boolean, title?: string, detail?: string, progress?: number, tone?: string, hand?: string }} state */
function update(state) {
  if (!state || typeof state !== 'object') return;
  const clean = {
    show: !!state.show,
    title: String(state.title ?? '').slice(0, 60),
    detail: String(state.detail ?? '').slice(0, 80),
    progress: Number.isFinite(state.progress) ? Math.min(1, Math.max(-1, state.progress)) : -1,
    tone: TONES.includes(state.tone) ? state.tone : 'sign',
    hand: state.hand === 'Left' ? 'Left' : 'Right',
  };
  lastState = clean;
  if (clean.show) {
    clearTimeout(hideTimer);
    hideTimer = null;
    const w = ensure();
    w.webContents.send('overlay:state', clean);
    if (!shown) {
      lastBounds = '';
      place();
      w.showInactive();
      w.setAlwaysOnTop(true, 'screen-saver');
      shown = true;
    }
    startFollow();
  } else if (win && shown) {
    win.webContents.send('overlay:state', clean);
    if (!hideTimer) {
      hideTimer = setTimeout(() => {
        hideTimer = null;
        stopFollow();
        if (win && !win.isDestroyed() && !lastState?.show) { win.hide(); shown = false; }
      }, HIDE_AFTER_MS);
    }
  }
}

/** After a virtual desktop switch: show the badge again so Windows puts it on the new desktop. */
function reattach() {
  if (!win || win.isDestroyed() || !shown) return;
  win.hide();
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function destroy() {
  stopFollow();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  shown = false;
}

/** For tests: what the badge currently shows. */
const current = () => ({ ...(lastState ?? { show: false }), visible: shown });

module.exports = { update, reattach, destroy, current };
