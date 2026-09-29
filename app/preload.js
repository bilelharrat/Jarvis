// The only things the page gets from Electron: hear about ⌥Space and ⌥⇧Space, ask for attention, pick
// a folder for the second brain, show and drive the built-in browser, and show and drive
// the BSH Research Center.
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
  // The BSH Research Center view: shown and driven only through Jarvis.
  research: {
    show: (bounds, base, path) => ipcRenderer.invoke('research:show', { bounds, base, path }),
    hide: () => ipcRenderer.invoke('research:hide'),
    setBounds: (bounds) => ipcRenderer.invoke('research:bounds', bounds),
    hand: (message) => ipcRenderer.send('research:hand', message),
    command: (command) => ipcRenderer.invoke('research:command', command),
    onState: (callback) => ipcRenderer.on('research:state', (_e, state) => callback(state)),
    onHover: (callback) => ipcRenderer.on('research:hover', (_e, hover) => callback(hover)),
    onNote: (callback) => ipcRenderer.on('research:note', (_e, note) => callback(note)),
    onEscape: (callback) => ipcRenderer.on('research:escape', () => callback()),
  },
});
