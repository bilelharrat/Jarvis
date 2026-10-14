// Click an element to send it: the app side's pure parts (app/features/element-pick.js uses
// them; node --test loads this file on its own: tests/web/code-pick.test.mjs).
// - pickable(url, userFile): whether a tab's page may be picked from: an address on this
//   Mac (localhost, 127.x, ::1, *.localhost, as features/code-verify.js has it: the session's
//   own dev server), or a file the owner opened in the address bar themselves (the tab's
//   userFile, audit S29). Never a site on the internet, nor a file a page went to by itself.
// - cropRect(box, zoom, bounds): where the element's picture is cut out of the tab.
'use strict';

const PAD = 8; // CSS pixels around the element in its picture
const NOT_HERE = 'Pick works on your dev server’s page (an address on this Mac) or a file you opened yourself. Open it in the browser first.';

function isLocal(url) {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch { return false; }
}

function pickable(url, userFile = '') {
  const u = String(url || '');
  if (isLocal(u)) return true;
  return /^file:\/\//i.test(u) && Boolean(userFile) && userFile === u;
}

// The element's picture in the tab's pixels: its box (CSS pixels in the page's view) with a
// margin, zoomed, and kept inside the tab.
function cropRect(box, zoom = 1, bounds = { width: 0, height: 0 }, pad = PAD) {
  const [bx, by, bw, bh] = (box || [0, 0, 0, 0]).map((v) => Number(v) || 0);
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  const maxW = Math.max(1, Math.floor(bounds.width || 1));
  const maxH = Math.max(1, Math.floor(bounds.height || 1));
  const x = Math.min(Math.max(0, Math.floor((bx - pad) * z)), maxW - 1);
  const y = Math.min(Math.max(0, Math.floor((by - pad) * z)), maxH - 1);
  const width = Math.max(1, Math.min(maxW - x, Math.ceil((bw + pad * 2) * z)));
  const height = Math.max(1, Math.min(maxH - y, Math.ceil((bh + pad * 2) * z)));
  return { x, y, width, height };
}

module.exports = { isLocal, pickable, cropRect, PAD, NOT_HERE };
