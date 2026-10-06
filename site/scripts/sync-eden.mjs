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
//   3. writes src/eden/manifest.js: the files the Worker may serve at the root, and where they
//      came from.
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
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(SITE, 'public', 'eden');
const VENDOR = path.join(SITE, 'src', 'eden', 'vendor', 'model-router.js');
const MANIFEST = path.join(SITE, 'src', 'eden', 'manifest.js');
const HOSTED = path.join(SITE, 'web');

// What the page may be made of. Anything else in web/chat is left out (and named).
const TYPES = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff2', '.woff', '.json', '.txt']);
// Root paths the Worker already answers: an Eden file may never take one.
const RESERVED = new Set(['download', 'latest.json', 'jarvis', 'messenger', 'api', 'artifact', 'signin', 'eden', 'favicon.ico', 'robots.txt']);
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

  if (opts.check) {
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

  const source = gitDescribe(opts.router);
  const code = await bundleRouter(opts.router);
  const pkg = JSON.parse(fs.readFileSync(path.join(opts.router, 'package.json'), 'utf8'));
  const header = `// model-router ${pkg.version} (${source.commit || 'unknown commit'}${source.dirty ? ', with uncommitted changes' : ''}), bundled ${new Date().toISOString().slice(0, 10)} from src/browser.ts by site/scripts/sync-eden.mjs. Generated: edit the askeden repo (router changes come from Model-Router), not this file.\n`;
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  fs.writeFileSync(VENDOR, header + code);

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

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`public/eden: ${files.length} files (${kb(files.reduce((n, f) => n + f.bytes.length, 0))}) from ${webChat}${source.commit ? ` @ ${source.commit}${source.dirty ? '+' : ''}` : ''}`);
  if (skipped.length) console.log(`  left out: ${skipped.join(', ')}`);
  console.log(`src/eden/vendor/model-router.js: ${kb(Buffer.byteLength(header + code))}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
