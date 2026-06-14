const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  get: () => ipcRenderer.invoke('usage:get'),
  context: () => ipcRenderer.invoke('context:get'),
  version: () => ipcRenderer.invoke('app:version'),
  onUpdate: (cb) => ipcRenderer.on('usage:update', (_e, data) => cb(data)),
  onContext: (cb) => ipcRenderer.on('context:update', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('usage:error', (_e, msg) => cb(msg)),
  refresh: () => ipcRenderer.send('widget:refresh'),
  hide: () => ipcRenderer.send('widget:hide'),
  close: () => ipcRenderer.send('widget:close'),
  accentColor: () => ipcRenderer.invoke('theme:accentColor'),
});
