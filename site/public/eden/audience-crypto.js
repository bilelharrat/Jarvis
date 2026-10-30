// Sealing what the audience room carries (Eden Slides live polls, Q&A, follow-along). On askeden.com the link has a key
// after the # (`k=`), and every poll, question and slide is sealed with it (AES-256-GCM, a fresh IV each time, the
// kind bound as additional data), so the server only counts. On the Mac's own Wi-Fi room the page is plain http,
// where browsers have no WebCrypto, and the Mac is the presenter's own: there is no key and bodies are plain JSON.

export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const b64u = (bytes) => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const aad = (kind) => new TextEncoder().encode(`eden-audience-v1:${kind}`);
const keys = new Map();
async function cryptoKey(keyText, subtle) {
  if (!keys.has(keyText)) keys.set(keyText, subtle.importKey('raw', unb64u(keyText), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return keys.get(keyText);
}
export const newKey = () => b64u(globalThis.crypto.getRandomValues(new Uint8Array(32)));

/** `value` as the room's body string: sealed with `keyText` when there is one, else plain JSON. */
export async function sealBody(value, keyText, kind, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  const text = JSON.stringify(value);
  if (!keyText) return text;
  if (!subtle) throw new Error('This browser can’t seal.');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kind) }, await cryptoKey(keyText, subtle), new TextEncoder().encode(text));
  return JSON.stringify({ v: 1, iv: b64u(iv), ct: b64u(ct) });
}
/** A body back to its value (null when it can't be read: a wrong key, a tampered body, the wrong kind). */
export async function openBody(body, keyText, kind, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  let env;
  try { env = JSON.parse(body); } catch { return null; }
  const sealed = env && typeof env === 'object' && env.v === 1 && typeof env.iv === 'string' && typeof env.ct === 'string';
  if (!sealed) return keyText ? null : env; // with a key, only sealed bodies count
  if (!keyText || !subtle) return null;
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv), additionalData: aad(kind) }, await cryptoKey(keyText, subtle), unb64u(env.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

/** The audience link: /a/<id>#k=<key> (&follow for the read-only view). */
export function audienceLink(origin, id, key = '', { follow = false } = {}) {
  const h = [key ? `k=${key}` : '', follow ? 'follow' : ''].filter(Boolean).join('&');
  return `${String(origin).replace(/\/+$/, '')}/a/${id}${h ? `#${h}` : ''}`;
}
export function readAudienceHash(hash) {
  const out = { key: '', follow: false };
  for (const part of String(hash || '').replace(/^#/, '').split('&')) {
    if (part === 'follow') out.follow = true;
    else if (part.startsWith('k=') && KEY_RE.test(part.slice(2))) out.key = part.slice(2);
  }
  return out;
}
