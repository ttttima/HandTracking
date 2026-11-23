/**
 * A short, quiet two-note sound when PC control turns on (rising) or off (falling), so you know
 * the on/off sign worked even when the app window is hidden behind others.
 */
let ctx: AudioContext | null = null;

export function chime(on: boolean): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const notes = on ? [660, 990] : [990, 660];
    const t0 = ctx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const t = t0 + i * 0.09;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch {
    /* no audio: the status line still shows the state */
  }
}
