// The feature modules' window side: web/features/*.js and *.css, as /features.json lists
// them. Run after app.js, one script after another in name order, so each can use
// app.js's functions and window.jarvisFeatures (on, send, registerPane, registerMoreItem…).
// Without a backend (the window's own tests) there's simply nothing to load. A split view
// pane (app.js: inSplitPane) shows one Eden Code session: only Eden Code's modules (code-*,
// code_*, and loops' entries) run there, and only their stylesheets and those of features
// with no script of their own (a module that doesn't run there has nothing there to style).
(function loadFeatures() {
  const PANE_SCRIPTS = /\/features\/(code[-_][\w-]*|loops)\.js(\?|$)/;
  const paneOnly = typeof inSplitPane !== 'undefined' && inSplitPane;
  const stem = (href) => (/\/features\/([\w-]+)\.(?:js|css)(\?|$)/.exec(href) || [])[1] || '';
  // Eden Code's own window asks for its modules only (server.EDEN_ONLY_FEATURES stay out).
  const edenCode = document.body && document.body.dataset.app === 'eden-code';
  fetch(edenCode ? '/features.json?app=code' : '/features.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then(({ scripts = [], styles = [] } = {}) => {
      const skipped = new Set(paneOnly ? scripts.filter((src) => !PANE_SCRIPTS.test(src)).map(stem) : []);
      for (const href of styles.filter((h) => !skipped.has(stem(h)))) {
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
    .catch(() => {})
    .then(() => window.dispatchEvent(new Event('jarvis-features-ready')));
})();
