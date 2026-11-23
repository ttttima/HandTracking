#!/usr/bin/env node
/**
 * Settings survive a restart: change keybinds and settings, close the app, wipe Chromium's own
 * storage, start again and check everything came back from settings.json.
 *
 * Usage: npm run verify:settings              (source tree)
 *        node scripts/verify-settings.mjs --packaged   (the built app in release/)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const exe = join(root, 'release', 'win-unpacked', 'HandGestures.exe');
if (packaged && !existsSync(exe)) {
  console.error('No packaged build found. Run `npm run desktop:dist` first.');
  process.exit(1);
}
const profile = mkdtempSync(join(tmpdir(), 'handgestures-settings-'));
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } });

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function launch() {
  const app = await electron.launch({
    ...(packaged ? { executablePath: exe, args: [] } : { args: ['.'] }),
    cwd: root,
    env: { ...process.env, HG_DRY_RUN: '1', VITE_DEV_SERVER_URL: '', HG_USER_DATA: profile },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.getElementById('btn-keybinds') && !document.getElementById('btn-keybinds').hidden, null, { timeout: 30000 });
  return { app, page };
}

const file = join(profile, 'settings.json');

// ── First run: change things ───────────────────────────────────────────────
let { app, page } = await launch();
try {
  await page.waitForTimeout(800);
  record('settings file is created on first start', existsSync(file), file);
  await page.locator('#swipe-distance').fill('1.35');
  await page.click('#btn-keybinds');
  await page.waitForTimeout(300);
  const thumbs = page.locator('#keybind-list .bind-row').filter({ hasText: 'Thumbs up' });
  await thumbs.locator('select').first().selectOption('keys');
  await thumbs.locator('.bind-keys input').fill('ctrl+alt+k');
  await thumbs.locator('.bind-keys input').blur();
  await page.click('#btn-close-keybinds');
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.locator('#gesture-toggles input[data-id="middle_finger"]').uncheck();
  await page.locator('#snap-enabled').check();
  await page.selectOption('#control-hand', 'Left');
  const shownPath = await page.textContent('#settings-file-path');
  record('Settings shows where the file is', !!shownPath && shownPath.endsWith('settings.json'), shownPath ?? '');
  await page.waitForTimeout(600); // let the debounced save land
} finally {
  await app.close();
}

const saved = JSON.parse(readFileSync(file, 'utf8'));
const s = saved.settings;
record('file holds the keybinds', s['handgestures.keybinds.v1']?.thumbs_up?.keys === 'Ctrl+Alt+K' || s['handgestures.keybinds.v1']?.thumbs_up?.keys === 'ctrl+alt+k',
  JSON.stringify(s['handgestures.keybinds.v1']?.thumbs_up));
record('file holds sensitivity, gestures, snapping, control', s['handgestures.thresholds.v1']?.swipeMinDistance === 1.35
  && s['handgestures.enabled.v1']?.middle_finger === false && s['handgestures.snapping.v1']?.enabled === true
  && s['handgestures.control.v1']?.hand === 'Left', Object.keys(s).join(', '));

// Wipe Chromium's own storage so only the file can bring the settings back.
for (const dir of ['Local Storage', 'Session Storage', 'IndexedDB']) rmSync(join(profile, dir), { recursive: true, force: true });

// ── Second run: everything is back ─────────────────────────────────────────
({ app, page } = await launch());
try {
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => ({
    swipe: document.getElementById('swipe-distance').value,
    middle: document.querySelector('#gesture-toggles input[data-id="middle_finger"]').checked,
    snap: document.getElementById('snap-enabled').checked,
    hand: document.getElementById('control-hand').value,
  }));
  await page.click('#btn-keybinds');
  await page.waitForTimeout(300);
  const thumbs = page.locator('#keybind-list .bind-row').filter({ hasText: 'Thumbs up' });
  const action = await thumbs.locator('select').first().inputValue();
  const keys = await thumbs.locator('.bind-keys input').inputValue();
  record('after a restart the keybind is back', action === 'keys' && /ctrl\+alt\+k/i.test(keys), `${action} ${keys}`);
  record('after a restart the settings are back', back.swipe === '1.35' && !back.middle && back.snap && back.hand === 'Left', JSON.stringify(back));
} finally {
  await app.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} settings checks passed.`);
process.exit(failed ? 1 : 0);
