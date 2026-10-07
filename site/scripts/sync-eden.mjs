// Brings Eden (the askeden repo's web/chat website, github.com/bilelharrat/askeden, which also
// holds a copy of the Model Router) into this Worker, for askeden.com/:
//
//   1. copies web/chat into public/eden/ (that folder is replaced each time; never edit it by
//      hand) and adds two lines to its index.html: the hosted additions (web/hosted.js, copied
//      in beside it) and noindex;
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
//   4. writes src/eden/manifest.js: the files the Worker may serve at the root, and where they
//      came from;
//   5. copies web/help (the FAQ, its pictures, the public Help page) into public/help/, served at
//      askeden.com/help signed out too, and bundles web/help/help-core.js with the FAQ and its
//      search index (built here, once) as src/eden/vendor/help.js, for Ask Help (src/eden/help.js).
//
// Re-run it whenever web/chat or the router changes (it's quick and idempotent):
//
//   node scripts/sync-eden.mjs [--eden <path>]      (default: ~/askeden, or $EDEN_HOME; --model-router and
//                                                   $MODEL_ROUTER_HOME still work as older names)
//   node scripts/sync-eden.mjs --check              (exit 1 if public/eden is out of date)

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const MANIFEST = path.join(SITE, 'src', 'eden', 'manifest.js');
const HOSTED = path.join(SITE, 'web');
const HELP_OUT = path.join(SITE, 'public', 'help');
const HELP_VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'help.js');

// What the page may be made of. Anything else in web/chat is left out (and named).
const TYPES = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff2', '.woff', '.json', '.txt']);
// Root paths the Worker already answers: an Eden file may never take one.
const RESERVED = new Set(['download', 'latest.json', 'jarvis', 'messenger', 'api', 'artifact', 'signin', 'eden', 'help', 'favicon.ico', 'robots.txt']);
// Lines added to the copy's index.html, just before </head>.
const ADDED_HEAD = '<meta name="robots" content="noindex, nofollow">\n<script type="module" src="hosted.js"></script>\n';

function args(argv) {
  // Eden moved out of the Model Router folder into its own repo (askeden) on 2026-10-06.
  const out = { router: process.env.EDEN_HOME || process.env.MODEL_ROUTER_HOME || path.join(os.homedir(), 'askeden'), check: false };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--eden' || argv[i] === '--model-router') && argv[i + 1]) out.router = path.resolve(argv[++i]);
    else if (argv[i] === '--check') out.check = true;
    else throw new Error(`usage: sync-eden.mjs [--eden <path>] [--check]  (unexpected ${argv[i]})`);
  }
  return out;
}

/** web/chat's files (top level only: the site is flat), as { name, bytes }. */
function pageFiles(webChat) {
  if (!fs.existsSync(path.join(webChat, 'index.html'))) throw new Error(`No Eden website at ${webChat} (index.html missing).`);
  const files = [];
  const skipped = [];
  for (const entry of fs.readdirSync(webChat, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (!entry.isFile() || !TYPES.has(path.extname(name).toLowerCase()) || !/^[\w.-]+$/.test(name)) {
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
function helpFiles(router) {
  const root = path.join(router, 'web', 'help');
  if (!fs.existsSync(path.join(root, 'faq.json'))) throw new Error(`No Help at ${root} (faq.json missing).`);
  const files = [];
  for (const dir of ['', 'img']) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'package.json' || !TYPES.has(path.extname(entry.name).toLowerCase()) || !/^[\w.-]+$/.test(entry.name)) continue;
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
  const { buildIndex } = await import(pathToFileURL(core).href);
  const esbuild = createRequire(path.join(router, 'package.json'))('esbuild');
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export * from './web/help/help-core.js';",
        `export const FAQ = ${JSON.stringify(faq)};`,
        `export const INDEX = ${JSON.stringify(buildIndex(faq))};`,
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

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);

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

  const help = helpFiles(opts.router);

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

  // The page: written to a fresh folder, then swapped in, so a failure leaves the old copy whole.
  const fresh = `${OUT}.new`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.mkdirSync(fresh, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(fresh, f.name), f.bytes);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.renameSync(fresh, OUT);

  // Help: the same swap, with its img/ folder
  const freshHelp = `${HELP_OUT}.new`;
  fs.rmSync(freshHelp, { recursive: true, force: true });
  fs.mkdirSync(path.join(freshHelp, 'img'), { recursive: true });
  for (const f of help) fs.writeFileSync(path.join(freshHelp, f.name), f.bytes);
  fs.rmSync(HELP_OUT, { recursive: true, force: true });
  fs.renameSync(freshHelp, HELP_OUT);

  const source = gitDescribe(opts.router);
  const code = await bundleRouter(opts.router);
  const pkg = JSON.parse(fs.readFileSync(path.join(opts.router, 'package.json'), 'utf8'));
  const header = `// model-router ${pkg.version} (${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}), bundled ${new Date().toISOString().slice(0, 10)} from src/browser.ts by site/scripts/sync-eden.mjs. Generated: edit the askeden repo (router changes come from Model-Router), not this file.\n`;
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  fs.writeFileSync(VENDOR, header + code);
  const google = await bundleGoogle(opts.router);
  const googleHeader = `// Eden's Gmail and Google Calendar core (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: src/chat/gmail.ts, gcal.ts), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;
  fs.writeFileSync(GOOGLE_VENDOR, googleHeader + google);
  const providers = await bundleGoogle(opts.router, PROVIDER_EXPORTS);
  const providersHeader = `// Eden's provider streaming (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: src/chat/stream.ts, sse.ts, provider-info.ts, calibrate/providers.ts), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;
  fs.writeFileSync(PROVIDERS_VENDOR, providersHeader + providers);

  const manifest = {
    files: files.map((f) => f.name),
    hashes: Object.fromEntries(files.map((f) => [f.name, sha(f.bytes)])),
    source: { repo: 'askeden', commit: source.commit, dirty: source.dirty, synced: new Date().toISOString() },
  };
  fs.writeFileSync(
    MANIFEST,
    '// Generated by scripts/sync-eden.mjs: the Eden files in public/eden, served at the root of askeden.com.\n' +
      `export const EDEN_FILES = ${JSON.stringify(manifest.files)};\n` +
      `export const EDEN_HASHES = ${JSON.stringify(manifest.hashes)};\n` +
      `export const EDEN_SOURCE = ${JSON.stringify(manifest.source)};\n`,
  );

  const helpCode = await bundleHelp(opts.router, help);
  const helpHeader = `// Eden's Help core and FAQ (askeden ${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}: web/help/help-core.js, faq.json, the search index built from it), bundled ${new Date().toISOString().slice(0, 10)} by site/scripts/sync-eden.mjs. Generated: edit the askeden repo, not this file.\n`;
  fs.writeFileSync(HELP_VENDOR, helpHeader + helpCode);

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`public/eden: ${files.length} files (${kb(files.reduce((n, f) => n + f.bytes.length, 0))}) from ${webChat}${source.commit ? ` @ ${source.commit}${source.dirty ? '+' : ''}` : ''}`);
  if (skipped.length) console.log(`  left out: ${skipped.join(', ')}`);
  console.log(`src/eden/vendor/model-router.js: ${kb(Buffer.byteLength(header + code))}`);
  console.log(`src/eden/vendor/google.js: ${kb(Buffer.byteLength(googleHeader + google))}`);
  console.log(`src/eden/vendor/providers.js: ${kb(Buffer.byteLength(providersHeader + providers))}`);
  console.log(`public/help: ${help.length} files (${kb(help.reduce((n, f) => n + f.bytes.length, 0))}); src/eden/vendor/help.js: ${kb(Buffer.byteLength(helpHeader + helpCode))}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
