// Eden Code's Browser pane: the built-in browser in Eden Code's own window, as a workbench
// pane beside the conversation (the title bar's globe, ⌥⌘B), the same as Terminal and Changes.
// - The engine is the app's (app/main.js): its tabs, ad blocker, per-site permissions,
//   downloads and sign-ins, in Eden Code's own profile. The page is a native view laid over
//   the pane's slot (edenCodeApp.browser.place), so it goes where it's told: the slot is watched
//   every frame while the pane is open (a window resized, full screen, the pane dragged wider)
//   and the view is moved, or taken off when the pane closes or another pane takes its place.
// - A native view is drawn above every element of the page, so when anything of the page lies
//   over the slot (a menu, a dialog, Settings, a picture shown larger: whatever
//   elementFromPoint finds there that isn't the slot) the view steps aside (park) and a
//   picture of it stands in for it until the slot is clear again.
// - As the Claude desktop app's browser: tabs (+, ×, dragged into order, their own menu, a
//   middle click closes; ⌘T, ⌘W, ⌘⇧T, ⌘1–9, ⌃Tab), back and forward (held: the tab's
//   history), reload and stop, the address (suggestions from the open tabs, bookmarks and
//   history, completed inline; its icon says secure, not secure, this Mac or a file, and is
//   the site's settings), find in page (⌘F, "2 of 9"), zoom per site (⌘+ ⌘- ⌘0, a badge to
//   reset), downloads (Save first, then progress, Open, Show in Finder), a site's requests
//   and sign-ins (features/browser.js's strip, shown here), DevTools docked under the page or
//   in a window, and the ⋯ menu: a private tab, a screenshot (on your message, to Downloads,
//   copied), sizes (Desktop, Tablet, Phone), light or dark, the console and requests (what
//   the agent reads), the page's source, zoom, find, print, save as PDF, the default browser.
//   The app side of these is app/browser-pane.js; the page's own keys come through main.js.
// - Full screen, as the old dock had it (the toolbar's last button, ⌃⌘F from anywhere in the
//   window): the browser takes the window, its tabs, toolbar, find and downloads kept, its top
//   clear of the window's buttons. Esc leaves it first, from the window and from the page; Esc
//   in the pane closes its own lists and panels, then full screen, then the browser, and never
//   reaches the conversation (where it would stop a session at work). A page's own full screen
//   (a video) hides the chrome too, and ending it puts back what was there before.
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
    // the corners too, a few pixels in (a menu opening at the slot's edge), and along each
    // edge a little in: a list hanging just over the slot's top (the address's suggestions)
    // or a toast at its side reaches only that far in
    const k = 4;
    pts.push([rect.left + k, rect.top + k], [rect.right - k, rect.top + k], [rect.left + k, rect.bottom - k], [rect.right - k, rect.bottom - k]);
    const e = 14;
    for (let i = 0; i < n * 2; i += 1) {
      const x = rect.left + ((i + 0.5) * rect.width) / (n * 2);
      const y = rect.top + ((i + 0.5) * rect.height) / (n * 2);
      pts.push([x, rect.top + e], [x, rect.bottom - e], [rect.left + e, y], [rect.right - e, y]);
    }
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

  // What the address's icon says about the page: a secure connection (https), one that isn't
  // (http off this Mac), the app being built (a page on this Mac), a file, or a site whose
  // certificate warning the owner went past (browser-parity.js site-state: unsafe).
  function security(url, unsafe = false) {
    let u = String(url || '');
    if (/^view-source:/i.test(u)) u = u.slice(12);
    if (!u || u === 'about:blank') return { kind: 'none', label: '' };
    if (unsafe) return { kind: 'unsafe', label: 'Not secure: you continued past a certificate warning on this site' };
    if (/^https:/i.test(u)) return { kind: 'secure', label: 'Connection is secure' };
    if (/^http:/i.test(u)) return isLocalUrl(u) ? { kind: 'local', label: 'A page on this Mac' } : { kind: 'insecure', label: 'Not secure: this site doesn’t use https' };
    if (/^file:/i.test(u)) return { kind: 'file', label: 'A file on this Mac' };
    return { kind: 'none', label: '' };
  }

  // An address without its scheme and www., as the suggestions are matched and completed.
  function bare(url) {
    return String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  }

  // Inline completion, as Chrome's address bar: what's typed, finished from the first
  // suggestion (an open tab, a bookmark, history) whose address starts with it: its site
  // while the typing is within the site's name, else the whole address. '' when none fits
  // (words with spaces are a search, never completed).
  function inlineCompletion(typed, rows = []) {
    const text = String(typed || '');
    if (!text || /\s/.test(text) || /^[a-z]+:\/\//i.test(text)) return '';
    const want = text.toLowerCase().replace(/^www\./, '');
    for (const row of rows) {
      if (!row || !row.url || !/^https?:/i.test(row.url)) continue;
      const b = bare(row.url);
      if (!b.toLowerCase().startsWith(want)) continue;
      const site = b.split('/')[0];
      const full = want.length <= site.length ? site : b;
      if (full.length <= want.length) return '';
      return text + full.slice(want.length);
    }
    return '';
  }

  // The size presets for testing a page (as the Claude desktop app's): the page laid out at
  // a tablet's or a phone's width and height, shown zoomed down to fit the pane when it's
  // smaller. Desktop is the pane itself.
  const PRESETS = {
    desktop: null,
    tablet: { w: 768, h: 1024, label: 'Tablet' },
    phone: { w: 375, h: 812, label: 'Phone' },
  };
  // A preset's place in the slot (centred, a little in from the edges) and the zoom that fits
  // its page there: the view is width × height on screen, and its page lays out at w × h CSS
  // pixels (width / fit). null for Desktop (the whole slot, the page's own zoom).
  function presetRect(rect, preset, pad = 12) {
    const p = PRESETS[preset];
    if (!p || !rect) return null;
    const label = 24;  // (room under it for the size's label)
    const room = { w: Math.max(1, rect.width - pad * 2), h: Math.max(1, rect.height - pad - label) };
    const width = Math.max(1, Math.floor(p.w * Math.min(1, room.w / p.w, room.h / p.h)));
    const fit = width / p.w;  // exactly: the page lays out at p.w CSS pixels, not one short
    const height = Math.max(1, Math.round(p.h * fit));
    return { left: Math.round(rect.left + (rect.width - width) / 2), top: Math.round(rect.top + pad), width, height, fit };
  }

  // Find in page: "2 of 9", or "No matches" once something's typed.
  function findLabel(r, typed) {
    if (!typed) return '';
    const n = Number(r && r.matches) || 0;
    return n ? `${Number(r.active) || 1} of ${n}` : 'No matches';
  }

  function fileSize(n) {
    const v = Number(n) || 0;
    if (!v) return '';
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(v / 1e3))} KB`;
  }

  // A download's line under its name (main.js sendDownload: asking, progressing, completed,
  // cancelled, interrupted), and how far along it is (0–1, or null when not known).
  function downloadNote(d) {
    const size = fileSize(d && d.total);
    switch (d && d.state) {
      case 'asking': return `${d.from ? `From ${d.from}` : 'Download'}${size ? ` · ${size}` : ''} · Save it?`;
      case 'progressing': return `${fileSize(d.received) || '0 KB'}${size ? ` of ${size}` : ''}`;
      case 'completed': return `Saved to Downloads${size ? ` · ${size}` : ''}`;
      case 'cancelled': return 'Cancelled';
      default: return 'Didn’t finish';
    }
  }
  function downloadShare(d) {
    if (!d || d.state !== 'progressing' || !Number(d.total)) return d && d.state === 'completed' ? 1 : null;
    return Math.max(0, Math.min(1, Number(d.received) / Number(d.total)));
  }

  // The console's and the requests' rows for the drawer (browser-cdp.js's entries: what
  // browser_console and browser_network give a session).
  function logRows(kind, entries = []) {
    const rows = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e) continue;
      if (kind === 'network') {
        if (/^data:/i.test(String(e.url || ''))) continue;  // (a page's inline pictures: not requests anyone looks for)
        const status = e.failed ? String(e.failed) : e.status ? String(e.status) : e.done ? '' : '…';
        const bad = Boolean(e.failed) || Number(e.status) >= 400;
        rows.push({ level: bad ? 'error' : 'info', head: `${e.method || 'GET'} ${status}`.trim(), text: String(e.url || ''), meta: [e.type, e.ms !== undefined ? `${e.ms} ms` : ''].filter(Boolean).join(' · ') });
      } else {
        const level = ['error', 'warning'].includes(e.level) ? e.level : 'info';
        rows.push({ level, head: level === 'info' ? String(e.level || 'log') : level, text: String(e.text || ''), meta: e.url ? `${String(e.url).replace(/^https?:\/\//, '')}${e.line ? `:${e.line}` : ''}` : '' });
      }
    }
    return rows;
  }

  // A key the window hears for the browser (the page's own come from the app as
  // browser:shortcut): the same keys as Chrome's and the Claude app's. ⌘ on a Mac is Ctrl
  // elsewhere (mac false), and ⌃⌘F's ⌃ is then the Windows key, as app.js's cmd() and other().
  function keyAction(e, mac = true) {
    if (!e) return '';
    const key = String(e.key || '').toLowerCase();
    const cmd = Boolean(mac ? e.metaKey : e.ctrlKey);
    const other = Boolean(mac ? e.ctrlKey : e.metaKey);
    if (e.ctrlKey && !e.metaKey && !e.altKey && key === 'tab') return e.shiftKey ? 'previous' : 'next';
    if (!cmd) return '';
    if (other) return key === 'f' || e.code === 'KeyF' ? 'full' : '';
    if (e.altKey) return key === 'i' || e.code === 'KeyI' ? 'devtools' : '';
    if (e.shiftKey) {
      if (key === 't') return 'reopen';
      if (key === 'a' || e.code === 'KeyA') return 'tab-search';
      if (key === 'n' || e.code === 'KeyN') return 'private-tab';
      if (key === '[' || key === '{') return 'previous';
      if (key === ']' || key === '}') return 'next';
      return '';
    }
    const plain = { t: 'new-tab', w: 'close-tab', l: 'address', f: 'find', d: 'bookmark', y: 'history', r: 'reload', '[': 'back', ']': 'forward', p: 'print', '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset' };
    if (plain[key]) return plain[key];
    if (/^[1-9]$/.test(key)) return `tab${key}`;
    return '';
  }

  // Where the window hears a browser key while the pane is open, as the old dock did: 'any'
  // from anywhere, even typing in a field of the window's own (⌘T, ⌘W, ⌃Tab, ⌃⌘F, ⌥⌘I, ⇧⌘T,
  // ⇧⌘[ ⇧⌘], ⇧⌘N); 'window' from anywhere but such a field (⌘L, ⌘D, ⌘Y, ⌘R, ⌘[ ⌘], ⌘P, zoom);
  // 'pane' only while the pane has the keyboard, since Eden Code has the same keys for itself
  // (⌘F finds in the conversation, ⇧⌘A is Needs attention, ⌘1–6 are split view's panes).
  const ANY_KEYS = new Set(['new-tab', 'close-tab', 'next', 'previous', 'full', 'devtools', 'reopen', 'private-tab']);
  function keyWhere(action) {
    if (action === 'find' || action === 'tab-search' || /^tab[1-9]$/.test(action)) return 'pane';
    return ANY_KEYS.has(action) ? 'any' : 'window';
  }
  // Whether the browser takes a key: pressed in the pane, any of its; elsewhere, by keyWhere.
  function keyHeard(action, { inPane = false, typing = false } = {}) {
    if (!action) return false;
    if (inPane) return true;
    const where = keyWhere(action);
    return where === 'any' || (where === 'window' && !typing);
  }

  // Tab search (⇧⌘A): every word typed is in the tab's title or address (features/browser.js tabMatches).
  function tabMatches(tab, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${(tab && tab.title) || ''} ${String((tab && tab.url) || '').replace(/^[a-z]+:\/\/(www\.)?/i, '')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  // Every folder the bookmarks are in, and the folders those are in, sorted ("Work",
  // "Work/Reading"); and how many bookmarks each holds, its subfolders' too (features/browser.js folderTree).
  function folderTree(bookmarks) {
    const counts = new Map();
    for (const b of bookmarks || []) {
      const parts = String((b && b.folder) || '').split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        counts.set(path, (counts.get(path) || 0) + 1);
      }
    }
    return [...counts.keys()].sort((a, b) => a.localeCompare(b)).map((path) => ({ path, count: counts.get(path), depth: path.split('/').length - 1 }));
  }

  // ★ lit: the page on show is one of the bookmarks.
  function bookmarked(bookmarks, url) {
    const u = String(url || '');
    return /^https?:/i.test(u) && (bookmarks || []).some((b) => b && b.url === u);
  }

  // The ad-block shield in the address (main.js's st.shields): on a web page only, lit while
  // blocking there, with how many it blocked; its tooltip says what a click and an ⌥-click do.
  function shieldView(sh, url, tr = (x) => x) {
    if (!sh || !sh.ready || sh.research || !/^https?:/i.test(String(url || ''))) return { hidden: true, pressed: false, count: '', title: '' };
    const on = Boolean(sh.on && !sh.allowed);
    const n = Math.max(0, Number(sh.blocked) || 0);
    const site = String(sh.site || '');
    const title = !sh.on ? tr('Ad blocking is off everywhere · ⌥-click to turn it on')
      : sh.allowed ? `${tr('Ads allowed on')} ${site} · ${tr('click to block them again')}`
        : `${n} ${tr('ads and trackers blocked on this page')} · ${tr('click to allow them on')} ${site} · ${tr('⌥-click: off everywhere')}`;
    return { hidden: false, pressed: on, count: on && n ? (n > 999 ? '999+' : String(n)) : '', title };
  }

  // What "Send errors to chat" puts on the message: the console's errors and the requests that
  // failed, on the page on show ('' when there are none). The page's own words: they go as a
  // document on the message, never as the owner's.
  function errorReport(url, consoleEntries = [], networkEntries = [], limit = 40) {
    const errors = logRows('console', consoleEntries).filter((r) => r.level === 'error').slice(-limit);
    const failed = logRows('network', networkEntries).filter((r) => r.level === 'error').slice(-limit);
    if (!errors.length && !failed.length) return '';
    const lines = [`Errors in the browser on ${String(url || '') || 'the page'}`];
    if (errors.length) lines.push('', 'Console:', ...errors.map((r) => `${r.text}${r.meta ? ` (${r.meta})` : ''}`));
    if (failed.length) lines.push('', 'Failed requests:', ...failed.map((r) => `${r.head} ${r.text}`));
    return lines.join('\n');
  }

  // The ⋯ menu's rows (app/browser-pane-lib.js menuTemplate shows them natively and answers
  // with the id picked), with the pane's state checked. tr: the window's translator. What the
  // toolbar drops when the pane is narrow (bookmarks, history, the console) is here too.
  function menuSpec(st = {}, view = {}, tr = (x) => x) {
    const pane = st.pane || {};
    const web = /^https?:/i.test(String(st.url || ''));
    const page = Boolean(st.url) && st.url !== 'about:blank';
    const radio = (id, label, checked) => ({ id, label: tr(label), type: 'radio', checked });
    return [
      { id: 'private', label: tr('New private tab') },
      { id: 'tab-search', label: tr('Search tabs…') },
      { id: 'bookmarks', label: tr('Bookmarks'), type: 'checkbox', checked: view.panel === 'bookmarks' },
      { id: 'history', label: tr('History'), type: 'checkbox', checked: view.panel === 'history' },
      { type: 'separator' },
      { id: 'split', label: tr(view.split ? 'Close split view' : 'Split view') },
      { id: 'popout', label: tr('Open in a window'), enabled: page },
      { type: 'separator' },
      { label: tr('Screenshot'), enabled: page, submenu: [
        { id: 'shot:attach', label: tr('Attach to your message') },
        { id: 'shot:file', label: tr('Save to Downloads') },
        { id: 'shot:clipboard', label: tr('Copy') },
      ] },
      { label: tr('Size'), submenu: [
        radio('size:desktop', 'Desktop', !view.preset),
        radio('size:tablet', 'Tablet (768 × 1024)', view.preset === 'tablet'),
        radio('size:phone', 'Phone (375 × 812)', view.preset === 'phone'),
      ] },
      { label: tr('Appearance'), submenu: [
        radio('scheme:', 'System', !pane.scheme),
        radio('scheme:light', 'Light', pane.scheme === 'light'),
        radio('scheme:dark', 'Dark', pane.scheme === 'dark'),
      ] },
      { label: tr('Developer tools'), submenu: [
        radio('devtools:docked', 'Docked in the pane', pane.devtools === 'docked'),
        radio('devtools:detach', 'In a window', pane.devtools === 'detach'),
        radio('devtools:', 'Closed', !pane.devtools),
      ] },
      { id: 'logs', label: tr('Console and network'), type: 'checkbox', checked: Boolean(view.drawer) },
      { id: 'source', label: tr('View page source'), enabled: web },
      { type: 'separator' },
      { id: 'zoom-in', label: tr('Zoom in'), enabled: !pane.fit },
      { id: 'zoom-out', label: tr('Zoom out'), enabled: !pane.fit },
      { id: 'zoom-reset', label: tr('Actual size'), enabled: !pane.fit && Number(st.zoom || 100) !== 100 },
      { type: 'separator' },
      { id: 'find', label: tr('Find in page…'), enabled: page },
      { id: 'print', label: tr('Print…'), enabled: page },
      { id: 'pdf', label: tr('Save as PDF…'), enabled: page && /^(https?|file):/i.test(String(st.url || '')) },
      { id: 'external', label: tr('Open in your default browser'), enabled: web },
    ];
  }

  // Where a tab dropped on another's near or far half goes in the list without it (features/browser.js dropIndex).
  const dropIndex = (from, target, after) => target + (after ? 1 : 0) - (from < target ? 1 : 0);

  // Split view: where the right-hand tab's page goes (the window's CSS pixels, as
  // browser-parity.js split-bounds takes them), its area beside the page; null while that
  // doesn't show (none, or too small to see), and the app takes it off.
  function splitBounds(rect) {
    if (!rect || !(rect.width >= 8) || !(rect.height >= 8)) return null;
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  // The full screen button's tooltip (the old dock's words): its key to go in, Esc to come out.
  function fullTitle(on) {
    return on ? 'Leave full screen (Esc)' : 'Full screen (⌃⌘F)';
  }

  // What Esc does in the browser, the most specific thing first, as Eden Code's own Esc: one of
  // the pane's lists or panels closes ('popup'), then full screen ends ('full'), then, pressed in
  // the pane itself, the browser closes ('close'). Pressed in the page, only full screen ends: a
  // page's Esc is its own (its dialog). While a page's own full screen (a video) has the window,
  // its Esc is the page's: one pressed in the window does nothing ('hold'). '' when the Esc isn't
  // the browser's: pressed elsewhere in the window beside a browser that isn't full screen, it's
  // the conversation's. Nothing here ever stops a session at work.
  //   popup: a list or panel of the pane's is open; full: the browser's full screen; pageFull:
  //   a page's own; inside: pressed in the pane; page: pressed in the page.
  function escapeStep({ popup = false, full = false, pageFull = false, inside = false, page = false } = {}) {
    if (page) return full && !pageFull ? 'full' : '';
    if (pageFull) return 'hold';
    if (!inside && !full) return '';
    if (popup) return 'popup';
    if (full) return 'full';
    return 'close';
  }

  const api = {
    hostOf, isLocalUrl, fieldText, addressKind, tabTitle, sessionOf, blankish, devOffer, paneWidth,
    probePoints, covered, rectKey, pickBlocked, agentWords, security, inlineCompletion, presetRect, findLabel,
    fileSize, downloadNote, downloadShare, logRows, keyAction, menuSpec, dropIndex, fullTitle, escapeStep, PRESETS,
    keyWhere, keyHeard, tabMatches, folderTree, bookmarked, shieldView, errorReport, splitBounds,
    HELD, NOT_LOCAL, NO_APP, ACTIVE_MS, MIN_W, MAIN_MIN,
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.edenCodeFeatures || root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const appRoot = () => root.edenCodeApp || root.jarvisApp;
  const browser = () => { const a = appRoot(); return a && a.browser && a.browser.place ? a.browser : null; };
  const inCode = () => document.body.dataset.app === 'eden-code' || document.body.classList.contains('eden-code');
  const paneEl = () => F.$('jc-pane');
  const shownNow = () => { const p = paneEl(); return Boolean(p && !p.hidden && p.dataset.kind === 'browser'); };
  // A Mac's keys (⌘), else Ctrl's: app.js's IS_MAC where it's loaded.
  const mac = () => (typeof IS_MAC !== 'undefined' ? Boolean(IS_MAC) : !(typeof navigator === 'object' && navigator && /Win|Linux|CrOS/i.test(String(navigator.platform || ''))));

  function note(text) {
    if (typeof jcNote === 'function') jcNote(t(text));
    const a11y = root.edenCodeAccessibility || root.jarvisAccessibility;
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
    warn: '<path d="M8 2.5l5.8 10.2H2.2z"/><path d="M8 6.6v2.8M8 11.2v.1"/>',
    local: '<rect x="2.5" y="3.5" width="11" height="7.5" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/>',
    file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
    camera: '<path d="M2.5 5.5h2.2l1.1-1.6h4.4l1.1 1.6h2.2v7h-11z"/><circle cx="8" cy="8.8" r="2.2"/>',
    more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
    up: '<path d="M4 10l4-4 4 4"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
    tab: '<rect x="2" y="4.5" width="12" height="9" rx="1.8"/><path d="M4.5 4.5V3.2A1.2 1.2 0 015.7 2h4.6a1.2 1.2 0 011.2 1.2v1.3"/>',
    star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.3"/>',
    sound: '<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 5.8a3.2 3.2 0 010 4.4"/>',
    muted: '<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.6 6.3l3.4 3.4M14 6.3l-3.4 3.4"/>',
    expand: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    shrink: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
    shield: '<path d="M8 1.6l5.4 2v4.1c0 3.3-2.3 5.7-5.4 6.7-3.1-1-5.4-3.4-5.4-6.7V3.6z"/>',
    book: '<path d="M3 2.5h7.5a2 2 0 012 2v9H5a2 2 0 01-2-2z"/><path d="M3 11.5a2 2 0 012-2h7.5"/>',
    history: '<path d="M2.7 8.6A5.4 5.4 0 104.2 4.2"/><path d="M2.3 2.4v2.8h2.8"/><path d="M8 5.2V8l2 1.3"/>',
    console: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M4.8 6.5L6.8 8l-2 1.5M8.5 10h2.7"/>',
    private: '<path d="M1.8 6.6c1.9-.8 3.9-1.1 6.2-1.1s4.3.3 6.2 1.1"/><path d="M2.6 7l.6 2.9a1.9 1.9 0 001.9 1.5h.4a1.9 1.9 0 001.9-1.6M13.4 7l-.6 2.9a1.9 1.9 0 01-1.9 1.5h-.4a1.9 1.9 0 01-1.9-1.6M7 9.6h2"/>',
    agent: '<path d="M8 1.8l1.4 3.9 3.9 1.4-3.9 1.4L8 12.4 6.6 8.5 2.7 7.1l3.9-1.4z"/>',
    window: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.8"/><path d="M1.8 5.8h12.4"/>',
    folder: '<path d="M2 4.6A1.6 1.6 0 013.6 3h2.6l1.5 1.6h4.7A1.6 1.6 0 0114 6.2v5.2A1.6 1.6 0 0112.4 13H3.6A1.6 1.6 0 012 11.4z"/>',
    chevron: '<path d="M6 4l4 4-4 4"/>',
    pencil: '<path d="M10.8 2.8l2.4 2.4L6 12.4 3 13l.6-3z"/>',
    split: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M8 3v10"/>',
    swap: '<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>',
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
    b.setAttribute('aria-label', t(label.replace(/ \((?:⌘|⌃|⇧|↩|Esc|hold)[^)]*\)$/, '')));  // (its key or hint only in the tooltip)
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
    activity: null, held: false, inflight: 0, peekAt: 0, peekTimer: 0, picking: false, devtools: '',
    preset: '', drawer: false, drawerKind: 'console', logs: null, logTimer: 0, findText: '', unsafe: false, dragTab: null, dtShare: 0,
    // the panel in the page's place ('tabs', 'library' or ''), and what it shows
    panel: '', panelFrom: null, libKind: 'bookmarks', lib: { bookmarks: [], history: [] }, openFolders: new Set(), editing: '',
    tabAt: 0, tabsFound: [], tabFocus: null, docked: null,
    split: null, splitPlaced: '',  // split view: browser-parity.js's { tab, title, url } while it's on; where its page was last laid
  };

  function titleOf(id) {
    const list = typeof ccTasks !== 'undefined' && Array.isArray(ccTasks) ? ccTasks : [];
    const task = list.find((x) => x.id === id);
    return task ? String(task.title || task.prompt || `Session ${id}`).slice(0, 60) : `Session ${id}`;
  }

  // ── the pane ──

  const pane = () => { const b = browser(); return b && b.pane ? b.pane : null; };
  const ask = (msg) => { const p = pane(); return p ? Promise.resolve(p(msg)).catch(() => null) : Promise.resolve(null); };
  const feature = (name, msg) => {
    const a = appRoot();
    const f = a && a.feature;
    return f ? Promise.resolve(f.invoke(`feature:browser:${name}`, msg)).catch(() => null) : Promise.resolve(null);
  };
  const nav = (action, url) => { const b = browser(); if (b) b.nav(action, url); };
  const shortcut = (action) => { const b = browser(); if (b && b.shortcut) b.shortcut(action); };

  // Back and Forward held down (or right-clicked): the tab's history that way, as a menu.
  function holdForHistory(btn, dir) {
    let timer = 0;
    const menu = () => { const r = btn.getBoundingClientRect(); ask({ action: 'history', dir, x: r.left, y: r.bottom + 4 }); };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || btn.disabled) return;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; btn.dataset.held = '1'; menu(); }, 450);
    });
    const cancel = () => { clearTimeout(timer); timer = 0; };
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!btn.disabled) menu(); });
    // (a long press's own click, after the menu, isn't a step too)
    btn.addEventListener('click', (e) => { if (btn.dataset.held) { delete btn.dataset.held; e.stopImmediatePropagation(); } }, true);
  }

  function build() {
    const box = el('div', 'cb');
    const tabs = el('div', 'cb-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', t('Tabs'));
    const newTab = tool('plus', 'New tab (⌘T)', () => { const b = browser(); if (b) b.tab('new'); setTimeout(focusAddress, 120); });
    newTab.classList.add('cb-newtab');
    // every open tab, found by its title or address (⇧⌘A), as the old dock's tabs button
    const tabSearch = tool('tab', 'Search tabs (⌘⇧A)', () => toggleTabSearch());
    tabSearch.classList.add('cb-newtab');
    tabSearch.setAttribute('aria-pressed', 'false');
    const closePaneBtn = tool('close', 'Close browser', () => {
      if (typeof closePane === 'function') closePane();
      else F.openPane('');
    });
    closePaneBtn.classList.add('cb-newtab', 'cb-pane-close');
    const strip = el('div', 'cb-strip');
    strip.append(tabs, newTab, tabSearch, closePaneBtn);

    const bar = el('form', 'cb-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('Browser'));
    const back = tool('back', 'Back (hold for history)', () => nav('back'));
    const fwd = tool('forward', 'Forward (hold for history)', () => nav('forward'));
    holdForHistory(back, 'back');
    holdForHistory(fwd, 'forward');
    const reload = tool('reload', 'Reload', () => nav(S.st.loading ? 'stop' : 'reload'));
    const field = el('div', 'cb-field');
    const site = el('button', 'cb-site');
    site.type = 'button';
    site.append(icon('globe', 13));
    site.addEventListener('click', () => {
      const r = site.getBoundingClientRect();
      if (/^(https?|file):/i.test(S.st.url || '')) feature('site-menu', { x: r.left, y: r.bottom + 4 });
    });
    const input = mine(el('input', 'cb-url'));
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = t('Search or enter an address');
    input.setAttribute('aria-label', t('Address'));
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'both');
    input.setAttribute('aria-expanded', 'false');
    const chips = el('span', 'cb-chips');
    const zoom = el('button', 'cb-zoom');
    zoom.type = 'button';
    zoom.hidden = true;
    zoom.addEventListener('click', () => shortcut('zoom-reset'));
    const suggest = el('div', 'cb-suggest');
    suggest.hidden = true;
    suggest.setAttribute('role', 'listbox');
    // "Private" while the tab on show is a private one
    const privatePill = el('span', 'cb-private', 'Private');
    privatePill.hidden = true;
    privatePill.prepend(icon('private', 12));
    // the ad-block shield: what it blocked here; a click allows the site (or blocks it again),
    // ⌥-click (⌥↩ from the keyboard) turns blocking off or on everywhere
    const shield = el('button', 'cb-shield');
    shield.type = 'button';
    shield.hidden = true;
    shield.setAttribute('aria-label', t('Ad blocking'));
    shield.setAttribute('aria-pressed', 'true');
    const blocked = mine(el('span', 'cb-blocked'));
    shield.append(icon('shield', 13), blocked);
    shield.addEventListener('click', (e) => shields(e.altKey ? 'toggle' : 'site'));
    shield.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.altKey) { e.preventDefault(); e.stopPropagation(); shields('toggle'); }
    });
    // ★: lit when the page is a bookmark; a click (⌘D) adds it or takes it off
    const star = el('button', 'cb-star');
    star.type = 'button';
    star.title = t('Bookmark this page (⌘D)');
    star.setAttribute('aria-label', t('Bookmark this page'));
    star.setAttribute('aria-pressed', 'false');
    star.append(icon('star', 13));
    star.addEventListener('click', () => toggleBookmark());
    field.append(site, privatePill, input, chips, zoom, shield, star, suggest);
    field.addEventListener('mousedown', (e) => { if (e.target === field) { e.preventDefault(); input.focus(); } });
    const pick = tool('pick', 'Select element: send it with your next message', () => selectElement());
    pick.classList.add('cb-pick');
    pick.setAttribute('aria-pressed', 'false');
    const shot = tool('camera', 'Screenshot', () => shotMenu());
    const tools = tool('tools', 'Developer tools', () => ask({ action: 'devtools', mode: 'docked', toggle: true }).then(drawState));
    tools.setAttribute('aria-pressed', 'false');
    // the console and the requests (the drawer under the page, where its errors go to the chat)
    const logsBtn = tool('console', 'Console and network', () => setDrawer(!S.drawer));
    logsBtn.classList.add('cb-narrow-1');
    logsBtn.setAttribute('aria-pressed', 'false');
    // bookmarks and history (⌘Y), one panel in the page's place with a tab for each
    const marksBtn = tool('book', 'Bookmarks', () => toggleLibrary('bookmarks'));
    marksBtn.classList.add('cb-narrow-1');
    marksBtn.setAttribute('aria-pressed', 'false');
    const historyBtn = tool('history', 'History (⌘Y)', () => toggleLibrary('history'));
    historyBtn.classList.add('cb-narrow-2');
    historyBtn.setAttribute('aria-pressed', 'false');
    const more = tool('more', 'More', () => moreMenu());
    // full screen: last, after ⋯, as in the old dock (its label stays; aria-pressed says which)
    const full = tool('expand', fullTitle(false), () => setFull(!isFull()));
    full.classList.add('cb-full-btn');
    full.setAttribute('aria-pressed', 'false');
    bar.append(back, fwd, reload, field, pick, shot, tools, logsBtn, marksBtn, historyBtn, more, full);
    bar.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      const b = browser();
      closeSuggest();
      if (!text || !b) return;
      b.nav('go', text);
      input.blur();
      setTimeout(() => ask({ action: 'focus' }), 60);  // the page has the keyboard next, as in Chrome
    });
    input.addEventListener('input', (e) => { S.typing = true; setKind(); suggestSoon(e); });
    input.addEventListener('focus', () => { S.typing = false; input.select(); setKind(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) closeSuggest(); setKind(); }, 120));
    input.addEventListener('keydown', addressKey);
    function setKind() {
      const typing = document.activeElement === input;
      const sec = security(S.st.url, S.unsafe);
      const k = typing && input.value && input.value !== fieldText(S.st.url) ? addressKind(input.value) : '';
      const name = k === 'search' ? 'search' : k ? 'globe' : { secure: 'lock', insecure: 'warn', unsafe: 'warn', local: 'local', file: 'file' }[sec.kind] || 'globe';
      site.replaceChildren(icon(name, 13));
      site.dataset.kind = k ? 'typing' : sec.kind;
      site.title = sec.label ? t(sec.label) : t('Site settings');
      site.setAttribute('aria-label', site.title);
    }

    const find = el('div', 'cb-find');
    find.hidden = true;
    find.setAttribute('role', 'search');
    const findInput = mine(el('input', 'cb-find-input'));
    findInput.type = 'text';
    findInput.spellcheck = false;
    findInput.placeholder = t('Find in page');
    findInput.setAttribute('aria-label', t('Find in page'));
    const findCount = el('span', 'cb-find-count');
    findCount.setAttribute('aria-live', 'polite');
    const findPrev = tool('up', 'Previous match (⇧↩)', () => findStep(false));
    const findNext = tool('down', 'Next match (↩)', () => findStep(true));
    const findDone = tool('close', 'Done (Esc)', () => closeFind());
    find.append(icon('search', 13), findInput, findCount, findPrev, findNext, findDone);
    findInput.addEventListener('input', () => { S.findText = ''; findStep(true); });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); findStep(!e.shiftKey); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });

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

    // a site's request (camera, microphone, location, notifications) or sign-in: features/browser.js's strip
    const asks = el('div', 'cb-asks');

    const msg = el('div', 'cb-msg');
    msg.hidden = true;
    const msgText = mine(el('span'));
    const retry = el('button', 'jc-mini', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => { msg.hidden = true; nav('reload'); });
    msg.append(msgText, retry);

    const stage = el('div', 'cb-stage');
    const slot = el('div', 'cb-slot');
    const snap = el('img', 'cb-snap');
    snap.alt = '';
    snap.hidden = true;
    const empty = el('p', 'cb-empty', '');
    empty.hidden = true;
    const size = mine(el('span', 'cb-size'));
    size.hidden = true;
    slot.append(snap, empty, size);
    // docked DevTools: their own view below the page (app/browser-pane.js), its height dragged
    const dt = el('div', 'cb-dt');
    dt.hidden = true;
    const dtGrip = el('div', 'cb-dt-grip');
    dtGrip.setAttribute('role', 'separator');
    dtGrip.setAttribute('aria-orientation', 'horizontal');
    dtGrip.setAttribute('aria-label', t('Resize the developer tools'));
    dt.append(dtGrip, el('p', 'cb-dt-note', 'Developer tools'));
    gripDrag(dtGrip, stage);
    // tab search, and bookmarks and history: a panel in the page's place (the page steps aside
    // while it shows, its picture behind: a native view would be drawn over anything here)
    const panel = el('section', 'cb-panel');
    panel.hidden = true;
    panel.addEventListener('keydown', panelKey);
    // split view (⋯, or a tab's own menu: Show beside): the right-hand tab beside the page, its
    // own page laid over .cb-split-area by the app (browser-parity.js) and stepped aside with it
    const split = el('div', 'cb-split');
    split.hidden = true;
    split.setAttribute('role', 'region');
    split.setAttribute('aria-label', t('Split view'));
    const splitHead = el('div', 'cb-split-head');
    const splitTitle = mine(el('span', 'cb-split-title'));
    const swap = tool('swap', 'Swap sides', () => feature('split', { action: 'swap' }));
    const unsplit = tool('close', 'Close split view', () => feature('split', { action: 'close' }));
    splitHead.append(icon('split', 13), splitTitle, swap, unsplit);
    const splitArea = el('div', 'cb-split-area');
    split.append(splitHead, splitArea);
    stage.append(slot, split, dt, panel);

    // the page's console and requests: what the agent reads too (browser_console, browser_network)
    const drawer = el('section', 'cb-drawer');
    drawer.hidden = true;
    const drawerHead = el('div', 'cb-drawer-head');
    const seg = el('div', 'cb-seg');
    seg.setAttribute('role', 'tablist');
    const segBtn = (kind, label) => {
      const b = el('button', 'cb-seg-btn', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { S.drawerKind = kind; drawLogs(); readLogs(); });
      return b;
    };
    const segConsole = segBtn('console', 'Console');
    const segNetwork = segBtn('network', 'Network');
    seg.append(segConsole, segNetwork);
    const drawerNote = el('small', 'cb-drawer-note', 'Eden reads these too');
    // the console's errors and the failed requests, onto the message as a document of the page's
    const sendErrors = el('button', 'jc-mini cb-send-errors', 'Send errors to chat');
    sendErrors.type = 'button';
    sendErrors.title = t('Put the console’s errors and the failed requests on your message');
    sendErrors.addEventListener('click', () => errorsToChat());
    const drawerX = tool('close', 'Close', () => setDrawer(false));
    drawerHead.append(seg, drawerNote, sendErrors, drawerX);
    const logs = el('ol', 'cb-logs');
    drawer.append(drawerHead, logs);

    const dls = el('ul', 'cb-dls');
    dls.hidden = true;
    dls.setAttribute('aria-label', t('Downloads'));

    box.append(strip, bar, find, progress, agent, asks, offer, msg, stage, drawer, dls);
    box.addEventListener('keydown', paneKey);
    S.parts = {
      box, tabs, back, fwd, reload, field, site, input, setKind, chips, zoom, suggest, pick, shot, tools, more, full,
      find, findInput, findCount, progress, offer, agent, agentPic, agentWhat, agentWhere, take, give, asks, msg, msgText,
      stage, slot, snap, empty, size, dt, drawer, segConsole, segNetwork, drawerNote, logs, dls,
      tabSearch, privatePill, shield, blocked, star, logsBtn, marksBtn, historyBtn, panel, sendErrors,
      split, splitTitle, splitArea,
    };
    adoptAsks();
    return box;
  }

  // Drag the docked DevTools' top edge: the page above gets what they give up.
  function gripDrag(grip, stage) {
    let startY = 0;
    let startH = 0;
    grip.addEventListener('pointerdown', (e) => {
      S.dragging = true;  // (the views step aside while the pointer crosses them)
      startY = e.clientY;
      startH = S.parts ? S.parts.dt.getBoundingClientRect().height : 0;
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('cb-resizing-y');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!S.dragging || !startY) return;
      const total = stage.getBoundingClientRect().height || 1;
      S.dtShare = Math.min(0.8, Math.max(0.2, (startH + (startY - e.clientY)) / total));
      stage.style.setProperty('--cb-dt-h', `${Math.round(S.dtShare * 100)}%`);
    });
    const end = () => { if (!startY) return; startY = 0; S.dragging = false; document.body.classList.remove('cb-resizing-y'); };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // features/browser.js draws a site's request, its sign-in and a certificate warning for the
  // dock; in Eden Code there's no dock, so they're shown in the pane: the request above the
  // page, the warning in the page's place (the page is hidden while it's up: browser-parity.js).
  function adoptAsks() {
    if (!S.parts) return;
    const strip = F.$('bd-ask');
    const cert = F.$('bd-cert');
    if (strip && strip.parentNode !== S.parts.asks) S.parts.asks.append(strip);
    if (cert && cert.parentNode !== S.parts.slot) S.parts.slot.append(cert);
  }

  function render(body) {
    hookApp();  // (idempotent: an app bridge that came late)
    if (!S.root) S.root = build();
    body.replaceChildren(S.root);
    adoptAsks();
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
    tellPane();
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
    const info = st.pane || {};
    p.back.disabled = !st.canBack;
    p.fwd.disabled = !st.canForward;
    p.reload.replaceChildren(icon(st.loading ? 'stop' : 'reload'));
    p.reload.title = t(st.loading ? 'Stop' : 'Reload');
    p.reload.setAttribute('aria-label', p.reload.title);
    p.progress.hidden = !st.loading;
    // the page's address, unless the owner is typing one (a tab switched or a page gone on
    // while the field merely has the focus still shows where the tab is, as in Chrome)
    if (document.activeElement !== p.input || !S.typing || S.shownTab !== activeTab(st)) { p.input.value = fieldText(st.url); S.typing = false; }
    S.shownTab = activeTab(st);
    p.setKind();
    const blocked = pickBlocked(st.url);
    p.pick.classList.toggle('cb-off', Boolean(blocked));
    p.pick.title = t(blocked || 'Select element: send it with your next message');
    p.pick.setAttribute('aria-pressed', String(S.picking));
    S.devtools = info.devtools || '';
    p.tools.setAttribute('aria-pressed', String(Boolean(S.devtools)));
    p.tools.title = t(S.devtools ? 'Close the developer tools' : 'Developer tools');
    p.stage.classList.toggle('dt', S.devtools === 'docked');
    p.dt.hidden = S.devtools !== 'docked';
    const z = Number(st.zoom) || 100;
    p.zoom.hidden = z === 100 || Boolean(info.fit);
    p.zoom.textContent = `${z}%`;
    p.zoom.title = t('Zoom: click for actual size (⌘0)');
    const chips = [];
    if (S.preset) chips.push(chipFor(`${PRESETS[S.preset].label} ${PRESETS[S.preset].w}×${PRESETS[S.preset].h}`, 'Back to Desktop size', () => setPreset('')));
    if (info.scheme) chips.push(chipFor(info.scheme === 'dark' ? 'Dark' : 'Light', 'Back to the system’s appearance', () => setScheme('')));
    p.chips.replaceChildren(...chips);
    p.size.hidden = !S.preset;
    if (S.preset) p.size.textContent = `${PRESETS[S.preset].w} × ${PRESETS[S.preset].h}${info.fit && info.fit < 1 ? ` · ${Math.round(info.fit * 100)}%` : ''}`;
    if (st.error) { p.msgText.textContent = String(st.error); p.msg.hidden = false; } else if (!st.loading) p.msg.hidden = true;
    const onShow = (st.tabs || []).find((x) => x.active);
    p.privatePill.hidden = !(onShow && onShow.private);
    drawShield();
    drawStar();
    p.logsBtn.setAttribute('aria-pressed', String(S.drawer));
    drawFull();
    drawTabs(st.tabs || []);
  }

  function activeTab(st) { const on = (st.tabs || []).find((x) => x.active); return on ? on.id : null; }

  function chipFor(words, tip, onClick) {
    const c = el('button', 'cb-chip', words);
    c.type = 'button';
    c.title = t(tip);
    c.addEventListener('click', onClick);
    return c;
  }

  // A tab's mark before its name: in a window of its own, private, or in Eden's own profile
  // (signed out of the owner's sites), as the old dock marked them.
  function tabMark(name, words, said) {
    const mark = el('span', `cb-tab-mark ${name}`);
    mark.append(icon(name, 11));
    mark.title = t(words);
    mark.setAttribute('aria-label', t(said));
    mark.setAttribute('role', 'img');
    return mark;
  }

  let tabsKey = '';
  function drawTabs(list) {
    // every tab, those in a window of their own too (a click brings that window forward)
    const shown = list;
    const key = JSON.stringify(shown.map((x) => [x.id, x.title, x.url, x.active, x.loading, x.owner, (x.favicon || '').length, x.private, x.pinned, x.audible, x.muted, x.popout, x.agentProfile, x.split]));
    if (key === tabsKey) return;
    tabsKey = key;
    const { tabs } = S.parts;
    // a tab with the keyboard keeps it through the redraw (or hands it to the tab an arrow picked)
    const focused = tabs.contains(document.activeElement) ? document.activeElement.closest('.cb-tab') : null;
    const want = focused ? (S.tabFocus !== null ? S.tabFocus : Number(focused.dataset.tab)) : null;
    S.tabFocus = null;
    const clearDrops = () => { for (const node of tabs.querySelectorAll('.cb-tab')) node.classList.remove('drop-before', 'drop-after', 'dragging'); };
    tabs.replaceChildren(...shown.map((tab, at) => {
      const cls = ['cb-tab', tab.active && 'on', tab.loading && 'loading', tab.pinned && 'pinned', tab.private && 'private', tab.popout && 'popout', tab.agentProfile && 'agent', tab.split === 'right' && 'split-right'];
      const item = el('div', cls.filter(Boolean).join(' '));
      item.dataset.tab = String(tab.id);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(Boolean(tab.active)));
      item.tabIndex = tab.active ? 0 : -1;
      item.draggable = true;
      const name = tabTitle(tab);
      item.title = tab.url ? `${name}\n${tab.url}` : name;
      if (tab.favicon && /^data:image\//.test(tab.favicon)) {
        const img = el('img', 'cb-fav');
        img.src = tab.favicon;
        img.alt = '';
        item.append(img);
      } else item.append(icon('globe', 12));
      if (tab.popout) item.append(tabMark('window', 'In a window of its own', 'In a window of its own'));
      if (tab.private) item.append(tabMark('private', 'Private: nothing it visits or keeps stays after it closes', 'Private'));
      else if (tab.agentProfile) item.append(tabMark('agent', 'Eden’s own profile, signed out of your sites', 'Eden’s own profile'));
      item.append(mine(el('span', 'cb-tab-name', name === 'New tab' ? t(name) : name)));
      if (tab.audible || tab.muted) {
        const sound = el('button', 'cb-tab-sound');
        sound.type = 'button';
        sound.title = t(tab.muted ? 'Unmute tab' : 'Mute tab');
        sound.setAttribute('aria-label', sound.title);
        sound.append(icon(tab.muted ? 'muted' : 'sound', 11));
        sound.addEventListener('click', (e) => { e.stopPropagation(); feature('tab', { action: tab.muted ? 'unmute' : 'mute', id: tab.id }); });
        item.append(sound);
      }
      const session = sessionOf(tab.owner);
      if (session) {
        const badge = el('span', 'cb-tab-agent', 'Eden');
        badge.title = `${t('Opened by')} ${titleOf(session)}`;
        item.append(badge);
      }
      const x = el('button', 'cb-tab-x');
      x.type = 'button';
      x.setAttribute('aria-label', t('Close tab'));
      x.title = t('Close tab (⌘W)');
      x.append(icon('close', 11));
      x.addEventListener('click', (e) => { e.stopPropagation(); const b = browser(); if (b) b.tab('close', tab.id); });
      if (shown.length > 1) item.append(x);
      // (a tab in a window of its own: select brings that window forward, main.js selectTab)
      item.addEventListener('click', () => { const b = browser(); if (b && !tab.active) b.tab('select', tab.id); });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = shown[(at + (e.key === 'ArrowRight' ? 1 : -1) + shown.length) % shown.length];
          if (!next) return;
          // to one in a window of its own: the keyboard moves there (↩ brings its window forward)
          const there = tabs.querySelector(`.cb-tab[data-tab="${next.id}"]`);
          if (next.popout) { if (there) there.focus(); return; }
          const b = browser();
          S.tabFocus = next.id;
          if (b) b.tab('select', next.id);
        }
      });
      item.addEventListener('auxclick', (e) => { if (e.button === 1 && shown.length > 1) { const b = browser(); if (b) b.tab('close', tab.id); } });
      // its own menu (reload, duplicate, pin, mute, show beside, a window of its own, close
      // others) and dragged into order, a mark where it'll land
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); feature('tab', { action: 'menu', id: tab.id, x: e.clientX, y: e.clientY }); });
      item.addEventListener('dragstart', (e) => {
        S.dragTab = tab.id;
        item.classList.add('dragging');
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(tab.id)); }
      });
      item.addEventListener('dragover', (e) => {
        if (S.dragTab === null || S.dragTab === undefined) return;
        e.preventDefault();
        if (S.dragTab === tab.id) return;
        const r = item.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        item.classList.toggle('drop-after', after);
        item.classList.toggle('drop-before', !after);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = shown.findIndex((x2) => x2.id === S.dragTab);
        const r = item.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        if (from >= 0 && shown[from].id !== tab.id) feature('tab', { action: 'move', id: S.dragTab, to: dropIndex(from, at, after) });
        S.dragTab = null;
        clearDrops();
      });
      item.addEventListener('dragend', () => { S.dragTab = null; clearDrops(); });
      return item;
    }));
    const on = tabs.querySelector('.cb-tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (want !== null && !Number.isNaN(want)) {
      const back = tabs.querySelector(`.cb-tab[data-tab="${want}"]`) || on;
      if (back) back.focus();
    }
  }

  // ── the address: suggestions from the open tabs, bookmarks and history, and inline completion ──

  const omni = { rows: [], typed: null, at: 0, seq: 0, timer: 0, raw: '' };
  function suggestSoon(e) {
    clearTimeout(omni.timer);
    const input = S.parts.input;
    const adding = !e || !e.inputType || /^insert/.test(e.inputType);
    omni.raw = input.value;
    omni.timer = setTimeout(() => suggestNow(adding), 60);
  }
  async function suggestNow(complete) {
    const input = S.parts.input;
    const text = omni.raw;
    if (document.activeElement !== input || !text.trim()) { closeSuggest(); return; }
    const seq = ++omni.seq;
    const r = await feature('suggest', { text });
    if (seq !== omni.seq || document.activeElement !== input || input.value.slice(0, text.length) !== text) return;
    omni.typed = r && r.typed ? r.typed : { text, url: text, search: addressKind(text) === 'search', engine: '' };
    omni.rows = r && Array.isArray(r.rows) ? r.rows : [];
    omni.at = 0;
    // inline: the rest of the first matching address, selected, so typing on replaces it
    const full = complete && input.value === text ? inlineCompletion(text, omni.rows) : '';
    if (full && input.setSelectionRange) {
      input.value = full;
      input.setSelectionRange(text.length, full.length);
      omni.typed = { text: full, url: full, search: false, engine: '' };  // ↩ opens the completed address, as the first row says
    }
    drawSuggest();
  }
  function drawSuggest() {
    const box = S.parts.suggest;
    if (!omni.typed) { closeSuggest(); return; }
    const rows = [];
    const typed = omni.typed;
    rows.push(suggestRow(typed.search ? 'search' : 'globe', typed.search ? typed.text : typed.url, typed.search ? `${t('Search')}${typed.engine ? ` ${typed.engine}` : ''}` : t('Open'), 0, () => goTyped()));
    omni.rows.slice(0, 7).forEach((row, i) => {
      const badge = row.kind === 'tab' ? t('Switch to tab') : row.kind === 'bookmark' ? t('Bookmark') : '';
      rows.push(suggestRow(row.kind === 'tab' ? 'tab' : row.kind === 'bookmark' ? 'star' : 'clock', row.title || hostOf(row.url), badge, i + 1, (e) => pickRow(row, e && e.metaKey), bare(row.url)));
    });
    box.replaceChildren(...rows);
    box.hidden = false;
    S.parts.input.setAttribute('aria-expanded', 'true');
  }
  function suggestRow(name, title, badge, i, go, sub = '') {
    const row = el('div', `cb-sug${omni.at === i ? ' on' : ''}`);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(omni.at === i));
    row.append(icon(name, 13));
    const words = el('span', 'cb-sug-words');
    words.append(mine(el('span', 'cb-sug-title', title)));
    if (sub) words.append(mine(el('small', 'cb-sug-sub', sub)));
    row.append(words);
    if (badge) row.append(el('span', 'cb-sug-badge', badge));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); go(e); });  // (before the field's blur closes the list)
    return row;
  }
  function closeSuggest() {
    clearTimeout(omni.timer);
    omni.seq += 1;
    omni.typed = null;
    if (!S.parts) return;
    S.parts.suggest.hidden = true;
    S.parts.input.setAttribute('aria-expanded', 'false');
  }
  function goTyped() {
    const form = S.parts.input.closest('form');
    if (form && form.requestSubmit) form.requestSubmit(); else if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
  }
  function pickRow(row, newTab) {
    const b = browser();
    closeSuggest();
    if (!b) return;
    if (row.kind === 'tab') b.tab('select', row.tab);
    else if (newTab) b.tab('new', undefined, row.url);
    else b.nav('go', row.url);
    S.parts.input.blur();
    setTimeout(() => ask({ action: 'focus' }), 60);
  }
  function addressKey(e) {
    const input = S.parts.input;
    const open = !S.parts.suggest.hidden && omni.typed;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = Math.min(omni.rows.length, 7) + 1;
      omni.at = (omni.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      input.value = omni.at ? omni.rows[omni.at - 1].url : omni.raw;
      drawSuggest();
      return;
    }
    if (open && e.key === 'Enter' && omni.at > 0) { e.preventDefault(); e.stopPropagation(); pickRow(omni.rows[omni.at - 1], e.metaKey); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (open) { closeSuggest(); input.value = fieldText(S.st.url); input.select(); return; }
      input.value = fieldText(S.st.url);
      S.parts.setKind();
      input.blur();
      ask({ action: 'focus' });  // back to the page
    }
  }
  function focusAddress() { if (!S.parts) return; S.parts.input.focus(); S.parts.input.select(); }

  // ── find in page (⌘F): matches as you type, ↩ and ⇧↩ for the next and the one before ──

  function openFind() {
    if (!S.parts) return;
    S.parts.find.hidden = false;
    S.parts.findInput.focus();
    S.parts.findInput.select();
    if (S.parts.findInput.value) findStep(true);
  }
  function closeFind() {
    if (!S.parts || S.parts.find.hidden) return;
    S.parts.find.hidden = true;
    S.findText = '';
    S.parts.findCount.textContent = '';
    const b = browser();
    if (b && b.find) b.find({ stop: true });
    ask({ action: 'focus' });
  }
  function findStep(forward) {
    const b = browser();
    const text = S.parts.findInput.value;
    if (!b || !b.find) return;
    if (!text) { S.findText = ''; S.parts.findCount.textContent = ''; b.find({ stop: true }); return; }
    b.find({ text, forward, next: text === S.findText });
    S.findText = text;
  }

  // ── full screen (⌃⌘F, the toolbar's last button; Esc leaves it) ──

  const isFull = () => document.body.classList.contains('cb-full');
  const isPageFull = () => document.body.classList.contains('cb-page-full');
  function setFull(on) {
    const want = Boolean(on) && shownNow();
    if (want === isFull()) { drawFull(); return; }
    document.body.classList.toggle('cb-full', want);
    S.placed = '';  // the page moves at once, not when the slot's next change is seen
    drawFull();
  }
  function drawFull() {
    if (!S.parts) return;
    const on = isFull();
    const b = S.parts.full;
    b.setAttribute('aria-pressed', String(on));
    b.title = t(fullTitle(on));
    b.replaceChildren(icon(on ? 'shrink' : 'expand'));
  }

  // ── Esc: the pane's own lists and panels, then full screen, then the browser (escapeStep) ──

  // One of the pane's lists or panels is open: the first Esc is theirs.
  function popupOpen() {
    return Boolean(S.parts) && (!S.parts.suggest.hidden || Boolean(S.panel) || !S.parts.find.hidden);
  }
  // The most specific one closes: the address's suggestions, an edit in a panel, the panel
  // (tab search, bookmarks and history), then find in page.
  function closePopup() {
    if (!S.parts) return false;
    if (!S.parts.suggest.hidden) { closeSuggest(); S.parts.input.value = fieldText(S.st.url); S.parts.setKind(); return true; }
    if (S.panel && S.editing) { S.editing = ''; drawLibrary(); return true; }
    if (S.panel) return closePanel();
    if (!S.parts.find.hidden) { closeFind(); return true; }
    return false;
  }
  function escape(step) {
    if (step === 'popup') closePopup();
    else if (step === 'full') setFull(false);
    else if (step === 'close' && typeof closePane === 'function') closePane();
  }
  // Whether an Esc is for something drawn in front of the full-screen browser (Settings, ⌘K, a
  // sheet or a menu with the keyboard): the element it went to shows at its own place. Under
  // the full-screen pane, nothing of the window does, the composer included.
  function inFront(node) {
    if (!node || node.nodeType !== 1 || node === document.body || node === document.documentElement || !node.getBoundingClientRect) return false;
    const r = node.getBoundingClientRect();
    if (!(r.width >= 1 && r.height >= 1)) return false;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(top) && (top === node || node.contains(top));
  }
  // Esc pressed in the window (the window's capture phase, before any field or the
  // conversation's Esc hears it): only while the browser covers the window, and never for what's
  // drawn in front of it. Pressed in the pane, its own fields hear it first, then escHere.
  function escWindow(e) {
    if (!shownNow() || !S.parts || e.defaultPrevented) return;
    const pane = paneEl();
    if (pane && pane.contains(e.target)) return;
    if (inFront(e.target)) return;
    const step = escapeStep({ popup: popupOpen(), full: isFull(), pageFull: isPageFull() });
    if (!step) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    escape(step);
  }
  // Esc in the pane that none of its fields took: never on to the conversation's Esc (which
  // stops a session at work).
  function escHere(e) {
    if (e.key !== 'Escape' || e.isComposing || !shownNow()) return;
    e.stopPropagation();
    if (e.defaultPrevented) return;  // (something of the pane's took it already)
    e.preventDefault();
    escape(escapeStep({ popup: popupOpen(), full: isFull(), pageFull: isPageFull(), inside: true }));
  }

  // ── ⋯, the screenshot, sizes and light or dark ──

  async function moreMenu() {
    const r = S.parts.more.getBoundingClientRect();
    const panel = S.panel === 'library' ? S.libKind : S.panel;
    const id = await ask({ action: 'menu', x: r.left, y: r.bottom + 4, items: menuSpec(S.st, { preset: S.preset, drawer: S.drawer, panel, split: Boolean(S.split) }, t) });
    if (id) runMenu(String(id));
  }
  async function shotMenu() {
    const r = S.parts.shot.getBoundingClientRect();
    const spec = menuSpec(S.st, {}, t).find((x) => Array.isArray(x.submenu) && x.submenu[0].id === 'shot:attach');
    const id = await ask({ action: 'menu', x: r.left, y: r.bottom + 4, items: spec ? spec.submenu : [] });
    if (id) runMenu(String(id));
  }
  async function runMenu(id) {
    const [what, arg = ''] = id.split(':');
    switch (what) {
      case 'private': return feature('private-tab');
      case 'tab-search': return openTabSearch();
      case 'bookmarks': case 'history': return toggleLibrary(what);
      case 'popout': return feature('pop-out');  // (its tab stays in the strip: a click brings its window forward)
      case 'split': return feature('split', { action: 'toggle' });  // (beside the tab last on show, else a new one)
      case 'shot': return screenshot(arg);
      case 'size': return setPreset(arg === 'desktop' ? '' : arg);
      case 'scheme': return setScheme(arg);
      case 'devtools': await ask({ action: 'devtools', mode: arg }); return drawState();
      case 'logs': return setDrawer(!S.drawer);
      case 'source': return ask({ action: 'source' });
      case 'zoom-in': case 'zoom-out': case 'zoom-reset': return shortcut(what);
      case 'find': return openFind();
      case 'print': return ask({ action: 'print' });
      case 'pdf': return ask({ action: 'pdf' });
      case 'external': { const b = browser(); return b && b.external ? b.external() : null; }
      default: return null;
    }
  }
  async function screenshot(to) {
    const r = await ask({ action: 'screenshot', to: to || 'file' });
    if (!r || !r.ok) { note((r && r.message) || 'The screenshot didn’t work.'); return; }
    if (r.to === 'attach') {
      const added = typeof attachItems === 'function' ? attachItems([{ data: r.png, media_type: 'image/png', name: r.name }]) : 0;
      note(added ? 'The screenshot is on your message.' : 'The screenshot couldn’t be added to your message.');
    } else if (r.to === 'clipboard') note('The screenshot is copied.');
    else note(`Saved ${r.name} to Downloads.`);
  }
  function setPreset(name) {
    S.preset = PRESETS[name] ? name : '';
    S.placed = '';
    drawState();
  }
  async function setScheme(value) {
    const r = await ask({ action: 'scheme', value });
    if (r && r.ok === false && r.message) note(r.message);
    drawState();
  }

  // ── the console and the requests ──

  function setDrawer(on) {
    S.drawer = Boolean(on);
    if (!S.parts) return;
    S.parts.drawer.hidden = !S.drawer;
    S.parts.logsBtn.setAttribute('aria-pressed', String(S.drawer));
    clearInterval(S.logTimer);
    S.logTimer = 0;
    if (S.drawer) { drawLogs(); readLogs(); S.logTimer = setInterval(() => { if (shownNow() && S.drawer) readLogs(); }, 1500); }
  }
  async function readLogs() {
    const kind = S.drawerKind;
    const r = await ask({ action: 'logs', kind });
    if (kind !== S.drawerKind || !S.parts) return;
    S.logs = r || {};
    drawLogs();
  }
  function drawLogs() {
    if (!S.parts) return;
    const p = S.parts;
    p.segConsole.classList.toggle('on', S.drawerKind === 'console');
    p.segNetwork.classList.toggle('on', S.drawerKind === 'network');
    p.segConsole.setAttribute('aria-selected', String(S.drawerKind === 'console'));
    p.segNetwork.setAttribute('aria-selected', String(S.drawerKind === 'network'));
    const r = S.logs || {};
    if (r.ok === false) { p.logs.replaceChildren(mine(el('li', 'cb-log-empty', r.message || ''))); return; }
    const rows = logRows(S.drawerKind, r.entries);
    if (!rows.length) { p.logs.replaceChildren(el('li', 'cb-log-empty', S.drawerKind === 'network' ? 'No requests yet.' : 'Nothing in the console yet.')); return; }
    p.logs.replaceChildren(...rows.slice(-200).map((row) => {
      const li = el('li', `cb-log ${row.level}`);
      li.append(mine(el('b', '', row.head)), mine(el('span', 'cb-log-text', row.text)));
      if (row.meta) li.append(mine(el('small', '', row.meta)));
      return li;
    }));
    p.logs.scrollTop = p.logs.scrollHeight;
  }
  // "Send errors to chat": the console's errors and the failed requests, read afresh, go on the
  // message as a document (the page's words, never the owner's); nothing is sent until they send.
  async function errorsToChat() {
    const [cons, net] = await Promise.all([ask({ action: 'logs', kind: 'console' }), ask({ action: 'logs', kind: 'network' })]);
    const text = errorReport(S.st.url, (cons && cons.entries) || [], (net && net.entries) || []);
    if (!text) { note('No errors in the console or the requests.'); return; }
    const put = F.attach || (typeof attachItems === 'function' ? attachItems : null);
    const added = put ? put([{ media_type: 'text/plain', data: text, name: `Browser errors · ${hostOf(S.st.url) || 'page'}` }]) : 0;
    note(added ? 'The errors are on your message.' : 'The errors couldn’t be added to your message.');
  }

  // ── the address's shield (ad blocking) and ★ (a bookmark) ──

  function shields(action) {
    const b = browser();
    if (b && b.shields) b.shields(action);
  }
  function drawShield() {
    if (!S.parts) return;
    const v = shieldView(S.st.shields, S.st.url, t);
    const { shield, blocked } = S.parts;
    shield.hidden = v.hidden;
    shield.setAttribute('aria-pressed', String(v.pressed));
    shield.title = v.title;
    blocked.textContent = v.count;
  }
  // The bookmarks and history (main.js browser:data), read when the pane opens, when the
  // library opens and after each change made here: never on every page.
  async function refreshLib(action, url, title) {
    const b = browser();
    if (!b || !b.data) return S.lib;
    const r = await Promise.resolve(b.data(action, url, title)).catch(() => null);
    if (r && Array.isArray(r.bookmarks)) S.lib = { bookmarks: r.bookmarks, history: Array.isArray(r.history) ? r.history : [] };
    drawStar();
    if (S.panel === 'library') drawLibrary();
    return S.lib;
  }
  function drawStar() {
    if (!S.parts) return;
    const web = /^https?:/i.test(String(S.st.url || ''));
    S.parts.star.disabled = !web;
    S.parts.star.setAttribute('aria-pressed', String(bookmarked(S.lib.bookmarks, S.st.url)));
  }
  // ★ or ⌘D: the page on show added to the bookmarks, or taken off them.
  async function toggleBookmark() {
    const url = String(S.st.url || '');
    if (!/^https?:/i.test(url)) return;
    const lib = await refreshLib('bookmark', url, S.st.title || url);
    note(bookmarked(lib.bookmarks, url) ? 'Bookmarked.' : 'Bookmark removed.');
  }

  // ── panels in the page's place: tab search (⇧⌘A) and bookmarks and history (⌘Y) ──

  function openPanel(kind) {
    if (!S.parts) return;
    closeSuggest();
    if (!S.panel) S.panelFrom = document.activeElement;
    S.panel = kind;
    S.editing = '';
    S.parts.panel.hidden = false;
    S.parts.panel.dataset.kind = kind;
    S.placed = '';
    drawPanelButtons();
  }
  // focus: where the keyboard goes once it's gone (the button it was opened from, else the page)
  function closePanel(focus = true) {
    if (!S.parts || !S.panel) return false;
    const inside = S.parts.panel.contains(document.activeElement);
    S.panel = '';
    S.editing = '';
    S.parts.panel.hidden = true;
    S.parts.panel.replaceChildren();
    drawPanelButtons();
    if (focus && inside) {
      const from = S.panelFrom;
      if (from && from.isConnected && S.parts.box.contains(from) && from.focus) from.focus(); else ask({ action: 'focus' });
    }
    S.panelFrom = null;
    return true;
  }
  function drawPanelButtons() {
    if (!S.parts) return;
    const p = S.parts;
    p.tabSearch.setAttribute('aria-pressed', String(S.panel === 'tabs'));
    p.marksBtn.setAttribute('aria-pressed', String(S.panel === 'library' && S.libKind === 'bookmarks'));
    p.historyBtn.setAttribute('aria-pressed', String(S.panel === 'library' && S.libKind === 'history'));
  }
  // Keys in a panel: Esc closes it (an edit in it first), never on to the conversation's.
  function panelKey(e) {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    if (S.editing) { S.editing = ''; drawLibrary(); return; }
    closePanel();
  }
  // The head every panel has: its search field (the keyboard starts there) and Done.
  function panelHead(placeholder, onInput, extra = []) {
    const head = el('div', 'cb-panel-head');
    const search = mine(el('input', 'cb-panel-search'));
    search.type = 'text';
    search.spellcheck = false;
    search.autocomplete = 'off';
    search.placeholder = t(placeholder);
    search.setAttribute('aria-label', t(placeholder));
    search.addEventListener('input', onInput);
    const done = el('button', 'jc-mini', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => closePanel());
    head.append(...extra, search, done);
    return { head, search };
  }

  // ── tab search: every open tab, found by its title or address; ↑↓, ↩, Esc, × from the list ──

  function toggleTabSearch() { if (S.panel === 'tabs') closePanel(); else openTabSearch(); }
  function openTabSearch() {
    if (!S.parts) return;
    openPanel('tabs');
    const box = S.parts.panel;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('Search tabs'));
    const { head, search } = panelHead('Search tabs', () => { S.tabAt = 0; drawTabSearch(); });
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-controls', 'cb-tablist');
    search.addEventListener('keydown', tabSearchKey);
    const list = el('ul', 'cb-panel-list');
    list.id = 'cb-tablist';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('Tabs'));
    box.replaceChildren(head, list);
    S.tabAt = Math.max(0, (S.st.tabs || []).findIndex((x) => x.active));
    S.tabsFound = [];
    drawTabSearch();
    search.focus();
  }
  function drawTabSearch() {
    if (!S.parts || S.panel !== 'tabs') return;
    const box = S.parts.panel;
    const search = box.querySelector('.cb-panel-search');
    const list = box.querySelector('.cb-panel-list');
    if (!search || !list) return;
    const all = S.st.tabs || [];
    const found = all.filter((x) => tabMatches(x, search.value));
    S.tabsFound = found;
    S.tabAt = Math.min(S.tabAt || 0, Math.max(0, found.length - 1));
    if (!found.length) {
      list.replaceChildren(el('li', 'cb-panel-empty', 'No open tab matches.'));
      search.removeAttribute('aria-activedescendant');
      return;
    }
    list.replaceChildren(...found.map((tab, i) => {
      const li = el('li', `cb-row${i === S.tabAt ? ' on' : ''}`);
      li.id = `cb-tabrow-${tab.id}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === S.tabAt));
      const go = el('button', 'cb-row-go');
      go.type = 'button';
      go.tabIndex = -1;
      go.append(icon(tab.audible && !tab.muted ? 'sound' : tab.popout ? 'window' : 'tab', 13));
      const words = el('span', 'cb-row-words');
      words.append(mine(el('span', 'cb-row-title', tabTitle(tab) === 'New tab' ? t('New tab') : tabTitle(tab))), mine(el('small', 'cb-row-sub', hostOf(tab.url))));
      go.append(words);
      const badge = tab.active ? 'Current tab' : tab.popout ? 'In a window of its own' : tab.pinned ? 'Pinned tab' : '';
      if (badge) go.append(el('span', 'cb-row-badge', badge));
      go.addEventListener('mousedown', (e) => e.preventDefault());  // (the search keeps the keyboard)
      go.addEventListener('click', () => pickTab(tab));
      li.append(go);
      if (all.length > 1) {
        const x = el('button', 'cb-row-x');
        x.type = 'button';
        x.tabIndex = -1;
        x.setAttribute('aria-label', t('Close tab'));
        x.title = t('Close tab');
        x.append(icon('close', 11));
        x.addEventListener('mousedown', (e) => e.preventDefault());
        x.addEventListener('click', () => { const b = browser(); if (b) b.tab('close', tab.id); });
        li.append(x);
      }
      return li;
    }));
    const on = found[S.tabAt];
    if (on) search.setAttribute('aria-activedescendant', `cb-tabrow-${on.id}`);
    const row = list.querySelector('.cb-row.on');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }
  function pickTab(tab) {
    closePanel(false);
    const b = browser();
    if (b && !tab.active) b.tab('select', tab.id);
    ask({ action: 'focus' });
  }
  function tabSearchKey(e) {
    const n = (S.tabsFound || []).length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { S.tabAt = ((S.tabAt || 0) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; drawTabSearch(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.tabsFound[S.tabAt]) pickTab(S.tabsFound[S.tabAt]);
    }
  }

  // ── bookmarks and history: one panel, a tab for each (⌘Y opens History); bookmarks in their
  // folders, each renamed or moved in place (features/browser.js's), history by day ──

  const LIB_MAX = 300;  // rows drawn at once
  const pathLabel = (path) => String(path || '').split('/').join(' › ');
  const newTabClick = (e) => Boolean(e && (mac() ? e.metaKey : e.ctrlKey));
  function toggleLibrary(kind) {
    if (S.panel === 'library' && S.libKind === kind) { closePanel(); return; }
    S.libKind = kind;
    if (S.panel === 'library') { drawPanelButtons(); drawLibrary(); return; }
    openLibrary();
  }
  function openLibrary() {
    if (!S.parts) return;
    openPanel('library');
    const box = S.parts.panel;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('Bookmarks and history'));
    const seg = el('div', 'cb-seg');
    seg.setAttribute('role', 'tablist');
    const segBtn = (kind, label) => {
      const b = el('button', 'cb-seg-btn', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.kind = kind;
      b.addEventListener('click', () => { S.libKind = kind; S.editing = ''; drawPanelButtons(); drawLibrary(); });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        S.libKind = S.libKind === 'bookmarks' ? 'history' : 'bookmarks';
        drawPanelButtons();
        drawLibrary();
        const to = seg.querySelector(`[data-kind="${S.libKind}"]`);
        if (to) to.focus();
      });
      return b;
    };
    seg.append(segBtn('bookmarks', 'Bookmarks'), segBtn('history', 'History'));
    const { head, search } = panelHead('Search', () => drawLibrary(), [seg]);
    const list = el('ul', 'cb-panel-list');
    const foot = el('div', 'cb-panel-foot');
    const clear = el('button', 'jc-mini cb-clear', 'Clear history');
    clear.type = 'button';
    clear.addEventListener('click', () => refreshLib('clear-history'));
    foot.append(clear);
    const names = el('datalist');
    names.id = 'cb-folders';
    box.replaceChildren(head, list, foot, names);
    drawLibrary();
    refreshLib();
    search.focus();
  }
  function drawLibrary() {
    if (!S.parts || S.panel !== 'library') return;
    const box = S.parts.panel;
    const search = box.querySelector('.cb-panel-search');
    const list = box.querySelector('.cb-panel-list');
    if (!search || !list) return;
    for (const b of box.querySelectorAll('.cb-seg-btn')) {
      const on = b.dataset.kind === S.libKind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const q = search.value.trim().toLowerCase();
    const clear = box.querySelector('.cb-clear');
    clear.hidden = S.libKind !== 'history' || !S.lib.history.length;
    if (S.libKind === 'bookmarks') drawBookmarks(list, q);
    else drawHistory(list, q);
  }
  function libRow(cls, depth = 0) {
    const li = el('li', `cb-row ${cls}`);
    if (depth) li.style.paddingLeft = `${depth * 16}px`;  // (a folder's own rows, in under it)
    return li;
  }
  function libGo(title, sub, onGo) {
    const go = el('button', 'cb-row-go');
    go.type = 'button';
    const words = el('span', 'cb-row-words');
    words.append(mine(el('span', 'cb-row-title', title)), mine(el('small', 'cb-row-sub', sub)));
    go.append(words);
    go.addEventListener('click', onGo);
    return go;
  }
  function rowAction(name, label, run) {
    const b = el('button', 'cb-row-act');
    b.type = 'button';
    b.title = t(label);
    b.setAttribute('aria-label', t(label));
    b.append(icon(name, 12));
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  }
  function openFromLibrary(url, e) {
    const b = browser();
    if (!b) return;
    if (newTabClick(e)) b.tab('new', undefined, url); else b.nav('go', url);
    closePanel(false);
    ask({ action: 'focus' });
  }
  function drawHistory(list, q) {
    const items = S.lib.history.filter((x) => x && (!q || `${x.title || ''} ${x.url}`.toLowerCase().includes(q))).slice(0, LIB_MAX);
    if (!items.length) { list.replaceChildren(el('li', 'cb-panel-empty', q ? 'Nothing matches.' : 'No history yet.')); return; }
    const rows = [];
    let day = '';
    for (const x of items) {
      const when = new Date(Number(x.at) || 0);
      const d = when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      if (d !== day) { day = d; rows.push(mine(el('li', 'cb-day', d))); }
      const li = libRow('cb-hist');
      const go = libGo(x.title || hostOf(x.url) || x.url, hostOf(x.url) || x.url, (e) => openFromLibrary(x.url, e));
      go.append(mine(el('span', 'cb-row-time', when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))));
      li.append(go);
      rows.push(li);
    }
    list.replaceChildren(...rows);
  }
  function drawBookmarks(list, q) {
    const all = S.lib.bookmarks.slice().reverse();  // the newest first
    const tree = folderTree(all);
    const names = S.parts.panel.querySelector('#cb-folders');
    if (names) names.replaceChildren(...tree.map((f) => { const o = el('option'); o.value = pathLabel(f.path); return o; }));
    const rows = [];
    if (q) {
      for (const b of all) {
        if (rows.length >= LIB_MAX) break;
        if (`${b.title || ''} ${b.url} ${b.folder || ''}`.toLowerCase().includes(q)) rows.push(bookmarkRow(b, 0, true));
      }
      list.replaceChildren(...(rows.length ? rows : [el('li', 'cb-panel-empty', 'Nothing matches.')]));
      return;
    }
    const inFolder = new Map();
    for (const b of all) {
      const f = b.folder || '';
      if (!inFolder.has(f)) inFolder.set(f, []);
      inFolder.get(f).push(b);
    }
    for (const b of inFolder.get('') || []) { if (rows.length >= LIB_MAX) break; rows.push(bookmarkRow(b, 0)); }
    const open = S.openFolders;
    const shown = (path) => path.split('/').every((_, i, parts) => i === parts.length - 1 || open.has(parts.slice(0, i + 1).join('/')));
    for (const f of tree) {
      if (rows.length >= LIB_MAX) break;
      if (!shown(f.path)) continue;  // inside a closed folder
      rows.push(folderRow(f));
      if (!open.has(f.path)) continue;
      for (const b of inFolder.get(f.path) || []) { if (rows.length >= LIB_MAX) break; rows.push(bookmarkRow(b, f.depth + 1)); }
    }
    list.replaceChildren(...(rows.length ? rows : [el('li', 'cb-panel-empty', 'No bookmarks yet. Press ★ in the address bar (⌘D) to add this page.')]));
  }
  function bookmarkRow(b, depth, withFolder = false) {
    if (S.editing === b.url) return bookmarkEditor(b, depth);
    const li = libRow('cb-bm', depth);
    const where = withFolder && b.folder ? `${hostOf(b.url)} · ${pathLabel(b.folder)}` : hostOf(b.url);
    li.append(libGo(b.title || hostOf(b.url) || b.url, where || b.url, (e) => openFromLibrary(b.url, e)),
      rowAction('pencil', 'Rename or move', () => { S.editing = b.url; drawLibrary(); }),
      rowAction('close', 'Remove bookmark', () => refreshLib('bookmark', b.url)));
    return li;
  }
  // A bookmark renamed, or moved to a folder ("Work › Reading"; none: the top).
  function bookmarkEditor(b, depth) {
    const li = libRow('cb-edit', depth);
    const form = el('form', 'cb-edit-form');
    const name = mine(el('input', 'cb-edit-field'));
    name.value = b.title || '';
    name.placeholder = t('Name');
    name.setAttribute('aria-label', t('Name'));
    const folder = mine(el('input', 'cb-edit-field'));
    folder.value = pathLabel(b.folder || '');
    folder.placeholder = t('Folder (none: the top)');
    folder.setAttribute('aria-label', t('Folder'));
    folder.setAttribute('list', 'cb-folders');
    for (const f of [name, folder]) { f.type = 'text'; f.autocomplete = 'off'; f.spellcheck = false; }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await feature('bookmark', { url: b.url, title: name.value, folder: folder.value.split('›').map((p) => p.trim()).filter(Boolean).join('/') });
      S.editing = '';
      await refreshLib();
    });
    const save = el('button', 'jc-mini primary', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'jc-mini', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { S.editing = ''; drawLibrary(); });
    form.append(name, folder, save, cancel);
    li.append(form);
    setTimeout(() => { if (name.isConnected) name.focus(); }, 0);
    return li;
  }
  function folderRow({ path, count, depth }) {
    if (S.editing === `folder:${path}`) {
      const li = libRow('cb-edit', depth);
      const form = el('form', 'cb-edit-form');
      const input = mine(el('input', 'cb-edit-field'));
      input.type = 'text';
      input.value = pathLabel(path);
      input.setAttribute('aria-label', t('Folder'));
      input.autocomplete = 'off';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const to = input.value.split('›').map((p) => p.trim()).filter(Boolean).join('/');
        await feature('folder', { from: path, to });
        if (S.openFolders.delete(path) && to) S.openFolders.add(to);
        S.editing = '';
        await refreshLib();
      });
      const save = el('button', 'jc-mini primary', 'Save');
      save.type = 'submit';
      const cancel = el('button', 'jc-mini', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { S.editing = ''; drawLibrary(); });
      form.append(input, save, cancel);
      li.append(form);
      setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
      return li;
    }
    const open = S.openFolders.has(path);
    const li = libRow(`cb-folder${open ? ' open' : ''}`, depth);
    const go = el('button', 'cb-row-go');
    go.type = 'button';
    go.setAttribute('aria-expanded', String(open));
    const words = el('span', 'cb-row-words');
    words.append(mine(el('span', 'cb-row-title', path.split('/').pop())));
    go.append(icon('chevron', 11), icon('folder', 13), words, mine(el('span', 'cb-row-count', String(count))));
    go.addEventListener('click', () => { if (open) S.openFolders.delete(path); else S.openFolders.add(path); drawLibrary(); });
    li.append(go, rowAction('pencil', 'Rename folder', () => { S.editing = `folder:${path}`; drawLibrary(); }));
    return li;
  }

  // ── downloads: each asks Save first (a page can't put a file on the Mac by itself), then
  // its progress, Open and Show in Finder ──

  const dls = new Map();
  function onDownload(d) {
    if (!d || !d.id) return;
    dls.set(d.id, d);
    drawDownloads();
  }
  function drawDownloads() {
    if (!S.parts) return;
    const list = [...dls.values()].reverse().slice(0, 6);
    S.parts.dls.hidden = !list.length;
    S.parts.dls.replaceChildren(...list.map((d) => {
      const li = el('li', `cb-dl ${d.state}`);
      const text = el('div', 'cb-dl-text');
      text.append(mine(el('b', '', d.name)), el('small', '', downloadNote(d)));
      const acts = el('div', 'cb-dl-acts');
      const act = (label, action, cls = '') => {
        const b = el('button', `jc-mini ${cls}`, label);
        b.type = 'button';
        b.addEventListener('click', () => {
          const br = browser();
          if (br && br.download) br.download(d.id, action);
          if (action === 'cancel') { dls.delete(d.id); drawDownloads(); }
        });
        return b;
      };
      if (d.state === 'asking') acts.append(act('Save', 'save', 'primary'), act('Cancel', 'cancel'));
      else if (d.state === 'progressing') acts.append(act('Cancel', 'cancel'));
      else if (d.state === 'completed') acts.append(act('Open', 'open'), act('Show in Finder', 'show'));
      const x = tool('close', 'Remove from the list', () => { dls.delete(d.id); drawDownloads(); });
      x.classList.add('cb-dl-x');
      if (d.state !== 'asking' && d.state !== 'progressing') acts.append(x);
      const bar = el('i', 'cb-dl-bar');
      const share = downloadShare(d);
      bar.hidden = share === null || d.state === 'completed';
      if (share !== null) bar.style.width = `${Math.round(share * 100)}%`;
      li.append(text, acts, bar);
      return li;
    }));
  }

  // ── keys while the pane has the keyboard (the page's own come from the app) ──

  function paneKey(e) {
    if (e.defaultPrevented) return;
    const action = keyAction(e, mac());
    if (!action) return;
    // a field of the pane's own keeps the keys it types with (⌘A, ⌘C…: none of these)
    e.preventDefault();
    e.stopPropagation();
    key(action, true);
  }

  // Whether the focus is in a field of the window's own (the composer, a search box): its
  // keys then stay its own, but for ⌘T, ⌘W and the others the old dock took even there.
  function typingIn(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
    return node.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|color|file|image)$/i.test(String(node.type || 'text'));
  }
  // The window's keys for the browser while the pane is open, heard before anything else of the
  // window's (its capture phase), so a key the pane has the keyboard for is never another's
  // (⇧⌘A isn't Needs attention there, ⌘F isn't the conversation's find): Esc (escWindow), and
  // the browser's keys by keyHeard (⌃⌘F from anywhere).
  function windowKey(e) {
    if (!inCode() || !shownNow() || !S.parts || e.isComposing) return;
    if (e.key === 'Escape') { escWindow(e); return; }
    if (e.defaultPrevented) return;
    const action = keyAction(e, mac());
    const pane = paneEl();
    const inPane = Boolean(pane && pane.contains(e.target));
    if (!keyHeard(action, { inPane, typing: typingIn(e.target) })) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    key(action, true);
  }

  // ── the native view over the slot ──

  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  function slotRect() { return box(S.parts.slot); }

  // Something of the window over the page's place (or the docked DevTools', or split view's
  // other page: splitRect): the stage's own parts don't count (the picture standing in, a
  // certificate warning in the page's place).
  function overlayOver(rect, splitRect = null) {
    const stage = S.parts.stage;
    const inside = (node) => node === stage || stage.contains(node);
    const hit = (x, y) => document.elementFromPoint(x, y);
    const sug = S.parts.suggest;  // (open over the page: the page steps aside, whatever the probes find)
    if (!sug.hidden) { const r = box(sug); if (r.bottom > rect.top && r.top < rect.bottom && r.right > rect.left && r.left < rect.right) return true; }
    return covered(rect, hit, inside) || (S.devtools === 'docked' && covered(box(S.parts.dt), hit, inside)) || Boolean(splitRect && covered(splitRect, hit, inside));
  }

  // ── split view: the right-hand tab beside the page, laid and stepped aside with it ──

  function drawSplit() {
    if (!S.parts) return;
    const on = Boolean(S.split);
    S.parts.split.hidden = !on;
    S.parts.stage.classList.toggle('split', on);
    S.parts.splitTitle.textContent = on ? String(S.split.title || hostOf(S.split.url) || t('New tab')) : '';
    S.placed = '';  // the page's own place is half the stage now (or all of it again)
    S.splitPlaced = '';
  }
  // The right-hand tab's page over its area (null: taken off), told to the app only when it moves.
  function placeSplit(bounds) {
    const key = bounds ? rectKey(bounds) : 'none';
    if (key === S.splitPlaced) return;
    S.splitPlaced = key;
    feature('split-bounds', bounds);
  }

  async function park() {
    const b = browser();
    if (!b || S.parked) return;
    S.parked = true;
    S.placed = '';
    const picture = await (S.parking = b.park().catch(() => ''));
    S.parking = null;
    if (!S.parts) return;
    if (typeof picture === 'string' && picture.startsWith('data:image/') && S.parked) { S.parts.snap.src = picture; S.parts.snap.hidden = false; }
  }

  async function place(rect) {
    const b = browser();
    if (!b) return;
    if (S.parking) await S.parking;  // (a park on its way: after it)
    // a size preset: the page at a phone's or a tablet's size, centred, zoomed down to fit
    const fitted = presetRect(rect, S.preset);
    const r = fitted || rect;
    const bounds = { x: r.left, y: r.top, width: r.width, height: r.height };
    if (fitted) bounds.fit = fitted.fit;
    if (S.devtools === 'docked' && S.parts) {
      const d = box(S.parts.dt);
      const grip = 6;  // (the grip above them stays the window's, for dragging)
      if (d.width > 8 && d.height > 8 + grip) bounds.dt = { x: d.left, y: d.top + grip, width: d.width, height: d.height - grip };
    }
    const key = `${rectKey(bounds)}|${bounds.fit || ''}|${bounds.dt ? rectKey(bounds.dt) : ''}`;
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
    closeSuggest();
    closePanel(false);
    setDrawer(false);
    const b = browser();
    if (b) b.hide();
    if (S.split) placeSplit(null);
    S.splitPlaced = '';
    tellDock(false);
  }

  // The app hears whether the browser is on show, as the old dock told it (browser-parity.js
  // dock): closing it stops every video and sound in its tabs (one in a window of its own
  // plays on).
  function tellDock(open) {
    if (S.docked === open || !browser()) return;
    S.docked = open;
    feature('dock', { open });
  }

  // A panel of the pane's in the page's place (tab search, bookmarks and history, the reader):
  // the page steps aside while it shows. Drawn inside the stage, it isn't found over the slot
  // (the stage's own parts never are), so it's asked for by name.
  function panelOver() {
    const r = F.$('bai-reader');
    return Boolean(S.panel) || Boolean(r && !r.hidden);
  }

  function startLoop() {
    if (S.loop || !browser()) return;
    tellDock(true);
    refreshLib();  // (★ for the page on show: the bookmarks as they are now)
    const tick = () => {
      S.loop = 0;
      if (!shownNow() || !S.parts || !S.parts.box.isConnected) { hideView(); return; }
      const rect = slotRect();
      const splitRect = S.split ? box(S.parts.splitArea) : null;
      const off = S.dragging || document.hidden || rect.width < 8 || rect.height < 8 || panelOver() || overlayOver(rect, splitRect);
      // (split view's other page goes and comes back with the page: both are native views)
      if (off) { park(); if (S.split) placeSplit(null); } else { place(rect); if (S.split) placeSplit(splitBounds(splitRect)); }
      S.loop = requestAnimationFrame(tick);
    };
    S.loop = requestAnimationFrame(tick);
  }
  function stopLoop() { if (S.loop) cancelAnimationFrame(S.loop); S.loop = 0; }

  // The backend hears whether the pane is open: a session's browser tools then work in the
  // tab on show here, the page the owner is looking at (browser_agent.TabRoutes).
  let paneSaid = null;
  function tellPane(force = false) {
    const open = shownNow() && Boolean(browser());
    if (!force && open === paneSaid) return;
    paneSaid = open;
    F.send({ type: 'code_browser_pane', open });
  }

  // The pane closed, or another took its place: the view comes off, and full screen with it.
  // Esc pressed in the pane that none of its own took ends here (escHere).
  function watchPane() {
    const pane = paneEl();
    if (!pane) return;
    new MutationObserver(() => {
      tellPane();
      if (!shownNow()) { if (S.loop || S.placed) hideView(); document.body.classList.remove('cb-page-full', 'cb-full'); drawFull(); } else startLoop();
    }).observe(pane, { attributes: true, attributeFilter: ['hidden', 'data-kind'] });
    pane.addEventListener('keydown', escHere);
  }

  // ── width: half the window by default, the left edge dragged to change it ──

  function savedWidth() { try { return Number(localStorage.getItem(WIDTH_KEY)) || 0; } catch (_) { return 0; } }
  function applyWidth(px) {
    const main = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.jc-main') : null;
    const left = main && typeof main.getBoundingClientRect === 'function' ? Math.max(0, Math.round(main.getBoundingClientRect().left)) : 0;
    const avail = left > 0 ? Math.max(PANE_MIN + MAIN_MIN, window.innerWidth - left - 16) : window.innerWidth;
    const w = paneWidth(px || savedWidth(), avail);
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
    const a = appRoot();
    const feature = a && a.feature;
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
    const pick = root.edenCodeCodePick || root.jarvisCodePick;
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
    b.onState((st) => {
      const before = S.st || {};
      const was = before.url;
      S.st = st || {};
      if (S.parts && was !== S.st.url && !S.parts.find.hidden && S.findText) { S.findText = ''; S.parts.findCount.textContent = ''; }
      // a page went on its way: bookmarks and history make way for it (as the old dock's)
      if (S.panel === 'library' && S.st.loading && !before.loading) closePanel();
      drawState();
      drawOffer();
      if (S.panel === 'tabs') drawTabSearch();
    });
    // A page's own full screen (a video) is a class of its own: ending it leaves the browser's
    // full screen as it was before (on or off).
    b.onPageFullscreen((on) => { if (shownNow() || !on) { document.body.classList.toggle('cb-page-full', Boolean(on) && shownNow()); S.placed = ''; } });
    // Esc pressed in the page (main.js): the browser's full screen ends; the rest of a page's
    // Esc is its own.
    if (b.onEscape) b.onEscape(() => { if (shownNow()) escape(escapeStep({ full: isFull(), pageFull: isPageFull(), page: true })); });
    if (b.onFound) b.onFound((r) => { if (S.parts) S.parts.findCount.textContent = t(findLabel(r, S.parts.findInput.value)); });
    if (b.onDownload) b.onDownload((d) => { if (inCode()) onDownload(d); });
    if (b.onNote) b.onNote((n) => { if (inCode() && shownNow() && n && n.text) note(n.text); });
    const a = appRoot();
    const bridge = a && a.feature;
    if (bridge && bridge.on) {
      bridge.on('feature:browser:site-state', (site) => { S.unsafe = Boolean(site && site.unsafe); if (S.parts) S.parts.setKind(); });
      bridge.on('feature:browser:ask', () => adoptAsks());
      // split view on or off, or its right-hand tab changed (browser-parity.js sendSplit)
      bridge.on('feature:browser:split', (next) => { S.split = next && next.on ? next : null; drawSplit(); });
    }
  }

  // A key: the page's (main.js browserShortcut, through app.js browserKey) or the window's own
  // (own: the window's capture of it, or paneKey), while the pane is the browser on show.
  function key(action, own = false) {
    if (!S.parts) return;
    const b = browser();
    const tabsNow = (S.st.tabs || []).filter((x) => !x.popout);
    switch (action) {
      case 'address': focusAddress(); break;
      case 'find': openFind(); break;
      case 'close': if (typeof closePane === 'function') closePane(); break;
      case 'full': setFull(!isFull()); break;
      case 'new-tab': if (b) b.tab('new'); setTimeout(focusAddress, 120); break;
      case 'close-tab': if (tabsNow.length > 1) { if (b) b.tab('close'); } else if (typeof closePane === 'function') closePane(); break;
      case 'reload': nav('reload'); break;
      case 'back': nav('back'); break;
      case 'forward': nav('forward'); break;
      case 'print': ask({ action: 'print' }); break;
      case 'devtools': ask({ action: 'devtools', mode: 'docked', toggle: true }).then(drawState); break;
      case 'bookmark': toggleBookmark(); break;
      case 'history': toggleLibrary('history'); break;
      case 'tab-search': toggleTabSearch(); break;
      // (the page's ⇧⌘N: features/browser.js opens it, on the same browser:shortcut)
      case 'private-tab': if (own) feature('private-tab'); break;
      default:
        if (['reopen', 'next', 'previous', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(action) || /^tab[1-9]$/.test(action)) shortcut(action);
    }
  }

  function toggle() {
    if (shownNow()) { if (typeof closePane === 'function') closePane(); } else F.openPane('browser');
  }

  F.registerPane('browser', { title: 'Browser', render: (body) => render(body) });
  const browserHandle = { agentStart, agentEnd, checkStart, checkEnd, key, toggle, run: (id) => runMenu(String(id || '')), open: (url) => { F.openPane('browser'); const b = browser(); if (b && url) b.nav('go', url); } };
  root.edenCodeCodeBrowser = browserHandle;
  root.jarvisCodeBrowser = browserHandle;

  // The globe only where there's a browser to show (the app); a window in a web browser has none.
  function showButton() {
    const btn = F.$('jc-browser');
    if (btn && inCode()) btn.hidden = !browser();
  }
  showButton();
  hookApp();
  watchPane();
  window.addEventListener('keydown', windowKey, true);
  // ⌥⌘B: the Browser pane (⇧⌘B is the Agent board's).
  document.addEventListener('keydown', (e) => {
    if (!inCode() || !browser() || (F.$('cc') && F.$('cc').hidden)) return;
    if (e.code === 'KeyB' && e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); toggle(); }
  });
  F.on('jc_select', () => { if (shownNow()) { askServers(); drawAgent(); } });
  F.on('hello', () => { if (shownNow()) askServers(); if (inCode()) tellPane(true); });
})(typeof window === 'object' ? window : globalThis);
