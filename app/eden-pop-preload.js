// Eden's pop-up (eden-pop.html, app/features/eden-pop.js): the few things its page may ask of
// the app, on its own 'eden-pop:' channels (the feature checks each comes from the pop-up).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edenPop', {
  onOpen: (callback) => ipcRenderer.on('eden-pop:open', (_e, state) => callback(state)),
  onChunk: (callback) => ipcRenderer.on('eden-pop:chunk', (_e, part) => callback(part)),
  onEnd: (callback) => ipcRenderer.on('eden-pop:end', (_e, end) => callback(end)),
  ask: (req) => ipcRenderer.send('eden-pop:ask', req),
  stop: () => ipcRenderer.send('eden-pop:stop'),
  close: () => ipcRenderer.send('eden-pop:close'),
  size: (height) => ipcRenderer.send('eden-pop:size', height),
  copy: (text) => ipcRenderer.invoke('eden-pop:copy', text),
  put: (text) => ipcRenderer.invoke('eden-pop:put', text),
  speak: (text) => ipcRenderer.invoke('eden-pop:speak', text),
  continueInEden: (req) => ipcRenderer.invoke('eden-pop:continue', req),
});
