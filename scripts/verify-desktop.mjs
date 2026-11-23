#!/usr/bin/env node
/**
 * End-to-end check of the desktop app (built files served over app://), with mouse control in
 * DRY-RUN mode: actions are logged in the main process, your real mouse is never touched.
 *
 *   camera (fake device streaming a peace-sign photo) → tracking → PC control on →
 *   pointer moves + peace = right click recorded by the native input layer.
 *
 * Usage: npm run verify:desktop              (source tree)
 *        node scripts/verify-desktop.mjs --packaged   (the built .exe in release/)
 * Run `npm run verify` once first to create the fake-camera file.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const y4m = join(root, 'tests', 'fixtures', '.cache', 'fake-camera.y4m');
if (!existsSync(y4m)) {
  console.error('Missing tests/fixtures/.cache/fake-camera.y4m. Run `npm run verify` once first.');
  process.exit(1);
}

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// --packaged checks the build produced by `npm run desktop:dist` instead of the source tree.
const packaged = process.argv.includes('--packaged');
const packagedExe = join(root, 'release', 'win-unpacked', 'HandGestures.exe');
if (packaged && !existsSync(packagedExe)) {
  console.error('No packaged build found. Run `npm run desktop:dist` first.');
  process.exit(1);
}
// A throwaway profile: the test never reads or changes your real settings (or collides with your open app).
const profile = mkdtempSync(join(tmpdir(), 'handgestures-test-'));
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } });
const fakeCamera = ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`];
const app = await electron.launch({
  ...(packaged ? { executablePath: packagedExe, args: fakeCamera } : { args: [...fakeCamera, '.'] }),
  cwd: root,
  env: { ...process.env, HG_DRY_RUN: '1', VITE_DEV_SERVER_URL: '', HG_USER_DATA: profile },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForFunction(() => !document.getElementById('btn-camera').disabled, null, { timeout: 30000, polling: 200 });
  record('app loads over app:// with the local model', page.url().startsWith('app://bundle/'), page.url());

  const info = await page.evaluate(() => window.pcControl?.info());
  record('native input layer available', !!info?.available, info ? `screen ${info.screen.width}×${info.screen.height}, dry run ${info.dryRun}` : 'no bridge');
  record('control button shown', await page.isVisible('#btn-control'));

  await page.click('#btn-camera');
  const camStart = Date.now();
  // Wait until the hand is tracked steadily (5 polls in a row, ~1 s), not just one early frame
  // while the automatic GPU → CPU fallback is still deciding.
  await page.waitForFunction(() => {
    const s = window.handGestures.snapshot();
    const seen = s.source?.kind === 'camera' && s.hands.length > 0;
    window.__steady = seen ? (window.__steady ?? 0) + 1 : 0;
    return window.__steady >= 5;
  }, null, { timeout: 30000, polling: 200 }).catch((e) => console.log(`  (wait failed: ${String(e.message).split('\n')[0]})`));
  const cam = await page.evaluate(() => window.handGestures.snapshot());
  record('camera tracked a hand', cam.hands.length > 0, `${cam.hands.map((h) => `${h.handedness}: ${h.primary}`).join(', ') || cam.status} after ${((Date.now() - camStart) / 1000).toFixed(1)} s`);

  // Control the hand that is actually in view, then start control.
  const hand = cam.hands[0]?.handedness ?? 'Right';
  await page.selectOption('#control-hand', hand);
  // Re-show the sign so a fresh "peace started" event reaches the controller.
  await page.click('#btn-control');
  await page.evaluate(() => { window.handGestures.app.engine.reset(); });
  await page.waitForTimeout(2500);

  const log = await app.evaluate(() => globalThis.__hgInputLog ?? []);
  const moves = log.filter((e) => e.op === 'move');
  const right = log.filter((e) => e.op === 'click' && e.button === 'right');
  const view = await page.evaluate(() => window.handGestures.snapshot().control);
  record('control is active', view?.state === 'active', JSON.stringify(view));
  record('pointer moves sent to the OS layer', moves.length > 0, moves.length ? `${moves.length} moves, last at ${moves.at(-1).x},${moves.at(-1).y}` : 'none');
  record('peace sign = right click', right.length === 1, `${right.length} right clicks`);
  const badge = await app.evaluate(() => globalThis.__hgOverlay?.());
  record('pointer badge shows the sign and what it does', badge?.visible && badge.title === 'Peace' && badge.detail === 'Right click', JSON.stringify(badge));
  const overlayWin = app.windows().find((w) => w.url().endsWith('overlay.html'));
  const badgeText = overlayWin ? await overlayWin.evaluate(() => document.getElementById('badge').className + ' ' + document.getElementById('title').textContent) : '';
  record('badge window draws it', /show/.test(badgeText) && /Peace/.test(badgeText), badgeText);
  // Reach calibration: starts on the picture, holds the mouse still, and refuses a hand that never moved.
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.click('#btn-calibrate');
  await page.waitForTimeout(300);
  const calibShown = await page.evaluate(() => !document.getElementById('calib').hidden && window.handGestures.app.control.suspended);
  const movesBefore = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op === 'move').length;
  // Count moves only while calibration is still running (it lasts 8 s); then let it finish.
  if (process.env.HG_SCREENSHOT_CALIB) { await page.waitForTimeout(4000); await page.screenshot({ path: process.env.HG_SCREENSHOT_CALIB }); await page.waitForTimeout(3000); }
  else await page.waitForTimeout(7000);
  const movesDuring = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op === 'move').length - movesBefore;
  await page.waitForTimeout(1600);
  const calibEnd = await page.evaluate(() => ({ open: !document.getElementById('calib').hidden, box: window.handGestures.app.control.options.box, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ') }));
  record('reach calibration runs and keeps the mouse still', calibShown && movesDuring === 0 && !calibEnd.open, `${movesDuring} moves while calibrating`);
  record('a hand that never moved is not accepted as a reach', calibEnd.box === null && /too small/.test(calibEnd.toast), calibEnd.toast);
  // Draw button on the picture: draw mode hides the hand drawing and holds PC control.
  await page.click('#btn-draw');
  await page.waitForTimeout(600);
  const draw = await page.evaluate(() => ({ text: document.getElementById('btn-draw').textContent, clear: !document.getElementById('btn-draw-clear').hidden, held: window.handGestures.app.control.suspended }));
  if (process.env.HG_SCREENSHOT_DRAW) await page.screenshot({ path: process.env.HG_SCREENSHOT_DRAW });
  await page.click('#btn-draw');
  await page.waitForTimeout(200);
  const drawOff = await page.evaluate(() => ({ text: document.getElementById('btn-draw').textContent, held: window.handGestures.app.control.suspended }));
  record('Draw button turns draw mode on and off, holding PC control meanwhile', draw.text === 'Stop drawing' && draw.clear && draw.held && drawOff.text === 'Draw' && !drawOff.held, `${JSON.stringify(draw)} → ${JSON.stringify(drawOff)}`);
  await page.evaluate(() => window.pcControl.minimizeActiveWindow());
  await page.waitForTimeout(200);
  const minimized = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op === 'minimize');
  record('minimise-window reaches the OS layer', minimized.length === 1, `${minimized.length} minimise calls (dry run)`);
  await page.evaluate(() => window.pcControl.toggleDesktop());
  await page.waitForTimeout(200);
  const winD = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op === 'win+d');
  record('show-desktop (Win+D) reaches the OS layer', winD.length === 1, `${winD.length} Win+D calls (dry run)`);
  await page.evaluate(() => window.pcControl.move(NaN, 0.5));
  await page.waitForTimeout(150);
  const lastOps = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).slice(-1).map((e) => e.op);
  record('a broken position is refused, never sent as mid-screen', lastOps[0] === 'move-rejected', lastOps.join(', '));
  record('no left click / stuck button', !log.some((e) => e.op === 'down' || (e.op === 'click' && e.button === 'left')));

  if (process.env.HG_SCREENSHOT) await page.screenshot({ path: process.env.HG_SCREENSHOT });

  // Keybinds panel: lists every bindable gesture, and a chosen shortcut is what the gesture sends.
  await page.click('#btn-keybinds');
  await page.waitForTimeout(400);
  const rows = await page.locator('#keybind-list .bind-row').count();
  record('keybinds panel lists every gesture except pinch', rows === 13, `${rows} rows`);
  const peaceRow = page.locator('#keybind-list .bind-row').filter({ hasText: 'Peace' });
  await peaceRow.locator('select').first().selectOption('keys');
  await peaceRow.locator('.bind-keys input').fill('ctrl+shift+t');
  await peaceRow.locator('.bind-keys input').blur();
  if (process.env.HG_SCREENSHOT_KEYBINDS) await page.screenshot({ path: process.env.HG_SCREENSHOT_KEYBINDS });
  // Open-an-app: the installed-app list loads, a listed app reaches the launcher (dry run), anything else is refused.
  const appList = await page.evaluate(() => window.pcControl.listApps());
  record('installed apps are listed', appList.length > 0, `${appList.length} apps`);
  const thumbsRow = page.locator('#keybind-list .bind-row').filter({ hasText: 'Thumbs up' });
  await thumbsRow.locator('select').first().selectOption('open_app');
  await page.waitForTimeout(300);
  const calc = appList.find((x) => /calculator/i.test(x.name)) ?? appList[0];
  await thumbsRow.locator('.bind-app input').fill(calc.name.slice(0, 5));
  await thumbsRow.locator('.bind-app select').selectOption(calc.id);
  if (process.env.HG_SCREENSHOT_APPS) await page.screenshot({ path: process.env.HG_SCREENSHOT_APPS });
  await page.evaluate((id) => { window.pcControl.openApp({ id }); window.pcControl.openApp({ id: 'not-an-installed-app' }); window.pcControl.openApp({ path: 'C:\Windows\System32\cmd.bat' }); }, calc.id);
  await page.waitForTimeout(500);
  const appLog = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op.startsWith('open-app'));
  record('a listed app reaches the launcher (dry run)', appLog.some((e) => e.op === 'open-app' && e.app === calc.name), `${calc.name}`);
  record('unlisted apps and other files are refused', appLog.filter((e) => e.op === 'open-app-rejected').length === 2, appLog.map((e) => e.op).join(', '));
  // Virtual desktops (dry run: the real desktop state is read, nothing is switched).
  await page.evaluate(() => { window.pcControl.switchDesktop('first'); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.pcControl.switchDesktop('second'); });
  await page.waitForTimeout(700);
  const deskLog = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op.startsWith('desktop-'));
  record('desktop switching reads the real desktop state', deskLog.length === 2 && deskLog.every((e) => e.count >= 1),
    deskLog.map((e) => `${e.op} (${e.count} desktops, on #${e.index + 1})`).join(', '));
  await page.click('#btn-close-keybinds');
  await page.evaluate(() => window.handGestures.app.engine.reset()); // re-show the peace sign
  await page.waitForTimeout(2000);
  const keyLog = (await app.evaluate(() => globalThis.__hgInputLog ?? [])).filter((e) => e.op === 'keys');
  record('rebinding peace sends the chosen shortcut', keyLog.some((e) => e.combo === 'Ctrl+Shift+T'), keyLog.map((e) => e.combo).join(', ') || 'none');

  await page.click('#btn-control');
  const after = await page.evaluate(() => window.handGestures.snapshot().control);
  record('control turns off', after?.state === 'off');
  await page.click('#btn-camera'); // stop the camera
  await page.waitForTimeout(500);
  const live = await page.evaluate(() => document.getElementById('video').srcObject);
  const liveTracks = await page.evaluate(() => window.handGestures.app.readerTrack?.readyState ?? 'none');
  record('stopping the camera releases every camera track', live === null && liveTracks === 'none', `video ${live === null ? 'released' : 'still attached'}, reader track ${liveTracks}`);
  record('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await app.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} desktop checks passed.`);
process.exit(failed ? 1 : 0);
