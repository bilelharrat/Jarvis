// The only things the page gets from Electron: hear about ⌥Space and ⌥⇧Space, ask for attention, pick
// a folder for the second brain, lay out a PDF, show and drive the built-in browser
// (where the BSH Research Center opens), and the app feature modules' own channels.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('jarvisApp', {
  onSummon: (callback) => ipcRenderer.on('jarvis:summon', () => callback()),
  onWhatsThis: (callback) => ipcRenderer.on('jarvis:whats-this', () => callback()),
  attention: () => ipcRenderer.send('jarvis:attention'),
  pickFolder: () => ipcRenderer.invoke('jarvis:pick-folder'),
  pdf: (page) => ipcRenderer.invoke('jarvis:pdf', page),
  desktopHands: (on) => ipcRenderer.send('jarvis:desktop-hands', !!on),
  handHud: (update) => ipcRenderer.send('jarvis:hand-hud', update),
  // Where a file dropped on the window lives (a video to summarize): only the file the
  // user dropped, which the page can't learn otherwise.
  pathFor: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  // Feature modules of the app (app/features/*.js): only their own 'feature:…' channels.
  feature: {
    invoke: (channel, ...args) => (String(channel).startsWith('feature:')
      ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('not a feature channel'))),
    send: (channel, ...args) => { if (String(channel).startsWith('feature:')) ipcRenderer.send(channel, ...args); },
    on: (channel, callback) => {
      if (String(channel).startsWith('feature:')) ipcRenderer.on(channel, (_e, ...args) => callback(...args));
    },
  },
  browser: {
    show: (bounds) => ipcRenderer.invoke('browser:show', bounds),
    hide: () => ipcRenderer.invoke('browser:hide'),
    setBounds: (bounds) => ipcRenderer.invoke('browser:bounds', bounds),
    nav: (action, url) => ipcRenderer.invoke('browser:nav', { action, url }),
    command: (command) => ipcRenderer.invoke('browser:command', command),
    tab: (action, id, url) => ipcRenderer.invoke('browser:tab', { action, id, url }),
    find: (options) => ipcRenderer.invoke('browser:find', options),
    data: (action, url, title) => ipcRenderer.invoke('browser:data', { action, url, title }),
    download: (id, action) => ipcRenderer.invoke('browser:download', { id, action }),
    shortcut: (action) => ipcRenderer.invoke('browser:shortcut', action),
    shields: (action) => ipcRenderer.invoke('browser:shields', { action }),
    researchLock: (on) => ipcRenderer.invoke('browser:research-lock', Boolean(on)),
    onFound: (callback) => ipcRenderer.on('browser:found', (_e, r) => callback(r)),
    onShortcut: (callback) => ipcRenderer.on('browser:shortcut', (_e, action) => callback(action)),
    onDownload: (callback) => ipcRenderer.on('browser:download', (_e, d) => callback(d)),
    onPageFullscreen: (callback) => ipcRenderer.on('browser:page-fullscreen', (_e, on) => callback(on)),
    hand: (message) => ipcRenderer.send('browser:hand', message),
    onState: (callback) => ipcRenderer.on('browser:state', (_e, state) => callback(state)),
    onOpen: (callback) => ipcRenderer.on('browser:open', () => callback()),
    onHover: (callback) => ipcRenderer.on('browser:hover', (_e, hover) => callback(hover)),
    onNote: (callback) => ipcRenderer.on('browser:note', (_e, note) => callback(note)),
    onEscape: (callback) => ipcRenderer.on('browser:escape', () => callback()),
  },
});
