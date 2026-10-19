'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets a narrow, named API. It never receives ipcRenderer, Node, or raw sockets.
const onChannel = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('codai', {
  app: {
    info: () => ipcRenderer.invoke('app:getInfo'),
    openLogs: () => ipcRenderer.invoke('shell:openLogs'),
  },
  runtime: {
    info: () => ipcRenderer.invoke('runtime:info'),
    restart: () => ipcRenderer.invoke('runtime:restart'),
    onPhase: (handler) => onChannel('runtime:phase', handler),
    onReady: (handler) => onChannel('runtime:ready', handler),
    onError: (handler) => onChannel('runtime:error', handler),
  },
  data: {
    load: () => ipcRenderer.invoke('data:load'),
    save: (data) => ipcRenderer.invoke('data:save', data),
  },
  settings: {
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
  },
  chat: {
    send: (request) => ipcRenderer.invoke('chat:send', request),
    stop: (id) => ipcRenderer.invoke('chat:stop', id),
    onDelta: (handler) => onChannel('chat:delta', handler),
  },
  dialog: {
    confirm: (message) => ipcRenderer.invoke('dialog:confirm', message),
  },
});
