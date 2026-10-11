// The canvas: html/svg/artifact blocks preview in a sandboxed iframe (POST /api/chat/artifact,
// then <iframe sandbox="allow-scripts" src=url>); any code block opens in the Code view with
// line numbers. Versions page through the same artifact across drafts; a selection in the
// code can be quoted into the composer; the divider drags (and double-clicks to 50/50).
// The Code view is an editor (canvas-model.js: language, highlighting; canvas-run.js: Run):
// a highlighted layer under a transparent textarea, line numbers, a language picker, Copy and
// Download, a console under it (stdout/stderr, exit code, time, stdin, Stop) that resizes, and
// "Ask Eden to edit" on a selection: Eden's revised file comes back as a new version. Typing
// makes a new version too (the first keystroke on a version forks it). On a phone the canvas
// is a full-screen sheet with Editor and Console tabs.
// Live previews: React (JSX/TSX) draws as a running UI (canvas-app.js, app-frame.html), HTML as
// before. Split shows the code beside the preview, redrawn as you type; the preview has phone,
// tablet and desktop widths, light and dark (React), and a console of its own whose errors
// "Fix it" sends to Eden with the code: the fix comes back as a new version.

import { $, el, toast, copyText, setSeg, isMobile, download } from './util.js';
import { t as tx } from './i18n.js';
import { LANGS, DEVICES, detectLang, langInfo, runnerOf, isApp, tokenize, fileName, appendCapped, editRequest, fixRequest, revisedIn, withReporter, watchLeave, LEFT_PAGE, pageKey, stillServed } from './canvas-model.js';
import * as runner from './canvas-run.js';
import { drawApp, setAppTheme, dropApp } from './canvas-app.js';
import { state, path, nodeText } from './state.js';
import { api, apiUrl } from './api.js';
import { artifactsIn } from './render.js';
import { CANVAS_LANGS, renderMarkdown } from './markdown.js';
import { openPublish } from './publish.js';

let H = {};
// view: 0 Preview, 1 Code, 2 Split (code beside the preview; wide windows only)
const art = { versions: [], i: 0, view: 0, urls: new Map(), dev: pref('dev', 'desktop'), theme: 'light', drawn: '', frame: null, seq: 0 };

function pref(k, d) { try { return localStorage.getItem(`eden:canvas:${k}`) || d; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(`eden:canvas:${k}`, v); } catch { /* private mode */ } }

/** What the preview shows: 'deck', 'report', 'html', 'app' (React), or null (code only). */
const PANE_W = 42, PANE_MAX = 66, SPLIT_W = 58; // % of #app (app.css #artifact)

/** Wide: over the whole window (browser.css #browserPane.full does the same); the essay writer opens wide. */
export function setWide(on) {
  $('artifact').classList.toggle('full', on);
  const b = $('btnArtWide');
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Back to the side' : 'Wide';
  b.setAttribute('aria-label', b.title);
  b.querySelector('use').setAttribute('href', on ? '#i-collapse' : '#i-expand');
}

/** Split needs room: the pane widens while it's on, and goes back after (unless dragged meanwhile). */
function splitWidth(on) {
  const pane = $('artifact');
  if (pane.classList.contains('split') === on) return;
  pane.classList.toggle('split', on);
  if (on) {
    art.paneW = pane.style.width;
    if ((parseFloat(pane.style.width) || PANE_W) < SPLIT_W) pane.style.width = `${SPLIT_W}%`;
    art.splitW = pane.style.width;
  } else if (art.splitW && pane.style.width === art.splitW) pane.style.width = art.paneW || '';
}

function previewKind(v) {
  if (!v) return null;
  if (v.lang === 'deck') return 'deck';
  if (v.report) return 'report';
  if (isApp(v.edLang || detectLang(v.code, v.lang))) return 'app';
  return CANVAS_LANGS.has(v.lang) ? 'html' : null;
}
const live = (kind) => kind === 'html' || kind === 'app'; // drawn from code you can edit: Split, sizes, console

function versionsFor(c, title, lang) {
  // every draft/branch of this conversation that made an artifact with this title
  const out = [];
  const nodes = Object.values(c.nodes).filter((n) => n.role === 'assistant').sort((a, b) => a.created - b.created);
  for (const n of nodes) for (const a of artifactsIn(nodeText(n))) if (a.title === title && a.lang === lang) out.push({ ...a, nodeId: n.id });
  return out;
}

export function openArtifact({ title, lang, code, nodeId, report = false }) {
  const c = state.current;
  $('artifact').classList.remove('sheet-on', 'essay-on'); // the spreadsheet canvas (sheet.js, Q15) and the essay writer (essay.js) step aside for this
  // `report`: a research report (Q2, research.js): Markdown, previewed as a page here, Download gives the .md
  const canvas = CANVAS_LANGS.has(lang) || report;
  const extra = report ? { report: true, edLang: 'markdown' } : {};
  let versions = canvas && c && !report ? versionsFor(c, title, lang === 'htm' ? 'html' : lang) : [];
  if (!versions.length) versions = [{ title, lang, code, nodeId, ...extra }];
  let i = versions.findIndex((v) => v.code === code);
  if (i < 0) { versions.push({ title, lang, code, nodeId, ...extra }); i = versions.length - 1; }
  art.versions = versions;
  art.i = i;
  art.view = canvas || isApp(detectLang(code, lang)) ? 0 : 1;
  art.drawn = '';
  $('split').classList.add('art-open');
  $('split').classList.remove('chat-view');
  document.body.classList.remove('canvas-hidden');
  setSeg($('mobSeg'), 1);
  show();
}

// Q14: a slide deck in the canvas (deck.js): its versions are the chat's deck versions; Preview draws the slides.
export function openDeckCanvas({ versions, i }) {
  $('artifact').classList.remove('essay-on');
  art.versions = versions;
  art.i = Math.max(0, Math.min(versions.length - 1, i));
  art.view = 0;
  $('split').classList.add('art-open');
  $('split').classList.remove('chat-view');
  document.body.classList.remove('canvas-hidden');
  setSeg($('mobSeg'), 1);
  show();
}
/** The version the canvas shows when it's a deck, else null. */
export const deckCanvasVersion = () => { const v = artifactOpen() && art.versions[art.i]; return v && v.lang === 'deck' ? v : null; };
/** A deck edit made in the canvas: the newest version, shown. */
export function pushDeckVersion(v) { art.versions.push(v); art.i = art.versions.length - 1; art.view = 0; show(); }
/** Send a message from the canvas (a deck's per-slide buttons). */
/** Send a prompt Eden wrote from a canvas: opts.origin marks it as Eden's own (no auto-search on its wording; chat.js sendMessage). */
export function artifactSend(text, opts = {}) { if (H.send) H.send(text, opts); }

export function closeArtifact() {
  if (!$('split').classList.contains('art-open')) return false;
  $('split').classList.remove('art-open', 'chat-view');
  document.body.classList.remove('canvas-hidden');
  splitWidth(false);
  setWide(false);
  $('artPreview').replaceChildren();
  art.frame = null;
  art.drawn = '';
  dropApp();
  runner.stop();
  return true;
}
export const artifactOpen = () => $('split').classList.contains('art-open');

function show() {
  const v = art.versions[art.i];
  if (!v) return;
  const deck = v.lang === 'deck'; // Q14
  if (!v.edLang) v.edLang = detectLang(v.code, v.lang);
  const kind = previewKind(v);
  const canvas = !!kind;
  const shown = v.title || (canvas ? 'Artifact' : `${v.lang || 'Code'}`);
  $('artTitle').textContent = shown === 'Artifact' || shown === 'SVG drawing' ? tx(shown) : shown; // #artTitle is data-no-i18n: the artifact's own title
  $('artVerN').textContent = `${art.i + 1} of ${art.versions.length}`;
  $('artPrev').disabled = art.i === 0;
  $('artNext').disabled = art.i === art.versions.length - 1;
  $('artVer').hidden = art.versions.length < 2;
  const segBtns = $('artSeg').querySelectorAll('button');
  segBtns[0].disabled = !canvas;
  segBtns[2].disabled = !live(kind);
  if (!canvas) art.view = 1;
  if (art.view === 2 && (!live(kind) || isMobile())) art.view = 0;
  setSeg($('artSeg'), art.view);
  splitWidth(art.view === 2);
  $('artPv').hidden = art.view === 1;
  $('artCode').hidden = art.view === 0;
  $('artCode').classList.toggle('app-code', kind === 'app'); // React's console is the preview's; no run console or stdin
  if (kind === 'app' && $('artCode').classList.contains('con-tab')) setEdTab(0);
  $('pvBar').hidden = !live(kind);
  $('btnPvTheme').hidden = kind !== 'app'; // an HTML page sets its own colours
  $('artPv').dataset.dev = live(kind) ? art.dev : 'desktop';
  setSeg($('pvDev'), Object.keys(DEVICES).indexOf(art.dev));
  if (!live(kind)) pvReset();
  $('btnArtExt').hidden = kind !== 'html';
  $('btnArtPublish').hidden = kind !== 'html'; // a deck shares from its own toolbar; a React app can't be published yet
  if ($('btnArtSlides')) $('btnArtSlides').hidden = !v.report; // Q14: a research report → a deck
  const lines = v.code.split('\n').length;
  const r = runnerOf(v.edLang);
  const where = deck ? ' · slides drawn sandboxed: no network, no cookies · ⌘Z undoes' : v.report ? ' · checked research report · Download saves it as Markdown' : kind === 'app' ? ' · draws sandboxed: packages from esm.sh, no cookies' : canvas ? ' · runs sandboxed: no network, no cookies' : r === 'js' || r === 'py' ? ' · runs in this browser, sandboxed' : r === 'cloud' ? ' · cloud runner: coming soon' : '';
  $('artCapText').textContent = `v${art.i + 1}${v.local ? ' (edited)' : ''} · ${langInfo(v.edLang).label} · ${lines} line${lines === 1 ? '' : 's'}${where}`;
  renderCode(v);
  if (art.view !== 1) renderPreview(v);
}

function renderCode(v) {
  const ta = $('artTa');
  if (ta.value !== v.code) ta.value = v.code;
  $('artLang').value = v.edLang;
  const r = runnerOf(v.edLang);
  const kind = previewKind(v);
  $('btnArtRun').disabled = !r && !kind;
  $('btnArtRun').title = r === 'cloud' ? 'Run in the cloud (coming soon) · ⌘↵' : r === 'app' || (kind && !r) ? 'Show the preview · ⌘↵' : r ? 'Run · ⌘↵' : `${langInfo(v.edLang).label} doesn’t run`;
  paint();
}

/** Redraw the highlighted layer and the line numbers from the textarea. */
function paint() {
  const v = art.versions[art.i];
  const code = $('artTa').value;
  const frag = document.createDocumentFragment();
  for (const { t, v: text } of tokenize(code, v ? v.edLang : 'text')) frag.append(t ? el('span', `tk-${t}`, text) : text);
  frag.append('\n '); // the textarea's last empty line has height too
  $('artHl').replaceChildren(frag);
  const n = code.split('\n').length;
  if ($('artGut').childElementCount !== n) $('artGut').replaceChildren(...Array.from({ length: n }, (_, i) => el('div', null, String(i + 1))));
}

function onType() {
  let v = art.versions[art.i];
  if (!v) return;
  if (!v.local) { // the first keystroke on a version forks it into a new one
    v = { ...v, code: v.code, local: true, nodeId: v.nodeId };
    art.versions.push(v);
    art.i = art.versions.length - 1;
    v.code = $('artTa').value;
    show();
    return;
  }
  v.code = $('artTa').value;
  paint();
  if (art.view === 2) { // Split: the preview follows the typing (an HTML page is stored for each draw, so less often)
    clearTimeout(art.liveT);
    art.liveT = setTimeout(() => { if (art.versions[art.i] === v && art.view === 2) renderPreview(v); }, previewKind(v) === 'app' ? 450 : 1200);
  }
}

// ── the console ──

const con = { total: 0 };
function conWrite(stream, text) {
  const c = appendCapped(con.total, text);
  con.total = c.total;
  if (!c.text) return;
  const out = $('conOut');
  const near = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  out.append(stream === 'stderr' ? el('span', 'con-err', c.text) : c.text);
  if (near) out.scrollTop = out.scrollHeight;
}
function conStatus(text, cls = '') { const s = $('conStat'); s.textContent = text; s.className = `con-stat ${cls}`; }
function setRunning(on) {
  $('btnConStop').hidden = !on;
  $('btnArtRun').classList.toggle('stop', on);
  $('btnArtRun').querySelector('span').textContent = on ? 'Stop' : 'Run';
}
function showConsole() { if (isMobile()) setEdTab(1); }
function setEdTab(i) { setSeg($('edTabs'), i); $('artCode').classList.toggle('con-tab', i === 1); }

async function runCode() {
  if (runner.running()) { runner.stop(); return; }
  const v = art.versions[art.i];
  if (!v) return;
  const kind = previewKind(v);
  if (kind && (!runnerOf(v.edLang) || kind === 'app')) { // Run on something that draws: show it (beside the code on a wide screen)
    if (art.view === 1) art.view = isMobile() || !live(kind) ? 0 : 2;
    art.drawn = '';
    show();
    return;
  }
  $('conOut').replaceChildren();
  con.total = 0;
  conStatus('Running…', 'busy');
  setRunning(true);
  showConsole();
  await runner.run({ lang: v.edLang, code: $('artTa').value, stdin: $('conIn').value }, {
    out: conWrite,
    status: (t) => { if (t) conStatus(t, 'busy'); else conStatus('Running…', 'busy'); },
    exit: ({ code, ms, reason }) => {
      setRunning(false);
      const time = ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
      if (reason === 'unavailable') conStatus('Cloud runner: coming soon', '');
      else if (reason === 'refused') conStatus('Didn’t run', 'bad');
      else if (reason === 'timeout') conStatus(`Stopped at the 30 s limit · exit ${code}`, 'bad');
      else if (reason === 'stopped') conStatus(`Stopped · ${time}`, '');
      else conStatus(`Exit ${code} · ${time}`, code === 0 ? 'ok' : 'bad');
    },
  });
}

// ── the preview's console (its own; the Code view's console is for runs) ──

const pv = { errors: [], lines: 0, open: false };
function pvReset() { pv.errors = []; pv.lines = 0; $('pvConOut').replaceChildren(); pvUi(); }
function pvLog(level, text) {
  if (++pv.lines > 500) return;
  if (level === 'error') { pv.errors.push(text); if (pv.errors.length === 1) pv.open = true; }
  const out = $('pvConOut');
  out.append(el('span', level === 'error' ? 'con-err' : level === 'warn' ? 'con-warn' : '', `${text}\n`));
  out.scrollTop = out.scrollHeight;
  pvUi();
}
function pvUi() {
  const n = pv.errors.length, all = Math.min(pv.lines, 500);
  $('pvCon').hidden = !all;
  $('pvConN').textContent = n ? `${n} error${n === 1 ? '' : 's'}` : `${all} line${all === 1 ? '' : 's'}`;
  $('pvConN').className = `con-stat${n ? ' bad' : ''}`;
  $('btnPvFix').hidden = !n || !H.send;
  $('pvConOut').hidden = !pv.open;
  $('btnPvCon').setAttribute('aria-expanded', String(pv.open));
}
window.addEventListener('message', (e) => { // an HTML preview's console (withReporter); a React preview's comes through canvas-app.js
  if (!art.frame || e.source !== art.frame.contentWindow || !e.data || !e.data.edenPreview) return;
  const d = e.data;
  if (d.type === 'log') pvLog(String(d.level || 'log'), String(d.text || ''));
  else if (d.type === 'error') pvLog('error', String(d.text || 'Error'));
});

/** "Fix it": the preview's errors and the file go to Eden; the fix comes back as a new version. */
function fixIt() {
  const v = art.versions[art.i];
  if (!v || !pv.errors.length || !H.send) return;
  const lang = v.edLang;
  art.pendingEdit = { at: Date.now(), lang, keepView: true };
  H.send(fixRequest({ title: v.title, lang, code: $('artTa').value, errors: pv.errors }), { origin: 'canvas' });
  toast('Asked Eden to fix it: the fix arrives as a new version');
}

function htmlFor(v) {
  if (v.lang === 'svg') return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${v.code}</body></html>`;
  if (/<html[\s>]|<!doctype/i.test(v.code)) return v.code;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${v.code}</body></html>`;
}

async function renderPreview(v) {
  const box = $('artPreview');
  const kind = previewKind(v);
  const key = `${kind}\n${v.edLang}\n${v.code}`;
  if (live(kind) && art.drawn === key && box.firstChild) return; // already showing this (Code → Split, a re-show)
  art.drawn = live(kind) ? key : '';
  const my = ++art.seq; // only the newest render draws, whichever upload ends first (Split while typing, AV2-10)
  const stale = () => my !== art.seq || art.versions[art.i] !== v || art.view === 1;
  if (kind !== 'app') dropApp();
  art.frame = null;
  if (kind === 'deck') { art.url = null; (await import('./deck.js')).renderDeckPreview(box, v); return; } // Q14
  if (kind === 'report') { box.replaceChildren(el('div', 'art-report md', renderMarkdown(v.code))); art.url = null; return; } // a research report: plain Markdown, drawn here (no scripts)
  pvReset();
  if (kind === 'app') {
    art.url = null;
    await drawApp(box, { code: v.code, lang: v.edLang, title: v.title, theme: art.theme }, { log: pvLog, error: (t) => pvLog('error', t), rendered() {} });
    return;
  }
  const html = withReporter(htmlFor(v)); // the page's console and errors come to the canvas (published pages don't carry this)
  const drawing = art.drawn;
  const pk = await pageKey(html);
  if (stale()) { if (art.drawn === drawing) art.drawn = ''; return; } // moved on while hashing
  let url = art.urls.get(pk);
  if (url && !(await stillServed(url))) { art.urls.delete(pk); url = null; } // the server dropped it: send it again (AV2-8)
  if (stale()) { if (art.drawn === drawing) art.drawn = ''; return; }
  if (!url) {
    box.replaceChildren(el('div', 'art-loading', 'Preparing preview…'));
    try {
      url = apiUrl((await api.artifact(html)).url);
      if (art.urls.size > 30) art.urls.delete(art.urls.keys().next().value); // the oldest go (as deck.js does)
      art.urls.set(pk, url);
    }
    catch (e) { if (my === art.seq) box.replaceChildren(el('div', 'art-loading', `Couldn’t prepare the preview: ${e.message}`)); return; }
    if (stale()) return;
  }
  const frame = el('iframe', { sandbox: 'allow-scripts', src: url, title: `Preview: ${v.title || 'artifact'}`, referrerpolicy: 'no-referrer' });
  watchLeave(frame, () => { if (art.frame === frame) pvLog('warn', LEFT_PAGE); });
  box.replaceChildren(frame);
  art.frame = frame;
  art.url = url;
}

/** Re-show the newest version after a regenerate, if the canvas shows that artifact. */
export function refreshArtifact() {
  if (!artifactOpen() || !state.current) return;
  const v = art.versions[art.i];
  if (!v) return;
  if (art.pendingEdit) { takeRevision(); return; }
  if (!CANVAS_LANGS.has(v.lang)) return;
  const list = versionsFor(state.current, v.title, v.lang);
  if (list.length > art.versions.length) { art.versions = list; art.i = list.length - 1; show(); }
}

/** Eden's reply to "Ask Eden to edit": its revised file becomes the newest version. */
function takeRevision() {
  const p = art.pendingEdit;
  const n = Object.values(state.current.nodes).filter((x) => x.role === 'assistant' && x.created >= p.at).sort((a, b) => b.created - a.created)[0];
  if (!n) return;
  art.pendingEdit = null;
  const code = revisedIn(nodeText(n), p.lang);
  if (!code) { toast('Eden’s reply had no revised file'); return; }
  const base = art.versions[art.i] || {};
  art.versions.push({ ...base, code, local: false, edLang: p.lang, nodeId: n.id });
  art.i = art.versions.length - 1;
  if (!p.keepView) art.view = 1; // "Fix it" stays on the preview, to see the fix work
  show();
  toast(`Eden’s edit is version ${art.i + 1}`);
}

function selectionInCode() {
  const ta = $('artTa');
  if ($('artCode').hidden || document.activeElement !== ta || ta.selectionStart === ta.selectionEnd) return '';
  return ta.value.slice(ta.selectionStart, ta.selectionEnd);
}

export function initArtifact(handlers) {
  H = handlers;
  $('artSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (!b || b.disabled) return; art.view = Number(b.dataset.i); show(); });
  $('artPrev').addEventListener('click', () => { if (art.i > 0) { art.i--; show(); } });
  $('artNext').addEventListener('click', () => { if (art.i < art.versions.length - 1) { art.i++; show(); } });
  $('btnArtClose').addEventListener('click', closeArtifact);
  $('btnArtCloseM').addEventListener('click', closeArtifact);
  $('btnArtCopy').addEventListener('click', () => { const v = art.versions[art.i]; if (v) copyText(v.code); });
  $('btnArtPublish').addEventListener('click', () => { const v = art.versions[art.i]; if (v && CANVAS_LANGS.has(v.lang)) openPublish({ title: v.title, html: htmlFor(v) }); }); // G10
  $('btnArtExt').addEventListener('click', () => { if (art.url) window.open(art.url, '_blank', 'noopener'); else toast('The preview isn’t ready yet'); });
  $('mobSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const i = Number(b.dataset.i);
    setSeg($('mobSeg'), i);
    $('split').classList.toggle('chat-view', i === 0);
    document.body.classList.toggle('canvas-hidden', i === 0);
  });
  $('btnCanvasBack').addEventListener('click', () => {
    $('split').classList.remove('chat-view');
    document.body.classList.remove('canvas-hidden');
    setSeg($('mobSeg'), 1);
  });
  const selUi = () => { const on = !!selectionInCode(); $('btnAskSel').classList.toggle('show', on); $('btnEditSel').classList.toggle('show', on); };
  document.addEventListener('selectionchange', selUi);
  ['select', 'keyup', 'mouseup'].forEach((ev) => $('artTa').addEventListener(ev, selUi));
  // the editor
  $('artLang').replaceChildren(...LANGS.map((l) => el('option', { value: l.id }, `${l.label}${l.runner === 'cloud' ? ' · cloud' : ''}`)));
  $('artLang').addEventListener('change', () => { const v = art.versions[art.i]; if (v) { v.edLang = $('artLang').value; show(); } });
  $('artTa').addEventListener('input', onType);
  $('artTa').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runCode(); return; }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  $('btnArtRun').addEventListener('click', runCode);
  // the preview: sizes, light/dark, reload, its console
  $('pvDev').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    art.dev = Object.keys(DEVICES)[Number(b.dataset.i)] || 'desktop';
    savePref('dev', art.dev);
    setSeg($('pvDev'), Number(b.dataset.i));
    $('artPv').dataset.dev = art.dev;
  });
  $('btnPvTheme').addEventListener('click', () => {
    art.theme = art.theme === 'dark' ? 'light' : 'dark';
    const dark = art.theme === 'dark';
    $('btnPvTheme').setAttribute('aria-pressed', String(dark));
    $('btnPvTheme').title = dark ? 'Preview in light mode' : 'Preview in dark mode';
    $('btnPvTheme').setAttribute('aria-label', $('btnPvTheme').title);
    $('btnPvTheme').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    setAppTheme(art.theme);
  });
  $('btnPvReload').addEventListener('click', () => { const v = art.versions[art.i]; if (v) { art.drawn = ''; renderPreview(v); } });
  $('btnPvCon').addEventListener('click', () => { pv.open = !pv.open; pvUi(); });
  $('btnPvConClear').addEventListener('click', pvReset);
  $('btnPvFix').addEventListener('click', fixIt);
  $('btnConStop').addEventListener('click', () => runner.stop());
  $('btnConClear').addEventListener('click', () => { $('conOut').replaceChildren(); con.total = 0; conStatus(''); });
  $('btnArtDl').addEventListener('click', () => { const v = art.versions[art.i]; if (v) download(fileName(v.title, v.edLang), $('artTa').value, 'text/plain'); });
  $('edTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) setEdTab(Number(b.dataset.i)); });
  // the console's grip
  const grip = $('conGrip'), conBox = $('artCon');
  let gripping = false;
  const setConH = (h) => { const max = $('artCode').clientHeight * 0.75; conBox.style.height = `${Math.round(Math.min(max, Math.max(56, h)))}px`; };
  grip.addEventListener('pointerdown', (e) => { gripping = true; grip.setPointerCapture(e.pointerId); document.body.classList.add('row-resize'); e.preventDefault(); });
  grip.addEventListener('pointermove', (e) => { if (gripping) setConH($('artCode').getBoundingClientRect().bottom - e.clientY); });
  const gripEnd = () => { gripping = false; document.body.classList.remove('row-resize'); };
  grip.addEventListener('pointerup', gripEnd);
  grip.addEventListener('pointercancel', gripEnd);
  grip.addEventListener('keydown', (e) => { if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault(); setConH(conBox.offsetHeight + (e.key === 'ArrowUp' ? 24 : -24)); });
  // Ask Eden to edit
  $('btnEditSel').addEventListener('mousedown', (e) => e.preventDefault());
  $('btnEditSel').addEventListener('click', () => {
    const t = selectionInCode();
    if (!t) return;
    art.editSel = t;
    $('editAsk').hidden = false;
    $('artCapText').hidden = true;
    $('editAskIn').value = '';
    $('editAskIn').focus();
  });
  const closeAsk = () => { $('editAsk').hidden = true; $('artCapText').hidden = false; };
  $('editAskIn').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAsk(); } });
  $('editAsk').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = art.versions[art.i];
    if (!v || !art.editSel || !H.send) { closeAsk(); return; }
    art.pendingEdit = { at: Date.now(), lang: v.edLang };
    H.send(editRequest({ title: v.title, lang: v.edLang, code: $('artTa').value, selection: art.editSel, instruction: $('editAskIn').value }), { origin: 'canvas' });
    art.editSel = '';
    closeAsk();
    toast('Asked Eden for the edit: it arrives as a new version');
  });
  $('btnAskSel').addEventListener('mousedown', (e) => e.preventDefault());
  $('btnAskSel').addEventListener('click', () => {
    const t = selectionInCode();
    if (!t) return;
    const v = art.versions[art.i];
    H.quote(`About this part of ${v && v.title ? v.title : 'the code'}:\n${t.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`);
    getSelection().removeAllRanges();
  });
  // the divider: the canvas's left edge (it's a column of #app, like the browser panel); widths are % of #app
  const divider = $('divider'), pane = $('artifact');
  let dragging = false;
  divider.addEventListener('pointerdown', (e) => { if (isMobile()) return; dragging = true; divider.setPointerCapture(e.pointerId); document.body.classList.add('col-resize'); e.preventDefault(); });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = pane.parentElement.getBoundingClientRect();
    pane.style.width = `${Math.min(PANE_MAX, Math.max(24, ((pane.getBoundingClientRect().right - e.clientX) / r.width) * 100))}%`;
  });
  const end = () => { dragging = false; document.body.classList.remove('col-resize'); };
  divider.addEventListener('pointerup', end);
  divider.addEventListener('pointercancel', end);
  divider.addEventListener('dblclick', () => { pane.style.width = ''; });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = parseFloat(pane.style.width) || PANE_W;
    pane.style.width = `${Math.min(PANE_MAX, Math.max(24, cur + (e.key === 'ArrowLeft' ? 4 : -4)))}%`;
  });
  // Wide: the canvas over the whole window, as the browser panel's Wide does
  $('btnArtWide').addEventListener('click', () => setWide(!pane.classList.contains('full')));
  // when a narrow window turns wide, the mobile "Chat" view mustn't stick
  matchMedia('(max-width:640px)').addEventListener('change', (m) => { if (!m.matches) { $('split').classList.remove('chat-view'); document.body.classList.remove('canvas-hidden'); } });
}

export { path };
