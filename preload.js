const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  get: () => ipcRenderer.invoke('usage:get'),
  onUpdate: (cb) => ipcRenderer.on('usage:update', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('usage:error', (_e, msg) => cb(msg)),
  refresh: () => ipcRenderer.send('widget:refresh'),
  close: () => ipcRenderer.send('widget:close'),
});
