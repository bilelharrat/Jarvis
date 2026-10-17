// Eden News (askeden.com/news): the edition and, for a signed-in reader opening News for the first time, the five
// questions (src/news/questions.js) that make it theirs. The server ranks (src/news/rank.js); this page shows.
// Everything from the server goes into the page as text (textContent), never as HTML.
'use strict';

const $ = (id) => document.getElementById(id);
const HEADERS = { 'content-type': 'application/json', 'x-eden-news': '1' };
const TINT = { world: '#64d2ff', politics: '#5e5ce6', business: '#ff9f0a', tech: '#0a84ff', science: '#30d158', sports: '#ff375f', culture: '#bf5af2', lifestyle: '#ffd60a' };
const BANNER = { world: ['#8fe0ff', '#2a8fbf', '#0f3a52'], politics: ['#a9a8ff', '#4d4bc9', '#1e1d5a'], business: ['#ffd08a', '#e07b00', '#5a3000'], tech: ['#8fd3ff', '#2a7de1', '#12325e'], science: ['#9be8b0', '#24a148', '#0d3d1b'], sports: ['#ff9fb2', '#d81b45', '#560818'], culture: ['#e0b0ff', '#9b3fd1', '#3b1052'], lifestyle: ['#fff0a0', '#d9a400', '#4d3a00'] };
const SVG = 'http://www.w3.org/2000/svg';

let state = { feed: null, profile: null, signedIn: false, tab: 'top', questions: null };

/** el('a', { href, class }, child, 'text', …): a node, children appended as nodes or text. */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

/** A small stroke icon (paths in a 24×24 box), hidden from screen readers. */
function icon(paths, size = 18) {
  const s = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, String(v));
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
const ICONS = {
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  up: ['M7 10l5-5 5 5', 'M12 5v14'],
  down: ['M7 14l5 5 5-5', 'M12 19V5'],
  hide: ['M3 3l18 18', 'M10.6 10.6a2 2 0 002.8 2.8', 'M9.9 4.2A10 10 0 0122 12a13 13 0 01-2.2 3.2M6.6 6.6A13 13 0 002 12a10 10 0 0014 6.4'],
  open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5'],
  today: ['M4 5h16v14H4z', 'M4 9h16', 'M8 13h4'],
  you: ['M12 21s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.6-7 10-7 10z'],
  person: ['M12 12a4 4 0 100-8 4 4 0 000 8z', 'M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
};

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: HEADERS, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || 'Something went wrong. Try again.');
  return out;
}

const ago = (ms) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const sectionOf = (s) => {
  const t = s.topics && s.topics[0] ? s.topics[0].id : '';
  return t.split('-')[0] === 'life' ? 'lifestyle' : t.split('-')[0] || 'world';
};
const gradient = (s, angle = '135deg') => {
  const [a, b, c] = BANNER[sectionOf(s)] || BANNER.world;
  return `linear-gradient(${angle}, ${a} 0%, ${b} 55%, ${c} 100%)`;
};

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

// ── a story's parts ──

/** The publisher line above a headline (Apple News puts the source first). */
function pub(s) {
  return el('span', { class: 'pub' }, el('span', { class: 'dot', 'aria-hidden': 'true', style: { background: TINT[sectionOf(s)] || '#8e8e93' } }), s.source);
}

/** Under the headline: the time, and how many outlets report it. */
function meta(s) {
  return el('div', { class: 'meta' },
    el('span', { text: ago(s.updatedAt) }),
    el('span', { 'aria-hidden': 'true', text: '·' }),
    s.outlets >= 2
      ? el('span', { class: 'check' }, icon(ICONS.check, 13), `${s.outlets} sources`)
      : el('span', { text: '1 source' }));
}

function whyLine(s) {
  const w = (s.why || [])[0];
  if (!w) return null;
  const text = w.kind === 'follow' ? `Because you follow ${w.name}` : w.kind === 'local' ? `Near ${w.name}` : `Because you like ${w.name}`;
  return el('span', { class: 'why', text });
}

/** The story's link: opening it tells Eden (signed in), then the publisher's page opens. */
function storyLink(s, cls) {
  return el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: cls, onclick: () => send(s, 'open') }, s.title);
}

/** A distressing story for a reader who asked for a heads-up: the summary waits behind a button. */
function summary(s) {
  if (!s.summary) return null;
  const p = el('p', { class: 'sum', text: s.summary });
  if (!(s.distressing && state.profile && state.profile.sensitive === 'warn')) return p;
  p.hidden = true;
  const btn = el('button', { type: 'button', class: 'reveal', onclick: () => { p.hidden = false; btn.remove(); } }, 'Show summary');
  return el('div', { class: 'heads-up' }, el('span', { class: 'badge-warn', text: 'Heads-up: distressing story' }), btn, p);
}

/** The "⋯" button: a glass menu with Open, More like this, Show less of this, Not interested. */
function moreButton(s, holder) {
  return el('button', { type: 'button', class: 'more', 'aria-haspopup': 'menu', 'aria-label': `More for “${s.title}”`, onclick: (e) => openMenu(e.currentTarget, s, holder) }, icon(ICONS.more, 18));
}

function thumb(s) {
  const t = el('span', { class: 'thumb', 'aria-hidden': 'true', style: { background: gradient(s) } });
  if (s.image) t.append(el('img', { src: s.image, alt: '', loading: 'lazy' }));
  return t;
}

// ── the cards ──

function leadCard(s) {
  const banner = el('div', { class: 'banner', style: { background: gradient(s, '160deg') } });
  if (s.image) banner.append(el('img', { src: s.image, alt: '' }), el('span', { class: 'credit', text: `Photo: ${s.source}` }));
  banner.append(el('span', { class: 'kicker', text: (s.topics || []).map((t) => t.name).slice(0, 2).join(' · ') || (s.region ? `Local · ${s.region}` : 'News') }));
  const card = el('article', { class: 'card lead' }, banner);
  card.append(el('div', { class: 'body' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, pub(s), el('span', { class: 'grow' }), moreButton(s, card)),
    whyLine(s),
    el('h3', {}, storyLink(s)),
    summary(s),
    meta(s)));
  return card;
}

/** One row of a grouped list: publisher, headline, summary, time — and its picture at the right. */
function row(s, n) {
  const r = el('article', { class: 'row' });
  r.append(...[
    n ? el('span', { class: 'n', text: String(n) }) : null,
    el('div', { class: 'text' }, el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, pub(s), el('span', { class: 'grow' }), moreButton(s, r)),
      whyLine(s), el('h3', { class: 't' }, storyLink(s)), summary(s), meta(s)),
    n ? null : thumb(s)].filter(Boolean));
  return r;
}

/** A medium card under the lead: its picture (or topic colour) on top, then the story. */
function midCard(s) {
  const pic = el('div', { class: 'pic', style: { background: gradient(s, '160deg') } });
  if (s.image) pic.append(el('img', { src: s.image, alt: '', loading: 'lazy' }), el('span', { class: 'credit', text: `Photo: ${s.source}` }));
  const card = el('article', { class: 'card mid' }, pic);
  card.append(el('div', { class: 'body' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, pub(s), el('span', { class: 'grow' }), moreButton(s, card)),
    whyLine(s), el('h3', { class: 't' }, storyLink(s)), meta(s)));
  return card;
}

function topList(title, list) {
  return el('section', { class: 'card list top', 'aria-label': title }, el('h2', { class: 'sec', style: { margin: '0 0 2px' } }, title), list.map((s, i) => row(s, i + 1)));
}

/** A section: its title, then its stories in two grouped lists side by side (one on a phone). */
function section(title, note, stories) {
  if (!stories.length) return null;
  const half = Math.ceil(stories.length / 2);
  const cols = stories.length > 2 ? [stories.slice(0, half), stories.slice(half)] : [stories];
  return el('section', { 'aria-label': title },
    el('h2', { class: 'sec' }, title, el('small', { text: note || '' })),
    el('div', { class: 'grid' }, cols.map((c) => el('div', { class: 'card list' }, c.map((s) => row(s))))));
}

// ── the "⋯" menu ──

let menuFor = null;
function openMenu(button, s, holder) {
  const m = $('menu');
  if (menuFor === button && !m.hidden) { closeMenu(); return; }
  const item = (label, ico, fn, cls) => el('button', { type: 'button', role: 'menuitem', class: cls, onclick: () => { closeMenu(); fn(); } }, icon(ico, 18), label);
  const items = [item('Open the story', ICONS.open, () => { send(s, 'open'); window.open(s.url, '_blank', 'noopener,noreferrer'); })];
  if (state.signedIn) {
    items.push(el('hr'),
      item('More like this', ICONS.up, () => send(s, 'more', 'Got it: more like this.')),
      item('Show less of this', ICONS.down, () => send(s, 'less', 'Got it: less of this.')),
      item('Not interested', ICONS.hide, () => { send(s, 'hide'); holder.remove(); }, 'danger'));
  }
  m.replaceChildren(...items);
  m.hidden = false;
  const b = button.getBoundingClientRect();
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  m.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, b.right - w))}px`;
  m.style.top = `${b.bottom + 6 + h > window.innerHeight - 12 ? b.top - h - 6 : b.bottom + 6}px`;
  menuFor = button;
  button.setAttribute('aria-expanded', 'true');
  m.querySelector('button')?.focus();
}
function closeMenu() {
  $('menu').hidden = true;
  if (menuFor) { menuFor.setAttribute('aria-expanded', 'false'); menuFor.focus({ preventScroll: true }); }
  menuFor = null;
}

// ── the page ──

function renderTabs() {
  const f = state.feed;
  const tabs = [['top', 'Top Stories']];
  if (f && f.personalized) tabs.splice(1, 0, ['you', 'For You']);
  for (const s of (f && f.sections) || []) tabs.push([s.id, s.name]);
  if (f && f.local && f.local.length) tabs.push(['local', 'Local']);
  $('tabs').replaceChildren(...tabs.map(([id, name]) => el('button', { type: 'button', class: 'tab', 'aria-pressed': String(state.tab === id), onclick: () => go(id) }, name)));
}

function renderDock() {
  const items = [['top', 'Today', ICONS.today]];
  if (state.feed && state.feed.personalized) items.push(['you', 'For You', ICONS.you]);
  const dock = items.map(([id, name, ico]) => el('button', { type: 'button', 'aria-pressed': String(state.tab === id), onclick: () => go(id) }, icon(ico, 22), name));
  dock.push(state.signedIn
    ? el('button', { type: 'button', onclick: () => { answered = {}; openQuestions(); } }, icon(ICONS.person, 22), 'Your News')
    : el('button', { type: 'button', onclick: () => { location.href = '/signin?return=%2Fnews'; } }, icon(ICONS.person, 22), 'Sign In'));
  $('dock').replaceChildren(...dock);
}

function go(tab) {
  state.tab = tab;
  render();
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function renderFollowing() {
  const list = (state.feed && state.feed.following) || [];
  $('following').hidden = !state.signedIn || !state.feed.personalized;
  if ($('following').hidden) return;
  const chips = list.map((f) => el('button', {
    type: 'button', class: 'follow', 'aria-pressed': String(state.tab === f.id),
    'aria-label': `${f.name}: ${f.count === 1 ? '1 story' : `${f.count} stories`}`,
    onclick: () => { state.tab = state.tab === f.id ? 'top' : f.id; render(); },
  },
  el('span', { class: 'dot', 'aria-hidden': 'true', style: { background: f.kind === 'topic' ? TINT[f.id.slice(2).split('-')[0] === 'life' ? 'lifestyle' : f.id.slice(2).split('-')[0]] || '#8e8e93' : '#8e8e93' } }),
  el('span', {}, el('b', { text: f.name }), el('span', { class: 'k', text: f.kind === 'follow' ? 'Following' : 'Topic' })),
  el('span', { class: f.count ? 'count' : 'count zero', 'aria-hidden': 'true', text: String(f.count) })));
  chips.push(el('button', { type: 'button', class: 'follow follow-add', onclick: () => { answered = {}; openQuestions(1); } }, el('b', { text: '+ Follow' })));
  $('rail').replaceChildren(...chips);
}

function render() {
  const f = state.feed;
  if (!f) return;
  renderTabs();
  renderFollowing();
  renderDock();
  const out = [];
  const followed = (f.following || []).find((x) => x.id === state.tab);
  if (followed) {
    out.push(section(followed.name, followed.count ? `${followed.count === 1 ? '1 story' : `${followed.count} stories`} right now` : '', followed.stories)
      || el('p', { class: 'card empty', text: `Nothing about ${followed.name} right now. Eden will put it here when there is.` }));
  } else if (state.tab === 'top') {
    if (f.lead) {
      const col = el('div', { class: 'lead-col' }, leadCard(f.lead), (f.featured || []).length ? el('div', { class: 'featured' }, f.featured.map(midCard)) : null);
      out.push(el('div', { class: 'lead-row' }, col, f.top.length ? topList(f.personalized ? 'Everyone’s Reading' : 'Top Stories', f.top) : null));
    }
    if (f.personalized) out.push(section('For You', 'from the topics and names you follow', f.forYou));
    out.push(section('Local', state.profile && state.profile.local ? `near ${state.profile.local}` : '', f.local || []));
    for (const s of f.sections) out.push(section(s.name, '', s.stories));
  } else if (state.tab === 'you') {
    out.push(section('For You', 'ranked for you', [f.lead, ...f.forYou].filter(Boolean)));
  } else if (state.tab === 'local') {
    out.push(section('Local', '', f.local || []));
  } else {
    const s = f.sections.find((x) => x.id === state.tab);
    out.push(section(s ? s.name : 'News', '', s ? s.stories : []));
  }
  const shown = out.filter(Boolean);
  $('feed').replaceChildren(...(shown.length ? shown : [el('p', { class: 'card empty', text: 'Nothing here yet. Check back soon.' })]));
  $('sample').hidden = !f.sample;
  $('updated').textContent = f.updatedAt ? `Updated ${ago(f.updatedAt)}. Summaries written by Eden from the linked reporting.` : '';
  $('signin').hidden = state.signedIn;
  $('yours').hidden = !state.signedIn;
  $('yours-small').hidden = !state.signedIn;
  $('main').setAttribute('aria-busy', 'false');
}

/** What the reader did with a story, told to Eden (signed in). `said`: a short confirmation, read out to screen readers. */
async function send(s, action, said) {
  if (!state.signedIn) return;
  try {
    const { profile } = await api('/api/news/feedback', { story: s.id, action });
    state.profile = profile;
    if (said) announce(said);
  } catch (e) {
    if (action !== 'open') showError(e.message); // an open that fails to count isn't worth a message
  }
}

function announce(text) {
  let live = $('live');
  if (!live) {
    live = el('p', { id: 'live', 'aria-live': 'polite', style: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)' } });
    document.body.append(live);
  }
  live.textContent = text;
}

async function load() {
  showError('');
  $('date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  try {
    const [feed, me] = await Promise.all([api('/api/news/feed'), api('/api/news/profile')]);
    state.feed = feed;
    state.signedIn = me.signedIn;
    state.profile = me.profile;
    if (!feed.personalized && state.tab === 'you') state.tab = 'top';
    render();
    if (feed.ask && !sessionStorageGet('news-asked')) openQuestions();
  } catch (e) {
    showError(e.message);
  }
}

function sessionStorageGet(k) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function sessionStorageSet(k, v) {
  try { sessionStorage.setItem(k, v); } catch { /* private mode: ask again next visit */ }
}

// ── the first-open questions ──

const ask = { step: 0, answers: {} };

function prefill() {
  const p = state.profile;
  ask.answers = p ? {
    topics: Object.entries(p.topics || {}).filter(([, w]) => w >= 1).map(([id]) => id),
    follows: [...(p.follows || [])], local: p.local || '', less: [...(p.less || [])],
    sensitive: p.sensitive || 'warn', depth: p.depth || 'summary', amount: p.amount || 10,
  } : { topics: [], follows: [], local: '', less: [], sensitive: 'warn', depth: 'summary', amount: 10 };
}

async function openQuestions(step = 0) {
  if (!state.questions) {
    try { state.questions = await api('/api/news/questions'); } catch (e) { showError(e.message); return; }
  }
  prefill();
  ask.step = step;
  $('ask').hidden = false;
  drawStep();
  $('q-title').focus?.();
}

function closeQuestions() {
  $('ask').hidden = true;
  sessionStorageSet('news-asked', '1');
}

function toggle(list, id) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
}

function chip(label, on, onclick, cls = 'chip') {
  return el('button', { type: 'button', class: cls, 'aria-pressed': String(Boolean(on)), onclick }, label);
}

function choiceCard(title, sub, on, onclick) {
  return el('button', { type: 'button', class: 'choice', 'aria-pressed': String(Boolean(on)), onclick }, el('b', { text: title }), el('span', { text: sub }));
}

const STEP_VIEWS = {
  topics(q) {
    const a = ask.answers;
    const box = el('div');
    const chips = el('div', { class: 'chips' });
    for (const t of state.questions.topics) {
      const subOn = t.subtopics.some((s) => a.topics.includes(s.id));
      chips.append(chip(t.name, a.topics.includes(t.id) || subOn, () => { if (subOn && !a.topics.includes(t.id)) a.topics.push(t.id); else toggle(a.topics, t.id); drawStep(); }));
    }
    box.append(chips);
    // the chosen sections open up, for the specific picks that help the most
    for (const t of state.questions.topics.filter((x) => a.topics.includes(x.id) || x.subtopics.some((s) => a.topics.includes(s.id)))) {
      box.append(el('div', { class: 'subs' }, el('p', { text: `In ${t.name}, anything in particular?` }),
        el('div', { class: 'chips', style: { marginTop: '8px' } }, t.subtopics.map((s) => chip(s.name, a.topics.includes(s.id), () => { toggle(a.topics, s.id); drawStep(); }, 'chip chip-sub')))));
    }
    const picked = a.topics.length;
    $('q-next').disabled = picked < q.min;
    $('q-count').textContent = picked < q.min ? `Pick ${q.min - picked} more` : `${a.topics.length} picked`;
    return box;
  },
  follows(q) {
    const a = ask.answers;
    const input = el('input', { type: 'text', id: 'q-follow', maxlength: '60', placeholder: q.placeholder, autocomplete: 'off', 'aria-label': 'A name to follow' });
    const add = () => {
      const v = input.value.trim();
      if (v.length >= 2 && a.follows.length < q.max && !a.follows.some((f) => f.toLowerCase() === v.toLowerCase())) a.follows.push(v);
      input.value = '';
      drawStep();
      $('q-follow')?.focus();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    $('q-count').textContent = a.follows.length ? `${a.follows.length} followed` : '';
    return el('div', {},
      el('div', { class: 'field' }, input, el('button', { type: 'button', class: 'capsule', onclick: add }, 'Add')),
      el('div', { class: 'chips' }, a.follows.map((f) => el('button', { type: 'button', class: 'chip chip-x', 'aria-label': `Stop following ${f}`, onclick: () => { a.follows = a.follows.filter((x) => x !== f); drawStep(); } }, f, el('b', { 'aria-hidden': 'true', text: '×' })))));
  },
  local(q) {
    const input = el('input', { type: 'text', maxlength: '80', placeholder: q.placeholder, value: ask.answers.local, autocomplete: 'address-level2', 'aria-label': 'City or region' });
    input.addEventListener('input', () => { ask.answers.local = input.value; });
    $('q-count').textContent = '';
    return el('div', { class: 'field' }, input);
  },
  less() {
    const a = ask.answers;
    $('q-count').textContent = '';
    return el('div', {},
      el('div', { class: 'chips' }, state.questions.less.map((l) => chip(l.name, a.less.includes(l.id), () => { toggle(a.less, l.id); drawStep(); }))),
      el('p', { class: 'label', text: 'Distressing stories (violence, disasters, loss)' }),
      el('div', { class: 'choices' },
        choiceCard('Show them', 'Like any other story', a.sensitive === 'show', () => { a.sensitive = 'show'; drawStep(); }),
        choiceCard('Heads-up first', 'Summary hidden until you tap', a.sensitive === 'warn', () => { a.sensitive = 'warn'; drawStep(); }),
        choiceCard('Keep them out', 'Not in your feed', a.sensitive === 'hide', () => { a.sensitive = 'hide'; drawStep(); })));
  },
  style() {
    const a = ask.answers;
    $('q-count').textContent = '';
    return el('div', {},
      el('div', { class: 'choices' },
        choiceCard('Headlines', 'Just the headline and its sources', a.depth === 'headlines', () => { a.depth = 'headlines'; drawStep(); }),
        choiceCard('Short summary', 'Two lines on what happened', a.depth === 'summary', () => { a.depth = 'summary'; drawStep(); }),
        choiceCard('With background', 'What happened and why it matters', a.depth === 'background', () => { a.depth = 'background'; drawStep(); })),
      el('p', { class: 'label', text: 'How many stories in your edition?' }),
      el('div', { class: 'chips' }, state.questions.amounts.map((n) => chip(n === 20 ? 'Everything (20)' : `About ${n}`, a.amount === n, () => { a.amount = n; drawStep(); }))));
  },
};

function drawStep() {
  const qs = state.questions.questions;
  const q = qs[ask.step];
  $('q-steps').replaceChildren(...qs.map((_, i) => el('span', { class: i <= ask.step ? 'on' : '' })));
  $('q-title').textContent = q.title;
  $('q-title').setAttribute('tabindex', '-1');
  $('q-help').textContent = q.help;
  $('q-next').disabled = false;
  $('q-body').replaceChildren(STEP_VIEWS[q.kind](q));
  $('q-back').hidden = ask.step === 0;
  $('q-next').textContent = ask.step === qs.length - 1 ? 'Show my news' : 'Continue';
}

/** What the step answered, in the shape the server takes (profile.js fromAnswers). */
function answersFor(kind) {
  const a = ask.answers;
  if (kind === 'topics') return { topics: a.topics };
  if (kind === 'follows') return { follows: a.follows };
  if (kind === 'local') return { local: a.local.trim() || null };
  if (kind === 'less') return { less: a.less, sensitive: a.sensitive };
  return { depth: a.depth, amount: a.amount };
}

let answered = {};
async function next(skip) {
  const qs = state.questions.questions;
  const q = qs[ask.step];
  if (!skip) Object.assign(answered, answersFor(q.kind));
  if (ask.step < qs.length - 1) {
    ask.step++;
    drawStep();
    $('q-title').focus();
    return;
  }
  await finish();
}

async function finish() {
  const btn = $('q-next');
  btn.disabled = true;
  try {
    await api('/api/news/profile', { ...answered, done: true });
    answered = {};
    closeQuestions();
    state.tab = 'top';
    await load();
  } catch (e) {
    btn.disabled = false;
    $('q-count').textContent = e.message;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('q-next').addEventListener('click', () => next(false));
  $('q-skip').addEventListener('click', () => next(true));
  $('q-back').addEventListener('click', () => { if (ask.step > 0) { ask.step--; drawStep(); } });
  $('q-skipall').addEventListener('click', async () => { await api('/api/news/profile', { ...answered, done: true }).catch(() => {}); answered = {}; closeQuestions(); load(); });
  for (const id of ['yours', 'yours-small']) $(id).addEventListener('click', () => { answered = {}; openQuestions(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('menu').hidden) closeMenu();
    else if (!$('ask').hidden) closeQuestions();
  });
  document.addEventListener('click', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target) && !e.target.closest('.more')) closeMenu(); });
  window.addEventListener('scroll', () => { if (!$('menu').hidden) closeMenu(); }, { passive: true });
  // the large title hands over to the compact glass bar once it scrolls away
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => $('nav').classList.toggle('show', !e.isIntersecting), { rootMargin: '-8px 0px 0px 0px' }).observe($('hero'));
  }
  load();
});
