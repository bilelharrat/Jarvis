// The page's bridge to the Mac app (askeden.com's Eden in Ask Eden for Mac): a badge on the
// Dock icon and a native notification. Nothing else; the page is the website as it is.
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
