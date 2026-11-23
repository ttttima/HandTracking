/**
 * Installed apps, for the "Open an app" keybind.
 *
 * The list comes from Windows' own Start-menu catalogue (Get-StartApps), which covers normal
 * programs, Store apps (Calculator, Settings…), web apps and games. Every entry opens through
 * the shell's app folder (explorer.exe shell:AppsFolder\<AppID>), exactly like clicking it in
 * the Start menu.
 *
 * Safety: the page can only ask to open an AppID from this list, or a program file the user
 * picked in the Browse dialog (.exe / .lnk). It can never run arbitrary commands.
 */
'use strict';
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { dialog, shell } = require('electron');

const DRY_RUN = process.env.HG_DRY_RUN === '1';
const CACHE_MS = 5 * 60 * 1000;
let cache = null;
let cacheAt = 0;
let pending = null;

function record(entry) {
  const log = globalThis.__hgInputLog;
  if (log) {
    log.push({ t: Date.now(), ...entry });
    if (log.length > 500) log.shift();
  }
}

/** @returns {Promise<{ name: string, id: string }[]>} */
function listApps() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (cache && Date.now() - cacheAt < CACHE_MS) return Promise.resolve(cache);
  if (pending) return pending;
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress';
  pending = new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      pending = null;
      if (err) return resolve(cache ?? []);
      try {
        const raw = JSON.parse(stdout || '[]');
        const seen = new Set();
        const apps = (Array.isArray(raw) ? raw : [raw])
          .filter((a) => a && typeof a.Name === 'string' && typeof a.AppID === 'string' && a.Name.trim())
          .map((a) => ({ name: a.Name.trim(), id: a.AppID }))
          .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        cache = apps;
        cacheAt = Date.now();
        resolve(apps);
      } catch {
        resolve(cache ?? []);
      }
    });
  });
  return pending;
}

/** Programs picked in the Browse dialog during this session (and saved ones that still exist). */
const PROGRAM_EXT = new Set(['.exe', '.lnk']);
function isProgramFile(p) {
  return typeof p === 'string' && path.isAbsolute(p) && PROGRAM_EXT.has(path.extname(p).toLowerCase()) && fs.existsSync(p);
}

/** @param {{ id?: string, path?: string, name?: string }} app */
async function openApp(app) {
  if (!app || typeof app !== 'object') return;
  if (typeof app.id === 'string' && app.id) {
    const apps = await listApps();
    const entry = apps.find((a) => a.id === app.id);
    if (!entry) return record({ op: 'open-app-rejected', app: String(app.id).slice(0, 80) });
    if (DRY_RUN) return record({ op: 'open-app', app: entry.name });
    spawn('explorer.exe', [`shell:AppsFolder\\${entry.id}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  if (isProgramFile(app.path)) {
    if (DRY_RUN) return record({ op: 'open-app', app: path.basename(app.path) });
    const err = await shell.openPath(app.path);
    if (err) record({ op: 'open-app-failed', app: path.basename(app.path), error: err });
    return;
  }
  record({ op: 'open-app-rejected', app: String(app.path ?? '').slice(0, 80) });
}

/** Let the user pick any program that is not in the Start menu. */
async function pickProgram(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a program to open',
    properties: ['openFile'],
    filters: [{ name: 'Programs and shortcuts', extensions: ['exe', 'lnk'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const file = res.filePaths[0];
  if (!isProgramFile(file)) return null;
  return { path: file, name: path.basename(file, path.extname(file)) };
}

module.exports = { listApps, openApp, pickProgram };
