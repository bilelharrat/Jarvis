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
// - historyItems(entries, active, dir): Back's and Forward's long-press list, nearest first.
// - sourceUrl(url): view-source: for a web page; '' otherwise.
// - shotName(url, when): a screenshot's file name, as macOS names its own.
// - menuTemplate(spec, pick): the pane's ⋯ menu as Electron's Menu template, from the plain
//   list the window sends (labels it translated itself); pick(id) is told which was chosen.
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

// Back's (dir 'back') or Forward's ('forward') long-press list: the pages that way from the
// one on show, nearest first, each with its place in the tab's history (goToIndex) and the
// words to show (its title, else its address), at most max of them.
function historyItems(entries, active, dir, max = 15) {
  const list = Array.isArray(entries) ? entries : [];
  const at = Number(active);
  if (!Number.isInteger(at) || at < 0 || at >= list.length) return [];
  const out = [];
  const step = dir === 'forward' ? 1 : -1;
  for (let i = at + step; i >= 0 && i < list.length && out.length < max; i += step) {
    const e = list[i] || {};
    const title = String(e.title || '').trim();
    const url = String(e.url || '');
    const label = (title || url || 'Untitled').replace(/\s+/g, ' ');
    out.push({ index: i, label: label.length > 70 ? `${label.slice(0, 69)}…` : label, url });
  }
  return out;
}

// The page's source in a tab of its own: a web page only. Never a file on this Mac (a
// view-source: tab isn't a file: one, so browser-agent.js's rule about files the owner
// didn't open wouldn't reach it), an app's own page or a data: page.
function sourceUrl(url) {
  const u = String(url || '');
  return /^https?:\/\//i.test(u) ? `view-source:${u}` : '';
}

// "Screenshot localhost 2026-10-16 at 14.03.22.png": the site and the moment, as the Mac's own.
function shotName(url, when = new Date()) {
  let site = '';
  try { site = new URL(String(url || '')).hostname.replace(/^www\./, ''); } catch { site = ''; }
  const d = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
  const two = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const time = `${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
  const name = `Screenshot${site ? ` ${site}` : ''} ${day} at ${time}.png`;
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
}

// The ⋯ menu the window sends (code-browser.js menuSpec): { id, label, checked, enabled,
// type: 'radio' | 'checkbox' | 'separator', submenu }. Only these keys are read, labels are
// cut short, and it nests two deep at most: what comes from the page is only ever words.
function menuTemplate(spec, pick, depth = 0) {
  const out = [];
  for (const item of Array.isArray(spec) ? spec.slice(0, 40) : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'separator') { if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' }); continue; }
    const label = String(item.label || '').slice(0, 80);
    if (!label) continue;
    const row = { label, enabled: item.enabled !== false };
    if (Array.isArray(item.submenu) && depth < 1) {
      row.submenu = menuTemplate(item.submenu, pick, depth + 1);
    } else {
      const id = String(item.id || '').slice(0, 60);
      if (!id) continue;
      if (item.type === 'radio' || item.type === 'checkbox') { row.type = item.type; row.checked = Boolean(item.checked); }
      row.click = () => pick(id);
    }
    out.push(row);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

// A page on this Mac (localhost, *.localhost, 127.x, ::1): the app an Eden Code session builds.
function isLoopback(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

module.exports = { viewRect, externalUrl, isLoopback, historyItems, sourceUrl, shotName, menuTemplate, MIN_SIDE };
