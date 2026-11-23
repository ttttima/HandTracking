/** Sensitivity drawer, generated from THRESHOLD_GROUPS in config.ts. */
import {
  GESTURE_TOGGLES, THRESHOLD_GROUPS, enabledGestures, resetThresholds, saveEnabledGestures, saveThresholds, thresholds,
} from '../config';
import { $, el } from './dom';
import { saveSnapping, snapping } from '../control/angleSnap';

export class SettingsPanel {
  private drawer = $('settings');
  private backdrop = $('drawer-backdrop');
  private button = $('btn-settings');
  private inputs = new Map<string, { input: HTMLInputElement; output: HTMLOutputElement; unit: string; step: number }>();
  private saveTimer = 0;

  constructor() {
    const body = $('settings-body');
    for (const group of THRESHOLD_GROUPS) {
      const g = el('section', 'set-group');
      g.append(el('h3', '', group.title));
      for (const f of group.fields) {
        const wrap = el('div', 'set-field');
        const label = el('label');
        const id = `set-${f.key}`;
        label.htmlFor = id;
        const output = el('output');
        label.append(el('span', '', f.label), output);
        const input = el('input');
        input.type = 'range';
        input.id = id;
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = String(f.step);
        input.addEventListener('input', () => {
          thresholds[f.key] = Number(input.value);
          this.renderValue(f.key);
          window.clearTimeout(this.saveTimer);
          this.saveTimer = window.setTimeout(saveThresholds, 250);
        });
        wrap.append(label, input, el('small', '', f.help));
        g.append(wrap);
        this.inputs.set(f.key, { input, output, unit: f.unit ?? '', step: f.step });
      }
      body.append(g);
    }
    this.buildGestureToggles();
    const snapOn = $('snap-enabled') as HTMLInputElement;
    const snapStep = $('snap-increment') as HTMLSelectElement;
    snapOn.addEventListener('change', () => { snapping.enabled = snapOn.checked; saveSnapping(); });
    snapStep.addEventListener('change', () => { snapping.increment = Number(snapStep.value); saveSnapping(); });
    this.refresh();

    this.button.addEventListener('click', () => this.toggle());
    $('btn-close-settings').addEventListener('click', () => this.toggle(false));
    this.backdrop.addEventListener('click', () => this.toggle(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggle(false); });
    $('btn-reset').addEventListener('click', () => {
      resetThresholds();
      this.refresh();
    });
  }

  private toggleInputs: HTMLInputElement[] = [];

  /** One checkbox per gesture; unchecked ones are ignored everywhere. */
  private buildGestureToggles() {
    const box = $('gesture-toggles');
    for (const g of GESTURE_TOGGLES) {
      const label = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.dataset.id = g.id;
      input.addEventListener('change', () => {
        enabledGestures[g.id] = input.checked;
        saveEnabledGestures();
      });
      const text = el('span', '', g.label);
      if (g.pc) text.append(el('small', '', `PC control: ${g.pc}`));
      label.append(input, text);
      box.append(label);
      this.toggleInputs.push(input);
    }
    $('btn-gestures-all').addEventListener('click', () => {
      for (const g of GESTURE_TOGGLES) enabledGestures[g.id] = true;
      saveEnabledGestures();
      this.refresh();
    });
  }

  private renderValue(key: string) {
    const i = this.inputs.get(key)!;
    const v = thresholds[key as keyof typeof thresholds];
    const decimals = i.step < 1 ? Math.max(0, -Math.floor(Math.log10(i.step))) : 0;
    i.output.value = `${v.toFixed(decimals)}${i.unit ? ` ${i.unit}` : ''}`;
  }

  refresh(): void {
    ($('snap-enabled') as HTMLInputElement).checked = snapping.enabled;
    ($('snap-increment') as HTMLSelectElement).value = String(snapping.increment);
    for (const input of this.toggleInputs) input.checked = enabledGestures[input.dataset.id as keyof typeof enabledGestures] !== false;
    for (const [key, i] of this.inputs) {
      i.input.value = String(thresholds[key as keyof typeof thresholds]);
      this.renderValue(key);
    }
  }

  toggle(open = !this.drawer.classList.contains('open')): void {
    this.drawer.classList.toggle('open', open);
    this.drawer.setAttribute('aria-hidden', String(!open));
    this.button.setAttribute('aria-expanded', String(open));
    this.backdrop.hidden = !open && !$('keybinds').classList.contains('open');
  }
}
