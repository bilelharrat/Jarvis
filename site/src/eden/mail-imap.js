// Eden Mail's IMAP mailboxes: iCloud, Yahoo, AOL, Fastmail, Zoho, GMX and any other IMAP + SMTP server,
// signed in with an app password (askeden ROADMAP Y2; plan: askeden/docs/mail-multi-account/plan.html).
//
// The trick: a mailbox here answers *Gmail's REST API* (the requests Eden's Gmail core makes:
// messages.list/get, attachments, batchModify, threads, drafts, send, sendAs, profile, history, the
// resumable upload), served over IMAP and SMTP. So createGmailApi + runGmailAction (vendor/google.js)
// run unchanged on top: the same reading, HTML cleaning, attachments, uploads, validation and results
// as Gmail, and Eden Mail on the page needs nothing new beyond the mailbox id.
//
//   ids        <folder code><UIDVALIDITY base36>-<UID base36>[-<hash of Message-ID>] (Gmail's id characters),
//              folder codes i inbox, s sent, d drafts, a archive, t trash, j junk
//   threads    't' + base64url(the thread's first Message-ID); found again with SEARCH HEADER
//   labels     INBOX/SENT/DRAFT by folder, UNREAD = no \Seen, STARRED = \Flagged
//   Done       moves to the Archive folder (made the first time if the account has none); undo moves back
//   send       SMTP (Bcc out of what's sent), then a copy APPENDed to Sent (\Seen)
//   drafts     APPENDed to Drafts (\Draft \Seen); an update replaces the message (new id, mapped within a request)
//   history    a number from the inbox/sent/drafts STATUS (changes when anything there does)
// One IMAP connection per Worker request, signed in once, logged out at the end (close()).

import { openImap, ImapError, imapQuote } from './imap.js';
import { sendSmtp, SmtpError } from './smtp.js';
import { attachmentIdOf, mimeB64url, mimeBinary, mimeBytesOf, decodeWords, fromBase64, gmailHeaders, gmailPayload, headerOf, parseHeaders, parseMessage, partAt, pathOfAttachmentId, snippetOf } from './mime.js';
import { GoogleError } from './vendor/google.js';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_UPLOAD_BASE = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const MAX_READ_BYTES = 30 * 1024 * 1024;
const SNIPPET_BYTES = 2500;

// ── providers ──

/** Known providers: their servers and how to make an app password. `users`: which login names to try (local part, full address). */
export const IMAP_PRESETS = {
  icloud: { name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'], imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }, users: ['local', 'email'],
    help: 'Make an app-specific password at account.apple.com › Sign-In and Security › App-Specific Passwords (it needs two-factor authentication). Your Apple Account password won’t work here.' },
  yahoo: { name: 'Yahoo Mail', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.ca', 'yahoo.com.au', 'yahoo.co.in', 'yahoo.co.jp', 'yahoo.com.br', 'yahoo.com.mx'], imap: { host: 'imap.mail.yahoo.com', port: 993 }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' }, users: ['email'],
    help: 'Make an app password in your Yahoo account: Account security › Generate app password. Your Yahoo password won’t work here.' },
  aol: { name: 'AOL Mail', domains: ['aol.com', 'aim.com', 'love.com', 'ygm.com', 'games.com', 'wow.com'], imap: { host: 'imap.aol.com', port: 993 }, smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' }, users: ['email'],
    help: 'Make an app password in your AOL account: Account security › Generate app password. Your AOL password won’t work here.' },
  fastmail: { name: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'], imap: { host: 'imap.fastmail.com', port: 993 }, smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' }, users: ['email'],
    help: 'Make an app password in Fastmail: Settings › Privacy & Security › App passwords, with access to IMAP and SMTP.' },
  zoho: { name: 'Zoho Mail', domains: ['zoho.com', 'zohomail.com'], imap: { host: 'imap.zoho.com', port: 993 }, smtp: { host: 'smtp.zoho.com', port: 465, security: 'tls' }, users: ['email'],
    help: 'Turn on IMAP in Zoho Mail’s settings, then make an app-specific password in your Zoho account’s security settings. Zoho accounts in Europe use “Other” with imap.zoho.eu.' },
  gmx: { name: 'GMX', domains: ['gmx.com'], imap: { host: 'imap.gmx.com', port: 993 }, smtp: { host: 'mail.gmx.com', port: 587, security: 'starttls' }, users: ['email'],
    help: 'Turn on IMAP in GMX’s settings (E-mail › POP3 & IMAP), then use your GMX password or an app password.' },
};
export const IMAP_KINDS = [...Object.keys(IMAP_PRESETS), 'imap'];
const GOOGLE_DOMAINS = /^(gmail|googlemail)\.com$/;
const MICROSOFT_DOMAINS = /^(outlook|hotmail|live|msn|passport|windowslive)\.[a-z.]{2,12}$/;

const imapBad = (message, code = 'bad_request', status = 400) => new GoogleError(message, code, status);

/** A mail server's host name: a public DNS name (no IPs, no local or internal names). */
export function checkHost(h) {
  const host = String(h || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host) || /\.(local|localhost|internal|lan|home|corp|intranet|test|invalid|example|arpa)$/.test(host)) {
    throw imapBad('The server must be a public name like imap.example.com.');
  }
  return host;
}
/** Only encrypted ports: IMAP 993; SMTP 465 (TLS) or 587 (STARTTLS). */
export function checkServers(imap, smtp) {
  const ih = checkHost(imap && imap.host);
  const sh = checkHost(smtp && smtp.host);
  const ip = Number((imap && imap.port) || 993);
  const sp = Number((smtp && smtp.port) || 465);
  if (ip !== 993) throw imapBad('Eden reads mail over IMAP with encryption from the start (port 993).');
  if (sp !== 465 && sp !== 587) throw imapBad('Eden sends through SMTP on port 465 (encrypted) or 587 (STARTTLS).');
  return { imap: { host: ih, port: 993 }, smtp: { host: sh, port: sp, security: sp === 465 ? 'tls' : 'starttls' } };
}
export function checkEmail(e) {
  const email = String(e || '').trim();
  if (email.length > 254 || !/^[^\s@<>"(),;:\\]{1,64}@[^\s@<>"(),;:\\]{1,253}$/.test(email)) throw imapBad('That isn’t an email address.');
  return email;
}
export function checkPassword(p) {
  if (typeof p !== 'string' || !p || p.length > 256 || /[\r\n\0]/.test(p)) throw imapBad('Enter the app password (one line).');
  return p;
}

/** The provider for an address's domain: { kind, ...preset } or null. Gmail and Microsoft get a pointer elsewhere. */
export function presetForEmail(email) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  if (GOOGLE_DOMAINS.test(domain)) throw imapBad('Add Gmail with “Gmail” (Google sign-in): it doesn’t need a password.', 'use_google');
  if (MICROSOFT_DOMAINS.test(domain)) throw imapBad('Outlook, Hotmail and Microsoft 365 need Microsoft sign-in, which comes next. They can’t be added with a password.', 'use_microsoft');
  for (const [kind, p] of Object.entries(IMAP_PRESETS)) if (p.domains.includes(domain)) return { kind, ...p };
  return null;
}

const timeout = () => ({ signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined });

/** An autoconfig XML document's text, or '' (any failure). */
async function fetchConfig(url, f) {
  try {
    const res = await f(url, timeout());
    return res.ok ? (await res.text()).slice(0, 65536) : '';
  } catch { return ''; }
}

/** The domain's mail host (its lowest-priority MX) via DNS over HTTPS, or ''. */
async function mxHost(domain, f) {
  try {
    const res = await f(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { ...timeout(), headers: { accept: 'application/dns-json' } });
    if (!res.ok) return '';
    const answers = ((await res.json()).Answer || []).filter((a) => a.type === 15).map((a) => String(a.data).trim().split(/\s+/)).filter((p) => p.length === 2);
    answers.sort((a, b) => Number(a[0]) - Number(b[0]));
    return answers.length ? answers[0][1].toLowerCase().replace(/\.$/, '') : '';
  } catch { return ''; }
}

/**
 * The servers for an address: a known provider, else Thunderbird's public list for the domain, else the
 * domain's own autoconfig, else the same two lookups for the provider its MX points at (so a custom domain
 * hosted at, say, Purelymail is found). Only domain names are sent. Else null (the page then asks).
 * Returns { kind, name, imap, smtp, users, help }.
 */
export async function detectServers(email, f = (u, i) => fetch(u, i)) {
  const preset = presetForEmail(email);
  if (preset) return preset;
  const domain = email.split('@')[1].toLowerCase();
  const lookups = async (d) => {
    let own = null;
    try { own = `https://${checkHost(`autoconfig.${d}`)}/mail/config-v1.1.xml`; } catch { /* not a public name: skip it */ }
    for (const url of [`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(d)}`, own].filter(Boolean)) {
      const found = parseConfig(await fetchConfig(url, f), d);
      if (found) return found;
    }
    return null;
  };
  const direct = await lookups(domain);
  if (direct) return direct;
  const mx = await mxHost(domain, f);
  const base = mx.split('.').slice(-2).join('.');
  // Google Workspace and Microsoft 365 mail needs their sign-ins, not a password: leave those to the page
  if (!base || base === domain || !/^[a-z0-9-]+\.[a-z]{2,}$/.test(base) || /^(google|googlemail|outlook)\.com$/.test(base)) return null;
  for (const [kind, p] of Object.entries(IMAP_PRESETS)) if (p.domains.includes(base)) return { kind, ...p };
  return lookups(base);
}

/** An autoconfig document → { kind: 'imap', name, imap, smtp, users, help }, or null. */
function parseConfig(xml, domain) {
  if (!xml) return null;
  const tag = (block, name) => (new RegExp(`<${name}>([^<]*)</${name}>`).exec(block) || [])[1]?.trim() || '';
  const servers = (type) => [...xml.matchAll(new RegExp(`<(?:incoming|outgoing)Server type="${type}">([\\s\\S]*?)</(?:incoming|outgoing)Server>`, 'g'))].map((m) => ({ host: tag(m[1], 'hostname'), port: Number(tag(m[1], 'port')), socket: tag(m[1], 'socketType').toUpperCase(), user: tag(m[1], 'username') }));
  const imap = servers('imap').find((s) => s.port === 993 && s.socket === 'SSL');
  const smtp = servers('smtp').find((s) => (s.port === 465 && s.socket === 'SSL') || (s.port === 587 && s.socket === 'STARTTLS'));
  if (!imap || !smtp) return null;
  try {
    const checked = checkServers(imap, smtp);
    const users = [imap.user === '%EMAILLOCALPART%' ? 'local' : 'email'];
    const name = tag(xml, 'displayName') || domain;
    return { kind: 'imap', name, ...checked, users, help: `Use your ${name} password, or an app password if your provider has them.` };
  } catch { return null; }
}

// ── folders ──

/** IMAP's modified UTF-7 folder names ("Entw&APw-rfe") → text, for matching by name. */
export function decodeMutf7(name) {
  return String(name).replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return '&';
    const bytes = fromBase64(b.replace(/,/g, '/'));
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  });
}
const IMAP_FOLDER_NAMES = {
  sent: ['sent messages', 'sent', 'sent items', 'sent mail', 'gesendet', 'gesendete elemente', 'envoyés', 'éléments envoyés', 'enviados', 'inviata'],
  drafts: ['drafts', 'draft', 'entwürfe', 'brouillons', 'borradores', 'bozze'],
  archive: ['archive', 'archives', 'archiv', 'archivo'],
  trash: ['deleted messages', 'trash', 'deleted items', 'deleted', 'bin', 'papierkorb', 'corbeille', 'papelera'],
  junk: ['junk', 'spam', 'bulk mail', 'junk e-mail', 'junk email', 'courrier indésirable'],
};
/** LIST results → { inbox, sent, drafts, archive, trash, junk } (special-use flags first, then the usual names; null when imapMissing). */
export function pickFolders(list) {
  const out = { inbox: 'INBOX', sent: null, drafts: null, archive: null, trash: null, junk: null };
  const usable = list.filter((f) => !f.flags.includes('\\noselect') && !f.flags.includes('\\nonexistent'));
  for (const role of Object.keys(IMAP_FOLDER_NAMES)) {
    const byFlag = usable.find((f) => f.flags.includes(`\\${role}`));
    if (byFlag) { out[role] = byFlag.name; continue; }
    const base = (f) => { const n = decodeMutf7(f.name).toLowerCase(); const d = f.delim && n.startsWith(`inbox${f.delim.toLowerCase()}`) ? n.slice(6) : n; return d; };
    for (const want of IMAP_FOLDER_NAMES[role]) {
      const hit = usable.find((f) => base(f) === want);
      if (hit) { out[role] = hit.name; break; }
    }
  }
  return out;
}

// ── Gmail's search words → IMAP SEARCH ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/**
 * A Gmail search (what Eden's Mail and its Ask your inbox write) as IMAP SEARCH: { criteria (literals as
 * \0n\0 marks), literals, folder ('inbox' | 'sent' | 'drafts' | 'archive' | 'any' | null) }. Unknown
 * operators (category:, label:, in:chats…) are left out rather than guessed.
 */
export function toImapSearch(q, now = Date.now()) {
  const literals = [];
  let folder = null;
  const str = (v) => (/[^\x20-\x7e]/.test(v) ? (literals.push(v), `\u0000${literals.length - 1}\u0000`) : imapQuote(v));
  const terms = [];
  const re = /(-?)(?:([a-z_]+):)?("(?:[^"\\]|\\.)*"|[^\s"(){}]+)|\b(OR)\b/g;
  const text = String(q || '').replace(/[(){}]/g, ' ');
  let m;
  while ((m = re.exec(text))) {
    if (m[4]) { terms.push('OR'); continue; }
    const neg = m[1] === '-';
    const key = (m[2] || '').toLowerCase();
    let val = m[3] || '';
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!val) continue;
    if (val === 'OR' && !key) { terms.push('OR'); continue; }
    let k = null;
    const v = val.toLowerCase();
    const ago = (n, unit) => new Date(now - n * (unit === 'y' ? 365 : unit === 'm' ? 30 : 1) * 86_400_000);
    const day = (s) => { const d = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s); return d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])) : null; };
    switch (key) {
      case 'from': k = `FROM ${str(val)}`; break;
      case 'to': k = `TO ${str(val)}`; break;
      case 'cc': k = `CC ${str(val)}`; break;
      case 'bcc': k = `BCC ${str(val)}`; break;
      case 'subject': k = `SUBJECT ${str(val)}`; break;
      case 'is': k = v === 'unread' ? 'UNSEEN' : v === 'read' ? 'SEEN' : v === 'starred' ? 'FLAGGED' : null; break;
      case 'has': k = v === 'attachment' ? 'HEADER Content-Type "multipart/mixed"' : null; break;
      case 'newer_than': case 'older_than': {
        const d = /^(\d{1,4})([dmy])$/.exec(v);
        if (d) k = `${key === 'newer_than' ? 'SINCE' : 'BEFORE'} ${imapDate(ago(Number(d[1]), d[2]))}`;
        break;
      }
      case 'after': case 'since': case 'before': { const d = day(v); if (d) k = `${key === 'before' ? 'BEFORE' : 'SINCE'} ${imapDate(d)}`; break; }
      case 'in':
        if (!neg && ['inbox', 'sent', 'drafts', 'archive', 'anywhere', 'all'].includes(v)) folder = v === 'anywhere' || v === 'all' ? 'any' : v;
        break;
      case '': k = `TEXT ${str(val)}`; break;
      default: k = null; // category:, label:, filename:, … left out
    }
    if (k) terms.push(neg ? `NOT ${k}` : k);
  }
  // "a OR b" → OR a b (a dangling OR is dropped)
  const out = [];
  for (let i = 0; i < terms.length; i++) {
    if (terms[i] === 'OR') continue;
    if (terms[i + 1] === 'OR' && terms[i + 2] && terms[i + 2] !== 'OR') { out.push(`OR (${terms[i]}) (${terms[i + 2]})`); i += 2; continue; }
    out.push(terms[i]);
  }
  return { criteria: out.join(' ') || 'ALL', literals, folder };
}

// ── addresses and outgoing messages ──

/** "Ana <a@x.com>, \"Lee, Sam\" <s@y.com>, b@z.com" → ['a@x.com', 's@y.com', 'b@z.com']. */
export function addressesIn(value) {
  const out = [];
  let cur = '', q = false, angle = false;
  const take = () => { const t = cur.trim(); cur = ''; if (!t) return; const m = /<([^<>]+)>\s*$/.exec(t); const a = (m ? m[1] : t).trim(); if (/^[^\s@<>]+@[^\s@<>]+$/.test(a)) out.push(a); };
  for (const ch of String(value || '')) {
    if (ch === '"') q = !q;
    else if (!q && ch === '<') angle = true;
    else if (!q && ch === '>') angle = false;
    if (!q && !angle && (ch === ',' || ch === ';')) { take(); continue; }
    cur += ch;
  }
  take();
  return out;
}

const rfcDate = (d) => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const p = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
const uuid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The message Eden's Gmail core built, ready for SMTP and for the Sent folder: Message-ID and Date
 * added when imapMissing, From set to the mailbox; `wire` without the Bcc header; `rcpt` everyone it goes to.
 */
export function prepareOutgoing(raw, email) {
  const s = typeof raw === 'string' ? raw : mimeBinary(raw);
  const m = /\r?\n\r?\n/.exec(s);
  const headText = m ? s.slice(0, m.index) : s;
  const body = m ? s.slice(m.index) : '\r\n\r\n';
  const lines = headText.split(/\r?\n(?![ \t])/);
  const has = (name) => lines.some((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  const extra = [];
  if (!has('Message-ID')) extra.push(`Message-ID: <${uuid()}@${email.split('@')[1] || 'askeden.com'}>`);
  if (!has('Date')) extra.push(`Date: ${rfcDate(new Date())}`);
  if (!has('From')) extra.push(`From: ${email}`);
  const headers = parseHeaders(headText);
  const rcpt = [...new Set(['to', 'cc', 'bcc'].flatMap((n) => headers.filter((h) => h.name.toLowerCase() === n).flatMap((h) => addressesIn(decodeWords(h.value)))).map((a) => a.toLowerCase()))];
  const all = [...extra, ...lines].join('\r\n');
  const wireHead = [...extra, ...lines.filter((l) => !/^bcc:/i.test(l))].join('\r\n');
  const messageId = (/<[^<>\s]+>/.exec(headerOf(parseHeaders([...extra, ...lines].join('\r\n')), 'message-id')) || [''])[0];
  return { full: mimeBytesOf(all + body), wire: mimeBytesOf(wireHead + body), rcpt, messageId, headers: parseHeaders(all) };
}

// ── ids and threads ──

const IMAP_FOLDER_CODE = { inbox: 'i', sent: 's', drafts: 'd', archive: 'a', trash: 't', junk: 'j' };
const ROLE = Object.fromEntries(Object.entries(IMAP_FOLDER_CODE).map(([k, v]) => [v, k]));
const IMAP_ID_RE = /^([isdatj])([0-9a-z]{1,12})-([0-9a-z]{1,12})(?:-([A-Za-z0-9_-]{6,16}))?$/;
export function makeId(role, uidvalidity, uid, hash) {
  return `${IMAP_FOLDER_CODE[role]}${Number(uidvalidity).toString(36)}-${Number(uid).toString(36)}${hash ? `-${hash}` : ''}`;
}
export function parseId(id) {
  const m = IMAP_ID_RE.exec(String(id || ''));
  return m ? { role: ROLE[m[1]], uidvalidity: parseInt(m[2], 36), uid: parseInt(m[3], 36), hash: m[4] || null } : null;
}
const imapUtf8 = new TextEncoder();
export async function midHash(messageId) {
  if (!messageId) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', imapUtf8.encode(messageId.trim().toLowerCase())));
  return mimeB64url(d).slice(0, 10);
}
const rootOf = (headers) => {
  const refs = (headerOf(headers, 'references').match(/<[^<>\s]+>/g) || []);
  return refs[0] || (/<[^<>\s]+>/.exec(headerOf(headers, 'in-reply-to')) || [])[0] || (/<[^<>\s]+>/.exec(headerOf(headers, 'message-id')) || [])[0] || '';
};
/** A thread's id from its first Message-ID ('t' + base64url, so it can be searched for again). */
export function threadIdOf(headers, fallback) {
  const root = rootOf(headers);
  if (root && root.length <= 90) return `t${mimeB64url(imapUtf8.encode(root))}`;
  return fallback;
}
export function rootOfThread(tid) {
  if (!/^t[A-Za-z0-9_-]{4,128}$/.test(String(tid || ''))) return null;
  try { return new TextDecoder().decode(fromBase64(tid.slice(1).replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}
const markOf = (parts) => {
  // FNV-1a over the folders' STATUS numbers, as a decimal Gmail-style history id (≤ 16 digits)
  let h = 0xcbf29ce4n;
  for (const ch of parts.join('|')) h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & 0x1fffffffffffffn;
  return String(h);
};

// ── the Gmail-shaped API over IMAP and SMTP ──

const imapJson = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const imapMissing = () => imapJson({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404);

/**
 * A Gmail REST API (as the core calls it) for one IMAP mailbox: { fetch, close, error }.
 * `account`: { email, user, smtpUser, pass, imap, smtp }; `folders`: pickFolders' answer;
 * `onAuthFail()` when the server refuses the password; `onFolders(folders)` after one was made.
 */
export function createImapGmail({ connect, account, folders: known, onAuthFail, onFolders, now = () => Date.now() }) {
  const folders = { inbox: 'INBOX', ...(known || {}) };
  let client = null;
  let authFailed = false;
  const meta = new Map(); // id → { role, uid, uidvalidity, flags, internal, headers, snippet, size }
  const full = new Map(); // id → parsed message (with its raw)
  const replaced = new Map(); // a draft's old id → its new id (drafts.update), for this request
  const uploads = new Map();
  let nUpload = 0;
  const shim = { error: null };

  async function imap() {
    if (authFailed) throw new ImapError('signed out', 'auth');
    if (client && !client.closed) return client;
    client = await openImap({ connect, host: account.imap.host, port: account.imap.port });
    try { await client.login(account.user, account.pass); }
    catch (e) { if (e.code === 'auth') authFailed = true; throw e; }
    return client;
  }
  const folderFor = (role) => folders[role] || null;
  async function open(role, readOnly) {
    const name = folderFor(role);
    if (!name) return null;
    const c = await imap();
    const info = await c.select(name, { readOnly });
    return { c, info, name };
  }
  async function ensureArchive() {
    if (folders.archive) return folders.archive;
    const c = await imap();
    try { await c.create('Archive'); } catch { /* it may exist without a flag or name we knew */ }
    folders.archive = 'Archive';
    if (onFolders) await onFolders({ ...folders }).catch(() => undefined);
    return folders.archive;
  }

  /** FETCH items for a list: flags, dates, the header and the first few KB of the body (the snippet). */
  const LIST_ITEMS = `UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.${SNIPPET_BYTES}>`;
  async function remember(role, info, rows) {
    const out = [];
    for (const r of rows) {
      const head = r['BODY[HEADER]'] instanceof Uint8Array ? mimeBinary(r['BODY[HEADER]']) : '';
      const text = r['BODY[TEXT]'] instanceof Uint8Array ? mimeBinary(r['BODY[TEXT]']) : '';
      const headers = parseHeaders(head);
      let snippet = '';
      try { snippet = snippetOf(parseMessage(`${head}\r\n\r\n${text}`)); } catch { /* a part too odd to read: no snippet */ }
      const mid = (/<[^<>\s]+>/.exec(headerOf(headers, 'message-id')) || [''])[0];
      const id = makeId(role, info.uidvalidity, r.UID, await midHash(mid));
      const internal = Date.parse(String(r.INTERNALDATE || '').replace(/^(\d{1,2})-(\w{3})-(\d{4}) /, '$2 $1 $3 ')) || Date.parse(headerOf(headers, 'date')) || 0;
      const m = { id, role, uid: r.UID, uidvalidity: info.uidvalidity, flags: (r.FLAGS || []).map(String), internal, headers, snippet, size: Number(r['RFC822.SIZE']) || 0 };
      meta.set(id, m);
      out.push(m);
    }
    return out;
  }
  const labelsOf = (m) => [...(m.role === 'inbox' ? ['INBOX'] : m.role === 'sent' ? ['SENT'] : m.role === 'drafts' ? ['DRAFT'] : []), ...(m.flags.includes('\\Seen') ? [] : ['UNREAD']), ...(m.flags.includes('\\Flagged') ? ['STARRED'] : [])];
  const threadOf = (m) => threadIdOf(m.headers, m.id);
  const resource = (m, payload) => ({ id: m.id, threadId: threadOf(m), labelIds: labelsOf(m), snippet: m.snippet, internalDate: String(m.internal || 0), sizeEstimate: m.size, payload: payload || { mimeType: (headerOf(m.headers, 'content-type').split(';')[0] || 'text/plain').trim().toLowerCase(), headers: gmailHeaders(m.headers) } });

  /** Where an id's message is now: its own folder and UID, else (moved: Done, undo, a snooze) found by its Message-ID hash. */
  async function locate(id) {
    const p = parseId(replaced.get(id) || id);
    if (!p) return null;
    const own = await open(p.role, false);
    if (own && own.info.uidvalidity === p.uidvalidity) {
      const got = await own.c.fetch([p.uid], 'UID');
      if (got.length) return { ...p, id: replaced.get(id) || id };
    }
    if (!p.hash) return null;
    for (const role of ['archive', 'inbox', p.role === 'drafts' ? 'drafts' : 'sent']) {
      const at = await open(role, false);
      if (!at) continue;
      const uids = (await at.c.search('ALL')).slice(-300);
      const rows = await at.c.fetch(uids, 'UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]');
      for (const r of rows) {
        const h = parseHeaders(r['BODY[HEADER.FIELDS (MESSAGE-ID)]'] instanceof Uint8Array ? mimeBinary(r['BODY[HEADER.FIELDS (MESSAGE-ID)]']) : '');
        if ((await midHash((/<[^<>\s]+>/.exec(headerOf(h, 'message-id')) || [''])[0])) === p.hash) return { role, uidvalidity: at.info.uidvalidity, uid: r.UID, hash: p.hash, id: makeId(role, at.info.uidvalidity, r.UID, p.hash) };
      }
    }
    return null;
  }
  async function metaOf(id) {
    const hit = meta.get(replaced.get(id) || id);
    if (hit) return hit;
    const at = await locate(id);
    if (!at) return null;
    const o = await open(at.role, true);
    const rows = await o.c.fetch([at.uid], LIST_ITEMS);
    return (await remember(at.role, o.info, rows))[0] || null;
  }
  async function fullOf(id) {
    const key = replaced.get(id) || id;
    if (full.has(key)) return full.get(key);
    const m = await metaOf(id);
    if (!m) return null;
    const o = await open(m.role, true);
    if (m.size > MAX_READ_BYTES) throw new GoogleError('That email is too big for Eden to read (over 30 MB).', 'too_large', 413);
    const rows = await o.c.fetch([m.uid], 'UID BODY.PEEK[]');
    const raw = rows[0] && rows[0]['BODY[]'];
    if (!(raw instanceof Uint8Array)) return null;
    const node = parseMessage(raw);
    const out = { m, node, raw };
    full.set(m.id, out);
    return out;
  }

  /** A list of ids for a folder (or inbox and sent together), newest first. */
  async function list({ role, search, max, pageToken }) {
    const roles = role === 'any' ? ['inbox', 'sent', 'archive'] : [role];
    const found = [];
    for (const r of roles) {
      const o = await open(r, true);
      if (!o) continue;
      let uids = await o.c.search(search.criteria, search.literals);
      const total = uids.length;
      if (pageToken && roles.length === 1) uids = uids.filter((u) => u < Number(pageToken));
      const pick = uids.slice(-max).reverse();
      const rows = await o.c.fetch(pick, LIST_ITEMS);
      for (const m of await remember(r, o.info, rows)) found.push(m);
      if (roles.length === 1) {
        found.sort((a, b) => b.uid - a.uid);
        return { rows: found, next: uids.length > max ? String(Math.min(...pick)) : null, total };
      }
    }
    found.sort((a, b) => b.internal - a.internal);
    return { rows: found.slice(0, max), next: null, total: found.length };
  }

  async function appendTo(role, flags, bytes) {
    const name = role === 'archive' ? await ensureArchive() : folderFor(role);
    if (!name) return null;
    const c = await imap();
    const got = await c.append(name, flags, bytes);
    const mid = (/<[^<>\s]+>/.exec(headerOf(parseHeaders(mimeBinary(bytes).split(/\r?\n\r?\n/)[0]), 'message-id')) || [''])[0];
    const hash = await midHash(mid);
    if (got) return makeId(role, got.uidvalidity, got.uid, hash);
    // no UIDPLUS: find it by its Message-ID
    const o = await open(role, true);
    const uids = mid ? await o.c.search(`HEADER Message-ID ${imapQuote(mid)}`) : [];
    return uids.length ? makeId(role, o.info.uidvalidity, uids[uids.length - 1], hash) : `${IMAP_FOLDER_CODE[role]}0-0`;
  }
  async function remove(id) {
    const at = await locate(id);
    if (!at) return false;
    const o = await open(at.role, false);
    await o.c.store([at.uid], '+', ['\\Deleted']);
    await o.c.expunge([at.uid]);
    meta.delete(at.id);
    full.delete(at.id);
    return true;
  }
  async function smtpSend(prepared) {
    if (!prepared.rcpt.length) throw new GoogleError('send needs at least one recipient (to, cc or bcc).', 'bad_request', 400);
    if (prepared.rcpt.length > 100) throw new GoogleError('At most 100 recipients.', 'bad_request', 400);
    try {
      await sendSmtp({ connect, host: account.smtp.host, port: account.smtp.port, security: account.smtp.security, user: account.smtpUser || account.email, pass: account.pass, from: account.email, rcpt: prepared.rcpt, data: prepared.wire });
    } catch (e) {
      if (e instanceof SmtpError && e.code === 'auth') authFailed = true;
      throw e;
    }
    // a copy in Sent (the server doesn't keep one for SMTP): best effort, the email has gone either way
    let id = 's0-0';
    try { id = await appendTo('sent', ['\\Seen'], prepared.full); } catch { /* sent, not filed */ }
    return { id, threadId: threadIdOf(prepared.headers, id) };
  }

  // ── the routes ──

  async function route(url, init) {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const bodyJson = () => { try { return init.body ? JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : {}; } catch { return {}; } };

    // the resumable upload of a big message: collected here, then sent or filed like a small one
    if (url.startsWith(GMAIL_UPLOAD_BASE)) {
      const path = u.pathname.replace('/upload/gmail/v1/users/me', '');
      const uid = u.searchParams.get('upload_id');
      if (!uid && method !== 'PUT') {
        const n = `imap${++nUpload}`;
        const size = Number((init.headers || {})['x-upload-content-length'] || 0);
        uploads.set(n, { method, path, meta: bodyJson(), size, chunks: [], got: 0 });
        return imapJson({}, 200, { location: `${GMAIL_UPLOAD_BASE}${path}?uploadType=resumable&upload_id=${n}` });
      }
      const up = uploads.get(uid || '');
      if (!up) return imapMissing();
      const bytes = init.body instanceof Uint8Array ? init.body : typeof init.body === 'string' ? imapUtf8.encode(init.body) : new Uint8Array(await new Response(init.body).arrayBuffer());
      up.chunks.push(bytes);
      up.got += bytes.length;
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec((init.headers || {})['content-range'] || '');
      if (range && up.got < Number(range[3])) return new Response(null, { status: 308, headers: { range: `bytes=0-${up.got - 1}` } });
      const raw = new Uint8Array(up.got);
      let at = 0;
      for (const c of up.chunks) { raw.set(c, at); at += c.length; }
      uploads.delete(uid);
      return deliver(up.method, up.path, up.meta, raw);
    }

    const path = u.pathname.replace('/gmail/v1/users/me', '');
    const q = u.searchParams;
    let m;
    if (path === '/profile') {
      const st = await marks();
      return imapJson({ emailAddress: account.email, messagesTotal: st.messages, threadsTotal: st.messages, historyId: st.mark });
    }
    if (path === '/history') {
      const st = await marks();
      const changed = st.mark !== q.get('startHistoryId');
      return imapJson({ historyId: st.mark, history: changed ? [{ messagesAdded: [{ message: { id: 'changed' } }] }] : [] });
    }
    if (path === '/settings/sendAs') return imapJson({ sendAs: [{ sendAsEmail: account.email, displayName: '', isPrimary: true, isDefault: true, verificationStatus: 'accepted' }] });
    if (path === '/messages' && method === 'GET') {
      const search = toImapSearch(q.get('q') || '', now());
      const label = q.get('labelIds');
      const role = label === 'INBOX' ? 'inbox' : label === 'SENT' ? 'sent' : label === 'DRAFT' ? 'drafts' : search.folder || 'any';
      const max = Math.min(Number(q.get('maxResults')) || 20, 100);
      const got = await list({ role, search, max, pageToken: q.get('pageToken') });
      return imapJson({ messages: got.rows.map((r) => ({ id: r.id, threadId: threadOf(r) })), ...(got.next ? { nextPageToken: got.next } : {}), resultSizeEstimate: got.total });
    }
    if (path === '/messages/batchModify' && method === 'POST') {
      const b = bodyJson();
      await modify(b.ids || [], b.addLabelIds || [], b.removeLabelIds || []);
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path))) {
      const got = await fullOf(m[1]);
      const pathOf = pathOfAttachmentId(m[2]);
      const part = got && pathOf !== null ? partAt(got.node, pathOf) : null;
      if (!part) return imapMissing();
      return imapJson(q.get('fields') === 'size' ? { size: part.body.length } : { size: part.body.length, data: mimeB64url(part.body) });
    }
    if ((m = /^\/messages\/([^/]+)$/.exec(path)) && method === 'GET') {
      if ((q.get('format') || 'full') === 'full') {
        const got = await fullOf(m[1]);
        if (!got) return imapMissing();
        return imapJson({ ...resource(got.m, gmailPayload(got.node)), snippet: got.m.snippet || snippetOf(got.node) });
      }
      const mm = await metaOf(m[1]);
      return mm ? imapJson(resource(mm)) : imapMissing();
    }
    if (path === '/messages/send' && method === 'POST') {
      const b = bodyJson();
      return deliver('POST', '/messages/send', b, fromBase64(String(b.raw || '').replace(/-/g, '+').replace(/_/g, '/')));
    }
    if ((m = /^\/threads\/([^/]+)$/.exec(path))) {
      const root = rootOfThread(m[1]);
      if (!root) return imapMissing();
      const rows = [];
      for (const role of ['inbox', 'sent', 'archive']) {
        const o = await open(role, true);
        if (!o) continue;
        const uids = (await o.c.search(`OR HEADER Message-ID ${imapQuote(root)} HEADER References ${imapQuote(root)}`)).slice(-50);
        rows.push(...await remember(role, o.info, await o.c.fetch(uids, LIST_ITEMS)));
      }
      if (!rows.length) return imapMissing();
      rows.sort((a, b) => a.internal - b.internal);
      return imapJson({ id: m[1], messages: rows.map((r) => ({ ...resource(r), threadId: m[1] })) });
    }
    if (path === '/drafts' && method === 'GET') {
      const search = toImapSearch(q.get('q') || '', now());
      const got = await list({ role: 'drafts', search, max: Math.min(Number(q.get('maxResults')) || 20, 100), pageToken: q.get('pageToken') });
      return imapJson({ drafts: got.rows.map((r) => ({ id: r.id, message: { id: r.id, threadId: threadOf(r) } })), ...(got.next ? { nextPageToken: got.next } : {}) });
    }
    if (path === '/drafts' && method === 'POST') {
      const b = bodyJson();
      return deliver('POST', '/drafts', b, fromBase64(String((b.message && b.message.raw) || '').replace(/-/g, '+').replace(/_/g, '/')));
    }
    if (path === '/drafts/send' && method === 'POST') {
      const b = bodyJson();
      const got = await fullOf(String(b.id || ''));
      if (!got || got.m.role !== 'drafts') return imapMissing();
      const prepared = prepareOutgoing(got.raw, account.email);
      const sent = await smtpSend(prepared);
      await remove(got.m.id).catch(() => undefined);
      return imapJson(sent);
    }
    if ((m = /^\/drafts\/([^/]+)$/.exec(path))) {
      if (method === 'GET') {
        const got = await fullOf(m[1]);
        if (!got || got.m.role !== 'drafts') return imapMissing();
        return imapJson({ id: got.m.id, message: { ...resource(got.m, gmailPayload(got.node)), snippet: got.m.snippet } });
      }
      if (method === 'DELETE') return (await remove(m[1])) ? new Response(null, { status: 204 }) : imapMissing();
      if (method === 'PUT') {
        const b = bodyJson();
        return deliver('PUT', `/drafts/${m[1]}`, b, fromBase64(String((b.message && b.message.raw) || '').replace(/-/g, '+').replace(/_/g, '/')));
      }
    }
    return imapJson({ error: { code: 400, message: `Eden’s IMAP mailboxes don’t do ${method} ${path}.`, status: 'INVALID_ARGUMENT' } }, 400);
  }

  /** A message the core built: sent (messages.send), or filed as a draft (drafts.create / drafts.update). */
  async function deliver(method, path, metaJson, raw) {
    const prepared = prepareOutgoing(raw, account.email);
    if (path === '/messages/send') return imapJson(await smtpSend(prepared));
    const id = await appendTo('drafts', ['\\Draft', '\\Seen'], prepared.full);
    const old = /^\/drafts\/([^/]+)$/.exec(path);
    if (old) {
      await remove(old[1]).catch(() => undefined);
      replaced.set(old[1], id);
    }
    return imapJson({ id, message: { id, threadId: threadIdOf(prepared.headers, id) } });
  }

  async function modify(ids, add, rem) {
    const flagsAdd = [...(rem.includes('UNREAD') ? ['\\Seen'] : []), ...(add.includes('STARRED') ? ['\\Flagged'] : [])];
    const flagsRem = [...(add.includes('UNREAD') ? ['\\Seen'] : []), ...(rem.includes('STARRED') ? ['\\Flagged'] : [])];
    for (const id of ids) {
      const at = await locate(id);
      if (!at) continue;
      const o = await open(at.role, false);
      if (flagsAdd.length) await o.c.store([at.uid], '+', flagsAdd);
      if (flagsRem.length) await o.c.store([at.uid], '-', flagsRem);
      if (rem.includes('INBOX') && at.role === 'inbox') await o.c.move([at.uid], await ensureArchive());
      else if (add.includes('INBOX') && ['archive', 'junk', 'trash'].includes(at.role)) await o.c.move([at.uid], 'INBOX'); // undo Done, a snooze waking
      meta.delete(at.id);
    }
  }

  async function marks() {
    const c = await imap();
    const parts = [];
    let messages = 0;
    for (const role of ['inbox', 'sent', 'drafts']) {
      const name = folderFor(role);
      if (!name) continue;
      const s = await c.status(name);
      if (role === 'inbox') messages = Number(s.messages) || 0;
      parts.push(role, s.uidvalidity, s.uidnext, s.messages, s.unseen, s.highestmodseq || '');
    }
    return { mark: markOf(parts), messages };
  }

  shim.fetch = async (url, init = {}) => {
    try {
      return await route(String(url), init);
    } catch (e) {
      if ((e instanceof ImapError || e instanceof SmtpError) && e.code === 'auth') {
        shim.error = new GoogleError(`${account.email} didn’t accept its app password. Make a new one and press Reconnect in Mail.`, 'reconnect', 401);
        if (onAuthFail) await onAuthFail().catch(() => undefined);
        return imapJson({ error: { code: 401, message: 'Unauthorized' } }, 401);
      }
      if (e instanceof GoogleError) { shim.error = e; return imapJson({ error: { code: e.status, message: e.message } }, e.status); }
      shim.error = new GoogleError(e instanceof ImapError || e instanceof SmtpError ? e.message : `${account.imap.host} couldn’t be read right now. Try again in a minute.`, e && e.code === 'timeout' ? 'unavailable' : 'upstream', e && e.code === 'timeout' ? 503 : 502);
      return imapJson({ error: { code: shim.error.status, message: shim.error.message } }, shim.error.status);
    }
  };
  shim.close = async () => { if (client) await client.logout().catch(() => undefined); };
  return shim;
}

// ── adding a mailbox ──

/**
 * Signs in to IMAP (each login name to try) and SMTP once, without reading or sending anything, and
 * reads the folder names. Returns { user, smtpUser, folders }; throws ImapError/SmtpError ('auth' when
 * the password is wrong).
 */
export async function verifyImapAccount({ connect, email, pass, imap, smtp, users = ['email'] }) {
  let lastAuth = null;
  let found = null;
  for (const u of [...new Set(users.map((x) => (x === 'local' ? email.split('@')[0] : x === 'email' ? email : x)))]) {
    const c = await openImap({ connect, host: imap.host, port: imap.port });
    try {
      await c.login(u, pass);
      found = { user: u, folders: pickFolders(await c.list()) };
      break;
    } catch (e) {
      if (e.code !== 'auth') throw e;
      lastAuth = e;
    } finally {
      await c.logout().catch(() => undefined);
    }
  }
  if (!found) throw lastAuth || new ImapError('The mail server didn’t accept that address and app password.', 'auth');
  let smtpUser = null;
  for (const u of [...new Set([email, found.user])]) {
    try {
      await sendSmtp({ connect, host: smtp.host, port: smtp.port, security: smtp.security, user: u, pass, from: email, rcpt: ['check'], data: null });
      smtpUser = u;
      break;
    } catch (e) {
      if (!(e instanceof SmtpError) || e.code !== 'auth') throw e;
    }
  }
  if (!smtpUser) throw new SmtpError('The mail server took the app password for reading but not for sending.', 'auth');
  return { user: found.user, smtpUser, folders: found.folders };
}

/** cloudflare:sockets' connect (tests pass their own as env.MAIL_SOCKETS). */
export async function socketsFor(env) {
  if (env && typeof env.MAIL_SOCKETS === 'function') return env.MAIL_SOCKETS;
  const { connect } = await import('cloudflare:sockets');
  return connect;
}
export { attachmentIdOf };
