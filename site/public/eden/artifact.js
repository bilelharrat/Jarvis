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

import { $, el, toast, copyText, setSeg, isMobile, download } from './util.js';
import { t as tx } from './i18n.js';
import { LANGS, detectLang, langInfo, runnerOf, tokenize, fileName, appendCapped, editRequest, revisedIn } from './canvas-model.js';
import * as runner from './canvas-run.js';
import { state, path, nodeText } from './state.js';
import { api, apiUrl } from './api.js';
import { artifactsIn } from './render.js';
import { CANVAS_LANGS, renderMarkdown } from './markdown.js';
import { openPublish } from './publish.js';

let H = {};
const art = { versions: [], i: 0, view: 0, urls: new Map() };

function versionsFor(c, title, lang) {
  // every draft/branch of this conversation that made an artifact with this title
  const out = [];
  const nodes = Object.values(c.nodes).filter((n) => n.role === 'assistant').sort((a, b) => a.created - b.created);
  for (const n of nodes) for (const a of artifactsIn(nodeText(n))) if (a.title === title && a.lang === lang) out.push({ ...a, nodeId: n.id });
  return out;
}

export function openArtifact({ title, lang, code, nodeId, report = false }) {
  const c = state.current;
  $('artifact').classList.remove('sheet-on'); // the spreadsheet canvas (sheet.js, Q15) steps aside for this
  // `report`: a research report (Q2, research.js): Markdown, previewed as a page here, Download gives the .md
  const canvas = CANVAS_LANGS.has(lang) || report;
  const extra = report ? { report: true, edLang: 'markdown' } : {};
  let versions = canvas && c && !report ? versionsFor(c, title, lang === 'htm' ? 'html' : lang) : [];
  if (!versions.length) versions = [{ title, lang, code, nodeId, ...extra }];
  let i = versions.findIndex((v) => v.code === code);
  if (i < 0) { versions.push({ title, lang, code, nodeId, ...extra }); i = versions.length - 1; }
  art.versions = versions;
  art.i = i;
  art.view = canvas ? 0 : 1;
  $('split').classList.add('art-open');
  $('split').classList.remove('chat-view');
  document.body.classList.remove('canvas-hidden');
  setSeg($('mobSeg'), 1);
  show();
}

// Q14: a slide deck in the canvas (deck.js): its versions are the chat's deck versions; Preview draws the slides.
export function openDeckCanvas({ versions, i }) {
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
export function artifactSend(text) { if (H.send) H.send(text); }

export function closeArtifact() {
  if (!$('split').classList.contains('art-open')) return false;
  $('split').classList.remove('art-open', 'chat-view');
  document.body.classList.remove('canvas-hidden');
  $('artPreview').replaceChildren();
  runner.stop();
  return true;
}
export const artifactOpen = () => $('split').classList.contains('art-open');

function show() {
  const v = art.versions[art.i];
  if (!v) return;
  const deck = v.lang === 'deck'; // Q14
  const canvas = CANVAS_LANGS.has(v.lang) || !!v.report || deck;
  const shown = v.title || (canvas ? 'Artifact' : `${v.lang || 'Code'}`);
  $('artTitle').textContent = shown === 'Artifact' || shown === 'SVG drawing' ? tx(shown) : shown; // #artTitle is data-no-i18n: the artifact's own title
  $('artVerN').textContent = `${art.i + 1} of ${art.versions.length}`;
  $('artPrev').disabled = art.i === 0;
  $('artNext').disabled = art.i === art.versions.length - 1;
  $('artVer').hidden = art.versions.length < 2;
  const segBtns = $('artSeg').querySelectorAll('button');
  segBtns[0].disabled = !canvas;
  if (!canvas) art.view = 1;
  setSeg($('artSeg'), art.view);
  $('artPreview').hidden = art.view !== 0;
  $('artCode').hidden = art.view !== 1;
  $('btnArtExt').hidden = !canvas || !!v.report || deck;
  $('btnArtPublish').hidden = !canvas || !!v.report || deck; // a deck shares from its own toolbar
  if ($('btnArtSlides')) $('btnArtSlides').hidden = !v.report; // Q14: a research report → a deck
  const lines = v.code.split('\n').length;
  if (!v.edLang) v.edLang = detectLang(v.code, v.lang);
  const r = runnerOf(v.edLang);
  const where = deck ? ' · slides drawn sandboxed: no network, no cookies · ⌘Z undoes' : v.report ? ' · checked research report · Download saves it as Markdown' : canvas ? ' · runs sandboxed: no network, no cookies' : r === 'js' || r === 'py' ? ' · runs in this browser, sandboxed' : r === 'cloud' ? ' · cloud runner: coming soon' : '';
  $('artCapText').textContent = `v${art.i + 1}${v.local ? ' (edited)' : ''} · ${langInfo(v.edLang).label} · ${lines} line${lines === 1 ? '' : 's'}${where}`;
  renderCode(v);
  if (art.view === 0) renderPreview(v);
}

function renderCode(v) {
  const ta = $('artTa');
  if (ta.value !== v.code) ta.value = v.code;
  $('artLang').value = v.edLang;
  const r = runnerOf(v.edLang);
  $('btnArtRun').disabled = !r && !CANVAS_LANGS.has(v.lang);
  $('btnArtRun').title = r === 'cloud' ? 'Run in the cloud (coming soon) · ⌘↵' : r ? 'Run · ⌘↵' : CANVAS_LANGS.has(v.lang) ? 'Show the preview' : `${langInfo(v.edLang).label} doesn’t run`;
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
  if (CANVAS_LANGS.has(v.lang) && !runnerOf(v.edLang)) { art.view = 0; show(); return; }
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

function htmlFor(v) {
  if (v.lang === 'svg') return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${v.code}</body></html>`;
  if (/<html[\s>]|<!doctype/i.test(v.code)) return v.code;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${v.code}</body></html>`;
}

async function renderPreview(v) {
  const box = $('artPreview');
  if (v.lang === 'deck') { art.url = null; (await import('./deck.js')).renderDeckPreview(box, v); return; } // Q14
  if (v.report) { box.replaceChildren(el('div', 'art-report md', renderMarkdown(v.code))); art.url = null; return; } // a research report: plain Markdown, drawn here (no scripts)
  const html = htmlFor(v);
  let url = art.urls.get(html);
  if (!url) {
    box.replaceChildren(el('div', 'art-loading', 'Preparing preview…'));
    try { url = apiUrl((await api.artifact(html)).url); art.urls.set(html, url); }
    catch (e) { box.replaceChildren(el('div', 'art-loading', `Couldn’t prepare the preview: ${e.message}`)); return; }
    if (art.versions[art.i] !== v || art.view !== 0) return;
  }
  const frame = el('iframe', { sandbox: 'allow-scripts', src: url, title: `Preview: ${v.title || 'artifact'}`, referrerpolicy: 'no-referrer' });
  box.replaceChildren(frame);
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
  art.view = 1;
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
    H.send(editRequest({ title: v.title, lang: v.edLang, code: $('artTa').value, selection: art.editSel, instruction: $('editAskIn').value }));
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
  // the divider
  const divider = $('divider'), split = $('split'), pane = $('artifact');
  let dragging = false;
  divider.addEventListener('pointerdown', (e) => { if (isMobile()) return; dragging = true; divider.setPointerCapture(e.pointerId); document.body.classList.add('col-resize'); e.preventDefault(); });
  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = split.getBoundingClientRect();
    pane.style.width = `${Math.min(72, Math.max(24, 100 - ((e.clientX - r.left) / r.width) * 100))}%`;
  });
  const end = () => { dragging = false; document.body.classList.remove('col-resize'); };
  divider.addEventListener('pointerup', end);
  divider.addEventListener('pointercancel', end);
  divider.addEventListener('dblclick', () => { pane.style.width = '50%'; });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = parseFloat(pane.style.width) || 46;
    pane.style.width = `${Math.min(72, Math.max(24, cur + (e.key === 'ArrowLeft' ? 4 : -4)))}%`;
  });
  // when a narrow window turns wide, the mobile "Chat" view mustn't stick
  matchMedia('(max-width:640px)').addEventListener('change', (m) => { if (!m.matches) { $('split').classList.remove('chat-view'); document.body.classList.remove('canvas-hidden'); } });
}

export { path };
