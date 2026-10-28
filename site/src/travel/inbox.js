// Bookings in, documents out. Three ways a booking reaches a trip besides Eden Mail (ops.js trip-mail-*): the person
// pastes a confirmation, or forwards it to their own Eden Travel address (trips+<code>@TRAVEL_INBOX_DOMAIN, through
// Cloudflare Email Routing to the Worker's email handler). Either way the email is kept as it came, read by the same
// reader as Eden Mail (confirmations.js: the airline's or hotel's structured data, never a model's guess), and shown as
// a card the person presses; nothing is added to the trip by the email alone. And each stop can hold its documents
// (tickets, boarding passes, PDFs), kept in the account's own object and cached by the page for offline use.
//
// Where it lives (the account's object): tpaste:<id> / tinbox:<id> → { subject, from, date, html, text } (the email,
// capped) · tinaddr → { code } with the index object `tin:<code>` → { account } · tdoc:<trip>:<doc> → the document's
// details, its bytes in tdocb:<doc>:<n> (chunks, as the object's values are capped).
//
//   trip-paste          { id, text, html? }          → { candidates, paste }  (kept 7 days; import with trip-mail-import
//                                                                              { source: 'paste', message: paste, … })
//   trip-inbox-address  {}                           → { address, on }         (made on first ask)
//   trip-inbox-reset    { confirm: true }            → { address, on }         (a new address; the old one stops)
//   trip-inbox          { id }                       → { candidates }          (forwarded emails for this trip; import with
//                                                                              source: 'inbox')
//   trip-inbox-drop     { message }                  → { dropped }
//   tinbox-add          { code, email }              (the Worker's email handler; no device signs it)
//   trip-doc-add        { id, stop, name, type, data (base64) } → { doc }
//   trip-docs           { id }                       → { docs }
//   trip-doc-get        { id, doc }                  → { doc, data (base64) }  (GET /api/chat/travel/doc serves the bytes)
//   trip-doc-delete     { id, doc }                  → { deleted }

import { ApiError } from '../accounts/util.js';
import { CODE, ask, newCode } from './track.js';

export const INBOX = { keep: 30, pasteMs: 7 * 86400_000, emailBytes: 1_500_000, partChars: 400_000 };
export const DOCS = { fileBytes: 10 * 1024 * 1024, perTrip: 60, accountBytes: 200 * 1024 * 1024, chunk: 1024 * 1024 };
// what a document may be, and the bytes it must start with (so a page can't be stored as a "PDF" and served back)
export const DOC_TYPES = {
  'application/pdf': (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46, // %PDF
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'image/heic': (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70, // ftyp
  'application/vnd.apple.pkpass': (b) => b[0] === 0x50 && b[1] === 0x4b, // a zip
};
const TRIP_ID = /^[0-9a-f]{16}$/;
const DOC_ID = /^d-[0-9a-f]{12}$/;
const MSG_ID = /^[0-9a-f]{16}$/;
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const inboxIndex = (env, code, op, body) => ask(env, `tin:${code}`, op, body);
export const inboxAddress = (env, code) => `trips+${code}@${String(env.TRAVEL_INBOX_DOMAIN || 'askedentravel.com').trim()}`;

/* ---------- an email as it came: MIME → { subject, from, date, html, text } ---------- */

const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
function decodeBytes(bytes, charset) {
  try { return new TextDecoder(String(charset || 'utf-8').toLowerCase().replace(/^(us-)?ascii$/, 'utf-8')).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
function qp(s) {
  const t = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else out.push(t.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}
function b64(s) {
  try { return latin1(atob(s.replace(/[^A-Za-z0-9+/=]/g, ''))); } catch { return new Uint8Array(); }
}
/** A header's encoded words (=?utf-8?B?…?= / =?…?Q?…?=) read out. */
export function headerText(v) {
  return String(v || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=\s*(?==\?)/g, '=?$1?$2?$3?=').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => decodeBytes(enc.toUpperCase() === 'B' ? b64(data) : qp(data.replace(/_/g, ' ')), cs));
}
function headersOf(block) {
  const h = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim(); }
  }
  return h;
}
const param = (v, name) => { const m = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(v || ''); return m ? (m[2] ?? m[1]) : null; };

/** The raw email (as a binary string, one char a byte) → its html and text parts, subject, sender and date. */
export function parseEmail(raw) {
  const out = { subject: '', from: '', date: null, html: '', text: '' };
  const walk = (part, depth) => {
    if (depth > 8 || out.html.length + out.text.length > INBOX.partChars * 2) return;
    const split = part.search(/\r?\n\r?\n/);
    const head = headersOf(split < 0 ? part : part.slice(0, split));
    const body = split < 0 ? '' : part.slice(split).replace(/^\r?\n\r?\n/, '');
    if (depth === 0) {
      out.subject = clean(headerText(head.subject), 200);
      out.from = clean(headerText(head.from), 160);
      const d = Date.parse(head.date || '');
      out.date = Number.isFinite(d) ? new Date(d).toISOString() : null;
    }
    const type = String(head['content-type'] || 'text/plain').toLowerCase();
    if (type.startsWith('multipart/')) {
      const boundary = param(head['content-type'], 'boundary');
      if (!boundary) return;
      for (const p of body.split(`--${boundary}`).slice(1)) { if (p.startsWith('--')) break; walk(p.replace(/^\r?\n/, ''), depth + 1); }
      return;
    }
    if (type.startsWith('message/rfc822')) return walk(body, depth + 1); // a forwarded email, attached whole
    if (!type.startsWith('text/html') && !type.startsWith('text/plain')) return;
    if (/attachment/i.test(head['content-disposition'] || '')) return;
    const enc = String(head['content-transfer-encoding'] || '').toLowerCase();
    const bytes = enc === 'base64' ? b64(body) : enc === 'quoted-printable' ? qp(body) : latin1(body);
    const s = decodeBytes(bytes, param(head['content-type'], 'charset')).slice(0, INBOX.partChars);
    if (type.startsWith('text/html')) out.html += s; else out.text += s;
  };
  walk(String(raw || ''), 0);
  return out;
}

/** The Worker's email handler (worker.js `email`): trips+<code>@ → that account's inbox. Unknown addresses are refused. */
export async function travelEmail(message, env) {
  const to = String(message.to || '').toLowerCase();
  const m = /^trips\+([a-z0-9]{12})@/.exec(to);
  if (!m) return message.setReject('No such Eden Travel address.');
  if (Number(message.rawSize) > INBOX.emailBytes) return message.setReject('That email is too large for Eden Travel.');
  const { account } = await inboxIndex(env, m[1], 'tshare-index-get').catch(() => ({}));
  if (!account) return message.setReject('No such Eden Travel address.');
  const buf = new Uint8Array(await new Response(message.raw).arrayBuffer());
  let raw = '';
  for (let i = 0; i < buf.length; i += 8192) raw += String.fromCharCode(...buf.subarray(i, i + 8192));
  const email = parseEmail(raw);
  if (!email.from) email.from = clean(message.from, 160);
  await ask(env, account, 'tinbox-add', { code: m[1], email });
}

/* ---------- in the account's object ---------- */

const keepEmail = (e) => ({ subject: clean(e.subject, 200), from: clean(e.from, 160), date: typeof e.date === 'string' ? e.date.slice(0, 30) : null, html: String(e.html || '').slice(0, INBOX.partChars), text: String(e.text || '').slice(0, INBOX.partChars) });

async function prune(storage, prefix, keep, now, ms = null) {
  const all = [...(await storage.list({ prefix }))].sort((a, b) => a[1].received - b[1].received);
  const old = all.filter(([, v], i) => i < all.length - keep || (ms && now - v.received > ms)).map(([k]) => k);
  if (old.length) await storage.delete(old);
}

/** The stored emails as the mail reader's `mail`: parts(id) and the ids. ops.js reads them as it reads Eden Mail. */
export function storedMail(storage, source) {
  const prefix = source === 'paste' ? 'tpaste:' : 'tinbox:';
  return {
    async ids() { return [...(await storage.list({ prefix }))].sort((a, b) => b[1].received - a[1].received).map(([k]) => k.slice(prefix.length)); },
    async parts(id) {
      if (!MSG_ID.test(String(id))) throw new ApiError(404, 'not_found', 'There is no such email here.');
      const e = await storage.get(`${prefix}${id}`);
      if (!e) throw new ApiError(404, 'not_found', source === 'paste' ? 'That pasted confirmation has expired. Paste it again.' : 'That forwarded email is gone.');
      return { ...e, id };
    },
  };
}

export async function inboxOp(account, op, body, { notify } = {}) {
  const storage = account.storage;
  const now = account.now();
  switch (op) {
    case 'trip-paste': {
      const text = String(body.text || '').slice(0, INBOX.partChars), html = String(body.html || '').slice(0, INBOX.partChars);
      if (!text.trim() && !html.trim()) throw new ApiError(400, 'bad_request', 'Paste the confirmation’s text first.');
      // a pasted .eml (headers and all) is read as an email; anything else as its text (and HTML, when the page had it)
      const e = /^(received|from|subject|mime-version|date|to|return-path|delivered-to):/im.test(text.slice(0, 2000)) && /\r?\n\r?\n/.test(text) ? parseEmail(text) : { subject: 'Pasted confirmation', from: 'You', date: new Date(now).toISOString(), html, text };
      const id = hex(8);
      await storage.put(`tpaste:${id}`, { ...keepEmail(e), received: now });
      await prune(storage, 'tpaste:', 20, now, INBOX.pasteMs);
      return { paste: id };
    }
    case 'trip-inbox-address':
    case 'trip-inbox-reset': {
      let addr = await storage.get('tinaddr');
      if (op === 'trip-inbox-reset') {
        if (body.confirm !== true) throw new ApiError(400, 'bad_request', 'inbox-reset needs confirm: true.');
        if (addr) await inboxIndex(account.env, addr.code, 'tshare-index-drop', {}).catch(() => {});
        addr = null;
      }
      if (!addr) {
        const acct = ((await storage.get('account')) || {}).id;
        for (let i = 0; i < 4 && !addr; i++) {
          const c = newCode();
          const claimed = await inboxIndex(account.env, c, 'tshare-index-claim', { account: acct }).catch(() => null);
          if (claimed && claimed.ok) addr = { code: c, created: now };
        }
        if (!addr) throw new ApiError(503, 'unavailable', 'Couldn’t make an address just now. Try again.');
        await storage.put('tinaddr', addr);
      }
      return { address: inboxAddress(account.env, addr.code), on: Boolean(account.env.TRAVEL_INBOX_DOMAIN) };
    }
    case 'tinbox-add': {
      const addr = await storage.get('tinaddr');
      if (!addr || !CODE.test(String(body.code || '')) || addr.code !== body.code) throw new ApiError(404, 'not_found', 'No such Eden Travel address.');
      const id = hex(8);
      const e = keepEmail(body.email || {});
      await storage.put(`tinbox:${id}`, { ...e, received: now });
      await prune(storage, 'tinbox:', INBOX.keep, now);
      if (notify) await notify(account, { title: 'Booking email received', body: `“${e.subject || 'An email'}” is in Eden Travel. Open a trip to add it.`, data: { kind: 'inbox' } }).catch(() => {});
      return { kept: true };
    }
    case 'trip-inbox-drop': {
      const id = String(body.message || '');
      if (!MSG_ID.test(id)) throw new ApiError(404, 'not_found', 'There is no such email here.');
      await storage.delete(`tinbox:${id}`);
      return { dropped: true };
    }
    case 'trip-doc-add': return docAdd(account, body);
    case 'trip-docs': {
      const id = tripId(body);
      return { docs: [...(await storage.list({ prefix: `tdoc:${id}:` })).values()].sort((a, b) => a.added - b.added) };
    }
    case 'trip-doc-get': {
      const id = tripId(body);
      const doc = await storage.get(`tdoc:${id}:${String(body.doc || '')}`);
      if (!doc) throw new ApiError(404, 'not_found', 'There is no such document.');
      const parts = await storage.get([...Array(doc.chunks).keys()].map((n) => `tdocb:${doc.id}:${n}`));
      const bytes = new Uint8Array(doc.bytes);
      let at = 0;
      for (let n = 0; n < doc.chunks; n++) { const c = parts.get(`tdocb:${doc.id}:${n}`); if (!c) throw new ApiError(410, 'gone', 'This document is damaged. Add it again.'); bytes.set(new Uint8Array(c), at); at += c.byteLength; }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { doc, data: btoa(bin) };
    }
    case 'trip-doc-delete': {
      const id = tripId(body);
      const key = `tdoc:${id}:${String(body.doc || '')}`;
      const doc = await storage.get(key);
      if (!doc) throw new ApiError(404, 'not_found', 'There is no such document.');
      await storage.delete([key, ...[...Array(doc.chunks).keys()].map((n) => `tdocb:${doc.id}:${n}`)]);
      return { deleted: true };
    }
    default:
      throw new ApiError(404, 'not_found', 'Not found');
  }
}

function tripId(body) {
  const id = String(body.id || '');
  if (!TRIP_ID.test(id)) throw new ApiError(400, 'bad_request', 'id must be a trip id.');
  return id;
}

async function docAdd(account, body) {
  const storage = account.storage;
  const id = tripId(body);
  const trip = await storage.get(`trip:${id}`);
  if (!trip) throw new ApiError(404, 'not_found', 'There is no such trip.');
  const stop = body.stop ? String(body.stop) : null;
  if (stop && !trip.days.some((d) => d.stops.some((s) => s.id === stop))) throw new ApiError(404, 'not_found', 'There is no such stop in this trip.');
  const type = String(body.type || '').toLowerCase();
  if (!DOC_TYPES[type]) throw new ApiError(400, 'bad_request', 'A document can be a PDF, a picture (PNG, JPEG, WebP, HEIC) or an Apple Wallet pass.');
  let bytes;
  try { bytes = latin1(atob(String(body.data || ''))); } catch { throw new ApiError(400, 'bad_request', 'data must be the file in base64.'); }
  if (!bytes.length) throw new ApiError(400, 'bad_request', 'That file is empty.');
  if (bytes.length > DOCS.fileBytes) throw new ApiError(413, 'too_large', `A document can be at most ${DOCS.fileBytes / 1024 / 1024} MB.`);
  if (!DOC_TYPES[type](bytes)) throw new ApiError(400, 'bad_request', 'That file isn’t the kind it says it is.');
  const docs = [...(await storage.list({ prefix: 'tdoc:' })).values()];
  if (docs.filter((d) => d.trip === id).length >= DOCS.perTrip) throw new ApiError(409, 'too_many', `A trip keeps at most ${DOCS.perTrip} documents.`);
  if (docs.reduce((n, d) => n + d.bytes, 0) + bytes.length > DOCS.accountBytes) throw new ApiError(409, 'too_many', 'Your Eden Travel documents are full. Delete some first.');
  const doc = { id: `d-${hex(6)}`, trip: id, stop, name: clean(body.name, 120) || 'Document', type, bytes: bytes.length, chunks: Math.ceil(bytes.length / DOCS.chunk), added: account.now() };
  const put = { [`tdoc:${id}:${doc.id}`]: doc };
  for (let n = 0; n < doc.chunks; n++) put[`tdocb:${doc.id}:${n}`] = bytes.slice(n * DOCS.chunk, (n + 1) * DOCS.chunk).buffer;
  await storage.put(put);
  return { doc };
}

/** A trip's documents gone with it (ops.js trip-delete). */
export async function dropTripDocs(storage, id) {
  const docs = [...(await storage.list({ prefix: `tdoc:${id}:` }))];
  const keys = docs.flatMap(([k, d]) => [k, ...[...Array(d.chunks).keys()].map((n) => `tdocb:${d.id}:${n}`)]);
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
}
