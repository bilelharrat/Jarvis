// The bar of a tab popped out of the dock into a window of its own (popout.html): its page's
// state, and the few things the bar does to that tab only (browser-parity.js checks the bar
// asking is that window's).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popout', {
  onState: (callback) => ipcRenderer.on('popout:state', (_e, state) => callback(state)),
  onFocusAddress: (callback) => ipcRenderer.on('popout:address', () => callback()),
  act: (action, url) => ipcRenderer.invoke('browser-popout:act', { action, url }),
});
