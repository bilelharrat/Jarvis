// /admin: what each AI provider itself says Eden spent and has left (GET /api/admin/providers, built by
// src/stats/provider-spend.js, kept 10 minutes; ?fresh=1 reads them again), and the owner's switches for the
// Ultra / Platinum / Eden Black usage bonus (GET/POST /api/admin/bonus-pool, src/accounts/bonus-pool.js).
// Both layouts (Version 3 and Classic) use these. `h` is admin.js's helpers: { el, cost, compact }.

const usd = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const v = Math.round(n * 100) / 100;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const STATUS = { ok: ['green', 'Read'], setup: ['amber', 'Needs a key'], error: ['red', 'Couldn’t read'], console: ['blue', 'Console only'] };
const TIER_NAMES = { ultra: 'Ultra', platinum: 'Platinum', black: 'Eden Black' };
const WRAP = 'white-space:normal;overflow-wrap:anywhere;word-break:break-word';
const NOTE_PAD = `padding:0 16px 10px;${WRAP}`;
const MAX_AGE = 10 * 60 * 1000; // the server keeps the provider read this long

/** A table in a sideways-scrolling wrapper, so no column vanishes off the card on a narrow screen. */
const scroller = (el, table) => el('div', { style: 'overflow-x:auto;max-width:100%' }, table);

let lastRedraw = null; // the last redraw admin.js gave us, used when a caller passes none
const remember = (redraw) => { if (typeof redraw === 'function') lastRedraw = redraw; return lastRedraw; };

// ── the provider bills ──

const prov = { data: null, error: '', at: 0, loading: null, fresh: false };

async function readProviders() {
  try {
    const r = await fetch(`/api/admin/providers${prov.fresh ? '?fresh=1' : ''}`, { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 404) throw new Error('you’re signed out, or this isn’t the owner’s account');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || j.error || !Array.isArray(j.providers)) throw new Error(j && j.error ? String(j.error) : 'the answer had no providers');
    prov.data = j;
    prov.error = '';
    prov.fresh = false;
  } catch (e) {
    prov.error = e instanceof TypeError ? 'couldn’t reach askeden.com' : String((e && e.message) || e);
  }
  prov.at = Date.now();
}

/** Start a read if none is running and the last one is missing or older than 10 minutes; redraw when it lands. */
function ensureProviders(redraw) {
  if (prov.loading) return;
  if (prov.at && Date.now() - prov.at < MAX_AGE) return;
  prov.loading = readProviders().finally(() => {
    prov.loading = null;
    const r = remember(redraw);
    if (r) r();
  });
}

/** How many alerts the provider bills have (the sidebar's badge). 0 until they've been read. */
export const providerAlerts = (_data) => {
  ensureProviders();
  return ((prov.data && prov.data.alerts) || []).length;
};

/** The provider bills: one row per provider, then the details of each that was read. `redraw` re-renders the page. */
export function providersBox(_data, h, redraw) {
  const { el } = h;
  remember(redraw);
  ensureProviders(redraw);
  const p = prov.data;
  const box = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'What each provider says we spent' }),
        el('div', { class: 'grouped-desc', text: 'From each provider’s own billing API, not Eden’s estimate. Read when you open this page, kept 10 minutes (Refresh reads again). This month is UTC.' }),
      ),
    ),
  );
  if (!p) {
    const text = prov.error && !prov.loading ? `Couldn’t read the providers (${prov.error}).` : 'Reading what each provider says…';
    box.append(el('p', { class: 'note', style: `padding:12px 16px;margin:0;${WRAP}`, text }));
    return box;
  }
  if (prov.error) box.append(el('p', { class: 'note', style: `padding:8px 16px 0;margin:0;${WRAP}`, text: `Couldn’t refresh: ${prov.error}. Showing the last read.` }));
  if (p.alerts && p.alerts.length) {
    box.append(el('div', { class: 'spend-alerts', style: 'padding:8px 16px' }, p.alerts.map((a) => el('div', { class: `v3-pill ${a.level === 'red' ? 'red' : 'amber'}`, style: 'display:flex;margin:4px 0;white-space:normal;align-items:flex-start;border-radius:10px;padding:4px 10px' },
      el('span', { class: 'pill-dot', style: 'flex:none;margin-top:4px' }),
      el('span', { style: `min-width:0;${WRAP}`, text: String(a.text || '') })))));
  }
  const list = Array.isArray(p.providers) ? p.providers : [];
  box.append(scroller(el, el('table', { class: 'mac-table' },
    el('thead', {}, el('tr', {}, ['Provider', 'Status', `This month (${p.month || '—'})`, 'Today', 'Yesterday', 'Tokens', 'Left'].map((t) => el('th', { text: t, style: 'white-space:nowrap' })))),
    el('tbody', {}, list.length ? list.map((x) => {
      const [tone, label] = STATUS[x.status] || ['amber', x.status];
      const tokens = x.tokens ? (x.tokens.in || 0) + (x.tokens.out || 0) : null;
      return el('tr', {},
        el('td', { style: `font-weight:600;min-width:140px;${WRAP}` }, el('a', { href: x.console, target: '_blank', rel: 'noopener noreferrer', title: `${x.name}'s billing console`, text: `${x.name} ↗` })),
        el('td', {}, el('span', { class: `v3-pill ${tone}`, style: 'white-space:nowrap' }, el('span', { class: 'pill-dot' }), label)),
        el('td', { text: usd(x.month_usd) }),
        el('td', { text: usd(x.today_usd) }),
        el('td', { text: usd(x.yesterday_usd) }),
        el('td', { text: tokens === null ? '—' : h.compact(tokens) }),
        el('td', { text: x.balance ? usd(x.balance.usd) : 'Console' }),
      );
    }) : [el('tr', {}, el('td', { colspan: '7', style: 'text-align:center;padding:16px', text: 'No providers to show.' }))]),
  )));
  const foot = el('div', { style: `padding:12px 16px 16px;${WRAP}` });
  box.append(foot);
  const counted = Array.isArray(p.counted) ? p.counted : [];
  foot.append(el('p', { class: 'note', text: `Read so far this month: ${usd(p.month_usd)} (${counted.length ? counted.join(', ') : 'no provider read yet'}). Balances under ${usd(p.floor_usd)} are flagged.` }));
  for (const x of list) {
    const notes = [x.note, x.balance_note].filter(Boolean);
    const lists = [['By app / API key', x.by_key, true], ['By model or service', x.by_model], ['By line item', x.by_item]].filter(([, l]) => l && l.length);
    if (!notes.length && !lists.length && x.credits_applied_usd === undefined) continue;
    const det = el('details', { class: 'spend-detail' }, el('summary', { text: x.name, style: WRAP }));
    for (const n of notes) det.append(el('p', { class: 'note', text: n }));
    if (x.credits_applied_usd !== undefined) det.append(el('p', { class: 'note', text: `Credits applied this month: ${usd(x.credits_applied_usd)}.` }));
    if (x.balance && (x.balance.cash_usd !== undefined || x.balance.voucher_usd !== undefined)) det.append(el('p', { class: 'note', text: `Cash ${usd(x.balance.cash_usd)}, vouchers ${usd(x.balance.voucher_usd)}.` }));
    for (const [title, rows, isKey] of lists) {
      det.append(el('div', { class: 'grouped-desc', style: 'margin-top:8px;font-weight:600', text: title }),
        scroller(el, el('table', { class: 'mac-table' },
          el('thead', {}, el('tr', {}, [isKey ? 'App (key id)' : 'Name', 'Spend', 'Tokens'].map((t) => el('th', { text: t, style: 'white-space:nowrap' })))),
          el('tbody', {}, rows.map((r) => el('tr', {},
            el('td', { style: `min-width:120px;${WRAP}`, text: isKey ? (r.app ? `${r.app} (${r.name})` : `${r.name} — unnamed`) : r.name }),
            el('td', { text: r.usd ? usd(r.usd) : '—' }),
            el('td', { text: r.tokens ? h.compact(r.tokens) : '—' }),
          ))),
        )));
    }
    foot.append(det);
  }
  foot.append(el('p', { class: 'note', text: 'Per app: give each app its own key at the provider and name the keys in PROVIDER_KEY_APPS. Keys to add (Worker secrets): OPENAI_ADMIN_KEY, ANTHROPIC_ADMIN_KEY, and for Google GCP_BILLING_TABLE once the billing export is on.' }));
  return box;
}

// ── the usage bonus ──

let bonus = null; // { ready, active, settings, months } once read
let bonusMsg = '';
let capDraft = null; // what the owner typed in the cap field, kept across redraws until a cap save succeeds
const CAP_RE = /^\s*(\d+(\.\d*)?|\.\d+)\s*$/;

async function readBonus() {
  try {
    const r = await fetch('/api/admin/bonus-pool', { cache: 'no-store', credentials: 'same-origin' });
    bonus = r.ok ? await r.json() : { ready: false, error: r.status === 404 ? 'you’re signed out, or this isn’t the owner’s account' : `HTTP ${r.status}` };
  } catch (e) {
    bonus = { ready: false, error: e instanceof TypeError ? 'couldn’t reach askeden.com' : String(e && e.message) };
  }
}

const SAVE_CODES = {
  max_pct: 'The cap must be 0 to 50%.',
  on: 'That change wasn’t accepted.',
  tiers: 'That change wasn’t accepted.',
  body: 'That change wasn’t accepted.',
};
function saveError(status, code) {
  if (code && Object.hasOwn(SAVE_CODES, code)) return SAVE_CODES[code];
  if (status === 404) return 'You’re signed out, or this isn’t the owner’s account.';
  if (status === 415) return 'That change wasn’t accepted.';
  return `Not saved (HTTP ${status}).`;
}

async function saveBonus(change, redraw) {
  bonusMsg = 'Saving…';
  redraw();
  let r;
  try {
    r = await fetch('/api/admin/bonus-pool', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  } catch {
    bonusMsg = 'Couldn’t reach askeden.com. Try again.';
    redraw();
    return;
  }
  const j = await r.json().catch(() => ({}));
  if (r.ok && j && j.settings) {
    bonus = { ...(bonus || {}), ready: true, settings: j.settings };
    if ('max_pct' in change) capDraft = null;
    bonusMsg = 'Saved. New claims use it at once; the plan cards and meters show it within a minute.';
  } else {
    bonusMsg = saveError(r.status, j && j.error);
  }
  redraw();
}

/** The bonus switches: on/off, the cap in %, which plans; and the pool's months. `redraw` re-renders the page. */
export function bonusBox(h, redraw) {
  const { el } = h;
  remember(redraw);
  const box = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Usage bonus (Ultra, Platinum, Eden Black)' }),
        el('div', { class: 'grouped-desc', text: 'Extra AI each billing period, paid only from AI that expired unused. Never from anyone’s current allowance. The cap is a % of the plan’s own AI; the pool decides how much of it each person actually gets.' }),
      ),
    ),
  );
  if (!bonus) {
    box.append(el('p', { class: 'note', style: `padding:12px 16px;margin:0;${WRAP}`, text: 'Reading the bonus…' }));
    readBonus().then(redraw);
    return box;
  }
  if (!bonus.ready) {
    box.append(el('p', { class: 'note', style: `padding:12px 16px;margin:0;${WRAP}`, text: bonus.error ? `Couldn’t read it (${bonus.error}).` : 'The bonus pool isn’t on yet: it starts with the new plans (ALLOWANCE_V2 and PLANS_V2 on, and the BONUS_POOL binding).' }));
    return box;
  }
  if (bonus.active === false) {
    box.append(el('div', { class: 'v3-pill blue', role: 'note', style: `display:block;white-space:normal;margin:10px 16px 0;padding:8px 12px;border-radius:8px;font-size:12.5px;${WRAP}`, text: 'The bonus isn’t running yet: it starts when the new plans go on sale. What you set here is saved and used from then.' }));
  }
  const s = bonus.settings || { on: true, max_pct: 20, tiers: ['ultra', 'platinum', 'black'] };
  const tiers = Array.isArray(s.tiers) ? s.tiers : [];
  const pct = el('input', { type: 'number', id: 'bonus-cap', min: '0', max: '50', step: '0.5', value: capDraft ?? s.max_pct, style: 'width:80px', 'aria-label': 'Bonus cap, percent of the plan’s AI (0 to 50)' });
  pct.addEventListener('input', () => { capDraft = pct.value; });
  const saveCap = () => {
    const raw = pct.value;
    capDraft = raw;
    const n = CAP_RE.test(raw) ? Number(raw) : NaN;
    if (!(Number.isFinite(n) && n >= 0 && n <= 50)) { bonusMsg = 'Enter a number from 0 to 50.'; redraw(); return; }
    saveBonus({ max_pct: n }, redraw);
  };
  pct.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCap(); } });
  box.append(scroller(el, el('table', { class: 'mac-table' }, el('tbody', {},
    el('tr', {}, el('td', { style: 'font-weight:600', text: 'Bonus' }), el('td', {},
      el('label', {}, el('input', { type: 'checkbox', checked: s.on, 'aria-label': 'Bonus on', onchange: (e) => saveBonus({ on: e.target.checked }, redraw) }), s.on ? ' On' : ' Off'))),
    el('tr', {}, el('td', { style: 'font-weight:600' }, el('label', { for: 'bonus-cap', text: 'Cap' })), el('td', {},
      'Up to +', pct, '% of the plan’s AI ',
      el('button', { type: 'button', class: 'btn-mac', text: 'Save', 'aria-label': 'Save the cap', onclick: saveCap }))),
    el('tr', {}, el('td', { style: 'font-weight:600', text: 'Plans' }), el('td', {},
      Object.entries(TIER_NAMES).map(([t, name]) => el('label', { style: 'margin-right:14px;white-space:nowrap' },
        el('input', { type: 'checkbox', checked: tiers.includes(t), 'aria-label': `${name} gets the bonus`, onchange: (e) => saveBonus({ tiers: e.target.checked ? [...new Set([...tiers, t])] : tiers.filter((x) => x !== t) }, redraw) }), ` ${name}`)))),
  ))));
  if (bonusMsg) box.append(el('p', { class: 'note', role: 'status', style: NOTE_PAD, text: bonusMsg }));
  const months = bonus.months || [];
  box.append(scroller(el, el('table', { class: 'mac-table' },
    el('thead', {}, el('tr', {}, ['Month', 'Paid in (expired AI)', 'Could give', 'Given', 'Plans weighed'].map((t) => el('th', { text: t, style: 'white-space:nowrap' })))),
    el('tbody', {}, months.length ? months.slice(0, 12).map((m) => el('tr', {},
      el('td', { text: m.month }), el('td', { text: usd(m.contrib) }), el('td', { text: usd(m.avail) }), el('td', { text: usd(m.granted) }), el('td', { text: `$${Math.round(m.weight || 0)}` }),
    )) : [el('tr', {}, el('td', { colspan: '5', style: 'text-align:center;padding:16px', text: 'Nothing in the pool yet.' }))]),
  )));
  return box;
}

/** Forget what was read, so the next draw reads the bonus and the providers again (the page's Refresh). */
export function refreshSpend() {
  bonus = null;
  bonusMsg = '';
  prov.at = 0;
  prov.fresh = true;
}

/** The old name: admin.js's Refresh calls this. */
export function forgetBonus() {
  refreshSpend();
}
