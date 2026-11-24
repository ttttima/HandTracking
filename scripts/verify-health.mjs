#!/usr/bin/env node
/**
 * Self-healing check: breaks the running desktop app in the ways a long session can, and checks
 * that it recovers on its own and carries on (camera, tracking and mouse control).
 *
 *   0. lots drawn in draw mode     each frame still draws fast
 *   1. frames throwing errors        tracking carries on once they stop
 *   2. the camera reader ending      the on-screen video takes over, then a new reader
 *   3. no frames analysed            the watchdog restarts the reader
 *   4. the hand model failing        it is loaded again
 *   5. the camera track ending       the camera reconnects, mouse control stays on
 *   6. the page crashing             the window reloads with the camera and mouse control back on
 *   7. the page hanging (--hang)     it is ended and reloaded (slow: about 45 s)
 *
 * Usage: npm run verify:health [-- --packaged] [-- --hang]
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const hang = process.argv.includes('--hang');
const exe = join(root, 'release', 'win-unpacked', 'HandGestures.exe');
const y4m = join(root, 'tests', 'fixtures', '.cache', 'fake-camera.y4m');
if (!existsSync(y4m)) { console.error('Run `npm run verify` once first.'); process.exit(1); }
const profile = mkdtempSync(join(tmpdir(), 'handgestures-health-'));
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } });

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const fake = ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`];
const app = await electron.launch({
  ...(packaged ? { executablePath: exe, args: fake } : { args: [...fake, '.'] }),
  cwd: root,
  env: { ...process.env, HG_DRY_RUN: '1', VITE_DEV_SERVER_URL: '', HG_USER_DATA: profile, HG_START_QUERY: 'delegate=cpu' },
});

/** The main window's page (not the pointer badge). */
async function mainPage() {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => w.url().startsWith('app://'));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('main window not found');
}
const frames = (page) => page.evaluate(() => window.handGestures.app.framesProcessed);
/** Frames analysed (and a hand seen) during the next `ms`. */
async function flowing(page, ms = 2000) {
  const a = await frames(page);
  await page.waitForTimeout(ms);
  const s = await page.evaluate(() => window.handGestures.snapshot());
  return { frames: (await frames(page)) - a, hands: s.hands.length, control: s.control?.state ?? 'none', recoveries: s.recoveries.map((r) => r.what) };
}

try {
  let page = await mainPage();
  await page.waitForFunction(() => !document.getElementById('btn-camera').disabled, null, { timeout: 30000 });
  await page.click('#btn-camera');
  await page.waitForFunction(() => window.handGestures.snapshot().hands.length > 0, null, { timeout: 30000, polling: 200 });
  await page.click('#btn-control');
  const start = await flowing(page);
  record('running: camera, tracking, mouse control', start.frames > 10 && start.hands > 0 && start.control === 'active', JSON.stringify(start));

  // 0. A lot drawn in draw mode: drawing a frame must stay fast however much is on the picture.
  const drawMs = await page.evaluate(() => {
    const app = window.handGestures.app;
    document.getElementById('btn-draw').click();
    const lines = app.air.strokes;
    for (let i = 0; i < 300; i++) {
      const pts = Array.from({ length: 200 }, (_, k) => ({ x: 0.1 + 0.8 * (k / 200), y: 0.1 + 0.8 * ((i * 37 + k * 7) % 100) / 100 }));
      lines.push({ color: '#d9a58c', width: 6, pts });
    }
    app.air.draw(); // first frame caches the finished lines
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) app.air.draw();
    const ms = (performance.now() - t0) / 30;
    app.air.clear();
    document.getElementById('btn-draw').click();
    return ms;
  });
  record('0. drawing stays fast with 300 long lines on the picture', drawMs < 4, `${drawMs.toFixed(2)} ms per frame`);

  // 1. Every frame throws for a while (a bug hit by some rare hand position).
  await page.evaluate(() => {
    const a = window.handGestures.app.analyzer;
    a.__orig = a.analyze;
    a.analyze = () => { throw new Error('test: analysis failed'); };
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const a = window.handGestures.app.analyzer; a.analyze = a.__orig; });
  const r1 = await flowing(page);
  const errs = await page.evaluate(() => window.handGestures.app.frameErrors);
  record('1. errors in frames do not stop tracking', errs > 5 && r1.frames > 10 && r1.hands > 0, `${errs} frame errors, then ${r1.frames} frames, ${r1.hands} hand(s)`);

  // 2. The camera reader ends by itself.
  await page.evaluate(() => window.handGestures.app.frameReader?.cancel());
  const r2 = await flowing(page, 2500);
  record('2. the camera reader ending does not stop tracking', r2.frames > 10 && r2.hands > 0, `${r2.frames} frames`);

  // 3. Nothing gets analysed (stuck somewhere): the watchdog steps in.
  await page.evaluate(() => {
    const app = window.handGestures.app;
    app.__process = app.process;
    app.process = () => {};
  });
  await page.waitForFunction(() => window.handGestures.snapshot().recoveries.some((r) => r.what.startsWith('restarted the camera reader')), null, { timeout: 8000, polling: 250 }).catch(() => {});
  await page.evaluate(() => { const app = window.handGestures.app; app.process = app.__process; });
  const r3 = await flowing(page);
  record('3. the watchdog restarts a stalled camera reader', r3.recoveries.some((w) => w.startsWith('restarted the camera reader')) && r3.frames > 10, r3.recoveries.at(-1) ?? 'no recovery');

  // 4. The hand model fails on every frame (e.g. the GPU was reset).
  await page.evaluate(() => { window.handGestures.app.detector.detect = () => { throw new Error('test: model failed'); }; });
  await page.waitForFunction(() => window.handGestures.snapshot().recoveries.some((r) => r.what.startsWith('reloading the hand model')), null, { timeout: 15000, polling: 250 }).catch(() => {});
  await page.waitForFunction(() => window.handGestures.snapshot().hands.length > 0, null, { timeout: 30000, polling: 250 }).catch(() => {});
  const r4 = await flowing(page);
  record('4. a failing hand model is loaded again', r4.recoveries.some((w) => w.startsWith('reloading the hand model')) && r4.frames > 10 && r4.hands > 0, `${r4.frames} frames, ${r4.hands} hand(s)`);

  // 5. The camera track ends (unplugged, PC asleep, another app took it).
  await page.evaluate(() => document.getElementById('video').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForFunction(() => window.handGestures.snapshot().recoveries.some((r) => r.what.startsWith('camera ended')), null, { timeout: 5000, polling: 200 }).catch(() => {});
  await page.waitForFunction(() => window.handGestures.snapshot().hands.length > 0 && window.handGestures.snapshot().source?.kind === 'camera', null, { timeout: 20000, polling: 250 }).catch(() => {});
  const r5 = await flowing(page);
  record('5. the camera reconnects by itself, mouse control stays on', r5.recoveries.some((w) => w.startsWith('camera ended')) && r5.frames > 10 && r5.control === 'active', `${r5.frames} frames, control ${r5.control}`);

  // 6. The page crashes. (Checked through the main process: the test tool treats a crashed page as gone
  // for good, even after the window has loaded it again.)
  const viaMain = () => app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://'));
    if (!w || w.webContents.isCrashed() || w.webContents.isLoading()) return null;
    try {
      // A hung page never answers: give up after 2 s.
      return await Promise.race([
        w.webContents.executeJavaScript(`(() => { const s = window.handGestures?.snapshot(); return s && { url: location.href, frames: window.handGestures.app.framesProcessed, camera: s.source?.kind === 'camera', hands: s.hands.length, control: s.control?.state ?? 'none' }; })()`),
        new Promise((r) => setTimeout(() => r(null), 2000)),
      ]);
    } catch { return null; }
  });
  /** Wait until the reloaded page is tracking a hand again, then measure for 2 s. */
  async function backAfter(limitMs) {
    const t = Date.now();
    let s = null;
    while (Date.now() - t < limitMs) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await viaMain().catch(() => null);
      if (s?.camera && s.hands > 0 && s.url.includes('resume=')) break;
      s = null;
    }
    if (!s) return { ok: false, secs: Math.round((Date.now() - t) / 1000) };
    await new Promise((r) => setTimeout(r, 2000));
    const s2 = await viaMain();
    return { ok: true, secs: Math.round((Date.now() - t) / 1000), frames: s2.frames - s.frames, control: s2.control, query: s.url.split('?')[1] };
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://'))?.webContents.forcefullyCrashRenderer());
  const r6 = await backAfter(45000);
  record('6. after a crash the window reloads with camera and mouse control back on', r6.ok && r6.frames > 10 && r6.control === 'active',
    r6.ok ? `back in ${r6.secs} s (${r6.query}), ${r6.frames} frames in 2 s, control ${r6.control}` : `not back after ${r6.secs} s`);

  // 7. The page hangs (an endless loop): ended after 15 s of not responding, then reloaded.
  if (hang) {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://'));
      void w?.webContents.executeJavaScript('setTimeout(() => { for (;;) { /* hang */ } }, 10); 1').catch(() => {});
    });
    // Wait until the hang is noticed and the page is gone, then for it to come back.
    const before7 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://'))?.webContents.getOSProcessId());
    const t7 = Date.now();
    while (Date.now() - t7 < 90000) {
      await new Promise((r) => setTimeout(r, 1000));
      const pid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('app://'))?.webContents.getOSProcessId());
      if (pid && pid !== before7) break;
    }
    const r7 = await backAfter(60000);
    r7.secs = Math.round((Date.now() - t7) / 1000);
    record('7. a hung page is restarted and carries on', r7.ok && r7.frames > 10 && r7.control === 'active',
      r7.ok ? `back in ${r7.secs} s, ${r7.frames} frames in 2 s, control ${r7.control}` : `not back after ${r7.secs} s`);
  }
} finally {
  await app.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} health checks passed.`);
process.exit(failed ? 1 : 0);
