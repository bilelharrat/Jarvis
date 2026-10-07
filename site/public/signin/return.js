// Where a sign-in goes back to: /signin?return=<path> (docs/web-auth.md "Where a sign-in ends").
// One rule for the page (signin.js) and the server (eden/session.js, eden/pages.js, which
// import this same file), so Eden Messenger's "Connect Eden" page and a deep link (#account,
// #tasks) open again after signing in, and nothing else can be named.
//
// Only a path of this site: it starts with exactly one "/" (never "//host" or "/\host", which
// browsers read as another site), has no scheme, no backslash, space or control character
// anywhere (browsers drop tabs and newlines, so "/\t/host" would become "//host"), is at most
// RETURN_MAX characters, and isn't an /api/ address: a sign-in must never end by calling one
// (the Eden app's handoff would sign this browser in to whoever made that code). Anything else
// is "/". What comes back is the path as a URL parser wrote it, so the page and the server
// agree on it, and it is still checked again wherever it's used.

export const RETURN_MAX = 1024;
const BASE = 'https://return.invalid';
// Characters never allowed, anywhere: controls, spaces (any), backslash, quotes and angle brackets.
const BAD = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff\\"'<>`]/;

/** `raw` if it's a safe place on this site to return to after signing in, else "/". */
export function safeReturn(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > RETURN_MAX) return '/';
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\' || BAD.test(raw)) return '/';
  let url;
  try {
    url = new URL(raw, BASE);
  } catch {
    return '/';
  }
  if (url.origin !== BASE || url.username || url.password) return '/';
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return '/'; // a broken %-escape
  }
  // "/%2F%2Fhost", "/%5Chost", "/%61pi/…", "/./api/…" (the parser already resolved dots).
  if (path.startsWith('//') || path.includes('\\') || BAD.test(path.replace(/ /g, '')) || /^\/api(?:\/|$)/i.test(path)) return '/';
  const out = `${url.pathname}${url.search}${url.hash}`;
  return out.length <= RETURN_MAX && out.startsWith('/') && !out.startsWith('//') ? out : '/';
}
