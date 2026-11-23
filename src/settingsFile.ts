/**
 * Desktop app: keeps every setting and keybind in a file (see electron/settingsFile.cjs).
 *
 * All modules save their settings under localStorage keys starting with "handgestures.". This
 * mirrors those keys to the settings file: on start the file is copied into localStorage (before
 * anything loads), and every later change to one of those keys is written back to the file.
 * In a plain browser there is no file and localStorage is used as before.
 */
const PREFIX = 'handgestures.';

export interface SettingsFileBridge {
  read(): { settings: Record<string, unknown> } | null;
  write(settings: Record<string, unknown>): void;
  writeNow(settings: Record<string, unknown>): void;
  path(): Promise<string>;
  reveal(): void;
}

function collect(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    const raw = localStorage.getItem(k) ?? '';
    try {
      out[k] = JSON.parse(raw); // stored readable in the file
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

/** Call once, before the app loads any setting. */
export function useSettingsFile(store: SettingsFileBridge | undefined): void {
  if (!store) return;
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return;
  }

  const saved = store.read();
  if (saved) {
    // The file is the source of truth: drop anything it does not have, then copy it in.
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (k?.startsWith(PREFIX) && !(k in saved.settings)) storage.removeItem(k);
    }
    for (const [k, v] of Object.entries(saved.settings)) {
      if (k.startsWith(PREFIX)) storage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

  let timer = 0;
  let dirty = false;
  const flush = () => {
    window.clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    store.write(collect());
  };
  const schedule = (key: string) => {
    if (!key.startsWith(PREFIX)) return;
    dirty = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(flush, 300);
  };

  // Every module saves through localStorage; catch those writes.
  const proto = Object.getPrototypeOf(storage) as Storage;
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    if (this === storage) schedule(String(key));
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    if (this === storage) schedule(String(key));
  };
  // Closing the window right after a change: write it before the page goes away.
  window.addEventListener('beforeunload', () => {
    if (dirty) {
      dirty = false;
      store.writeNow(collect());
    }
  });

  // First start with the file: save what there is, so the file exists from now on.
  if (!saved) {
    dirty = true;
    flush();
  }
}
