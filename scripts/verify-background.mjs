#!/usr/bin/env node
/**
 * Checks that tracking keeps full speed while the desktop app is minimised (mouse control has
 * to work while you use other apps). Uses the fake camera and a throwaway profile, dry run.
 *
 * Usage: node scripts/verify-background.mjs [--packaged]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const y4m = join(root, 'tests', 'fixtures', '.cache', 'fake-camera.y4m');
if (!existsSync(y4m)) {
  console.error('Missing fake camera file. Run `npm run verify` once first.');
  process.exit(1);
}
const packaged = process.argv.includes('--packaged');
const exe = join(root, 'release', 'win-unpacked', 'HandGestures.exe');
const profile = mkdtempSync(join(tmpdir(), 'handgestures-bg-'));
const fake = ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`];

const app = await electron.launch({
  ...(packaged ? { executablePath: exe, args: fake } : { args: [...fake, '.'] }),
  cwd: root,
  env: { ...process.env, HG_DRY_RUN: '1', VITE_DEV_SERVER_URL: '', HG_USER_DATA: profile },
});
let ok = true;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !document.getElementById('btn-camera').disabled, null, { timeout: 30000, polling: 200 });
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.handGestures.snapshot().hands.length > 0, null, { timeout: 30000, polling: 200 });
  await page.waitForTimeout(3000);

  /** Count analysed frames over `ms` (works even while the page gets no animation frames). */
  const measure = (ms) => page.evaluate(async (ms) => {
    const app = window.handGestures.app;
    const start = app.framesProcessed;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    return ((app.framesProcessed - start) * 1000) / (performance.now() - t0);
  }, ms);

  const visible = await measure(3000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.waitForTimeout(1500);
  const hiddenState = await page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState }));
  const minimised = await measure(4000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await page.waitForTimeout(1000);
  const restored = await measure(3000);

  const fmt = (n) => n.toFixed(1);
  console.log(`  visible ${fmt(visible)} fps | minimised ${fmt(minimised)} fps (${hiddenState.state}) | restored ${fmt(restored)} fps`);
  ok = minimised >= visible * 0.75 && restored >= visible * 0.75;
  console.log(ok ? '  ✔ tracking keeps its speed while minimised' : '  ✘ tracking slows down while minimised');
} finally {
  await app.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(ok ? 0 : 1);
