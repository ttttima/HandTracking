/**
 * Swipe distance slider under the picture: how far the palm has to move (in palm sizes) for a
 * swipe to fire its action. Same value as Settings → Sensitivity → Swipe distance.
 */
import { saveThresholds, thresholds } from '../config';
import { $ } from './dom';

/** Fired on window whenever a threshold changes, so every slider showing it can update. */
export const THRESHOLDS_CHANGED = 'hg:thresholds-changed';

export class SwipeSlider {
  private input = $('swipe-distance') as HTMLInputElement;
  private output = $('swipe-distance-out') as HTMLOutputElement;
  private saveTimer = 0;

  constructor() {
    this.input.addEventListener('input', () => {
      thresholds.swipeMinDistance = Number(this.input.value);
      this.render();
      window.dispatchEvent(new CustomEvent(THRESHOLDS_CHANGED, { detail: 'swipeMinDistance' }));
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(saveThresholds, 250);
    });
    window.addEventListener(THRESHOLDS_CHANGED, () => this.refresh());
    this.refresh();
  }

  refresh(): void {
    this.input.value = String(thresholds.swipeMinDistance);
    this.render();
  }

  private render() {
    const v = thresholds.swipeMinDistance;
    this.output.value = `${v.toFixed(2)} palm`;
  }
}
