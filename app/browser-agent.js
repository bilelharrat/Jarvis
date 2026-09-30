// JARVIS's and Jarvis Code's hands in the built-in browser, over the Chrome DevTools Protocol
// (browser-cdp.js): accessibility snapshots whose elements carry refs ([e12]), actions on
// those refs with real input events, waits, and the tab bookkeeping they need. main.js owns
// the tabs and the window; it hands this module what it needs as hooks (createAgent).
//
// Input lands like a person's: the element is scrolled into view, its box is measured, and
// the click goes to its middle only if nothing covers it there. Chromium drops real input to
// a page that has never been on screen (a tab behind the one on show, or every tab while the
// window is covered by other apps), so the agent turns the tab's background throttling off
// before it acts (the input then goes through), checks with a harmless probe that it does,
// and otherwise has the page's own click() and events stand in. Hovering and dragging need
// the page drawing, so on a page that isn't they ask for the tab to be shown first.
'use strict';

const { nativeImage } = require('electron');
const { TabCdp, CdpError } = require('./browser-cdp');
const core = require('./browser-agent-core');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PRESSES = new Set(['click', 'dblclick', 'rightclick', 'check', 'uncheck']);
const KINDS = new Set([...PRESSES, 'hover', 'type', 'fill', 'press', 'select', 'drag', 'scroll']);
const BUTTONS = { left: 1, right: 2, middle: 4 };
const MOD_BITS = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const FIELD_MAX = 20;
const WAIT_MAX = 30000;
const IDLE_MS = 10 * 60 * 1000; // a tab the agent hasn't used this long goes back to normal
const TABS_MAX = 30;
const SHOT_WIDTH = 1280; // the widest picture Claude gets
const PIECE_CSS = 1600; // a full page comes as pictures this tall (CSS pixels)
const FULL_MAX = 9600; // and no taller than this in all
// Numbered marks on what can be acted on, drawn over the page for a screenshot and removed.
const MARKS_STYLE = `.b{position:fixed;box-sizing:border-box;border:2px solid #ff3b30;border-radius:3px}
.t{position:fixed;box-sizing:border-box;height:15px;padding:0 3px;font:600 11px/15px -apple-system,Helvetica,sans-serif;color:#fff;background:#ff3b30;border-radius:3px;white-space:nowrap}`;
const NOT_DRAWING = 'needs the page drawing on screen: its tab on show in the browser, with the J.A.R.V.I.S. window not covered by other apps. Click instead, or ask the user to bring the window forward.';

// What a ref points at, as the purchase guard and the risky-press check need it.
const DESCRIBE = `function () {
  const el = this;
  const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const type = String(el.type || attr('type') || '').toLowerCase();
  const text = (n) => (n ? (n.innerText || n.textContent || '') : '');
  const by = attr('aria-labelledby').split(/\\s+/).filter(Boolean).map((id) => text(el.ownerDocument.getElementById(id))).join(' ');
  const labels = el.labels ? [...el.labels].map(text).join(' ') : '';
  const legend = el.closest && (type === 'radio' || type === 'checkbox') ? text(el.closest('fieldset') && el.closest('fieldset').querySelector('legend')) : '';
  const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const editable = Boolean(el.isContentEditable) || tag === 'textarea'
    || (tag === 'input' && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/.test(type));
  return {
    tag, type,
    name: clean(attr('name'), 120), id: clean(el.id, 120), placeholder: clean(attr('placeholder'), 160),
    autocomplete: clean(attr('autocomplete'), 60),
    label: clean([legend, by, attr('aria-label'), labels, attr('title')].filter(Boolean).join(' '), 240),
    editable,
    submits: Boolean((el.type === 'submit' || (tag === 'input' && type === 'image')) && el.form),
    file: tag === 'input' && type === 'file',
    select: tag === 'select',
    multiple: Boolean(el.multiple),
    checkable: tag === 'input' && (type === 'checkbox' || type === 'radio'),
    href: tag === 'a' ? clean(el.href, 300) : '',
  };
}`;

const FOCUS = `function (clear) {
  const el = this;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const type = String(el.type || '').toLowerCase();
  const editable = Boolean(el.isContentEditable) || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/.test(type));
  if (!editable) return { editable: false };
  el.focus({ preventScroll: true });
  const doc = el.ownerDocument;
  if (clear) {
    if (typeof el.select === 'function' && !el.isContentEditable) { try { el.select(); } catch (e) {} }
    else { const r = doc.createRange(); r.selectNodeContents(el); const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r); }
  } else if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {}
  }
  const active = doc.activeElement;
  return { editable: true, focused: active === el || (active && el.contains(active)) || el.isContentEditable };
}`;

const CONTAINS = `function (hit) {
  for (let n = hit; n; n = n.parentNode || n.host) if (n === this) return { inside: true };
  if (this.labels) for (const l of this.labels) if (l === hit || l.contains(hit)) return { inside: true };
  const el = hit && hit.nodeType === 1 ? hit : hit && hit.parentElement;
  if (!el) return { inside: false, what: 'something else' };
  const id = el.id ? '#' + el.id : '';
  const cls = el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
  const words = String(el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return { inside: false, what: '<' + el.tagName.toLowerCase() + id + cls + '>' + (words ? ' “' + words + '”' : '') };
}`;

const QUIET = (quietMs, maxMs) => `new Promise((resolve) => {
  let timer = null;
  const done = () => { try { mo.disconnect(); } catch (e) {} clearTimeout(timer); clearTimeout(cap); resolve(true); };
  const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${quietMs}); });
  const cap = setTimeout(done, ${maxMs});
  timer = setTimeout(done, ${quietMs});
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})`;

const SELECT = `function (wanted) {
  if (this.tagName !== 'SELECT') return { error: 'not a select' };
  const options = [...this.options];
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const picked = [];
  for (const w of wanted) {
    const want = norm(w);
    const o = options.find((x) => norm(x.value) === want) || options.find((x) => norm(x.label) === want)
      || options.find((x) => norm(x.label).startsWith(want)) || options.find((x) => norm(x.label).includes(want));
    if (!o) return { error: 'no option', want: String(w).slice(0, 80), options: options.slice(0, 40).map((x) => x.label.trim()) };
    if (o.disabled) return { error: 'disabled option', want: o.label.trim() };
    if (!picked.includes(o)) picked.push(o);
  }
  if (!this.multiple && picked.length > 1) return { error: 'single' };
  this.focus();
  for (const o of options) o.selected = picked.includes(o);
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: picked.map((x) => x.label.trim()) };
}`;

const CHECKED = `function () {
  const type = String(this.type || '').toLowerCase();
  if (this.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) return { state: Boolean(this.checked), radio: type === 'radio' };
  const a = this.getAttribute('aria-checked') || this.getAttribute('aria-pressed') || this.getAttribute('aria-selected');
  if (a === 'true' || a === 'false' || a === 'mixed') return { state: a === 'true', radio: this.getAttribute('role') === 'radio' };
  return { state: null };
}`;

function modifierBits(list) {
  let bits = 0;
  for (const m of Array.isArray(list) ? list : String(list || '').split(/[+,\s]+/)) bits |= MOD_BITS[String(m).toLowerCase()] || 0;
  return bits;
}

function describeEntry(entry) {
  const role = core.clip(entry.role, 40);
  return `${entry.ref} (${role}${entry.name ? ` “${core.clip(entry.name, 60)}”` : ''})`;
}

// A picture no wider than Claude takes, as PNG base64.
function fit(image) {
  const { width } = image.getSize();
  return (width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH }) : image).toPNG().toString('base64');
}

function createAgent(hooks) {
  return new BrowserAgent(hooks);
}

class BrowserAgent {
  constructor(hooks) {
    this.hooks = hooks;
    this.registry = new core.RefRegistry();
    this.state = new Map(); // webContents id -> tab state
    this.synthetic = 0;
    this.sweeper = null;
  }

  // Tabs the agent left alone for a while: the debugger lets go (the page no longer keeps an
  // accessibility tree or request log for it) and the tab is throttled in the background again.
  sweep(now = Date.now()) {
    for (const tab of this.state.values()) {
      if (now - tab.lastUse < IDLE_MS || tab.keep) continue;
      if (tab.view.webContents.isDestroyed()) continue;
      if (tab.cdp.attached) tab.cdp.detach();
      if (tab.unthrottled && !this.hooks.isShown(tab.view)) {
        try { tab.view.webContents.setBackgroundThrottling(true); } catch { /* going */ }
        tab.unthrottled = false;
      }
      tab.delivery = null;
    }
  }

  // ── tabs ──

  views() {
    return this.hooks.tabs();
  }

  byId(id) {
    return this.views().find((v) => v.webContents.id === Number(id)) || null;
  }

  // The tab a command is for: the one it names, else the one on show.
  target(args = {}) {
    if (args.tab !== undefined && args.tab !== null && args.tab !== '') {
      const view = this.byId(args.tab);
      if (!view) throw new CdpError(`Tab ${args.tab} is closed. List the open tabs with browser_tabs.`, 'closed');
      return view;
    }
    return this.hooks.ensureBrowser();
  }

  tab(view) {
    const wc = view.webContents;
    let tab = this.state.get(wc.id);
    if (!tab) {
      tab = { view, id: wc.id, cdp: new TabCdp(wc), refs: new core.RefTable(this.registry, wc.id), lastUse: 0 };
      this.state.set(wc.id, tab);
      wc.once('destroyed', () => {
        this.state.delete(tab.id);
        this.registry.forgetTab(tab.id);
      });
    }
    tab.lastUse = Date.now();
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
      if (this.sweeper.unref) this.sweeper.unref();
    }
    return tab;
  }

  where(view, extra = {}) {
    const wc = view.webContents;
    return { tab: wc.id, url: wc.getURL(), title: wc.getTitle(), shown: this.hooks.isShown(view), ...extra };
  }

  // Refs are for one page: a new document makes the old ones stale.
  sync(tab) {
    if (tab.refs.docGen !== tab.cdp.docGen) tab.refs.newDocument(tab.cdp.docGen);
  }

  // ── the snapshot ──

  async frames(tab) {
    const { cdp } = tab;
    const local = [];
    const walk = (node, session) => {
      if (!node || !node.frame || local.length >= 25) return;
      local.push({ session, frameId: node.frame.id, url: node.frame.url || '' });
      for (const child of node.childFrames || []) walk(child, session);
    };
    const root = await cdp.send('Page.getFrameTree');
    walk(root.frameTree, '');
    cdp.mainFrameId = root.frameTree.frame.id;
    const sessions = [...cdp.sessions.keys()];
    const trees = await Promise.all(sessions.map((s) => cdp.send('Page.getFrameTree', {}, { session: s, timeout: 4000 }).catch(() => null)));
    trees.forEach((t, i) => { if (t) walk(t.frameTree, sessions[i]); });
    const key = (f) => `${f.session}|${f.frameId}`;
    const byFrameId = new Map(local.map((f) => [f.frameId, key(f)]));
    const frames = {};
    await Promise.all(local.map(async (f) => {
      const r = await cdp.send('Accessibility.getFullAXTree', { frameId: f.frameId }, { session: f.session || undefined, timeout: 12000 }).catch(() => null);
      if (r && Array.isArray(r.nodes)) frames[key(f)] = { nodes: r.nodes, session: f.session, frameId: f.frameId, url: f.url };
    }));
    // Which document each <iframe> shows.
    const owners = new Map();
    const lookups = [];
    for (const [k, frame] of Object.entries(frames)) {
      for (const n of frame.nodes) {
        const role = n.role && n.role.value;
        if ((role === 'Iframe' || role === 'IframePresentational') && n.backendDOMNodeId !== undefined) lookups.push([k, frame.session, n.backendDOMNodeId]);
      }
    }
    await Promise.all(lookups.slice(0, 40).map(async ([k, session, backend]) => {
      const d = await cdp.send('DOM.describeNode', { backendNodeId: backend }, { session: session || undefined, timeout: 4000 }).catch(() => null);
      const child = d && d.node && d.node.frameId;
      if (child && byFrameId.has(child)) owners.set(`${k}:${backend}`, byFrameId.get(child));
    }));
    return { frames, owners, main: key(local[0]) };
  }

  // Whether each element is in the viewport: one DOMSnapshot per process, laid over the
  // viewport of the document it's in (a frame's own, inside its <iframe> box).
  async viewports(tab, collected) {
    const { cdp } = tab;
    const docs = new Map(); // frame key -> { bounds: Map(backend -> [x,y,w,h]), scroll: [x,y], owner?: {key, backend} }
    const sessions = new Set(Object.values(collected.frames).map((f) => f.session));
    await Promise.all([...sessions].map(async (session) => {
      const snap = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, { session: session || undefined, timeout: 10000 }).catch(() => null);
      if (!snap || !Array.isArray(snap.documents)) return;
      const keys = snap.documents.map((d) => `${session}|${snap.strings[d.frameId]}`);
      snap.documents.forEach((d, i) => {
        const bounds = new Map();
        const backend = (d.nodes && d.nodes.backendNodeId) || [];
        const layout = d.layout || { nodeIndex: [], bounds: [] };
        layout.nodeIndex.forEach((ni, li) => bounds.set(backend[ni], layout.bounds[li]));
        const entry = docs.get(keys[i]) || {};
        Object.assign(entry, { bounds, scroll: [d.scrollOffsetX || 0, d.scrollOffsetY || 0] });
        docs.set(keys[i], entry);
        const rare = d.nodes && d.nodes.contentDocumentIndex;
        if (rare && Array.isArray(rare.index)) {
          rare.index.forEach((ni, j) => {
            const child = keys[rare.value[j]];
            if (!child) return;
            const c = docs.get(child) || {};
            c.owner = { key: keys[i], backend: backend[ni] };
            docs.set(child, c);
          });
        }
      });
    }));
    // Frames in other processes: their <iframe> element is in the parent's process.
    await Promise.all([...cdp.sessions.entries()].map(async ([session, info]) => {
      const key = `${session}|${info.targetId}`;
      if (!docs.has(key)) return;
      const owner = await cdp.send('DOM.getFrameOwner', { frameId: info.targetId }, { session: info.parent || undefined, timeout: 4000 }).catch(() => null);
      if (!owner) return;
      for (const [k, d] of docs) {
        if (k.startsWith(`${info.parent || ''}|`) && d.bounds && d.bounds.has(owner.backendNodeId)) {
          docs.get(key).owner = { key: k, backend: owner.backendNodeId };
          break;
        }
      }
    }));
    // DOMSnapshot measures in device pixels (twice CSS pixels on a Retina screen), in the
    // document's own coordinates; so does the layout viewport here.
    let root = { x: 0, y: 0, width: 2560, height: 1600 };
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, { timeout: 4000 }).catch(() => null);
    if (metrics) {
      const css = metrics.cssLayoutViewport || {};
      const device = metrics.layoutViewport;
      const ratio = metrics.contentSize && metrics.cssContentSize && metrics.cssContentSize.width ? metrics.contentSize.width / metrics.cssContentSize.width : 1;
      root = device
        ? { x: device.pageX || 0, y: device.pageY || 0, width: device.clientWidth, height: device.clientHeight }
        : { x: (css.pageX || 0) * ratio, y: (css.pageY || 0) * ratio, width: (css.clientWidth || 1280) * ratio, height: (css.clientHeight || 800) * ratio };
    }
    const viewOf = new Map();
    const visible = (key, depth = 0) => {
      if (viewOf.has(key)) return viewOf.get(key);
      const d = docs.get(key);
      let view = null;
      if (key === collected.main) view = root;
      else if (d && d.owner && depth < 8) {
        const parent = docs.get(d.owner.key);
        const box = parent && parent.bounds && parent.bounds.get(d.owner.backend);
        const pv = visible(d.owner.key, depth + 1);
        if (box && pv && core.intersects({ x: box[0], y: box[1], width: box[2], height: box[3] }, pv)) {
          view = { x: d.scroll[0], y: d.scroll[1], width: box[2], height: box[3] };
        }
      }
      viewOf.set(key, view);
      return view;
    };
    return (frameKey, backend) => {
      const d = docs.get(frameKey);
      const box = d && d.bounds && d.bounds.get(backend);
      const view = visible(frameKey);
      return Boolean(box && view && box[2] > 0 && box[3] > 0 && core.intersects({ x: box[0], y: box[1], width: box[2], height: box[3] }, view));
    };
  }

  async snapshot(view, args = {}) {
    const tab = this.tab(view);
    await tab.cdp.ensure();
    this.sync(tab);
    const collected = await this.frames(tab);
    if (!collected.frames[collected.main]) return { ok: false, message: "The page didn't give me its structure. Wait for it to load, or try browser_read.", ...this.where(view) };
    let inView = () => false;
    try { inView = await this.viewports(tab, collected); } catch { /* no viewport data: no in-view marks */ }
    tab.frames = collected.frames;
    const within = args.within ? String(args.within).trim().replace(/^\[|\]$/g, '') : '';
    if (within) {
      const found = tab.refs.lookup(within);
      if (found.error) return { ok: false, message: found.error, ...this.where(view) };
    }
    const built = core.buildSnapshot({
      frames: collected.frames,
      main: collected.main,
      childFrame: (k, b) => collected.owners.get(`${k}:${b}`) || '',
      inView,
      table: tab.refs,
      interactive: Boolean(args.interactive),
      within,
    });
    const page = core.renderLines(built.lines, { offset: Number(args.offset) || 0, budget: core.LINE_BUDGET });
    return {
      ok: true, ...this.where(view), text: page.text, next: page.next, total: page.total, start: page.start,
      refs: built.refCount, changes: built.counts, first: built.first, snapshot: tab.refs.snapshots,
      frames: Object.keys(collected.frames).length, dialog: this.dialogNote(tab),
    };
  }

  // ── refs ──

  entry(tab, ref) {
    const found = tab.refs.lookup(ref);
    if (found.error) throw new CdpError(found.error, 'stale');
    const e = found.entry;
    const frame = (tab.frames && tab.frames[e.frameKey]) || null;
    const [session, frameId] = e.frameKey.split('|');
    return { ...e, session: frame ? frame.session : session, frameId: frame ? frame.frameId : frameId };
  }

  async info(tab, entry) {
    try {
      return await tab.cdp.onNode(entry, DESCRIBE);
    } catch (err) {
      if (err.code === 'gone' || err.code === 'navigated') throw new CdpError(`${entry.ref} is no longer on the page. Take a new browser_snapshot.`, 'stale');
      throw err;
    }
  }

  // What these refs are (for the purchase guard): their words, what kind of field.
  async describe(view, args = {}) {
    const tab = this.tab(view);
    await tab.cdp.ensure();
    this.sync(tab);
    const out = {};
    const refs = (Array.isArray(args.refs) ? args.refs : []).slice(0, FIELD_MAX + 2);
    for (const ref of refs) {
      const entry = this.entry(tab, ref);
      const info = await this.info(tab, entry);
      out[entry.ref] = { ...info, role: entry.role, ax: entry.name, risky: core.risky(entry.name, { role: entry.role, submits: info.submits }) };
    }
    if (args.focused) out.focused = await this.focusedInfo(tab).catch(() => null);
    return { ok: true, ...this.where(view), refs: out };
  }

  async focusedInfo(tab) {
    const { cdp } = tab;
    const ctx = await cdp.world('', cdp.mainFrameId);
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el && el !== document.body ? el : null; })()`,
      contextId: ctx, objectGroup: 'jarvis-agent',
    });
    if (!r.result || !r.result.objectId) return null;
    const d = await cdp.send('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: DESCRIBE, returnByValue: true });
    const info = d.result ? d.result.value : null;
    if (info) info.risky = core.risky(info.label || info.name, { role: info.tag === 'a' ? 'link' : '', submits: info.submits });
    return info;
  }

  // ── input ──

  async dispatch(tab, method, params, session) {
    this.synthetic += 1;
    this.hooks.setSynthetic(true); // on the Research Center's locked pages, only JARVIS's input goes through
    try {
      return await tab.cdp.send(method, params, { session: session || undefined, timeout: 5000 });
    } finally {
      this.synthetic -= 1;
      if (!this.synthetic) this.hooks.setSynthetic(false);
    }
  }

  // Real input goes to this tab from now on, even behind other tabs or apps: a page that
  // was never on screen drops it otherwise. (The tab keeps running at full speed until the
  // agent has left it alone for a while: sweep.)
  async prepare(view) {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    const tab = this.tab(view);
    if (!tab.unthrottled) {
      try { wc.setBackgroundThrottling(false); tab.unthrottled = true; } catch { /* going */ }
    }
  }

  async visibility(tab) {
    try {
      const ctx = await tab.cdp.world('', tab.cdp.mainFrameId);
      const r = await tab.cdp.send('Runtime.evaluate', { expression: 'document.visibilityState', contextId: ctx, returnByValue: true }, { timeout: 3000 });
      return r.result ? r.result.value : 'visible';
    } catch {
      return 'visible';
    }
  }

  // Whether real input reaches this page now: a press of Shift on its own (which does
  // nothing), heard by a listener in the agent's own world. Kept for a few seconds.
  async delivers(tab) {
    const { cdp } = tab;
    const known = tab.delivery;
    if (known && known.docGen === cdp.docGen && Date.now() - known.at < 8000) return known.ok;
    let ok = false;
    try {
      const ctx = await cdp.world('', cdp.mainFrameId);
      await cdp.send('Runtime.evaluate', { contextId: ctx, expression: "window.__heard = false; if (!window.__listening) { window.__listening = true; addEventListener('keydown', (e) => { if (e.key === 'Shift') window.__heard = true; }, true); } true" });
      const shift = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 };
      // the first input after a page loads can be lost, and a busy Mac can take a moment
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        await this.dispatch(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...shift, modifiers: 8 });
        await this.dispatch(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...shift });
        for (let i = 0; i < 6 && !ok; i++) {
          const r = await cdp.send('Runtime.evaluate', { contextId: ctx, expression: 'window.__heard === true', returnByValue: true }, { timeout: 2000 });
          ok = Boolean(r.result && r.result.value);
          if (!ok) await sleep(50);
        }
      }
    } catch { ok = false; }
    tab.delivery = { ok, at: Date.now(), docGen: cdp.docGen };
    return ok;
  }

  // How input can reach this tab: "live" (all of it), "pressed" (clicks and keys, but the
  // page isn't drawing: no hovering or dragging), or "page" (real input doesn't reach it, so
  // the page's own click() and events stand in).
  async readiness(tab) {
    await this.prepare(tab.view);
    if ((await this.visibility(tab)) === 'visible') return 'live';
    return (await this.delivers(tab)) ? 'pressed' : 'page';
  }

  async frameOffset(tab, session, depth = 0) {
    if (!session || depth > 6) return { x: 0, y: 0 };
    const info = tab.cdp.sessions.get(session);
    if (!info) return { x: 0, y: 0 };
    const parent = info.parent || undefined;
    const owner = await tab.cdp.send('DOM.getFrameOwner', { frameId: info.targetId }, { session: parent });
    const box = await tab.cdp.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, { session: parent });
    const up = await this.frameOffset(tab, parent, depth + 1);
    return { x: box.model.content[0] + up.x, y: box.model.content[1] + up.y, owner: owner.backendNodeId, parent };
  }

  async quads(tab, session, backendNodeId) {
    const r = await tab.cdp.send('DOM.getContentQuads', { backendNodeId }, { session: session || undefined }).catch(() => ({ quads: [] }));
    return r.quads || [];
  }

  // Where to press this element, in the page's viewport; scrolled into view first, and only
  // if nothing covers it there.
  async point(tab, entry, { check = true } = {}) {
    const { cdp } = tab;
    const session = entry.session || undefined;
    if (session) {
      const off = await this.frameOffset(tab, session).catch(() => null);
      if (off && off.owner) await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: off.owner }, { session: off.parent }).catch(() => {});
    }
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, { session }).catch((err) => {
      if (err.code === 'gone') throw new CdpError(`${entry.ref} is no longer on the page. Take a new browser_snapshot.`, 'stale');
    });
    let backend = entry.backendNodeId;
    let pt = core.clickPoint(await this.quads(tab, session, backend));
    if (!pt) { // a checkbox drawn by its label: press the label
      const label = await this.labelNode(tab, entry);
      if (label) {
        backend = label;
        pt = core.clickPoint(await this.quads(tab, session, label));
      }
    }
    if (!pt) throw new CdpError(`${describeEntry(entry)} isn't showing on the page (it has no size); it may be hidden or collapsed.`, 'hidden');
    const off = session ? await this.frameOffset(tab, session) : { x: 0, y: 0 };
    const at = { x: pt.x + off.x, y: pt.y + off.y };
    if (check) await this.uncovered(tab, entry, at, pt, off);
    return at;
  }

  async labelNode(tab, entry) {
    try {
      const ctx = await tab.cdp.world(entry.session, entry.frameId);
      const { object } = await tab.cdp.send('DOM.resolveNode', { backendNodeId: entry.backendNodeId, executionContextId: ctx, objectGroup: 'jarvis-agent' }, { session: entry.session || undefined });
      const r = await tab.cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.labels && this.labels[0] ? this.labels[0] : null; }' }, { session: entry.session || undefined });
      if (!r.result || !r.result.objectId) return 0;
      const d = await tab.cdp.send('DOM.describeNode', { objectId: r.result.objectId }, { session: entry.session || undefined });
      return d.node ? d.node.backendNodeId : 0;
    } catch {
      return 0;
    }
  }

  // How far the document in this frame is scrolled, in CSS pixels.
  async scrolled(tab, session) {
    const m = await tab.cdp.send('Page.getLayoutMetrics', {}, { session: session || undefined, timeout: 3000 }).catch(() => null);
    const vp = m && m.cssLayoutViewport;
    return { x: (vp && vp.pageX) || 0, y: (vp && vp.pageY) || 0 };
  }

  // What's at this viewport point (DOM.getNodeForLocation takes document coordinates).
  async hitAt(tab, point, session) {
    const s = await this.scrolled(tab, session);
    return tab.cdp.send('DOM.getNodeForLocation', {
      // as a real click finds it: things that let clicks through (pointer-events: none) don't count
      x: Math.round(point.x + s.x), y: Math.round(point.y + s.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false,
    }, { session: session || undefined }).catch(() => null);
  }

  // Nothing else is at that point: not a cookie banner, a sticky header or a menu over it.
  async uncovered(tab, entry, at, local, off) {
    const { cdp } = tab;
    let hit = await this.hitAt(tab, at);
    if (!hit) return; // can't tell: a person would press it
    if (entry.session) {
      if (off && off.owner && hit.backendNodeId !== off.owner && !off.parent) {
        throw new CdpError(`${describeEntry(entry)} is covered by something else on the page. Close what's over it first, or scroll.`, 'covered');
      }
      hit = await this.hitAt(tab, local, entry.session);
      if (!hit) return;
    }
    if (hit.backendNodeId === entry.backendNodeId) return;
    const session = entry.session || undefined;
    let verdict = null;
    try {
      const ctx = await cdp.world(entry.session, entry.frameId);
      const target = await cdp.send('DOM.resolveNode', { backendNodeId: entry.backendNodeId, executionContextId: ctx, objectGroup: 'jarvis-agent' }, { session });
      const other = await cdp.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: ctx, objectGroup: 'jarvis-agent' }, { session });
      const r = await cdp.send('Runtime.callFunctionOn', { objectId: target.object.objectId, functionDeclaration: CONTAINS, arguments: [{ objectId: other.object.objectId }], returnByValue: true }, { session });
      verdict = r.result && r.result.value;
    } catch {
      verdict = { inside: false, what: 'something in another frame' };
    }
    if (verdict && !verdict.inside) {
      throw new CdpError(`${describeEntry(entry)} is covered by ${verdict.what}. Deal with that first (it may be a dialog, a banner or a menu), or scroll.`, 'covered');
    }
  }

  async click(tab, at, { button = 'left', count = 1, modifiers = 0, live = true } = {}) {
    if (live) await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, modifiers });
    for (let i = 1; i <= count; i++) {
      await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button, buttons: BUTTONS[button] || 1, clickCount: i, modifiers });
      await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button, buttons: 0, clickCount: i, modifiers });
    }
  }

  async key(tab, key, mode) {
    if (mode === 'page') return this.pageKey(tab, key);
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: key.modifiers };
    await this.dispatch(tab, 'Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, text: key.text, unmodifiedText: key.text, commands: key.commands });
    await this.dispatch(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return '';
  }

  // A tab that can't take real input: the page's own events stand in (Enter submits the
  // form the focus is in, text goes in as typed text).
  async pageKey(tab, key) {
    if (key.printable && key.text) {
      await this.dispatch(tab, 'Input.insertText', { text: key.text });
      return '';
    }
    const ctx = await tab.cdp.world('', tab.cdp.mainFrameId);
    await tab.cdp.send('Runtime.evaluate', {
      contextId: ctx,
      expression: `(() => {
        let el = document.activeElement || document.body;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        const init = { key: ${JSON.stringify(key.key)}, code: ${JSON.stringify(key.code)}, bubbles: true, cancelable: true, composed: true,
          shiftKey: ${Boolean(key.modifiers & 8)}, ctrlKey: ${Boolean(key.modifiers & 2)}, altKey: ${Boolean(key.modifiers & 1)}, metaKey: ${Boolean(key.modifiers & 4)} };
        const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        if (go && init.key === 'Enter' && el.form && el.tagName === 'INPUT') el.form.requestSubmit();
        if (go && init.key === 'Enter' && (el.tagName === 'BUTTON' || el.tagName === 'A')) el.click();
        return true;
      })()`,
    });
    return ' (the tab isn’t on screen, so the key went to the page itself)';
  }

  async typeInto(tab, entry, text, { clear = true } = {}) {
    let r;
    try {
      r = await tab.cdp.onNode(entry, FOCUS, [Boolean(clear)]);
    } catch (err) {
      if (err.code === 'gone' || err.code === 'navigated') throw new CdpError(`${entry.ref} is no longer on the page. Take a new browser_snapshot.`, 'stale');
      throw err;
    }
    if (!r || !r.editable) throw new CdpError(`${describeEntry(entry)} isn't a text field. Click it instead, or pick a textbox from the snapshot.`, 'kind');
    if (text) await this.dispatch(tab, 'Input.insertText', { text }, entry.session);
    else if (clear) await tab.cdp.onNode(entry, 'function () { this.ownerDocument.execCommand("delete"); }');
  }

  // For main.js's own click by words and Enter after typing: on a page that isn't drawing
  // (behind other tabs or apps), Electron's sendInputEvent doesn't reach it, so the press
  // goes in over the DevTools protocol, or as the page's own click() and events. Returns
  // false when the page is on screen and main.js's usual input will do.
  async pressHidden(view, { x, y, key } = {}) {
    const tab = this.tab(view);
    await this.prepare(view);
    await tab.cdp.ensure();
    this.sync(tab);
    if ((await this.visibility(tab)) === 'visible') return false;
    const mode = (await this.delivers(tab)) ? 'pressed' : 'page';
    if (key) {
      await this.key(tab, core.parseKey(key), mode);
      return true;
    }
    const zoom = view.webContents.getZoomFactor() || 1; // main.js's points are zoomed, CDP's aren't
    const at = { x: x / zoom, y: y / zoom };
    if (mode === 'pressed') await this.click(tab, at, { live: false });
    else {
      const ctx = await tab.cdp.world('', tab.cdp.mainFrameId);
      await tab.cdp.send('Runtime.evaluate', { contextId: ctx, expression: `(() => { const el = document.elementFromPoint(${at.x}, ${at.y}); if (el) el.click(); return Boolean(el); })()` });
    }
    return true;
  }

  // ── acting ──

  async act(view, args = {}) {
    if (this.hooks.research && this.hooks.research(view)) {
      return { ok: false, message: 'This tab is the BSH Research Center: work in it with the research tools, which it answers to.', ...this.where(view) };
    }
    const tab = this.tab(view);
    await tab.cdp.ensure();
    this.sync(tab);
    const kind = String(args.kind || 'click').toLowerCase();
    if (!KINDS.has(kind)) return { ok: false, message: `I don't know how to “${core.clip(kind, 30)}”. Use one of: ${[...KINDS].join(', ')}.` };
    const refs = kind === 'fill' ? (Array.isArray(args.fields) ? args.fields : []).map((f) => f && f.ref) : [args.ref, ...(kind === 'drag' ? [args.to] : [])];
    if (kind === 'fill' && (!refs.length || refs.length > FIELD_MAX)) return { ok: false, message: `Give fill between 1 and ${FIELD_MAX} fields, each with a ref and text.` };
    if (kind !== 'press' && refs.some((r) => !r)) return { ok: false, message: `${kind} needs a ref from browser_snapshot${kind === 'drag' ? ' and a “to” ref' : ''}.` };
    const entries = [];
    try {
      for (const ref of refs) if (ref) entries.push(this.entry(tab, ref));
    } catch (err) {
      return { ok: false, message: err.message, ...this.where(view) };
    }
    const infos = [];
    for (const e of entries) infos.push(await this.info(tab, e));
    // Anything that starts a run, sends, posts, pays or deletes waits for the user's OK.
    const risky = [];
    entries.forEach((e, i) => {
      const presses = PRESSES.has(kind) || kind === 'drag' || (kind === 'press' && /^(enter|return|space| )$/i.test(String(args.key || '')));
      if (presses && core.risky(e.name, { role: e.role, submits: infos[i].submits })) risky.push(e.name || e.role);
    });
    const pressKey = kind === 'press' && /^(enter|return|space| )$/i.test(String(args.key || '').trim());
    if (pressKey && !entries.length) { // Enter or Space on whatever has the focus presses it
      const focused = await this.focusedInfo(tab).catch(() => null);
      if (focused && focused.risky) risky.push(focused.label || focused.name || 'the focused button');
    }
    if (risky.length && !args.force) {
      const label = core.clip(risky[0], 60);
      return { ok: false, needsConfirm: true, label, message: `“${label}” needs the user's OK first.`, ...this.where(view) };
    }
    const mode = await this.readiness(tab);
    const before = { docGen: tab.cdp.docGen, url: view.webContents.getURL(), tabs: new Set(this.views().map((v) => v.webContents.id)) };
    let note = '';
    const run = (async () => {
      switch (kind) {
        case 'click': case 'dblclick': case 'rightclick': {
          const button = kind === 'rightclick' ? 'right' : ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left';
          const count = kind === 'dblclick' ? 2 : 1;
          if (mode === 'page' && (button !== 'left' || args.modifiers)) {
            throw new CdpError(`A click with another button or keys held ${NOT_DRAWING}`, 'hidden');
          }
          const at = await this.point(tab, entries[0]); // in view, and nothing over it
          if (mode === 'page') {
            await tab.cdp.onNode(entries[0], `function (n) { for (let i = 0; i < n; i++) this.click(); if (n > 1) this.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true })); }`, [count]);
            note = ' (the tab isn’t on screen, so the page’s own click stood in)';
            return `${count > 1 ? 'Double-clicked' : 'Clicked'} ${describeEntry(entries[0])}`;
          }
          await this.click(tab, at, { button, count, modifiers: modifierBits(args.modifiers), live: mode === 'live' });
          return `${count > 1 ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked'} ${describeEntry(entries[0])}`;
        }
        case 'hover': {
          if (mode !== 'live') throw new CdpError(`Hovering ${NOT_DRAWING}`, 'hidden');
          const at = await this.point(tab, entries[0]);
          await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
          return `Hovered over ${describeEntry(entries[0])}`;
        }
        case 'type': {
          await this.typeInto(tab, entries[0], String(args.text ?? ''), { clear: args.clear !== false });
          if (args.submit) note = await this.key(tab, core.parseKey('Enter'), mode);
          return `Typed into ${describeEntry(entries[0])}${args.submit ? ' and pressed Enter' : ''}`;
        }
        case 'fill': {
          const done = [];
          for (let i = 0; i < entries.length; i++) {
            await this.typeInto(tab, entries[i], String((args.fields[i] && args.fields[i].text) ?? ''), { clear: true });
            done.push(entries[i].ref);
          }
          return `Filled ${done.length} field${done.length === 1 ? '' : 's'} (${done.join(', ')})`;
        }
        case 'press': {
          const key = core.parseKey(args.key);
          if (!key) throw new CdpError(`“${core.clip(args.key, 30)}” isn't a key I know. Use names like Enter, Tab, Escape, ArrowDown, Backspace, Meta+A or a single character.`, 'kind');
          if (entries[0]) {
            const r = await tab.cdp.onNode(entries[0], 'function () { this.scrollIntoView({ block: "center" }); this.focus({ preventScroll: true }); return true; }');
            if (!r) throw new CdpError(`${describeEntry(entries[0])} can't take the focus.`, 'kind');
          }
          note = await this.key(tab, key, mode);
          return `Pressed ${key.label}${entries[0] ? ` in ${describeEntry(entries[0])}` : ''}`;
        }
        case 'select': {
          const wanted = (Array.isArray(args.values) ? args.values : [args.values ?? args.text]).filter((v) => v !== undefined && v !== null && String(v).trim()).slice(0, 30).map(String);
          if (!wanted.length) throw new CdpError('Say which option to select (its label or value).', 'kind');
          const r = await tab.cdp.onNode(entries[0], SELECT, [wanted]);
          if (r && r.error === 'not a select') throw new CdpError(`${describeEntry(entries[0])} isn't a drop-down list (<select>). Click it to open it, then click the option.`, 'kind');
          if (r && r.error === 'single') throw new CdpError(`${describeEntry(entries[0])} takes one option only.`, 'kind');
          if (r && r.error) throw new CdpError(`${describeEntry(entries[0])} has no ${r.error === 'disabled option' ? 'available ' : ''}option “${r.want}”.${r.options ? ` Its options: ${r.options.map((o) => `“${o}”`).join(', ')}.` : ''}`, 'kind');
          return `Selected ${r.selected.map((s) => `“${s}”`).join(', ')} in ${describeEntry(entries[0])}`;
        }
        case 'check': case 'uncheck': {
          const want = kind === 'check';
          const now = await tab.cdp.onNode(entries[0], CHECKED);
          if (!now || now.state === null) throw new CdpError(`${describeEntry(entries[0])} isn't a checkbox, radio button or switch.`, 'kind');
          if (now.state === want) return `${describeEntry(entries[0])} was already ${want ? 'checked' : 'unchecked'}`;
          if (!want && now.radio) throw new CdpError(`${describeEntry(entries[0])} is a radio button: check another option instead.`, 'kind');
          const at = await this.point(tab, entries[0]);
          if (mode === 'page') await tab.cdp.onNode(entries[0], 'function () { this.click(); }');
          else await this.click(tab, at, { live: mode === 'live' });
          let after = null;
          for (let i = 0; i < 12; i++) { // the page may take a moment to show it
            after = await tab.cdp.onNode(entries[0], CHECKED).catch(() => null);
            if (!after || after.state === want) break;
            await sleep(80);
          }
          if (after && after.state !== want) throw new CdpError(`I clicked ${describeEntry(entries[0])} but it didn't change.`, 'unchanged');
          return `${want ? 'Checked' : 'Unchecked'} ${describeEntry(entries[0])}`;
        }
        case 'drag': {
          if (mode !== 'live') throw new CdpError(`Dragging ${NOT_DRAWING}`, 'hidden');
          const from = await this.point(tab, entries[0]);
          const to = await this.point(tab, entries[1], { check: false });
          await this.drag(tab, from, to);
          return `Dragged ${describeEntry(entries[0])} onto ${describeEntry(entries[1])}`;
        }
        case 'scroll': {
          await this.point(tab, entries[0], { check: false });
          return `Scrolled ${describeEntry(entries[0])} into view`;
        }
        default:
          throw new CdpError(`Unknown action ${kind}`, 'kind');
      }
    })();
    let outcome;
    try {
      outcome = await run;
    } catch (err) {
      run.catch(() => {});
      if (err instanceof CdpError) return { ok: false, message: err.message, ...this.where(view) };
      throw err;
    }
    if (kind !== 'hover' && kind !== 'scroll') await this.settle(tab, before);
    const created = this.views().filter((v) => !before.tabs.has(v.webContents.id)).map((v) => v.webContents.id);
    const navigated = tab.cdp.docGen !== before.docGen;
    return {
      ok: true, message: `${outcome}${note}.`, navigated, newTabs: created, dialog: this.dialogNote(tab), ...this.where(view),
    };
  }

  async drag(tab, from, to) {
    await this.dispatch(tab, 'Input.setInterceptDrags', { enabled: true }).catch(() => {});
    let data = null;
    const intercepted = tab.cdp.waitFor((m) => m === 'Input.dragIntercepted', 1500).then((e) => { data = e && e.params.data; });
    try {
      await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 12; i++) {
        const x = from.x + ((to.x - from.x) * i) / 12;
        const y = from.y + ((to.y - from.y) * i) / 12;
        await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        if (data) break;
      }
      await Promise.race([intercepted, sleep(120)]);
      if (data) {
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await this.dispatch(tab, 'Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
        }
      }
      await this.dispatch(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      await this.dispatch(tab, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
  }

  // After an action: a new page it started loads, then the page stops changing (no DOM
  // changes and no requests for a moment), within a few seconds.
  async settle(tab, before, ms = 4500) {
    const wc = tab.view.webContents;
    const end = Date.now() + ms;
    await sleep(60);
    if (wc.isDestroyed()) return;
    if (wc.isLoading() || tab.cdp.docGen !== before.docGen) await this.loaded(wc, 12000);
    await this.quiet(tab, end);
  }

  loaded(wc, ms) {
    if (wc.isDestroyed() || !wc.isLoading()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wc.removeListener('did-stop-loading', done); resolve(); };
      const timer = setTimeout(done, ms);
      wc.once('did-stop-loading', done);
    });
  }

  async quiet(tab, end) {
    const { cdp } = tab;
    const left = () => end - Date.now();
    if (left() > 50) {
      try {
        const ctx = await cdp.world('', cdp.mainFrameId);
        await cdp.send('Runtime.evaluate', { expression: QUIET(300, Math.max(50, left() - 100)), contextId: ctx, awaitPromise: true, returnByValue: true }, { timeout: Math.max(200, left() + 300) });
      } catch { /* a page that went away, or never settles: carry on */ }
    }
    while (left() > 0 && (cdp.busy(4000) > 0 || Date.now() - cdp.lastNetwork < 250)) await sleep(100);
  }

  // ── waiting ──

  async wait(view, args = {}) {
    const tab = this.tab(view);
    await tab.cdp.ensure();
    const ms = Math.max(100, Math.min(WAIT_MAX, Number(args.ms) || (args.text || args.gone || args.selector || args.url || args.idle ? 10000 : 1000)));
    const start = Date.now();
    const wants = [];
    if (args.text) wants.push(`“${core.clip(args.text, 60)}” on the page`);
    if (args.gone) wants.push(`“${core.clip(args.gone, 60)}” gone`);
    if (args.selector) wants.push(`${core.clip(args.selector, 60)} showing`);
    if (args.url) wants.push(`the address matching ${core.clip(args.url, 80)}`);
    if (args.idle) wants.push('the network quiet');
    if (!wants.length) {
      await sleep(ms);
      return { ok: true, message: `Waited ${(ms / 1000).toFixed(1)} s.`, ...this.where(view) };
    }
    const check = `(() => {
      const body = (document.body && document.body.innerText) || '';
      const low = body.toLowerCase();
      let sel = null;
      ${args.selector ? `try { const el = document.querySelector(${JSON.stringify(String(args.selector))}); sel = Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); } catch (e) { sel = 'bad'; }` : ''}
      return { text: ${args.text ? `low.includes(${JSON.stringify(String(args.text).toLowerCase())})` : 'true'},
        gone: ${args.gone ? `!low.includes(${JSON.stringify(String(args.gone).toLowerCase())})` : 'true'}, sel };
    })()`;
    let last = null;
    while (Date.now() - start < ms) {
      if (tab.cdp.nativeDialog) break;
      let page = { text: true, gone: true, sel: true };
      if (args.text || args.gone || args.selector) {
        try {
          const ctx = await tab.cdp.world('', tab.cdp.mainFrameId);
          const r = await tab.cdp.send('Runtime.evaluate', { expression: check, contextId: ctx, returnByValue: true }, { timeout: 3000 });
          page = (r.result && r.result.value) || page;
        } catch { page = { text: false, gone: false, sel: false }; }
        if (page.sel === 'bad') return { ok: false, message: `${core.clip(args.selector, 80)} isn't a valid CSS selector.`, ...this.where(view) };
      }
      const urlOk = args.url ? core.urlMatches(view.webContents.getURL(), args.url) : true;
      const idleOk = args.idle ? tab.cdp.busy(8000) === 0 && Date.now() - tab.cdp.lastNetwork >= 500 : true;
      last = { text: page.text, gone: page.gone, sel: args.selector ? page.sel === true : true, url: urlOk, idle: idleOk };
      if (Object.values(last).every(Boolean)) {
        return { ok: true, message: `Done waiting after ${((Date.now() - start) / 1000).toFixed(1)} s: ${wants.join(', ')}.`, ...this.where(view), dialog: this.dialogNote(tab) };
      }
      await sleep(200);
    }
    const missing = [];
    if (last) {
      if (!last.text) missing.push(wants.find((w) => w.endsWith('on the page')));
      if (!last.gone) missing.push(wants.find((w) => w.endsWith('gone')));
      if (!last.sel) missing.push(wants.find((w) => w.endsWith('showing')));
      if (!last.url) missing.push(wants.find((w) => w.startsWith('the address')));
      if (!last.idle) missing.push('the network quiet');
    }
    const dialog = this.dialogNote(tab);
    return {
      ok: false,
      message: dialog ? `Stopped waiting: ${dialog}` : `Still not ${missing.filter(Boolean).join(', ') || wants.join(', ')} after ${(ms / 1000).toFixed(1)} s.`,
      ...this.where(view), dialog,
    };
  }

  // ── dialogs the page shows ──

  dialogNote(tab) {
    const d = tab.cdp.nativeDialog;
    if (!d) return '';
    return `The page is showing a ${d.type} on screen: “${core.clip(d.message, 300)}”. The user has to answer it there.`;
  }

  // ── screenshots ──

  // What can be acted on and is in view, with its box in the viewport (CSS pixels): the refs a
  // screenshot's marks show, the same ones browser_snapshot gives.
  async markable(tab) {
    const collected = await this.frames(tab);
    if (!collected.frames[collected.main]) return [];
    let inView = () => false;
    try { inView = await this.viewports(tab, collected); } catch { /* none marked */ }
    tab.frames = collected.frames;
    const built = core.buildSnapshot({
      frames: collected.frames, main: collected.main, childFrame: (k, b) => collected.owners.get(`${k}:${b}`) || '',
      inView, table: tab.refs, interactive: true,
    });
    const lines = built.lines.filter((l) => l.ref && l.kind === 'control' && l.states.includes('in view')).slice(0, 150);
    const out = [];
    await Promise.all(lines.map(async (line) => {
      try {
        const entry = this.entry(tab, line.ref);
        const quad = core.clickPoint(await this.quads(tab, entry.session, entry.backendNodeId));
        if (!quad) return;
        const off = entry.session ? await this.frameOffset(tab, entry.session) : { x: 0, y: 0 };
        out.push({ ref: line.ref, role: line.role, name: line.name, x: quad.left + off.x, y: quad.top + off.y, width: quad.w, height: quad.h });
      } catch { /* gone meanwhile */ }
    }));
    const order = new Map(lines.map((l, i) => [l.ref, i]));
    return out.sort((a, b) => order.get(a.ref) - order.get(b.ref));
  }

  async drawMarks(tab, placed) {
    const ctx = await tab.cdp.world('', tab.cdp.mainFrameId);
    const html = placed.map((m) => `<div class="b" style="left:${m.box.x}px;top:${m.box.y}px;width:${m.box.width}px;height:${m.box.height}px"></div>`
      + `<div class="t" style="left:${m.label.x}px;top:${m.label.y}px">${m.ref}</div>`).join('');
    await tab.cdp.send('Runtime.evaluate', {
      contextId: ctx,
      expression: `(() => {
        if (window.__marks) window.__marks.remove();
        const host = document.createElement('jarvis-marks');
        host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = ${JSON.stringify(`<style>${MARKS_STYLE}</style>`)} + ${JSON.stringify(html)};
        document.documentElement.appendChild(host);
        window.__marks = host;
        return true;
      })()`,
    });
  }

  async clearMarks(tab) {
    try {
      const ctx = await tab.cdp.world('', tab.cdp.mainFrameId);
      await tab.cdp.send('Runtime.evaluate', { contextId: ctx, expression: 'if (window.__marks) { window.__marks.remove(); window.__marks = null; } true' }, { timeout: 3000 });
    } catch { /* the page went: so did the marks */ }
  }

  // A picture of the page as it is, over the DevTools protocol (it works for a tab behind the
  // one on show too): what's in view, or the whole page in pieces; with marks, each thing that
  // can be acted on carries its ref.
  async screenshot(view, args = {}) {
    const tab = this.tab(view);
    try {
      await tab.cdp.ensure();
    } catch (err) { // the page's developer tools are open: a plain picture of the tab on show still works
      if (args.marks || args.fullPage || !this.hooks.isShown(view)) throw err;
      const image = await view.webContents.capturePage();
      return { ok: true, ...this.where(view), pngs: [fit(image)], png: fit(image), legend: [], fullPage: false, cut: false };
    }
    this.sync(tab);
    const { cdp } = tab;
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, { timeout: 4000 });
    const vp = metrics.cssLayoutViewport || { clientWidth: 1280, clientHeight: 800 };
    let legend = [];
    let drawn = false;
    if (args.marks) {
      const items = await this.markable(tab);
      const placed = core.layoutMarks(items, { width: vp.clientWidth, height: vp.clientHeight });
      if (placed.length) {
        await this.drawMarks(tab, placed);
        drawn = true;
      }
      const byRef = new Map(items.map((i) => [i.ref, i]));
      legend = placed.map((p) => ({ ref: p.ref, role: byRef.get(p.ref).role, name: byRef.get(p.ref).name }));
    }
    const pngs = [];
    let cut = false;
    try {
      if (args.fullPage) {
        const size = metrics.cssContentSize || { width: vp.clientWidth, height: vp.clientHeight };
        const height = Math.min(Math.ceil(size.height), FULL_MAX);
        cut = size.height > FULL_MAX;
        const width = Math.ceil(Math.min(size.width, vp.clientWidth));
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, { timeout: 30000 });
        const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
        const px = image.getSize();
        const ratio = px.height / height || 1;
        for (let top = 0; top < px.height; top += Math.round(PIECE_CSS * ratio)) {
          const piece = image.crop({ x: 0, y: top, width: px.width, height: Math.min(Math.round(PIECE_CSS * ratio), px.height - top) });
          pngs.push(fit(piece));
        }
      } else {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, { timeout: 15000 });
        pngs.push(fit(nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))));
      }
    } finally {
      if (drawn) await this.clearMarks(tab);
    }
    return { ok: true, ...this.where(view), pngs, png: pngs[0], legend, fullPage: Boolean(args.fullPage), cut };
  }

  // ── tabs ──

  // Open a page: in a new tab of the agent's own (on show, or behind the one on show with
  // background), in the tab it names, or in the tab on show. A new tab reuses the tab on show
  // when that has never had a page (the browser's first, empty tab).
  async open(args = {}) {
    const url = this.hooks.toUrl(args.url);
    let view;
    if (args.newTab) {
      view = this.hooks.blankTab();
      if (view && args.owner && !view.agentOwner) view.agentOwner = args.owner;
      if (!view) {
        if (this.views().length >= TABS_MAX) {
          return { ok: false, message: `${this.views().length} tabs are open already. Close some with browser_tabs, or open this in a tab you have (tab).` };
        }
        view = this.hooks.addTab({ select: !args.background, owner: args.owner || '' });
      }
    } else {
      view = this.target(args);
    }
    const tab = this.tab(view);
    if (String(args.owner || '').startsWith('code:')) tab.keep = true; // a session's tab stays watched
    if (!args.background) {
      this.hooks.select(view);
      this.hooks.showBrowser();
    }
    this.hooks.markAsked();
    const wc = view.webContents;
    await wc.loadURL(url).catch(() => {});
    await this.loaded(wc, 20000);
    if (tab.cdp.attached) await this.quiet(tab, Date.now() + 1500);
    return { ok: true, ...this.where(view), opened: args.newTab ? 'new' : 'same', background: Boolean(args.background) };
  }

  // A page asking for a new window from a tab behind the one on show: a new tab behind too,
  // the same driver's (the act that clicked it reports it).
  popup(opener, url) {
    if (this.views().length >= TABS_MAX) return;
    const view = this.hooks.addTab({ select: false, owner: opener.agentOwner || '' });
    view.webContents.loadURL(this.hooks.toUrl(url)).catch(() => {});
  }

  tabs(args = {}) {
    const op = String(args.op || 'list');
    if (op === 'list') {
      return {
        ok: true,
        tabs: this.views().map((v) => ({
          id: v.webContents.id, title: v.webContents.getTitle(), url: v.webContents.getURL(),
          loading: v.webContents.isLoading(), shown: this.hooks.isShown(v), owner: v.agentOwner || '',
        })),
      };
    }
    const view = this.byId(args.id);
    if (!view) return { ok: false, message: `There's no tab ${args.id}. List the open tabs with browser_tabs.` };
    if (op === 'switch') {
      if (!args.background) {
        this.hooks.select(view);
        this.hooks.showBrowser();
      }
      return { ok: true, message: args.background ? `Working in tab ${view.webContents.id}, behind the one on show.` : `Showing tab ${view.webContents.id}.`, ...this.where(view) };
    }
    if (op === 'close') {
      const was = this.where(view);
      if (!this.hooks.close(view)) return { ok: false, message: "That's the only tab open; it stays." };
      return { ok: true, message: `Closed tab ${was.tab} (${was.title || was.url}).`, closed: was.tab };
    }
    return { ok: false, message: 'op must be list, switch or close (open with browser_open).' };
  }

  // ── the command switch ──

  handles(action) {
    return ['snapshot', 'describe', 'act', 'wait', 'open', 'tabs', 'screenshot'].includes(action);
  }

  async run(action, args = {}) {
    let view;
    try {
      view = action === 'tabs' || (action === 'open' && args.newTab) ? this.hooks.ensureBrowser() : this.target(args);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    try {
      switch (action) {
        case 'snapshot': return await this.snapshot(view, args);
        case 'describe': return await this.describe(view, args);
        case 'act': return await this.act(view, args);
        case 'wait': return await this.wait(view, args);
        case 'open': return await this.open(args);
        case 'tabs': return this.tabs(args);
        case 'screenshot': return await this.screenshot(view, args);
        default: return { error: `Unknown browser action ${action}` };
      }
    } catch (err) {
      if (err instanceof CdpError) return { ok: false, message: err.message, ...(view.webContents.isDestroyed() ? {} : this.where(view)) };
      throw err;
    }
  }
}

module.exports = { createAgent, BrowserAgent };
