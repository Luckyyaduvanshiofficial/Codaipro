'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The splash may only listen for startup phases. It cannot send messages or touch Node.
contextBridge.exposeInMainWorld('codaiSplash', {
  onPhase: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('phase', listener);
    return () => ipcRenderer.removeListener('phase', listener);
  },
});
