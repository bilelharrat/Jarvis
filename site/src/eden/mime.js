// Reading raw email (RFC 5322 + MIME) for Eden Mail's IMAP mailboxes (iCloud, Yahoo, AOL, other servers;
// askeden ROADMAP Y2). mail-imap.js turns what this reads into Gmail's message format, so Eden's Gmail
// core (vendor/google.js) shows, sanitizes and answers about these emails exactly as it does Gmail's.
//
// Bytes are carried as "binary strings" (one char per byte, latin1) while splitting, so offsets stay
// exact; text is decoded only at the end, by its own charset. Lenient: a truncated or odd message
// still gives what it can (a list's snippet reads only the first few KB of a body).

const MAX_DEPTH = 20;
const MAX_PARTS = 300;

/** Uint8Array → mimeBinary string (one char per byte). */
export function mimeBinary(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}
/** Binary string → Uint8Array. */
export function mimeBytesOf(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/** Text from bytes in `charset` (Workers' TextDecoder knows UTF-8 for sure; latin1-like ones are done here). */
export function decodeText(bytes, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  if (/^(us-)?ascii$|^iso-8859-1$|^latin-?1$|^l1$|^windows-1252$|^cp1252$/.test(cs) && cs !== 'utf-8') {
    // windows-1252 differs from latin1 only in 0x80–0x9F: the common ones are mapped
    const W = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };
    let out = '';
    for (const b of bytes) out += W[b] && cs.endsWith('1252') ? W[b] : String.fromCharCode(b);
    return out;
  }
  try { return new TextDecoder(cs).decode(bytes); } catch { /* an encoding this runtime doesn't have */ }
  return new TextDecoder('utf-8').decode(bytes);
}

/** A header's raw bytes as text: UTF-8 when it is valid UTF-8 (8-bit headers), else latin1. */
function mimeHeaderText(raw) {
  if (!/[\u0080-ÿ]/.test(raw)) return raw;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(mimeBytesOf(raw)); } catch { return raw; }
}

const MIME_B64_JUNK = /[^A-Za-z0-9+/]/g;
/** Base64 (lenient: anything else is skipped) → bytes. */
export function fromBase64(s) {
  const t = String(s).replace(MIME_B64_JUNK, '');
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let n = 0, acc = 0, bits = 0;
  for (const ch of t) {
    const v = ch === '+' ? 62 : ch === '/' ? 63 : ch <= '9' ? ch.charCodeAt(0) + 4 : ch <= 'Z' ? ch.charCodeAt(0) - 65 : ch.charCodeAt(0) - 71;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, n);
}
/** Quoted-printable (mimeBinary string in) → bytes. */
export function fromQuotedPrintable(s) {
  const t = String(s).replace(/=\r?\n/g, '');
  const out = new Uint8Array(t.length);
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out[n++] = parseInt(t.slice(i + 1, i + 3), 16); i += 2; }
    else out[n++] = t.charCodeAt(i) & 255;
  }
  return out.subarray(0, n);
}

/** RFC 2047 encoded words (=?utf-8?B?…?= / =?iso-8859-1?Q?…?=) in a header, decoded; whitespace between two of them dropped. */
export function decodeWords(value) {
  const s = mimeHeaderText(String(value || ''));
  return s.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)(\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=))?/g, (_, w) => {
    const m = /^=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=$/.exec(w);
    if (!m) return w;
    const bytes = m[2].toUpperCase() === 'B' ? fromBase64(m[3]) : fromQuotedPrintable(m[3].replace(/_/g, ' '));
    return decodeText(bytes, m[1]);
  });
}

/** Header lines (mimeBinary string) → [{ name, value (raw, unfolded) }]. */
export function parseHeaders(text) {
  const out = [];
  for (const line of String(text).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0 || /\s/.test(line.slice(0, i))) continue;
    out.push({ name: line.slice(0, i), value: line.slice(i + 1).trim() });
  }
  return out;
}
const headerOf = (headers, name) => { const n = name.toLowerCase(); const h = headers.find((x) => x.name.toLowerCase() === n); return h ? h.value : ''; };

/** "text/plain; charset=utf-8; name*=UTF-8''r%C3%A9sum%C3%A9.pdf" → { type, params } (RFC 2231 continuations and charsets too). */
export function parseParams(value) {
  const s = String(value || '');
  const semi = s.indexOf(';');
  const type = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
  const params = {};
  const parts = {};
  const re = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let m;
  while ((m = re.exec(s))) {
    let [, key, val] = m;
    key = key.toLowerCase();
    val = val.trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const c = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (c) (parts[c[1]] ||= []).push({ n: Number(c[2] || 0), val, enc: Boolean(c[3]) || (!c[2] && key.endsWith('*')) });
    else params[key] = val;
  }
  for (const [key, list] of Object.entries(parts)) {
    list.sort((a, b) => a.n - b.n);
    let charset = 'utf-8';
    let raw = '';
    list.forEach((p, i) => {
      let v = p.val;
      if (p.enc && i === 0) { const q = /^([^']*)'[^']*'(.*)$/.exec(v); if (q) { charset = q[1] || charset; v = q[2]; } }
      raw += p.enc ? v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : v;
    });
    params[key] = decodeText(mimeBytesOf(raw), charset);
  }
  return { type, params };
}

/**
 * A message (Uint8Array or mimeBinary string) → a tree: { headers, type, params, disposition, encoding, filename,
 * body (Uint8Array, decoded), parts }. Multipart children are parsed too (MAX_DEPTH, MAX_PARTS).
 */
export function parseMessage(input, depth = 0, count = { n: 0 }) {
  const s = typeof input === 'string' ? input : mimeBinary(input);
  const m = /\r?\n\r?\n/.exec(s);
  const headText = m ? s.slice(0, m.index) : s;
  const bodyText = m ? s.slice(m.index + m[0].length) : '';
  const headers = parseHeaders(headText);
  const ct = parseParams(headerOf(headers, 'content-type') || 'text/plain; charset=us-ascii');
  const cd = parseParams(headerOf(headers, 'content-disposition'));
  const encoding = headerOf(headers, 'content-transfer-encoding').trim().toLowerCase();
  const filename = decodeWords(cd.params.filename || ct.params.name || '');
  const node = { headers, type: ct.type || 'text/plain', params: ct.params, disposition: cd.type || '', encoding, filename, body: new Uint8Array(0), parts: [] };
  count.n++;
  if (node.type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    const b = `--${ct.params.boundary}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // the epilogue after the closing "--boundary--" is cut off first; pieces[0] is the preamble
    const close = bodyText.search(new RegExp(`(?:^|\\r?\\n)${b}--`));
    const inner = close >= 0 ? bodyText.slice(0, close) : bodyText;
    const pieces = inner.split(new RegExp(`(?:^|\\r?\\n)${b}[ \\t]*(?:\\r?\\n|$)`));
    for (const piece of pieces.slice(1)) {
      if (count.n >= MAX_PARTS) break;
      if (!piece.trim()) continue;
      node.parts.push(parseMessage(piece, depth + 1, count));
    }
    return node;
  }
  node.body = encoding === 'base64' ? fromBase64(bodyText) : encoding === 'quoted-printable' ? fromQuotedPrintable(bodyText) : mimeBytesOf(bodyText);
  return node;
}

const isText = (n) => (n.type === 'text/plain' || n.type === 'text/html') && !n.filename && n.disposition !== 'attachment';

/** The text of a message: the first text/plain, else the HTML without its tags (for a list's snippet). */
export function snippetOf(node, max = 200) {
  let plain = null, html = null;
  const walk = (n) => { if (plain) return; if (isText(n)) { if (n.type === 'text/plain') plain = n; else if (!html) html = n; } for (const p of n.parts) walk(p); };
  walk(node);
  const pick = plain || html;
  if (!pick) return '';
  let t = decodeText(pick.body, pick.params.charset);
  if (pick === html) t = t.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The part at `path` ("2.1": the second part's first part; "" the message itself), or null. */
export function partAt(node, path) {
  let n = node;
  for (const i of String(path || '').split('.').filter(Boolean)) {
    n = n && n.parts[Number(i) - 1];
    if (!n) return null;
  }
  return n;
}

const mimeB64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
/** "2.1" ↔ an attachment id Gmail's checks accept ([0-9A-Za-z_-]). */
export const attachmentIdOf = (path) => `p${String(path).replace(/\./g, '_')}`;
export const pathOfAttachmentId = (id) => (String(id) === 'p0' ? '' : /^p[0-9_]+$/.test(String(id)) ? String(id).slice(1).replace(/_/g, '.') : null);

/** Headers in Gmail's form: decoded text ({ name, value }). */
export const gmailHeaders = (headers) => headers.map((h) => ({ name: h.name, value: decodeWords(h.value) }));

/**
 * The tree in Gmail's `payload` form (format=full): text parts carry their bytes (`body.data`, base64url),
 * everything else an attachment id, fetched when wanted (mail-imap.js).
 */
export function gmailPayload(node, path = '') {
  const out = {
    partId: path,
    mimeType: node.type,
    filename: node.filename || '',
    headers: gmailHeaders(node.headers),
    body: { size: node.body.length },
  };
  if (node.parts.length) out.parts = node.parts.map((p, i) => gmailPayload(p, path ? `${path}.${i + 1}` : String(i + 1)));
  else if (isText(node) && node.body.length <= 4 * 1024 * 1024) out.body.data = mimeB64url(node.body);
  else if (node.body.length) out.body.attachmentId = attachmentIdOf(path || '0');
  return out;
}
export { mimeB64url, headerOf };
