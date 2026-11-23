/**
 * Keybinds: what each gesture does when PC control is on (Keybinds panel).
 * Pinch is not bindable: it is the mouse (click and drag).
 */
import type { StaticGestureId } from '../types';

export type BindTarget =
  | Exclude<StaticGestureId, 'pinch'>
  | 'swipe_left'
  | 'swipe_right'
  | 'swipe_up'
  | 'swipe_down';

export type ActionKind =
  | 'none'
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'scroll_up'
  | 'scroll_down'
  | 'minimize_window'
  | 'show_desktop'
  | 'pause_control'
  | 'open_app'
  | 'keys';

/** 'made' = as soon as the gesture is recognised, 'held' = after holding it about a second. */
export type Trigger = 'made' | 'held';

/** An installed app (Start-menu AppID) or a program file picked with Browse. */
export interface AppRef {
  name: string;
  id?: string;
  path?: string;
}

export interface Keybind {
  action: ActionKind;
  /** Only for action 'open_app'. */
  app?: AppRef;
  /** Only for action 'keys', e.g. "Ctrl+Shift+T". */
  keys?: string;
  trigger: Trigger;
}

export const BIND_TARGETS: { id: BindTarget; label: string; swipe?: boolean }[] = [
  { id: 'open_palm', label: 'Open palm' },
  { id: 'closed_palm', label: 'Closed palm' },
  { id: 'fist', label: 'Fist' },
  { id: 'pointing', label: 'Pointing' },
  { id: 'peace', label: 'Peace' },
  { id: 'middle_finger', label: 'Middle finger' },
  { id: 'thumbs_up', label: 'Thumbs up' },
  { id: 'thumbs_down', label: 'Thumbs down' },
  { id: 'swipe_left', label: 'Swipe left', swipe: true },
  { id: 'swipe_right', label: 'Swipe right', swipe: true },
  { id: 'swipe_up', label: 'Swipe up', swipe: true },
  { id: 'swipe_down', label: 'Swipe down', swipe: true },
];

export const ACTIONS: { id: ActionKind; label: string }[] = [
  { id: 'none', label: 'Nothing' },
  { id: 'left_click', label: 'Left click' },
  { id: 'right_click', label: 'Right click' },
  { id: 'double_click', label: 'Double click' },
  { id: 'scroll_up', label: 'Scroll up' },
  { id: 'scroll_down', label: 'Scroll down' },
  { id: 'minimize_window', label: 'Minimise window' },
  { id: 'show_desktop', label: 'Show desktop / bring windows back (Win+D)' },
  { id: 'pause_control', label: 'Pause or resume control' },
  { id: 'open_app', label: 'Open an app…' },
  { id: 'keys', label: 'Keyboard shortcut…' },
];

export const KEY_PRESETS: { keys: string; label: string }[] = [
  { keys: 'Alt+Tab', label: 'Switch window (Alt+Tab)' },
  { keys: 'Win+Tab', label: 'Task view (Win+Tab)' },
  { keys: 'Alt+F4', label: 'Close window (Alt+F4)' },
  { keys: 'Win+E', label: 'File Explorer (Win+E)' },
  { keys: 'Ctrl+C', label: 'Copy (Ctrl+C)' },
  { keys: 'Ctrl+V', label: 'Paste (Ctrl+V)' },
  { keys: 'Ctrl+Z', label: 'Undo (Ctrl+Z)' },
  { keys: 'Ctrl+Tab', label: 'Next tab (Ctrl+Tab)' },
  { keys: 'Ctrl+Shift+Tab', label: 'Previous tab (Ctrl+Shift+Tab)' },
  { keys: 'Alt+Left', label: 'Back (Alt+Left)' },
  { keys: 'Alt+Right', label: 'Forward (Alt+Right)' },
  { keys: 'MediaPlayPause', label: 'Play / pause media' },
  { keys: 'MediaNext', label: 'Next track' },
  { keys: 'MediaPrev', label: 'Previous track' },
  { keys: 'VolumeUp', label: 'Volume up' },
  { keys: 'VolumeDown', label: 'Volume down' },
  { keys: 'VolumeMute', label: 'Mute' },
  { keys: 'Win+Shift+S', label: 'Screenshot (Win+Shift+S)' },
  { keys: 'Esc', label: 'Escape' },
  { keys: 'Enter', label: 'Enter' },
  { keys: 'Space', label: 'Space' },
];

const none = (): Keybind => ({ action: 'none', trigger: 'made' });

/** Defaults match what the app did before keybinds existed. */
export function defaultKeybinds(): Record<BindTarget, Keybind> {
  const map = Object.fromEntries(BIND_TARGETS.map((t) => [t.id, none()])) as Record<BindTarget, Keybind>;
  map.peace = { action: 'right_click', trigger: 'made' };
  map.middle_finger = { action: 'minimize_window', trigger: 'made' };
  map.fist = { action: 'pause_control', trigger: 'held' };
  map.swipe_up = { action: 'scroll_up', trigger: 'made' };
  map.swipe_down = { action: 'scroll_down', trigger: 'made' };
  return map;
}

/** Live, mutable keybinds shared by the controller and the panel. */
export const keybinds: Record<BindTarget, Keybind> = defaultKeybinds();

const STORAGE = 'handgestures.keybinds.v1';
const ACTION_IDS = new Set(ACTIONS.map((a) => a.id));

export function loadKeybinds(): void {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE) ?? '{}') as Partial<Record<BindTarget, Keybind>>;
    for (const t of BIND_TARGETS) {
      const b = saved[t.id];
      if (!b || !ACTION_IDS.has(b.action)) continue;
      const app = b.app && typeof b.app.name === 'string' && (typeof b.app.id === 'string' || typeof b.app.path === 'string')
        ? { name: b.app.name, id: typeof b.app.id === 'string' ? b.app.id : undefined, path: typeof b.app.path === 'string' ? b.app.path : undefined }
        : undefined;
      keybinds[t.id] = { action: b.action, keys: typeof b.keys === 'string' ? b.keys : undefined, app, trigger: b.trigger === 'held' && !t.swipe ? 'held' : 'made' };
    }
  } catch {
    /* keep defaults */
  }
}

export function saveKeybinds(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE, JSON.stringify(keybinds));
  } catch {
    /* ignore */
  }
}

export function resetKeybinds(): void {
  Object.assign(keybinds, defaultKeybinds());
  saveKeybinds();
}

// ── Key combos ──────────────────────────────────────────────────────────────

export const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Win'] as const;

const NAMED_KEYS = [
  'Enter', 'Esc', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Left', 'Up', 'Right', 'Down', 'PrintScreen', 'CapsLock',
  'VolumeMute', 'VolumeDown', 'VolumeUp', 'MediaNext', 'MediaPrev', 'MediaStop', 'MediaPlayPause',
];

const ALIASES: Record<string, string> = {
  control: 'Ctrl', ctl: 'Ctrl', option: 'Alt', meta: 'Win', windows: 'Win', super: 'Win', cmd: 'Win', os: 'Win',
  escape: 'Esc', return: 'Enter', spacebar: 'Space', del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown',
  arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', prtsc: 'PrintScreen',
  mute: 'VolumeMute', playpause: 'MediaPlayPause', next: 'MediaNext', prev: 'MediaPrev', previous: 'MediaPrev',
};

function canonical(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  for (const m of MODIFIERS) if (m.toLowerCase() === lower) return m;
  for (const k of NAMED_KEYS) if (k.toLowerCase() === lower) return k;
  if (/^[a-z0-9]$/i.test(t)) return t.toUpperCase();
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(t);
  if (f) return `F${f[1]}`;
  return null;
}

/**
 * Normalise a combo like "ctrl + shift + t" to "Ctrl+Shift+T".
 * Returns null if any part is unknown or there are two non-modifier keys.
 */
export function normalizeCombo(input: string): string | null {
  const parts = input.split('+').map(canonical);
  if (!parts.length || parts.some((p) => p === null)) return null;
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  const keys = [...new Set(parts.filter((p) => !(MODIFIERS as readonly string[]).includes(p!)))] as string[];
  if (keys.length > 1) return null;
  if (!mods.length && !keys.length) return null;
  return [...mods, ...keys].join('+');
}

/** Turn a browser keydown into a combo, or null while only modifiers are held. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else {
    const map: Record<string, string> = {
      Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PrintScreen: 'PrintScreen',
      CapsLock: 'CapsLock', AudioVolumeMute: 'VolumeMute', AudioVolumeDown: 'VolumeDown', AudioVolumeUp: 'VolumeUp',
      MediaTrackNext: 'MediaNext', MediaTrackPrevious: 'MediaPrev', MediaStop: 'MediaStop', MediaPlayPause: 'MediaPlayPause',
    };
    key = map[code] ?? null;
  }
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean) as string[];
  return [...mods, key].join('+');
}

export function describeBind(b: Keybind): string {
  if (b.action === 'keys') return b.keys ? b.keys : 'No shortcut set';
  if (b.action === 'open_app') return b.app ? `Open ${b.app.name}` : 'No app chosen';
  return ACTIONS.find((a) => a.id === b.action)?.label ?? b.action;
}
