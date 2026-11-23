#!/usr/bin/env node
/**
 * Prepares local runtime assets so the app works fully offline after install:
 *   1. Copies the MediaPipe WASM runtime from node_modules → public/mediapipe/wasm
 *   2. Downloads the hand landmarker model → public/models/hand_landmarker.task
 *
 * Runs automatically on `npm install` (postinstall) and can be re-run with `npm run setup`.
 * If the download fails (offline), the app falls back to the CDN model URL at runtime.
 */
import { copyFile, mkdir, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(root, 'public', 'mediapipe', 'wasm');
const modelDst = join(root, 'public', 'models', 'hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

async function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn('[setup] @mediapipe/tasks-vision not installed yet; skipping WASM copy.');
    return;
  }
  await mkdir(wasmDst, { recursive: true });
  const files = await readdir(wasmSrc);
  for (const f of files) await copyFile(join(wasmSrc, f), join(wasmDst, f));
  console.log(`[setup] Copied ${files.length} WASM runtime files → public/mediapipe/wasm`);
}

async function downloadModel() {
  if (existsSync(modelDst) && (await stat(modelDst)).size > 1_000_000) {
    console.log('[setup] Hand landmarker model already present.');
    return;
  }
  await mkdir(dirname(modelDst), { recursive: true });
  console.log('[setup] Downloading hand landmarker model (~7.5 MB)…');
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${modelDst}.part`;
    await writeFile(tmp, buf);
    await rename(tmp, modelDst);
    console.log(`[setup] Saved model (${(buf.length / 1e6).toFixed(1)} MB) → public/models/hand_landmarker.task`);
  } catch (err) {
    console.warn(`[setup] Model download failed (${err.message}). The app will load it from the CDN at runtime.`);
  }
}

await copyWasm();
await downloadModel();
