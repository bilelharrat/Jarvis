// Eden Mail with several accounts (ROADMAP Y; the owner picked look A, 2026-11-07): the accounts in
// Mail's sidebar (All inboxes, then each mailbox with its colour and unread count, Add an account),
// the narrow panel's menu of them, the account mark on a row, Add an account (Gmail by Google sign-in;
// iCloud, Yahoo, AOL, Fastmail, Zoho, GMX and any IMAP server by app password: phase 2; Outlook, Hotmail
// and Microsoft 365 by Microsoft sign-in once askeden.com has its Microsoft client: phase 3) and Manage
// accounts (name, colour, remove, reconnect). The list comes from askeden.com (GET /api/chat/mail/accounts,
// only while MAIL_MULTI is on there); anywhere else it answers 404 and Mail stays one Gmail, as before.
// Nothing secret reaches the page: ids, addresses, names, colours and whether each one works. An app
// password typed here goes once to askeden.com (which checks it with the provider and seals it) and
// is cleared from the form; it is never kept in this browser.

import { MAIL_ONLY, el, ico, toast } from './util.js';
import { api } from './api.js';
import { PRIMARY, COLORS, COLOR_NAMES, boxName } from './mail-merge.js';

const st = { multi: false, max: 10, list: [], providers: [], outlook: false, loaded: 0, p: null };
const LAST = 'eden:mail:from-box';
const LS = (() => { try { return localStorage; } catch { return null; } })();
const norm = (list) => (Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string').map((a) => ({ ...a, color: COLORS.includes(a.color) ? a.color : COLORS[0] })) : []);
const take = (j) => {
  if (!j) return;
  if (Array.isArray(j.accounts)) st.list = norm(j.accounts);
  if (Array.isArray(j.providers)) st.providers = j.providers.filter((p) => p && typeof p.kind === 'string');
  if (j.max) st.max = Number(j.max) || st.max;
  if (j.outlook !== undefined) st.outlook = j.outlook === true;
  st.loaded = Date.now();
  st.p = Promise.resolve(st.list);
};

/** The mailboxes from askeden.com (kept a minute; `force` asks again). [] when several accounts are off. */
export function loadMailboxes(force = false) {
  if (!force && st.p && Date.now() - st.loaded < 60_000) return st.p;
  st.p = (async () => {
    try {
      const j = await api.mailAccounts();
      st.multi = !!(j && j.multi);
      take(j);
    } catch { st.multi = false; st.list = []; }
    st.loaded = Date.now();
    return st.list;
  })();
  return st.p;
}
export const mailboxes = () => st.list;
/** Several accounts are on and there's at least one mailbox to show. */
export const multiOn = () => st.multi && st.list.length > 0;
/** Several accounts are on at askeden.com (even with no mailbox yet: Mail then offers Add an account, no Gmail needed). */
export const multiAvailable = () => st.multi;
/** Whether one of the mailboxes is the first Gmail (scheduled send, read receipts and background drafts run there). */
export const hasFirstGmail = () => st.list.some((b) => b.primary);
export const mailboxById = (id) => st.list.find((b) => b.id === id) || null;
export const okMailboxes = () => st.list.filter((b) => b.status !== 'reconnect');
export const mailboxMax = () => st.max;
export const nameOfBox = (id) => boxName(mailboxById(id));
export const colorOfBox = (id) => (mailboxById(id) || {}).color || COLORS[0];
export function lastFrom() { try { return (LS && LS.getItem(LAST)) || ''; } catch { return ''; } }
export function setLastFrom(id) { try { if (LS && id) LS.setItem(LAST, id); } catch { /* storage blocked */ } }
/** "Gmail", "iCloud Mail", "Yahoo Mail", … or "Other mail". */
export const kindName = (kind) => (kind === 'gmail' ? 'Gmail' : kind === 'outlook' ? 'Outlook' : kind === 'imap' ? 'Other mail' : (st.providers.find((p) => p.kind === kind) || {}).name || 'Mail');
/** Where each provider makes app passwords (the sheet links there; askeden.com's help text says how). */
const APP_PASSWORD_AT = {
  icloud: 'https://account.apple.com/account/manage',
  yahoo: 'https://login.yahoo.com/account/security',
  aol: 'https://login.aol.com/account/security',
  fastmail: 'https://app.fastmail.com/settings/security/apps',
  zoho: 'https://accounts.zoho.com/home#security/app_password',
  gmx: 'https://www.gmx.com/mail/',
};
/** Mail redraws itself after an account is added, removed or changed anywhere (mail.js listens). */
const changed = (what) => { try { dispatchEvent(new CustomEvent('eden:mailboxes', { detail: { what } })); } catch { /* no window */ } };

/** A mailbox's dot (its colour), for rows, menus and the compose window. */
export const boxDot = (id) => el('span', { class: `mbx-dot mbx-${colorOfBox(id)}`, 'aria-hidden': 'true' });

/** The account mark by a row's time in All inboxes: the dot and the name (the name hides on a narrow list). */
export function rowMark(m) {
  const ids = [m.box || PRIMARY, ...(m.alsoIn || [])];
  const names = ids.map(nameOfBox);
  return el('span', { class: 'mr-acct', title: `In ${names.join(' and ')}` }, ...ids.map(boxDot), el('span', 'mr-acct-n', names[0]), ids.length > 1 ? el('span', 'mr-acct-more', `+${ids.length - 1}`) : null);
}

/** Gmail: Google's account chooser on askeden.com; Outlook: Microsoft's. Back to Eden (and to /mail) after. */
async function startSignIn(provider) {
  try {
    const r = await api.mailAccountsDo({ action: 'add', provider });
    if (r && r.url) {
      if (MAIL_ONLY) try { sessionStorage.setItem('eden:mail-only-return', '1'); } catch { /* blocked */ } // app.js sends it back to /mail
      location.href = r.url;
    }
  } catch (e) { toast(e.message || 'Couldn’t start adding an account.'); }
}
const startGoogle = () => startSignIn('gmail');
/** A tile across the sheet's two columns (set in CSSOM: the page's CSP allows no inline style attribute). */
const wide = (node) => { node.style.gridColumn = '1 / -1'; return node; };
const startMicrosoft = () => startSignIn('outlook');
/** Add an account: the provider picker. */
export const addMailbox = (anchor) => openAddAccount({ anchor: anchor instanceof Element ? anchor : null });
/** Reconnect: Google sign-in again for Gmail, the app password form for the others. */
export function reconnectMailbox(id, anchor) {
  const b = mailboxById(id);
  if (!b) return;
  if (b.provider === 'gmail') { startGoogle(); return; }
  if (b.provider === 'outlook') { startMicrosoft(); return; }
  openAddAccount({ anchor, kind: b.kind, email: b.email, reconnect: true });
}

/**
 * The sidebar's accounts (wide panel): All inboxes, each mailbox (dot, name, address, unread) and Add an account.
 * `current` is 'all' or a mailbox id; `onPick(id)` switches. Returns { node, paint(current, unread) }.
 */
export function accountsNav({ current, onPick, onManage }) {
  const node = el('div', { class: 'mx-accts', role: 'group', 'aria-label': 'Accounts' });
  const paint = (cur, unread = {}) => {
    const total = Object.values(unread).reduce((a, b) => a + b, 0);
    const item = (id, dot, label, sub, n, extra) => {
      const on = cur === id;
      const name = `${label}${n ? `, ${n} unread` : ''}`;
      return el('button', { type: 'button', class: `mx-nv mx-acct-it${on ? ' on' : ''}${extra ? ` ${extra}` : ''}`, 'data-mbox': id, title: sub ? `${label} · ${sub}` : label, 'aria-label': name, 'aria-current': on ? 'true' : null, onclick: () => onPick(id) },
        dot, el('span', 'fl', el('span', 'mx-acct-l', label), sub ? el('small', 'mx-acct-e', sub) : null), n ? el('span', 'fc unread', String(n)) : el('span', { class: 'fc', hidden: true }));
    };
    node.replaceChildren(
      el('div', 'mx-sh mx-acct-sh', el('span', '', 'Accounts'), el('button', { type: 'button', class: 'mx-acct-gear', title: 'Manage accounts', 'aria-label': 'Manage accounts', onclick: (e) => onManage(e.currentTarget) }, ico('gear', 13))),
      item('all', el('span', { class: 'mbx-all', 'aria-hidden': 'true' }, ico('inbox', 15)), 'All inboxes', '', total),
      ...st.list.map((b) => item(b.id, boxDot(b.id), boxName(b), b.status === 'reconnect' ? 'Needs signing in again' : b.label && b.email ? b.email : b.kind && b.kind !== 'gmail' ? kindName(b.kind) : '', b.status === 'reconnect' ? 0 : unread[b.id] || 0, b.status === 'reconnect' ? 'warn' : '')),
      st.list.length < st.max ? el('button', { type: 'button', class: 'mx-nv mx-acct-add', title: 'Add an account', 'aria-label': 'Add an account', onclick: (e) => addMailbox(e.currentTarget) }, ico('plus', 15), el('span', 'fl', 'Add an account')) : null,
    );
  };
  paint(current);
  return { node, paint };
}

/** The narrow panel's menu of the same (the sidebar is a bar there), with Add an account at the end. */
export function accountsSelect({ current, onPick }) {
  const sel = el('select', { class: 'mx-acct mx-boxsel', 'aria-label': 'Account' });
  let cur = current;
  const paint = (c) => {
    cur = c;
    sel.replaceChildren(el('option', { value: 'all' }, 'All inboxes'), ...st.list.map((b) => el('option', { value: b.id }, b.status === 'reconnect' ? `${boxName(b)} (sign in again)` : boxName(b))),
      st.list.length < st.max ? el('option', { value: '+add' }, 'Add an account…') : null);
    sel.value = c;
  };
  paint(current);
  sel.addEventListener('change', () => { if (sel.value === '+add') { sel.value = cur; addMailbox(sel); return; } onPick(sel.value); });
  return { node: sel, paint };
}

/** A line over the list for a mailbox that couldn't be read, with Reconnect when it needs signing in. */
export function boxProblems(problems) {
  const shown = (problems || []).filter((p) => p && mailboxById(p.box));
  if (!shown.length) return null;
  return el('div', { class: 'mx-boxwarn', role: 'status' }, ...shown.map((p) => el('div', 'mx-boxwarn-r', boxDot(p.box),
    el('span', 'grow', p.reconnect ? `${nameOfBox(p.box)} needs signing in again.` : `${nameOfBox(p.box)} couldn’t refresh: ${p.error || 'try again in a minute'}.`),
    p.reconnect ? el('button', { type: 'button', class: 'cap', onclick: (e) => reconnectMailbox(p.box, e.currentTarget) }, 'Reconnect') : null)));
}

/** A sheet anchored under `anchor` (Manage accounts, Add an account): Escape or a click outside closes it. */
function sheetAt(anchor, label, cls = '') {
  document.querySelector('.mbx-sheet')?.remove();
  const sheet = el('div', { class: `mbx-sheet glass ${cls}`.trim(), role: 'dialog', 'aria-modal': 'false', 'aria-label': label });
  const close = () => { if (watch) watch.disconnect(); sheet.remove(); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', esc, true); if (anchor && document.contains(anchor)) anchor.focus(); };
  const outside = (e) => { if (!sheet.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const place = () => {
    const r = anchor && document.contains(anchor) ? anchor.getBoundingClientRect() : { left: (window.innerWidth - sheet.offsetWidth) / 2, bottom: 60 };
    sheet.style.left = `${Math.max(8, Math.min(window.innerWidth - sheet.offsetWidth - 8, r.left))}px`;
    sheet.style.top = `${Math.max(8, Math.min(window.innerHeight - sheet.offsetHeight - 8, r.bottom + 6))}px`;
  };
  let watch = null;
  const open = () => {
    document.body.append(sheet);
    place();
    // it grows (an error, the server settings): kept on screen
    try { watch = new ResizeObserver(() => place()); watch.observe(sheet); } catch { /* old engines: placed once */ }
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', esc, true);
    requestAnimationFrame(() => { const f = sheet.querySelector('input, button:not(.mbx-x)'); if (f) f.focus(); });
  };
  const head = (title, back) => el('div', 'mbx-head', back ? el('button', { type: 'button', class: 'mx-ib mbx-back', 'aria-label': 'Back', title: 'Back', onclick: back }, ico('chevl', 14)) : null,
    el('b', '', title), el('button', { type: 'button', class: 'mx-ib mbx-x', 'aria-label': 'Close', title: 'Close', onclick: close }, ico('x', 14)));
  return { sheet, close, open, place, head };
}

/**
 * Add an account: pick the provider (Gmail signs in with Google; the others take an app password),
 * or open straight on one (`kind`, Reconnect). askeden.com checks the password with the provider before
 * anything is saved; a wrong one says what to do instead.
 */
export function openAddAccount({ anchor, kind, email = '', reconnect = false } = {}) {
  const s = sheetAt(anchor, reconnect ? 'Sign in again' : 'Add an account', 'mbx-add-sheet');
  const picker = () => {
    const tiles = [['gmail', 'Gmail', 'Sign in with Google'], ...st.providers.map((p) => [p.kind, p.name, 'App password']), ['imap', 'Other mail', 'Any IMAP and SMTP server']];
    s.sheet.replaceChildren(s.head('Add an account'),
      el('div', { class: 'mbx-provs', role: 'list' }, ...tiles.map(([k, name, sub]) => el('button', { type: 'button', role: 'listitem', class: 'mbx-prov', onclick: () => (k === 'gmail' ? startGoogle() : form(k)) }, el('b', '', name), el('small', '', sub))),
        st.outlook
          ? wide(el('button', { type: 'button', role: 'listitem', class: 'mbx-prov', onclick: startMicrosoft }, el('b', '', 'Outlook, Hotmail, Microsoft 365'), el('small', '', 'Sign in with Microsoft')))
          : el('div', { class: 'mbx-prov off', role: 'listitem', 'aria-disabled': 'true' }, el('b', '', 'Outlook, Hotmail, Microsoft 365'), el('small', '', 'Coming next (Microsoft sign-in)'))),
      el('p', 'mbx-note', 'A password is checked with your provider, then kept encrypted on askeden.com. It never stays in this browser.'));
    s.place();
  };
  const form = (k) => {
    const provider = st.providers.find((p) => p.kind === k);
    const other = k === 'imap';
    const field = (label, input, note) => el('label', 'mbx-field', el('span', 'mbx-k', label), input, note ? el('small', 'mbx-fn', note) : null);
    const emailIn = el('input', { type: 'email', class: 'mbx-in', autocomplete: 'email', spellcheck: 'false', value: email || '', placeholder: provider && provider.domains && provider.domains[0] ? `you@${provider.domains[0]}` : 'you@example.com', required: true });
    const passIn = el('input', { type: 'password', class: 'mbx-in', autocomplete: 'off', spellcheck: 'false', placeholder: other ? 'Password or app password' : 'xxxx-xxxx-xxxx-xxxx', required: true });
    const imapIn = el('input', { type: 'text', class: 'mbx-in', spellcheck: 'false', placeholder: 'imap.example.com', autocomplete: 'off' });
    const smtpIn = el('input', { type: 'text', class: 'mbx-in', spellcheck: 'false', placeholder: 'smtp.example.com', autocomplete: 'off' });
    const portIn = el('select', { class: 'mbx-in' }, el('option', { value: '465' }, '465 (TLS)'), el('option', { value: '587' }, '587 (STARTTLS)'));
    const userIn = el('input', { type: 'text', class: 'mbx-in', spellcheck: 'false', placeholder: 'Same as the email address', autocomplete: 'off' });
    const servers = el('fieldset', { class: 'mbx-servers', hidden: true }, el('legend', '', 'Server settings'),
      field('Incoming (IMAP, port 993)', imapIn), field('Outgoing (SMTP)', smtpIn), field('Outgoing port', portIn), field('Username', userIn, 'Only if it isn’t your email address'));
    const help = el('p', 'mbx-help', provider ? provider.help : 'Eden finds the servers from the address. Some providers need an app password instead of your normal one.');
    const at = APP_PASSWORD_AT[k];
    const link = at ? el('a', { class: 'mbx-link', href: at, target: '_blank', rel: 'noopener noreferrer' }, 'Make an app password', ico('ext', 11)) : null;
    const found = el('p', { class: 'mbx-found', hidden: true });
    const err = el('p', { class: 'mbx-err', role: 'alert', hidden: true });
    const go = el('button', { type: 'submit', class: 'btn primary mbx-go' }, reconnect ? 'Sign in again' : 'Add account');
    const showServers = (on) => { servers.hidden = !on; s.place(); };
    let detected = null;
    if (other) {
      emailIn.addEventListener('change', async () => {
        const v = emailIn.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return;
        found.hidden = true;
        try {
          const d = await api.mailAccountsDo({ action: 'detect', email: v });
          detected = d;
          if (d.use === 'microsoft' && st.outlook) {
            found.replaceChildren('Outlook, Hotmail and Microsoft 365 sign in with Microsoft, not a password. ', el('button', { type: 'button', class: 'mx-link', onclick: startMicrosoft }, 'Sign in with Microsoft'));
            found.hidden = false;
            return;
          }
          if (d.use) { found.textContent = d.message; found.hidden = false; return; }
          if (d.need) { found.textContent = d.message; found.hidden = false; showServers(true); return; }
          found.textContent = `${d.name}: ${d.servers.imap.host} and ${d.servers.smtp.host}.`;
          found.hidden = false;
          help.textContent = d.help || help.textContent;
          showServers(false);
        } catch { /* typed on: askeden.com says on Add */ }
      });
    }
    const box = el('form', { class: 'mbx-form', novalidate: true },
      field('Email address', emailIn), field(other ? 'Password' : 'App password', passIn), help, link, found, other ? el('button', { type: 'button', class: 'mx-link mbx-adv', onclick: () => showServers(servers.hidden) }, 'Server settings') : null, servers, err,
      el('div', 'mbx-acts', el('button', { type: 'button', class: 'btn', onclick: reconnect ? s.close : picker }, reconnect ? 'Cancel' : 'Back'), go));
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const addr = emailIn.value.trim();
      if (!addr || !passIn.value) { err.textContent = 'Enter the email address and the password.'; err.hidden = false; return; }
      if (detected && detected.use && detected.email === addr) { err.textContent = detected.message; err.hidden = false; return; }
      const body = { action: 'add', provider: 'imap', email: addr, password: passIn.value };
      if (!other) body.kind = k;
      else if (!servers.hidden && imapIn.value.trim()) {
        body.imap = { host: imapIn.value.trim(), port: 993 };
        body.smtp = { host: smtpIn.value.trim(), port: Number(portIn.value) };
        if (userIn.value.trim()) body.user = userIn.value.trim();
      }
      go.disabled = true;
      go.textContent = `Checking with ${provider ? provider.name : 'your provider'}…`;
      try {
        const j = await api.mailAccountsDo(body);
        passIn.value = '';
        take(j);
        changed('add');
        s.close();
        toast(reconnect ? `${addr} is signed in again` : `${addr} added`);
      } catch (x) {
        passIn.value = '';
        // the provider's how-to is already on the form: the error says only what went wrong
        err.textContent = String(x.message || 'That didn’t work. Try again.').replace(help.textContent, '').replace(/\s+/g, ' ').trim();
        err.hidden = false;
        if (x.code === 'need_servers') showServers(true);
        go.disabled = false;
        go.textContent = reconnect ? 'Sign in again' : 'Add account';
        passIn.focus();
      }
    });
    s.sheet.replaceChildren(s.head(reconnect ? `Sign in to ${kindName(k)} again` : `Add ${provider ? provider.name : 'other mail'}`, reconnect ? null : picker), box);
    s.place();
    requestAnimationFrame(() => (email ? passIn : emailIn).focus());
  };
  if (kind) form(kind); else picker();
  s.open();
}

/**
 * Manage accounts: each mailbox's name and colour, Remove (and where to finish at the provider), Reconnect,
 * Add an account. `onChange(what)` redraws Mail after a change.
 */
export function manageMailboxes(anchor, { onChange } = {}) {
  const s = sheetAt(anchor, 'Mail accounts');
  const save = async (body, done) => {
    try {
      take(await api.mailAccountsDo(body));
      if (done) done();
      draw();
      if (onChange) onChange(body.action);
    } catch (e) { toast(e.message || 'Couldn’t save that.'); }
  };
  const row = (b) => {
    const name = el('input', { type: 'text', class: 'mbx-name', maxlength: '40', value: b.label || '', placeholder: b.email || 'Name', 'aria-label': `Name for ${b.email || 'this account'}` });
    name.addEventListener('change', () => save({ action: 'edit', id: b.id, label: name.value }));
    const swatches = el('div', { class: 'mbx-sw', role: 'radiogroup', 'aria-label': `Colour for ${boxName(b)}` }, ...COLORS.map((c) => el('button', {
      type: 'button', role: 'radio', class: `mbx-swatch mbx-${c}${b.color === c ? ' on' : ''}`, 'aria-checked': String(b.color === c), 'aria-label': COLOR_NAMES[c], title: COLOR_NAMES[c],
      onclick: () => { if (b.color !== c) save({ action: 'edit', id: b.id, color: c }); },
    })));
    const gmail = b.provider === 'gmail';
    const outlook = b.provider === 'outlook';
    const where = !gmail && APP_PASSWORD_AT[b.kind] ? ` To cancel the app password too, delete it in your ${kindName(b.kind)} account.` : !gmail ? ' To cancel the password too, change it with your provider.' : '';
    const confirmRemove = el('div', { class: 'mbx-confirm', hidden: true },
      el('p', '', gmail ? `Remove ${b.email || boxName(b)} from Eden Mail? Eden stops reading it and Google cancels Eden’s access. Your mail stays in Gmail.`
        : outlook ? `Remove ${b.email || boxName(b)} from Eden Mail? Eden stops reading it and forgets its sign-in. Your mail stays in Outlook. To end Eden’s access at Microsoft too, remove Eden under your Microsoft account’s apps (account.microsoft.com, or myapps.microsoft.com for work).`
          : `Remove ${b.email || boxName(b)} from Eden Mail? Eden stops reading it and forgets its password. Your mail stays with ${kindName(b.kind)}.${where}`),
      el('div', 'mbx-acts', el('button', { type: 'button', class: 'btn', onclick: () => { confirmRemove.hidden = true; } }, 'Keep'),
        el('button', { type: 'button', class: 'btn danger', onclick: () => save({ action: 'remove', id: b.id }, () => toast(`${b.email || 'The account'} was removed`)) }, 'Remove')));
    return el('div', 'mbx-row',
      el('div', 'mbx-top', boxDot(b.id), el('div', 'mbx-who', name, el('small', '', `${b.primary ? 'First Gmail' : kindName(b.kind || b.provider)} · ${b.email || ''}`)),
        b.status === 'reconnect' ? el('button', { type: 'button', class: 'cap', onclick: (e) => reconnectMailbox(b.id, e.currentTarget) }, 'Reconnect') : null,
        b.primary ? null : el('button', { type: 'button', class: 'mx-ib', title: 'Remove this account', 'aria-label': `Remove ${b.email || boxName(b)}`, onclick: () => { confirmRemove.hidden = false; } }, ico('trash', 14))),
      swatches,
      b.primary ? el('p', 'mbx-note', 'Your first Gmail also holds your calendar: disconnect it in Settings › Accounts.') : null,
      confirmRemove);
  };
  const draw = () => s.sheet.replaceChildren(
    s.head('Mail accounts'),
    el('div', 'mbx-list', ...st.list.map(row)),
    st.list.length < st.max ? el('button', { type: 'button', class: 'btn primary mbx-add', onclick: () => openAddAccount({ anchor }) }, ico('plus', 14), el('span', '', 'Add an account')) : el('p', 'mbx-note', `Mail holds ${st.max} accounts at most.`),
    el('p', 'mbx-note', `${st.outlook ? '' : 'Outlook and Microsoft 365 come next. '}Scheduled send, read receipts and drafts written while Mail is closed ${hasFirstGmail() ? 'work from your first Gmail' : 'need a Gmail account (add one any time)'} for now.`));
  draw();
  s.open();
}
