'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quickAsk', {
  send: (text) => ipcRenderer.send('eden:quick:send', String(text || '').slice(0, 20000)),
  close: () => ipcRenderer.send('eden:quick:close'),
});
