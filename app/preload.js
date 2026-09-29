// The only things the page gets from Electron: hear about ⌥Space, and ask for attention.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisApp', {
  onSummon: (callback) => ipcRenderer.on('jarvis:summon', () => callback()),
  attention: () => ipcRenderer.send('jarvis:attention'),
});
