// Eden Code's Browser pane: the built-in browser in Eden Code's own window, as a workbench
// pane beside the conversation (the title bar's globe, ⌥⌘B), the same as Terminal and Changes.
// - The engine is the app's (app/main.js): its tabs, ad blocker, per-site permissions,
//   downloads and sign-ins, in Eden Code's own profile. The page is a native view laid over
//   the pane's slot (jarvisApp.browser.place), so it goes where it's told: the slot is watched
//   every frame while the pane is open (a window resized, full screen, the pane dragged wider)
//   and the view is moved, or taken off when the pane closes or another pane takes its place.
// - A native view is drawn above every element of the page, so when anything of the page lies
//   over the slot (a menu, a dialog, Settings, a picture shown larger: whatever
//   elementFromPoint finds there that isn't the slot) the view steps aside (park) and a
//   picture of it stands in for it until the slot is clear again.
// - Toolbar: back, forward, reload (stop while loading), the address (a web address, a page
//   on this Mac, or words to search for: app/url-input.js reads it), Select element, the page
//   in the default browser, DevTools; and a simple tab strip with + and ×.
// - Dev servers (devservers.py, through code_verify's cv_state and devservers events): the
//   project's running server is offered above the page, and opened by itself when the pane
//   shows only an empty tab or the start page; a configured one that isn't running offers
//   Start, and opens once it answers.
// - Watching the agent: a session's own browser tools (browser_agent.py, through app.js's
//   runBrowserCommand) and its "Check it yourself" (code_selfcheck.py, a hidden preview: a
//   live picture of it here, app/features/self-check.js peek) show as "Eden is using the
//   browser", with Take over (the session's browser commands are held, answered "the owner
//   has taken over", until Hand back) and Hand back.
// - Point and tell: Select element is code-pick's Pick mode (features/code_pick.py): the
//   element's selector, text, a picture of it and the page's address go on the composer as
//   its usual attachment chip. Only a page on this Mac or a file the owner opened (S29).
// Cost policy (Claude): nothing here calls a model.
// Pure helpers are exported for node --test (tests/web/code-browser.test.mjs).
(function codeBrowser(root) {
  'use strict';

  const ACTIVE_MS = 5000;  // "Eden is using the browser" stays this long after its last step
  const PEEK_MS = 1200;  // the hidden preview's picture is read at most this often
  const MIN_W = 360;  // the pane's narrowest (px)
  const MAIN_MIN = 420;  // what's always left for the conversation (px)
  const WIDTH_KEY = 'eden.code.browserWidth';
  const HELD = 'The owner has taken over the browser. Wait until they hand it back, or ask them in your reply.';
  const NOT_LOCAL = 'Select element works on your dev server’s page (an address on this Mac) or a file you opened yourself.';
  const NO_APP = 'The browser shows pages in the Eden Code app.';

  // ── pure helpers ──

  function hostOf(url) {
    try { return new URL(String(url)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (_) { return ''; }
  }

  // A page on this Mac (app/element-pick-lib.js isLocal): what Select element and the dev
  // server offer work on.
  function isLocalUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch (_) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = hostOf(url);
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  }

  // What the address field shows for a page: its address as it is, nothing for an empty tab.
  function fieldText(url) {
    const u = String(url || '');
    return u === 'about:blank' ? '' : u;
  }

  // What's typed, as main.js's toUrl (app/url-input.js) will read it: an address, or words to
  // search for. Only for the field's look (its icon); the app decides where it goes.
  function addressKind(text) {
    const s = String(text || '').trim();
    if (!s) return 'empty';
    if (/^(https?|file):\/\//i.test(s) || /^about:blank$/i.test(s)) return 'url';
    if (/\s/.test(s)) return 'search';
    const m = /^(\[[0-9a-f:.]+\]|[\w-]+(?:\.[\w-]+)*)(?::(\d{1,5}))?([/?#]\S*)?$/i.exec(s);
    if (!m) return 'search';
    const [, host, port] = m;
    if (port && Number(port) > 65535) return 'search';
    const name = host.toLowerCase();
    if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[')) return 'url';
    if (port) return 'url';
    return host.includes('.') && /[a-z]/i.test(host.split('.').pop()) ? 'url' : 'search';
  }

  // A tab's words in the strip: its title, else its site, else "New tab".
  function tabTitle(tab) {
    if (!tab) return 'New tab';
    const title = String(tab.title || '').trim();
    if (title && title !== tab.url) return title;
    const host = hostOf(tab.url);
    return host || 'New tab';
  }

  // 'code:12' -> 12: the Eden Code session a tab or a browser command is for.
  function sessionOf(owner) {
    const m = /^code:(\d+)$/.exec(String(owner || ''));
    return m ? Number(m[1]) : null;
  }

  // An empty tab, or the search engine's start page: one a dev server may open over by itself.
  function blankish(url) {
    const u = String(url || '');
    if (!u || u === 'about:blank') return true;
    try {
      const p = new URL(u);
      return /^(www\.)?(google\.com|duckduckgo\.com|bing\.com|search\.brave\.com|kagi\.com)$/.test(p.hostname) && (p.pathname === '/' || p.pathname === '');
    } catch (_) { return false; }
  }

  // The dev server the pane offers for a project: a live one with an address (ready first),
  // else a configured one to start. null when the page already shows it (same origin).
  //   servers: devservers' public() items; configs: cv_state's; project: the project's folder.
  function devOffer({ servers = [], configs = [], project = '', shown = '' } = {}) {
    if (!project) return null;
    const ours = servers.filter((s) => s && s.project === project && s.url && ['starting', 'ready', 'running'].includes(s.status));
    const rank = (s) => (s.status === 'starting' ? 1 : 0);
    const live = ours.slice().sort((a, b) => rank(a) - rank(b))[0];
    if (live) {
      let same = false;
      try { same = new URL(live.url).origin === new URL(shown).origin; } catch (_) { same = false; }
      if (same) return null;
      return { kind: live.status === 'starting' ? 'starting' : 'open', name: live.name, url: live.url, key: live.key };
    }
    const config = configs.find((c) => c && c.name);
    return config ? { kind: 'start', name: config.name } : null;
  }

  // The pane's width (px): what the owner dragged it to, else half the window; never so wide
  // the conversation goes, never narrower than MIN_W.
  function paneWidth(saved, windowWidth) {
    const w = Number(windowWidth) || 0;
    const most = Math.max(MIN_W, w - MAIN_MIN);
    const want = Number(saved) > 0 ? Number(saved) : Math.round(w * 0.5);
    return Math.max(MIN_W, Math.min(most, want));
  }

  // Points spread over a rect (a grid of n × n, inset from the edges), where the page's own
  // elements are looked for over the slot.
  function probePoints(rect, n = 4) {
    const pts = [];
    if (!rect || rect.width < 2 || rect.height < 2) return pts;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        pts.push([rect.left + ((i + 0.5) * rect.width) / n, rect.top + ((j + 0.5) * rect.height) / n]);
      }
    }
    // the corners too, a few pixels in (a menu opening at the slot's edge)
    const k = 4;
    pts.push([rect.left + k, rect.top + k], [rect.right - k, rect.top + k], [rect.left + k, rect.bottom - k], [rect.right - k, rect.bottom - k]);
    return pts;
  }

  // Whether something of the page lies over the slot: hit(x, y) is what's topmost there (the
  // window's elementFromPoint); inside(node) whether that node is the slot or in it.
  function covered(rect, hit, inside) {
    for (const [x, y] of probePoints(rect)) {
      const node = hit(x, y);
      if (node && !inside(node)) return true;
    }
    return false;
  }

  // The view's bounds key: moved only when it changes.
  function rectKey(r) {
    return r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v)).join(',') : '';
  }

  // Select element's word before it starts: '' when the page can be picked from.
  function pickBlocked(url) {
    const u = String(url || '');
    if (isLocalUrl(u) || /^file:\/\//i.test(u)) return '';
    return NOT_LOCAL;
  }

  // The banner's words: who is using the browser, and how.
  function agentWords(activity, titleOf = () => '') {
    if (!activity) return '';
    const who = activity.session ? titleOf(activity.session) : '';
    const what = activity.kind === 'check' ? 'Eden is checking its work in a hidden preview' : 'Eden is using the browser';
    return who ? `${what} · ${who}` : what;
  }

  const api = {
    hostOf, isLocalUrl, fieldText, addressKind, tabTitle, sessionOf, blankish, devOffer, paneWidth,
    probePoints, covered, rectKey, pickBlocked, agentWords, HELD, NOT_LOCAL, NO_APP, ACTIVE_MS, MIN_W, MAIN_MIN,
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const browser = () => (root.jarvisApp && root.jarvisApp.browser && root.jarvisApp.browser.place ? root.jarvisApp.browser : null);
  const inCode = () => document.body.dataset.app === 'eden-code' || document.body.classList.contains('eden-code');
  const paneEl = () => F.$('jc-pane');
  const shownNow = () => { const p = paneEl(); return Boolean(p && !p.hidden && p.dataset.kind === 'browser'); };

  function note(text) {
    if (typeof jcNote === 'function') jcNote(t(text));
    const a11y = root.jarvisAccessibility;
    if (a11y && a11y.announce) a11y.announce(t(text));
  }

  const ICON = {
    back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
    forward: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    reload: '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2"/><path d="M12.5 2.8v2.6H9.9"/>',
    stop: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    pick: '<path d="M3 3l4.2 10 1.4-4.4L13 7.2z"/><path d="M9 9l3.5 3.5"/>',
    out: '<path d="M9.5 3H13v3.5"/><path d="M13 3L7.5 8.5"/><path d="M11.5 9.5V13H3V4.5h3.5"/>',
    tools: '<path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    close: '<path d="M5 5l6 6M11 5l-6 6"/>',
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.2 3.5 2.2 5.5S9.6 11.9 8 13.5C6.4 11.9 5.8 10 5.8 8S6.4 4.1 8 2.5z"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
    lock: '<rect x="4" y="7" width="8" height="6" rx="1.5"/><path d="M5.8 7V5.5a2.2 2.2 0 0 1 4.4 0V7"/>',
  };
  function icon(name, size = 15) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICON[name];
    return s;
  }
  function tool(name, label, run) {
    const b = el('button', 'cb-btn');
    b.type = 'button';
    b.title = t(label);
    b.setAttribute('aria-label', t(label));
    b.append(icon(name));
    b.addEventListener('click', run);
    return b;
  }

  // ── state ──

  const S = {
    st: {},  // the app's browser:state
    root: null, parts: null,
    placed: '', parked: false, parking: null, loop: 0, dragging: false,
    project: '', configs: [], servers: [], autoOpened: new Set(), wantOpen: '',
    activity: null, held: false, inflight: 0, peekAt: 0, peekTimer: 0, picking: false, devtools: false,
  };

  function titleOf(id) {
    const list = typeof ccTasks !== 'undefined' && Array.isArray(ccTasks) ? ccTasks : [];
    const task = list.find((x) => x.id === id);
    return task ? String(task.title || task.prompt || `Session ${id}`).slice(0, 60) : `Session ${id}`;
  }

  // ── the pane ──

  function build() {
    const box = el('div', 'cb');
    const tabs = el('div', 'cb-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', t('Tabs'));
    const newTab = tool('plus', 'New tab', () => { const b = browser(); if (b) b.tab('new'); });
    newTab.classList.add('cb-newtab');
    const strip = el('div', 'cb-strip');
    strip.append(tabs, newTab);

    const bar = el('form', 'cb-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('Browser'));
    const back = tool('back', 'Back', () => { const b = browser(); if (b) b.nav('back'); });
    const fwd = tool('forward', 'Forward', () => { const b = browser(); if (b) b.nav('forward'); });
    const reload = tool('reload', 'Reload', () => { const b = browser(); if (b) b.nav(S.st.loading ? 'stop' : 'reload'); });
    const field = el('label', 'cb-field');
    const kind = el('span', 'cb-kind');
    kind.append(icon('globe', 13));
    const input = mine(el('input', 'cb-url'));
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = t('Search or enter an address');
    input.setAttribute('aria-label', t('Address'));
    field.append(kind, input);
    const pick = tool('pick', 'Select element: send it with your next message', () => selectElement());
    pick.classList.add('cb-pick');
    pick.setAttribute('aria-pressed', 'false');
    const out = tool('out', 'Open in your default browser', () => { const b = browser(); if (b && b.external) b.external(); });
    const tools = tool('tools', 'Developer tools', async () => {
      const b = browser();
      if (!b || !b.devtools) return;
      S.devtools = Boolean(await b.devtools());
      tools.setAttribute('aria-pressed', String(S.devtools));
    });
    tools.setAttribute('aria-pressed', 'false');
    bar.append(back, fwd, reload, field, pick, out, tools);
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      const b = browser();
      if (!text || !b) return;
      b.nav('go', text);
      input.blur();
    });
    input.addEventListener('input', () => setKind(addressKind(input.value)));
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = fieldText(S.st.url); setKind(addressKind(input.value)); input.blur(); }
    });
    function setKind(k) {
      kind.replaceChildren(icon(k === 'search' ? 'search' : /^https:/.test(S.st.url || '') && document.activeElement !== input ? 'lock' : 'globe', 13));
    }

    const progress = el('div', 'cb-progress');
    progress.hidden = true;

    const offer = el('div', 'cb-offer');
    offer.hidden = true;

    const agent = el('div', 'cb-agent');
    agent.hidden = true;
    agent.setAttribute('role', 'status');
    const agentPic = el('img', 'cb-agent-pic');
    agentPic.alt = '';
    agentPic.hidden = true;
    const agentText = el('div', 'cb-agent-text');
    const agentWhat = el('strong');
    const agentWhere = mine(el('small'));
    agentText.append(agentWhat, agentWhere);
    const take = el('button', 'jc-mini cb-take', 'Take over');
    take.type = 'button';
    take.addEventListener('click', takeOver);
    const give = el('button', 'jc-mini cb-give', 'Hand back');
    give.type = 'button';
    give.addEventListener('click', handBack);
    agent.append(el('span', 'cb-agent-dot'), agentPic, agentText, take, give);

    const msg = el('div', 'cb-msg');
    msg.hidden = true;
    const msgText = mine(el('span'));
    const retry = el('button', 'jc-mini', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => { msg.hidden = true; const b = browser(); if (b) b.nav('reload'); });
    msg.append(msgText, retry);

    const stage = el('div', 'cb-stage');
    const slot = el('div', 'cb-slot');
    const snap = el('img', 'cb-snap');
    snap.alt = '';
    snap.hidden = true;
    const empty = el('p', 'cb-empty', '');
    empty.hidden = true;
    slot.append(snap, empty);
    stage.append(slot);

    box.append(strip, bar, progress, agent, offer, msg, stage);
    S.parts = { box, tabs, back, fwd, reload, input, setKind, pick, tools, progress, offer, agent, agentPic, agentWhat, agentWhere, take, give, msg, msgText, stage, slot, snap, empty };
    return box;
  }

  function render(body) {
    hookApp();  // (idempotent: an app bridge that came late)
    if (!S.root) S.root = build();
    body.replaceChildren(S.root);
    ensureHandle();
    applyWidth();
    const b = browser();
    const { empty, slot } = S.parts;
    if (!b) {
      empty.textContent = t(NO_APP);
      empty.hidden = false;
      slot.classList.add('cb-noapp');
    } else {
      empty.hidden = true;
      slot.classList.remove('cb-noapp');
    }
    askServers();
    drawAll();
    startLoop();
  }

  function drawAll() {
    drawState();
    drawOffer();
    drawAgent();
  }

  function drawState() {
    if (!S.parts) return;
    const st = S.st || {};
    const p = S.parts;
    p.back.disabled = !st.canBack;
    p.fwd.disabled = !st.canForward;
    p.reload.replaceChildren(icon(st.loading ? 'stop' : 'reload'));
    p.reload.title = t(st.loading ? 'Stop' : 'Reload');
    p.reload.setAttribute('aria-label', p.reload.title);
    p.progress.hidden = !st.loading;
    if (document.activeElement !== p.input) p.input.value = fieldText(st.url);
    p.setKind(addressKind(p.input.value));
    const blocked = pickBlocked(st.url);
    p.pick.classList.toggle('cb-off', Boolean(blocked));
    p.pick.title = t(blocked || 'Select element: send it with your next message');
    p.pick.setAttribute('aria-pressed', String(S.picking));
    p.tools.setAttribute('aria-pressed', String(S.devtools));
    if (st.error) { p.msgText.textContent = String(st.error); p.msg.hidden = false; } else if (!st.loading) p.msg.hidden = true;
    drawTabs(st.tabs || []);
  }

  let tabsKey = '';
  function drawTabs(list) {
    const shown = list.filter((x) => !x.popout);
    const key = JSON.stringify(shown.map((x) => [x.id, x.title, x.url, x.active, x.loading, x.owner, (x.favicon || '').length, x.private]));
    if (key === tabsKey) return;
    tabsKey = key;
    const { tabs } = S.parts;
    tabs.replaceChildren(...shown.map((tab) => {
      const item = el('div', `cb-tab${tab.active ? ' on' : ''}${tab.loading ? ' loading' : ''}`);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(Boolean(tab.active)));
      item.tabIndex = tab.active ? 0 : -1;
      const name = tabTitle(tab);
      item.title = tab.url ? `${name}\n${tab.url}` : name;
      if (tab.favicon && /^data:image\//.test(tab.favicon)) {
        const img = el('img', 'cb-fav');
        img.src = tab.favicon;
        img.alt = '';
        item.append(img);
      } else item.append(icon('globe', 12));
      item.append(mine(el('span', 'cb-tab-name', name === 'New tab' ? t(name) : name)));
      const session = sessionOf(tab.owner);
      if (session) {
        const badge = el('span', 'cb-tab-agent', 'Eden');
        badge.title = `${t('Opened by')} ${titleOf(session)}`;
        item.append(badge);
      }
      const x = el('button', 'cb-tab-x');
      x.type = 'button';
      x.setAttribute('aria-label', t('Close tab'));
      x.title = t('Close tab');
      x.append(icon('close', 11));
      x.addEventListener('click', (e) => { e.stopPropagation(); const b = browser(); if (b) b.tab('close', tab.id); });
      if (shown.length > 1) item.append(x);
      item.addEventListener('click', () => { const b = browser(); if (b && !tab.active) b.tab('select', tab.id); });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const at = shown.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
          const next = shown[(at + shown.length) % shown.length];
          const b = browser();
          if (b && next) b.tab('select', next.id);
        }
      });
      item.addEventListener('auxclick', (e) => { if (e.button === 1 && shown.length > 1) { const b = browser(); if (b) b.tab('close', tab.id); } });
      return item;
    }));
  }

  // ── the native view over the slot ──

  function slotRect() {
    const r = S.parts.slot.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function overlayOver(rect) {
    const slot = S.parts.slot;
    return covered(rect, (x, y) => document.elementFromPoint(x, y), (node) => node === slot || slot.contains(node));
  }

  async function park() {
    const b = browser();
    if (!b || S.parked) return;
    S.parked = true;
    S.placed = '';
    const picture = await (S.parking = b.park().catch(() => ''));
    S.parking = null;
    if (!S.parts) return;
    if (picture && S.parked) { S.parts.snap.src = picture; S.parts.snap.hidden = false; }
  }

  async function place(rect) {
    const b = browser();
    if (!b) return;
    if (S.parking) await S.parking;  // (a park on its way: after it)
    const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    const key = rectKey(bounds);
    if (key === S.placed && !S.parked) return;
    S.placed = key;
    S.parked = false;
    await b.place(bounds);
    if (S.parts && !S.parked) S.parts.snap.hidden = true;
  }

  function hideView() {
    stopLoop();
    S.placed = '';
    S.parked = false;
    if (S.parts) S.parts.snap.hidden = true;
    const b = browser();
    if (b) b.hide();
  }

  function startLoop() {
    if (S.loop || !browser()) return;
    const tick = () => {
      S.loop = 0;
      if (!shownNow() || !S.parts || !S.parts.box.isConnected) { hideView(); return; }
      const rect = slotRect();
      const off = S.dragging || document.hidden || rect.width < 8 || rect.height < 8 || overlayOver(rect);
      if (off) park(); else place(rect);
      S.loop = requestAnimationFrame(tick);
    };
    S.loop = requestAnimationFrame(tick);
  }
  function stopLoop() { if (S.loop) cancelAnimationFrame(S.loop); S.loop = 0; }

  // The pane closed, or another took its place: the view comes off.
  function watchPane() {
    const pane = paneEl();
    if (!pane) return;
    new MutationObserver(() => {
      if (!shownNow()) { if (S.loop || S.placed) hideView(); document.body.classList.remove('cb-page-full'); } else startLoop();
    }).observe(pane, { attributes: true, attributeFilter: ['hidden', 'data-kind'] });
  }

  // ── width: half the window by default, the left edge dragged to change it ──

  function savedWidth() { try { return Number(localStorage.getItem(WIDTH_KEY)) || 0; } catch (_) { return 0; } }
  function applyWidth(px) {
    const w = paneWidth(px || savedWidth(), window.innerWidth);
    document.body.style.setProperty('--cb-w', `${w}px`);
    return w;
  }
  function ensureHandle() {
    const pane = paneEl();
    if (!pane || pane.querySelector('.cb-resize')) return;
    const handle = el('div', 'cb-resize');
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', t('Resize the browser'));
    handle.tabIndex = 0;
    let startX = 0;
    let startW = 0;
    handle.addEventListener('pointerdown', (e) => {
      S.dragging = true;  // the view steps aside: it would swallow the pointer as the drag crosses it
      startX = e.clientX;
      startW = pane.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('cb-resizing');
    });
    handle.addEventListener('pointermove', (e) => { if (S.dragging) applyWidth(startW + (startX - e.clientX)); });
    const end = () => {
      if (!S.dragging) return;
      S.dragging = false;
      document.body.classList.remove('cb-resizing');
      const w = pane.getBoundingClientRect().width;
      try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch (_) { /* private mode */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const w = applyWidth(pane.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 40 : -40));
      try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (_) { /* private mode */ }
    });
    pane.append(handle);
  }
  window.addEventListener('resize', () => { if (shownNow()) applyWidth(); });

  // ── dev servers ──

  function where() {
    const task = F.currentTask();
    if (task) return { id: task.id };
    const project = typeof deckProject !== 'undefined' ? deckProject : '';
    return project ? { directory: project } : null;
  }
  function askServers() {
    const w = where();
    if (w) F.send({ type: 'cv_state', ...w });
  }
  function forShown(ev) {
    const task = F.currentTask();
    return task ? ev.id === task.id : !ev.id && ev.project === (typeof deckProject !== 'undefined' ? deckProject : '');
  }

  function drawOffer() {
    if (!S.parts) return;
    const o = devOffer({ servers: S.servers, configs: S.configs, project: S.project, shown: S.st.url || '' });
    const box = S.parts.offer;
    if (!o) { box.hidden = true; return; }
    // Opened by itself over an empty tab or the start page, once per server.
    if (o.kind === 'open' && browser() && shownNow() && (blankish(S.st.url) || S.wantOpen === o.name) && !S.autoOpened.has(o.key)) {
      S.autoOpened.add(o.key);
      S.wantOpen = '';
      browser().nav('go', o.url);
      box.hidden = true;
      return;
    }
    const dot = el('span', `jc-dot ${o.kind === 'start' ? '' : o.kind === 'starting' ? 'busy' : 'live'}`);
    const words = el('span', 'cb-offer-text');
    let action = null;
    if (o.kind === 'open') {
      words.append(mine(el('strong', '', o.name)), document.createTextNode(` ${t('is running at')} `), mine(el('code', '', o.url.replace(/^https?:\/\//, ''))));
      action = el('button', 'jc-mini', 'Open');
      action.addEventListener('click', () => { const b = browser(); if (b) b.nav('go', o.url); });
    } else if (o.kind === 'starting') {
      words.append(mine(el('strong', '', o.name)), document.createTextNode(` ${t('is starting…')}`));
    } else {
      words.append(document.createTextNode(`${t('Dev server')} `), mine(el('strong', '', o.name)), document.createTextNode(` ${t('isn’t running.')}`));
      action = el('button', 'jc-mini', 'Start');
      action.addEventListener('click', () => {
        const w = where();
        if (!w) return;
        S.wantOpen = o.name;
        F.send({ type: 'cv_server', action: 'start', name: o.name, ...w });
        action.disabled = true;
      });
    }
    box.replaceChildren(dot, words);
    if (action) { action.type = 'button'; box.append(action); }
    box.hidden = false;
  }

  F.on('cv_state', (ev) => {
    if (!forShown(ev) || ev.error) return;
    S.project = ev.path || '';
    S.configs = Array.isArray(ev.configs) ? ev.configs : [];
    if (Array.isArray(ev.servers)) S.servers = S.servers.filter((s) => s.project !== ev.path).concat(ev.servers);
    drawOffer();
  });
  F.on('devservers', (ev) => { S.servers = Array.isArray(ev.items) ? ev.items : []; drawOffer(); });

  // ── watching the agent ──

  function activityOn(kind, owner, session, url) {
    S.activity = { kind, owner, session, url: url || (S.activity && S.activity.owner === owner ? S.activity.url : ''), at: Date.now() };
    drawAgent();
    clearTimeout(S.activityTimer);
    S.activityTimer = setTimeout(() => { if (!S.inflight && !S.held) { S.activity = null; drawAgent(); } }, ACTIVE_MS + 50);
  }

  function drawAgent() {
    const btn = F.$('jc-browser');
    const busy = Boolean(S.activity) && (S.inflight > 0 || Date.now() - S.activity.at < ACTIVE_MS);
    if (btn) btn.classList.toggle('cb-busy', busy || S.held);
    if (!S.parts) return;
    const p = S.parts;
    const a = S.activity;
    if (!a && !S.held) { p.agent.hidden = true; return; }
    p.agent.hidden = false;
    p.agent.classList.toggle('held', S.held);
    p.agentWhat.textContent = S.held ? t('You have the browser. Eden waits until you hand it back.') : t(agentWords(a).split(' · ')[0]);
    p.agentWhere.textContent = a ? [a.session ? titleOf(a.session) : '', a.url ? a.url.replace(/^https?:\/\//, '') : ''].filter(Boolean).join(' · ') : '';
    p.take.hidden = S.held || !a;
    p.give.hidden = !S.held;
    p.agentPic.hidden = !(a && a.kind === 'check' && a.pic);
    if (a && a.pic) p.agentPic.src = a.pic;
  }

  function takeOver() {
    S.held = true;
    const a = S.activity;
    // A check's hidden preview: its page opened here, for the owner's own hands.
    if (a && a.kind === 'check' && a.url && isLocalUrl(a.url)) { const b = browser(); if (b) b.tab('new', undefined, a.url); }
    drawAgent();
    note('You have the browser. Eden’s browser steps wait until you hand it back.');
  }
  function handBack() {
    S.held = false;
    drawAgent();
    note('Handed back: Eden can use the browser again.');
  }

  // app.js runBrowserCommand: a session's browser tool, before it runs ('' to go ahead, or
  // the words it's answered with while the owner has the browser) and after.
  const LOOKS = new Set(['tabs']);
  function agentStart(ev) {
    const args = (ev && ev.args) || {};
    if (!inCode()) return '';  // (Eden Secretary's dock has its own)
    if (S.held) return HELD;
    if (LOOKS.has(ev.action) || args.op === 'list') return '';
    S.inflight += 1;
    activityOn('tab', String(args.owner || ''), sessionOf(args.owner), '');
    return '';
  }
  function agentEnd(ev, result) {
    const args = (ev && ev.args) || {};
    if (!inCode()) return;
    if (LOOKS.has(ev.action) || args.op === 'list') return;
    S.inflight = Math.max(0, S.inflight - 1);
    activityOn('tab', String(args.owner || ''), sessionOf(args.owner), result && result.url ? String(result.url) : (S.st.url || ''));
  }

  // code-selfcheck.js: a session's "Check it yourself" step in its hidden preview.
  function checkStart(ev) {
    if (S.held) return HELD;
    if (ev.action === 'close') { if (S.activity && S.activity.kind === 'check') { S.activity = null; drawAgent(); } return ''; }
    S.inflight += 1;
    activityOn('check', `selfcheck:${ev.session}`, Number(ev.session) || null, '');
    return '';
  }
  function checkEnd(ev, result) {
    if (ev.action === 'close') return;
    S.inflight = Math.max(0, S.inflight - 1);
    activityOn('check', `selfcheck:${ev.session}`, Number(ev.session) || null, result && result.url ? String(result.url) : '');
    peekSoon(ev.session);
  }
  function peekSoon(session) {
    const feature = root.jarvisApp && root.jarvisApp.feature;
    if (!feature || S.peekTimer) return;
    const wait = Math.max(0, PEEK_MS - (Date.now() - S.peekAt));
    S.peekTimer = setTimeout(async () => {
      S.peekTimer = 0;
      S.peekAt = Date.now();
      let r = null;
      try { r = await feature.invoke('feature:self-check:peek', { session }); } catch (_) { r = null; }
      if (!r || !r.ok || !S.activity || S.activity.kind !== 'check') return;
      if (r.jpeg && /^[A-Za-z0-9+/]+={0,2}$/.test(r.jpeg)) S.activity.pic = `data:image/jpeg;base64,${r.jpeg}`;
      if (r.url) S.activity.url = r.url;
      drawAgent();
    }, wait);
  }

  // ── point and tell ──

  async function selectElement() {
    const pick = root.jarvisCodePick;
    if (!pick || !pick.available()) { note(NO_APP); return; }
    const blocked = pickBlocked(S.st.url);
    if (blocked && !S.picking) { note(blocked); return; }
    if (S.picking) { pick.start(); return; }  // (a second press gives up)
    S.picking = true;
    drawState();
    try { await pick.start(); } finally { S.picking = false; drawState(); }
  }

  // ── the app's browser, heard ──

  function hookApp() {
    const b = browser();
    if (!b || hookApp.done) return;
    hookApp.done = true;
    b.onState((st) => { S.st = st || {}; drawState(); drawOffer(); });
    b.onPageFullscreen((on) => { if (shownNow()) document.body.classList.toggle('cb-page-full', Boolean(on)); });
  }

  // A key the page sent (main.js browserShortcut), while the pane is the browser on show.
  function key(action) {
    if (!S.parts) return;
    if (action === 'address') { S.parts.input.focus(); S.parts.input.select(); }
    if (action === 'close' && typeof closePane === 'function') closePane();
  }

  function toggle() {
    if (shownNow()) { if (typeof closePane === 'function') closePane(); } else F.openPane('browser');
  }

  F.registerPane('browser', { title: 'Browser', render: (body) => render(body) });
  root.jarvisCodeBrowser = { agentStart, agentEnd, checkStart, checkEnd, key, toggle, open: (url) => { F.openPane('browser'); const b = browser(); if (b && url) b.nav('go', url); } };

  // The globe only where there's a browser to show (the app); a window in a web browser has none.
  function showButton() {
    const btn = F.$('jc-browser');
    if (btn && inCode()) btn.hidden = !browser();
  }
  showButton();
  hookApp();
  watchPane();
  // ⌥⌘B: the Browser pane (⇧⌘B is the Agent board's).
  document.addEventListener('keydown', (e) => {
    if (!inCode() || !browser() || (F.$('cc') && F.$('cc').hidden)) return;
    if (e.code === 'KeyB' && e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); toggle(); }
  });
  F.on('jc_select', () => { if (shownNow()) { askServers(); drawAgent(); } });
  F.on('hello', () => { if (shownNow()) askServers(); });
})(typeof window === 'object' ? window : globalThis);
