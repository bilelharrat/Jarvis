// The Help Center's interface, shared by Eden's Help panel (web/chat/help.js) and the public
// page (web/help/page.js): search, topics, illustrated answers with "Was this helpful?", and
// Ask Help, a small chat answered from these pages that can look at a screenshot.
//
// No inline styles and no HTML strings (the public page's CSP is style-src 'self'): every node
// is built with h() and styled by web/help/help.css. The host passes what differs:
//
//   mountHelp(root, {
//     faq, core,             web/help/faq.json and help-core.js
//     imgBase,               where img/… lives ('/help/')
//     mode,                  'panel' (inside Eden) | 'page' (askeden.com/help)
//     theme(),               'light' | 'dark': which picture variant to show
//     ask(payload, signal),  → { text, cited, notSure, pages, left }   (throws Error with .status)
//     askState(),            → { ok: true, note } | { ok: false, reason, href, label }
//     canRun(open), run(open)  an answer's "open the feature" button, when the host can
//     tour(chapter)          the try-it tour at that chapter, or null
//     surface                'Eden on the web', 'Eden on your Mac', 'askeden.com/help' (for the support email)
//   }) → { show(id), home(), askView(text), search(q), focus() }

import { cleanScreenshot } from './help-image.js';

const VOTES = 'eden:help:votes';
const CHAT = 'eden:help:chat'; // the Help chat: this tab only, never the person's conversations

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (typeof attrs === 'string') n.className = attrs;
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}

const ICONS = {
  search: 'M10.5 4a6.5 6.5 0 104.1 11.5l4.2 4.2 1.2-1.2-4.2-4.2A6.5 6.5 0 0010.5 4zm0 1.7a4.8 4.8 0 110 9.6 4.8 4.8 0 010-9.6z',
  back: 'M14.7 5.3l1.2 1.2L10.4 12l5.5 5.5-1.2 1.2L8 12z',
  chev: 'M9.3 5.3L8.1 6.5l5.5 5.5-5.5 5.5 1.2 1.2L16 12z',
  clip: 'M16.5 6.5v8a4.5 4.5 0 01-9 0V6a3 3 0 016 0v8a1.5 1.5 0 01-3 0V7h-1.5v7a3 3 0 006 0V6a4.5 4.5 0 00-9 0v8.5a6 6 0 0012 0v-8z',
  send: 'M12 4l6 6-1.3 1.3-3.8-3.8V20h-1.8V7.5l-3.8 3.8L6 10z',
  x: 'M6.4 5.2L12 10.8l5.6-5.6 1.2 1.2-5.6 5.6 5.6 5.6-1.2 1.2-5.6-5.6-5.6 5.6-1.2-1.2 5.6-5.6-5.6-5.6z',
  mail: 'M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1zm.8 1.6v.3l7.2 4.7 7.2-4.7v-.3zm14.4 2.2L12 14.4 4.8 9.8V16.4h14.4z',
  spark: 'M12 3l1.9 5.4L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.6z',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'hc-ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.spark);
  s.append(p);
  return s;
}

const safeHref = (u) => (/^(https:\/\/|mailto:|\/(?!\/))/i.test(u) ? u : null);

/** The FAQ's markdown-lite as nodes: paragraphs, "- " lists, **bold**, `code`, [text](url), [#page] citations. */
export function renderText(md, { cite } = {}) {
  const frag = document.createDocumentFragment();
  const inline = (text) => {
    const out = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[#([a-z0-9-]+)\]|\[([^\]]+)\]\(([^)\s]+)\)|(https:\/\/askeden\.com\/[\w/#?=.-]*|askeden\.com\/[\w/#?=.…-]*|support@askeden\.com)/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > at) out.push(text.slice(at, m.index));
      if (m[1]) out.push(h('strong', null, m[1]));
      else if (m[2]) out.push(h('code', null, m[2]));
      else if (m[3]) out.push(cite ? cite(m[3]) : '');
      else if (m[4]) {
        const href = safeHref(m[5]);
        out.push(href ? h('a', { href, target: href.startsWith('/') ? null : '_blank', rel: 'noopener' }, m[4]) : m[4]);
      } else if (m[6]) {
        const raw = m[6];
        const href = raw.includes('@') ? `mailto:${raw}` : raw.startsWith('https://') ? raw : /…$/.test(raw) ? null : `https://${raw}`;
        out.push(href ? h('a', { href, target: '_blank', rel: 'noopener' }, raw) : raw);
      }
      at = re.lastIndex;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  };
  const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const list = (lines) => {
    const items = lines.filter((l) => l.trim());
    return h(/^\s*\d/.test(items[0] || '') ? 'ol' : 'ul', null, items.map((l) => h('li', null, inline(l.replace(ITEM, '')))));
  };
  for (const block of String(md || '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => ITEM.test(l));
    if (at < 0) { frag.append(h('p', null, inline(lines.join(' ')))); continue; }
    if (at > 0) frag.append(h('p', null, inline(lines.slice(0, at).join(' '))));
    frag.append(list(lines.slice(at)));
  }
  return frag;
}

function readJson(store, key, fallback) {
  try {
    const v = JSON.parse(store.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(store, key, value) {
  try { store.setItem(key, JSON.stringify(value)); } catch { /* private mode: kept for this view only */ }
}
const local = () => { try { return window.localStorage; } catch { return null; } };
const session = () => { try { return window.sessionStorage; } catch { return null; } };

export function mountHelp(root, opts) {
  const { faq, core } = opts;
  const index = core.buildIndex(faq);
  const byId = Object.fromEntries(faq.entries.map((e) => [e.id, e]));
  const cats = faq.categories;
  const catOf = Object.fromEntries(cats.map((c) => [c.id, c]));
  const votes = readJson(local() || { getItem: () => null }, VOTES, {});
  let chat = readJson(session() || { getItem: () => null }, CHAT, []);
  let view = { name: 'home' };
  let shot = null; // the screenshot waiting to be sent
  let asking = null; // AbortController of the question in flight

  root.classList.add('hc');
  root.dataset.mode = opts.mode || 'panel';
  root.replaceChildren();

  // ── the top: search and the two tabs ──
  const q = h('input', { type: 'search', class: 'hc-q', placeholder: 'Search Help', 'aria-label': 'Search Help', autocomplete: 'off', spellcheck: 'false' });
  const tabBrowse = h('button', { type: 'button', role: 'tab', class: 'hc-tab on', 'aria-selected': 'true', onclick: () => go({ name: 'home' }) }, 'Help topics');
  const tabAsk = h('button', { type: 'button', role: 'tab', class: 'hc-tab', 'aria-selected': 'false', onclick: () => go({ name: 'ask' }) }, icon('spark'), 'Ask Help');
  const top = h('div', 'hc-top',
    h('label', 'hc-search', icon('search'), q),
    h('div', { class: 'hc-tabs', role: 'tablist', 'aria-label': 'Help' }, tabBrowse, tabAsk));
  const body = h('div', { class: 'hc-body', tabindex: '-1' });
  const live = h('div', { class: 'hc-sr', role: 'status', 'aria-live': 'polite' });
  root.append(top, body, live);

  let typing = 0;
  q.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => go(q.value.trim() ? { name: 'search', q: q.value.trim() } : { name: 'home' }, { keepFocus: true }), 120);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = body.querySelector('.hc-row');
      if (first) first.click();
    }
  });

  function go(next, { keepFocus = false, push = true } = {}) {
    view = next;
    const asks = next.name === 'ask';
    tabAsk.classList.toggle('on', asks);
    tabAsk.setAttribute('aria-selected', String(asks));
    tabBrowse.classList.toggle('on', !asks);
    tabBrowse.setAttribute('aria-selected', String(!asks));
    if (next.name !== 'search' && !keepFocus) q.value = '';
    if (next.name === 'home') drawHome();
    else if (next.name === 'cat') drawCategory(next.id);
    else if (next.name === 'entry') drawEntry(next.id);
    else if (next.name === 'search') drawSearch(next.q);
    else drawAsk(next.prefill);
    body.scrollTop = 0;
    if (push && opts.onNavigate) opts.onNavigate(next);
    if (!keepFocus && next.name === 'entry') requestAnimationFrame(() => body.querySelector('h2')?.focus());
  }

  const row = (e, sub) => h('button', { type: 'button', class: 'hc-row', onclick: () => go({ name: 'entry', id: e.id }) },
    h('span', 'hc-row-t', e.q), sub ? h('span', 'hc-row-s', sub) : null, icon('chev'));

  function drawHome() {
    const popular = ['first-message', 'signin-ways', 'err-mac-offline', 'allowance', 'privacy-mode', 'mac-link'].map((id) => byId[id]).filter(Boolean);
    body.replaceChildren(
      h('section', 'hc-sec',
        h('h2', 'hc-h', 'Popular'),
        h('div', 'hc-list', popular.map((e) => row(e, catOf[e.cat]?.title)))),
      h('section', 'hc-sec',
        h('h2', 'hc-h', 'Topics'),
        h('div', 'hc-cats', cats.map((c) => h('button', { type: 'button', class: `hc-cat${c.id === 'trouble' ? ' warn' : ''}`, onclick: () => go({ name: 'cat', id: c.id }) },
          h('span', 'hc-cat-t', c.title), h('span', 'hc-cat-n', `${faq.entries.filter((e) => e.cat === c.id).length}`))))),
      stuck());
  }

  function drawCategory(id) {
    const c = catOf[id];
    body.replaceChildren(
      backTo('All topics', { name: 'home' }),
      h('h2', { class: 'hc-title', tabindex: '-1' }, c ? c.title : 'Topic'),
      h('div', 'hc-list', faq.entries.filter((e) => e.cat === id).map((e) => row(e))),
      stuck());
  }

  function drawSearch(text) {
    const results = core.search(index, text, { limit: 12 }).filter((r, i, all) => i < 3 || r.score >= all[0].score * 0.25);
    live.textContent = results.length ? `${results.length} results` : 'No results';
    body.replaceChildren(
      results.length
        ? h('div', 'hc-list', results.map((r) => row(byId[r.id], catOf[byId[r.id].cat]?.title)))
        : h('div', 'hc-empty', h('p', null, `Nothing in Help matches “${text}”.`), h('p', null, 'Try other words, or ask Help in your own words.')),
      stuck(text));
  }

  function backTo(label, target) {
    return h('button', { type: 'button', class: 'hc-back', onclick: () => go(target) }, icon('back'), label);
  }

  function figure(key) {
    const im = faq.images && faq.images[key];
    if (!im) return null;
    const dark = opts.theme && opts.theme() === 'dark' && im.dark;
    const src = `${opts.imgBase}${dark ? im.dark : im.src}`;
    return h('figure', `hc-fig${im.phone ? ' phone' : ''}`,
      h('img', { src, alt: im.alt, loading: 'lazy', decoding: 'async', width: im.w, height: im.h }),
      im.caption ? h('figcaption', null, im.caption) : null);
  }

  function actions(e, { compact = false } = {}) {
    const btns = [];
    if (e.open && e.open.faq && byId[e.open.faq]) btns.push(h('button', { type: 'button', class: 'hc-btn', onclick: () => go({ name: 'entry', id: e.open.faq }) }, e.open.label || 'Read more'));
    else if (e.open && opts.canRun && opts.canRun(e.open)) btns.push(h('button', { type: 'button', class: 'hc-btn primary', onclick: () => opts.run(e.open) }, e.open.label || 'Open'));
    else if (e.open && e.open.href && opts.links !== false) btns.push(h('a', { class: 'hc-btn primary', href: e.open.href }, e.open.label || 'Open'));
    if (e.tour && opts.tour) btns.push(h('button', { type: 'button', class: 'hc-btn', onclick: () => opts.tour(e.tour) }, compact ? 'Try it' : 'Try it in the tour'));
    return btns.length ? h('div', 'hc-acts', btns) : null;
  }

  function drawEntry(id) {
    const e = byId[id];
    if (!e) { drawHome(); return; }
    const c = catOf[e.cat];
    const vote = h('div', 'hc-vote');
    const drawVote = () => {
      const v = votes[e.id];
      if (v === 1) vote.replaceChildren(h('span', 'hc-vote-done', 'Thanks for telling us.'));
      else if (v === -1) vote.replaceChildren(h('span', 'hc-vote-done', 'Sorry it didn’t help.'), h('button', { type: 'button', class: 'hc-link', onclick: () => go({ name: 'ask', prefill: e.q.replace(/^"|"$/g, '') }) }, 'Ask Help instead'));
      else vote.replaceChildren(h('span', null, 'Was this helpful?'),
        h('button', { type: 'button', class: 'hc-chip', onclick: () => cast(1) }, 'Yes'),
        h('button', { type: 'button', class: 'hc-chip', onclick: () => cast(-1) }, 'No'));
    };
    const cast = (v) => {
      votes[e.id] = v;
      const store = local();
      if (store) writeJson(store, VOTES, votes); // kept in this browser only
      drawVote();
      live.textContent = 'Thanks';
    };
    drawVote();
    const related = faq.entries.filter((x) => x.cat === e.cat && x.id !== e.id).slice(0, 3);
    body.replaceChildren(
      backTo(c ? c.title : 'All topics', c ? { name: 'cat', id: c.id } : { name: 'home' }),
      h('article', { class: 'hc-entry', id: `help-${e.id}` },
        h('h2', { class: 'hc-title', tabindex: '-1' }, e.q),
        h('div', 'hc-answer', renderText(e.a)),
        (e.img || []).map(figure),
        actions(e),
        vote),
      related.length ? h('section', 'hc-sec', h('h3', 'hc-h', 'Related'), h('div', 'hc-list', related.map((x) => row(x)))) : null,
      stuck(e.q));
  }

  function stuck(prefill) {
    return h('div', 'hc-stuck',
      h('span', null, 'Still stuck?'),
      h('button', { type: 'button', class: 'hc-btn', onclick: () => go({ name: 'ask', prefill: prefill && !/^"/.test(prefill) ? prefill : '' }) }, icon('spark'), 'Ask Help'));
  }

  // ── Ask Help ──
  const ta = h('textarea', { class: 'hc-in', rows: '2', placeholder: 'Ask about Eden, or paste a screenshot of the problem', 'aria-label': 'Ask Help' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/heic,image/*', hidden: true });
  const strip = h('div', { class: 'hc-strip', hidden: true });
  const note = h('p', { class: 'hc-note', hidden: true, role: 'note' }, core.SCREENSHOT_NOTE);
  const send = h('button', { type: 'submit', class: 'hc-send', 'aria-label': 'Send to Help' }, icon('send'));
  const attach = h('button', { type: 'button', class: 'hc-attach', 'aria-label': 'Attach a screenshot', title: 'Attach a screenshot' }, icon('clip'));
  const form = h('form', 'hc-form', strip, note, h('div', 'hc-bar', attach, ta, send), file);
  const log = h('div', { class: 'hc-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Help conversation' });
  const gate = h('div', 'hc-gate');
  const support = h('a', { class: 'hc-link', href: core.supportMailto([]) }, icon('mail'), 'Contact support');
  const clear = h('button', { type: 'button', class: 'hc-link', onclick: () => { chat = []; saveChat(); drawAsk(); } }, 'Clear');
  const askFoot = h('div', 'hc-askfoot', support, clear);
  const askView = h('div', 'hc-ask', gate, log, form, askFoot);

  attach.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { if (file.files && file.files[0]) takeShot(file.files[0]); file.value = ''; });
  ta.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (item) { e.preventDefault(); takeShot(item.getAsFile()); }
  });
  askView.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
  askView.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); takeShot(f); }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  async function takeShot(f) {
    try {
      const s = await cleanScreenshot(f);
      dropShot();
      shot = s;
      strip.replaceChildren(
        h('img', { src: s.url, alt: 'Screenshot to send', class: 'hc-thumb' }),
        h('div', 'hc-strip-t', h('b', null, 'Screenshot ready'), h('span', null, `${s.width}×${s.height}, location and camera details removed`)),
        h('button', { type: 'button', class: 'hc-x', 'aria-label': 'Remove the screenshot', onclick: () => { dropShot(); ta.focus(); } }, icon('x')));
      strip.hidden = false;
      note.hidden = false;
      live.textContent = core.SCREENSHOT_NOTE;
      ta.focus();
    } catch (err) {
      bubble('help', err.message || 'That picture couldn’t be read.', { error: true });
    }
  }
  function dropShot() {
    if (shot) URL.revokeObjectURL(shot.url);
    shot = null;
    strip.hidden = true;
    note.hidden = true;
    strip.replaceChildren();
  }

  function saveChat() {
    const store = session();
    if (store) writeJson(store, CHAT, chat.slice(-20)); // text only: a screenshot is never kept
    support.href = core.supportMailto(chat, { surface: opts.surface || '' });
  }

  function citeChip(id) {
    const e = byId[id];
    if (!e) return '';
    return h('button', { type: 'button', class: 'hc-cite', onclick: () => go({ name: 'entry', id }) }, e.q.replace(/^"|"$/g, ''));
  }

  function bubble(role, text, { image = false, error = false, cited = [], notSure = false } = {}) {
    const b = h('div', `hc-msg ${role}${error ? ' error' : ''}`);
    if (role === 'user') {
      if (image) b.append(h('span', 'hc-msg-img', 'Screenshot attached'));
      if (text) b.append(h('p', null, text));
    } else {
      b.append(renderText(text, { cite: () => '' }));
      if (cited.length) b.append(h('div', 'hc-cites', h('span', null, 'From Help:'), cited.map(citeChip)));
      const first = byId[cited[0]];
      if (first && !error) { const a = actions(first, { compact: true }); if (a) b.append(a); }
      if (notSure) {
        b.append(h('div', 'hc-acts',
          opts.tour ? h('button', { type: 'button', class: 'hc-btn', onclick: () => opts.tour(null) }, 'Take the tour') : null,
          h('button', { type: 'button', class: 'hc-btn', onclick: () => go({ name: 'home' }) }, 'Browse topics'),
          h('a', { class: 'hc-btn', href: core.supportMailto(chat, { surface: opts.surface || '' }) }, 'Contact support')));
      }
    }
    log.append(b);
    b.scrollIntoView({ block: 'nearest' });
    return b;
  }

  async function drawAsk(prefill) {
    body.replaceChildren(askView);
    log.replaceChildren();
    if (!chat.length) {
      log.append(h('div', 'hc-hello',
        h('p', null, h('b', null, 'Ask anything about Eden.'), ' Answers come from the Help pages, with links to them. It can also look at a screenshot of a problem.'),
        h('p', 'hc-small', 'Separate from your chats: nothing here goes into your history or uses your allowance.')));
    }
    for (const m of chat) bubble(m.role === 'user' ? 'user' : 'help', m.content, { image: m.image, cited: m.cited || [], notSure: m.notSure });
    saveChat();
    if (prefill) ta.value = prefill;
    gate.replaceChildren();
    form.hidden = false;
    const st = await (opts.askState ? opts.askState() : { ok: true });
    if (view.name !== 'ask') return;
    if (!st.ok) {
      form.hidden = true;
      gate.append(h('div', 'hc-gatebox', h('p', null, st.reason), st.href ? h('a', { class: 'hc-btn primary', href: st.href }, st.label || 'Sign in') : null));
    } else if (st.note) gate.append(h('p', 'hc-small', st.note));
    requestAnimationFrame(() => { if (!form.hidden) ta.focus(); });
  }

  async function submit() {
    if (asking) return;
    const question = ta.value.trim();
    if (!question && !shot) { ta.focus(); return; }
    const image = shot;
    const history = chat.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    chat.push({ role: 'user', content: question, image: Boolean(image) });
    bubble('user', question, { image: Boolean(image) });
    ta.value = '';
    shot = null; // the thumbnail's URL goes once it's sent
    strip.hidden = true;
    note.hidden = true;
    strip.replaceChildren();
    const wait = h('div', 'hc-msg help wait', h('span', 'hc-dots', h('i'), h('i'), h('i')), h('span', 'hc-sr', 'Help is looking…'));
    log.append(wait);
    wait.scrollIntoView({ block: 'nearest' });
    asking = new AbortController();
    send.disabled = true;
    try {
      const r = await opts.ask({ question, history, image: image ? { mime: image.mime, data: image.data } : null }, asking.signal);
      wait.remove();
      const msg = { role: 'assistant', content: r.text, cited: r.cited || [], notSure: Boolean(r.notSure) };
      chat.push(msg);
      bubble('help', msg.content, msg);
      if (r.left && typeof r.left.messages === 'number' && r.left.messages <= 5) bubble('help', `${r.left.messages} Help question${r.left.messages === 1 ? '' : 's'} left today.`, {});
    } catch (err) {
      wait.remove();
      if (err && err.name === 'AbortError') return;
      bubble('help', (err && err.message) || 'Help couldn’t answer just now. Try again.', { error: true });
      if (err && err.status === 401) drawAsk();
    } finally {
      if (image) URL.revokeObjectURL(image.url);
      asking = null;
      send.disabled = false;
      saveChat();
    }
  }

  go({ name: 'home' }, { push: false });
  return {
    show: (id) => go(byId[id] ? { name: 'entry', id } : { name: 'home' }),
    home: () => go({ name: 'home' }),
    askView: (text) => go({ name: 'ask', prefill: text || '' }),
    search: (text) => { q.value = text; go({ name: 'search', q: text }, { keepFocus: true }); },
    focus: () => (view.name === 'ask' ? ta.focus() : q.focus()),
    view: () => view,
    stop: () => asking && asking.abort(),
  };
}
