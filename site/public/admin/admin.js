// The owner's dashboard (askeden.com/admin): draws GET /api/admin/stats and GET/POST /api/admin/keys.
// Supports both Version 3 (macOS Sequoia Glass API Keys, Spend Limits & Failover Controls) and the Classic Dashboard.

const PRODUCTS = {
  eden: 'Eden (web chat)', edu: 'Eden Edu', secretary: 'Eden Secretary', code: 'Eden Code', daredevil: 'Eden Daredevil',
  'ask-eden': 'Ask Eden (Mac beta)', apps: 'Mac & iPhone apps', messenger: 'Eden Messenger', router: 'Eden Router',
  business: 'Eden for Business', eves: 'EVES Verification', guides: 'SEO Guides',
  news: 'Eden News', help: 'Help', site: 'Website pages', other: 'Other',
};
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['total', 'All time']];

const KNOWN_MODELS = [
  { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o-mini' },
  { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  { id: 'o3-mini', label: 'OpenAI o3-mini (Reasoning)' },
  { id: 'kimi-k2', label: 'Moonshot Kimi K2' },
];

const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v; // the CSP allows no style attributes, only the CSSOM
    else if (k === 'onclick' && typeof v === 'function') node.addEventListener('click', v);
    else if (k === 'onchange' && typeof v === 'function') node.addEventListener('change', v);
    else if (k === 'checked') node.checked = Boolean(v);
    else if (k === 'disabled') node.disabled = Boolean(v);
    else if (k === 'value') node.value = String(v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}
const svgEl = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) node.append(kid);
  return node;
};

const int = (n) => (Number(n) || 0).toLocaleString();
const money = (n, cur = 'usd') => (Number(n) || 0).toLocaleString(undefined, { style: 'currency', currency: (cur || 'usd').toUpperCase(), maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
const cost = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: Number(n) > 0 && Number(n) < 1 ? 4 : 2 })}`;
const compact = (n) => (Number(n) || 0).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const product = (k) => PRODUCTS[k] || k || 'Other';
const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐');
const region = (() => { try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; } })();
const country = (cc) => (/^[A-Z]{2}$/.test(cc || '') && region ? region.of(cc) : cc === '??' || !cc ? 'Unknown' : cc);
const ago = (ms) => {
  const t = typeof ms === 'string' ? Date.parse(ms) : Number(ms);
  if (!Number.isFinite(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

/** State for UI mode (Version 3 macOS Glass vs Classic Dashboard) */
let currentData = null;
let uiMode = localStorage.getItem('eden.admin.mode') || 'v3'; // 'v3' | 'classic'
let v3Theme = localStorage.getItem('eden.admin.v3theme') || 'dark'; // 'dark' | 'light'
let v3Section = 'keys'; // 'keys' | 'limits' | 'alerts' | 'failover' | 'byok' | 'audit' | 'travel'
let latestSecret = null; // { name, key, note } shown once after create/rotate
let activeModal = null; // null | { kind: 'create'|'edit'|'usage', client?: obj, usage?: obj }
let statusBannerText = null;

function setUiMode(mode) {
  uiMode = mode;
  try { localStorage.setItem('eden.admin.mode', mode); } catch {}
  syncHeaderControls();
  if (currentData) render(currentData);
}

function setV3Theme(theme) {
  v3Theme = theme;
  try { localStorage.setItem('eden.admin.v3theme', theme); } catch {}
  if (currentData) render(currentData);
}

function syncHeaderControls() {
  const actions = $('.actions');
  if (!actions) return;
  let switcher = $('#mode-switcher');
  if (!switcher) {
    switcher = el('div', { id: 'mode-switcher', class: 'mode-switch' });
    actions.prepend(switcher);
  }
  switcher.replaceChildren(
    el('button', {
      type: 'button',
      class: `mode-btn${uiMode === 'v3' ? ' active' : ''}`,
      text: 'Version 3 (macOS Glass)',
      onclick: () => setUiMode('v3'),
    }),
    el('button', {
      type: 'button',
      class: `mode-btn${uiMode === 'classic' ? ' active' : ''}`,
      text: 'Classic Dashboard',
      onclick: () => setUiMode('classic'),
    }),
  );
}

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

/** Call POST /api/admin/keys and refresh dashboard state */
async function apiAdminKeyAction(payload) {
  const r = await fetch('/api/admin/keys', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `Request failed (${r.status})`);
  return out;
}

async function refreshRouterOnly() {
  const r = await fetch('/api/admin/keys', { credentials: 'same-origin', cache: 'no-store' });
  if (r.ok && currentData) {
    currentData.router = await r.json();
    render(currentData);
  }
}

// ── Version 3 (macOS Sequoia Glass Interface) ──

function spendBar(spent, limit) {
  const cap = Number(limit) || 0;
  const s = Number(spent) || 0;
  const pct = cap > 0 ? Math.min(100, Math.round((s / cap) * 1000) / 10) : 0;
  const tone = pct >= 95 ? 'red' : pct >= 80 ? 'amber' : 'green';
  return el('div', { class: 'spend-meter-box' },
    el('div', { class: 'spend-meta' },
      el('span', { text: cost(s) }),
      el('span', { style: 'color:var(--v3-text3)', text: cap > 0 ? `${cost(cap)}` : 'No cap' }),
    ),
    el('div', { class: 'mac-bar-track' },
      el('div', { class: `mac-bar-fill ${tone}`, style: `width:${cap > 0 ? Math.max(2, pct) : 0}%` }),
    ),
  );
}

function clientStatusPill(c) {
  if (c.revoked) return el('span', { class: 'v3-pill red' }, el('span', { class: 'pill-dot' }), 'Revoked');
  if (c.paused) return el('span', { class: 'v3-pill red' }, el('span', { class: 'pill-dot' }), 'Held');
  const dayPct = c.daily_usd > 0 ? ((c.spent_today_usd || 0) / c.daily_usd) * 100 : 0;
  const moPct = c.monthly_usd > 0 ? ((c.spent_month_usd || 0) / c.monthly_usd) * 100 : 0;
  const maxPct = Math.max(dayPct, moPct);
  if (maxPct >= 100) return el('span', { class: 'v3-pill red' }, el('span', { class: 'pill-dot' }), 'Cap Reached');
  if (maxPct >= 85) return el('span', { class: 'v3-pill amber' }, el('span', { class: 'pill-dot' }), `${Math.round(maxPct)}% Used`);
  return el('span', { class: 'v3-pill green' }, el('span', { class: 'pill-dot' }), 'Active');
}

function buildKeyModal(policy) {
  if (!activeModal) return null;
  if (activeModal.kind === 'usage') {
    const u = activeModal.usage || {};
    const c = u.client || activeModal.client || {};
    const dailyRows = (u.daily || []).map((d) => el('tr', {},
      el('td', { text: d.day }),
      el('td', { text: int(d.requests) }),
      el('td', { text: int(d.errors) }),
      el('td', { text: compact((d.tokens_in || 0) + (d.tokens_out || 0)) }),
      el('td', { text: cost(d.usd) }),
    ));
    const logRows = (u.data || []).slice(0, 25).map((l) => el('tr', {},
      el('td', { text: ago(l.time) }),
      el('td', { text: l.model || l.kind || 'chat' }),
      el('td', { text: l.provider || '—' }),
      el('td', { text: `${l.latency_ms || 0}ms` }),
      el('td', { text: cost(l.cost_usd) }),
      el('td', { text: String(l.status || 200) }),
    ));
    return el('div', {
      class: 'modal-overlay',
      onclick: (e) => { if (e.target.classList.contains('modal-overlay')) { activeModal = null; render(currentData); } },
    },
      el('div', { class: 'macos-sheet', style: 'width:680px;max-height:85vh;overflow-y:auto' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
          el('div', { class: 'sheet-title', text: `Usage & Spend History — ${c.name || c.id}` }),
          el('button', { type: 'button', class: 'btn-mac', text: '✕', onclick: () => { activeModal = null; render(currentData); } }),
        ),
        el('div', { class: 'grouped-box' },
          el('div', { class: 'grouped-header' }, el('div', { class: 'grouped-title', text: 'Last 7 Days (UTC)' })),
          el('table', { class: 'mac-table' },
            el('thead', {}, el('tr', {}, ['Day', 'Requests', 'Errors', 'Tokens', 'Spend (USD)'].map((h) => el('th', { text: h })))),
            el('tbody', {}, dailyRows.length ? dailyRows : [el('tr', {}, el('td', { colspan: '5', text: 'No usage recorded yet.' }))]),
          ),
        ),
        el('div', { class: 'grouped-box' },
          el('div', { class: 'grouped-header' }, el('div', { class: 'grouped-title', text: 'Recent Requests (No prompts or keys stored)' })),
          el('table', { class: 'mac-table' },
            el('thead', {}, el('tr', {}, ['When', 'Model', 'Provider', 'Latency', 'Cost', 'Status'].map((h) => el('th', { text: h })))),
            el('tbody', {}, logRows.length ? logRows : [el('tr', {}, el('td', { colspan: '6', text: 'No requests logged yet.' }))]),
          ),
        ),
      ),
    );
  }

  const isEdit = activeModal.kind === 'edit';
  const c = activeModal.client || {};
  const nameInput = el('input', { type: 'text', class: 'mac-input', placeholder: 'e.g. Production Mobile Gateway', value: c.name || '' });
  const dailyInput = el('input', { type: 'number', class: 'mac-input', step: '1', min: '0', value: c.daily_usd ?? 100 });
  const monthlyInput = el('input', { type: 'number', class: 'mac-input', step: '10', min: '0', placeholder: '2500', value: c.monthly_usd ?? 2500 });
  const rpmInput = el('input', { type: 'number', class: 'mac-input', step: '1', min: '1', value: c.rpm ?? 60 });
  const tagInput = el('input', { type: 'text', class: 'mac-input', placeholder: 'tag: enterprise', value: c.tag || '' });
  const ipInput = el('input', { type: 'text', class: 'mac-input', placeholder: 'e.g. 198.51.100.0/24 (optional)', value: (c.ip_whitelist || []).join(', ') });
  const breachSelect = el('select', { class: 'mac-input' },
    el('option', { value: 'failover', text: 'Divert to Secondary Failover Pool' }),
    el('option', { value: 'reject', text: 'Hard Reject (HTTP 429 Spend Cap)' }),
    el('option', { value: 'throttle', text: 'Throttle Rate Limit' }),
  );
  breachSelect.value = c.on_cap_breach || 'failover';
  const serviceCheck = el('input', { type: 'checkbox', checked: Boolean(c.service_keys) });

  const selectedModels = new Set(Array.isArray(c.models) && c.models.length ? c.models : []);
  const modelCheckboxes = KNOWN_MODELS.map((m) => {
    const cb = el('input', { type: 'checkbox', checked: selectedModels.has(m.id), style: 'margin-right:5px' });
    return { id: m.id, cb, node: el('label', { class: 'tag-badge accent', style: 'padding:4px 8px;cursor:pointer;display:inline-flex;align-items:center' }, cb, m.label) };
  });

  const errBox = el('div', { style: 'color:var(--v3-red);font-size:12px;display:none' });

  const submitBtn = el('button', {
    type: 'button',
    class: 'btn-mac primary',
    text: isEdit ? 'Save Changes' : 'Generate Key',
    onclick: async () => {
      submitBtn.disabled = true;
      errBox.style.display = 'none';
      try {
        const pickedModels = modelCheckboxes.filter((m) => m.cb.checked).map((m) => m.id);
        const payload = {
          action: isEdit ? 'update' : 'create',
          ...(isEdit ? { id: c.id } : {}),
          name: nameInput.value.trim() || 'API Client',
          daily_usd: Number(dailyInput.value) || 0,
          monthly_usd: monthlyInput.value === '' ? null : Number(monthlyInput.value),
          rpm: Math.max(1, Math.round(Number(rpmInput.value) || 60)),
          tag: tagInput.value.trim() || null,
          ip_whitelist: ipInput.value.trim() ? ipInput.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : null,
          on_cap_breach: breachSelect.value,
          service_keys: serviceCheck.checked,
          models: pickedModels.length ? pickedModels : null,
        };
        const out = await apiAdminKeyAction(payload);
        if (out.api_key) {
          latestSecret = { name: out.client?.name || payload.name, key: out.api_key, note: out.note || 'Shown once: copy now.' };
        }
        activeModal = null;
        statusBannerText = isEdit ? `Updated limits for ${payload.name}.` : `Created API key for ${payload.name}.`;
        await refreshRouterOnly();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.style.display = 'block';
        submitBtn.disabled = false;
      }
    },
  });

  return el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target.classList.contains('modal-overlay')) { activeModal = null; render(currentData); } },
  },
    el('div', { class: 'macos-sheet' },
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
        el('div', { class: 'sheet-title', text: isEdit ? `Edit API Key — ${c.name}` : 'New Scoped API Key' }),
        el('button', { type: 'button', class: 'btn-mac', text: '✕', onclick: () => { activeModal = null; render(currentData); } }),
      ),
      errBox,
      el('div', { class: 'form-row' },
        el('label', { class: 'form-label', text: 'Key Name / Identifier' }),
        nameInput,
      ),
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
        el('div', { class: 'form-row' },
          el('label', { class: 'form-label', text: 'Daily Spend Limit (USD)' }),
          dailyInput,
        ),
        el('div', { class: 'form-row' },
          el('label', { class: 'form-label', text: 'Monthly Failover Cap (USD)' }),
          monthlyInput,
        ),
      ),
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
        el('div', { class: 'form-row' },
          el('label', { class: 'form-label', text: 'Rate Limit (RPM)' }),
          rpmInput,
        ),
        el('div', { class: 'form-row' },
          el('label', { class: 'form-label', text: 'Cost Center Tag' }),
          tagInput,
        ),
      ),
      el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
        el('div', { class: 'form-row' },
          el('label', { class: 'form-label', text: 'IP CIDR Whitelist (Optional)' }),
          ipInput,
        ),
        el('div', { class: 'form-row' },
          el('label', { class: 'form-label', text: 'On Cap Breach' }),
          breachSelect,
        ),
      ),
      el('div', { class: 'form-row' },
        el('label', { class: 'form-label', text: 'Allowed Models (Leave unchecked for All Models *)' }),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:2px' }, modelCheckboxes.map((m) => m.node)),
      ),
      el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:12px;color:var(--v3-text2);cursor:pointer' },
        serviceCheck,
        'Allow key to use Eden Worker service provider keys when client headers are omitted',
      ),
      el('div', { style: 'display:flex;justify-content:flex-end;gap:10px;margin-top:6px' },
        el('button', { type: 'button', class: 'btn-mac', text: 'Cancel', onclick: () => { activeModal = null; render(currentData); } }),
        submitBtn,
      ),
    ),
  );
}

function renderV3(data) {
  const main = $('#main');
  main.replaceChildren();
  const rtr = data.router || {};
  const clients = rtr.clients || [];
  const totals = rtr.totals || {};
  const policy = rtr.policy || {
    daily_pool_cap_usd: 500,
    monthly_pool_cap_usd: 10000,
    slack_alerts_enabled: true,
    webhook_url: '',
    alert_thresholds: [50, 80, 95],
    ttft_breaker_enabled: true,
    ttft_threshold_ms: 2500,
    burst_429_failover: true,
    rotation_grace_24h: true,
    atomic_hold_enabled: true,
    fallback_chain: [
      { rank: 1, provider: 'anthropic', name: 'Anthropic Direct Pool', models: 'Claude 3.5 Sonnet / Haiku', status: 'primary' },
      { rank: 2, provider: 'openai', name: 'OpenAI Scale Pool', models: 'GPT-4o / 4o-mini', status: 'hot_standby' },
      { rank: 3, provider: 'gemini', name: 'Google Gemini 1.5 Pro', models: 'Gemini 1.5 Pro / Flash', status: 'hot_standby' },
      { rank: 4, provider: 'kimi', name: 'Moonshot Kimi K2', models: 'Kimi K2 Long Context', status: 'cold_standby' },
    ],
  };
  const audits = rtr.audits || [];
  const providers = rtr.providers || [
    { id: 'anthropic', name: 'Anthropic', configured: true },
    { id: 'openai', name: 'OpenAI', configured: true },
    { id: 'gemini', name: 'Google Gemini', configured: true },
    { id: 'kimi', name: 'Moonshot Kimi', configured: false },
  ];

  const activeCount = totals.active_keys ?? clients.filter((c) => !c.revoked && !c.paused).length;
  const pausedCount = totals.paused_keys ?? clients.filter((c) => !c.revoked && c.paused).length;
  const spentToday = Number(totals.spent_today_usd || 0);
  const spentMonth = Number(totals.spent_month_usd || 0);
  const dailyPoolCap = Number(policy.daily_pool_cap_usd || 500);
  const monthlyPoolCap = Number(policy.monthly_pool_cap_usd || 10000);
  const dailyPoolPct = dailyPoolCap > 0 ? Math.min(100, Math.round((spentToday / dailyPoolCap) * 1000) / 10) : 0;

  const navItem = (id, label, badge = null) => el('button', {
    type: 'button',
    class: `nav-item${v3Section === id ? ' active' : ''}`,
    onclick: () => { v3Section = id; render(currentData); },
  },
    el('span', { class: 'nav-item-left' }, el('span', { text: label })),
    badge !== null ? el('span', { class: 'nav-badge', text: String(badge) }) : null,
  );

  // Build Keys Table
  const keyRows = clients.map((c) => {
    const modelsNode = Array.isArray(c.models) && c.models.length
      ? el('div', {}, c.models.map((m) => el('span', { class: 'tag-badge accent', text: m })))
      : el('span', { class: 'tag-badge accent', text: 'All Models (*)' });

    const rotateBtn = !c.revoked ? el('button', {
      type: 'button',
      class: 'btn-mac',
      text: 'Rotate',
      onclick: async () => {
        rotateBtn.disabled = true;
        try {
          const graceMs = policy.rotation_grace_24h ? 86_400_000 : 0;
          const out = await apiAdminKeyAction({ action: 'rotate', id: c.id, grace_period_ms: graceMs });
          latestSecret = { name: c.name, key: out.api_key, note: out.note };
          statusBannerText = `Rotated key for ${c.name}.`;
          await refreshRouterOnly();
        } catch (err) {
          statusBannerText = `Rotate failed: ${err.message}`;
          render(currentData);
        }
      },
    }) : null;

    const editBtn = !c.revoked ? el('button', {
      type: 'button',
      class: 'btn-mac',
      text: 'Edit',
      onclick: () => {
        activeModal = { kind: 'edit', client: c };
        render(currentData);
      },
    }) : null;

    const holdBtn = !c.revoked ? el('button', {
      type: 'button',
      class: 'btn-mac',
      text: c.paused ? 'Resume' : 'Hold',
      onclick: async () => {
        holdBtn.disabled = true;
        try {
          await apiAdminKeyAction({ action: c.paused ? 'resume' : 'pause', id: c.id });
          statusBannerText = `${c.paused ? 'Resumed' : 'Held'} key ${c.name}.`;
          await refreshRouterOnly();
        } catch (err) {
          statusBannerText = err.message;
          render(currentData);
        }
      },
    }) : null;

    const usageBtn = el('button', {
      type: 'button',
      class: 'btn-mac',
      text: 'Usage',
      onclick: async () => {
        usageBtn.disabled = true;
        try {
          const u = await apiAdminKeyAction({ action: 'usage', id: c.id, limit: 30, days: 7 });
          activeModal = { kind: 'usage', client: c, usage: u };
          render(currentData);
        } catch (err) {
          statusBannerText = err.message;
          render(currentData);
        }
      },
    });

    const revokeBtn = !c.revoked ? el('button', {
      type: 'button',
      class: 'btn-mac danger',
      text: 'Revoke',
      onclick: async () => {
        if (!window.confirm(`Revoke API key "${c.name}" (${c.key_hint})? This cannot be undone.`)) return;
        revokeBtn.disabled = true;
        try {
          await apiAdminKeyAction({ action: 'revoke', id: c.id });
          statusBannerText = `Revoked key ${c.name}.`;
          await refreshRouterOnly();
        } catch (err) {
          statusBannerText = err.message;
          render(currentData);
        }
      },
    }) : null;

    return el('tr', {},
      el('td', {},
        el('div', { style: 'font-weight:600', text: c.name }),
        el('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap' },
          el('span', { class: 'key-code', text: c.key_hint }),
          c.tag ? el('span', { class: 'tag-badge', text: c.tag }) : null,
          c.ip_whitelist && c.ip_whitelist.length ? el('span', { class: 'tag-badge', text: `IP: ${c.ip_whitelist.join(', ')}` }) : null,
          c.grace_until ? el('span', { class: 'tag-badge accent', text: '24h grace active' }) : null,
        ),
      ),
      el('td', {}, clientStatusPill(c)),
      el('td', {}, modelsNode),
      el('td', {}, spendBar(c.spent_today_usd || 0, c.daily_usd)),
      el('td', {}, spendBar(c.spent_month_usd || 0, c.monthly_usd ?? (c.daily_usd * 30))),
      el('td', {}, el('b', { text: String(c.rpm) })),
      el('td', { style: 'text-align:right;white-space:nowrap' },
        el('div', { style: 'display:inline-flex;gap:5px;flex-wrap:nowrap;justify-content:flex-end' },
          rotateBtn, editBtn, holdBtn, usageBtn, revokeBtn,
        ),
      ),
    );
  });

  const keysBox = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Registered API Keys & Per-Key Spending Limits' }),
        el('div', { class: 'grouped-desc', text: 'Keys are hashed with SHA-256 in the Router Durable Object. Raw secrets are shown only once upon creation or rotation.' }),
      ),
      el('button', {
        type: 'button',
        class: 'btn-mac primary',
        text: '+ Generate API Key',
        onclick: () => { activeModal = { kind: 'create' }; render(currentData); },
      }),
    ),
    el('div', { class: 'scroll' },
      el('table', { class: 'mac-table' },
        el('thead', {}, el('tr', {}, ['Key Name & Token', 'Status', 'Allowed Models', 'Daily Limit (24h)', 'Monthly Cap', 'RPM', 'Actions'].map((h, i) => el('th', { style: i === 6 ? 'text-align:right' : '', text: h })))),
        el('tbody', {}, keyRows.length ? keyRows : [
          el('tr', {}, el('td', { colspan: '7', style: 'text-align:center;padding:24px;color:var(--v3-text2)' },
            'No API keys registered yet. Click "+ Generate API Key" to create your first scoped key with daily and monthly spend limits.',
          )),
        ]),
      ),
    ),
  );

  // Failover & Alert Policy Controls
  const slackToggle = el('input', { type: 'checkbox', checked: policy.slack_alerts_enabled !== false });
  const ttftToggle = el('input', { type: 'checkbox', checked: policy.ttft_breaker_enabled !== false });
  const burst429Toggle = el('input', { type: 'checkbox', checked: policy.burst_429_failover !== false });
  const grace24hToggle = el('input', { type: 'checkbox', checked: policy.rotation_grace_24h !== false });
  const atomicHoldToggle = el('input', { type: 'checkbox', checked: policy.atomic_hold_enabled !== false });
  const dailyPoolInput = el('input', { type: 'number', class: 'mac-input', style: 'width:130px', value: dailyPoolCap });
  const monthlyPoolInput = el('input', { type: 'number', class: 'mac-input', style: 'width:130px', value: monthlyPoolCap });
  const ttftMsInput = el('input', { type: 'number', class: 'mac-input', style: 'width:110px', value: policy.ttft_threshold_ms || 2500 });
  const webhookInput = el('input', { type: 'text', class: 'mac-input', placeholder: 'https://hooks.slack.com/services/...', value: policy.webhook_url || '' });

  const savePolicyBtn = el('button', {
    type: 'button',
    class: 'btn-mac primary',
    text: 'Save Failover & Alert Policy',
    onclick: async () => {
      savePolicyBtn.disabled = true;
      try {
        await apiAdminKeyAction({
          action: 'policy',
          policy: {
            daily_pool_cap_usd: Number(dailyPoolInput.value) || 500,
            monthly_pool_cap_usd: Number(monthlyPoolInput.value) || 10000,
            slack_alerts_enabled: slackToggle.checked,
            webhook_url: webhookInput.value.trim(),
            ttft_breaker_enabled: ttftToggle.checked,
            ttft_threshold_ms: Number(ttftMsInput.value) || 2500,
            burst_429_failover: burst429Toggle.checked,
            rotation_grace_24h: grace24hToggle.checked,
            atomic_hold_enabled: atomicHoldToggle.checked,
            fallback_chain: policy.fallback_chain,
          },
        });
        statusBannerText = 'Saved monthly failover controls and alert thresholds.';
        await refreshRouterOnly();
      } catch (err) {
        statusBannerText = `Failed to save policy: ${err.message}`;
        render(currentData);
      }
    },
  });

  const chainRows = (policy.fallback_chain || []).map((node, idx, arr) => el('div', { class: 'policy-row' },
    el('div', { style: 'display:flex;align-items:center;gap:12px' },
      el('span', { class: 'v3-pill blue', text: `#${idx + 1}` }),
      el('div', {},
        el('div', { style: 'font-weight:600;font-size:13px', text: node.name }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: `${node.models} · Provider: ${node.provider}` }),
      ),
    ),
    el('div', { style: 'display:flex;align-items:center;gap:8px' },
      el('span', { class: `v3-pill ${idx === 0 ? 'green' : 'blue'}`, text: idx === 0 ? 'Primary Active' : idx < 3 ? 'Hot Standby' : 'Cold Standby' }),
      idx > 0 ? el('button', {
        type: 'button',
        class: 'btn-mac',
        text: '↑ Promote',
        onclick: async () => {
          const nextChain = [...arr];
          const [picked] = nextChain.splice(idx, 1);
          nextChain.splice(idx - 1, 0, picked);
          nextChain.forEach((n, i) => { n.rank = i + 1; });
          await apiAdminKeyAction({ action: 'policy', policy: { fallback_chain: nextChain } });
          statusBannerText = `Promoted ${node.name} to priority #${idx}.`;
          await refreshRouterOnly();
        },
      }) : null,
    ),
  ));

  const failoverBox = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Monthly Failover Controls, Provider Chain & Alert Thresholds' }),
        el('div', { class: 'grouped-desc', text: 'Policies trigger automatically when spend ceilings or upstream provider rate limits are reached.' }),
      ),
      savePolicyBtn,
    ),
    el('div', { class: 'policy-row' },
      el('div', {},
        el('div', { style: 'font-size:13px;font-weight:600', text: 'Global Pool Spending Ceilings (Daily & Monthly)' }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: 'Aggregate daily 24h cap and monthly failover cap across all keys.' }),
      ),
      el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
        el('label', { style: 'font-size:12px;color:var(--v3-text2);display:flex;align-items:center;gap:6px' }, 'Daily ($):', dailyPoolInput),
        el('label', { style: 'font-size:12px;color:var(--v3-text2);display:flex;align-items:center;gap:6px' }, 'Monthly ($):', monthlyPoolInput),
      ),
    ),
    el('div', { class: 'policy-row' },
      el('div', {},
        el('div', { style: 'font-size:13px;font-weight:600', text: 'Slack & Webhook Early Warning (50%, 80%, 95%)' }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: 'Notify team at 50%, 80%, and 95% spend thresholds before cut-off.' }),
      ),
      el('label', { class: 'mac-switch' }, slackToggle, el('span', { class: 'mac-slider' })),
    ),
    el('div', { class: 'policy-row' },
      el('div', {},
        el('div', { style: 'font-size:13px;font-weight:600', text: 'TTFT Latency Circuit Breaker' }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: 'Automatically divert key traffic to fallback provider if primary stream hangs past threshold (ms).' }),
      ),
      el('div', { style: 'display:flex;align-items:center;gap:10px' },
        ttftMsInput,
        el('label', { class: 'mac-switch' }, ttftToggle, el('span', { class: 'mac-slider' })),
      ),
    ),
    el('div', { class: 'policy-row' },
      el('div', {},
        el('div', { style: 'font-size:13px;font-weight:600', text: 'Burst 429 Provider Failover' }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: 'Immediate diversion to standby provider pool on upstream quota refusal.' }),
      ),
      el('label', { class: 'mac-switch' }, burst429Toggle, el('span', { class: 'mac-slider' })),
    ),
    el('div', { class: 'policy-row' },
      el('div', {},
        el('div', { style: 'font-size:13px;font-weight:600', text: 'Zero-Downtime 24h Rotation Grace Period' }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: 'Maintains the retiring SHA-256 hash valid for 24h so production servers can roll keys safely.' }),
      ),
      el('label', { class: 'mac-switch' }, grace24hToggle, el('span', { class: 'mac-slider' })),
    ),
    el('div', { class: 'policy-row' },
      el('div', {},
        el('div', { style: 'font-size:13px;font-weight:600', text: 'Atomic Hold on Limit Breach' }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2)', text: 'Reserves estimated cost before upstream call and rejects breaches once hard limit is reached.' }),
      ),
      el('label', { class: 'mac-switch' }, atomicHoldToggle, el('span', { class: 'mac-slider' })),
    ),
    el('div', { class: 'policy-row' },
      el('div', { style: 'flex:1' },
        el('div', { style: 'font-size:12px;font-weight:600;margin-bottom:4px', text: 'Slack / Alert Webhook Endpoint' }),
        webhookInput,
      ),
    ),
  );

  const chainBox = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Autonomous Provider Fallback Sequence' }),
        el('div', { class: 'grouped-desc', text: 'Order of upstream provider pools used when failover triggers.' }),
      ),
      el('span', { class: 'v3-pill green' }, el('span', { class: 'pill-dot' }), 'Auto-Reroute Healthy'),
    ),
    ...chainRows,
  );

  // BYOK & Upstream Provider Status Box
  const byokBox = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Upstream Provider BYOK & Service Key Health' }),
        el('div', { class: 'grouped-desc', text: 'Service-level provider credentials configured on the Worker and 30-day model burn.' }),
      ),
    ),
    el('table', { class: 'mac-table' },
      el('thead', {}, el('tr', {}, ['Provider', 'Worker Key Status', 'Failover Role', '30d AI Spend'].map((h) => el('th', { text: h })))),
      el('tbody', {}, providers.map((p, idx) => {
        const modelSpend = ((data.events?.ai?.by_model) || [])
          .filter((m) => String(m.name || '').toLowerCase().includes(p.id === 'anthropic' ? 'claude' : p.id === 'openai' ? 'gpt' : p.id))
          .reduce((acc, m) => acc + (Number(m.usd) || 0), 0);
        return el('tr', {},
          el('td', { style: 'font-weight:600', text: p.name }),
          el('td', {}, el('span', { class: `v3-pill ${p.configured ? 'green' : 'amber'}` }, el('span', { class: 'pill-dot' }), p.configured ? 'Configured' : 'Client Header Only')),
          el('td', { text: idx === 0 ? 'Tier 1 Primary' : `Tier ${idx + 1} Fallback` }),
          el('td', { text: cost(modelSpend) }),
        );
      })),
    ),
  );

  // Audit Trail Box
  const auditBox = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Admin Key & Policy Audit Trail' }),
        el('div', { class: 'grouped-desc', text: 'Immutable log of key creations, rotations, limit adjustments, holds, and failover policy updates.' }),
      ),
    ),
    el('table', { class: 'mac-table' },
      el('thead', {}, el('tr', {}, ['When', 'Action', 'Target', 'Details', 'Actor'].map((h) => el('th', { text: h })))),
      el('tbody', {}, audits.length ? audits.map((a) => el('tr', {},
        el('td', { text: ago(a.time) }),
        el('td', {}, el('span', { class: `v3-pill ${a.action === 'revoke' || a.action === 'pause' ? 'red' : 'blue'}`, text: a.action })),
        el('td', { style: 'font-weight:600', text: a.target_name || a.target_id || '—' }),
        el('td', { text: a.detail || '—' }),
        el('td', { text: a.actor || 'owner' }),
      )) : [el('tr', {}, el('td', { colspan: '5', style: 'text-align:center;padding:20px;color:var(--v3-text2)' }, 'No admin actions recorded yet.'))]),
    ),
  );

  // Eden Travel's card payments to sort out by hand (src/travel/pay.js flags): the classic page's rows, in this layout
  const travel = data.travel || {};
  const travelFlags = travel.flags || [];
  const travelBox = el('div', { class: 'grouped-box' },
    el('div', { class: 'grouped-header' },
      el('div', {},
        el('div', { class: 'grouped-title', text: 'Travel refunds' }),
        el('div', { class: 'grouped-desc', text: TRAVEL_NOTE }),
      ),
    ),
    el('table', { class: 'mac-table' },
      el('thead', {}, el('tr', {}, ['Account', 'Booking', 'Amount', 'Currency', 'Why', 'Since', 'Tries', ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, travel.ready === false
        ? [el('tr', {}, el('td', { colspan: '8', style: 'text-align:center;padding:20px;color:var(--v3-text2)' }, `Couldn’t read the flags${travel.error ? ` (${travel.error})` : ''}.`))]
        : travelFlags.length ? travelFlags.map((f) => el('tr', {}, ...travelCells(f, true).map((c) => el('td', {}, c))))
          : [el('tr', {}, el('td', { colspan: '8', style: 'text-align:center;padding:20px;color:var(--v3-text2)' }, 'Nothing to sort out.'))]),
    ),
  );

  // Determine which sections to display based on sidebar selection
  const bodyNodes = [];

  if (latestSecret) {
    bodyNodes.push(el('div', { class: 'secret-banner' },
      el('div', {},
        el('div', { style: 'font-weight:600;font-size:13.5px', text: `API Key for "${latestSecret.name}" (Shown Once)` }),
        el('div', { style: 'font-family:var(--font-mono);font-size:13px;margin-top:4px;word-break:break-all', text: latestSecret.key }),
        el('div', { style: 'font-size:11.5px;color:var(--v3-text2);margin-top:2px', text: latestSecret.note }),
      ),
      el('div', { style: 'display:flex;gap:8px' },
        el('button', {
          type: 'button',
          class: 'btn-mac primary',
          text: 'Copy Secret Key',
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(latestSecret.key);
              e.currentTarget.textContent = 'Copied!';
            } catch {}
          },
        }),
        el('button', {
          type: 'button',
          class: 'btn-mac',
          text: 'Dismiss',
          onclick: () => { latestSecret = null; render(currentData); },
        }),
      ),
    ));
  }

  if (statusBannerText) {
    bodyNodes.push(el('div', { class: 'grouped-box', style: 'padding:10px 14px;display:flex;justify-content:space-between;align-items:center' },
      el('span', { style: 'font-size:12.5px', text: statusBannerText }),
      el('button', { type: 'button', class: 'btn-mac', text: 'Dismiss', onclick: () => { statusBannerText = null; render(currentData); } }),
    ));
  }

  // Always show KPI row at top of V3
  const primaryProvider = (policy.fallback_chain && policy.fallback_chain[0] && policy.fallback_chain[0].name) || 'Anthropic Direct';
  bodyNodes.push(el('div', { class: 'kpi-row' },
    el('div', { class: 'kpi-card' },
      el('div', { class: 'label', text: 'Active Router Keys' }),
      el('div', { class: 'value', text: int(activeCount) }),
      el('div', { class: 'sub' },
        el('span', { class: `v3-pill ${pausedCount > 0 ? 'amber' : 'green'}` }, el('span', { class: 'pill-dot' }), pausedCount > 0 ? `${pausedCount} Held` : 'All Operational'),
      ),
    ),
    el('div', { class: 'kpi-card' },
      el('div', { class: 'label', text: '24h Combined Spend' }),
      el('div', { class: 'value', text: cost(spentToday) }),
      el('div', { class: 'sub', text: `of ${cost(dailyPoolCap)} daily ceiling (${dailyPoolPct}%)` }),
    ),
    el('div', { class: 'kpi-card' },
      el('div', { class: 'label', text: 'Monthly Projected Burn' }),
      el('div', { class: 'value', text: cost(spentMonth) }),
      el('div', { class: 'sub', text: `of ${cost(monthlyPoolCap)} monthly failover limit` }),
    ),
    el('div', { class: 'kpi-card' },
      el('div', { class: 'label', text: 'Failover Circuit State' }),
      el('div', { class: 'value', style: 'color:var(--v3-green)', text: 'Tier 1 Active' }),
      el('div', { class: 'sub', text: `${primaryProvider} · ${int(totals.errors_today || 0)} errors today` }),
    ),
  ));

  if (v3Section === 'keys') {
    bodyNodes.push(keysBox, failoverBox, chainBox);
  } else if (v3Section === 'limits') {
    bodyNodes.push(keysBox, failoverBox);
  } else if (v3Section === 'alerts') {
    bodyNodes.push(failoverBox);
  } else if (v3Section === 'failover') {
    bodyNodes.push(chainBox, failoverBox);
  } else if (v3Section === 'byok') {
    bodyNodes.push(byokBox, chainBox);
  } else if (v3Section === 'audit') {
    bodyNodes.push(auditBox);
  } else if (v3Section === 'travel') {
    bodyNodes.push(travelBox);
  }

  const shell = el('div', { class: 'v3-shell', 'data-v3-theme': v3Theme },
    el('div', { class: 'macos-window' },
      el('aside', { class: 'macos-sidebar' },
        el('div', { class: 'traffic-lights' },
          el('div', { class: 'traffic-dots' },
            el('div', { class: 'traffic-light traffic-close' }),
            el('div', { class: 'traffic-light traffic-min' }),
            el('div', { class: 'traffic-light traffic-max' }),
          ),
          el('button', {
            type: 'button',
            class: 'btn-mac',
            style: 'font-size:11px;padding:3px 8px',
            text: v3Theme === 'dark' ? '☀ Light' : '☾ Dark',
            onclick: () => setV3Theme(v3Theme === 'dark' ? 'light' : 'dark'),
          }),
        ),
        el('div', { class: 'sidebar-section-title', text: 'Router & Keys' }),
        el('div', { class: 'sidebar-nav' },
          navItem('keys', 'API Keys', clients.length),
          navItem('limits', 'Spending Limits'),
          navItem('alerts', 'Alert Rules', (policy.alert_thresholds || [50, 80, 95]).length),
        ),
        el('div', { class: 'sidebar-section-title', text: 'Resilience & BYOK' }),
        el('div', { class: 'sidebar-nav' },
          navItem('failover', 'Provider Failover'),
          navItem('byok', 'BYOK Balances'),
          navItem('audit', 'Audit Trail', audits.length || null),
        ),
        el('div', { class: 'sidebar-section-title', text: 'Eden Travel' }),
        el('div', { class: 'sidebar-nav' },
          navItem('travel', 'Travel Refunds', travel.ready === false ? '!' : travelFlags.length || null),
        ),
        el('div', { class: 'sidebar-section-title', text: 'Site & Revenue' }),
        el('div', { class: 'sidebar-nav' },
          el('button', {
            type: 'button',
            class: 'nav-item',
            onclick: () => setUiMode('classic'),
          },
            el('span', { class: 'nav-item-left' }, el('span', { text: 'Classic Dashboard →' })),
          ),
        ),
      ),
      el('div', { class: 'macos-main' },
        el('header', { class: 'macos-toolbar' },
          el('div', { class: 'toolbar-title' }, el('span', { text: 'API Keys, Spending Limits & Monthly Failover Controls' })),
          el('div', { class: 'toolbar-actions' },
            el('a', { class: 'btn-mac', href: '/api/admin/keys?format=csv', text: 'Export CSV' }),
            el('button', {
              type: 'button',
              class: 'btn-mac primary',
              text: '+ Generate API Key',
              onclick: () => { activeModal = { kind: 'create' }; render(currentData); },
            }),
          ),
        ),
        el('div', { class: 'content-body' }, ...bodyNodes),
      ),
    ),
    buildKeyModal(policy),
  );

  main.append(shell);
}

// ── Classic Dashboard (100% preserved) ──

function renderClassic(data) {
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
    row('Email & SMS leads', (p) => int(per('lead', p))),
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

  // Leads, Campaigns & Conversion Funnel
  const ld = data.leads || {};
  const AUDIENCE_NAMES = { 'power-user': 'AI Power Users', educator: 'Educators & Faculty', api: 'Developers / API & Agents', general: 'General' };
  const FUNNEL_NAMES = {
    cta_signin: 'CTA · Sign in (browser)',
    cta_edu_pilot: 'CTA · Edu Pilot',
    cta_download_mac: 'CTA · Download Mac',
    cta_download_windows: 'CTA · Download Windows',
    cta_case_study: 'CTA · Guides',
    cta_router_api: 'CTA · Router API',
    lead_submit: 'Lead Form Submitted',
    exit_intent_shown: 'Exit-Intent Shown',
    exit_intent_dismissed: 'Exit-Intent Dismissed',
  };
  const utmRefs = (ev.referrers || []).filter((r) => String(r.name || '').startsWith('utm:'));
  main.append(...section(
    'Leads, Campaigns & Conversion Funnel',
    'Email & SMS leads captured across askeden.com, askedenedu.com, evesverification.com and edenrouter.com, synced to Klaviyo.',
    el('div', { class: 'grid g3' },
      card('Captured leads by segment',
        el('p', { class: 'note' }, `${int(ld.total)} total · ${int(ld.sms)} SMS opt-ins · ${int(ld.klaviyo)} synced to Klaviyo · `,
          el('a', { href: '/api/admin/leads?format=csv', text: 'Download CSV' })),
        bars((ld.by_audience || []).map((a) => ({ label: AUDIENCE_NAMES[a.name] || a.name, value: a.n })))),
      card('Conversion funnel (last 30 days)',
        bars((ev.funnel || []).map((f) => ({ label: FUNNEL_NAMES[f.name] || f.name, value: f.n, sub: product(f.product) })))),
      card('UTM campaign traffic (last 30 days)',
        bars(utmRefs.map((r) => ({ label: String(r.name).replace(/^utm:/, ''), value: r.n }))))),
    card('Recent leads', table(
      ['Email', 'Segment', 'Organization / Course', 'Page & UTM', 'SMS', 'Klaviyo', 'When'],
      (ld.recent || []).map((r) => [
        r.email || '',
        AUDIENCE_NAMES[r.audience] || r.audience || 'general',
        r.organization || '—',
        [r.source_page || '/', [r.utm_source, r.utm_campaign].filter(Boolean).join('/')].filter(Boolean).join(' · '),
        r.phone ? r.phone : '—',
        r.klaviyo_synced ? 'Synced' : 'Local D1',
        r.updated_at ? ago(r.updated_at) : '—',
      ]),
    )),
  ));

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

function render(data) {
  currentData = data;
  syncHeaderControls();
  if (uiMode === 'classic') renderClassic(data);
  else renderV3(data);
}

const WHY = { refund_failed: 'Refund failing', refund_currency: 'Other currency', stuck: 'Stuck booking' };
const cents = (n, cur) => { try { return (Number(n) / 100).toLocaleString(undefined, { style: 'currency', currency: cur }); } catch { return `${cur || ''} ${(Number(n) / 100).toFixed(2)}`; } };

/** Travel refunds: one row per open flag, each with Mark resolved (after it's sorted in Stripe or with the provider). */
const TRAVEL_NOTE = 'Eden Travel card payments Eden couldn’t finish on its own. Sort each out in Stripe (or with the provider), then mark it resolved; that changes nothing at Stripe.';

/** One flag's cells, for the classic table (pill) and the v3 box (v3 = true: v3-pill, btn-mac). */
function travelCells(f, v3 = false) {
  const button = el('button', { type: 'button', class: v3 ? 'btn-mac' : '', text: 'Mark resolved' });
  button.addEventListener('click', () => resolveFlag(f, button));
  const red = f.gave_up || f.why === 'stuck';
  return [
    el('span', { class: 'err', title: f.account, text: f.account_short || '' }),
    el('div', {}, f.title || f.kind || '', el('div', { class: 'note', text: [f.booking, f.pay_id].filter(Boolean).join(' · ') })),
    Number.isFinite(f.cents) ? cents(f.cents, f.currency) : '',
    f.currency || '',
    el('div', {}, el('span', { class: v3 ? `v3-pill ${red ? 'red' : 'amber'}` : `pill${red ? ' red' : ''}`, text: WHY[f.why] || f.why }), el('div', { class: 'note', text: f.text || '' })),
    f.since ? ago(f.since) : '',
    int(f.tries),
    button,
  ];
}

function travelSection(t) {
  const note = TRAVEL_NOTE;
  if (t.ready === false) return section('Travel refunds', note, card(null, empty(`Couldn’t read the flags${t.error ? ` (${t.error})` : ''}.`)));
  const rows = (t.flags || []).map((f) => travelCells(f));
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
syncHeaderControls();
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120_000);
