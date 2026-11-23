import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { HandTrackingApp } from './app';

const app = new HandTrackingApp();

declare global {
  interface Window {
    /** Desktop app only: mouse control provided by electron/preload.cjs. */
    pcControl?: import('./control/pcController').PcBridge & {
      info(): Promise<{ available: boolean; dryRun: boolean; error: string | null; screen: { width: number; height: number }; shortcut: string }>;
      setAlwaysOnTop(on: boolean): void;
      onToggle(cb: () => void): () => void;
      listApps(): Promise<{ name: string; id: string }[]>;
      pickProgram(): Promise<{ path: string; name: string } | null>;
    };
    /** Debug / automation hook: `handGestures.snapshot()` in the dev-tools console. */
    handGestures: { app: HandTrackingApp; snapshot: () => ReturnType<HandTrackingApp['snapshot']> };
  }
}
window.handGestures = { app, snapshot: () => app.snapshot() };

app.init().catch((err) => {
  console.error('[app] init failed', err);
});
