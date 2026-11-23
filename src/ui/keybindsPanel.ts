/** Keybinds drawer: pick what each gesture does when PC control is on. */
import { isEnabled, type ToggleId } from '../config';
import {
  ACTIONS, BIND_TARGETS, KEY_PRESETS, comboFromEvent, keybinds, normalizeCombo, resetKeybinds, saveKeybinds,
  type ActionKind, type BindTarget, type Trigger,
} from '../control/keybinds';
import { $, el } from './dom';

interface Row {
  target: BindTarget;
  appBox: HTMLElement;
  appSearch: HTMLInputElement;
  appSelect: HTMLSelectElement;
  appNote: HTMLElement;
  swipe: boolean;
  action: HTMLSelectElement;
  trigger: HTMLSelectElement | null;
  keysBox: HTMLElement;
  keys: HTMLInputElement;
  record: HTMLButtonElement;
  preset: HTMLSelectElement;
  note: HTMLElement;
  off: HTMLElement;
}

export class KeybindsPanel {
  private drawer = $('keybinds');
  private backdrop = $('drawer-backdrop');
  private button = $('btn-keybinds');
  private rows: Row[] = [];
  private recording: Row | null = null;
  private apps: { name: string; id: string }[] | null = null;
  private appsLoading = false;

  constructor() {
    const list = $('keybind-list');
    for (const t of BIND_TARGETS) list.append(this.buildRow(t.id, t.label, !!t.swipe));
    this.button.addEventListener('click', () => this.toggle());
    $('btn-close-keybinds').addEventListener('click', () => this.toggle(false));
    this.backdrop.addEventListener('click', () => this.toggle(false));
    $('btn-reset-keybinds').addEventListener('click', () => {
      resetKeybinds();
      this.refresh();
    });
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    this.refresh();
  }

  private buildRow(target: BindTarget, label: string, swipe: boolean): HTMLElement {
    const wrap = el('div', 'bind-row');
    const name = el('div', 'bind-name', label);
    const off = el('small', 'bind-off', 'Turned off in Settings → Gestures');
    name.append(off);

    const action = el('select');
    action.setAttribute('aria-label', `${label}: action`);
    for (const a of ACTIONS) action.append(new Option(a.label, a.id));

    let trigger: HTMLSelectElement | null = null;
    if (!swipe) {
      trigger = el('select');
      trigger.setAttribute('aria-label', `${label}: when`);
      trigger.append(new Option('When made', 'made'), new Option('When held', 'held'));
    }

    const keysBox = el('div', 'bind-keys');
    const keys = el('input');
    keys.type = 'text';
    keys.placeholder = 'e.g. Ctrl+Shift+T';
    keys.spellcheck = false;
    keys.setAttribute('aria-label', `${label}: shortcut`);
    const record = el('button', 'btn quiet small', 'Record');
    record.type = 'button';
    const preset = el('select');
    preset.setAttribute('aria-label', `${label}: common shortcuts`);
    preset.append(new Option('Common shortcuts…', ''));
    for (const p of KEY_PRESETS) preset.append(new Option(p.label, p.keys));
    const note = el('small', 'bind-note');
    keysBox.append(keys, record, preset, note);

    // App picker (action "Open an app").
    const appBox = el('div', 'bind-app');
    const appSearch = el('input');
    appSearch.type = 'search';
    appSearch.placeholder = 'Search installed apps';
    appSearch.setAttribute('aria-label', `${label}: search apps`);
    const browse = el('button', 'btn quiet small', 'Browse…');
    browse.type = 'button';
    browse.title = 'Pick a program that is not in the list (.exe or shortcut)';
    const appSelect = el('select');
    appSelect.setAttribute('aria-label', `${label}: app`);
    const appNote = el('small', 'bind-note');
    appBox.append(appSearch, browse, appSelect, appNote);

    const row: Row = { target, swipe, action, trigger, keysBox, keys, record, preset, note, off, appBox, appSearch, appSelect, appNote };
    appSearch.addEventListener('input', () => this.fillApps(row));
    appSelect.addEventListener('change', () => {
      const app = this.apps?.find((a) => a.id === appSelect.value);
      if (!app) return;
      keybinds[target].app = { name: app.name, id: app.id };
      this.save(row);
    });
    browse.addEventListener('click', async () => {
      const picked = await window.pcControl?.pickProgram();
      if (!picked) return;
      keybinds[target].app = { name: picked.name, path: picked.path };
      this.save(row);
    });
    action.addEventListener('change', () => {
      keybinds[target].action = action.value as ActionKind;
      this.save(row);
    });
    trigger?.addEventListener('change', () => {
      keybinds[target].trigger = trigger!.value as Trigger;
      this.save(row);
    });
    keys.addEventListener('input', () => {
      keybinds[target].keys = keys.value;
      this.save(row, false);
    });
    keys.addEventListener('blur', () => {
      const n = normalizeCombo(keys.value);
      if (n) keys.value = keybinds[target].keys = n;
      this.save(row);
    });
    preset.addEventListener('change', () => {
      if (!preset.value) return;
      keys.value = keybinds[target].keys = preset.value;
      preset.value = '';
      this.save(row);
    });
    record.addEventListener('click', () => this.setRecording(this.recording === row ? null : row));

    const controls = el('div', 'bind-controls');
    controls.append(action);
    if (trigger) controls.append(trigger);
    wrap.append(name, controls, keysBox, appBox);
    this.rows.push(row);
    return wrap;
  }

  private save(row: Row, rerender = true) {
    saveKeybinds();
    if (rerender) this.renderRow(row);
    else this.renderNote(row);
  }

  private setRecording(row: Row | null) {
    if (this.recording) {
      this.recording.record.textContent = 'Record';
      this.recording.record.classList.remove('on');
    }
    this.recording = row;
    if (row) {
      row.record.textContent = 'Press keys…';
      row.record.classList.add('on');
    }
  }

  /** While recording, the next key combination pressed becomes the shortcut. */
  private onKey(e: KeyboardEvent) {
    if (!this.recording) return;
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return; // only modifiers so far
    const row = this.recording;
    row.keys.value = keybinds[row.target].keys = combo;
    this.setRecording(null);
    this.save(row);
  }

  private renderNote(row: Row) {
    const raw = row.keys.value.trim();
    const ok = raw ? normalizeCombo(raw) : null;
    row.note.textContent = !raw
      ? 'Type a shortcut, press Record, or pick one. Win key shortcuts may need typing (for example Win+E).'
      : ok ? `Sends ${ok}` : 'Not a shortcut this app knows. Use names like Ctrl, Alt, Shift, Win, A–Z, F1–F24, Enter, Esc, Left.';
    row.note.classList.toggle('bad', !!raw && !ok);
  }

  /** Load the installed-app list once, the first time someone picks "Open an app". */
  private ensureApps() {
    if (this.apps || this.appsLoading || !window.pcControl) return;
    this.appsLoading = true;
    window.pcControl.listApps().then((apps) => {
      this.apps = apps;
      this.appsLoading = false;
      for (const r of this.rows) if (keybinds[r.target].action === 'open_app') this.fillApps(r);
    }).catch(() => { this.apps = []; this.appsLoading = false; });
  }

  private fillApps(row: Row) {
    const b = keybinds[row.target];
    const q = row.appSearch.value.trim().toLowerCase();
    const sel = row.appSelect;
    sel.innerHTML = '';
    if (!this.apps) {
      sel.append(new Option('Loading installed apps…', ''));
      return;
    }
    sel.append(new Option(b.app ? `Current: ${b.app.name}` : 'Choose an app…', ''));
    const shown = this.apps.filter((a) => !q || a.name.toLowerCase().includes(q));
    for (const a of shown.slice(0, 400)) sel.append(new Option(a.name, a.id));
    if (b.app?.id && shown.some((a) => a.id === b.app!.id)) sel.value = b.app.id;
    if (q && !shown.length) sel.options[0].text = 'No app matches. Try Browse…';
  }

  private renderRow(row: Row) {
    const b = keybinds[row.target];
    row.action.value = b.action;
    if (row.trigger) row.trigger.value = b.trigger;
    row.keysBox.hidden = b.action !== 'keys';
    row.appBox.hidden = b.action !== 'open_app';
    if (b.action === 'open_app') {
      this.ensureApps();
      this.fillApps(row);
      row.appNote.textContent = b.app ? `Opens ${b.app.name}${b.app.path ? ` (${b.app.path})` : ''}` : 'Pick an app from the list, or Browse for a program.';
    }
    if (document.activeElement !== row.keys) row.keys.value = b.keys ?? '';
    this.renderNote(row);
    const gestureId = (row.swipe ? 'swipe' : row.target) as ToggleId;
    row.off.hidden = isEnabled(gestureId);
  }

  refresh(): void {
    for (const r of this.rows) this.renderRow(r);
  }

  toggle(open = !this.drawer.classList.contains('open')): void {
    if (open) this.refresh();
    else this.setRecording(null);
    this.drawer.classList.toggle('open', open);
    this.drawer.setAttribute('aria-hidden', String(!open));
    this.button.setAttribute('aria-expanded', String(open));
    this.backdrop.hidden = !open && !$('settings').classList.contains('open');
  }
}
