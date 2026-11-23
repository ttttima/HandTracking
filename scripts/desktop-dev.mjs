#!/usr/bin/env node
/**
 * Development mode for the desktop app: starts the Vite dev server (hot reload for the UI)
 * and opens Electron pointed at it. Closing the window stops both.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBin = require('electron'); // path to the Electron executable

const server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), server: { port: 5174, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[desktop] UI dev server at ${url}`);

const child = spawn(electronBin, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
