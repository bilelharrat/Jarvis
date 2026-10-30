// Share a conversation as a read-only link (ROADMAP Q3), the pure part: which messages a share can
// hold, the snapshot made of the ones the owner picks, the personal-data check shown before it goes
// out, and its encryption. No DOM; share.js (the dialog in Eden) and share-view.js (the public
// page at /s/<id>) both use it; the tests load it alone.
//
// Why the key is in the link's #fragment, and what that trades away:
// Eden's chats are end-to-end encrypted (H1): askeden.com never holds their plaintext. A shared
// link has to be readable by someone with no Eden account and no key of the owner's, so a share
// is a separate snapshot, made on purpose, of only the messages the owner picked. It is encrypted
// here with a fresh random AES-256-GCM key for that one share; the server stores only the
// ciphertext and the key travels in the link after the "#", which browsers never send to any
// server (not in requests, not in Referer). So askeden.com (or the Mac's server) still can't read
// a shared chat, and revoking it deletes the ciphertext, which makes every copy of the link dead.
// The costs: anyone who has the whole link can read it (as with any "anyone with the link"
// share; the link is the secret, so it must be shared with care); the server can't preview,
// search or scan what it holds, so abuse reports need the full link; a link copied without its
// fragment opens to "this link is missing its key"; and the shared page has to run a script to
// decrypt (it is a fixed, same-origin script under a strict CSP; the content itself is rendered
// as untrusted Markdown, never as HTML). The plaintext alternative (the server keeps a readable
// snapshot) would allow server-side rendering and indexing, which a private share doesn't want.

import { detectSensitive } from './privacy-rules.js';

export const SHARE_VERSION = 1;
export const SHARE_LIMITS = { messages: 400, text: 100_000, title: 120, bytes: 2 * 1024 * 1024, max: 100 };
export const EXPIRY = [
  { k: 'never', label: 'Never (until you revoke it)', ms: 0 },
  { k: '1d', label: '1 day', ms: 864e5 },
  { k: '7d', label: '7 days', ms: 7 * 864e5 },
  { k: '30d', label: '30 days', ms: 30 * 864e5 },
];
/** When a share made at `now` with expiry choice `k` stops working (ms), or null for never. */
export const expiresAt = (k, now = Date.now()) => { const e = EXPIRY.find((x) => x.k === k); return e && e.ms ? now + e.ms : null; };

const clean = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const oneLine = (s, max) => clean(s, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);

/** A node's shareable text: what the person typed, or the reply's text parts (tool calls, thinking and attachments are never shared). */
export function shareText(n) {
  if (!n) return '';
  if (n.role === 'user') return String(n.content || '');
  return (n.parts || []).filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
}

/**
 * The messages a share of `c` can hold: the shown version of each turn, in order, as
 * [{ id, role, text, model, at, files }] (files: how many attachments are left out).
 */
export function shareable(c) {
  const out = [];
  if (!c || !c.root) return out;
  let p = c.root;
  const seen = new Set();
  while (p.children && p.children.length) {
    const id = p.children[Math.min(p.sel || 0, p.children.length - 1)];
    const n = c.nodes[id];
    if (!n || seen.has(id)) break;
    seen.add(id);
    const text = shareText(n).trim();
    if ((n.role === 'user' || n.role === 'assistant') && text && !n.streaming) {
      const model = n.role === 'assistant' ? (n.route && (n.route.modelName || n.route.model)) || n.importedModel || '' : '';
      out.push({ id, role: n.role, text, model: oneLine(model, 60), at: n.created || 0, files: (n.attachments || []).length });
    }
    p = n;
  }
  return out;
}

/** The snapshot of the picked messages (ids from shareable()), exactly what the link will show. */
export function buildSnapshot({ title, items, picked, now = Date.now() }) {
  const keep = (items || []).filter((x) => picked.has(x.id)).slice(0, SHARE_LIMITS.messages);
  return {
    v: SHARE_VERSION,
    title: oneLine(title, SHARE_LIMITS.title) || 'Shared chat',
    shared: now,
    messages: keep.map((x) => ({ role: x.role, text: clean(x.text, SHARE_LIMITS.text), ...(x.model ? { model: x.model } : {}), ...(x.at ? { at: x.at } : {}) })),
  };
}

/** A decrypted snapshot, checked field by field (what the public page trusts of it), or throws. */
export function checkSnapshot(x) {
  if (!x || typeof x !== 'object' || x.v !== SHARE_VERSION || !Array.isArray(x.messages)) throw new Error('This shared chat is damaged.');
  return {
    v: SHARE_VERSION,
    title: oneLine(x.title, SHARE_LIMITS.title) || 'Shared chat',
    shared: Number.isFinite(x.shared) ? x.shared : 0,
    messages: x.messages.slice(0, SHARE_LIMITS.messages).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .map((m) => ({ role: m.role, text: clean(m.text, SHARE_LIMITS.text), model: typeof m.model === 'string' ? oneLine(m.model, 60) : '', at: Number.isFinite(m.at) ? m.at : 0 })),
  };
}

/* ---------- personal data, before anything is shared ---------- */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
const PHONE = /(?:^|[^\w+])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]?\d{3,4}(?![\w-])/;
const ADDRESS = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Square|Sq|Terrace)\b\.?|\b(?:Rua|Avenida|Calle|Via|Rue|Straße|Strasse)\s+[A-Z]/;
const TOKEN_URL = /https?:\/\/\S*[?&](?:token|key|sig|signature|auth|code|session|access_token|apikey|api_key)=[^\s&]{8,}/i;
const BIRTH = /\b(?:born on|date of birth|dob|birthday)\b[^\n]{0,20}\d/i;

/** What in `text` looks like personal data: [{ kind, label }] (privacy-rules.js's checks, plus contact details). */
export function personalIn(text) {
  const t = String(text || '');
  const out = detectSensitive(t).map((h) => ({ kind: h.kind, label: h.label }));
  const add = (kind, label) => { if (!out.some((h) => h.kind === kind)) out.push({ kind, label }); };
  if (EMAIL.test(t)) add('email', 'an email address');
  if (PHONE.test(t)) add('phone', 'a phone number');
  if (ADDRESS.test(t)) add('address', 'a street address');
  if (TOKEN_URL.test(t)) add('link with a key', 'a link with a key or token in it');
  if (BIRTH.test(t)) add('birth date', 'a date of birth');
  return out;
}

/** The personal-data warnings for a snapshot: [{ index (-1: the title), role, labels }]. */
export function personalData(snapshot) {
  const out = [];
  const t = personalIn(snapshot.title);
  if (t.length) out.push({ index: -1, role: 'title', labels: t.map((h) => h.label) });
  snapshot.messages.forEach((m, i) => { const h = personalIn(m.text); if (h.length) out.push({ index: i, role: m.role, labels: h.map((x) => x.label) }); });
  return out;
}

/* ---------- encryption: AES-256-GCM, a fresh key per share, the key only in the link ---------- */

const b64u = (bytes) => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
export const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
export const ID_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes, base64url (the server picks it)
const AAD = new TextEncoder().encode('eden-share-v1');

/** { key (base64url, for the link), blob (JSON text for the server: { v, iv, ct }) }. */
export async function sealSnapshot(snapshot, subtle = globalThis.crypto.subtle) {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(snapshot)));
  return { key: b64u(raw), blob: JSON.stringify({ v: SHARE_VERSION, iv: b64u(iv), ct: b64u(ct) }) };
}

/** The snapshot in `blob`, opened with the link's key, checked; throws a plain-English Error. */
export async function openSnapshot(blob, keyText, subtle = globalThis.crypto.subtle) {
  if (!KEY_RE.test(String(keyText || ''))) throw new Error('This link is missing its key (the part after #). Ask for the whole link.');
  let env;
  try { env = typeof blob === 'string' ? JSON.parse(blob) : blob; } catch { env = null; }
  if (!env || env.v !== SHARE_VERSION || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new Error('This shared chat is damaged.');
  let plain;
  try {
    const key = await subtle.importKey('raw', unb64u(keyText), 'AES-GCM', false, ['decrypt']);
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv), additionalData: AAD }, key, unb64u(env.ct));
  } catch { throw new Error('This link’s key doesn’t open this chat. Check you copied the whole link.'); }
  let x;
  try { x = JSON.parse(new TextDecoder().decode(plain)); } catch { throw new Error('This shared chat is damaged.'); }
  return checkSnapshot(x);
}

/** The link to share: the page's address, then the key after # (never sent to the server). */
export const shareLink = (origin, id, key) => `${String(origin).replace(/\/+$/, '')}/s/${id}#${key}`;
/** The key in a page's location.hash ('#<key>' or '#k=<key>'), or ''. */
export const keyFromHash = (hash) => { const h = String(hash || '').replace(/^#/, '').replace(/^k=/, ''); return KEY_RE.test(h) ? h : ''; };
/** The share id in /s/<id>, or ''. */
export const idFromPath = (p) => { const m = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(String(p || '')); return m ? m[1] : ''; };

/** A share as the owner keeps it on the chat (synced end-to-end encrypted with it): the key stays with the owner. */
export const shareRecord = ({ id, key, title, created, expires, count }) => ({ id, key, title: oneLine(title, SHARE_LIMITS.title), created, expires: expires || null, count });
