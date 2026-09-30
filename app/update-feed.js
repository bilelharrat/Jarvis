// The update feed of the app people download: a static release.json (Squirrel.Mac's JSON
// format) next to the update's zip, both published by the owner. This reads it, decides
// whether it's newer than the running app, and writes it for the dist build. Pure: no
// network, no Electron (app/features/updates.js does those).
//
//   { "currentRelease": "0.2.0",
//     "releases": [{ "version": "0.2.0",
//                    "updateTo": { "version": "0.2.0", "name": "J.A.R.V.I.S. 0.2.0",
//                                  "pub_date": "2026-10-01T12:00:00Z", "notes": "…",
//                                  "url": "https://…/J.A.R.V.I.S.-0.2.0-mac.zip" } }] }
'use strict';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const MAX_NOTES = 2000;
const MAX_FEED = 256 * 1024; // bytes of JSON: a feed, not a download

function parseVersion(text) {
  const m = VERSION.exec(String(text || '').trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

// -1, 0 or 1, as semver orders them (0.10.0 after 0.9.9; 1.0.0-beta.2 before 1.0.0).
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i += 1) if (x.parts[i] !== y.parts[i]) return x.parts[i] < y.parts[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// The feed's address as baked into the app: https only (the update itself is checked by its
// signature, but the feed decides what's offered), else '' (updates off).
function cleanFeedUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

// The release the feed offers: {version, name, notes, pubDate, url}. Throws, in words to
// show, when the feed isn't one.
function parseFeed(text, feedUrl) {
  if (typeof text !== 'string' || text.length > MAX_FEED) throw new Error("the update feed isn't a feed");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("the update feed isn't valid JSON"); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.releases)) throw new Error('the update feed has no releases');
  const current = String(data.currentRelease || '');
  if (!parseVersion(current)) throw new Error("the update feed doesn't name its current release");
  const entry = data.releases.find((r) => r && typeof r === 'object' && String(r.version || '') === current);
  const to = entry && entry.updateTo && typeof entry.updateTo === 'object' ? entry.updateTo : null;
  if (!to || String(to.version || '') !== current) throw new Error("the update feed's current release is missing");
  let url = '';
  try { url = new URL(String(to.url || ''), feedUrl || undefined).toString(); } catch { url = ''; }
  if (!url.startsWith('https://')) throw new Error("the update's address isn't https");
  return {
    version: current,
    name: String(to.name || `J.A.R.V.I.S. ${current}`).slice(0, 80),
    notes: String(to.notes || '').slice(0, MAX_NOTES),
    pubDate: String(to.pub_date || '').slice(0, 40),
    url,
  };
}

// The release when it's newer than the running app, else null.
function newerRelease(release, running) {
  if (!release || !parseVersion(running)) return null;
  return compareVersions(release.version, running) > 0 ? release : null;
}

// release.json for the dist build: the zip's address is the feed's own folder plus its name.
function releaseFeed({ version, zipName, feedUrl, notes = '', date = new Date() }) {
  if (!parseVersion(version)) throw new Error(`package.json's version ${version} isn't x.y.z`);
  const base = cleanFeedUrl(feedUrl);
  if (!base) throw new Error(`the update feed's address must be https (JARVIS_UPDATE_URL is ${JSON.stringify(String(feedUrl || ''))})`);
  const url = new URL(encodeURIComponent(zipName), base).toString();
  return {
    currentRelease: version,
    releases: [{
      version,
      updateTo: { version, name: `J.A.R.V.I.S. ${version}`, pub_date: date.toISOString(), notes: String(notes).slice(0, MAX_NOTES), url },
    }],
  };
}

module.exports = { compareVersions, parseVersion, cleanFeedUrl, parseFeed, newerRelease, releaseFeed, MAX_FEED };
