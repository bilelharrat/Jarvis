// The only things the page gets from Electron: hear about ⌥Space and ⌥⇧Space, ask for attention, pick
// a folder for the second brain, and show and drive the built-in browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisApp', {
  onSummon: (callback) => ipcRenderer.on('jarvis:summon', () => callback()),
  onWhatsThis: (callback) => ipcRenderer.on('jarvis:whats-this', () => callback()),
  attention: () => ipcRenderer.send('jarvis:attention'),
  pickFolder: () => ipcRenderer.invoke('jarvis:pick-folder'),
  browser: {
    show: (bounds) => ipcRenderer.invoke('browser:show', bounds),
    hide: () => ipcRenderer.invoke('browser:hide'),
    setBounds: (bounds) => ipcRenderer.invoke('browser:bounds', bounds),
    nav: (action, url) => ipcRenderer.invoke('browser:nav', { action, url }),
    command: (command) => ipcRenderer.invoke('browser:command', command),
    onState: (callback) => ipcRenderer.on('browser:state', (_e, state) => callback(state)),
    onOpen: (callback) => ipcRenderer.on('browser:open', () => callback()),
  },
});
