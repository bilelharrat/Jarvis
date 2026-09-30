// The feature modules' window side: web/features/*.js and *.css, as /features.json lists
// them. Loaded after app.js, one script after another in name order, so each can use
// app.js's functions and window.jarvisFeatures (on, send, registerPane, registerMoreItem…).
// Without a backend (the window's own tests) there's simply nothing to load.
(function loadFeatures() {
  fetch('/features.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then(({ scripts = [], styles = [] } = {}) => {
      for (const href of styles) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.append(link);
      }
      return scripts.reduce((ready, src) => ready.then(() => new Promise((resolve) => {
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
