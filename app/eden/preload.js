// The page's bridge to the Mac app (askeden.com's Eden in Ask Eden for Mac): a badge on the
// Dock icon, a native notification, and the app's own browser in the page's browser panel
// (local-browser.js; askeden web/chat/browser-pane.js uses window.jarvisBrowser). Nothing else;
// the page is the website as it is.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('askEdenMac', {
  version: 1,
  badge: (n) => ipcRenderer.send('eden:badge', Math.max(0, Math.min(99, Number(n) || 0))),
  notify: (title, body) => ipcRenderer.send('eden:notify', String(title || '').slice(0, 120), String(body || '').slice(0, 300)),
  // The boot-up sound: Settings › Appearance and the welcome sheet (askeden web/chat/boot-sound.js).
  getBootSound: () => ipcRenderer.invoke('eden:boot-sound'),
  setBootSound: (on) => ipcRenderer.invoke('eden:boot-sound', Boolean(on)),
  relink: () => ipcRenderer.invoke('eden:relink'),
  engine: () => ipcRenderer.invoke('eden:engine'),
});

// The browser on this Mac (the same calls as Eden Secretary's window.jarvisBrowser, and a few more).
const CH = 'eden:browser:';
contextBridge.exposeInMainWorld('jarvisBrowser', {
  version: 2,
  local: true,
  open: (on) => ipcRenderer.invoke(`${CH}open`, on !== false),
  show: (bounds) => ipcRenderer.invoke(`${CH}show`, bounds),
  hide: () => ipcRenderer.invoke(`${CH}hide`),
  bounds: (bounds) => ipcRenderer.invoke(`${CH}bounds`, bounds),
  nav: (action, url) => ipcRenderer.invoke(`${CH}nav`, String(action || ''), String(url || '')),
  tab: (action, id) => ipcRenderer.invoke(`${CH}tab`, String(action || ''), Number(id) || 0),
  state: () => ipcRenderer.invoke(`${CH}state`),
  pageText: () => ipcRenderer.invoke(`${CH}pagetext`),
  selection: () => ipcRenderer.invoke(`${CH}selection`),
  find: (q, dir, fresh) => ipcRenderer.invoke(`${CH}find`, String(q || ''), Number(dir) || 1, Boolean(fresh)),
  zoom: (step) => ipcRenderer.invoke(`${CH}zoom`, Number(step) || 0),
  outside: () => ipcRenderer.invoke(`${CH}outside`),
  clear: () => ipcRenderer.invoke(`${CH}clear`),
  onState: (callback) => { ipcRenderer.on(`${CH}state`, (_e, state) => callback(state)); },
  onCommand: (callback) => { ipcRenderer.on(`${CH}command`, (_e, cmd) => callback(cmd)); },
});
