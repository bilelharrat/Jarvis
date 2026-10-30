// Saved workflows (ROADMAP H9): any conversation becomes a reusable recipe — its prompt with
// {blanks} where the parts that change were, the router level and model it used, and its
// attachments as optional slots — run in one tap from the Workflows gallery (a small form for
// the blanks), or on a schedule (a background task with a time trigger: tasks.js).
// workflow-model.js is the pure part (extraction, filling, merging).
//
// Stored in this browser (localStorage `eden:workflows`, deletions kept as tombstones) and, at
// askeden.com with end-to-end sync on (sync.js, H1), as one sealed item `eden/workflows` in the
// account's encrypted sync, merged by id (the newer edit wins). askeden.com can't read it.
// Team spaces (spaces.js, G8): at askeden.com spaces.js registers a sharer (registerWorkflowSharer),
// which seals a workflow with a space's key like a shared conversation; members add it to their
// own gallery (importWorkflow). Until something registers, "Share to a space" isn't offered
// (Copy recipe works everywhere).

import { el, ico, toast, copyText } from './util.js';
import { state } from './state.js';
import { apiUrl } from './api.js';
import { acting } from './acting.js';
import { t } from './i18n.js';
import { checkWorkflow, extractWorkflow, fillTemplate, findBlanks, blanksIn, blankKey, mergeWorkflows, templateFrom } from './workflow-model.js';

const KEY = 'eden:workflows';
const SYNC_ITEM = 'eden/workflows';
const LEVELS = { 1: 'Max efficiency', 2: 'Efficient', 3: 'Balanced', 4: 'Performance', 5: 'Max performance' };
const MODES = [['chat', 'Chat'], ['search', 'Search'], ['research', 'Research']];

let H = {};
let sheet = null;
let view = { kind: 'gallery' };
let returnFocus = null;
let sharer = null;
let syncTimer = null;

/* ---------------- storage ---------------- */

function stored() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function storeAll(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { toast('This browser couldn’t save the workflow (storage is full or off).'); }
}
export const workflows = () => stored().filter((w) => !w.deleted).sort((a, b) => (b.updated || 0) - (a.updated || 0));
function put(w) {
  const list = stored().filter((x) => x.id !== w.id);
  list.unshift({ ...w, updated: Date.now() });
  storeAll(list);
  queueSync();
}
function remove(id) {
  const list = stored().map((x) => (x.id === id ? { id, deleted: true, updated: Date.now() } : x));
  storeAll(list);
  queueSync();
}

/** A space (spaces.js) offers to take workflows: fn(workflow) → Promise<string> (what to tell the owner; '' says nothing). */
export function registerWorkflowSharer(fn) { sharer = typeof fn === 'function' ? fn : null; }

/**
 * A workflow shared in a team space, added to this gallery (spaces.js "Add to my workflows").
 * Its own id (the shared one, marked), so adding it again updates this copy and never touches
 * the sharer's own; `from`: { space, by } for its chip. → the copy as stored.
 */
export function importWorkflow(w, from = {}) {
  const base = String((w && w.id) || 'wf').replace(/[^\w-]/g, '').slice(0, 48) || 'wf';
  const now = Date.now();
  const had = stored().find((x) => x.id === `${base}_s` && !x.deleted);
  const copy = checkWorkflow({
    ...w,
    id: `${base}_s`,
    created: had ? had.created : now,
    shared: { space: String(from.space || 'a team space').slice(0, 60), by: String(from.by || '').slice(0, 40) },
  });
  delete copy.source;
  put(copy);
  if (sheet && sheet.classList.contains('open') && view.kind === 'gallery') paint();
  return copy;
}

/* ---------------- encrypted sync (askeden.com, sync.js on) ---------------- */

function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncWorkflows().catch(() => {}); }, 3000);
}

async function esync(path, body) {
  const res = await fetch(apiUrl(path), { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `askeden.com said ${res.status}`);
  return out;
}

/** Pulls the sealed gallery, merges it here, pushes the merge. Only at askeden.com with sync on. */
export async function syncWorkflows() {
  if (!state.meta || !state.meta.hosted) return false;
  const S = await import('./sync.js');
  const info = S.info();
  if (!info.on || !info.account) return false;
  const rec = await S.keyGet('sync');
  if (!rec || !rec.key) return false;
  const E = await import('./eden-crypto.js');
  const mkey = `eden:workflows:sync:${info.account}`;
  let meta;
  try { meta = JSON.parse(localStorage.getItem(mkey) || 'null') || { since: 0, rev: 0, hash: '' }; } catch { meta = { since: 0, rev: 0, hash: '' }; }
  const take = async (data) => {
    try {
      const v = await E.openItem(rec.keys || rec.key, SYNC_ITEM, data); // keys: also those before a key change (sync.js)
      if (v && Array.isArray(v.workflows)) storeAll(mergeWorkflows(stored(), v.workflows));
    } catch { /* not readable with this key: ours replaces it */ }
  };
  for (let page = 0; page < 50; page++) {
    const got = await esync('/api/web/esync/pull', { since: meta.since });
    if (got.rev < meta.since) { meta = { since: 0, rev: 0, hash: '' }; continue; }
    for (const item of got.items || []) {
      if (item.key !== SYNC_ITEM) continue;
      meta.rev = item.rev;
      if (!item.deleted && item.data) await take(item.data);
    }
    meta.since = Math.max(meta.since, got.rev);
    if (!got.more) break;
  }
  for (let tries = 0; tries < 3; tries++) {
    const value = { v: 1, workflows: stored() };
    const hash = await E.digest(JSON.stringify(value));
    if (hash === meta.hash) break;
    const { results } = await esync('/api/web/esync/push', { items: [{ key: SYNC_ITEM, data: await E.sealItem(rec.key, SYNC_ITEM, value), base_rev: meta.rev || 0 }] });
    const r = results && results[0];
    if (r && r.rev) { meta.rev = r.rev; meta.hash = hash; break; }
    if (r && r.conflict) { meta.rev = r.conflict.rev; if (r.conflict.data) await take(r.conflict.data); continue; }
    break;
  }
  try { localStorage.setItem(mkey, JSON.stringify(meta)); } catch { /* private mode */ }
  if (sheet && sheet.classList.contains('open') && view.kind === 'gallery') paint();
  return true;
}

/* ---------------- the sheet ---------------- */

function buildSheet() {
  sheet = el('div', { class: 'sheet wf-sheet', id: 'workflowsSheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wfTitle' },
    el('div', 'sheet-card glass wf-card',
      el('div', 'sheet-head', ico('spark'), el('h2', { id: 'wfTitle' }, 'Workflows'),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close workflows', onclick: closeWorkflows }, ico('x'))),
      el('div', { class: 'sheet-body wf-body', id: 'wfBody' })));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeWorkflows(); });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (view.kind !== 'gallery') { view = { kind: 'gallery' }; paint(); } else closeWorkflows();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('button:not([disabled]), input, textarea, select, summary')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  });
  document.body.append(sheet);
}

function show(next) {
  if (!sheet) buildSheet();
  if (!sheet.classList.contains('open')) {
    if (H.beforeOpen) H.beforeOpen();
    returnFocus = document.activeElement;
  }
  view = next;
  sheet.classList.add('open');
  paint();
  requestAnimationFrame(() => { const f = sheet.querySelector('.wf-focus') || sheet.querySelector('#wfBody input, #wfBody button') || sheet.querySelector('button'); if (f) f.focus(); });
}
export function openWorkflows() {
  show({ kind: 'gallery' });
  syncWorkflows().catch(() => {});
}
export function closeWorkflows() {
  if (!sheet || !sheet.classList.contains('open')) return false;
  sheet.classList.remove('open');
  const back = returnFocus;
  returnFocus = null;
  if (back && back !== document.body && document.contains(back)) back.focus();
  return true;
}
export const workflowsOpen = () => Boolean(sheet && sheet.classList.contains('open'));

function paint() {
  const body = sheet.querySelector('#wfBody');
  const head = sheet.querySelector('#wfTitle');
  head.toggleAttribute('data-no-i18n', view.kind === 'run'); // a workflow's name is the owner's
  head.textContent = view.kind === 'edit' ? (view.isNew ? 'Save as workflow' : 'Edit workflow') : view.kind === 'run' ? view.w.name : view.kind === 'schedule' ? 'Run on a schedule' : 'Workflows';
  body.replaceChildren(view.kind === 'edit' ? editor(view) : view.kind === 'run' ? runForm(view.w) : view.kind === 'schedule' ? scheduleForm(view.w) : gallery());
}

/* ---------------- the gallery ---------------- */

const modelName = (id) => {
  const m = state.meta && (state.meta.models || []).find((x) => x.id === id);
  return m ? m.name.replace(/^Claude /, '') : id;
};

function preview(template) {
  const out = el('p', { class: 'wf-tpl', 'data-no-i18n': '' });
  let at = 0;
  const t = template.length > 220 ? `${template.slice(0, 219)}…` : template;
  for (const m of t.matchAll(/\{([a-z][a-z0-9_]{0,30})\}/g)) {
    out.append(t.slice(at, m.index), el('span', 'wf-blank', m[1].replace(/_/g, ' ')));
    at = m.index + m[0].length;
  }
  out.append(t.slice(at));
  return out;
}

function gallery() {
  const list = workflows();
  if (!list.length) {
    return el('div', 'wf-empty',
      el('div', 'wf-empty-ico', ico('spark', 24)),
      el('h3', '', 'No workflows yet'),
      el('p', 'muted', 'Open a conversation you’d like to repeat, then choose “Save as workflow” in its ⋯ menu. Eden keeps the prompt with blanks for what changes, the model and level it used, and its attachments as optional slots.'),
      H.current && H.current() ? el('button', { type: 'button', class: 'btn primary wf-focus', onclick: () => saveWorkflowFrom(H.current()) }, 'Save this chat as a workflow') : null);
  }
  return el('div', 'wf-grid', ...list.map((w) => {
    const chips = [
      w.model ? el('span', 'wf-chip', ico('spark', 11), modelName(w.model)) : el('span', 'wf-chip', ico('sliders', 11), `Level ${w.level}`),
      w.mode !== 'chat' ? el('span', 'wf-chip', w.mode === 'research' ? 'Research' : 'Search') : null,
      w.blanks.length ? el('span', 'wf-chip', `${w.blanks.length} blank${w.blanks.length === 1 ? '' : 's'}`) : null,
      w.slots.length ? el('span', 'wf-chip', ico('doc', 11), `${w.slots.length} file${w.slots.length === 1 ? '' : 's'}`) : null,
      w.shared ? el('span', { class: 'wf-chip', title: `Shared in ${w.shared.space}${w.shared.by ? ` by ${w.shared.by}` : ''}` }, ico('folder', 11), el('span', { 'data-no-i18n': '' }, w.shared.space)) : null,
    ];
    const more = el('details', 'wf-more',
      el('summary', { 'aria-label': `More for ${w.name}` }, ico('more', 15)),
      el('div', 'wf-menu glass',
        el('button', { type: 'button', onclick: () => show({ kind: 'edit', w: structuredClone(w) }) }, 'Edit'),
        el('button', { type: 'button', onclick: () => copyText(recipeText(w)) }, 'Copy recipe'),
        sharer ? el('button', { type: 'button', onclick: async (e) => { e.currentTarget.closest('details').open = false; try { const said = await sharer(w); if (said) toast(said); } catch (err) { toast(`Couldn’t share it: ${err.message}`); } } }, 'Share to a space…') : null,
        el('button', { type: 'button', class: 'danger', onclick: () => { if (window.confirm(`Delete the workflow “${w.name}”?`)) { remove(w.id); paint(); toast('Workflow deleted'); } } }, 'Delete')));
    return el('article', { class: 'wf-item', 'aria-label': w.name },
      el('div', 'wf-item-h', el('h3', { 'data-no-i18n': '' }, w.name), more),
      preview(w.template),
      el('div', 'wf-chips', ...chips),
      el('div', 'wf-acts',
        el('button', { type: 'button', class: 'btn primary', onclick: () => (w.blanks.length || w.slots.length ? show({ kind: 'run', w }) : runWorkflow(w, {}, [])) }, ico('send', 13), 'Run'),
        // Scheduled runs are background tasks, this person's own (acting for someone, they'd be refused: acting.js).
        acting() ? null : el('button', { type: 'button', class: 'btn', onclick: () => show({ kind: 'schedule', w }) }, ico('clock', 13), 'Run on a schedule')));
  }));
}

function recipeText(w) {
  const lines = [`Eden workflow: ${w.name}`, '', w.template, ''];
  if (w.blanks.length) lines.push(`Blanks: ${w.blanks.map((b) => `{${b.key}}${b.sample ? ` (e.g. ${b.sample})` : ''}`).join(', ')}`);
  lines.push(w.model ? `Model: ${modelName(w.model)}${w.effort ? `, ${w.effort} effort` : ''}` : `Router level: ${w.level} (${LEVELS[w.level]})`);
  if (w.slots.length) lines.push(`Optional attachments: ${w.slots.map((s) => s.name).join(', ')}`);
  return lines.join('\n');
}

/* ---------------- save / edit ---------------- */

/** "Save as workflow" on a conversation (app.js's ⋯ menu). `conv`: the page's conversation. */
export function saveWorkflowFrom(conv) {
  const msgs = H.messagesOf ? H.messagesOf(conv) : [];
  const route = conv && conv.lastRoute ? { model: conv.lastRoute.model, effort: conv.lastRoute.effort } : null;
  const w = extractWorkflow({ title: conv && conv.title !== 'New chat' ? conv.title : '', messages: msgs, route, level: state.settings.level, mode: conv && conv.mode });
  if (!w) { toast('Send a message first: a workflow starts from what you asked.'); return; }
  show({ kind: 'edit', w, isNew: true });
}

const field = (label, input, note) => el('label', 'field wf-field', el('span', '', label), input, note ? el('span', 'wf-hint', note) : null);

function editor(v) {
  const w = v.w;
  const name = el('input', { type: 'text', maxlength: '80', value: w.name, class: 'wf-focus', 'aria-label': 'Workflow name' });
  const tpl = el('textarea', { rows: '6', maxlength: '8000', 'aria-label': t('Prompt with {blanks}') });
  tpl.value = w.template;
  const blanksBox = el('div', 'wf-blanks');
  const drawBlanks = () => {
    const keys = blanksIn(tpl.value);
    const known = new Map(w.blanks.map((b) => [b.key, b]));
    w.blanks = keys.map((key) => known.get(key) || { key, label: key.replace(/_/g, ' '), sample: '', required: true });
    blanksBox.replaceChildren(...(w.blanks.length ? w.blanks.map((b) => {
      const label = el('input', { type: 'text', maxlength: '60', value: b.label, 'aria-label': `Label for {${b.key}}` });
      const sample = el('input', { type: 'text', maxlength: '400', value: b.sample, placeholder: 'Example', 'aria-label': `Example for {${b.key}}` });
      const req = el('input', { type: 'checkbox', 'aria-label': `{${b.key}} is required` });
      req.checked = b.required !== false;
      label.addEventListener('input', () => { b.label = label.value; });
      sample.addEventListener('input', () => { b.sample = sample.value; });
      req.addEventListener('change', () => { b.required = req.checked; });
      return el('div', 'wf-blank-row', el('code', '', `{${b.key}}`), label, sample, el('label', 'wf-req', req, el('span', '', 'Required')));
    }) : [el('p', 'muted', 'No blanks: the prompt runs as it is. Select a word above and press “Make a blank”.')]));
  };
  tpl.addEventListener('input', drawBlanks);
  const makeBlank = el('button', { type: 'button', class: 'cap' }, 'Make a blank of the selection');
  makeBlank.addEventListener('click', () => {
    const [a, b] = [tpl.selectionStart, tpl.selectionEnd];
    const picked = tpl.value.slice(a, b).trim();
    if (!picked) { toast('Select the words that change from one run to the next'); tpl.focus(); return; }
    const label = window.prompt('Name this blank', 'topic');
    if (!label) return;
    let key = blankKey(label);
    while (blanksIn(tpl.value).includes(key)) key = `${key}_2`;
    w.blanks.push({ key, label: label.slice(0, 60), sample: picked.slice(0, 400), required: true });
    tpl.setRangeText(`{${key}}`, a, b, 'end');
    drawBlanks();
    tpl.focus();
  });
  const suggest = el('button', { type: 'button', class: 'cap' }, 'Find blanks again');
  suggest.addEventListener('click', () => {
    const plain = tpl.value.replace(/\{([a-z][a-z0-9_]{0,30})\}/g, (m, k) => (w.blanks.find((b) => b.key === k) || {}).sample || m);
    const out = templateFrom(plain, findBlanks(plain));
    tpl.value = out.template;
    w.blanks = out.blanks;
    drawBlanks();
  });
  const models = (state.meta && state.meta.models) || [];
  const model = el('select', { 'aria-label': 'Model' }, el('option', { value: '' }, 'The router picks (by level)'), ...models.map((m) => {
    const o = el('option', { value: m.id }, m.name);
    if (m.id === w.model) o.selected = true;
    return o;
  }));
  if (w.model && !models.some((m) => m.id === w.model)) model.append(Object.assign(el('option', { value: w.model }, `${w.model} (not here)`), { selected: true }));
  const level = el('select', { 'aria-label': 'Router level' }, ...[1, 2, 3, 4, 5].map((n) => {
    const o = el('option', { value: String(n) }, `${n} · ${LEVELS[n]}`);
    if (n === w.level) o.selected = true;
    return o;
  }));
  const mode = el('select', { 'aria-label': 'Mode' }, ...MODES.map(([k, label]) => { const o = el('option', { value: k }, label); if (k === w.mode) o.selected = true; return o; }));
  const slotsBox = el('div', 'wf-slots');
  const drawSlots = () => slotsBox.replaceChildren(...[
    ...w.slots.map((s, i) => el('div', 'wf-slot', ico(s.kind === 'image' ? 'art' : 'doc', 13), el('span', 'grow', `${s.name} (optional)`),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Remove the slot ${s.name}`, onclick: () => { w.slots.splice(i, 1); drawSlots(); } }, ico('x', 13)))),
    w.slots.length < 6 ? el('div', 'wf-slot-add',
      el('button', { type: 'button', class: 'cap', onclick: () => { w.slots.push({ name: 'A file', kind: 'text', optional: true }); drawSlots(); } }, '+ File slot'),
      el('button', { type: 'button', class: 'cap', onclick: () => { w.slots.push({ name: 'A picture', kind: 'image', optional: true }); drawSlots(); } }, '+ Picture slot')) : null,
  ].filter(Boolean));
  drawBlanks();
  drawSlots();
  const save = () => {
    try {
      const out = checkWorkflow({ ...w, name: name.value, template: tpl.value, model: model.value || null, effort: model.value && model.value === w.model ? w.effort : null, level: Number(level.value), mode: mode.value });
      put(out);
      toast(v.isNew ? 'Saved to Workflows' : 'Workflow saved');
      show({ kind: 'gallery' });
    } catch (e) { toast(e.message); }
  };
  return el('div', 'wf-edit',
    field('Name', name),
    field('Prompt', tpl, 'Words in {curly braces} are blanks you fill in each time.'),
    el('div', 'wf-tools', makeBlank, suggest),
    el('div', 'field wf-field', el('span', '', 'Blanks'), blanksBox),
    el('div', 'wf-three', field('Model', model), field('Router level', level, 'Used when the router picks.'), field('Mode', mode)),
    el('div', 'field wf-field', el('span', '', 'Attachments (optional each run)'), slotsBox),
    el('div', 'dlg-acts',
      el('button', { type: 'button', class: 'btn', onclick: () => (v.isNew ? closeWorkflows() : show({ kind: 'gallery' })) }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: save }, v.isNew ? 'Save workflow' : 'Save')));
}

/* ---------------- run ---------------- */

function blankInputs(w, values) {
  return w.blanks.map((b, i) => {
    const inp = el('input', { type: 'text', maxlength: '2000', placeholder: b.sample ? `e.g. ${b.sample}` : '', 'aria-label': b.label, class: i === 0 ? 'wf-focus' : null });
    inp.value = values[b.key] || '';
    inp.addEventListener('input', () => { values[b.key] = inp.value; });
    return field(`${b.label}${b.required === false ? ' (optional)' : ''}`, inp);
  });
}

function runForm(w) {
  const values = {};
  const files = w.slots.map((s) => {
    const inp = el('input', { type: 'file', accept: s.kind === 'image' ? 'image/*' : '.txt,.md,.csv,.json,.html,.xml,.log,.js,.ts,.py,.yaml,.yml,text/*', 'aria-label': s.name });
    return { slot: s, inp };
  });
  const go = el('button', { type: 'button', class: 'btn primary' }, ico('send', 13), 'Run');
  go.addEventListener('click', async () => {
    const { text, missing } = fillTemplate(w, values);
    if (missing.length) { toast(`Fill in: ${missing.join(', ')}`); return; }
    go.disabled = true;
    try {
      const atts = [];
      for (const { inp } of files) for (const f of inp.files || []) { const a = await readAttachment(f); if (a) atts.push(a); }
      if (runWorkflow(w, values, atts, text)) closeWorkflows();
    } finally { go.disabled = false; }
  });
  return el('div', 'wf-run',
    preview(w.template),
    ...blankInputs(w, values),
    ...files.map(({ slot, inp }) => field(`${slot.name} (optional)`, inp)),
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: () => show({ kind: 'gallery' }) }, 'Back'), go));
}

/** A file for a slot as the composer would attach it (pictures redrawn: no EXIF/GPS goes along). */
async function readAttachment(file) {
  if (file.type.startsWith('image/')) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * scale));
      cv.height = Math.max(1, Math.round(bmp.height * scale));
      const g = cv.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(bmp, 0, 0, cv.width, cv.height);
      bmp.close();
      const url = cv.toDataURL('image/jpeg', 0.88);
      return { kind: 'image', mime: 'image/jpeg', data: url.split(',', 2)[1], url, name: file.name.replace(/\.[^.]*$/, '.jpg'), size: Math.round((url.length * 3) / 4) };
    } catch { toast(`${file.name} couldn’t be read.`); return null; }
  }
  if (file.size > 400 * 1024) { toast(`${file.name} is over 400 KB.`); return null; }
  const text = await file.text();
  if (text.includes('\u0000')) { toast(`${file.name} isn’t a text file.`); return null; }
  return { kind: 'text', mime: file.type || 'text/plain', text, name: file.name, size: file.size };
}

/**
 * One run in a new chat: the filled prompt, the workflow's model for this message only (or its
 * router level for this message only), its mode. Your own settings stay as they were.
 */
export function runWorkflow(w, values = {}, attachments = [], filled = null) {
  const { text, missing } = filled ? { text: filled, missing: [] } : fillTemplate(w, values);
  if (missing.length) { toast(`Fill in: ${missing.join(', ')}`); return false; }
  const s = state.settings;
  const saved = { level: s.level, efficiency: s.efficiency, performance: s.performance };
  const lvl = state.meta && (state.meta.levels || []).find((x) => x.level === w.level);
  const usable = w.model && state.meta && (state.meta.models || []).some((m) => m.id === w.model && m.available !== false);
  if (w.model && !usable) toast(`${modelName(w.model)} isn’t available here: the router picks.`);
  let ok = false;
  try {
    if (usable) state.turnOverride = { model: w.model, ...(w.effort ? { effort: w.effort } : {}) };
    else if (lvl) Object.assign(s, { level: lvl.level, efficiency: lvl.efficiency, performance: lvl.performance });
    ok = H.run ? H.run(text, attachments, { mode: w.mode, title: w.name }) !== false : false;
  } finally {
    Object.assign(s, saved); // the request was built synchronously: the owner's level is back at once
    if (!ok && usable) state.turnOverride = null;
  }
  if (ok) {
    put({ ...w, used: (w.used || 0) + 1, lastRun: Date.now() });
    toast(`Running “${w.name}”`);
  }
  return ok;
}

/* ---------------- schedule (a background task with a time trigger) ---------------- */

const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function scheduleForm(w) {
  const values = {};
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  const at = el('input', { type: 'datetime-local', value: localInput(next.getTime()), class: 'wf-focus', 'aria-label': 'First run' });
  const repeat = el('select', { 'aria-label': 'Repeat' }, ...[['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['hourly', 'Every hour'], ['none', 'Once']].map(([k, l]) => el('option', { value: k }, l)));
  const go = el('button', { type: 'button', class: 'btn primary' }, 'Next: check the task');
  go.addEventListener('click', () => {
    const { text, missing } = fillTemplate(w, values);
    if (missing.length) { toast(`Fill in: ${missing.join(', ')}`); return; }
    if (!at.value) { toast('Pick when it first runs'); return; }
    const task = {
      title: w.name,
      trigger: { kind: 'time', at: new Date(at.value).toISOString(), repeat: repeat.value },
      every_min: 15,
      plan: `Run my saved workflow “${w.name}” and send me the result (one or two sentences; the full answer goes in the summary):\n\n${text}`,
      actions: ['notify'],
      budget: { run_usd: 0.05, month_usd: 1 },
      expires: new Date(Date.now() + 30 * 86400_000).toISOString(),
      workflow: { id: w.id, name: w.name },
    };
    closeWorkflows();
    if (H.openTasks) H.openTasks({ prefill: task });
  });
  return el('div', 'wf-sched',
    el('p', 'muted', 'Eden runs it in the background as a task (Tasks panel) and tells you the result. Scheduled runs use a small model within the task’s budget.'),
    ...blankInputs(w, values),
    el('div', 'wf-two', field('First run', at), field('Repeat', repeat)),
    w.slots.length ? el('p', 'wf-hint', 'Attachments aren’t used on scheduled runs.') : null,
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn', onclick: () => show({ kind: 'gallery' }) }, 'Back'), go));
}

/* ---------------- wiring ---------------- */

/**
 * handlers: { run(text, attachments, { mode, title }) → bool (a new chat with that message),
 * messagesOf(conv) → [{ role, content, attachments }], current() → the open conversation,
 * openTasks({ prefill }), beforeOpen() }.
 */
export function initWorkflows(handlers = {}) {
  H = handlers;
  setTimeout(() => syncWorkflows().catch(() => {}), 6000); // (askeden.com with sync on only: syncWorkflows checks)
}
