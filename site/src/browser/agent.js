// Eden driving the cloud browser (browser/session.js): the tools of agent-tools.js run on the
// account's own tabs over CDP. The page is read and acted on from an isolated world of its own
// ("eden-agent": the page's scripts can't see it, call it or forge its element numbers); clicks,
// hovers and the wheel are real input events at the element's middle, text goes in as typed text.
// Every click, Enter, typed field and download is described first and checked against the approval
// rules (agent-tools.js approvalFor): held for an approval card, or refused (passwords, payment).

import { APPROVAL_TTL_MS, PERSONAL_SOURCE, SECRET_SOURCE, approvalFor, formatSnapshot, stepText } from './agent-tools.js';
import { REFUSED, addressAllowed, hostOf, toUrl } from './rules.js';

const WORLD = 'eden-agent';
const NEW_TAB = 'about:blank';

// The page as numbered elements and text, in page order (agent-tools.js formatSnapshot words it).
const SNAPSHOT = `(() => {
  const A = (globalThis.__edenAgent = { els: [null] });
  const nodes = []; let chars = 0;
  const INTER = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const shown = (e) => (e.checkVisibility ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : e.getClientRects().length > 0);
  const nameOf = (e) => String(e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('alt') || (e.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(e.type) ? e.value : '') || e.innerText || e.getAttribute('title') || e.getAttribute('placeholder') || (e.querySelector('img[alt]') || {}).alt || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
  const ROLES = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
  const INPUTS = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', file: 'file upload' };
  const roleOf = (e) => e.getAttribute('role') || ROLES[e.tagName] || (e.tagName === 'INPUT' ? INPUTS[e.type] || 'textbox' : e.isContentEditable ? 'textbox' : 'element');
  const short = (h) => { try { const u = new URL(h); return u.origin === location.origin ? (u.pathname + u.search).slice(0, 120) : u.href.slice(0, 120); } catch { return ''; } };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|CANVAS|VIDEO|AUDIO|OBJECT|EMBED)$/i;
  const BLOCK = 'p,li,td,th,dd,dt,blockquote,figcaption,label,article,section,div,main,header,footer,nav,aside';
  let lastBlock = null;
  const visit = (root) => {
    for (const c of root.childNodes) {
      if (nodes.length >= 500 || chars >= 16000) return;
      if (c.nodeType === 3) {
        const t = c.data.replace(/\\s+/g, ' ').trim();
        const p = c.parentElement;
        if (!t || !p || !shown(p)) continue;
        const block = p.closest(BLOCK);
        const last = nodes[nodes.length - 1];
        if (last && last.role === 'text' && block === lastBlock && last.name.length < 400) last.name += ' ' + t;
        else nodes.push({ role: 'text', name: t });
        lastBlock = block; chars += t.length + 1;
        continue;
      }
      if (c.nodeType !== 1 || SKIP.test(c.tagName)) continue;
      const e = c;
      if (e.matches(INTER)) {
        if (!shown(e) || e.closest('[aria-hidden="true"]')) continue;
        const ref = A.els.push(e) - 1;
        const node = { ref, role: roleOf(e), name: nameOf(e) };
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && !/^(submit|button|reset|image|checkbox|radio)$/i.test(e.type)) node.value = e.type === 'password' ? (e.value ? '••••' : '') : e.tagName === 'SELECT' ? (e.selectedOptions[0] ? e.selectedOptions[0].text : '') : String(e.value || '').slice(0, 80);
        if (/^(checkbox|radio)$/i.test(e.type) || /^(checkbox|radio|switch)$/.test(e.getAttribute('role') || '')) node.checked = Boolean(e.checked || e.getAttribute('aria-checked') === 'true');
        if (e.tagName === 'A') node.href = short(e.href);
        if (e.disabled || e.getAttribute('aria-disabled') === 'true') node.disabled = true;
        if (e.tagName === 'SELECT') node.name = (node.name || '').slice(0, 60) + ' options: ' + [...e.options].slice(0, 12).map((o) => o.text.trim()).join(' | ');
        nodes.push(node); chars += node.name.length + 20; lastBlock = null;
        continue;
      }
      if (/^H[1-6]$/.test(e.tagName) && !e.querySelector(INTER)) {
        const t = shown(e) ? e.innerText.replace(/\\s+/g, ' ').trim() : '';
        if (t) { nodes.push({ role: 'heading', level: Number(e.tagName[1]), name: t.slice(0, 200) }); chars += t.length; lastBlock = null; }
        continue;
      }
      if (e.shadowRoot) visit(e.shadowRoot);
      visit(e);
    }
  };
  visit(document.body || document.documentElement);
  return { url: location.href, title: document.title, nodes, scroll: { y: scrollY, h: document.documentElement.scrollHeight } };
})()`;

// One element, described for the approval rules (and its middle, in the page's CSS pixels).
const DESCRIBE = `(ref, scroll) => {
  const A = globalThis.__edenAgent;
  const e = ref === 0 ? (document.activeElement && document.activeElement !== document.body ? document.activeElement : null) : A && A.els[ref];
  if (!e) return ref === 0 ? { none: true } : { stale: true };
  if (!e.isConnected) return { stale: true };
  if (scroll) e.scrollIntoView({ block: 'center', inline: 'center' });
  const r = e.getBoundingClientRect();
  const f = e.form || e.closest('form');
  const PERSONAL = new RegExp(${JSON.stringify(PERSONAL_SOURCE)}, 'i');
  const SECRET = new RegExp(${JSON.stringify(SECRET_SOURCE)}, 'i');
  const words = (x) => [x.name, x.id, x.getAttribute && x.getAttribute('autocomplete'), x.getAttribute && x.getAttribute('placeholder'), x.getAttribute && x.getAttribute('aria-label'), x.labels && x.labels[0] && x.labels[0].innerText].filter(Boolean).join(' ');
  const fields = f ? [...f.elements].filter((x) => /^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName) && !/^(hidden|submit|button|reset|image)$/i.test(x.type)) : [];
  const filled = fields.filter((x) => (/^(checkbox|radio)$/i.test(x.type) ? false : x.value));
  const searchy = (x) => /search|query|^q$|keyword|find/i.test(words(x)) || x.type === 'search';
  const a = e.closest('a[href]');
  const label = e.labels && e.labels[0] ? e.labels[0].innerText.trim().slice(0, 100) : '';
  return {
    x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
    tag: e.tagName.toLowerCase(), type: String(e.type || ''), role: e.getAttribute('role') || '',
    text: String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200), name: e.getAttribute('name') || '', id: e.id || '',
    value: e.type === 'password' ? '' : String(e.value || '').slice(0, 100), aria: e.getAttribute('aria-label') || '', title: e.getAttribute('title') || '',
    href: a ? a.href : '', download: a ? a.getAttribute('download') || '' : '', autocomplete: e.getAttribute('autocomplete') || '', label, placeholder: e.getAttribute('placeholder') || '',
    editable: Boolean(e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName)),
    inForm: Boolean(f), formSearch: Boolean(f && (f.getAttribute('role') === 'search' || /search/i.test(f.action || '') || (fields.length > 0 && fields.length <= 3 && fields.some(searchy) && !fields.some((x) => x.type === 'password')))),
    formPersonal: filled.some((x) => x.type === 'email' || x.type === 'tel' || PERSONAL.test(words(x))),
    formHasSecret: fields.some((x) => x.type === 'password' || SECRET.test(words(x))),
    covered: (() => { const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(t && t !== e && !e.contains(t) && !t.contains(e)); })(),
  };
}`;

const FOCUS = `(ref) => { const e = globalThis.__edenAgent && globalThis.__edenAgent.els[ref]; if (!e || !e.isConnected) return false;
  e.focus(); if (e.select && /^(INPUT|TEXTAREA)$/.test(e.tagName)) e.select(); else if (e.isContentEditable) { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  return true; }`;
const CLEAR = `(ref) => { const e = globalThis.__edenAgent.els[ref]; if ('value' in e) { e.value = ''; } else e.textContent = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; }`;
const SELECT = `(ref, want) => { const e = globalThis.__edenAgent && globalThis.__edenAgent.els[ref]; if (!e || !e.isConnected) return { stale: true };
  if (e.tagName !== 'SELECT') return { error: 'not a drop-down' };
  const w = String(want).trim().toLowerCase();
  const o = [...e.options].find((x) => x.text.trim().toLowerCase() === w || x.value.toLowerCase() === w) || [...e.options].find((x) => x.text.toLowerCase().includes(w));
  if (!o) return { error: 'no such option', options: [...e.options].slice(0, 30).map((x) => x.text.trim()) };
  e.value = o.value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, text: o.text.trim() }; }`;
const CLICK_JS = `(ref) => { const e = globalThis.__edenAgent.els[ref]; e.click(); return true; }`;
const FIND = `(q) => { const t = document.body ? document.body.innerText : ''; const lo = t.toLowerCase(); const n = q.toLowerCase(); const out = []; let at = lo.indexOf(n), count = 0;
  while (at >= 0 && count < 1000) { if (out.length < 5) out.push(t.slice(Math.max(0, at - 80), at + n.length + 80).replace(/\\s+/g, ' ')); count++; at = lo.indexOf(n, at + n.length); }
  return { count, around: out }; }`;
const HAS_TEXT = `(q) => Boolean(document.body && document.body.innerText.toLowerCase().includes(q.toLowerCase()))`;
const SCROLL_END = `(top) => { scrollTo(0, top ? 0 : document.documentElement.scrollHeight); return true; }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const labelOf = (d) => (d ? (d.text || d.aria || d.label || d.placeholder || d.title || d.value || d.name || '').slice(0, 80) : '');
const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The agent's world in a tab (made again after a navigation destroys it). */
async function world(tab) {
  if (tab.agentCtx && tab.agentCtxUrl === tab.url) return tab.agentCtx;
  const tree = await tab.cdp.send('Page.getFrameTree').catch(() => null);
  const frameId = tree ? tree.frameTree.frame.id : tab.mainFrame;
  const r = await tab.cdp.send('Page.createIsolatedWorld', { frameId, worldName: WORLD, grantUniveralAccess: false });
  tab.agentCtx = r.executionContextId;
  tab.agentCtxUrl = tab.url;
  return tab.agentCtx;
}

async function inWorld(tab, fn, ...args) {
  const contextId = await world(tab);
  const expression = `(${fn})(${args.map((a) => JSON.stringify(a)).join(', ')})`;
  let r;
  try {
    r = await tab.cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true, timeout: 5000 });
  } catch (err) {
    if (/context/i.test(String(err && err.message))) { tab.agentCtx = 0; return { stale: true }; }
    throw err;
  }
  if (r && r.exceptionDetails) throw new Error('The page script failed.');
  return r && r.result ? r.result.value : null;
}

/** Until the tab has loaded (or `ms` passed). */
async function settle(tab, ms = 12000) {
  await sleep(350);
  const end = Date.now() + ms;
  while (tab.loading && Date.now() < end) await sleep(250);
  await sleep(250);
}

async function mouseAt(tab, x, y, type, extra = {}) {
  await tab.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
}

async function keyPress(tab, key) {
  const K = { Enter: [13, '\r'], Tab: [9], Escape: [27], ArrowDown: [40], ArrowUp: [38], ArrowLeft: [37], ArrowRight: [39], PageDown: [34], PageUp: [33], Home: [36], End: [35], Backspace: [8], Delete: [46], Space: [32, ' '] };
  const [vk, text] = K[key] || [0];
  const name = key === 'Space' ? ' ' : key;
  const base = { key: name, code: key === 'Space' ? 'Space' : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await tab.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await tab.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const STALE = 'That element number is out of date (the page changed). Call read_page again.';

/**
 * Runs one validated tool call on the session's active tab. → { text, image?, step, label?,
 * needs? { id, kind, summary }, blocked?, error? }. `approved`: the owner already said yes
 * (the approval card), so the gate is passed.
 */
export async function runTool(s, name, args, { approved = false, vision = true } = {}) {
  let tab = s.tabs.get(s.active);
  const page = () => ({ url: tab ? tab.url : '', host: tab ? hostOf(tab.url) : '' });
  const done = (text, info = {}) => ({ text, step: stepText(name, args, info), ...info });
  const fail = (error) => ({ text: error, error, step: '' });
  if (!tab && !['navigate', 'new_tab', 'list_tabs'].includes(name)) return fail('No tab is open: use navigate or new_tab.');
  switch (name) {
    case 'navigate': {
      const r = toUrl(args.url, (await s.prefs()).engine);
      if (!r.ok) return fail(REFUSED[r.why] || REFUSED.bad);
      if (!tab) { tab = await s.openTab(r.url); if (!tab) return fail('The cloud browser couldn’t open a tab.'); }
      else await s.navigate(tab, r.url);
      await settle(tab);
      if (tab.failed) return fail(`Couldn’t open ${r.url}: ${tab.failed.title || 'it failed'}.`);
      return done(`Opened ${tab.url} (${tab.title || 'no title yet'}). Call read_page to see it.`, { url: tab.url });
    }
    case 'back': case 'forward': await s.history(tab, name === 'back' ? -1 : 1); await settle(tab); return done(`Now at ${tab.url}.`);
    case 'reload': await tab.cdp.send('Page.reload', {}); await settle(tab); return done(`Reloaded ${tab.url}.`);
    case 'new_tab': {
      let url = NEW_TAB;
      if (args.url) { const r = toUrl(args.url, (await s.prefs()).engine); if (!r.ok) return fail(REFUSED[r.why] || REFUSED.bad); url = r.url; }
      const t = await s.openTab(url);
      if (!t) return fail('Couldn’t open another tab (at most a few at once).');
      await settle(t);
      return done(`Opened tab ${t.id}${url !== NEW_TAB ? ` at ${t.url}` : ''}.`, { url: t.url });
    }
    case 'switch_tab': if (!s.tabs.has(args.id)) return fail(`No tab ${args.id}: see list_tabs.`); await s.select(args.id); return done(`Switched to ${args.id}.`);
    case 'close_tab': {
      const t = s.tabs.get(args.id || s.active);
      if (!t) return fail('No such tab.');
      await t.page.close().catch(() => {});
      s.closed(t.id);
      return done(`Closed ${t.id}.`);
    }
    case 'list_tabs': return done([...s.tabs.values()].map((t) => `${t.id}${t.id === s.active ? ' (current)' : ''}: ${t.title || '(no title)'} ${t.url === NEW_TAB ? '(new tab)' : t.url}`).join('\n') || 'No tabs.');
    case 'get_url': return done(`${tab.url === NEW_TAB ? '(new tab)' : tab.url}\n${tab.title || ''}`);
    case 'read_page': {
      if (!/^https?:/.test(tab.url)) return done('A new tab (nothing to read): navigate somewhere first.');
      tab.agentCtx = 0; // a fresh world: the numbers start again
      const snap = await inWorld(tab, SNAPSHOT);
      if (!snap || snap.stale) return fail('Couldn’t read the page yet: try again in a moment.');
      return done(formatSnapshot(snap), { title: snap.title, untrusted: true });
    }
    case 'find': {
      const r = await inWorld(tab, FIND, args.text);
      if (!r || r.stale) return fail('Couldn’t search the page.');
      return done(r.count ? `${r.count} match${r.count === 1 ? '' : 'es'}:\n${r.around.map((a) => `… ${a} …`).join('\n')}` : 'No matches.', { untrusted: true });
    }
    case 'click': case 'hover': {
      const d = await inWorld(tab, DESCRIBE, args.ref, true);
      if (!d || d.stale) return fail(STALE);
      const label = labelOf(d);
      if (name === 'click' && !approved) {
        const gate = approvalFor('click', args, d, page());
        if (gate && gate.block) return { ...fail(gate.why), blocked: true };
        if (gate) return hold(s, name, args, gate, label, tab);
      }
      await sleep(120);
      const p = await inWorld(tab, DESCRIBE, args.ref, false); // where it is after scrolling
      if (!p || p.stale) return fail(STALE);
      if (p.w < 1 || p.h < 1) { if (name === 'click') await inWorld(tab, CLICK_JS, args.ref); }
      else {
        await mouseAt(tab, p.x, p.y, 'mouseMoved');
        if (name === 'click') { await mouseAt(tab, p.x, p.y, 'mousePressed'); await mouseAt(tab, p.x, p.y, 'mouseReleased'); }
      }
      if (name === 'click') await settle(tab, 6000);
      return done(`${name === 'click' ? 'Clicked' : 'Hovering'} [${args.ref}] ${label}. Now at ${tab.url}.`, { label });
    }
    case 'type': {
      const d = await inWorld(tab, DESCRIBE, args.ref, true);
      if (!d || d.stale) return fail(STALE);
      const label = labelOf(d) || d.name;
      if (!d.editable) return fail(`[${args.ref}] isn’t a text field.`);
      const gate = approvalFor('type', args, d, page());
      if (gate && gate.block) return { ...fail(gate.why), blocked: true }; // never, even approved
      if (gate && !approved) return hold(s, name, args, gate, label, tab);
      if (!(await inWorld(tab, FOCUS, args.ref))) return fail(STALE);
      if (args.text) await tab.cdp.send('Input.insertText', { text: args.text });
      else await inWorld(tab, CLEAR, args.ref);
      if (args.submit) { await keyPress(tab, 'Enter'); await settle(tab, 8000); }
      return done(`Typed into [${args.ref}] ${label}${args.submit ? ' and pressed Enter' : ''}.`, { label });
    }
    case 'press': {
      if (args.key === 'Enter' && !approved) {
        const d = await inWorld(tab, DESCRIBE, 0, false);
        const gate = d && !d.none && !d.stale ? approvalFor('press', args, d, page()) : null;
        if (gate) return hold(s, name, args, gate, labelOf(d), tab);
      }
      await keyPress(tab, args.key);
      if (args.key === 'Enter') await settle(tab, 6000);
      return done(`Pressed ${args.key}.`);
    }
    case 'select': {
      const r = await inWorld(tab, SELECT, args.ref, args.value);
      if (!r || r.stale) return fail(STALE);
      if (r.error) return fail(r.options ? `No option “${args.value}”. Options: ${r.options.join(' | ')}` : `[${args.ref}] isn’t a drop-down: click it, then click the option.`);
      return done(`Chose “${r.text}”.`);
    }
    case 'scroll': {
      if (args.ref) { const d = await inWorld(tab, DESCRIBE, args.ref, true); if (!d || d.stale) return fail(STALE); return done(`Scrolled to [${args.ref}].`); }
      const dir = args.direction || 'down';
      if (dir === 'top' || dir === 'bottom') await inWorld(tab, SCROLL_END, dir === 'top');
      else {
        const v = tab.viewport || { width: 1024, height: 768 };
        await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: v.width / 2, y: v.height / 2, deltaX: 0, deltaY: (dir === 'up' ? -1 : 1) * Math.round(v.height * 0.8) });
      }
      await sleep(400);
      return done(`Scrolled ${dir}. Call read_page to see what’s there now.`);
    }
    case 'screenshot': {
      if (!vision) return fail('This model can’t see pictures: use read_page.');
      const m = await tab.cdp.send('Page.getLayoutMetrics');
      const vv = m.cssVisualViewport || m.visualViewport || { pageX: 0, pageY: 0, clientWidth: 1024, clientHeight: 768 };
      const scale = Math.min(1, 800 / Math.max(1, vv.clientWidth));
      const r = await tab.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 45, fromSurface: true, clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale } });
      if (!r || !r.data) return fail('Couldn’t take a picture.');
      return done(`A picture of ${tab.url} (what the viewport shows).`, { image: r.data, untrusted: true });
    }
    case 'wait_for': {
      const end = Date.now() + args.seconds * 1000;
      if (!args.text) { await sleep(args.seconds * 1000); return done(`Waited ${args.seconds} s.`); }
      while (Date.now() < end) {
        if (await inWorld(tab, HAS_TEXT, args.text).catch(() => false) === true) return done(`“${args.text}” is on the page.`);
        await sleep(500);
      }
      return done(`“${args.text}” didn’t appear within ${args.seconds} s.`);
    }
    case 'download': {
      let url = args.url;
      let d = null;
      if (args.ref) { d = await inWorld(tab, DESCRIBE, args.ref, false); if (!d || d.stale) return fail(STALE); url = d.href; }
      const ok = addressAllowed(String(url || ''));
      if (!ok.ok || !/^https?:/.test(ok.url)) return fail('That isn’t a downloadable web address.');
      const gate = approvalFor('download', { url: ok.url }, d, page());
      if (gate && !approved) return hold(s, name, args, gate, '', tab);
      const last = ok.url.split(/[?#]/)[0].split('/').pop() || 'file';
      let fileName = last;
      try { fileName = decodeURIComponent(last); } catch { /* a broken %-escape: the name as it is */ }
      fileName = fileName.slice(0, 200);
      s.send({ t: 'download', url: ok.url, name: fileName });
      return done(s.ws ? `Offered ${fileName} to the user as a download in the browser panel.` : `The panel isn’t open: give the user this link: ${ok.url}`);
    }
    case 'zoom': {
      await s.onMessage(args.to === 'reset' ? { t: 'zoom', to: 1 } : { t: 'zoom', dir: args.to === 'in' ? 1 : -1 });
      return done(`Zoom is ${Math.round((tab.zoom || 1) * 100)}%.`);
    }
    default: return fail(`Unknown tool ${name}.`);
  }
}

/** An action held for the owner: kept here (10 minutes) until the approval card is answered. */
async function hold(s, name, args, gate, label, tab) {
  const pending = { id: uid(), name, args, kind: gate.kind, summary: gate.summary, label, url: tab.url, tab: tab.id, at: s.now() };
  await s.storage.put('agentPending', pending);
  return { text: `Waiting for the user’s approval: ${gate.summary}. Stop here and tell the user what you were about to do; they approve on the card in the chat.`, step: `Waiting for your OK: ${gate.summary}`, needs: { id: pending.id, kind: gate.kind, summary: gate.summary } };
}

/** The held action, if `id` names it and it's still fresh and on the same page (it's used up either way). */
export async function takePending(s, id) {
  const p = await s.storage.get('agentPending');
  if (!p || p.id !== id) return { error: 'That approval is no longer waiting (it was answered or replaced).' };
  await s.storage.delete('agentPending');
  if (s.now() - p.at > APPROVAL_TTL_MS) return { error: 'That approval expired (10 minutes). Ask again.' };
  const tab = s.tabs.get(p.tab);
  if (!tab || tab.url !== p.url) return { error: 'The page changed since the approval was asked, so nothing was done.' };
  if (s.active !== p.tab) await s.select(p.tab);
  return { pending: p };
}

export { labelOf };
export const SCRIPTS = { SNAPSHOT, DESCRIBE, FOCUS, CLEAR, SELECT, CLICK_JS, FIND, HAS_TEXT, SCROLL_END };
