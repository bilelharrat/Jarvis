// The Ask Eden window's page (features/eden-window.js) gets one thing from Electron: Jarvis's
// built-in browser, docked in Eden's browser panel (askeden web/chat/browser-pane.js). Only
// its own 'feature:eden:browser:…' channels, which the window checks come from Eden's page.
const { contextBridge, ipcRenderer } = require('electron');

const CH = 'feature:eden:browser:';
contextBridge.exposeInMainWorld('jarvisBrowser', {
  version: 1,
  open: (on) => ipcRenderer.invoke(`${CH}open`, on !== false),
  show: (bounds) => ipcRenderer.invoke(`${CH}show`, bounds),
  hide: () => ipcRenderer.invoke(`${CH}hide`),
  bounds: (bounds) => ipcRenderer.invoke(`${CH}bounds`, bounds),
  nav: (action, url) => ipcRenderer.invoke(`${CH}nav`, String(action || ''), String(url || '')),
  tab: (action, id) => ipcRenderer.invoke(`${CH}tab`, String(action || ''), Number(id) || 0),
  shields: () => ipcRenderer.invoke(`${CH}shields`),
  state: () => ipcRenderer.invoke(`${CH}state`),
  onState: (callback) => ipcRenderer.on(`${CH}state`, (_e, state) => callback(state)),
});
