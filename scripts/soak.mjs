#!/usr/bin/env node
/**
 * Long-run check: runs the desktop app on the fake camera with mouse control on (dry run) and the
 * pointer badge showing, and samples speed and memory every SAMPLE_S seconds. Anything that keeps
 * growing (memory, page size) or keeps falling (frame rate) shows up in the table.
 *
 * Usage: node scripts/soak.mjs [minutes=10] [--packaged] [--gpu | --cpu] [--minimize]
 * Run `npm run verify` once first to create the fake-camera file.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minutes = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 10);
const SAMPLE_S = minutes <= 3 ? 10 : 30;
const packaged = process.argv.includes('--packaged');
const delegate = process.argv.includes('--gpu') ? 'gpu' : process.argv.includes('--cpu') ? 'cpu' : '';
const exe = join(root, 'release', 'win-unpacked', 'HandGestures.exe');
const y4m = join(root, 'tests', 'fixtures', '.cache', 'fake-camera.y4m');
if (!existsSync(y4m)) { console.error('Run `npm run verify` once first.'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'handgestures-soak-'));
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } });
const fake = ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--enable-precise-memory-info'];
const app = await electron.launch({
  ...(packaged ? { executablePath: exe, args: fake } : { args: [...fake, '.'] }),
  cwd: root,
  env: { ...process.env, HG_DRY_RUN: '1', VITE_DEV_SERVER_URL: '', HG_USER_DATA: profile, ...(delegate ? { HG_START_QUERY: `delegate=${delegate}` } : {}) },
});

const mb = (b) => Math.round(b / 1048576);
const rows = [];
try {
  const page = await app.firstWindow();
  let pageErrors = 0;
  page.on('pageerror', (e) => { pageErrors++; console.log('pageerror', String(e).slice(0, 200)); });
  page.on('crash', () => console.log('RENDERER CRASHED'));
  await page.waitForFunction(() => !document.getElementById('btn-camera').disabled, null, { timeout: 30000 });
  await page.click('#btn-camera');
  // (The GPU model may never find the hand in the fake camera; keep going anyway, it still runs every frame.)
  await page.waitForFunction(() => window.handGestures.snapshot().hands.length > 0, null, { timeout: 15000, polling: 200 }).catch(() => console.log('(no hand found in the picture; running anyway)'));
  await page.click('#btn-control');
  if (process.argv.includes('--minimize')) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://'))?.minimize());
    console.log('(window minimised)');
  }
  const t0 = Date.now();
  const end = t0 + minutes * 60000;
  const backend = await page.evaluate(() => window.handGestures.snapshot().backend);
  console.log(`soak: ${minutes} min, sample every ${SAMPLE_S} s${packaged ? ' (packaged)' : ''}, detector ${JSON.stringify(backend)}`);
  console.log('  min  fps   infer  jsHeap  dom   renderer  gpu   main  badge  overlayProc  cpu%(r/g/m)  frames');
  while (true) {
    const s = await page.evaluate(() => {
      const snap = window.handGestures.snapshot();
      const m = performance.memory;
      return {
        fps: snap.fps, infer: snap.inferenceMs, hands: snap.hands.length,
        heap: m ? m.usedJSHeapSize : 0, dom: document.getElementsByTagName('*').length,
        frames: window.handGestures.app.framesProcessed ?? 0,
      };
    });
    const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ type: p.type, name: p.name ?? '', pid: p.pid, ws: p.memory.workingSetSize * 1024, priv: (p.memory.privateBytes ?? 0) * 1024, cpu: p.cpu.percentCPUUsage })));
    const main = await app.evaluate(() => ({ heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, badge: globalThis.__hgOverlay?.().visible ?? false }));
    const tabs = metrics.filter((p) => p.type === 'Tab').sort((a, b) => b.ws - a.ws);
    const gpu = metrics.find((p) => p.type === 'GPU');
    const browser = metrics.find((p) => p.type === 'Browser');
    const row = {
      min: (Date.now() - t0) / 60000, fps: s.fps, infer: s.infer, heap: s.heap, dom: s.dom, frames: s.frames,
      renderer: tabs[0]?.priv || tabs[0]?.ws || 0, overlay: tabs[1]?.priv || tabs[1]?.ws || 0, gpu: gpu?.priv || gpu?.ws || 0,
      main: browser?.priv || browser?.ws || 0, mainHeap: main.heap, badge: main.badge,
      cpu: `${Math.round(tabs[0]?.cpu ?? 0)}/${Math.round(gpu?.cpu ?? 0)}/${Math.round(browser?.cpu ?? 0)}`,
    };
    rows.push(row);
    console.log(`  ${row.min.toFixed(1).padStart(4)}  ${row.fps.toFixed(1).padStart(4)}  ${row.infer.toFixed(1).padStart(5)}  ${String(mb(row.heap)).padStart(4)}MB  ${String(row.dom).padStart(4)}  ${String(mb(row.renderer)).padStart(6)}MB  ${String(mb(row.gpu)).padStart(4)}MB  ${String(mb(row.main)).padStart(4)}MB  ${row.badge ? ' on ' : ' off'}   ${String(mb(row.overlay)).padStart(6)}MB     ${row.cpu.padStart(9)}   ${row.frames}`);
    if (Date.now() >= end) break;
    await page.waitForTimeout(SAMPLE_S * 1000);
  }
  // Growth after warm-up (first sample after 1 min vs last), per minute.
  const warm = rows.find((r) => r.min >= Math.min(1, minutes / 3)) ?? rows[0];
  const last = rows.at(-1);
  const span = Math.max(0.01, last.min - warm.min);
  const per = (k) => `${((mb(last[k]) - mb(warm[k])) / span).toFixed(1)} MB/min`;
  console.log(`\ngrowth after warm-up (${span.toFixed(1)} min): renderer ${per('renderer')}, JS heap ${per('heap')}, GPU ${per('gpu')}, main ${per('main')}, main heap ${per('mainHeap')}, overlay ${per('overlay')}, DOM ${last.dom - warm.dom} nodes`);
  const health = await page.evaluate(() => ({ url: location.search, errors: window.handGestures.app.frameErrors, recoveries: window.handGestures.app.recoveries.map((r) => r.what) }));
  console.log(`frame rate: ${warm.fps.toFixed(1)} → ${last.fps.toFixed(1)} fps, inference ${warm.infer.toFixed(1)} → ${last.infer.toFixed(1)} ms, page errors ${pageErrors}`);
  console.log(`health: frame errors ${health.errors}, self-repairs ${health.recoveries.length ? health.recoveries.join('; ') : 'none'}, reloaded after crash/hang: ${health.url.includes('resume=') ? 'YES' : 'no'}`);
} finally {
  await app.close();
}
