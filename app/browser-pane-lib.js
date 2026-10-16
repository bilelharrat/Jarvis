// Eden Code's Browser pane, the app side's pure parts (main.js uses them; node --test loads
// this file on its own: tests/web/code-browser.test.mjs).
// The pane (web/features/code-browser.js) is the built-in browser's own engine (main.js: its
// tabs, ad blocker, permissions, downloads and sign-ins, in Eden Code's own profile) shown in
// the workbench pane instead of Eden Secretary's dock: the page is a native view laid over
// the pane's slot, so where it goes is worked out here, in the window's content pixels.
// - viewRect(bounds, zoom, content): the slot's place (CSS pixels) as the view's bounds:
//   zoomed as the window's page is, kept inside the window's content, and null when nothing
//   of it would show (the pane mid-close, a window shrunk to nothing): the view is taken off
//   then, never left as a 0 × 0 page that still takes the agent's "is it on show".
// - externalUrl(url): the page's address for the Mac's default browser: a web page only
//   (http or https), never a file, a data: page or an app's own scheme.
'use strict';

const MIN_SIDE = 8; // CSS pixels: a slot smaller than this isn't shown

function viewRect(bounds, zoom = 1, content = null) {
  if (!bounds || typeof bounds !== 'object') return null;
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  const nums = ['x', 'y', 'width', 'height'].map((k) => Number(bounds[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let [x, y, width, height] = nums;
  if (width < MIN_SIDE || height < MIN_SIDE) return null;
  let left = Math.round(x * z);
  let top = Math.round(y * z);
  let right = Math.round((x + width) * z);
  let bottom = Math.round((y + height) * z);
  if (content && Number(content.width) > 0 && Number(content.height) > 0) {
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(Math.round(content.width), right);
    bottom = Math.min(Math.round(content.height), bottom);
  }
  if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function externalUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

module.exports = { viewRect, externalUrl, MIN_SIDE };
