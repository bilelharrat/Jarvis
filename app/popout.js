// The bar of a tab popped out of the dock (browser-parity.js lays the page under it): back,
// forward, reload, its address (typed ones go where the dock's address bar would send
// them), and back to the dock. Its words come in the owner's language with each state.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.popout;
  let state = {};

  function render(next) {
    state = next || {};
    const L = state.labels || {};
    for (const [id, key] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload']]) {
      if (L[key]) { $(id).title = L[key]; $(id).setAttribute('aria-label', L[key]); }
    }
    if (L.dock) $('dock-label').textContent = L.dock;
    if (L.address) $('address').setAttribute('aria-label', L.address);
    $('back').disabled = !state.canBack;
    $('forward').disabled = !state.canForward;
    $('progress').hidden = !state.loading;
    if (document.activeElement !== $('address')) $('address').value = state.url || '';
    document.title = state.title || state.url || '';
  }

  $('back').addEventListener('click', () => api.act('back'));
  $('forward').addEventListener('click', () => api.act('forward'));
  $('reload').addEventListener('click', () => api.act(state.loading ? 'stop' : 'reload'));
  $('dock').addEventListener('click', () => api.act('dock'));
  $('bar').addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = $('address').value.trim();
    if (typed) api.act('go', typed);
    $('address').blur();
  });
  $('address').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('address').value = state.url || ''; $('address').blur(); }
  });
  $('address').addEventListener('focus', () => $('address').select());
  api.onState(render);
  api.onFocusAddress(() => { $('address').focus(); $('address').select(); });
})();
