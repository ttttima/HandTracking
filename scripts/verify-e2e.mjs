#!/usr/bin/env node
/**
 * End-to-end verification of the real tracking pipeline in a real browser (Edge or Chrome,
 * driven by playwright-core — no browser download needed).
 *
 *   1. Image test   — runs MediaPipe on real hand photos and checks the recognised gesture.
 *   2. Webcam test  — feeds a hand photo through Chromium's *fake camera* so the full
 *                     getUserMedia → detector → gesture path runs exactly like a real webcam.
 *   3. Denied test  — camera permission refused → friendly error screen.
 *
 * Usage: npm run verify [-- --headed] [-- --screenshots <dir>] [-- --delegate cpu|gpu]
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const shotIdx = args.indexOf('--screenshots');
const shotDir = shotIdx >= 0 ? resolve(args[shotIdx + 1]) : null;
const cacheDir = join(root, 'tests', 'fixtures', '.cache');
const delIdx = args.indexOf('--delegate');
const delegateQS = delIdx >= 0 ? `delegate=${args[delIdx + 1]}` : '';
const q = (params = '') => {
  const s = [params, delegateQS].filter(Boolean).join('&');
  return s ? `/?${s}` : '/';
};

// Public MediaPipe sample images (Apache-2.0 test assets) with the gesture they show.
const FIXTURES = [
  { name: 'victory.jpg', expect: 'peace' },
  { name: 'thumbs_up.jpg', expect: 'thumbs_up' },
  { name: 'pointing_up.jpg', expect: 'pointing' },
  { name: 'thumbs_down.jpg', expect: 'thumbs_down' },
];
const FIXTURE_BASE = 'https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function ensureFixtures() {
  await mkdir(cacheDir, { recursive: true });
  for (const f of FIXTURES) {
    const p = join(cacheDir, f.name);
    if (existsSync(p) && (await stat(p)).size > 1000) continue;
    const res = await fetch(FIXTURE_BASE + f.name);
    if (!res.ok) throw new Error(`Could not download fixture ${f.name}: HTTP ${res.status}`);
    await writeFile(p, Buffer.from(await res.arrayBuffer()));
  }
}

async function launch(extraArgs = []) {
  const opts = { headless: !headed, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs] };
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ ...opts, channel });
    } catch { /* try next */ }
  }
  return chromium.launch(opts); // bundled chromium, if installed
}

async function waitFor(page, predicate, timeout = 20000, arg) {
  return page.waitForFunction(predicate, arg, { timeout, polling: 100 });
}

/** Render an image into a 640×480 YUV4MPEG2 (I420) file for Chromium's fake camera. */
async function makeY4m(browser, url, outPath) {
  const page = await browser.newPage();
  await page.goto(url);
  const W = 640, H = 480;
  const rgba = await page.evaluate(async ({ W, H, src }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / img.width, H / img.height);
    ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
    return Array.from(ctx.getImageData(0, 0, W, H).data);
  }, { W, H, src: url });
  await page.close();
  const Y = Buffer.alloc(W * H), U = Buffer.alloc((W * H) / 4), V = Buffer.alloc((W * H) / 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    Y[y * W + x] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
    if (y % 2 === 0 && x % 2 === 0) {
      const j = (y / 2) * (W / 2) + x / 2;
      U[j] = Math.max(0, Math.min(255, Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128)));
      V[j] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128)));
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]);
  await writeFile(outPath, Buffer.concat([header, frame, frame]));
}

async function main() {
  console.log('Preparing fixtures…');
  await ensureFixtures();
  if (shotDir) await mkdir(shotDir, { recursive: true });

  const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), server: { port: 5199, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const base = server.resolvedUrls.local[0].replace(/\/$/, '');
  console.log(`Dev server at ${base}`);
  const pageErrors = [];

  try {
    // ── 1. Image tests ────────────────────────────────────────────────────
    console.log('\n[1] Real hand photos through the full pipeline');
    let browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    for (const f of FIXTURES) {
      await page.goto(`${base}${q(`source=/tests/fixtures/.cache/${f.name}`)}`);
      try {
        await waitFor(page, (want) => {
          const s = window.handGestures?.snapshot();
          return s?.hands?.length > 0 && s.hands.some((h) => h.primary === want);
        }, 20000, f.expect);
        await page.waitForTimeout(250);
      } catch { /* evaluated below */ }
      const snap = await page.evaluate(() => window.handGestures.snapshot());
      const h = snap.hands[0];
      const ok = snap.hands.some((x) => x.primary === f.expect);
      const fingers = h ? Object.entries(h.extended).filter(([, v]) => v).map(([k]) => k).join('+') || 'none' : '-';
      record(`${f.name} → ${f.expect}`, ok,
        h ? `got ${h.primary ?? 'none'} | ${h.handedness} ${(h.score * 100).toFixed(0)}% | extended: ${fingers} | top: ${h.topScores.join(', ')} | backend ${snap.backend?.delegate}/${snap.backend?.assets}`
          : 'no hand detected');
      if (shotDir) await page.screenshot({ path: join(shotDir, `image-${f.name.replace('.jpg', '')}.png`) });
    }

    // Build a fake-camera feed from the peace-sign photo.
    const y4m = join(cacheDir, 'fake-camera.y4m');
    await makeY4m(browser, `${base}/tests/fixtures/.cache/victory.jpg`, y4m);
    await browser.close();

    // ── 2. Webcam path with a fake camera ────────────────────────────────
    console.log('\n[2] Webcam path (getUserMedia with a fake camera streaming a hand photo)');
    browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`]);
    const cam = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    cam.on('pageerror', (e) => pageErrors.push(String(e)));
    await cam.goto(`${base}${q()}`);
    await waitFor(cam, () => !document.getElementById('btn-camera').disabled, 30000);
    await cam.click('#btn-camera');
    try {
      await waitFor(cam, () => {
        const s = window.handGestures.snapshot();
        return s.source?.kind === 'camera' && s.hands.length > 0 && s.fps > 0 && s.hands[0].primary;
      }, 25000);
    } catch { /* evaluated below */ }
    await cam.waitForTimeout(1500);
    const cs = await cam.evaluate(() => window.handGestures.snapshot());
    record('camera starts and streams', cs.source?.kind === 'camera', cs.source ? `${cs.source.width}×${cs.source.height} "${cs.source.label}"` : cs.status);
    record('hand tracked from camera', cs.hands.length > 0, cs.hands[0] ? `${cs.hands[0].handedness}, gesture ${cs.hands[0].primary}` : 'none');
    record('detection loop running', cs.fps > 0, `${cs.fps} FPS, ${cs.inferenceMs} ms/inference`);
    record('events emitted', cs.eventCount > 0, `${cs.eventCount} events`);
    if (shotDir) await cam.screenshot({ path: join(shotDir, 'camera.png') });
    // Stop camera → idle state.
    await cam.click('#btn-camera');
    await cam.waitForTimeout(300);
    const stopped = await cam.evaluate(() => ({ s: window.handGestures.snapshot(), empty: !document.getElementById('stage-empty').hidden }));
    record('camera stops cleanly', !stopped.s.source && stopped.empty, stopped.s.status);
    await browser.close();

    // ── 3. Permission denied ─────────────────────────────────────────────
    console.log('\n[3] Camera permission denied');
    browser = await launch(['--use-fake-device-for-media-stream', '--deny-permission-prompts']);
    const ctx = await browser.newContext();
    const denied = await ctx.newPage();
    await denied.goto(`${base}${q()}`);
    await waitFor(denied, () => !document.getElementById('btn-camera').disabled, 30000);
    await denied.click('#btn-camera');
    await waitFor(denied, () => document.getElementById('status').dataset.state === 'error', 15000).catch(() => {});
    const err = await denied.evaluate(() => ({
      title: document.getElementById('empty-title').textContent,
      text: document.getElementById('empty-text').textContent,
      state: document.getElementById('status').dataset.state,
    }));
    record('shows a friendly error', err.state === 'error' && /blocked|denied/i.test(err.title), `"${err.title}" ${err.text.slice(0, 70)}…`);
    if (shotDir) await denied.screenshot({ path: join(shotDir, 'denied.png') });
    await browser.close();
  } finally {
    await server.close();
  }

  // MediaPipe logs informational lines ("INFO: Created TensorFlow Lite XNNPACK delegate…") via console.error.
  const relevantErrors = pageErrors.filter((e) => !/favicon|DevTools|^INFO:|^W0000|gl_context/i.test(e));
  record('no uncaught page errors', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
