// The owner's dashboard (askeden.com/admin): draws GET /api/admin/stats (src/stats/admin.js).

const PRODUCTS = {
  eden: 'Eden (web chat)', edu: 'Eden Edu', secretary: 'Eden Secretary', code: 'Eden Code', daredevil: 'Eden Daredevil',
  'ask-eden': 'Ask Eden (Mac beta)', apps: 'Mac & iPhone apps', messenger: 'Eden Messenger', router: 'Eden Router',
  news: 'Eden News', help: 'Help', site: 'Website pages', other: 'Other',
};
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['total', 'All time']];

const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v; // the CSP allows no style attributes, only the CSSOM
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const int = (n) => (Number(n) || 0).toLocaleString();
const money = (n, cur = 'usd') => (Number(n) || 0).toLocaleString(undefined, { style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
const cost = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: Number(n) < 1 ? 4 : 2 })}`;
const compact = (n) => (Number(n) || 0).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const product = (k) => PRODUCTS[k] || k || 'Other';
const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐');
const region = (() => { try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; } })();
const country = (cc) => (/^[A-Z]{2}$/.test(cc || '') && region ? region.of(cc) : cc === '??' || !cc ? 'Unknown' : cc);
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

/** This browser's own period starts (its time zone), for the server. */
function bounds() {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return {
    today: day.getTime(), week: week.getTime(),
    month: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), year: new Date(now.getFullYear(), 0, 1).getTime(),
    offset: -now.getTimezoneOffset(),
  };
}

const card = (title, ...body) => el('div', { class: 'card' }, title ? el('h3', { text: title }) : null, ...body);
const kpi = (k, v, s) => el('div', { class: 'card kpi' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), s ? el('div', { class: 's', text: s }) : null);
const empty = (text = 'Nothing yet.') => el('div', { class: 'empty', text });
const section = (title, note, ...body) => [el('h2', { text: title }), note ? el('p', { class: 'note', text: note }) : null, ...body].filter(Boolean);

/** Bars: [{ label, value, sub }] drawn as a ranked list. */
function bars(items, fmt = int) {
  if (!items.length) return empty();
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1e-9);
  return el('div', { class: 'rows' }, items.map((i) => el('div', { class: 'row' },
    el('span', { class: 'lab', title: i.label, text: i.label }),
    el('span', { class: 'num', text: `${fmt(i.value)}${i.sub ? ` · ${i.sub}` : ''}` }),
    el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${Math.max(1, ((Number(i.value) || 0) / max) * 100).toFixed(1)}%` })))));
}

function table(head, rows, cls = '') {
  if (!rows.length) return empty();
  return el('div', { class: 'scroll' }, el('table', { class: cls },
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => (c instanceof Node ? el('td', {}, c) : el('td', { text: c }))))))));
}

/** The last 30 days: visits as bars, sign-ups and downloads as dots on the same days. */
function daysChart(days) {
  if (!days.length) return empty('The chart fills in as days go by.');
  const W = 720; const H = 180; const P = { l: 34, r: 8, t: 10, b: 22 };
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 29);
  const byDay = new Map(days.map((d) => [new Date(d.day).toDateString(), d]));
  const series = Array.from({ length: 30 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return { d, ...(byDay.get(d.toDateString()) || {}) }; });
  const max = Math.max(1, ...series.map((s) => Math.max(s.visits || 0, s.signups || 0, s.downloads || 0)));
  const x = (i) => P.l + (i + 0.5) * ((W - P.l - P.r) / 30);
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const bw = ((W - P.l - P.r) / 30) * 0.62;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Visits, sign-ups and downloads, last 30 days' });
  for (const f of [0, 0.5, 1]) {
    svg.append(svgEl('line', { x1: P.l, x2: W - P.r, y1: y(max * f), y2: y(max * f), class: 'gridline' }));
    const t = svgEl('text', { x: P.l - 6, y: y(max * f) + 3, 'text-anchor': 'end', class: 'axis' }); t.textContent = compact(Math.round(max * f)); svg.append(t);
  }
  series.forEach((s, i) => {
    const r = svgEl('rect', { x: x(i) - bw / 2, y: y(s.visits || 0), width: bw, height: Math.max(0, H - P.b - y(s.visits || 0)), rx: 2, fill: 'var(--bar)' });
    const tip = svgEl('title'); tip.textContent = `${s.d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${int(s.visits)} visits, ${int(s.visitors)} visitors, ${int(s.signups)} sign-ups, ${int(s.downloads)} downloads, ${cost(s.usd)} AI`;
    r.append(tip); svg.append(r);
    if (s.signups) svg.append(svgEl('circle', { cx: x(i), cy: y(s.signups), r: 3.5, fill: 'var(--bar2)' }));
    if (s.downloads) svg.append(svgEl('circle', { cx: x(i), cy: y(s.downloads), r: 3.5, fill: 'var(--bar3)' }));
    if (i % 5 === 0 || i === 29) {
      const t = svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'axis' });
      t.textContent = s.d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); svg.append(t);
    }
  });
  return el('div', { class: 'chart' }, svg, el('div', { class: 'legend' },
    el('span', {}, el('i', { style: 'background:var(--bar)' }), 'Visits'), el('span', {}, el('i', { style: 'background:var(--bar2)' }), 'Sign-ups'), el('span', {}, el('i', { style: 'background:var(--bar3)' }), 'Downloads')));
}

function hoursChart(hours, key) {
  const by = new Map(hours.map((h) => [Number(h.hour), Number(h[key]) || 0]));
  const vals = Array.from({ length: 24 }, (_, h) => by.get(h) || 0);
  const max = Math.max(1, ...vals);
  if (!vals.some(Boolean)) return empty();
  return el('div', {},
    el('div', { class: 'hours' }, vals.map((v, h) => el('div', { style: `height:${Math.max(2, (v / max) * 100)}%`, title: `${h}:00 · ${int(v)}` }))),
    el('div', { class: 'hours-axis' }, Array.from({ length: 24 }, (_, h) => el('span', { text: h % 6 === 0 ? `${h}h` : '' }))));
}

function render(data) {
  const main = $('#main');
  main.replaceChildren();
  const ev = data.events || {};
  const st = data.stripe || {};
  const gh = data.github || {};
  const counts = Object.fromEntries((ev.counts || []).map((c) => [c.kind, c]));
  const per = (kind, p) => Number((counts[kind] || {})[p]) || 0;
  const since = ev.since ? new Date(ev.since).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : null;

  if (!ev.ready) main.append(el('div', { class: 'banner', text: `Site tracking isn't answering yet${ev.error ? ` (${ev.error})` : ''}. Stripe and GitHub numbers below still work.` }));
  else main.append(el('div', { class: 'banner', text: since
    ? `Visits, sign-ups, AI use, features and errors are counted from ${since}, when tracking started. Revenue (Stripe) and installer downloads (GitHub) go back to the beginning.`
    : 'Tracking is on. Visits, sign-ups, AI use and errors appear here as they happen. Revenue (Stripe) and installer downloads (GitHub) already go back to the beginning.' }));

  // The headline numbers
  const usersTotal = (data.users_before || 0) + per('signup', 'total');
  main.append(el('div', { class: 'grid g4', style: 'margin-top:14px' },
    kpi('Revenue this month', st.error ? '—' : money(st.gross?.month, st.currency), st.error ? st.error : `${money(st.gross?.total, st.currency)} all time · ${money(st.net?.month, st.currency)} after fees`),
    kpi('Eden Plus subscribers', st.error ? '—' : int(st.active_subscriptions), st.error ? '' : `${money(st.mrr, st.currency)} a month recurring`),
    kpi('Users', int(usersTotal), data.users_before ? `${int(per('signup', 'today'))} new today` : `new since tracking began · ${int(per('signup', 'today'))} today`),
    kpi('AI cost this month', cost(ev.ai?.month), `${compact(ev.ai?.tok_month)} tokens · ${cost(ev.ai?.total)} all time`)));

  // Every number by period
  const row = (label, f) => [label, ...PERIODS.map(([p]) => f(p))];
  const uv = ev.unique_visitors || {};
  const au = ev.active_users || {};
  main.append(...section('By period', 'Weeks start on Monday, in your time zone.', card(null, table(['', ...PERIODS.map(([, l]) => l)], [
    row('Revenue', (p) => (st.error ? '—' : money(st.gross?.[p], st.currency))),
    row('Revenue after fees and refunds', (p) => (st.error ? '—' : money(st.net?.[p], st.currency))),
    row('New users', (p) => int(per('signup', p))),
    row('Active AI users', (p) => (p === 'total' ? '—' : int(au[p]))),
    row('Website visits', (p) => int(per('visit', p))),
    row('Unique visitors', (p) => (p === 'today' ? int(uv.today) : '—')),
    row('Downloads (askeden.com buttons)', (p) => int(per('download', p))),
    row('AI tokens', (p) => compact(p === 'total' ? ev.ai?.tok_total : ev.ai?.[`tok_${p}`])),
    row('AI cost', (p) => cost(ev.ai?.[p])),
    row('Actions people took', (p) => int(per('action', p))),
    row('Errors (server + browsers)', (p) => int(per('error', p) + per('client', p))),
  ], 'big'))));

  main.append(...section('Last 30 days', null, card(null, daysChart(ev.days || []))));

  // Every product
  const prod = new Map();
  for (const r of ev.by_product || []) {
    const k = r.product || 'eden';
    if (!prod.has(k)) prod.set(k, {});
    prod.get(k)[r.kind] = r;
  }
  const aiProd = new Map((ev.ai?.by_product || []).map((r) => [r.name, r]));
  const installs = gh.installers || {};
  const ghByProduct = {};
  for (const [k, n] of Object.entries(installs)) { const [p] = k.split(':'); ghByProduct[p] = (ghByProduct[p] || 0) + n; }
  const allProducts = [...new Set([...Object.keys(PRODUCTS).filter((k) => k !== 'other'), ...prod.keys(), ...aiProd.keys()])];
  const v = (k, kind, p = 'month') => int(((prod.get(k) || {})[kind] || {})[p]);
  const msg = data.messenger || {};
  main.append(...section('Every Eden product', 'This month, except AI (last 30 days) and installer downloads (GitHub, all time).', card(null, table(
    ['Product', 'Visits', 'Downloads', 'Installer downloads (all time)', 'Sign-ups', 'Actions', 'AI cost', 'Errors'],
    allProducts.map((k) => [product(k), v(k, 'visit'), v(k, 'download'), ghByProduct[k] ? int(ghByProduct[k]) : '—', v(k, 'signup'), v(k, 'action'), aiProd.get(k) ? cost(aiProd.get(k).usd) : '—', int((((prod.get(k) || {}).error || {}).month || 0) + (((prod.get(k) || {}).client || {}).month || 0))]),
  )), card('Eden Messenger (its own server)', msg.error
    ? el('p', { class: 'note', text: msg.error === 'not connected' ? 'Not connected yet: Messenger keeps its own accounts on its own server. Its user and message counts appear here once that link is switched on.' : `Couldn't reach Messenger: ${msg.error}` })
    : table(['', ...PERIODS.map(([, l]) => l)], [
      row('New users', (p) => int(msg.signups?.[p])), row('Active users', (p) => int(msg.active?.[p])),
      row('Messages', (p) => int(msg.messages?.[p])), row('Calls', (p) => int(msg.calls?.[p])),
    ].concat(msg.users_total !== undefined ? [['Users in total', int(msg.users_total), '', '', '', '']] : [])))));

  // Downloads
  const PLAT = { mac: 'Mac', windows: 'Windows', android: 'Android', iphone: 'iPhone' };
  main.append(...section('Downloads', 'GitHub counts every installer ever downloaded; askeden.com counts clicks on its own buttons from the day tracking began (the two overlap).', el('div', { class: 'grid g2' },
    card('Installers, all time (GitHub)', gh.error ? el('p', { class: 'note', text: gh.error }) : bars(Object.entries(installs).sort((a, b) => b[1] - a[1]).map(([k, n]) => { const [p, plat] = k.split(':'); return { label: `${product(p)} · ${PLAT[plat] || plat}`, value: n }; })),
      gh.update_checks ? el('p', { class: 'note', text: `${int(gh.update_checks)} update checks from installed Mac apps.` }) : null),
    card('Where downloads come from (this month)', bars((ev.countries || []).filter((c) => c.downloads).sort((a, b) => b.downloads - a.downloads).slice(0, 12).map((c) => ({ label: `${flag(c.name)} ${country(c.name)}`, value: c.downloads })))))));

  // Where
  main.append(...section('Where people are', 'Last 30 days. From Cloudflare’s location for each request; no IP addresses are kept.', el('div', { class: 'grid g2' },
    card('Countries', table(['Country', 'Visits', 'Downloads', 'Sign-ups', 'AI turns'], (ev.countries || []).map((c) => [`${flag(c.name)} ${country(c.name)}`, int(c.visits), int(c.downloads), int(c.signups), int(c.ai)]))),
    card('Cities', table(['City', 'Visits', 'Downloads', 'Sign-ups'], (ev.cities || []).map((c) => [`${flag(c.country)} ${c.city}${c.region ? `, ${c.region}` : ''}`, int(c.n - c.downloads - c.signups), int(c.downloads), int(c.signups)]))))));

  // Features
  main.append(...section('What people use', 'Last 30 days.', el('div', { class: 'grid g2' },
    card('AI features', bars((ev.ai?.by_feature || []).map((f) => ({ label: f.name, value: f.n, sub: `${int(f.users)} people · ${cost(f.usd)}` })))),
    card('Actions (what people press)', bars((ev.actions || []).slice(0, 20).map((a) => ({ label: `${a.name.replace(/^\/api\//, '')}`, value: a.n, sub: product(a.product) })))))));

  // Tendencies
  const ret = ev.returning || {};
  const retTotal = (Number(ret.came_back) || 0) + (Number(ret.once) || 0);
  main.append(...section('How people use Eden', 'Last 30 days, hours in your time zone.', el('div', { class: 'grid g3' },
    card('When people visit', hoursChart(ev.hours || [], 'visits')),
    card('When people use the AI', hoursChart(ev.hours || [], 'ai')),
    card('Coming back', retTotal ? el('div', {},
      el('div', { class: 'kpi' }, el('div', { class: 'v', text: `${Math.round(((Number(ret.came_back) || 0) / retTotal) * 100)}%` }), el('div', { class: 's', text: `of AI users came back on another day (${int(ret.came_back)} of ${int(retTotal)})` })),
      au.month ? el('p', { class: 'note', text: `${cost((ev.ai?.month || 0) / Math.max(1, au.month))} of AI per active user this month.` }) : null) : empty()),
    card('Devices', bars((ev.devices || []).map((d) => ({ label: { 'mac-app': 'Mac app', iphone: 'iPhone', ipad: 'iPad', android: 'Android', windows: 'Windows', mac: 'Mac (browser)', linux: 'Linux', other: 'Other' }[d.name] || d.name, value: d.visits, sub: `${int(d.downloads)} downloads · ${int(d.signups)} sign-ups` })))),
    card('Where visitors come from', bars((ev.referrers || []).map((r) => ({ label: r.name, value: r.n })))),
    card('AI models', bars((ev.ai?.by_model || []).map((m) => ({ label: m.name, value: m.usd, sub: `${compact(m.tokens)} tokens` })), cost)))));

  // Bugs
  main.append(...section('Bugs', 'Last 30 days: server errors and errors in people’s browsers, newest first. Same error grouped.', card(null, table(['Where', 'What', 'Times', 'Last'],
    (ev.errors || []).map((e) => [el('span', {}, el('span', { class: `pill${e.kind === 'error' ? ' red' : ''}`, text: e.kind === 'error' ? 'server' : 'browser' }), ` ${e.name || ''}`, el('div', { class: 'note', text: product(e.product) })), el('div', { class: 'err', text: e.detail || '' }), int(e.n), ago(e.last)])))));
  const lastTd = main.querySelectorAll('td:nth-child(2)');
  lastTd.forEach((td) => { if (td.querySelector('.err')) td.classList.add('wrap'); });

  // Eden Travel's card payments to sort out by hand (src/travel/pay.js flags)
  main.append(...travelSection(data.travel || {}));

  // Unlimited accounts and the fine print
  main.append(el('p', { class: 'note', style: 'margin-top:28px', text: `${data.unlimited || 0} email${data.unlimited === 1 ? '' : 's'} on unlimited AI. ${st.live === false ? 'Stripe is in test mode. ' : ''}${st.partial ? 'Stripe history was cut short (very many transactions). ' : ''}App Store sales aren’t included yet.` }));
}

const WHY = { refund_failed: 'Refund failing', refund_currency: 'Other currency', stuck: 'Stuck booking' };
const cents = (n, cur) => { try { return (Number(n) / 100).toLocaleString(undefined, { style: 'currency', currency: cur }); } catch { return `${cur || ''} ${(Number(n) / 100).toFixed(2)}`; } };

/** Travel refunds: one row per open flag, each with Mark resolved (after it's sorted in Stripe or with the provider). */
function travelSection(t) {
  const note = 'Eden Travel card payments Eden couldn’t finish on its own. Sort each out in Stripe (or with the provider), then mark it resolved; that changes nothing at Stripe.';
  if (t.ready === false) return section('Travel refunds', note, card(null, empty(`Couldn’t read the flags${t.error ? ` (${t.error})` : ''}.`)));
  const rows = (t.flags || []).map((f) => {
    const button = el('button', { type: 'button', text: 'Mark resolved' });
    button.addEventListener('click', () => resolveFlag(f, button));
    return [
      el('span', { class: 'err', title: f.account, text: f.account_short || '' }),
      el('div', {}, f.title || f.kind || '', el('div', { class: 'note', text: [f.booking, f.pay_id].filter(Boolean).join(' · ') })),
      Number.isFinite(f.cents) ? cents(f.cents, f.currency) : '',
      f.currency || '',
      el('div', {}, el('span', { class: `pill${f.gave_up || f.why === 'stuck' ? ' red' : ''}`, text: WHY[f.why] || f.why }), el('div', { class: 'note', text: f.text || '' })),
      f.since ? ago(f.since) : '',
      int(f.tries),
      button,
    ];
  });
  const out = section('Travel refunds', note, card(null, rows.length ? table(['Account', 'Booking', 'Amount', 'Currency', 'Why', 'Since', 'Tries', ''], rows) : empty('Nothing to sort out.')));
  out.at(-1).querySelectorAll('td:nth-child(2), td:nth-child(5)').forEach((td) => td.classList.add('wrap'));
  return out;
}

async function resolveFlag(f, button) {
  if (!window.confirm(`Mark ${f.title || 'this payment'} resolved? Only once it's sorted in Stripe or with the provider.`)) return;
  button.disabled = true;
  try {
    const r = await fetch('/api/admin/travel-refunds', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: f.account, pay_id: f.pay_id }) });
    if (!r.ok) throw new Error(`The server said ${r.status}.`);
    await load();
  } catch (error) {
    button.disabled = false;
    window.alert(`Couldn’t mark it resolved. ${error.message}`);
  }
}

let loading = false;
async function load(fresh = false) {
  if (loading) return;
  loading = true;
  const button = $('#refresh');
  button.disabled = true;
  try {
    const q = new URLSearchParams(Object.entries(bounds()).map(([k, v]) => [k, String(v)]));
    if (fresh) q.set('fresh', '1');
    const r = await fetch(`/api/admin/stats?${q}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'This account can’t see the dashboard.' : `The server said ${r.status}.`);
    const data = await r.json();
    render(data);
    $('#updated').textContent = `Updated ${new Date(data.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  } catch (error) {
    $('#main').replaceChildren(el('div', { class: 'banner', text: `Couldn’t load the numbers. ${error.message}` }));
  } finally {
    loading = false;
    button.disabled = false;
  }
}

$('#refresh').addEventListener('click', () => load(true));
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120_000);
