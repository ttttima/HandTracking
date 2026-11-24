import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { HandTrackingApp } from './app';
import { useSettingsFile, type SettingsFileBridge } from './settingsFile';

// Desktop app: settings and keybinds live in a file; load it before anything reads a setting.
useSettingsFile(window.pcControl?.settingsFile);
const app = new HandTrackingApp();

declare global {
  interface Window {
    /** Desktop app only: mouse control provided by electron/preload.cjs. */
    pcControl?: import('./control/pcController').PcBridge & {
      info(): Promise<{ available: boolean; dryRun: boolean; error: string | null; screen: { width: number; height: number }; shortcut: string }>;
      setAlwaysOnTop(on: boolean): void;
      setOverlay(state: import('./control/cursorBadge').BadgeState): void;
      reportState?(state: { camera: boolean; control: boolean }): void;
      setScreens(mode: 'primary' | 'all'): Promise<{ x: number; y: number; width: number; height: number }>;
      onToggle(cb: () => void): () => void;
      listApps(): Promise<{ name: string; id: string }[]>;
      pickProgram(): Promise<{ path: string; name: string } | null>;
      settingsFile: SettingsFileBridge;
    };
    /** Debug / automation hook: `handGestures.snapshot()` in the dev-tools console. */
    handGestures: { app: HandTrackingApp; snapshot: () => ReturnType<HandTrackingApp['snapshot']> };
  }
}
window.handGestures = { app, snapshot: () => app.snapshot() };

app.init().catch((err) => {
  console.error('[app] init failed', err);
});
