// Click an element to send it (Eden Code's Pick mode, features/code_pick.py), in the page
// itself: app/features/element-pick.js registers this for the built-in browser's tabs; it
// runs in each tab's main frame, in an isolated world (the page's own scripts can neither see
// nor fake it), and only does anything when the app asks:
// - start: Pick mode. What the pointer is over is outlined (a box of the app's own, in a
//   closed shadow root, that never takes the pointer), with its tag and size; a click takes
//   it (the page never gets that click), Escape gives up. Only the person's own pointer and
//   keys count (isTrusted), never events the page makes up.
// - tree: the page's elements as a screen reader meets them (role, name, box), for the
//   spoken way ("pick the button under the price": features/code_pick.py finds it).
// - capture {index}: one element of the last tree, taken as a click takes it.
// - stop: Pick mode off.
// What's taken: a unique CSS selector, the role and name, the outer HTML (trimmed: long
// attribute values cut, at most HTML_MAX characters), the key computed styles and the box
// in the page's view (the app cuts its picture out of the tab). The app checks the tab is a
// page on this Mac (or a file the owner opened) before asking, and again after.
//
// The helpers at the top work without a page: node --test loads this file on its own
// (tests/web/code-pick.test.mjs).
'use strict';

(() => {
  const squash = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const HTML_MAX = 4000; // element_words.PICK_HTML_MAX
  const ATTR_MAX = 160; // a longer attribute value (an inline picture, a style) is cut
  const NAME_MAX = 160;
  const NODES_MAX = 800; // code_pick.NODES_MAX
  const SCAN_MAX = 6000; // elements looked at for one tree
  const STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
    'background-image', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
    'border', 'border-radius', 'box-shadow', 'opacity', 'gap', 'flex-direction', 'justify-content',
    'align-items', 'grid-template-columns', 'z-index',
  ];
  // Values that say nothing about how it looks: left out.
  const STYLE_NOISE = new Set(['', 'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'visible', 'start']);

  // An element's outer HTML, short enough for a message: long attribute values cut, runs
  // of spaces as one, and at most HTML_MAX characters (said when it was cut).
  function trimHtml(html, max = HTML_MAX) {
    let out = String(html || '').replace(/\s+/g, ' ');
    out = out.replace(/(\s[\w:-]+=")([^"]*)"/g, (m, head, value) => (value.length > ATTR_MAX ? `${head}${value.slice(0, ATTR_MAX)}…"` : m));
    const cut = out.length > max;
    return { html: cut ? `${out.slice(0, max - 1)}…` : out, cut };
  }

  // The computed styles worth knowing (getPropertyValue of each key), the uninteresting left out.
  function keyStyles(get) {
    const out = {};
    for (const key of STYLE_KEYS) {
      let value = '';
      try { value = squash(get(key)); } catch (_) { value = ''; }
      if (!STYLE_NOISE.has(value)) out[key] = value.slice(0, 200);
    }
    return out;
  }

  const ROLE_OF_TAG = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', svg: 'img', nav: 'navigation',
    main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', table: 'table',
    tr: 'row', ul: 'list', ol: 'list', li: 'listitem', article: 'article', section: 'region', dialog: 'dialog',
    p: 'paragraph', summary: 'button', option: 'option', label: 'text', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  };
  const INPUT_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio',
    search: 'searchbox', range: 'slider', hidden: '',
  };
  // An element's role as a screen reader has it: its own role attribute, else its tag's.
  function roleOf({ tag = '', role = '', type = '', href = false } = {}) {
    const own = squash(role).split(' ')[0].toLowerCase();
    if (own && own !== 'presentation' && own !== 'none') return own;
    const t = String(tag).toLowerCase();
    if (t === 'a') return href ? 'link' : '';
    if (t === 'input') { const k = String(type || 'text').toLowerCase(); return k in INPUT_ROLE ? INPUT_ROLE[k] : 'textbox'; }
    return ROLE_OF_TAG[t] || '';
  }

  // The first name an element has, as a screen reader takes it.
  function nameFrom(parts) {
    for (const part of parts) {
      const words = squash(part);
      if (words) return words.length > NAME_MAX ? `${words.slice(0, NAME_MAX - 1)}…` : words;
    }
    return '';
  }

  const SAFE = /^[A-Za-z][\w-]*$/;
  // A CSS selector that matches this element alone (count(selector) says how many it
  // matches): its id when that is unique, else the path down from the nearest unique place,
  // each step its tag, two classes and its place among its kind.
  function selectorFor(el, count) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 12; node = node.parentElement) {
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === 'html') break;
      if (node.id && SAFE.test(node.id) && count(`#${node.id}`) === 1) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = tag;
      const classes = [...(node.classList || [])].filter((c) => SAFE.test(c)).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
      if (count(parts.join(' > ')) === 1 && tag !== 'body') break;
    }
    return parts.join(' > ');
  }

  const H = { trimHtml, keyStyles, roleOf, nameFrom, selectorFor, STYLE_KEYS, HTML_MAX, NODES_MAX };
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = H;
    return;
  }
  if (window !== window.top) return; // the page itself only, never its frames
  if (!/^https?:|^file:/.test(location.href)) return;

  const { ipcRenderer } = require('electron');

  // ── an element as the session gets it ──

  const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch (_) { return 0; } };

  function textOf(id) {
    const el = id ? document.getElementById(id) : null;
    return el ? el.innerText || el.textContent || '' : '';
  }

  function nameOf(el) {
    const label = el.labels && el.labels.length ? el.labels[0].innerText : '';
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(textOf).join(' ');
    const ownText = el.childElementCount > 40 ? '' : (el.innerText || '');
    return nameFrom([el.getAttribute('aria-label'), labelledBy, el.getAttribute('alt'), label, ownText, el.getAttribute('title'),
      el.getAttribute('placeholder'), el.value && typeof el.value === 'string' && el.type !== 'password' ? el.value : '']);
  }

  function role(el) {
    return roleOf({ tag: el.tagName, role: el.getAttribute('role') || '', type: el.getAttribute('type') || '', href: el.hasAttribute('href') });
  }

  // Words of its own, not only its children's: "$19.99" in a span, a label's text.
  function ownWords(el) {
    for (const child of el.childNodes) if (child.nodeType === 3 && squash(child.nodeValue)) return true;
    return false;
  }

  function shown(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
    return r;
  }

  function take(el) {
    if (!el || !el.isConnected) return { ok: false, message: 'That element is gone from the page.' };
    let r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      r = el.getBoundingClientRect();
    }
    const computed = getComputedStyle(el);
    const { html, cut } = trimHtml(el.outerHTML);
    return {
      ok: true,
      pick: {
        url: location.href,
        title: document.title,
        selector: selectorFor(el, count),
        role: role(el) || (ownWords(el) ? 'text' : ''),
        name: nameOf(el),
        tag: el.tagName.toLowerCase(),
        html,
        html_cut: cut,
        styles: keyStyles((key) => computed.getPropertyValue(key)),
        box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      },
    };
  }

  // ── the tree, for the spoken way ──

  let lastTree = [];
  function tree() {
    const nodes = [];
    lastTree = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let scanned = 0;
    for (let el = walker.currentNode; el && scanned < SCAN_MAX && nodes.length < NODES_MAX; el = walker.nextNode()) {
      scanned += 1;
      if (el === host) continue;
      const kind = role(el) || (ownWords(el) ? 'text' : '');
      if (!kind || ['main', 'generic'].includes(kind)) continue;
      const r = shown(el);
      if (!r) continue;
      const name = ['list', 'navigation', 'contentinfo', 'banner', 'region', 'form', 'table', 'article', 'complementary'].includes(kind)
        ? nameFrom([el.getAttribute('aria-label'), (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(textOf).join(' ')])
        : nameOf(el);
      if (kind === 'text' && !name) continue;
      lastTree.push(el);
      // (Page coordinates: what's under what holds whatever the scroll.)
      nodes.push({ i: lastTree.length - 1, role: kind, name, box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] });
    }
    return { ok: true, url: location.href, title: document.title, nodes };
  }

  // ── Pick mode ──

  let host = null;
  let frame = null;
  let tag = null;
  let hover = null;
  let finish = null; // resolves the start command: the element taken, or given up

  function draw() {
    if (!frame) return;
    if (!hover) { frame.style.display = 'none'; tag.style.display = 'none'; return; }
    const r = hover.getBoundingClientRect();
    Object.assign(frame.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = `${hover.tagName.toLowerCase()}${hover.id ? `#${hover.id}` : ''}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    Object.assign(tag.style, { display: 'block', left: `${Math.max(0, r.left)}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` });
  }

  function under(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el !== host && el !== document.documentElement ? el : null;
  }

  const swallow = (e) => { if (e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); } };
  function onMove(e) { if (!e.isTrusted) return; hover = under(e); draw(); }
  function onClick(e) {
    if (!e.isTrusted) return;
    swallow(e);
    const el = under(e) || hover;
    if (el && el !== document.body) end(take(el));
  }
  function onKey(e) {
    if (!e.isTrusted) return;
    if (e.key === 'Escape') { swallow(e); end({ ok: false, cancelled: true, message: 'Nothing picked.' }); }
  }
  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick'];

  function begin() {
    end({ ok: false, cancelled: true }); // one Pick mode at a time
    host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>.f{position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #0a84ff;background:rgba(10,132,255,.12);border-radius:3px;display:none}'
      + '.t{position:fixed;z-index:2147483647;pointer-events:none;font:600 11px/18px -apple-system,Helvetica,sans-serif;color:#fff;background:#0a84ff;border-radius:4px;padding:0 6px;white-space:nowrap;display:none}'
      + '.h{position:fixed;z-index:2147483647;pointer-events:none;right:12px;bottom:12px;font:500 12px/1.4 -apple-system,Helvetica,sans-serif;color:#fff;background:rgba(0,0,0,.78);border-radius:8px;padding:6px 10px}</style>'
      + '<div class="f"></div><div class="t"></div><div class="h" role="status">Pick an element · Esc to cancel</div>';
    frame = shadow.querySelector('.f');
    tag = shadow.querySelector('.t');
    document.documentElement.append(host);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    for (const type of BLOCKED) window.addEventListener(type, swallow, true);
    window.addEventListener('scroll', draw, true);
    return new Promise((resolve) => { finish = resolve; });
  }

  function end(result) {
    if (host) host.remove();
    host = frame = tag = hover = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    for (const type of BLOCKED) window.removeEventListener(type, swallow, true);
    window.removeEventListener('scroll', draw, true);
    const done = finish;
    finish = null;
    if (done) done(result);
  }

  const COMMANDS = {
    start: () => begin(),
    stop: () => { end({ ok: false, cancelled: true, message: 'Nothing picked.' }); return { ok: true }; },
    tree: () => tree(),
    capture: (args) => {
      const el = lastTree[Number(args.index)];
      return el ? take(el) : { ok: false, message: 'The page changed: read it again.' };
    },
  };
  ipcRenderer.on('element-pick:command', async (_event, message) => {
    const { id, action, args } = message || {};
    let result;
    try {
      const fn = COMMANDS[action];
      result = fn ? await fn(args || {}) : { ok: false, message: `Unknown command ${action}` };
    } catch (err) {
      result = { ok: false, message: String(err && err.message ? err.message : err) };
    }
    ipcRenderer.send('element-pick:result', { id, result });
  });
  window.addEventListener('pagehide', () => end({ ok: false, cancelled: true, message: 'The page went away.' }));
})();
