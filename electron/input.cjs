/**
 * Native mouse control for Windows through user32.dll (via koffi, no compiler needed).
 *
 * All coordinates arrive normalised (0..1) and are mapped to the primary screen in physical
 * pixels (Electron runs per-monitor DPI aware, so GetSystemMetrics / SetCursorPos agree).
 *
 * HG_DRY_RUN=1 logs every call instead of performing it (used by the automated checks).
 */
'use strict';

const DRY_RUN = process.env.HG_DRY_RUN === '1';
const log = [];
globalThis.__hgInputLog = log;

const MOUSEEVENTF = {
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  WHEEL: 0x0800,
};
const WHEEL_DELTA = 120;

let user32 = null;
let loadError = null;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    user32 = {
      SetCursorPos: lib.func('bool __stdcall SetCursorPos(int x, int y)'),
      GetSystemMetrics: lib.func('int __stdcall GetSystemMetrics(int index)'),
      mouse_event: lib.func('void __stdcall mouse_event(uint32 flags, uint32 dx, uint32 dy, int32 data, uintptr extra)'),
      GetForegroundWindow: lib.func('void * __stdcall GetForegroundWindow()'),
      ShowWindow: lib.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
      keybd_event: lib.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)'),
    };
  } catch (err) {
    loadError = err;
  }
} else {
  loadError = new Error('PC control is only implemented for Windows.');
}

let screen = { width: 1920, height: 1080 };
let screenReadAt = 0;
function screenSize() {
  const now = Date.now();
  if (user32 && now - screenReadAt > 2000) {
    screen = { width: user32.GetSystemMetrics(0), height: user32.GetSystemMetrics(1) };
    screenReadAt = now;
  }
  return screen;
}

const pressed = { left: false, right: false };

function record(entry) {
  log.push({ t: Date.now(), ...entry });
  if (log.length > 500) log.shift();
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);

function moveTo(nx, ny) {
  const { width, height } = screenSize();
  const x = Math.round(clamp01(nx) * (width - 1));
  const y = Math.round(clamp01(ny) * (height - 1));
  if (DRY_RUN || !user32) return record({ op: 'move', x, y });
  user32.SetCursorPos(x, y);
}

function button(which, down) {
  if (which !== 'left' && which !== 'right') return;
  if (pressed[which] === down) return;
  pressed[which] = down;
  const flag = MOUSEEVENTF[`${which.toUpperCase()}${down ? 'DOWN' : 'UP'}`];
  if (DRY_RUN || !user32) return record({ op: down ? 'down' : 'up', button: which });
  user32.mouse_event(flag, 0, 0, 0, 0);
}

function click(which) {
  if (which !== 'left' && which !== 'right') return;
  if (DRY_RUN || !user32) return record({ op: 'click', button: which });
  const up = MOUSEEVENTF[`${which.toUpperCase()}UP`];
  const downFlag = MOUSEEVENTF[`${which.toUpperCase()}DOWN`];
  user32.mouse_event(downFlag, 0, 0, 0, 0);
  user32.mouse_event(up, 0, 0, 0, 0);
}

/** Positive = scroll up (away from the user), negative = down. */
function scroll(notches) {
  const n = Math.max(-20, Math.min(20, Math.round(Number(notches) || 0)));
  if (!n) return;
  if (DRY_RUN || !user32) return record({ op: 'scroll', notches: n });
  user32.mouse_event(MOUSEEVENTF.WHEEL, 0, 0, n * WHEEL_DELTA, 0);
}

const SW_MINIMIZE = 6;

/** Minimise whichever window is currently in front (the one you are using). */
function minimizeForeground() {
  if (DRY_RUN || !user32) return record({ op: 'minimize' });
  const hwnd = user32.GetForegroundWindow();
  if (hwnd) user32.ShowWindow(hwnd, SW_MINIMIZE);
}

const VK_LWIN = 0x5b;
const VK_D = 0x44;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;

/**
 * Win+D: shows the desktop, and pressed again restores every window exactly as it was.
 * Windows tracks that toggle itself, which is why it is used for both directions.
 */
function toggleDesktop() {
  if (DRY_RUN || !user32) return record({ op: 'win+d' });
  user32.keybd_event(VK_LWIN, 0, KEYEVENTF_EXTENDEDKEY, 0);
  user32.keybd_event(VK_D, 0, 0, 0);
  user32.keybd_event(VK_D, 0, KEYEVENTF_KEYUP, 0);
  user32.keybd_event(VK_LWIN, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────
const VK = {
  Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Win: 0x5b,
  Enter: 0x0d, Esc: 0x1b, Space: 0x20, Tab: 0x09, Backspace: 0x08, Delete: 0x2e, Insert: 0x2d,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28,
  PrintScreen: 0x2c, CapsLock: 0x14,
  VolumeMute: 0xad, VolumeDown: 0xae, VolumeUp: 0xaf, MediaNext: 0xb0, MediaPrev: 0xb1, MediaStop: 0xb2, MediaPlayPause: 0xb3,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(65 + i)] = 65 + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
for (let i = 1; i <= 24; i++) VK[`F${i}`] = 0x6f + i;
const EXTENDED = new Set(['Win', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Left', 'Up', 'Right', 'Down',
  'PrintScreen', 'VolumeMute', 'VolumeDown', 'VolumeUp', 'MediaNext', 'MediaPrev', 'MediaStop', 'MediaPlayPause']);
const MODS = ['Ctrl', 'Alt', 'Shift', 'Win'];

/** Parse "Ctrl+Shift+T" into known key names (null if anything is unknown). */
function parseCombo(combo) {
  if (typeof combo !== 'string' || combo.length > 60) return null;
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 5) return null;
  for (const p of parts) if (!(p in VK)) return null;
  const mods = MODS.filter((m) => parts.includes(m));
  const keys = parts.filter((p) => !MODS.includes(p));
  if (keys.length > 1) return null;
  return [...mods, ...keys];
}

/** Press a shortcut: modifiers down, key down/up, modifiers up (in reverse). */
function sendKeys(combo) {
  const keys = parseCombo(combo);
  if (!keys) return record({ op: 'keys-rejected', combo: String(combo).slice(0, 60) });
  if (DRY_RUN || !user32) return record({ op: 'keys', combo: keys.join('+') });
  const flags = (k) => (EXTENDED.has(k) ? KEYEVENTF_EXTENDEDKEY : 0);
  for (const k of keys) user32.keybd_event(VK[k], 0, flags(k), 0);
  for (const k of [...keys].reverse()) user32.keybd_event(VK[k], 0, flags(k) | KEYEVENTF_KEYUP, 0);
}

/** Never leave a button stuck down (window closed, renderer crashed, control switched off). */
function releaseAll() {
  button('left', false);
  button('right', false);
}

module.exports = {
  available: !!user32,
  dryRun: DRY_RUN,
  loadError: loadError ? String(loadError.message || loadError) : null,
  screenSize,
  moveTo,
  button,
  click,
  scroll,
  minimizeForeground,
  toggleDesktop,
  sendKeys,
  releaseAll,
};
