// A small stand-in document for the window's feature scripts (web/features/*.js), for the
// tests that need more of the page than one hand-made node: a tree that knows where it is
// (isConnected, contains, closest), the selectors the features use (tag, #id, .class,
// [attr], [attr="v"], descendants, commas), the focus and what happens to it when the
// focused element leaves the page (it goes to the body, as in a browser: a pane redrawn
// under the keyboard loses its place), and events that bubble. It isn't a browser: no
// layout, no CSS, insertAdjacentHTML does nothing. load() runs a feature's source with the
// window's globals it reads (currentPane, el, $ and the like) given by the test.

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { return this.parentNode ? this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null : null; }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  _detach() {
    const p = this.parentNode;
    if (!p) return;
    const doc = this.ownerDocument;
    if (doc._active && this.contains(doc._active) && this.isConnected) doc._active = null;  // the focus goes to the body
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  _adopt(kids, at) {
    const nodes = kids.map((k) => (typeof k === 'string' ? this.ownerDocument.createTextNode(k) : k));
    for (const n of nodes) n._detach();
    for (const n of nodes) n.parentNode = this;
    this.childNodes.splice(at === undefined ? this.childNodes.length : at, 0, ...nodes);
  }
  append(...kids) { this._adopt(kids); }
  appendChild(kid) { this._adopt([kid]); return kid; }
  prepend(...kids) { this._adopt(kids, 0); }
  insertBefore(kid, ref) {
    if (!ref) return this.appendChild(kid);
    kid._detach();
    this._adopt([kid], this.childNodes.indexOf(ref));
    return kid;
  }
  removeChild(kid) { kid._detach(); return kid; }
  replaceChildren(...kids) {
    for (const k of [...this.childNodes]) k._detach();
    this._adopt(kids);
  }
  remove() { this._detach(); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const k of [...this.childNodes]) k._detach();
    if (v !== '' && v !== null && v !== undefined) this._adopt([String(v)]);
  }
}

class Text extends Node {
  constructor(doc, text) { super(doc); this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.listeners = {};
    this.style = {};
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? el.getAttribute(`data-${kebab(k)}`) ?? undefined : undefined),
      set: (_, k, v) => { el.setAttribute(`data-${kebab(k)}`, String(v)); return true; },
      deleteProperty: (_, k) => { el.removeAttribute(`data-${kebab(k)}`); return true; },
      has: (_, k) => el.hasAttribute(`data-${kebab(k)}`),
    });
    this.classList = {
      _get: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      add(...c) { el.className = [...new Set([...this._get(), ...c])].join(' '); },
      remove(...c) { el.className = this._get().filter((x) => !c.includes(x)).join(' '); },
      contains(c) { return this._get().includes(c); },
      toggle(c, on) {
        const want = on === undefined ? !this.contains(c) : Boolean(on);
        if (want) this.add(c); else this.remove(c);
        return want;
      },
    };
  }
  get nodeName() { return this.tagName; }
  get localName() { return this.tagName.toLowerCase(); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get tabIndex() {
    const v = this.getAttribute('tabindex');
    if (v !== null) return Number(v);
    return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1;
  }
  set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get htmlFor() { return this.getAttribute('for') || ''; }
  set htmlFor(v) { this.setAttribute('for', v); }
  get innerHTML() { return ''; }
  set innerHTML(v) { this.textContent = ''; }
  insertAdjacentHTML() {}
  setAttribute(k, v) { this.attributes.set(String(k).toLowerCase(), String(v)); }
  getAttribute(k) { const v = this.attributes.get(String(k).toLowerCase()); return v === undefined ? null : v; }
  hasAttribute(k) { return this.attributes.has(String(k).toLowerCase()); }
  removeAttribute(k) { this.attributes.delete(String(k).toLowerCase()); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) { return this.ownerDocument._dispatch(this, ev); }
  click() { if (!this.disabled) this.dispatchEvent(this.ownerDocument.event('click')); }
  focus() {
    if (!this.isConnected || this.disabled) return;
    const doc = this.ownerDocument;
    if (doc._active === this) return;
    doc._active = this;
    for (const fn of this.listeners.focus || []) fn(doc.event('focus', { target: this }));
  }
  blur() { if (this.ownerDocument._active === this) this.ownerDocument._active = null; }
  select() { this.selected = true; } // (a field's text selected: what's typed next replaces it)
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  matches(sel) { return parse(sel).some((chain) => matchChain(this, chain)); }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// Selectors: comma lists of descendant chains of compounds (tag#id.class[attr="v"]).
function parse(sel) {
  return String(sel).split(',').map((part) => part.trim().split(/\s+/).map((compound) => {
    const c = { tag: null, id: null, classes: [], attrs: [] };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|(\*)/g;
    let m;
    while ((m = re.exec(compound))) {
      if (m[1]) c.tag = m[1].toUpperCase();
      else if (m[2]) c.id = m[2];
      else if (m[3]) c.classes.push(m[3]);
      else if (m[4]) c.attrs.push([m[4].toLowerCase(), m[5] ?? m[6] ?? m[7]]);
    }
    return c;
  }));
}
function matchOne(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const [k, v] of c.attrs) {
    if (!el.hasAttribute(k)) return false;
    if (v !== undefined && el.getAttribute(k) !== v) return false;
  }
  return true;
}
function matchChain(el, chain) {
  if (!matchOne(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let n = el.parentNode; n && n.nodeType === 1 && i >= 0; n = n.parentNode) if (matchOne(n, chain[i])) i -= 1;
  return i < 0;
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this._active = null;
    this.listeners = {};
    this.documentElement = this.createElement('html');
    this._adopt([this.documentElement]);
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
  }
  get isConnected() { return true; }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(text) { return new Text(this, text); }
  createDocumentFragment() { return new Element(this, '#fragment'); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  event(type, extra = {}) {
    const ev = {
      type, defaultPrevented: false, stopped: false, button: 0,
      metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
      preventDefault() { ev.defaultPrevented = true; }, stopPropagation() { ev.stopped = true; },
      stopImmediatePropagation() { ev.stopped = true; },
      ...extra,
    };
    return ev;
  }
  _dispatch(target, ev) {
    ev.target = target;
    for (let n = target; n && !ev.stopped; n = n === this ? null : n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners[ev.type] || [])]) fn(ev);
    }
    return !ev.defaultPrevented;
  }
  // A key pressed where the focus is.
  key(key, extra = {}) { return this._dispatch(this.activeElement, this.event('keydown', { key, ...extra })); }
}

export function makeDocument() { return new Document(); }

// Runs a feature's source in a scope with the window's globals: `scope` is read live (a
// test can change scope.currentPane later), and anything not in it is Node's own.
export function load(source, scope) {
  // eslint-disable-next-line no-new-func
  new Function('__scope', `with (__scope) {\n${source}\n}`)(scope);
}

// The window's el(tag, cls, text) (app.js).
export function elFor(document) {
  return (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
}
