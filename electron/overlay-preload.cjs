/** The pointer badge page gets one thing: the state to draw. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hgBadge', {
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, state) => cb(state)),
});
