// The only things the page gets from Electron: hear about ⌥Space, ask for attention, and
// pick a folder for the second brain.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisApp', {
  onSummon: (callback) => ipcRenderer.on('jarvis:summon', () => callback()),
  attention: () => ipcRenderer.send('jarvis:attention'),
  pickFolder: () => ipcRenderer.invoke('jarvis:pick-folder'),
});
