// The hand-control indicator's preload: it can only listen for updates from main.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('handHud', {
  onUpdate: (callback) => ipcRenderer.on('hand-hud:update', (_e, update) => callback(update)),
});
