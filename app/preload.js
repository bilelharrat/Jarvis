// The only things the page gets from Electron: hear about ⌥Space and ⌥⇧Space, ask for attention, pick
// a folder for the second brain, lay out a PDF, and show and drive the built-in browser
// (where the BSH Research Center opens).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisApp', {
  onSummon: (callback) => ipcRenderer.on('jarvis:summon', () => callback()),
  onWhatsThis: (callback) => ipcRenderer.on('jarvis:whats-this', () => callback()),
  attention: () => ipcRenderer.send('jarvis:attention'),
  pickFolder: () => ipcRenderer.invoke('jarvis:pick-folder'),
  pdf: (page) => ipcRenderer.invoke('jarvis:pdf', page),
  browser: {
    show: (bounds) => ipcRenderer.invoke('browser:show', bounds),
    hide: () => ipcRenderer.invoke('browser:hide'),
    setBounds: (bounds) => ipcRenderer.invoke('browser:bounds', bounds),
    nav: (action, url) => ipcRenderer.invoke('browser:nav', { action, url }),
    command: (command) => ipcRenderer.invoke('browser:command', command),
    hand: (message) => ipcRenderer.send('browser:hand', message),
    onState: (callback) => ipcRenderer.on('browser:state', (_e, state) => callback(state)),
    onOpen: (callback) => ipcRenderer.on('browser:open', () => callback()),
    onHover: (callback) => ipcRenderer.on('browser:hover', (_e, hover) => callback(hover)),
    onNote: (callback) => ipcRenderer.on('browser:note', (_e, note) => callback(note)),
    onEscape: (callback) => ipcRenderer.on('browser:escape', () => callback()),
  },
});
