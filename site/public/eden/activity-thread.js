// One web-only progress surface for regular chat and EVES. Callers supply recorded activity;
// this component owns stable DOM, disclosure state and focus through streaming redraws.
import { el } from './util.js';
import { t } from './i18n.js';

const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const symbols = { done: '✓', active: '●', pending: '○', stopped: '!', skipped: '–' };

export function createActivityThread({ id, onStop }) {
  const title = el('span', 'activity-title');
  const elapsed = el('span', { class: 'activity-time', 'data-no-i18n': '' });
  const list = el('ol', { class: 'activity-list', id: `activity-${id}`, 'aria-label': t('Activity thread') });
  const head = el('button', { type: 'button', class: 'activity-head', 'data-act': 'activity-toggle', 'aria-expanded': 'true', 'aria-controls': list.id },
    el('span', { class: 'activity-mark', 'aria-hidden': 'true' }), title, elapsed,
    el('span', { class: 'activity-chevron', 'aria-hidden': 'true' }, '›'));
  const body = el('div', 'activity-body');
  const warning = el('p', { class: 'activity-warning', hidden: true });
  const meta = el('span', 'activity-meta');
  const stop = el('button', { type: 'button', class: 'activity-stop', 'data-act': 'activity-stop' }, t('Stop'));
  const footer = el('div', 'activity-footer', meta, stop);
  const root = el('section', { class: 'activity-thread', 'aria-label': t('Turn progress') },
    el('div', 'activity-glass', head, list), warning, footer);
  const view = { root, head, title, elapsed, list, body, warning, meta, stop, footer, rows: new Map(), phase: null, open: true };
  head.addEventListener('click', (event) => {
    event.stopPropagation();
    view.open = !view.open;
    head.setAttribute('aria-expanded', String(view.open));
    list.hidden = !view.open;
  });
  stop.addEventListener('click', (event) => { event.stopPropagation(); onStop?.(); });
  return view;
}

export function updateActivityThread(v, data) {
  // Automatic tucking happens only at a lifecycle boundary, not at each stream update.
  // Explicit choices persist within a phase; the person can reopen a completed run.
  if (v.phase !== data.phase) {
    v.phase = data.phase;
    v.open = data.phase === 'work';
  }
  v.head.setAttribute('aria-expanded', String(v.open));
  v.list.hidden = !v.open;
  v.root.dataset.phase = data.phase;
  setText(v.title, t(data.title));
  setText(v.elapsed, data.elapsed || '');
  setText(v.meta, t(data.meta || ''));
  setText(v.warning, t(data.warning || ''));
  v.warning.hidden = !data.warning;
  v.stop.hidden = !data.canStop;
  v.footer.hidden = !data.meta && !data.canStop;

  const keep = new Set(data.rows.map((row) => row.id));
  for (const [id, row] of v.rows) {
    if (!keep.has(id)) { row.li.remove(); v.rows.delete(id); }
  }
  data.rows.forEach((row, index) => {
    let item = v.rows.get(row.id);
    if (!item) {
      const symbol = el('span', { class: 'activity-dot', 'aria-hidden': 'true' });
      const text = el('span', 'activity-label');
      const status = el('span', 'sr-only');
      const li = el('li', { class: 'activity-step', 'data-step': row.id }, symbol, text, status);
      item = { li, symbol, text, status };
      v.rows.set(row.id, item);
    }
    item.li.dataset.status = row.status;
    if (row.status === 'active') item.li.setAttribute('aria-current', 'step');
    else item.li.removeAttribute('aria-current');
    setText(item.symbol, symbols[row.status] || '○');
    setText(item.text, t(row.text));
    setText(item.status, ` (${t({ done: 'Done', active: 'In progress', pending: 'Pending', stopped: 'Stopped', skipped: 'Not needed' }[row.status] || 'Pending')})`);
    // Do not detach/reinsert existing controls on a no-op redraw.
    if (v.list.children[index] !== item.li) v.list.insertBefore(item.li, v.list.children[index] || null);
  });
  const current = data.rows.find((row) => row.status === 'active')
    || [...data.rows].reverse().find((row) => row.status !== 'pending');
  const target = current && v.rows.get(current.id)?.li;
  if (target && v.body.parentElement !== target) target.append(v.body);
  if (!target) v.body.remove();
}
