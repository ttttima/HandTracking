/**
 * Exposes a small, explicit API to the page (window.pcControl). The page never gets Node or
 * Electron access; it can only ask the main process for these specific mouse actions.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcControl', {
  move: (x, y) => ipcRenderer.send('input:move', Number(x), Number(y)),
  button: (which, down) => ipcRenderer.send('input:button', String(which), !!down),
  click: (which) => ipcRenderer.send('input:click', String(which)),
  scroll: (notches) => ipcRenderer.send('input:scroll', Number(notches)),
  releaseAll: () => ipcRenderer.send('input:release'),
  minimizeActiveWindow: () => ipcRenderer.send('window:minimize-foreground'),
  toggleDesktop: () => ipcRenderer.send('window:toggle-desktop'),
  sendKeys: (combo) => ipcRenderer.send('input:keys', String(combo)),
  switchDesktop: (which) => ipcRenderer.send('desktop:switch', which === 'first' ? 'first' : 'second'),
  listApps: () => ipcRenderer.invoke('apps:list'),
  pickProgram: () => ipcRenderer.invoke('apps:pick'),
  openApp: (app) => ipcRenderer.send('apps:open', {
    id: typeof app?.id === 'string' ? app.id : undefined,
    path: typeof app?.path === 'string' ? app.path : undefined,
  }),
  info: () => ipcRenderer.invoke('input:info'),
  setAlwaysOnTop: (on) => ipcRenderer.send('window:on-top', !!on),
  onToggle: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('control:toggle', handler);
    return () => ipcRenderer.removeListener('control:toggle', handler);
  },
});
