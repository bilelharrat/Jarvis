// The build stamp's arithmetic, without the manifest (eden/build.js imports it for the Worker; the sync's
// scripts/eden-versions.mjs for the pages' <meta name="eden-build">, so both compute the same value).

/** FNV-1a (64 bits, as two 32-bit halves) of the text: 16 hex characters. */
export function stampOf(text) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (a >>> 7), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** The build stamp of these file hashes ({ name: hash }): the same set, the same stamp, in any order. */
export function buildOf(hashes) {
  return stampOf(Object.keys(hashes || {}).sort().map((n) => `${n}\u0000${hashes[n]}`).join('\n'));
}
