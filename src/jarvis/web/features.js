// The feature modules' window side: web/features/*.js and *.css, as /features.json lists
// them. Run after app.js, one script after another in name order, so each can use
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
      // All asked for at once, and still run one after another in this order: scripts put in
      // with async = false run in the order they were put in, each once those before it have
      // (or have failed to load). Asking for each only after the one before had run waited
      // out some ninety round trips to the backend, one by one, at every start.
      return Promise.all(scripts.filter((src) => !paneOnly || PANE_SCRIPTS.test(src)).map((src) => new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => { console.error('feature script failed:', src); resolve(); };
        document.body.append(script);
      })));
    })
    // A list that couldn't be read (the backend gone mid-start, a damaged answer) leaves the
    // window without its features: said once, in the console, rather than not at all.
    .catch((err) => { console.error('features.json failed:', err); })
    .then(() => window.dispatchEvent(new Event('jarvis-features-ready')));
})();
