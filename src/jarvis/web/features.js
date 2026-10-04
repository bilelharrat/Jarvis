// The feature modules' window side: web/features/*.js and *.css, as /features.json lists
// them. Loaded after app.js, one script after another in name order, so each can use
// app.js's functions and window.jarvisFeatures (on, send, registerPane, registerMoreItem…).
// Without a backend (the window's own tests) there's simply nothing to load. Split view's
// right pane (app.js: inSplitPane) shows one Jarvis Code session: only Jarvis Code's modules
// (code-*, code_*, and loops' entries) run there; every stylesheet loads.
(function loadFeatures() {
  const PANE_SCRIPTS = /\/features\/(code[-_][\w-]*|loops)\.js(\?|$)/;
  const paneOnly = typeof inSplitPane !== 'undefined' && inSplitPane;
  fetch('/features.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then(({ scripts = [], styles = [] } = {}) => {
      for (const href of styles) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.append(link);
      }
      return scripts.filter((src) => !paneOnly || PANE_SCRIPTS.test(src)).reduce((ready, src) => ready.then(() => new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => { console.error('feature script failed:', src); resolve(); };
        document.body.append(script);
      })), Promise.resolve());
    })
    .catch(() => {})
    .then(() => window.dispatchEvent(new Event('jarvis-features-ready')));
})();
