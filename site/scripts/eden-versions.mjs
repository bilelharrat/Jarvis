// The Eden copy's versioned addresses (askeden opt1-ae-web), used by sync-eden.mjs. Kept apart so tests
// can run it on a few files (test/eden-versions.test.js).
import crypto from 'node:crypto';
import { buildOf } from '../src/eden/build-stamp.js';

export const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// A year in the browser's cache, one request on a warm load:
//
// The copy's two pages (index.html, edu.html) name each script and stylesheet with its content hash
// (`app.js?v=<EDEN_HASHES>`), and an import map gives every module the same versioned address
// (`/mail.js` → `/mail.js?v=…`, for static and dynamic imports alike), so the Worker can send them
// `immutable` for a year (eden/pages.js) and a warm load revalidates only the page. A changed file has a
// new address in the new page at once. The import map is an inline script: its sha256 goes into the
// pages' CSP (EDEN_SCRIPT_HASHES). No `modulepreload` hints: measured (opt1-ae-web, a 4G phone profile),
// preloading the ~100 first-load modules let them crowd out the stylesheets: first paint 0.43 s → 1.0 s
// for 0.05 s off DOMContentLoaded.
// web/chat itself (the Mac's server: ETags) never changes; this is the copy only.
const VERSIONED_PAGES = ['index.html', 'edu.html'];
const MODULE = /\.(m?js)$/;

/**
 * index.html and edu.html with versioned addresses and an import map (changes those files' bytes in
 * `files`); returns the import map's CSP hash ('sha256-…'), or none when there's no page to version.
 */
export function versionPages(files) {
  const byName = new Map(files.map((f) => [f.name, f]));
  const hashOf = (name) => sha(byName.get(name).bytes);
  const pages = VERSIONED_PAGES.filter((n) => byName.has(n));
  // Each page's entry scripts. One that another module also imports (artifact.js: import('./deck.js'))
  // keeps its plain address everywhere: were the import map ever not applied, a versioned <script> and a
  // plain import would be two copies of one module.
  const entriesOf = (html) => [...html.matchAll(/<script\b[^>]*\btype=["']?module["']?[^>]*\bsrc=["']?([\w.-]+)["']?[^>]*><\/script>/gi)].map((m) => m[1]).filter((n) => byName.has(n));
  const sources = files.filter((f) => MODULE.test(f.name)).map((f) => [f.name, f.bytes.toString('utf8')]);
  const importedElsewhere = (name) => {
    const re = new RegExp(`["'\`](?:\\./|/)?${name.replace(/[.]/g, '\\.')}["'\`]`);
    return sources.some(([n, text]) => n !== name && re.test(text));
  };
  const plain = new Set();
  for (const p of pages) for (const e of entriesOf(byName.get(p).bytes.toString('utf8'))) if (importedElsewhere(e)) plain.add(e);
  const versioned = (name) => byName.has(name) && !plain.has(name) && name !== 'index.html';
  const imports = Object.fromEntries(files.filter((f) => MODULE.test(f.name) && versioned(f.name)).map((f) => [`/${f.name}`, `/${f.name}?v=${hashOf(f.name)}`]));
  const importMap = JSON.stringify({ imports });
  const cspHash = `'sha256-${crypto.createHash('sha256').update(importMap).digest('base64')}'`;
  for (const p of pages) {
    let html = byName.get(p).bytes.toString('utf8');
    if (/<script\b[^>]*type=["']?importmap/i.test(html)) throw new Error(`web/chat/${p} has its own import map: the sync's versioned addresses would need merging into it.`);
    html = html
      .replace(/(<script\b[^>]*\bsrc=)(["']?)([\w.-]+)\2/gi, (m, a, q, n) => (versioned(n) && MODULE.test(n) ? `${a}"${n}?v=${hashOf(n)}"` : m))
      .replace(/(<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=)(["']?)([\w.-]+\.css)\2/gi, (m, a, q, n) => (versioned(n) ? `${a}"${n}?v=${hashOf(n)}"` : m));
    const mapTag = `<script type="importmap">${importMap}</script>\n`;
    const charset = /<meta\s+charset=[^>]*>\s*/i.exec(html);
    const at = charset ? charset.index + charset[0].length : html.search(/<head[^>]*>/i) + /<head[^>]*>/i.exec(html)[0].length;
    html = html.slice(0, at) + mapTag + html.slice(at);
    byName.get(p).bytes = Buffer.from(html);
  }
  return pages.length ? [cspHash] : [];
}

/**
 * The build stamp the Worker answers at GET /api/chat/build (EDEN_BUILD, eden/build.js), written into each
 * versioned page as <meta name="eden-build" content="…">, so page-update compares the server's stamp with the
 * build the page was made from, not with its first look (askeden AW2-1). Computed over every file's hash with
 * the pages as versioned (they name every module's hash) and before the meta goes in. Run after versionPages;
 * changes those pages' bytes in `files`; returns the stamp.
 */
export function stampPages(files) {
  const build = buildOf(Object.fromEntries(files.map((f) => [f.name, sha(f.bytes)])));
  for (const f of files) {
    if (!VERSIONED_PAGES.includes(f.name)) continue;
    let html = f.bytes.toString('utf8');
    if (/<meta\s+name=["']?eden-build/i.test(html)) throw new Error(`web/chat/${f.name} has its own eden-build meta.`);
    const tag = `<meta name="eden-build" content="${build}">\n`;
    const map = /<script type="importmap">[^<]*<\/script>\n?/.exec(html);
    const charset = /<meta\s+charset=[^>]*>\s*/i.exec(html);
    const at = map ? map.index + map[0].length : charset ? charset.index + charset[0].length : html.search(/<head[^>]*>/i) + /<head[^>]*>/i.exec(html)[0].length;
    html = html.slice(0, at) + tag + html.slice(at);
    f.bytes = Buffer.from(html);
  }
  return build;
}

/**
 * Hand edits a sync would lose (askeden AW2-2: a change made in public/eden, not in web/chat, is reverted by the
 * next sync, and with versioned caching an edit after a sync is served `immutable` under the old hash): the
 * files in `dir` whose bytes no longer match the last sync's hash (`hashes`, EDEN_HASHES) and that the new copy
 * (`files`) would change. → [{ name, lines }]: up to five lines of the edited file the new one doesn't have.
 */
export function handEdits(dir, hashes, files, { fs }) {
  const out = [];
  for (const f of files) {
    const at = `${dir}/${f.name}`;
    if (!hashes || !hashes[f.name] || !fs.existsSync(at)) continue;
    const now = fs.readFileSync(at);
    if (sha(now) === hashes[f.name] || now.equals(f.bytes)) continue;
    const fresh = new Set(f.bytes.toString('utf8').split('\n'));
    const lines = now.toString('utf8').split('\n').filter((l) => l.trim() && !fresh.has(l)).slice(0, 5);
    out.push({ name: f.name, lines });
  }
  return out;
}
