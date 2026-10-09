// Pages made usable with a screen reader, the window's side (the backend is
// jarvis.features.page_a11y; the app's is app/features/page-a11y.js, whose
// page-a11y-preload.js mends each page in the built-in browser):
// - whether the browser mends pages: while screen-reader mode is on (the backend's "a11y"
//   event says) and the owner hasn't turned it off (a11y_page_fixes), told to the app
//   ('feature:page-a11y:mode') whenever either changes;
// - the switch for it, in Settings › Accessibility (accessibility.js builds that group; this
//   adds a row to it);
// - the hub's calls into the browser (page_a11y_cmd: summary, for the page_summary tool),
//   passed to the app and answered (page_a11y_result).
// The helper at the top is pure (window.jarvisPageA11y), so node --test can check it without
// a page.
(() => {
  const P = {
    // Whether the browser mends pages: screen-reader mode on, and the setting not off.
    wanted(a11y, features) {
      const effective = Boolean(a11y && a11y.effective);
      return effective && !(features && features.a11y_page_fixes === false);
    },
  };
  window.jarvisPageA11y = P;

  const F = window.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el } = F;
  const t = (s) => F.t(s);
  const app = window.jarvisApp || null;

  let a11y = null; // the last "a11y" event
  let features = {}; // prefs.features
  let told = null; // what the app was last told

  // Only once the backend has said whether screen-reader mode is on: J.A.R.V.I.S. Daredevil's
  // app starts with the fixes on, and a "no" before then would undo them for nothing.
  function tell() {
    if (!a11y) return;
    const on = P.wanted(a11y, features);
    if (on === told) return;
    told = on;
    if (app && app.feature) app.feature.send('feature:page-a11y:mode', on);
  }

  // ── Settings › Accessibility: the switch ──

  let sw = null;
  function render() {
    if (sw) sw.setAttribute('aria-checked', String(features.a11y_page_fixes !== false));
  }
  function build() {
    const group = F.$('a11y-group');
    if (!group || sw) return Boolean(sw);
    const row = el('div', 'row');
    row.id = 'page-a11y-row';
    const words = el('span');
    words.append(el('strong', '', t('Make web pages easier to read')),
      el('small', '', t('In the built-in browser: names for unlabeled buttons, links and pictures, headings you can jump between, and cookie banners and pop-ups out of the way (cookies refused where the page lets you). Only while screen-reader mode is on.')));
    sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t('Make web pages easier to read'));
    sw.addEventListener('click', () => {
      const next = features.a11y_page_fixes === false;
      features = { ...features, a11y_page_fixes: next };
      F.send({ type: 'feature_prefs', changes: { a11y_page_fixes: next } });
      render();
      tell();
    });
    row.append(words, sw);
    const before = F.$('a11y-open-note');
    if (before && before.parentElement === group) group.insertBefore(row, before); else group.append(row);
    render();
    return true;
  }
  function mount() {
    if (build()) return;
    // Settings' Accessibility group may come a moment later.
    const sheet = F.$('settings') || document.body;
    const watch = new MutationObserver(() => { if (build()) watch.disconnect(); });
    watch.observe(sheet, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  F.on('a11y', (ev) => { a11y = ev; tell(); }, { replay: true });
  F.on('prefs', (ev) => {
    features = (ev && ev.features) || {};
    render();
    tell();
  }, { replay: true });

  // ── the hub's calls ──

  F.on('page_a11y_cmd', async (ev) => {
    let result;
    if (!app || !app.feature) result = { ok: false, message: 'The built-in browser is only in the J.A.R.V.I.S. app.' };
    else {
      try {
        result = await app.feature.invoke('feature:page-a11y:call', { action: ev.action, args: ev.args || {} });
      } catch (err) {
        result = { ok: false, message: String((err && err.message) || err) };
      }
    }
    F.send({ type: 'page_a11y_result', id: ev.id, result: result || {} });
  });
})();
