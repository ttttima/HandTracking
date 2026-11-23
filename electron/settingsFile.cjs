/**
 * Every setting and keybind, kept in one JSON file in the app's data folder:
 *
 *   %APPDATA%\hand-gestures\settings.json
 *
 * The page sends the whole set whenever something changes; it is written atomically
 * (temp file + rename), so a crash or a killed process never leaves a half-written file.
 * On start the page reads it back before anything else loads.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const KEY = /^handgestures\.[a-z0-9.]{1,40}$/i;
const MAX_BYTES = 1024 * 1024;

const filePath = () => path.join(app.getPath('userData'), 'settings.json');

/** @returns {{ version: number, savedAt?: string, settings: Record<string, unknown> } | null} */
function read() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (!data || typeof data !== 'object' || !data.settings || typeof data.settings !== 'object') return null;
    const settings = {};
    for (const [k, v] of Object.entries(data.settings)) if (KEY.test(k)) settings[k] = v;
    return { version: 1, savedAt: data.savedAt, settings };
  } catch {
    return null; // no file yet (first start) or unreadable: the page keeps its defaults
  }
}

/** @param {unknown} settings */
function write(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const clean = {};
  for (const [k, v] of Object.entries(settings)) if (KEY.test(k)) clean[k] = v;
  const text = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), settings: clean }, null, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) return false;
  const file = filePath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { filePath, read, write };
