'use strict';
// Builds the ad blocker's engine from the lists in adblock-lists.json: gather() fetches
// (async, on the app's thread), compile() parses (adblock.js runs it in a worker thread, so a
// rebuild never stalls the app; inline if a worker can't start).
//
// Lists come straight from their publishers, as Brave's do (Ghostery's mirror of them,
// which the engine's own fullLists point at, had last been updated three months before),
// and each is asked for with its ETag, so an unchanged list costs a 304. A list that can't
// be fetched keeps its last copy. The engine is only rebuilt when something changed.
//
// Two engines are written: engine.bin (everything) and pages.bin (only the lists marked
// blockPages: malware and scam sites, which may stop a page from opening at all).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = require('./adblock-lists.json');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);

// The engine's settings. Preprocessors on: uBlock's lists hold rules only for Firefox, only
// for phones or only for uBlock Lite behind !#if; without them every branch loaded at once.
const ENGINE_CONFIG = {
  enableCompression: true, loadExtendedSelectors: true, guessRequestTypeFromUrl: true, loadPreprocessors: true,
};

function envFor(platform) {
  return new Map(Object.entries(CONFIG.preprocessorEnv[platform] || CONFIG.preprocessorEnv.desktop));
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const write = (file, data) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); };

async function get(url, headers = {}, timeoutMs = 45000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(timer); }
}

// One source: fetched if it changed since last time, kept from last time if it can't be.
// Returns its text (or null if there has never been a copy).
async function source(dir, id, url, log) {
  const textFile = path.join(dir, `${id}.txt`);
  const metaFile = path.join(dir, `${id}.json`);
  const meta = readJson(metaFile, {});
  const have = fs.existsSync(textFile);
  const headers = {};
  if (have && meta.etag) headers['If-None-Match'] = meta.etag;
  if (have && meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
  try {
    const res = await get(url, headers);
    if (res.status === 304 && have) return fs.readFileSync(textFile, 'utf8');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 20) throw new Error('empty');
    write(textFile, text);
    write(metaFile, JSON.stringify({ etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetched: new Date().toISOString() }));
    return text;
  } catch (err) {
    log(`adblock: ${id} not fetched (${err && err.message}), ${have ? 'using the last copy' : 'none yet'}`);
    return have ? fs.readFileSync(textFile, 'utf8') : null;
  }
}

// uBlock Origin's scriptlets and redirects, as Ghostery builds them daily: its CDN names
// the latest revision, so a new one is only downloaded when there is one.
async function ghosteryResource(dir, res, log) {
  const file = path.join(dir, `${res.id}.json`);
  const metaFile = path.join(dir, `${res.id}.meta.json`);
  const meta = readJson(metaFile, {});
  try {
    const { revisions } = await (await get(`${res.base}/${res.name}/metadata.json`)).json();
    const latest = revisions[revisions.length - 1];
    if (latest === meta.revision && fs.existsSync(file)) return readJson(file, null);
    const body = await (await get(`${res.base}/${res.name}/${latest}/list.txt`)).text();
    const json = JSON.parse(body);
    if (!Array.isArray(json.scriptlets) || !Array.isArray(json.redirects)) throw new Error('not resources');
    write(file, body);
    write(metaFile, JSON.stringify({ revision: latest, fetched: new Date().toISOString() }));
    return json;
  } catch (err) {
    log(`adblock: ${res.id} resources not fetched (${err && err.message})`);
    return readJson(file, null);
  }
}

// Brave's own resources (adblock-rust's format: base64 content and a MIME type). Its
// lists call them as scriptlets (+js(fundingchoices-reject)) and as redirects (SugarCoat):
// added as JavaScript redirects, which the engine also injects when a rule names one.
function braveResources(text) {
  const out = [];
  for (const r of JSON.parse(text)) {
    if (!(r.kind && r.kind.mime === 'application/javascript') || typeof r.content !== 'string') continue; // all of Brave's are scripts
    out.push({ name: r.name, aliases: r.aliases || [], body: Buffer.from(r.content, 'base64').toString('utf8'), contentType: 'application/javascript' });
  }
  return out;
}

// Fetch what changed (async, on the caller's thread: its fetch is the app's), and work out
// whether the engine needs building. Returns a job for compile(), or null if it doesn't.
async function gather({ dir, platform = 'desktop', force = false, log = console.log } = {}) {
  const { ENGINE_VERSION } = require('@ghostery/adblocker');
  const listsDir = path.join(dir, 'lists');
  fs.mkdirSync(listsDir, { recursive: true });
  const lists = CONFIG.lists.filter((l) => (l.platforms || ['desktop']).includes(platform));
  const [texts, resources] = await Promise.all([
    Promise.all(lists.map((l) => source(listsDir, l.id, l.url, log))),
    Promise.all(CONFIG.resources.map((r) => (r.kind === 'ghostery-cdn'
      ? ghosteryResource(listsDir, r, log)
      : source(listsDir, `resources-${r.id}`, r.url, log).then((t) => (t ? { scriptlets: [], redirects: braveResources(t) } : null))))),
  ]);
  const have = lists.filter((_, i) => texts[i] !== null);
  if (!have.length) return { job: null, error: 'no lists' };

  const merged = { scriptlets: [], redirects: [] };
  const names = new Set();
  for (const r of resources) {
    if (!r) continue;
    merged.scriptlets.push(...r.scriptlets);
    for (const x of r.redirects) if (!names.has(x.name)) { names.add(x.name); merged.redirects.push(x); }
  }
  const resourcesText = JSON.stringify(merged);
  const env = envFor(platform);
  const stamp = sha([ENGINE_VERSION, platform, JSON.stringify(ENGINE_CONFIG), JSON.stringify([...env]), ...lists.map((l, i) => `${l.id}:${texts[i] === null ? '-' : sha(texts[i])}`), sha(resourcesText)].join('|'));
  const previous = readJson(path.join(dir, 'engine.json'), {});
  const missing = lists.filter((_, i) => texts[i] === null).map((l) => l.id);
  if (!force && previous.stamp === stamp && fs.existsSync(path.join(dir, 'engine.bin')) && fs.existsSync(path.join(dir, 'pages.bin'))) {
    return { job: null, lists: have.length, missing: missing.length };
  }
  write(path.join(dir, 'resources.json'), resourcesText);
  return {
    job: { dir, platform, stamp, lists: have.map((l) => ({ id: l.id, blockPages: Boolean(l.blockPages) })), missing, scriptlets: merged.scriptlets.length, redirects: merged.redirects.length },
    lists: have.length, missing: missing.length,
  };
}

// Parse the lists a job names into the two engines and write them (the CPU-heavy part:
// adblock.js runs it in a worker thread).
function compile(job) {
  const { FiltersEngine } = require('@ghostery/adblocker');
  const began = Date.now();
  const text = (id) => fs.readFileSync(path.join(job.dir, 'lists', `${id}.txt`), 'utf8');
  const env = envFor(job.platform);
  const engine = FiltersEngine.parse(job.lists.map((l) => text(l.id)).join('\n'), ENGINE_CONFIG);
  engine.updateEnv(env);
  const resourcesText = fs.readFileSync(path.join(job.dir, 'resources.json'), 'utf8');
  if (job.scriptlets || job.redirects) engine.updateResources(resourcesText, sha(resourcesText));
  const pages = FiltersEngine.parse(job.lists.filter((l) => l.blockPages).map((l) => text(l.id)).join('\n'), { ...ENGINE_CONFIG, loadCosmeticFilters: false, loadCSPFilters: false });
  pages.updateEnv(env);
  write(path.join(job.dir, 'engine.bin'), engine.serialize());
  write(path.join(job.dir, 'pages.bin'), pages.serialize());
  const ms = Date.now() - began;
  write(path.join(job.dir, 'engine.json'), JSON.stringify({ stamp: job.stamp, built: new Date().toISOString(), ms, lists: job.lists.map((l) => l.id), missing: job.missing, scriptlets: job.scriptlets, redirects: job.redirects }, null, 1));
  return { built: true, ms };
}

// Both, on this thread (for tests and tools).
async function build(opts = {}) {
  const { job, ...rest } = await gather(opts);
  return job ? { ...rest, ...compile(job) } : { ...rest, built: false };
}

module.exports = { gather, compile, build, envFor, ENGINE_CONFIG, CONFIG };

// As a worker thread: compile one job, answer, exit.
const threads = require('worker_threads');
if (!threads.isMainThread && threads.workerData && threads.workerData.adblockCompile) {
  try { threads.parentPort.postMessage(compile(threads.workerData.adblockCompile)); } catch (err) { threads.parentPort.postMessage({ built: false, error: String(err && err.message) }); }
}
