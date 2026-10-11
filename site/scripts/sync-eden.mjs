// Brings Eden (the askeden repo's web/chat website, github.com/bilelharrat/askeden, which also
// holds a copy of the Model Router) into this Worker, for askeden.com/:
//
//   1. copies web/chat into public/eden/ (that folder is replaced each time; never edit it by
//      hand) and adds two lines to its index.html: the hosted additions (web/hosted.js, copied
//      in beside it) and noindex; then index.html and edu.html name every script and stylesheet by its
//      content hash, with an import map for the modules (eden-versions.mjs: a year in the browser's
//      cache on askeden.com, eden/pages.js);
//   2. bundles the Model Router's browser router (src/browser.ts, the same entry as its
//      scripts/build-browser.js) as an ES module for the Worker: src/eden/vendor/model-router.js.
//      It's built straight from the router's TypeScript with the router repo's own esbuild,
//      so the router's dist/ is neither read nor written;
//   3. bundles Eden's Gmail and Google Calendar core (src/chat/gmail.ts and gcal.ts: written
//      to run in a Worker, only fetch and Web Crypto) as src/eden/vendor/google.js, for hosted
//      Gmail and Calendar (src/eden/google-data.js);
//   3b. bundles Eden's provider streaming (src/chat/stream.ts with sse.ts, the router's prices in
//      calibrate/providers.ts, and provider-info.ts: fetch only, no Node APIs) as
//      src/eden/vendor/providers.js, so askeden.com builds and parses the Anthropic, OpenAI,
//      Gemini and Moonshot streams with the Mac's own code (src/eden/providers.js);
//   3c. bundles Eden's two fact checks (ROADMAP N19: src/verify/presupposition.ts, the assumption check
//      before an answer, and falsification.ts, the web check after one) with the risk class (risk.ts) and
//      the labels under replies (labels.ts): runtime-neutral, the model calls injected; as
//      src/eden/vendor/verify.js, for src/eden/checks.js;
//   4. writes src/eden/manifest.js: the files the Worker may serve at the root, and where they
//      came from;
//   5. copies web/help (the FAQ, its pictures, the public Help page) into public/help/, served at
//      askeden.com/help signed out too, and bundles web/help/help-core.js with the FAQ and its
//      search index (built here, once) as src/eden/vendor/help.js, for Ask Help (src/eden/help.js);
//      with web/help/faq.fr.json, the French FAQ and its index too (FAQ_FR, INDEX_FR; null without it).
//
// Re-run it whenever web/chat or the router changes (it's quick and idempotent):
//
//   node scripts/sync-eden.mjs [--eden <path>]      (default: ~/askeden, or $EDEN_HOME; --model-router and
//                                                   $MODEL_ROUTER_HOME still work as older names)
//   node scripts/sync-eden.mjs --check              (exit 1 if public/eden is out of date)
//
// public/eden is never edited by hand: a sync refuses to run over a file changed there since the last sync
// (its hash isn't the manifest's) that the new copy would change, naming it, so the change is ported to
// web/chat first (askeden AW2-2). Then: --ported <name,…> (the change is in web/chat now), or --force (drop it).
// public/help the same way (its files named help/<name>, hashes in EDEN_HELP_HASHES: askeden AW3-3).
//
// All or nothing (askeden AW3-2): everything is built first (the bundles, the manifest), then written beside its
// target (public/eden.new, public/help.new, <file>.new), then swapped in together; a failure at any point leaves the
// old public/eden, public/help, vendor bundles and manifest as they were (and removes what was staged).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handEdits, sha, stampPages, versionPages } from './eden-versions.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(SITE, 'public', 'eden');
const VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'model-router.js');
const GOOGLE_VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'google.js');
// What src/eden/google-data.js uses of Eden's Gmail and Calendar core.
const GOOGLE_EXPORTS = {
  'src/chat/gmail.ts': ['GoogleError', 'createGmailApi', 'refreshAccessToken', 'revokeToken', 'runGmailAction',
    // attachments uploaded ahead (src/eden/gmail-uploads.js, src/accounts/mail-uploads.js): the same checks and limits
    'GMAIL_API', 'GMAIL_UPLOAD_API', 'MAX_ATTACHMENT_BYTES', 'MEDIA_UPLOAD_THRESHOLD', 'blockedExtension', 'googleHttpError', 'normalizeBase64', 'safeFileName'],
  'src/chat/gmail-uploads.ts': ['UPLOAD_CHUNK_BYTES', 'UPLOAD_ID', 'UPLOAD_MAX_BYTES', 'missing'],
  'src/chat/gcal.ts': ['CALENDAR_SCOPES', 'createCalendarApi', 'hasCalendarScopes', 'runCalendarAction'],
  // Google Sheets and Drive with drive.file (askeden ROADMAP Q15): the spreadsheet canvas's open, write-back and upload.
  'src/chat/sheets.ts': ['DRIVE_FILE_SCOPE', 'SHEETS_WRITES', 'createSheetsApi', 'hasSheetsScope', 'pickerToken', 'runSheetsAction'],
  // Prompt-injection guard (ROADMAP H8): the hosted turns wrap untrusted content the same way (src/eden/chat.js).
  'src/chat/provenance.ts': ['contextKind', 'createLedger'],
};
// What src/eden/providers.js uses of Eden's provider streaming (the Mac's code, unchanged).
const PROVIDERS_VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'providers.js');
const PROVIDER_EXPORTS = {
  'src/chat/stream.ts': ['buildStreamRequest', 'createStreamParser'],
  'src/chat/sse.ts': ['readSse'],
  'src/calibrate/providers.ts': ['usageCost', 'requestMaxOutputTokens', 'withMaxOutputTokens', 'redact'],
  'src/chat/provider-info.ts': ['PROVIDER_NAMES', 'computedWhere', 'hasVision'],
};
// What src/eden/checks.js uses of Eden's verification (askeden src/verify: no Node APIs, every model call injected).
const VERIFY_VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'verify.js');
const VERIFY_EXPORTS = {
  'src/verify/presupposition.ts': ['auditPresuppositions', 'hasFactualPremise', 'premiseNote', 'PREMISE_MAX_CALLS', 'PREMISE_MAX_SEARCHES'],
  'src/verify/falsification.ts': ['FALSIFY_THRESHOLD', 'FALSIFY_MAX_CALLS', 'falsifyAnswer', 'isFactualLookup', 'reanswerWithSearch'],
  'src/verify/risk.ts': ['assessRisk'],
  // the date and the changing-facts / disputed-answer rules for the hosted system prompt (chat.js freshnessNote)
  'src/verify/prompts.ts': ['changingFacts', 'disputedAnswer', 'knowledgeDate'],
  'src/verify/labels.ts': ['buildVerification', 'worthSending', 'PREMISE_CORRECTED', 'WEB_CORRECTED', 'WEB_DISAGREES'],
};
const MANIFEST = path.join(SITE, 'src', 'eden', 'manifest.js');
const HOSTED = path.join(SITE, 'web');
const HELP_OUT = path.join(SITE, 'public', 'help');
const HELP_VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'help.js');

// What the page may be made of. Anything else in web/chat is left out (and named).
const TYPES = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff2', '.woff', '.json', '.txt']);
// Of those, the folder's dev files, never part of the page (askeden AW3-9: web/chat/package.json, for its Node tests).
const NOT_WEB = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json']);
export const isWebFile = (name) => TYPES.has(path.extname(name).toLowerCase()) && /^[\w.-]+$/.test(name) && !NOT_WEB.has(name.toLowerCase()) && !/\.(test|spec)\.m?js$/i.test(name);
// Root paths the Worker already answers: an Eden file may never take one.
const RESERVED = new Set(['download', 'latest.json', 'jarvis', 'messenger', 'api', 'artifact', 'signin', 'eden', 'help', 's', 'p', 'favicon.ico', 'robots.txt']);
// Lines added to the copy's index.html, just before </head>.
const ADDED_HEAD = '<meta name="robots" content="noindex, nofollow">\n<script type="module" src="hosted.js"></script>\n';

function args(argv) {
  // Eden moved out of the Model Router folder into its own repo (askeden) on 2026-10-06.
  const out = { router: process.env.EDEN_HOME || process.env.MODEL_ROUTER_HOME || path.join(os.homedir(), 'askeden'), check: false, force: false, ported: [] };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--eden' || argv[i] === '--model-router') && argv[i + 1]) out.router = path.resolve(argv[++i]);
    else if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--ported' && argv[i + 1]) out.ported.push(...argv[++i].split(',').map((n) => n.trim()).filter(Boolean));
    else throw new Error(`usage: sync-eden.mjs [--eden <path>] [--check] [--ported <name,…>] [--force]  (unexpected ${argv[i]})`);
  }
  return out;
}

/** web/chat's files (top level only: the site is flat), as { name, bytes }. */
export function pageFiles(webChat) {
  if (!fs.existsSync(path.join(webChat, 'index.html'))) throw new Error(`No Eden website at ${webChat} (index.html missing).`);
  const files = [];
  const skipped = [];
  for (const entry of fs.readdirSync(webChat, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (!entry.isFile() || !isWebFile(name)) {
      skipped.push(name);
      continue;
    }
    if (RESERVED.has(name.toLowerCase()) || name === 'hosted.js') throw new Error(`web/chat/${name} would take a path askeden.com already uses.`);
    files.push({ name, bytes: fs.readFileSync(path.join(webChat, name)) });
  }
  return { files, skipped };
}

/** index.html with the hosted additions (the original is never changed). */
function withHostedHead(html) {
  const at = html.search(/<\/head>/i);
  if (at < 0) throw new Error('web/chat/index.html has no </head> to add the hosted script before.');
  if (/\bsrc=["']?hosted\.js/.test(html)) return html;
  return html.slice(0, at) + ADDED_HEAD + html.slice(at);
}

function gitDescribe(dir) {
  try {
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', 'web/chat', 'src'], { encoding: 'utf8' }).trim() !== '';
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

async function bundleRouter(router) {
  const entry = path.join(router, 'src', 'browser.ts');
  if (!fs.existsSync(entry)) throw new Error(`No router source at ${entry}.`);
  const esbuild = createRequire(path.join(router, 'package.json'))('esbuild');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'error',
  });
  return result.outputFiles[0].text;
}

async function bundleGoogle(router, exportsMap = GOOGLE_EXPORTS) {
  for (const file of Object.keys(exportsMap)) {
    if (!fs.existsSync(path.join(router, file))) throw new Error(`No ${file} in ${router}.`);
  }
  const esbuild = createRequire(path.join(router, 'package.json'))('esbuild');
  const result = await esbuild.build({
    stdin: {
      contents: Object.entries(exportsMap).map(([file, names]) => `export { ${names.join(', ')} } from './${file}';`).join('\n'),
      resolveDir: router,
      sourcefile: 'google-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'error',
  });
  return result.outputFiles[0].text;
}

/** web/help's files (and its img/ folder), as { name, bytes }; name is the path under /help/. */
export function helpFiles(router) {
  const root = path.join(router, 'web', 'help');
  if (!fs.existsSync(path.join(root, 'faq.json'))) throw new Error(`No Help at ${root} (faq.json missing).`);
  const files = [];
  for (const dir of ['', 'img']) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.') || !isWebFile(entry.name)) continue;
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      files.push({ name, bytes: fs.readFileSync(path.join(root, name)) });
    }
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** help-core.js with the FAQ, its index and the page's file list, as one module for the Worker. */
async function bundleHelp(router, files) {
  const core = path.join(router, 'web', 'help', 'help-core.js');
  const faq = JSON.parse(fs.readFileSync(path.join(router, 'web', 'help', 'faq.json'), 'utf8'));
  const frFile = path.join(router, 'web', 'help', 'faq.fr.json');
  const faqFr = fs.existsSync(frFile) ? JSON.parse(fs.readFileSync(frFile, 'utf8')) : null;
  const { buildIndex } = await import(pathToFileURL(core).href);
  const esbuild = createRequire(path.join(router, 'package.json'))('esbuild');
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export * from './web/help/help-core.js';",
        `export const FAQ = ${JSON.stringify(faq)};`,
        `export const INDEX = ${JSON.stringify(buildIndex(faq))};`,
        `export const FAQ_FR = ${JSON.stringify(faqFr)};`,
        `export const INDEX_FR = ${JSON.stringify(faqFr ? buildIndex(faqFr) : null)};`,
        `export const HELP_FILES = ${JSON.stringify(files.map((f) => f.name))};`,
      ].join('\n'),
      resolveDir: router,
      sourcefile: 'help-entry.js',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'error',
  });
  return result.outputFiles[0].text;
}


/** The last sync's file hashes (EDEN_HASHES in src/eden/manifest.js; EDEN_HELP_HASHES for public/help), or null before any. */
function manifestHashes(name = 'EDEN_HASHES') {
  try {
    const m = new RegExp(`^export const ${name} = (.*);$`, 'm').exec(fs.readFileSync(MANIFEST, 'utf8'));
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

/** The files under `dir` (and its img/ folder, for public/help), as names relative to it. */
function filesIn(dir, sub = []) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of ['', ...sub]) {
    if (!fs.existsSync(path.join(dir, d))) continue;
    for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) if (e.isFile() && !e.name.startsWith('.')) out.push(d ? `${d}/${e.name}` : e.name);
  }
  return out;
}

/**
 * Puts every staged path in place, all or nothing (AW3-2): `swaps` is [{ from: staged path, to: target }]; each target
 * is moved aside first (<to>.old), and if any step fails every step so far is undone. The old copies are removed at
 * the end. SYNC_EDEN_FAIL_AT=<n>, for the tests only: step n fails, as a full disk or a locked file would.
 */
export function swapIn(swaps, { fail = Number(process.env.SYNC_EDEN_FAIL_AT || 0) } = {}) {
  const done = [];
  try {
    for (const [i, { from, to }] of swaps.entries()) {
      const old = `${to}.old`;
      fs.rmSync(old, { recursive: true, force: true });
      const had = fs.existsSync(to);
      if (had) fs.renameSync(to, old);
      done.push({ from, to, old, had });
      if (fail && i + 1 === fail) throw new Error(`SYNC_EDEN_FAIL_AT=${fail}: a step failed on purpose (test)`);
      fs.renameSync(from, to);
      done[done.length - 1].moved = true;
    }
  } catch (error) {
    for (const s of done.reverse()) {
      try {
        if (s.moved) fs.renameSync(s.to, s.from);
        if (s.had) fs.renameSync(s.old, s.to);
      } catch (e) { console.error(`could not restore ${s.to} (the old copy is at ${s.old}): ${e.message}`); }
    }
    for (const { from } of swaps) fs.rmSync(from, { recursive: true, force: true });
    throw error;
  }
  for (const s of done) fs.rmSync(s.old, { recursive: true, force: true });
}

async function main() {
  const opts = args(process.argv.slice(2));
  const webChat = path.join(opts.router, 'web', 'chat');
  const { files, skipped } = pageFiles(webChat);
  for (const name of fs.readdirSync(HOSTED)) {
    if (!name.startsWith('.')) files.push({ name, bytes: fs.readFileSync(path.join(HOSTED, name)) });
  }
  const index = files.find((f) => f.name === 'index.html');
  index.bytes = Buffer.from(withHostedHead(index.bytes.toString('utf8')));
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  // versioned addresses and an import map in index.html and edu.html (eden-versions.mjs)
  const scriptHashes = versionPages(files);
  // the build stamp, in the pages and the manifest (eden-versions.mjs stampPages; eden/build.js)
  const build = stampPages(files);

  const help = helpFiles(opts.router);

  // hand edits in public/eden (AW2-2) and public/help (AW3-3) that this sync would lose: refused unless ported (or --force)
  const lastHashes = manifestHashes();
  const added = lastHashes && fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((n) => !n.startsWith('.') && !(n in lastHashes) && !files.some((f) => f.name === n)).map((name) => ({ name, lines: ['(a file added by hand)'] })) : [];
  const lastHelp = manifestHashes('EDEN_HELP_HASHES');
  const helpAdded = lastHelp ? filesIn(HELP_OUT, ['img']).filter((n) => !(n in lastHelp) && !help.some((f) => f.name === n)).map((name) => ({ name, lines: ['(a file added by hand)'] })) : [];
  const helpEdits = [...handEdits(HELP_OUT, lastHelp, help, { fs }), ...helpAdded].map((e) => ({ ...e, name: `help/${e.name}` }));
  const edits = [...handEdits(OUT, lastHashes, files, { fs }), ...added, ...helpEdits].filter((e) => !opts.ported.includes(e.name));
  if (edits.length) {
    const said = edits.map((e) => `  ${e.name}${e.lines.length ? `:\n${e.lines.map((l) => `      ${l.trim().slice(0, 160)}`).join('\n')}` : ''}`).join('\n');
    const what = `public/eden${helpEdits.length ? ' or public/help' : ''} has hand edits since the last sync that ${opts.check ? 'a sync' : 'this sync'} would lose:\n${said}\nPort them to web/chat or web/help (in ${opts.router}/web), then run again with --ported ${edits.map((e) => e.name).join(',')}; or --force to drop them.`;
    if (opts.check || !opts.force) {
      console.error(what);
      process.exit(1);
    }
    console.warn(`--force: ${what}`);
  }

  if (opts.check) {
    const staleHelp = help.filter((f) => !fs.existsSync(path.join(HELP_OUT, f.name)) || !fs.readFileSync(path.join(HELP_OUT, f.name)).equals(f.bytes));
    if (staleHelp.length) {
      console.error(`public/help is out of date: ${staleHelp.map((f) => f.name).join(', ')}. Run node scripts/sync-eden.mjs.`);
      process.exit(1);
    }
    const stale = files.filter((f) => !fs.existsSync(path.join(OUT, f.name)) || !fs.readFileSync(path.join(OUT, f.name)).equals(f.bytes));
    const extra = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((n) => !files.some((f) => f.name === n)) : [];
    if (stale.length || extra.length) {
      console.error(`public/eden is out of date: ${[...stale.map((f) => f.name), ...extra.map((n) => `${n} (gone)`)].join(', ')}. Run node scripts/sync-eden.mjs.`);
      process.exit(1);
    }
    console.log('public/eden matches web/chat.');
    return;
  }

  // Everything is built first; nothing in the tree changes until it all exists (AW3-2).
  const source = gitDescribe(opts.router);
  const code = await bundleRouter(opts.router);
  const pkg = JSON.parse(fs.readFileSync(path.join(opts.router, 'package.json'), 'utf8'));
  const header = `// model-router ${pkg.version} (${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}), bundled ${new Date().toISOString().slice(0, 10)} from src/browser.ts by site/scripts/sync-eden.mjs. Generated: edit the askeden repo (router changes come from Model-Router), not this file.\n`;
  const google = await bundleGoogle(opts.router);
  const googleHeader = `// Eden's Gmail and Google Calendar core (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: src/chat/gmail.ts, gcal.ts), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;
  const providers = await bundleGoogle(opts.router, PROVIDER_EXPORTS);
  const providersHeader = `// Eden's provider streaming (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: src/chat/stream.ts, sse.ts, provider-info.ts, calibrate/providers.ts), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;
  const verify = await bundleGoogle(opts.router, VERIFY_EXPORTS);
  const verifyHeader = `// Eden's fact checks (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: src/verify/presupposition.ts, falsification.ts, risk.ts, labels.ts), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;
  const helpCode = await bundleHelp(opts.router, help);
  const helpHeader = `// Eden's Help core and FAQ (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: web/help/help-core.js, faq.json, the search index built from it), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;

  const manifest = {
    files: files.map((f) => f.name),
    hashes: Object.fromEntries(files.map((f) => [f.name, sha(f.bytes)])),
    helpHashes: Object.fromEntries(help.map((f) => [f.name, sha(f.bytes)])),
    source: { repo: 'askeden', commit: source.commit, dirty: source.dirty, synced: new Date().toISOString() },
  };
  const manifestText =
    '// Generated by scripts/sync-eden.mjs: the Eden files in public/eden, served at the root of askeden.com.\n' +
    `export const EDEN_FILES = ${JSON.stringify(manifest.files)};\n` +
    `export const EDEN_HASHES = ${JSON.stringify(manifest.hashes)};\n` +
    `// public/help as synced (a hand edit there is refused by the next sync: AW3-3)\n` +
    `export const EDEN_HELP_HASHES = ${JSON.stringify(manifest.helpHashes)};\n` +
    `export const EDEN_SOURCE = ${JSON.stringify(manifest.source)};\n` +
    `// the build stamp: GET /api/chat/build (eden/build.js) and the pages' <meta name="eden-build">\n` +
    `export const EDEN_BUILD = ${JSON.stringify(build)};\n` +
    `// the pages' import map (versioned addresses), allowed by its hash in their CSP (eden/pages.js)\n` +
    `export const EDEN_SCRIPT_HASHES = ${JSON.stringify(scriptHashes)};\n`;

  // Staged beside their targets (the same disk, so each swap is a rename), then swapped in together.
  const swaps = [];
  try {
    const fresh = `${OUT}.new`;
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.mkdirSync(fresh, { recursive: true });
    swaps.push({ from: fresh, to: OUT });
    for (const f of files) fs.writeFileSync(path.join(fresh, f.name), f.bytes);
    const freshHelp = `${HELP_OUT}.new`;
    fs.rmSync(freshHelp, { recursive: true, force: true });
    fs.mkdirSync(path.join(freshHelp, 'img'), { recursive: true });
    swaps.push({ from: freshHelp, to: HELP_OUT });
    for (const f of help) fs.writeFileSync(path.join(freshHelp, f.name), f.bytes);
    fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
    for (const [to, text] of [[VENDOR, header + code], [GOOGLE_VENDOR, googleHeader + google], [PROVIDERS_VENDOR, providersHeader + providers], [VERIFY_VENDOR, verifyHeader + verify], [HELP_VENDOR, helpHeader + helpCode], [MANIFEST, manifestText]]) {
      swaps.push({ from: `${to}.new`, to });
      fs.writeFileSync(`${to}.new`, text);
    }
  } catch (error) {
    for (const { from } of swaps) fs.rmSync(from, { recursive: true, force: true });
    throw error;
  }
  swapIn(swaps);

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`public/eden: ${files.length} files (${kb(files.reduce((n, f) => n + f.bytes.length, 0))}) from ${webChat}${source.commit ? ` @ ${source.commit}${source.dirty ? '+' : ''}` : ''}`);
  if (skipped.length) console.log(`  left out: ${skipped.join(', ')}`);
  console.log(`src/eden/vendor/model-router.js: ${kb(Buffer.byteLength(header + code))}`);
  console.log(`src/eden/vendor/google.js: ${kb(Buffer.byteLength(googleHeader + google))}`);
  console.log(`src/eden/vendor/providers.js: ${kb(Buffer.byteLength(providersHeader + providers))}`);
  console.log(`src/eden/vendor/verify.js: ${kb(Buffer.byteLength(verifyHeader + verify))}`);
  console.log(`public/help: ${help.length} files (${kb(help.reduce((n, f) => n + f.bytes.length, 0))}); src/eden/vendor/help.js: ${kb(Buffer.byteLength(helpHeader + helpCode))}`);
}

// Run as a script (imported by the tests for pageFiles, helpFiles and swapIn only).
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
