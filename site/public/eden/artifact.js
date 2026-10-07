// The canvas: html/svg/artifact blocks preview in a sandboxed iframe (POST /api/chat/artifact,
// then <iframe sandbox="allow-scripts" src=url>); any code block opens in the Code view with
// line numbers. Versions page through the same artifact across drafts; a selection in the
// code can be quoted into the composer; the divider drags (and double-clicks to 50/50).

import { $, el, toast, copyText, setSeg, isMobile } from './util.js';
import { state, path, nodeText } from './state.js';
import { api, apiUrl } from './api.js';
import { artifactsIn } from './render.js';
import { CANVAS_LANGS } from './markdown.js';
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

export function openArtifact({ title, lang, code, nodeId }) {
  const c = state.current;
  const canvas = CANVAS_LANGS.has(lang);
  let versions = canvas && c ? versionsFor(c, title, lang === 'htm' ? 'html' : lang) : [];
  if (!versions.length) versions = [{ title, lang, code, nodeId }];
  let i = versions.findIndex((v) => v.code === code);
  if (i < 0) { versions.push({ title, lang, code, nodeId }); i = versions.length - 1; }
  art.versions = versions;
  art.i = i;
  art.view = canvas ? 0 : 1;
  $('split').classList.add('art-open');
  $('split').classList.remove('chat-view');
  document.body.classList.remove('canvas-hidden');
  setSeg($('mobSeg'), 1);
  show();
}

export function closeArtifact() {
  if (!$('split').classList.contains('art-open')) return false;
  $('split').classList.remove('art-open', 'chat-view');
  document.body.classList.remove('canvas-hidden');
  $('artPreview').replaceChildren();
  return true;
}
export const artifactOpen = () => $('split').classList.contains('art-open');

function show() {
  const v = art.versions[art.i];
  if (!v) return;
  const canvas = CANVAS_LANGS.has(v.lang);
  $('artTitle').textContent = v.title || (canvas ? 'Artifact' : `${v.lang || 'Code'}`);
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
  $('btnArtExt').hidden = !canvas;
  $('btnArtPublish').hidden = !canvas;
  const lines = v.code.split('\n').length;
  $('artCapText').textContent = `v${art.i + 1} · ${v.lang || 'text'} · ${lines} line${lines === 1 ? '' : 's'}${canvas ? ' · runs sandboxed: no network, no cookies' : ''}`;
  renderCode(v);
  if (art.view === 0) renderPreview(v);
}

function renderCode(v) {
  const box = el('div', { class: 'codeblk', tabindex: '0', 'aria-label': 'Code' });
  v.code.split('\n').forEach((line, i) => box.append(el('span', 'ln', String(i + 1)), `${line}\n`));
  $('artCode').replaceChildren(box);
}

function htmlFor(v) {
  if (v.lang === 'svg') return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${v.code}</body></html>`;
  if (/<html[\s>]|<!doctype/i.test(v.code)) return v.code;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${v.code}</body></html>`;
}

async function renderPreview(v) {
  const box = $('artPreview');
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
  if (!v || !CANVAS_LANGS.has(v.lang)) return;
  const list = versionsFor(state.current, v.title, v.lang);
  if (list.length > art.versions.length) { art.versions = list; art.i = list.length - 1; show(); }
}

function selectionInCode() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !$('artCode').contains(sel.anchorNode)) return '';
  // drop the line-number gutter
  const frag = sel.getRangeAt(0).cloneContents();
  frag.querySelectorAll('.ln').forEach((n) => n.remove());
  return frag.textContent.replace(/\n$/, '');
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
  document.addEventListener('selectionchange', () => { $('btnAskSel').classList.toggle('show', !!selectionInCode()); });
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
