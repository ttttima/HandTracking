/**
 * Two virtual desktops, for the "second desktop" / "first desktop" keybinds.
 *
 *   second  On the first desktop: go to the second one, creating it if it does not exist yet.
 *           Already on the second (or a later) desktop: nothing.
 *   first   On the second (or a later) desktop: go back to the first. On the first: nothing.
 *
 * Never creates more than two desktops. Which desktop is current comes from the registry,
 * where Explorer keeps the desktop list and the current desktop; switching uses the standard
 * shortcuts (Ctrl+Win+Right / Left, Ctrl+Win+D to create one).
 */
'use strict';
const { execFile } = require('node:child_process');
const input = require('./input.cjs');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';
const SESSION_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SessionInfo';
const DRY_RUN = process.env.HG_DRY_RUN === '1';

function record(entry) {
  const log = globalThis.__hgInputLog;
  if (log) {
    log.push({ t: Date.now(), ...entry });
    if (log.length > 500) log.shift();
  }
}

function regQuery(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', ...args], { windowsHide: true, timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

const binaryValue = (text, name) => {
  const m = new RegExp(`\\s${name}\\s+REG_BINARY\\s+([0-9A-Fa-f]*)`).exec(text);
  return m ? m[1].toUpperCase() : null;
};

/** @returns {Promise<{ count: number, index: number }>} index 0 = the first (original) desktop. */
async function desktopState() {
  if (process.platform !== 'win32') return { count: 1, index: 0 };
  const text = await regQuery([KEY]);
  const idsHex = binaryValue(text, 'VirtualDesktopIDs') ?? '';
  const ids = idsHex.match(/.{32}/g) ?? [];
  // Windows 11 keeps the current desktop next to the list; Windows 10 keeps it per session.
  let current = binaryValue(text, 'CurrentVirtualDesktop');
  if (!current && ids.length > 1) current = binaryValue(await regQuery([SESSION_KEY, '/s', '/v', 'CurrentVirtualDesktop']), 'CurrentVirtualDesktop');
  const index = current ? Math.max(0, ids.indexOf(current)) : 0;
  return { count: Math.max(1, ids.length), index };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;

/** @param {'second' | 'first'} which */
async function switchDesktop(which) {
  if (busy || (which !== 'second' && which !== 'first')) return;
  busy = true;
  try {
    const st = await desktopState();
    if (which === 'second') {
      if (st.index >= 1) return record({ op: 'desktop-stay', ...st });
      if (st.count >= 2) {
        record({ op: 'desktop-second', ...st });
        if (!DRY_RUN) input.sendKeys('Ctrl+Win+Right');
      } else {
        record({ op: 'desktop-create', ...st });
        if (!DRY_RUN) input.sendKeys('Ctrl+Win+D');
      }
    } else {
      if (st.index <= 0) return record({ op: 'desktop-stay', ...st });
      record({ op: 'desktop-first', ...st });
      if (DRY_RUN) return;
      for (let i = 0; i < st.index; i++) {
        input.sendKeys('Ctrl+Win+Left');
        if (i + 1 < st.index) await wait(250);
      }
    }
  } finally {
    // Let Explorer finish the switch (and update the registry) before the next request.
    setTimeout(() => { busy = false; }, 400);
  }
}

module.exports = { desktopState, switchDesktop };
