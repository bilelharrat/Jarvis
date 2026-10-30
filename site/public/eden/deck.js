// Slide decks in Eden (ROADMAP Q14): the page side. A chat in Slides mode asks the routed model for a
// deck as JSON (deck-model.js deckSystem, sent through api.js addSendExtra with `deck: true`, which
// gives the reply room for a whole deck on the server); the reply's deck becomes a version on the
// conversation (c.deckVersions, synced; pictures in c.deckImages stay on this device) and opens in
// the canvas, drawn by deck-render.js inside the artifact sandbox. The canvas's version arrows are
// undo/redo; every edit (typed on a slide, dragged, a theme, a picture, a slide Eden changed) is a
// version. Present fills the screen; presenter view shows notes and a timer. Exports: PowerPoint
// (deck-pptx.js), PDF (the browser’s print of a script-free copy), Google Slides (the PowerPoint
// converted in the person's Drive with sheet-google.js driveUpload, drive.file only), Markdown outline; Publish (G10) shares a live, view-only copy.

import { $, el, ico, toast, isMobile, noteAsset } from './util.js';
import { t as tx } from './i18n.js';
import { state, nodeText, saveConversation, path } from './state.js';
import { api, apiUrl, addSendExtra } from './api.js';
import { openDeckCanvas, deckCanvasVersion, pushDeckVersion, artifactSend, closeArtifact, setWide } from './artifact.js';
import { setComposerText } from './composer.js';
import { openPublish } from './publish.js';
import { labelView } from './verify-model.js';
import { IN_APP, appPrint, appCanPrint } from './native.js'; // the PDF in the iPhone app: the app prints (R2-8)
import {
  THEMES, TRANSITIONS, BUILDS, SPEEDS, motionOf, setMotion, setSlideMotion, normalizeDeck, deckFromReply, deckSystem, deckContext, slidesAsked, wantsSlides, addVersion, setText, moveSlide, deleteSlide,
  insertSlide, slideLayouts, setSlideLayout, layoutDeck, duplicateSlide, setTheme, setImage, cycleSlideLayout, toggleSlidePlaybook, missingAlt, imagesUsed, editablePath, slideRequest, deckOutline, deckFileName, looseJson,
} from './deck-model.js';
import { pickImages } from './search-images.js';
import { initDeckMedia, openMediaPanel, pruneMedia, pptxMediaFiles } from './deck-video-ui.js'; // video/audio on slides (web only)
import { canRecord, openRecorder } from './deck-record.js'; // record yourself presenting (web only)
import { mediaPosters } from './deck-model.js';
import { macFile } from './sheet-google.js';
import { brandRow, brandFonts, saveThemeAsKit } from './deck-brand.js'; // brand kits (web only)
import { mediaPanel, pruneCredits } from './deck-media.js'; // stock photos, icons, video, audio (web-only Media tray)
import { collabHooks, commentsPanel, presenceBar, commentsOf } from './deck-comments.js'; // comments, tasks, presence (web only)
import { presentHooks, presentAt, presentEnded, presentFrameReady } from './deck-present.js'; // rehearse, timings, self-running show, live polls/Q&A (web only)
import { freeformPanel, insert as insertFree, freeSelection } from './deck-freeform.js'; // free-form text boxes, shapes, icons, pictures (web only: Text and Shape)
import * as shellKit from './deck-shell.js'; // the web editor's Keynote-style shell (registers nothing in the iPhone app)
import { initArrange, exportDeck } from './deck-arrange.js'; // undo/redo, history, sorter, menus, zoom: registers with deck-shell.js (web only)
import { commentOn } from './deck-comments.js';
import { initRichText, richMessage } from './deck-rich-ui.js'; // rich text: format bar, Format › Text, ⌘B/⌘I/⌘U/⌘K, Tab indent (web only)
// find and replace, spell check, handouts (web only: each registers with deck-shell.js; the app never loads them)
if (!IN_APP) for (const m of ['./deck-find.js', './deck-spell.js', './deck-handouts-ui.js']) import(m).catch((e) => console.warn(`Slides: ${m} didn’t load`, e));
import './deck-format.js'; // chart data, table editing, slide backgrounds, slide numbers and footer (web only: registers with deck-shell.js behind !IN_APP)
// the deck's own page (deck-render.js, 48 KB): loaded when a deck is first drawn, printed or shared
// (a load that failed, offline, is tried again the next time: R2C-19)
let renderP = null;
const deckRender = () => (renderP ??= import('./deck-render.js').then((m) => { noteAsset(new URL('./deck-render.js', import.meta.url).href); return m; }, (e) => { renderP = null; throw e; }));

const versionsOf = (c) => (c && Array.isArray(c.deckVersions) ? c.deckVersions : []);
const latest = (c) => { const v = versionsOf(c).at(-1); return v ? v.deck : null; };
const save = (c) => saveConversation(c);
const view = { frame: null, url: '', at: 0, presenting: false, pending: null, urls: new Map(), conv: null };
/** The chat whose deck the canvas shows (the one opened, else the current chat). */
const cur = () => (view.conv && state.convs.includes(view.conv) ? view.conv : state.current);
if (!IN_APP) initDeckMedia({ frame: () => view.frame, currentDeck: () => currentDeck(), cur, commit: (d, o) => commit(d, o), notice: (t, k) => notice(t, k), storeImage: (...a) => storeImage(...a), slideAt: () => slideAt(), save });
if (!IN_APP) collabHooks({ conv: () => cur(), deck: () => currentDeck(), frame: () => view.frame, slide: () => (view.index >= 0 ? view.index : 0), at: () => view.at });
if (!IN_APP) presentHooks({ frame: () => view.frame, stage: () => $('deckStage'), present: (o) => present(o), exit: () => exitPresent(), deck: () => currentDeck(), commit: (d, o) => commit(d, o), conv: () => cur(), at: () => view.at, index: () => view.index, presenting: () => view.presenting, render: () => deckRender() });
if (!IN_APP) view.onPresentEnd = presentEnded;
if (!IN_APP) initRichText({ frame: () => view.frame, currentDeck: () => currentDeck(), commit: (d, o) => commit(d, o), queue: (msg) => { (view.pending ||= []).push(msg); } });
if (!IN_APP) import('./deck-factcheck.js').catch((e) => console.error(e)); // Eden's AI on selected text and slides, EVES fact-check (deck-ai.js; registers with deck-shell.js)
if (!IN_APP) initArrange({ cur: () => cur(), currentDeck: () => currentDeck(), commit: (d, o) => commit(d, o), frame: () => view.frame, slideAt: () => (view.index >= 0 ? view.index : 0), storeImage: (c, id, data, w, h) => storeImage(c, id, data, w, h), save: (c) => save(c), deckRender: () => deckRender(), commentOn: (a) => commentOn(a) });

// ── the turn: Slides mode adds the deck instructions, the current deck and room for a long reply ──

const pendingImages = new Map(); // chat id → { att1: stored id }
const SOURCES_WANTED = /\b(sources?|cite|citations?|research|latest|current|recent|today|this year|news|statistics|stats|data on)\b/i;

addSendExtra((body) => {
  const c = state.convs.find((x) => x.id === body.chatId) || state.current;
  if (!c || c.kind === 'code' || body.privacy || body.deckJob) return null; // deckJob: a small model job of the editor's own (deck-translate.js), not a Slides turn
  const last = (body.messages || []).at(-1) || {};
  const deck = latest(c);
  const autoSlides = c.mode !== 'slides' && wantsSlides(last.content, { hasDeck: !!deck });
  if (c.mode !== 'slides' && !autoSlides) return null;
  const atts = (last.attachments || []).filter((a) => a.kind === 'image' && a.data);
  const images = [];
  const map = {};
  atts.slice(0, 8).forEach((a, k) => {
    const data = `data:${a.mime || 'image/png'};base64,${a.data}`;
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(data)) return;
    const id = `att${k + 1}`;
    const stored = `i${Date.now().toString(36)}${k}`;
    storeImage(c, stored, data);
    map[id] = stored;
    images.push({ id, name: a.name });
  });
  pendingImages.set(c.id, map);
  const searchOk = !(state.meta && state.meta.search && state.meta.search.available === false);
  return {
    deck: true,
    ...(body.mode === 'chat' && searchOk && SOURCES_WANTED.test(String(last.content || '')) ? { mode: 'search' } : {}),
    system: [body.system, deckSystem({ images, hasDeck: !!deck, count: slidesAsked(last.content) || 0, allowAutoImages: true })].filter(Boolean).join('\n\n'),
    ...(deck ? { context: [...(body.context || []), deckContext(deck)] } : {}),
  };
});

function storeImage(c, id, data, w = 0, h = 0) {
  c.deckImages = c.deckImages || {};
  c.deckImages[id] = { data, w, h };
  if ((!w || /^data:image\/webp/i.test(data)) && typeof Image !== 'undefined' && typeof document !== 'undefined') {
    const im = new Image();
    im.onload = () => {
      if (!c.deckImages[id]) return;
      c.deckImages[id].w = im.naturalWidth || w || 960;
      c.deckImages[id].h = im.naturalHeight || h || 540;
      if (/^data:image\/webp/i.test(c.deckImages[id].data)) {
        try {
          const cv = document.createElement('canvas');
          cv.width = c.deckImages[id].w;
          cv.height = c.deckImages[id].h;
          cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
          const jpg = cv.toDataURL('image/jpeg', 0.86);
          if (/^data:image\/jpeg;base64,/.test(jpg)) c.deckImages[id].data = jpg;
        } catch { /* keep original if canvas fails */ }
      }
      save(c);
    };
    im.src = data;
  }
}
/** Pictures no version uses any more are dropped (they live only on this device). */
function pruneImages(c) {
  pruneMedia(c, versionsOf(c).map((v) => v.deck)); // and video/audio files (deck-video-ui.js)
  if (!c.deckImages) return;
  const used = new Set(versionsOf(c).flatMap((v) => imagesUsed(v.deck)));
  for (const v of versionsOf(c)) if (v.deck) for (const id of mediaPosters(v.deck)) used.add(id); // a video's poster
  for (const id of Object.keys(c.deckImages)) if (!used.has(id)) delete c.deckImages[id];
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'how', 'why', 'what', 'when', 'where', 'who', 'which', 'their', 'this', 'that', 'these', 'those',
  'way', 'dna', 'blueprint', 'philosophy', 'anatomy', 'architecture', 'core', 'key', 'summary', 'overview', 'introduction', 'conclusion',
  'slide', 'slides', 'deck', 'presentation', 'system', 'offensive', 'defensive', 'favorite', 'favourite', 'plays', 'play', 'era', 'part',
  'mastery', 'mechanics', 'machine', 'option', 'routes', 'route', 'seam', 'dictation', 'two', 'tight', 'end', 'slot', 'pocket', 'pre', 'snap',
  'pillar', 'pillars', 'framework', 'model', 'strategy', 'strategic', 'execution', 'analysis', 'breakdown', 'deep', 'dive', 'evolution',
  'impact', 'legacy', 'benchmark', 'metrics', 'comparison', 'versus', 'vs', 'phase', 'step', 'steps', 'principles', 'principle', 'rules',
  'rule', 'guide', 'modern', 'classic', 'ultimate', 'complete', 'inside', 'behind', 'secrets', 'secret', 'art', 'science', 'power', 'future',
]);

function cleanEntityWords(str) {
  return String(str || '')
    .replace(/['’]s\b/gi, '')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
}

function buildSlideImageQueries(deck, slide, idx) {
  const queries = [];
  const pushQ = (q) => {
    const s = String(q || '').replace(/\s+/g, ' ').trim();
    if (s && s.length >= 3 && !queries.some((x) => x.toLowerCase() === s.toLowerCase())) queries.push(s);
  };

  const deckWords = cleanEntityWords(deck && deck.title);
  const deckSubject = deckWords.slice(0, 3).join(' ');
  const slideWords = cleanEntityWords(slide && slide.title);
  const subWords = cleanEntityWords(slide && slide.subtitle);
  const cardWords = Array.isArray(slide && slide.cards)
    ? cleanEntityWords(slide.cards.map((c) => `${c.title || ''} ${c.badge || ''}`).join(' '))
    : [];
  const colWords = Array.isArray(slide && slide.columns)
    ? cleanEntityWords(slide.columns.map((c) => c.heading || '').join(' '))
    : [];
  const bulletWords = Array.isArray(slide && slide.bullets)
    ? cleanEntityWords(slide.bullets.slice(0, 2).join(' '))
    : [];

  if (slide && slide.imageQuery) {
    const iqWords = cleanEntityWords(slide.imageQuery);
    if (iqWords.length) pushQ(iqWords.slice(0, 4).join(' '));
    pushQ(slide.imageQuery);
  }
  if (slide && slide.macImage) pushQ(slide.macImage);

  if (idx === 0) {
    if (deckSubject) pushQ(deckSubject);
    if (slideWords.length) pushQ(slideWords.slice(0, 3).join(' '));
  } else {
    if (slideWords.length && deckWords.length) {
      const distinctSlide = slideWords.filter((w) => !deckWords.some((dw) => dw.toLowerCase() === w.toLowerCase()));
      if (distinctSlide.length) {
        pushQ(`${distinctSlide.slice(0, 2).join(' ')} ${deckWords.slice(0, 2).join(' ')}`);
        pushQ(distinctSlide.slice(0, 3).join(' '));
      }
    }
    if (slideWords.length) pushQ(slideWords.slice(0, 3).join(' '));
    const extraWords = [...subWords, ...cardWords, ...colWords, ...bulletWords].filter(
      (w) => !slideWords.some((sw) => sw.toLowerCase() === w.toLowerCase()),
    );
    if (extraWords.length && deckWords.length) {
      pushQ(`${extraWords.slice(0, 2).join(' ')} ${deckWords.slice(0, 2).join(' ')}`);
    }
    if (deckSubject) pushQ(deckSubject);
  }

  if (deckWords.length >= 2) pushQ(deckWords.slice(-2).join(' '));
  if (deckWords.length >= 1) pushQ(deckWords.slice(0, 2).join(' '));
  return queries.slice(0, 6);
}

function isLegacySyntheticImage(id, entry) {
  if (!id || !entry || !entry.data) return true;
  if (String(id).startsWith('vis')) return true;
  return false;
}

function slideWantsPhoto(s, idx) {
  if (!s || typeof s !== 'object') return false;
  if (s.live) return false; // a poll or Q&A slide: the results and the join code need the room (deck-present.js)
  if (s.layout === 'playbook' || s.playbook || s.layout === 'chart' || s.layout === 'table' || s.layout === 'diagram' || s.layout === 'sources') return false;
  if (idx === 0 || s.layout === 'title' || s.layout === 'image' || s.layout === 'section' || s.layout === 'quote') return true;
  if (s.imageQuery || s.macImage || s.imageGen) return true;
  if (s.layout === 'bullets') return true;
  if (s.layout === 'grid' && (!s.cards || s.cards.length <= 2)) return true;
  if (s.layout === 'stats' && (!s.stats || s.stats.length <= 2)) return true;
  return false;
}

async function fetchWithTimeout(url, ms = 5500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolveSlideImages(c, deck) {
  let changed = false;
  const compressBlobToDataUrl = (blob) => new Promise((res) => {
    const timer = setTimeout(() => res(null), 5000);
    const done = (val) => { clearTimeout(timer); res(val); };
    const fr = new FileReader();
    fr.onload = () => {
      const rawUrl = String(fr.result || '');
      if (typeof Image === 'undefined' || typeof document === 'undefined') {
        done({ data: rawUrl, w: 800, h: 500 });
        return;
      }
      const im = new Image();
      im.onload = () => {
        try {
          const maxDim = 960;
          const scale = Math.min(1, maxDim / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
          const w = Math.max(1, Math.round((im.naturalWidth || 800) * scale));
          const h = Math.max(1, Math.round((im.naturalHeight || 500) * scale));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(im, 0, 0, w, h);
          const jpeg = cv.toDataURL('image/jpeg', 0.80);
          done({ data: jpeg && /^data:image\/jpeg;base64,/.test(jpeg) ? jpeg : rawUrl, w, h });
        } catch {
          done({ data: rawUrl, w: im.naturalWidth || 800, h: im.naturalHeight || 500 });
        }
      };
      im.onerror = () => done(null);
      im.src = rawUrl;
    };
    fr.onerror = () => done(null);
    fr.readAsDataURL(blob);
  });
  const queryCache = new Map();
  const wikiLookup = async (query) => {
    const key = String(query || '').toLowerCase().trim();
    if (!key) return [];
    if (queryCache.has(key)) return queryCache.get(key);
    const p = (async () => {
      const r = await fetchWithTimeout(apiUrl(`/api/chat/webimage?q=${encodeURIComponent(query)}`), 5500);
      if (!r || !r.ok) return [];
      const data = await r.json().catch(() => null);
      if (!data || (!data.search && !data.images)) return [];
      return pickImages(data.search, data.images, { max: 14 }).map((item) => ({
        ...item,
        src: apiUrl(`/api/chat/webimage?u=${encodeURIComponent(item.thumb)}`),
      }));
    })();
    queryCache.set(key, p);
    return p;
  };
  const aiGenerateSlideImage = async (prompt) => {
    let imgData = null;
    await api.send(
      {
        messages: [{ role: 'user', content: `Create a photorealistic widescreen 16:9 photograph (no text or words): ${prompt}` }],
        image: true,
        deck: false,
        settings: { level: 2 },
      },
      {
        onEvent: (t, d) => {
          if (t === 'image' && d && d.data && !imgData) {
            imgData = { mime: d.mime || 'image/webp', data: d.data };
          }
        },
      },
    ).catch(() => {});
    return imgData;
  };

  // Pre-warm all unique image queries across the deck in parallel (batches of 4) so slide resolution is near-instant
  const allQueries = [];
  deck.slides.forEach((s, idx) => {
    const existing = s.image && c.deckImages ? c.deckImages[s.image] : null;
    if (existing && !isLegacySyntheticImage(s.image, existing)) return;
    if (slideWantsPhoto(s, idx)) {
      for (const q of buildSlideImageQueries(deck, s, idx).slice(0, 3)) {
        if (!allQueries.some((x) => x.toLowerCase() === q.toLowerCase())) allQueries.push(q);
      }
    }
  });
  for (let b = 0; b < allQueries.length; b += 4) {
    await Promise.all(allQueries.slice(b, b + 4).map((q) => wikiLookup(q)));
  }

  let aiGeneratedCount = 0;
  const usedThumbs = new Set();
  const slides = [];
  for (let idx = 0; idx < deck.slides.length; idx++) {
    const s = deck.slides[idx];
    const existing = s.image && c.deckImages ? c.deckImages[s.image] : null;
    if (existing && !isLegacySyntheticImage(s.image, existing)) {
      slides.push(s);
      continue;
    }
    if (s.image && isLegacySyntheticImage(s.image, existing)) {
      if (c.deckImages) delete c.deckImages[s.image];
      changed = true;
    }

    // 1. Browse/load an image file from the user's Mac if requested (`macImage`)
    if (s.macImage && state.jarvis && state.jarvis.available) {
      try {
        const res = await api.jarvis('files_search', { query: s.macImage, kind: 'image', limit: 5 });
        const fileHit = (res && Array.isArray(res.files) ? res.files : []).find((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.path || f.name || ''));
        if (fileHit && fileHit.path) {
          const read = await macFile({ action: 'read', path: fileHit.path });
          if (read && read.data) {
            const mime = read.mime || (/\.png$/i.test(fileHit.path) ? 'image/png' : /\.webp$/i.test(fileHit.path) ? 'image/webp' : /\.gif$/i.test(fileHit.path) ? 'image/gif' : 'image/jpeg');
            const id = `mac${Date.now().toString(36)}${idx}`;
            storeImage(c, id, `data:${mime};base64,${read.data}`);
            changed = true;
            slides.push({ ...s, layout: s.layout || 'image', image: id, alt: s.alt || fileHit.name || s.macImage });
            continue;
          }
        }
      } catch { /* fallback to web image lookup if Mac file wasn't found */ }
    }

    // 2. Real high-resolution web/Wikimedia photograph lookup across slide-specific & deck-entity queries
    const autoWantPic = slideWantsPhoto(s, idx);

    if (autoWantPic) {
      const queries = buildSlideImageQueries(deck, s, idx);
      let resolvedSlide = null;
      for (const tryQ of queries) {
        try {
          const found = await wikiLookup(tryQ);
          for (const cand of found) {
            if (!cand || !cand.src || usedThumbs.has(cand.thumb)) continue;
            const resp = await fetchWithTimeout(cand.src, 5500);
            if (!resp || !resp.ok) continue;
            const blob = await resp.blob().catch(() => null);
            if (!blob || blob.size < 3500) continue;
            const conv = await compressBlobToDataUrl(blob).catch(() => null);
            if (conv && /^data:image\/(png|jpeg|gif|webp);base64,/.test(conv.data)) {
              usedThumbs.add(cand.thumb);
              const id = `web${Date.now().toString(36)}${idx}`;
              storeImage(c, id, conv.data, conv.w || cand.width || 800, conv.h || cand.height || 500);
              changed = true;
              resolvedSlide = { ...s, layout: s.layout || 'image', image: id, alt: s.alt || cand.title || tryQ };
              break;
            }
          }
          if (resolvedSlide) break;
        } catch { /* try next query */ }
      }
      if (resolvedSlide) {
        slides.push(resolvedSlide);
        continue;
      }
    }

    // 3. Bespoke AI photograph (`imageGen` or fallback when web search returned no photo)
    const genPrompt = s.imageGen || (autoWantPic ? (s.alt || s.imageQuery || `${deck.title || ''} ${s.title || ''}`.trim()) : '');
    if (genPrompt && !IN_APP && aiGeneratedCount < 2) {
      aiGeneratedCount++;
      try {
        const gen = await aiGenerateSlideImage(genPrompt);
        if (gen && gen.data) {
          const id = `ai${Date.now().toString(36)}${idx}`;
          storeImage(c, id, `data:${gen.mime};base64,${gen.data}`, 1536, 1024);
          changed = true;
          slides.push({ ...s, layout: s.layout || 'image', image: id, alt: s.alt || genPrompt });
          continue;
        }
      } catch { /* ignore failed AI image generation */ }
    }

    // If no real photo was found, remove any stale/broken image reference so the slide renders cleanly as typography/cards without a fake placeholder box
    if (s.image || s.imageQuery || s.imageGen || s.macImage) {
      const cleaned = { ...s };
      delete cleaned.image;
      delete cleaned.imageQuery;
      delete cleaned.imageGen;
      delete cleaned.macImage;
      if (cleaned.layout === 'image') cleaned.layout = cleaned.cards ? 'grid' : cleaned.left && cleaned.right ? 'two-column' : 'bullets';
      changed = true;
      slides.push(cleaned);
    } else {
      slides.push(s);
    }
  }
  return changed ? { ...deck, slides } : deck;
}

const RESEND = 'The slides didn’t come through.';
// a finished reply with a deck in it: a new version, opened in the canvas
addEventListener('eden:turn-done', async (e) => {
  const { c, node } = e.detail || {};
  if (!c || !node || node.role !== 'assistant') return;
  const text = nodeText(node);
  if (!/```\s*(deck|slides)/.test(text) && !/~~~\s*(deck|slides)/.test(text)) return;
  const r = deckFromReply(text, latest(c));
  if (!r) return;
  if (r.error) {
    dispatchEvent(new CustomEvent('eden:repaint', { detail: { c } }));
    // Web: a deck that still can't be read (deck-model.js repairJson mends most) is asked for once more, not left
    // as a dead card; a reply to that request that fails too is left as it is (no loop).
    const asked = node.parent && c.nodes[node.parent] && nodeText(c.nodes[node.parent]).startsWith(RESEND);
    if (!IN_APP && !asked && c === state.current && !state.streams.has(c.id)) {
      toast(tx('The slides didn’t come through: asking Eden to send them again'));
      if (c.mode !== 'slides') { c.mode = 'slides'; save(c); }
      setTimeout(() => { if (cur() === c && !state.streams.has(c.id)) artifactSend(`${RESEND} (${r.error}) Send the complete deck again as one deck block of strict JSON: double quotes, no comments, no citation marks.`); }, 400);
    } else toast(r.error);
    return;
  }
  const map = pendingImages.get(c.id) || {};
  pendingImages.delete(c.id);
  let deck = { ...r.deck, slides: r.deck.slides.map((s) => (s.image && map[s.image] ? { ...s, image: map[s.image] } : s)) };
  c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: node.id, kind: 'model', deck });
  pruneImages(c);
  save(c);
  dispatchEvent(new CustomEvent('eden:repaint', { detail: { c } }));
  if (r.warning) toast(r.warning);
  if (c === state.current) openDeck(c, { nodeId: node.id });
});

addEventListener('eden:open-deck', (e) => {
  const { c, node } = e.detail || {};
  const conv = c || state.current;
  if (!conv) return;
  if (node && node.role === 'assistant' && !node.streaming && !versionsOf(conv).some((v) => v.nodeId === node.id)) { // a reply whose deck couldn't be read before (repairJson now can)
    const r = deckFromReply(nodeText(node), latest(conv));
    if (r && r.deck) { conv.deckVersions = addVersion(conv.deckVersions, { at: Date.now(), nodeId: node.id, kind: 'model', deck: r.deck }); save(conv); dispatchEvent(new CustomEvent('eden:repaint', { detail: { c: conv } })); }
  }
  openDeck(conv, node ? { nodeId: node.id } : {});
});
const handleExportDeck = async (e) => {
  const { c, node, nodeId, format } = e.detail || {};
  const conv = c || cur() || state.current;
  if (!conv) return;
  const targetNodeId = nodeId || (node && node.id) || null;
  if (targetNodeId || !deckCanvasVersion()) {
    openDeck(conv, targetNodeId ? { nodeId: targetNodeId } : {});
  }
  if (format === 'pdf') await exportPdf();
  else await exportPptx();
};
addEventListener('eden:export-deck-pptx', handleExportDeck);
addEventListener('eden:export-deck', handleExportDeck);
addEventListener('eden:report-slides', () => {
  const c = cur();
  if (!c) return;
  c.mode = 'slides';
  save(c);
  artifactSend('Make a slide deck from the research report above: its key findings, one idea per slide, with charts or tables where it has numbers. Keep its citations as [n] and list its sources.');
});

// ── the canvas ──

const toArt = (v, k) => ({ title: v.deck.title, lang: 'deck', code: JSON.stringify(v.deck, null, 2), nodeId: v.nodeId, local: v.kind !== 'model', edLang: 'json', deckIdx: k });

/** Open the chat's deck (its newest version, or the one a reply made) in the canvas. */
export function openDeck(c, { nodeId } = {}) {
  view.conv = c;
  tools.open = '';
  const vs = versionsOf(c);
  if (!vs.length) { openEmpty(c); return; }
  let i = nodeId ? vs.map((v) => v.nodeId).lastIndexOf(nodeId) : vs.length - 1;
  if (i < 0) i = vs.length - 1;
  openDeckCanvas({ versions: vs.map(toArt), i });
  enterEditor();
}

function openEmpty(c) {
  openDeckCanvas({ versions: [{ title: 'Slides', lang: 'deck', code: '', edLang: 'json', empty: true }], i: 0 });
  if (c.mode !== 'slides') { c.mode = 'slides'; save(c); }
}

/** A local edit: a new version (after the newest, even when an older one is shown), drawn at once. */
function commit(deck, { toastText = '', src = '' } = {}) {
  const c = cur();
  if (!c || !deck) return;
  if (c.deckCredits) deck = pruneCredits(deck, c.deckCredits); // a media-library credit goes with its last picture or clip
  const base = deckCanvasVersion();
  c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: base && base.nodeId, kind: 'edit', ...(src ? { src } : {}), deck }); // src: 'template' | 'restore' (History, deck-arrange.js)
  pruneImages(c);
  save(c);
  const vs = versionsOf(c);
  pushDeckVersion(toArt(vs.at(-1), vs.length - 1));
  if (toastText) toast(toastText, { label: tx('Undo'), run: () => $('artPrev').click() });
}

function currentDeck(v = deckCanvasVersion()) {
  if (!v || v.empty) return null;
  const r = normalizeDeck(looseJson(v.code));
  if (r.deck && !IN_APP) { const cm = commentsOf(cur()); if (cm.length) r.deck.comments = cm; } // the latest comments, whichever version is shown
  return r.deck || null;
}

/** The label under the reply that made this version, for the sources slide ("Searched the web · cited"…). */
function labelFor(c, v) {
  const n = v && v.nodeId && c.nodes[v.nodeId];
  const l = n && n.verification ? labelView(n.verification) : null;
  if (l && l.text) return tx(l.text); // drawn inside the deck's own frame, which the page's translator doesn't reach
  if (n && n.research && n.research.report) return tx('From Eden’s checked research report');
  return '';
}

const labels = (LABELS) => Object.fromEntries(Object.entries(LABELS).map(([k, s]) => [k, tx(s)]));
const darkUi = () => document.documentElement.dataset.theme === 'dark';

const resolvingDecks = new Set();

/** Draw the shown version in the canvas (artifact.js calls this for a deck). */
export async function renderDeckPreview(box, v) {
  const c = cur();
  const renderToken = view.renderToken = {};
  if (!IN_APP && view.presenting) exitPresent();
  view.frame = null;
  if (!c) return;
  if (v.empty) { box.replaceChildren(emptyState(c)); return; }
  const parsed = looseJson(v.code);
  const r = parsed === undefined ? { error: 'This isn’t valid JSON yet: fix it in the Code view.' } : normalizeDeck(parsed);
  if (r.error) { box.replaceChildren(el('div', 'art-loading', r.error)); return; }
  if (v.deckIdx === undefined) { // edited in the Code view: kept as a version
    c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: v.nodeId, kind: 'edit', deck: r.deck });
    v.deckIdx = versionsOf(c).length - 1;
    save(c);
  }
  let R;
  try { R = await deckRender(); } catch (e) { box.replaceChildren(el('div', 'art-loading', `Couldn’t load the slides: ${e.message}. Open the deck again to retry.`)); return; }
  if (!IN_APP && (view.renderToken !== renderToken || cur() !== c)) return;
  const { deckDocument, LABELS } = R;
  const deck = r.deck;
  // Auto-resolve images for existing decks whenever opened in the canvas if any slide lacks its resolved image or still has a legacy synthetic image (`vis*`)
  const needsImg = !deck.template && deck.slides.some((s, idx) => { // template placeholder words make no photo search
    const existing = s.image && c.deckImages ? c.deckImages[s.image] : null;
    if (!existing || isLegacySyntheticImage(s.image, existing)) {
      return slideWantsPhoto(s, idx);
    }
    return false;
  });
  const sourceVersion = versionsOf(c)[v.deckIdx];
  const sourceCode = v.code;
  const resolveKey = IN_APP ? `${c.id}:${v.nodeId || v.deckIdx || 0}` : sourceVersion || v;
  if (needsImg && !resolvingDecks.has(resolveKey)) {
    resolvingDecks.add(resolveKey);
    resolveSlideImages(c, deck).then((hydrated) => {
      resolvingDecks.delete(resolveKey);
      if (hydrated !== deck) {
        const vs = versionsOf(c);
        // Indices shift when history is capped; nodeId is shared by edits. Only the exact
        // version we started from may receive this result, never a replacement or new edit.
        if (!IN_APP && (!sourceVersion || !vs.includes(sourceVersion) || v.code !== sourceCode)) return;
        const idx = !IN_APP ? vs.indexOf(sourceVersion) : typeof v.deckIdx === 'number' && vs[v.deckIdx] ? v.deckIdx : vs.findIndex((x) => x.nodeId === v.nodeId);
        if (idx >= 0) vs[idx] = { ...vs[idx], deck: hydrated };
        else c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), nodeId: v.nodeId, kind: 'model', deck: hydrated });
        v.code = JSON.stringify(hydrated, null, 2);
        save(c);
        dispatchEvent(new CustomEvent('eden:repaint', { detail: { c } }));
        const curV = deckCanvasVersion();
        if (curV && (IN_APP ? (curV === v || (curV.nodeId && curV.nodeId === v.nodeId)) : (curV === v && cur() === c && view.renderToken === renderToken && !view.presenting))) {
          curV.code = v.code;
          renderDeckPreview(box, curV);
        }
      }
    }).catch(() => resolvingDecks.delete(resolveKey));
  }
  if (c.deckImages) {
    for (const id of Object.keys(c.deckImages)) {
      if (isLegacySyntheticImage(id, c.deckImages[id])) delete c.deckImages[id];
    }
  }
  const html = deckDocument(deck, { mode: 'edit', progressive: !IN_APP, persistentExit: !IN_APP, motion: !IN_APP, media: !IN_APP, fonts: IN_APP ? undefined : await brandFonts(deck), images: c.deckImages || {}, start: view.at, label: labelFor(c, v), labels: labels(LABELS), darkUi: darkUi(), lang: document.documentElement.lang || 'en' });
  const wrap = el('div', { class: 'deck-stage', id: 'deckStage' });
  const panel = el('div', { class: 'deck-panel', id: 'deckPanel', hidden: true });
  box.replaceChildren(...(IN_APP ? [toolbar(c, deck), panel, wrap] : [editorShell(c, deck, panel, wrap)])); // the web: the Keynote-style shell (deck-shell.js)
  let url = view.urls.get(html);
  let useSrcdoc = false;
  if (!url) {
    wrap.append(el('div', 'art-loading', 'Drawing the slides…'));
    try {
      url = apiUrl((await api.artifact(html)).url);
      if (view.urls.size > 30) {
        const oldKey = view.urls.keys().next().value;
        const oldUrl = view.urls.get(oldKey);
        if (oldUrl && oldUrl.startsWith('blob:')) { try { URL.revokeObjectURL(oldUrl); } catch { /* ignore */ } }
        view.urls.delete(oldKey);
      }
      view.urls.set(html, url);
    } catch {
      try {
        url = URL.createObjectURL(new Blob([html], { type: 'text/html; charset=utf-8' }));
        view.urls.set(html, url);
      } catch {
        useSrcdoc = true;
      }
    }
    const curV = deckCanvasVersion();
    if (!curV || (IN_APP ? (curV !== v && (!curV.nodeId || curV.nodeId !== v.nodeId)) : (curV !== v || cur() !== c || view.renderToken !== renderToken))) return;
  }
  const frame = el('iframe', { sandbox: 'allow-scripts', ...(!IN_APP ? { allow: 'autoplay' } : {}), ...(useSrcdoc ? {} : { src: url }), title: `${tx('Slides')}: ${deck.title}`, referrerpolicy: 'no-referrer', class: 'deck-frame' });
  if (useSrcdoc) frame.srcdoc = html;
  wrap.replaceChildren(frame, el('button', { type: 'button', class: 'deck-exit', hidden: true, ...(!IN_APP ? { style: { minHeight: '40px', minWidth: '40px' } } : {}), onclick: exitPresent }, ico('x', 14), tx('Exit')));
  view.frame = frame;
  view.url = url;
  const miss = missingAlt(deck);
  if (miss.length) notice(`${miss.length} picture${miss.length === 1 ? ' needs' : 's need'} alt text (slide${miss.length === 1 ? '' : 's'} ${miss.map((i) => i + 1).join(', ')}): click “Picture…” on that slide to describe it.`);
}

function emptyState(c) {
  const file = el('input', { type: 'file', accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', hidden: true, onchange: () => { if (file.files[0]) importFile(file.files[0]); } });
  const hasChat = path(c).some((n) => n.role === 'assistant' && nodeText(n).trim());
  return el('div', 'deck-empty',
    el('h3', '', 'Slides'),
    el('p', '', 'Describe a deck below (Slides mode is on), attach a PDF, Word or PowerPoint file to build it from, or bring in a PowerPoint to restyle or continue.'),
    el('div', 'deck-empty-acts',
      hasChat ? el('button', { type: 'button', class: 'cap primary', onclick: () => artifactSend('Make a slide deck from this conversation: the main points, one idea per slide, with speaker notes.') }, ico('art', 14), 'Make slides from this chat') : null,
      !IN_APP ? el('button', { type: 'button', class: hasChat ? 'cap' : 'cap primary', 'data-deck': 'templates', onclick: () => openTemplates('deck') }, ico('art', 14), tx('Start from a template…')) : null,
      el('button', { type: 'button', class: 'cap', onclick: () => file.click() }, ico('doc', 14), 'Import a PowerPoint (.pptx)…'),
      file));
}

function notice(text, kids = []) {
  const p = $('deckPanel');
  if (!p) return;
  p.hidden = false;
  p.replaceChildren(el('div', 'grow', text, ...kids), el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', onclick: () => { p.hidden = true; } }, ico('x', 14)));
}

function toolbar(c, deck) {
  const cur = deck.theme.base;
  const themeSel = el('select', { 'aria-label': 'Theme', class: 'deck-theme', onchange: () => {
    if (themeSel.value === '__brand') { themeSel.value = cur; brandFile.click(); return; }
    if (themeSel.value === '__describe') { themeSel.value = cur; setComposerText('Restyle the deck for this brand: '); return; }
    commit(setTheme(deck, { base: themeSel.value }));
  } },
  ...Object.entries(THEMES).map(([id, th]) => el('option', { value: id, selected: id === cur && !deck.theme.colors ? true : null }, tx(th.name))),
  deck.theme.colors ? el('option', { value: cur, selected: true }, tx('Brand colors')) : null,
  el('option', { value: '__brand' }, tx('Brand from a PowerPoint…')),
  el('option', { value: '__describe' }, tx('Describe a brand…')));
  const brandFile = el('input', { type: 'file', accept: '.pptx', hidden: true, onchange: () => { if (brandFile.files[0]) importFile(brandFile.files[0], { themeOnly: true }); brandFile.value = ''; } });
  const pptxFile = el('input', { type: 'file', accept: '.pptx', hidden: true, onchange: () => { if (pptxFile.files[0]) importFile(pptxFile.files[0]); pptxFile.value = ''; } });
  const picFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: () => { if (picFile.files[0]) pictureFor(picFile.files[0]); picFile.value = ''; } });
  const btn = (icon, label, run, cls = 'cap') => el('button', { type: 'button', class: cls, 'data-deck': label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, ''), onclick: run }, icon ? ico(icon, 14) : null, label); // data-deck names it (the label is translated)
  return el('div', { class: 'deck-bar', role: 'toolbar', 'aria-label': 'Slides' },
    btn('play', 'Present', () => present()),
    btn(null, 'Presenter view', () => present({ presenter: true })),
    themeSel,
    btn('plus', 'Picture…', () => openPhotoStudio()),
    btn(null, 'Switch layout', () => { const d = currentDeck(); const i = view.index >= 0 ? view.index : 0; if (d) commit(cycleSlideLayout(d, i), { toastText: tx(`Switched layout on slide ${i + 1}`) }); }),
    btn(null, 'Playbook X/O', () => { const d = currentDeck(); const i = view.index >= 0 ? view.index : 0; if (d) commit(toggleSlidePlaybook(d, i), { toastText: tx(`Added X’s & O’s playbook diagram to slide ${i + 1}`) }); }),
    state.jarvis && state.jarvis.available ? btn('folder', 'From Mac…', () => browseMacPicture()) : null,
    btn('down', 'PowerPoint', () => exportPptx()),
    btn(null, 'PDF', () => exportPdf()),
    btn(null, 'Google Slides', () => googleSlides()),
    btn(null, 'Outline', () => { const d = currentDeck(); if (d) downloadBlob(new Blob([deckOutline(d)], { type: 'text/markdown' }), deckFileName(d.title, 'md')); }),
    btn('doc', 'Import .pptx', () => pptxFile.click()),
    btn('globe', 'Share', () => share()),
    brandFile, pptxFile, picFile);
}

// Web-only progressive editor; native builds keep their existing controls.
function addLocalSlide() {
  const d = currentDeck();
  const i = view.index >= 0 ? view.index : 0;
  if (!d) return;
  const next = insertSlide(d, i);
  if (next === d) { toast('This deck has reached its slide limit'); return; }
  view.index = i + 1;
  view.at = layoutDeck(next).findIndex((r) => r.index === i + 1);
  commit(next, { toastText: tx('Slide added — click its text to edit') });
}

// Templates (web only, deck-templates.js): starter decks and single slides; each pick is a version (Undo goes back).
function openTemplates(kind) {
  if (IN_APP) return;
  Promise.all([import('./deck-templates.js'), deckRender()])
    .then(([m, r]) => m.openTemplateGallery({ kind, deck: currentDeck(), deckDocument: r.deckDocument, tx, apply: (pick) => applyTemplate(m, pick) }))
    .catch(() => toast(tx('Templates couldn’t load. Try again.')));
}
function applyTemplate(m, { how, deck, slide, topic, template }) {
  const c = cur();
  if (!c) return;
  const d = currentDeck();
  if (how === 'start' || !d) {
    if (!deck) return;
    c.mode = 'slides';
    c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), kind: 'edit', src: 'template', deck });
    save(c);
    view.at = 0; view.index = 0;
    openDeck(c);
    toast(tx(`Started “${deck.title}”: click any text to make it yours`));
  } else if (how === 'replace') {
    keepFocus('tool:file'); // the redesigned editor opens templates from File
    view.at = 0; view.index = 0;
    commit(deck, { toastText: tx('Template applied'), src: 'template' });
  } else if (how === 'append') {
    const next = m.addTemplateSlides(d, deck);
    if (next === d) { toast(tx('This deck has reached its slide limit')); return; }
    keepFocus('tool:file'); // the redesigned editor opens templates from File
    commit(next, { toastText: tx(`Added ${next.slides.length - d.slides.length} slides`), src: 'template' });
  } else if (how === 'insert') {
    const i = view.index >= 0 ? view.index : d.slides.length - 1;
    const next = m.insertTemplateSlide(d, i, slide);
    if (next === d) { toast(tx('This deck has reached its slide limit')); return; }
    view.index = i + 1;
    view.at = layoutDeck(next).findIndex((r) => r.index === i + 1);
    keepFocus('tool:add-slide'); // …and a slide from a template from Add slide
    commit(next, { toastText: tx('Slide added — click its text to edit'), src: 'template' });
  }
  if (topic) ask(m.fillPrompt(topic, template));
}

/** The focused control, kept across the redraw each edit causes, so picking a theme or layout leaves the Inspector as
 *  it was with focus where it was. (tools.open: kept for the iPhone app's bar, which has no trays.) */
const tools = { open: '', focus: '' };
const keepFocus = (key) => { tools.focus = key; const n = tools.seq = (tools.seq || 0) + 1; setTimeout(() => { if (tools.seq === n) tools.focus = ''; }, 2000); }; // only for the redraw this click causes (an older click's timer never clears a newer key)

// ── the web editor: a Keynote-style shell (deck-shell.js; contract: research_notes/slides-redesign/inspector-api.md) ──
// A slim toolbar, the navigator and canvas (inside the frame), and an Inspector whose Format / Animate / Document tabs
// follow the selection. Every control the old trays had lives here (the map is in the contract). Web only.
const files = {}; // the hidden file pickers of the shown editor
const pickFile = (accept, run) => el('input', { type: 'file', accept, hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) run(f); } });
const shellHost = {
  currentDeck: () => currentDeck(), cur: () => cur(), commit: (d, o) => commit(d, o), frame: () => view.frame,
  storeImage: (id, data, w, h) => { const c = cur(); if (c) storeImage(c, id, data, w, h); }, keepFocus: (k) => keepFocus(k), notice: (t, k) => notice(t, k),
  actions: {
    present: () => present(), exitPresent: () => exitPresent(), presenterView: () => present({ presenter: true }), addSlide: () => addLocalSlide(),
    slideAction: (name, i = slideAt()) => { const d = currentDeck(); if (d) slideAction(name, d, i); },
    openPhotoStudio: (i, o) => openPhotoStudio(i, o), photoTools: (i) => photoTools(i), openMedia: (i = slideAt()) => openMediaPanel(i),
    openTemplates: (kind = 'deck') => openTemplates(kind), exportPptx: () => exportPptx(), exportPdf: (o) => exportPdf(o), googleSlides: () => googleSlides(),
    outline: () => { const d = exportDeck(currentDeck()); if (d) downloadBlob(new Blob([deckOutline(d)], { type: 'text/markdown' }), deckFileName(d.title, 'md')); },
    share: () => share(), importPptx: () => files.pptx && files.pptx.click(), brandFromPptx: () => files.brand && files.brand.click(),
    resize: () => openDeckTool('resize'), translate: () => openDeckTool('translate'), ask: (text) => ask(text), chat: () => showChat(true),
    record: () => openRecorder({ present: () => present(), stage: () => $('deckStage'), notice, title: () => (currentDeck() || {}).title, downloadBlob, toast, tx }),
  },
};
function editorShell(c, deck, panel, stage) {
  files.brand = pickFile('.pptx', (f) => importFile(f, { themeOnly: true }));
  files.pptx = pickFile('.pptx', (f) => importFile(f));
  files.pic = pickFile('image/png,image/jpeg,image/gif,image/webp', (f) => pictureFor(f));
  const root = shellKit.mountShell({ stage, panel, host: shellHost, extra: [files.brand, files.pptx, files.pic], trailing: [presenceBar()] });
  shellKit.select({ slide: slideAt(), at: view.at });
  setTimeout(() => { // after the redraw puts the editor in the page
    const key = tools.focus;
    tools.focus = '';
    const back = key && [...root.querySelectorAll('[data-key]')].find((b) => b.dataset.key === key);
    const lost = !document.activeElement || document.activeElement === document.body; // never taken from the slide or the chat
    if (back && lost) { back.focus({ preventScroll: true }); back.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }, 0);
  return root;
}
/** The editor opens beside the chat, like the browser pane (owner, 2026-10-24); Full Screen in the toolbar (or View)
 *  fills the window only when asked, and is never remembered. */
function enterEditor() {}
const editorWide = () => !!(typeof document !== 'undefined' && $('artifact') && $('artifact').classList.contains('full'));
function showChat(show) {
  setWide(!show);
  if (show) setTimeout(() => { const ta = document.querySelector('#composer textarea, #input, textarea'); if (ta) ta.focus(); }, 50);
  refreshShell();
}
const refreshShell = () => { shellKit.refreshToolbar(); shellKit.context().refresh(); };

function themeSelect(deck) {
  const base = deck.theme.base;
  const s = el('select', { 'aria-label': tx('Theme'), class: 'deck-theme', 'data-key': 'theme-select', onchange: () => {
    keepFocus('theme-select');
    if (s.value === '__brand') { s.value = base; files.brand.click(); return; }
    if (s.value === '__describe') { s.value = base; setComposerText('Restyle the deck for this brand: '); showChat(true); return; }
    commit(setTheme(currentDeck(), { base: s.value }));
  } },
  ...Object.entries(THEMES).map(([id, th]) => el('option', { value: id, selected: id === base && !deck.theme.colors ? true : null }, tx(th.name))),
  deck.theme.colors ? el('option', { value: base, selected: true }, tx('Brand colors')) : null,
  el('option', { value: '__brand' }, tx('Brand from a PowerPoint…')),
  el('option', { value: '__describe' }, tx('Describe a brand…')));
  return s;
}
const slideHas = (i, f) => { const d = currentDeck(); const s = d && d.slides[i]; return !!(s && f(s, d)); };
const btnRow = (...b) => el('div', { class: 'dsh-btns' }, ...b);
/** Insert a slide of a kind (a table or chart to fill in) after the selected one. */
function insertKind(kind) {
  const d = currentDeck();
  if (!d) return;
  const i = slideAt();
  const slide = kind === 'table'
    ? { layout: 'table', title: tx('Table'), table: { header: [tx('Item'), tx('Value')], rows: [[tx('First'), '1'], [tx('Second'), '2'], [tx('Third'), '3']] } }
    : { layout: 'chart', title: tx('Chart'), chart: { type: kind === 'pie' ? 'pie' : kind === 'line' ? 'line' : 'bar', labels: ['2023', '2024', '2025'], series: [{ name: tx('Value'), values: [3, 5, 8] }] }, caption: tx('Click any text to edit it') };
  import('./deck-templates.js').then((m) => {
    const next = m.insertTemplateSlide(currentDeck(), i, slide);
    if (next === currentDeck()) { toast(tx('This deck has reached its slide limit')); return; }
    view.index = i + 1;
    view.at = layoutDeck(next).findIndex((r) => r.index === i + 1);
    commit(next, { toastText: kind === 'table' ? tx('Table slide added — click a cell to edit') : tx('Chart slide added — click a label to edit') });
  }, () => toast(tx('That couldn’t load. Try again.')));
}

function registerEditor(S) {
  const { registerTool: tool, registerInspector: section, registerInspectorTab, registerContextMenu: menuFor, registerShortcut: key, kit } = S;
  const { button, listRow, segmented } = kit;
  const i0 = () => slideAt();
  // toolbar: View · Add Slide, Play │ Table, Chart, Text, Shape, Media, Comment │ Collaborate, File │ Format, Animate, Document
  tool({ id: 'view', group: 'view', order: 10, label: tx('View'), icon: 'sidebar', menu: () => S.menuItems('view', {}, [
    { label: tx('Navigator'), checked: S.ui.nav === 'list', run: () => S.setNavigator('list') },
    { label: tx('Light Table'), checked: S.ui.nav === 'grid', run: () => S.setNavigator('grid') },
    { label: tx('Slide Only'), checked: S.ui.nav === 'hidden', run: () => S.setNavigator('hidden') },
    { separator: true },
    { label: tx('Presenter Notes'), checked: S.ui.notes, run: () => S.setNotes(!S.ui.notes) },
    { label: tx('Inspector'), checked: S.ui.open, shortcut: 'Mod+Alt+0', run: () => S.openInspector(S.ui.tab, { toggle: true }) },
    { separator: true },
    { label: editorWide() ? tx('Back to the Chat') : tx('Full Screen'), icon: editorWide() ? 'eden' : 'resize', run: () => showChat(editorWide()) },
  ]) });
  // beside the chat: Full Screen; in full screen: Eden (its logo) brings the chat back
  tool({ id: 'chat', group: 'view', order: 20, label: tx('Full Screen'), icon: 'resize', title: tx('Fill the window with the slides'), when: () => !isMobile() && !editorWide(), run: () => showChat(false) });
  tool({ id: 'eden', group: 'view', order: 19, label: tx('Eden'), icon: 'eden', title: tx('Back to the chat with Eden'), when: () => !isMobile() && editorWide(), run: () => showChat(true) });
  tool({ id: 'add-slide', group: 'slide', order: 10, primary: true, label: tx('Add Slide'), icon: 'add-slide', shortcut: 'Mod+Alt+N', popover: (ctx, close) => el('div', { class: 'dsh-menu-list' },
    el('p', { class: 'dsh-pop-title' }, tx('Add a slide after this one')),
    listRow({ icon: 'add-slide', label: tx('Blank slide'), detail: shellKit.formatKeys('Mod+Alt+N'), key: 'add:blank', onClick: () => { close(); addLocalSlide(); } }),
    listRow({ icon: 'templates', label: tx('From a template…'), detail: tx('Title, agenda, timeline, team…'), onClick: () => { close(); openTemplates('slide'); } }),
    listRow({ icon: 'table', label: tx('Table'), onClick: () => { close(); insertKind('table'); } }),
    listRow({ icon: 'chart', label: tx('Chart'), onClick: () => { close(); insertKind('chart'); } }),
    listRow({ icon: 'sparkles', label: tx('Ask Eden to write one…'), detail: tx('Say what it’s about in the chat'), onClick: () => { close(); showChat(true); slideAction('add-ai', currentDeck(), i0()); } })) });
  tool({ id: 'play', group: 'slide', order: 20, label: tx('Play'), icon: 'play', shortcut: 'Mod+Alt+P', menu: () => S.menuItems('play', {}, [
    { label: tx('Play Slideshow'), icon: 'play', shortcut: 'Mod+Alt+P', run: () => present() },
    { label: tx('Presenter View'), icon: 'presenter', run: () => present({ presenter: true }) },
    ...(canRecord() ? [{ label: tx('Record a Presentation…'), icon: 'record', run: () => shellHost.actions.record() }] : []),
  ]) });
  tool({ id: 'table', group: 'insert', order: 10, label: tx('Table'), icon: 'table', title: tx('Add a table slide'), run: () => insertKind('table') });
  tool({ id: 'chart', group: 'insert', order: 20, label: tx('Chart'), icon: 'chart', popover: (ctx, close) => el('div', { class: 'dsh-menu-list' },
    el('p', { class: 'dsh-pop-title' }, tx('Add a chart slide')),
    ...[['bar', 'Column'], ['line', 'Line'], ['pie', 'Pie']].map(([k, l]) => listRow({ icon: 'chart', label: tx(l), onClick: () => { close(); insertKind(k); } })),
    el('p', { class: 'dsh-hint', style: { margin: '6px 8px 2px' } }, tx('Edit the numbers on the slide, or ask Eden to chart your data.'))) });
  tool({ id: 'text', group: 'insert', order: 30, label: tx('Text'), icon: 'text', shortcut: 'Mod+Alt+T', title: tx('Add a text box'), run: () => { freeformPanel(freeCtx(), { part: 'insert' }); insertFree('text'); } });
  tool({ id: 'shape', group: 'insert', order: 40, label: tx('Shape'), icon: 'shape', popover: () => freeformPanel(freeCtx(), { part: 'insert' }) });
  tool({ id: 'media', group: 'insert', order: 50, label: tx('Media'), icon: 'media', popover: (ctx, close) => el('div', { class: 'dsh-menu-list' },
    el('p', { class: 'dsh-pop-title' }, `${tx('Picture or clip on slide')} ${i0() + 1}`),
    listRow({ icon: 'search', label: tx('Photo from the web…'), onClick: () => { close(); openPhotoStudio(); } }),
    listRow({ icon: 'photo', label: tx('Picture from this device…'), onClick: () => { close(); files.pic.click(); } }),
    listRow({ icon: 'grid', label: tx('Stock library…'), detail: tx('Photos, icons, video and music'), onClick: () => { close(); openStockLibrary(); } }),
    listRow({ icon: 'video', label: tx('Video or audio…'), onClick: () => { close(); openMediaPanel(i0()); } }),
    listRow({ icon: 'sparkles', label: tx('AI visual…'), onClick: () => { close(); openPhotoStudio(i0(), { mode: 'ai' }); } }),
    slideHas(i0(), (s) => s.image) ? listRow({ icon: 'wand', label: tx('Photo tools…'), detail: tx('Remove background, upscale, erase'), onClick: () => { close(); photoTools(); } }) : null,
    state.jarvis && state.jarvis.available ? listRow({ icon: 'folder', label: tx('From your Mac…'), onClick: () => { close(); browseMacPicture(); } }) : null) });
  tool({ id: 'comment', group: 'insert', order: 60, label: tx('Comment'), icon: 'comment', shortcut: 'Mod+Alt+K', domId: 'deck-tools-comments-button', pressed: () => S.ui.open && S.ui.tab === 'comments', run: () => S.openInspector('comments', { toggle: true }) });
  tool({ id: 'collaborate', group: 'collab', order: 10, label: tx('Collaborate'), icon: 'collaborate', popover: (ctx, close) => el('div', { class: 'dsh-menu-list' },
    el('p', { class: 'dsh-pop-title' }, tx('Work on this deck with others')),
    listRow({ icon: 'collaborate', label: tx('Edit together…'), detail: tx('Live editing links, comments and tasks'), onClick: () => { close(); S.openInspector('comments'); setTimeout(() => { const t = document.querySelector('.deck-cm-together'); if (t) { t.scrollIntoView({ block: 'nearest' }); const b = t.querySelector('button'); if (b) b.focus(); } }, 60); } }),
    listRow({ icon: 'share', label: tx('Publish a view-only link…'), onClick: () => { close(); share(); } }),
    ...shellKit.menuItems('share').filter((it) => it.label).map((it) => listRow({ icon: it.icon || 'share', label: it.label, detail: it.detail || '', onClick: () => { close(); if (it.run) it.run(shellKit.context()); } }))) });
  tool({ id: 'file', group: 'collab', order: 20, label: tx('File'), icon: 'folder', menu: () => S.menuItems('file', {}, [
    { label: tx('New from Template…'), icon: 'templates', run: () => openTemplates('deck') },
    { label: tx('Import PowerPoint…'), icon: 'import', run: () => files.pptx.click() },
    { label: tx('Brand from a PowerPoint…'), icon: 'theme', run: () => files.brand.click() },
    { separator: true }, { heading: tx('Export') },
    { label: tx('PowerPoint (.pptx)'), icon: 'download', shortcut: 'Mod+Alt+E', run: () => exportPptx() },
    { label: tx('PDF…'), icon: 'document', run: () => exportPdf() },
    { label: tx('Google Slides…'), icon: 'globe', run: () => googleSlides() },
    { label: tx('Outline (Markdown)'), icon: 'notes', run: () => shellHost.actions.outline() },
    { separator: true },
    { label: tx('Magic Resize…'), icon: 'resize', run: () => openDeckTool('resize') },
    { label: tx('Translate…'), icon: 'globe', run: () => openDeckTool('translate') },
    { separator: true },
    { label: tx('Publish a View-Only Link…'), icon: 'share', run: () => share() },
  ]) });
  for (const [id, label, ic, n] of [['format', 'Format', 'format', 1], ['animate', 'Animate', 'animate', 2], ['document', 'Document', 'document', 3]]) {
    tool({ id, group: 'inspector', order: n * 10, label: tx(label), icon: ic, shortcut: `Mod+Alt+${n}`, pressed: () => S.ui.open && S.ui.tab === id, run: () => S.openInspector(id, { toggle: true }) });
    key({ id: `inspector-${id}`, keys: `Mod+Alt+${n}`, label: `${tx('Show')} ${tx(label)}`, run: () => S.openInspector(id) });
  }
  registerInspectorTab({ id: 'comments', title: 'Comments', icon: 'comment', order: 40 });

  // Inspector › Format: what you can do to the selection
  section({ id: 'welcome', tab: 'format', order: 0, render: () => S.hint('welcome', tx('Click anything on the slide to change it here. Right-click a slide or thumbnail for more. Tooltips show each shortcut.')) });
  section({ id: 'free-style', tab: 'format', order: 20, title: 'Arrange & Style', when: (s) => s.kind === 'element', render: () => freeformPanel(freeCtx(), { part: 'style' }) });
  section({ id: 'text-basic', tab: 'format', order: 20, title: 'Text', when: (s) => s.kind === 'text', render: (ctx) => el('div', { class: 'dsh-sec-body' },
    el('p', '', ctx.selection.textPath === 'notes' ? tx('Presenter notes show in Presenter View, never on the slide.') : tx('Type on the slide. Return or a click elsewhere keeps it; Escape cancels.'))) });
  section({ id: 'slide-layout', tab: 'format', order: 10, title: 'Slide Layout', when: (s) => s.kind !== 'element', render: (ctx) => {
    const d = ctx.deck; const i = ctx.selection.slide;
    if (!d || !d.slides[i]) return null;
    const box = el('div', { class: 'deck-choices dsh-choices', id: 'deckLayoutChoices', role: 'group', 'aria-label': tx('Slide layouts'), 'aria-describedby': 'deckLayoutHint' });
    updateLayoutChoices(d, i, box);
    return el('div', { class: 'dsh-sec-body' }, el('p', { id: 'deckLayoutHint', class: 'sr-only' }, tx('Only layouts supported by this slide’s content are shown. Other content is kept; Undo restores the previous view.')), box,
      btnRow(button({ label: tx('Next layout'), key: 'btn:switch-layout', onClick: () => slideAction('layout', currentDeck(), i) }), button({ label: tx('Playbook X/O'), key: 'btn:playbook-x-o', onClick: () => slideAction('playbook', currentDeck(), i) })));
  } });
  section({ id: 'slide-picture', tab: 'format', order: 30, title: 'Picture & Media', when: (s) => s.kind === 'slide', render: (ctx) => {
    const i = ctx.selection.slide, has = slideHas(i, (s) => s.image);
    return btnRow(button({ icon: 'photo', label: has ? tx('Replace…') : tx('Picture…'), key: 'btn:picture', onClick: () => openPhotoStudio(i) }),
      has ? button({ icon: 'wand', label: tx('Photo tools…'), key: 'btn:photo-tools', onClick: () => photoTools(i) }) : null,
      button({ icon: 'video', label: tx('Video or audio…'), key: 'btn:video-or-audio', onClick: () => openMediaPanel(i) }));
  } });
  section({ id: 'slide-actions', tab: 'format', order: 80, title: 'Slide', when: (s) => s.kind !== 'element', render: (ctx) => {
    const i = ctx.selection.slide, n = ctx.deck ? ctx.deck.slides.length : 0;
    const a = (k) => () => slideAction(k, currentDeck(), i);
    return btnRow(button({ icon: 'duplicate', label: tx('Duplicate'), shortcut: 'Mod+Alt+D', key: 'btn:duplicate', onClick: a('dup') }), button({ icon: 'trash', label: tx('Delete'), key: 'btn:delete-slide', disabled: n < 2, onClick: a('delete') }),
      button({ icon: 'up', label: tx('Move up'), key: 'btn:move-up', disabled: i < 1, onClick: a('up') }), button({ icon: 'down', label: tx('Move down'), key: 'btn:move-down', disabled: i >= n - 1, onClick: a('down') }));
  } });
  section({ id: 'slide-ai', tab: 'format', order: 90, title: 'Ask Eden', when: (s) => s.kind !== 'element', render: (ctx) => {
    const i = ctx.selection.slide;
    return btnRow(...[['shorter', 'Shorter'], ['expand', 'Expand'], ['regen', 'Regenerate'], ['ai-visual', 'AI visual']].map(([k, l]) => button({ label: tx(l), key: `btn:${k}`, icon: k === 'regen' ? 'sparkles' : k === 'ai-visual' ? 'photo' : null, onClick: () => slideAction(k, currentDeck(), i) })));
  } });

  // Inspector › Animate
  section({ id: 'transition-deck', tab: 'animate', order: 10, title: 'Slide Transition', render: (ctx) => {
    const d = ctx.deck; if (!d) return null;
    const i = ctx.selection.slide;
    const sel = el('select', { class: 'deck-theme', id: 'deckSlideTransition', 'data-key': 'slide-transition', 'aria-label': tx('Transition into the selected slide'), onchange: (e) => { keepFocus('slide-transition'); pickMotion(setSlideMotion(currentDeck(), slideAt(), { transition: e.target.value })); } });
    const builds = el('div', { class: 'deck-choices dsh-choices', id: 'deckBuilds', role: 'group', 'aria-label': tx('How the selected slide’s content arrives') });
    const box = el('div', { class: 'dsh-sec-body' },
      el('h4', '', tx('Whole deck')),
      choiceRow('deckTransitions', tx('Deck transitions'), TRANSITIONS.map((id) => [id, MOTION_LABEL[id], MOTION_ICON[id]]), d.motion && d.motion.transition || 'none', (id) => setMotion(currentDeck(), { transition: id }), 'tr'),
      S.kit.row(tx('Speed'), speedSel(d)),
      el('h4', '', `${tx('Into slide')} ${i + 1}`), S.kit.row(tx('Transition'), sel),
      el('h4', '', tx('Build in')), builds,
      el('p', { id: 'deckMotionHint' }, tx('Plays when you present. One by one: each Next shows the next piece.')),
      btnRow(button({ icon: 'play', label: tx('Preview'), key: 'btn:preview', onClick: () => { if (view.frame) view.frame.contentWindow.postMessage({ type: 'deck-preview' }, '*'); } }),
        button({ label: tx('Use on every slide'), key: 'btn:use-on-every-slide', onClick: () => { const dd = currentDeck(); if (dd) { const m = motionOf(dd, dd.slides[slideAt()]); pickMotion(setSlideMotion(dd, 0, { build: m.build, transition: 'deck' }, { all: true }), tx('Every slide now arrives the same way')); } } })));
    box.querySelector('#deckTransitions').classList.add('dsh-choices');
    updateMotionChoices(d, i, box);
    return box;
  } });

  // Inspector › Document: the whole deck's look
  section({ id: 'theme', tab: 'document', order: 10, title: 'Theme', render: (ctx) => {
    const d = ctx.deck; if (!d) return null;
    return el('div', { class: 'dsh-sec-body' }, S.kit.row(tx('Theme'), themeSelect(d)),
      el('div', { class: 'deck-choices dsh-choices', role: 'group', 'aria-label': tx('Deck themes') },
        ...Object.entries(THEMES).map(([id, th]) => el('button', { type: 'button', class: 'deck-choice', 'data-key': `theme:${id}`, 'aria-pressed': String(id === d.theme.base && !d.theme.colors), onclick: () => { const dd = currentDeck(); keepFocus(`theme:${id}`); if (dd) commit(setTheme(dd, { base: id }), { toastText: tx('Theme updated') }); } },
          el('span', { class: 'deck-swatch', 'aria-hidden': 'true', style: { background: th.colors.bg, color: th.colors.text, borderColor: th.colors.accent } }, 'Aa', el('span', { style: { background: th.colors.accent } }, '')),
          tx(th.name)))));
  } });
  section({ id: 'brand', tab: 'document', order: 20, title: 'Brand Kit', render: (ctx) => ctx.deck ? brandRow(ctx.deck, { currentDeck, commit, keepFocus, btn: (icon, label, run) => button({ label: tx(label), key: `btn:${label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, '')}`, onClick: run }), storeImage: (id, data, w, h) => { const c = cur(); if (c) storeImage(c, id, data, w, h); } }) : null });
  section({ id: 'deck-tools', tab: 'document', order: 80, title: 'Deck', render: () => btnRow(
    button({ icon: 'resize', label: tx('Magic Resize…'), key: 'btn:resize', onClick: () => openDeckTool('resize') }),
    button({ icon: 'globe', label: tx('Translate…'), key: 'btn:translate', onClick: () => openDeckTool('translate') }),
    button({ icon: 'templates', label: tx('Templates…'), key: 'btn:templates', onClick: () => openTemplates('deck') }),
    button({ icon: 'download', label: tx('Export…'), key: 'btn:export', onClick: (e) => S.menu(e.currentTarget, S.menuItems('file', {}, [{ label: tx('PowerPoint (.pptx)'), run: () => exportPptx() }, { label: tx('PDF…'), run: () => exportPdf() }, { label: tx('Google Slides…'), run: () => googleSlides() }, { label: tx('Outline (Markdown)'), run: () => shellHost.actions.outline() }]), { label: tx('Export') }) })) });
  section({ id: 'comments', tab: 'comments', order: 10, render: () => commentsPanel() });

  // right-click menus
  const slideMenu = (ctx) => { const i = Number.isInteger(ctx.index) && ctx.index >= 0 ? ctx.index : slideAt(); const n = (currentDeck() || { slides: [] }).slides.length; const a = (k) => () => slideAction(k, currentDeck(), i); return [
    { label: tx('New Slide'), icon: 'add-slide', shortcut: 'Mod+Alt+N', run: () => { view.index = i; addLocalSlide(); } },
    { label: tx('Duplicate Slide'), icon: 'duplicate', shortcut: 'Mod+Alt+D', run: a('dup') },
    { label: tx('Delete Slide'), icon: 'trash', disabled: n < 2, danger: true, run: a('delete') },
    { separator: true },
    { label: tx('Move Up'), icon: 'up', disabled: i < 1, run: a('up') }, { label: tx('Move Down'), icon: 'down', disabled: i >= n - 1, run: a('down') },
    { separator: true },
    { label: tx('Change Layout…'), icon: 'layout', run: () => S.openInspector('format') },
    { label: tx('Transition…'), icon: 'animate', run: () => S.openInspector('animate') },
    { label: tx('Play from This Slide'), icon: 'play', run: () => present() },
  ]; };
  menuFor({ id: 'slide-core', target: 'thumb', order: 10, items: slideMenu });
  menuFor({ id: 'slide-core', target: 'slide', order: 10, items: (ctx) => [
    { label: tx('Picture…'), icon: 'photo', run: () => openPhotoStudio(Number.isInteger(ctx.index) && ctx.index >= 0 ? ctx.index : slideAt()) },
    { separator: true }, ...slideMenu(ctx)] }); // (commenting is the arrange menu's Add Comment…)
  menuFor({ id: 'text-core', target: 'text', order: 10, items: () => [{ label: tx('Format…'), icon: 'format', run: () => S.openInspector('format') }] });
  menuFor({ id: 'element-core', target: 'element', order: 10, items: () => [{ label: tx('Format…'), icon: 'format', run: () => S.openInspector('format') }] });

  // shortcuts (⌘ on a Mac, Ctrl elsewhere; ⌥⌘ avoids the browser's own ⌘N, ⌘T, ⌘D and ⌥⌘I)
  key({ id: 'add-slide', keys: 'Mod+Alt+N', label: tx('Add a slide'), run: () => addLocalSlide() });
  key({ id: 'play', keys: 'Mod+Alt+P', label: tx('Play'), run: () => present() });
  key({ id: 'inspector', keys: 'Mod+Alt+0', label: tx('Show or hide the Inspector'), run: () => S.openInspector(S.ui.tab, { toggle: true }) });
  key({ id: 'text-box', keys: 'Mod+Alt+T', label: tx('Add a text box'), run: () => { freeformPanel(freeCtx(), { part: 'insert' }); insertFree('text'); } });
  key({ id: 'duplicate', keys: 'Mod+Alt+D', label: tx('Duplicate the slide'), run: () => slideAction('dup', currentDeck(), slideAt()) });
  key({ id: 'comment', keys: 'Mod+Alt+K', label: tx('Comments'), run: () => S.openInspector('comments') });
  key({ id: 'export', keys: 'Mod+Alt+E', label: tx('Export PowerPoint'), run: () => exportPptx() });
}
const freeCtx = () => ({ currentDeck, cur, slideAt, storeImage, commit, keepFocus, shrinkPicture, frame: () => view.frame });
/** The stock library (photos, icons, video, music) in a sheet: picks land on the selected slide. */
function openStockLibrary() {
  shellKit.kit.sheet({ title: tx('Stock Library'), wide: true, content: mediaPanel({ currentDeck, cur, slideAt, storeImage, commit, setImage, keepFocus }) });
}
if (!IN_APP) {
  registerEditor(shellKit);
  addEventListener('message', (e) => { // the frame's selection, right-clicks, shortcuts and navigator view (deck-shell-frame.js)
    const f = view.frame;
    if (!f || e.source !== f.contentWindow) return;
    const m = e.data && typeof e.data === 'object' ? e.data : {};
    if (typeof m.type !== 'string') return;
    if (m.type === 'deck-ready') { shellKit.frameReady(); const fsel = freeSelection(); if (fsel.ids.length && fsel.index === slideAt()) shellKit.select({ slide: fsel.index, elementIds: fsel.ids }); }
    else if (m.type === 'deck-at') { if (Number.isInteger(m.index) && m.index >= 0) shellKit.select({ slide: m.index, at: m.k }); }
    else shellKit.frameMessage(m, currentDeck());
  });
}

// ── motion (web only): transitions and builds, drawn when presenting (deck-render.js) and kept in the PowerPoint ──
const MOTION_LABEL = { none: 'None', fade: 'Fade', push: 'Push', wipe: 'Wipe', zoom: 'Zoom', rise: 'Rise', steps: 'One by one' };
const MOTION_ICON = { none: '—', fade: '◐', push: '⇢', wipe: '▶|', zoom: '⤢', rise: '⇡', steps: '⋯' };
const BUILD_LABEL = { none: 'All at once', fade: 'Fade in', rise: 'Rise', steps: 'One by one' };
const slideAt = () => (view.index >= 0 ? view.index : 0);
/** A motion change: saved like any edit, then played in the redrawn slide. */
function pickMotion(next, toastText = tx('Animation updated')) {
  if (!next) return;
  view.previewNext = true;
  commit(next, { toastText });
}
function speedSel(deck) {
  const cur = (deck.motion && deck.motion.speed) || 'medium';
  return el('select', { class: 'deck-theme', 'data-key': 'speed', 'aria-label': tx('Transition speed'), onchange: (e) => { keepFocus('speed'); pickMotion(setMotion(currentDeck(), { speed: e.target.value })); } },
    ...SPEEDS.map((id) => el('option', { value: id, selected: id === cur ? true : null }, tx(id[0].toUpperCase() + id.slice(1)))));
}
function choiceRow(id, label, choices, current, make, key) {
  const row = el('div', { class: 'deck-choices', id, role: 'group', 'aria-label': label });
  fillChoices(row, choices, current, make, key);
  return row;
}
function fillChoices(row, choices, current, make, key) {
  row.replaceChildren(...choices.map(([id, name, icon]) => el('button', { type: 'button', class: 'deck-choice', 'data-key': `${key}:${id}`, 'aria-pressed': String(id === current), onclick: () => { keepFocus(`${key}:${id}`); const d = currentDeck(); if (d) pickMotion(make(id)); } },
    el('span', { class: 'deck-layout-icon', 'aria-hidden': 'true' }, icon), tx(name))));
}
/** The selected slide's own transition and build, after it changes. */
function updateMotionChoices(deck, i, root = document) {
  const sel = root.querySelector('#deckSlideTransition'), builds = root.querySelector('#deckBuilds');
  const s = deck.slides[i];
  if (!s || !sel || !builds) return;
  const deckTr = (deck.motion && deck.motion.transition) || 'none';
  sel.replaceChildren(el('option', { value: 'deck', selected: !s.transition ? true : null }, `${tx('Same as deck')} (${tx(MOTION_LABEL[deckTr])})`),
    ...TRANSITIONS.map((id) => el('option', { value: id, selected: s.transition === id ? true : null }, tx(MOTION_LABEL[id]))));
  fillChoices(builds, BUILDS.map((id) => [id, BUILD_LABEL[id], MOTION_ICON[id]]), motionOf(deck, s).build, (id) => setSlideMotion(currentDeck(), i, { build: id }), 'build');
}

function updateLayoutChoices(deck, i, box = $('deckLayoutChoices')) {
  if (!box || !deck.slides[i]) return;
  const symbols = { title: '▰ ━', section: '━', bullets: '☰', grid: '▦', 'two-column': '▥', image: '▧', chart: '▥', table: '▦', diagram: '□ → □', playbook: 'X → O', quote: '“ ”', stats: '123', sources: '☷' };
  box.replaceChildren(...slideLayouts(deck.slides[i]).map((layout) => el('button', { type: 'button', class: 'deck-choice', 'data-key': `layout:${layout}`, 'aria-pressed': String(deck.slides[i].layout === layout), onclick: () => { const d = currentDeck(); keepFocus(`layout:${layout}`); if (d) commit(setSlideLayout(d, i, layout), { toastText: tx('Layout updated') }); } }, el('span', { class: 'deck-layout-icon', 'aria-hidden': 'true' }, symbols[layout]), tx(layout.replace(/-/g, ' ')))));
}

// ── messages from the deck frame ──

addEventListener('message', (e) => {
  const f = view.frame;
  if (!f || e.source !== f.contentWindow) return;
  const m = e.data && typeof e.data === 'object' ? e.data : {};
  const deck = currentDeck();
  if (!deck) return;
  const idx = Number.isInteger(m.index) && m.index >= 0 && m.index < deck.slides.length ? m.index : -1;
  switch (m.type) {
    case 'deck-ready':
      if (view.pending) { for (const msg of view.pending) f.contentWindow.postMessage(msg, '*'); view.pending = null; }
      if (view.previewNext) { view.previewNext = false; f.contentWindow.postMessage({ type: 'deck-preview' }, '*'); } // a motion just picked: show it
      if (view.editNext) { f.contentWindow.postMessage({ type: 'deck-edit', ...view.editNext }, '*'); view.editNext = null; } // Tab in a table cell: on to the next one (deck-format)
      if (!IN_APP) presentFrameReady(); // rehearsal targets and live results (deck-present.js)
      break;
    case 'deck-at': if (Number.isInteger(m.k) && m.k >= 0) { view.at = m.k; view.index = idx; if (!IN_APP) { updateLayoutChoices(deck, idx); updateMotionChoices(deck, idx); presentAt(m.k, idx); } } break;
    case 'deck-text':
      if (idx < 0 || !editablePath(m.path) || typeof m.value !== 'string' || m.value.length > 5000) return;
      view.editNext = !IN_APP && typeof m.next === 'string' && editablePath(m.next) ? { index: idx, path: m.next } : null;
      commit(setText(deck, idx, m.path, m.value));
      break;
    case 'deck-move': {
      const from = Number.isInteger(m.from) ? m.from : -1, to = Number.isInteger(m.to) ? m.to : -1;
      if (from < 0 || to < 0 || from >= deck.slides.length || to >= deck.slides.length) return;
      commit(moveSlide(deck, from, to));
      break;
    }
    case 'deck-delete': if (idx >= 0 && deck.slides.length > 1) commit(deleteSlide(deck, idx), { toastText: tx(`Slide ${idx + 1} deleted`) }); break;
    case 'deck-act': slideAction(String(m.act || ''), deck, idx); break;
    case 'deck-undo': (m.redo ? $('artNext') : $('artPrev')).click(); break;
    case 'deck-exit': exitPresent(); break;
    default: if (!IN_APP) richMessage(m, deck, idx); break; // rich text (deck-rich-ui.js): selection, format keys, links
  }
});

function slideAction(act, deck, i) {
  if (i < 0) return;
  if (act === 'up' && i > 0) commit(moveSlide(deck, i, i - 1));
  else if (act === 'down' && i < deck.slides.length - 1) commit(moveSlide(deck, i, i + 1));
  else if (act === 'dup') commit(duplicateSlide(deck, i));
  else if (act === 'delete' && deck.slides.length > 1) commit(deleteSlide(deck, i), { toastText: tx(`Slide ${i + 1} deleted`) });
  else if (act === 'layout') commit(cycleSlideLayout(deck, i), { toastText: tx(`Switched layout on slide ${i + 1}`) });
  else if (act === 'playbook') commit(toggleSlidePlaybook(deck, i), { toastText: tx(`Added X’s & O’s playbook diagram to slide ${i + 1}`) });
  else if (act === 'photo') openPhotoStudio(i);
  else if (act === 'ai-visual') openPhotoStudio(i, { mode: 'ai' });
  else if (act === 'add' && !IN_APP) addLocalSlide();
  else if (act === 'add' || act === 'add-ai') { setComposerText(`${slideRequest('add', deck, i).replace(/ that follows from it\.$/, '').replace(/\.$/, '')} about `); toast('Say what the new slide is about, then send'); }
  else if (act === 'regen' || act === 'shorter' || act === 'expand') ask(slideRequest(act, deck, i));
}

function ask(text) {
  const c = cur();
  if (!c) return;
  if (state.streams.has(c.id)) { toast('Wait for the current reply to finish'); return; }
  if (c.mode !== 'slides') { c.mode = 'slides'; save(c); }
  artifactSend(text);
}

// ── present ──

function present({ presenter = false } = {}) {
  const f = view.frame;
  if (!f) { toast('The slides are still loading'); return; }
  const stage = $('deckStage');
  if (!stage || (!IN_APP && view.presenting)) return;
  const session = view.presentSession = {};
  if (!IN_APP) {
    view.returnFocus = document.activeElement;
    stage.querySelector('.deck-exit').hidden = false;
  }
  view.presenting = true;
  const mode = { type: 'deck-mode', mode: 'present', presenter };
  let full;
  try { full = !presenter && stage.requestFullscreen ? Promise.resolve(stage.requestFullscreen()).catch(() => null) : Promise.resolve(null); }
  catch { full = Promise.resolve(null); }
  full.then(() => {
    if (!IN_APP && (!view.presenting || view.presentSession !== session || view.frame !== f || !stage.isConnected)) {
      if (document.fullscreenElement === stage && !view.presenting) document.exitFullscreen().catch(() => {});
      return;
    }
    if (document.fullscreenElement === stage) { f.contentWindow.postMessage(mode, '*'); f.focus(); return; }
    // no Fullscreen API (iPhone) or presenter view: the slides fill the window. Moving the frame reloads it,
    // so it's told again where it was and how to show (on its deck-ready).
    view.home = stage.parentNode;
    view.pending = [{ type: 'deck-go', k: view.at }, mode];
    stage.classList.add('deck-full');
    stage.querySelector('.deck-exit').hidden = false;
    document.body.append(stage);
    document.body.classList.add('deck-presenting');
    setTimeout(() => { if (IN_APP || (view.presenting && view.presentSession === session)) f.focus(); }, 300);
  });
}
function exitPresent() {
  if (!view.presenting) return;
  view.presenting = false;
  if (view.onPresentEnd) view.onPresentEnd(); // a rehearsal's summary, a self-running show stops (deck-present.js, web only)
  const stage = $('deckStage');
  if (!IN_APP) {
    view.presentSession = null;
    const exit = stage && stage.querySelector('.deck-exit');
    if (exit) exit.hidden = true;
    if (view.returnFocus && view.returnFocus.isConnected) view.returnFocus.focus();
    view.returnFocus = null;
  }
  if (document.fullscreenElement && (IN_APP || document.fullscreenElement === stage)) document.exitFullscreen().catch(() => {});
  if (stage && stage.classList.contains('deck-full')) {
    stage.classList.remove('deck-full');
    stage.querySelector('.deck-exit').hidden = true;
    document.body.classList.remove('deck-presenting');
    view.pending = [{ type: 'deck-go', k: view.at }, ...(!IN_APP ? [{ type: 'deck-mode', mode: 'edit' }] : [])];
    if (view.home && view.home.isConnected) view.home.append(stage); else stage.remove();
    return;
  }
  if (view.frame) view.frame.contentWindow.postMessage({ type: 'deck-mode', mode: 'edit' }, '*');
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && view.presenting) exitPresent(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view.presenting && !document.fullscreenElement) { e.stopPropagation(); exitPresent(); } }, true);

// ── pictures, import ──

async function shrinkPicture(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const png = file.type === 'image/png' && file.size < 600_000;
  return { data: cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), w, h };
}

function openPhotoStudio(slideIdx = view.index >= 0 ? view.index : 0, { mode = 'web' } = {}) {
  const deck = currentDeck();
  const c = cur();
  if (!deck || !c || !deck.slides[slideIdx]) return;
  const s = deck.slides[slideIdx];
  const defaultQ = (buildSlideImageQueries(deck, s, slideIdx)[0] || s.imageQuery || s.title || deck.title || '').slice(0, 60);
  const qIn = el('input', {
    type: 'text',
    value: mode === 'ai' ? (s.imageGen || `${deck.title || ''} — ${s.title || ''}`.trim()) : defaultQ,
    placeholder: mode === 'ai' ? tx('Describe the AI image or diagram to generate…') : tx('Search real photos (e.g. Tom Brady Patriots, Rob Gronkowski, Gillette Stadium)…'),
    style: { flex: '1', minWidth: '220px' },
  });
  const grid = el('div', {
    class: 'photo-studio-grid',
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: '8px', maxHeight: '220px', overflowY: 'auto', marginTop: '8px' },
  });
  const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: () => { if (fileIn.files[0]) pictureFor(fileIn.files[0]); fileIn.value = ''; } });

  const pickWebCandidate = async (cand) => {
    try {
      toast('Adding high-resolution photo to slide…');
      const resp = await fetch(cand.src);
      if (!resp.ok) throw new Error('Photo could not be fetched');
      const blob = await resp.blob();
      const fr = new FileReader();
      const dataUrl = await new Promise((res, rej) => { fr.onload = () => res(String(fr.result || '')); fr.onerror = rej; fr.readAsDataURL(blob); });
      const id = `web${Date.now().toString(36)}${slideIdx}`;
      storeImage(c, id, dataUrl, cand.width || 960, cand.height || 600);
      commit(setImage(deck, slideIdx, id, cand.title || qIn.value.trim() || s.title || 'Slide photo'), { toastText: tx(`Updated photo on slide ${slideIdx + 1}`) });
      const p = $('deckPanel');
      if (p) p.hidden = true;
    } catch (e) {
      toast(`Couldn’t load that photo: ${e.message || e}`);
    }
  };

  const runWebSearch = async (query) => {
    const q = String(query || '').trim();
    if (!q) return;
    grid.replaceChildren(el('span', 'muted', tx('Searching real photographs…')));
    try {
      const r = await fetch(apiUrl(`/api/chat/webimage?q=${encodeURIComponent(q)}`));
      const data = r.ok ? await r.json().catch(() => null) : null;
      const items = data ? pickImages(data.search, data.images, { max: 12 }).map((p) => ({ ...p, src: apiUrl(`/api/chat/webimage?u=${encodeURIComponent(p.thumb)}`) })) : [];
      if (!items.length) {
        grid.replaceChildren(el('span', 'muted', tx('No photos matched that exact phrase — try a shorter 1–3 word name or click “AI Generate”.')));
        return;
      }
      grid.replaceChildren(...items.map((cand) =>
        el('button', {
          type: 'button',
          class: 'photo-cand',
          style: { padding: '0', border: '1px solid rgba(127,127,127,0.28)', borderRadius: '10px', overflow: 'hidden', cursor: 'pointer', background: 'rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', height: '104px' },
          onclick: () => pickWebCandidate(cand),
          title: cand.title || q,
        },
        el('img', { src: cand.src, alt: cand.title || q, style: { width: '100%', height: '78px', objectFit: 'cover', display: 'block' } }),
        el('span', { style: { fontSize: '10.5px', padding: '3px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%', textAlign: 'left' } }, cand.title || q)),
      ));
    } catch (e) {
      grid.replaceChildren(el('span', 'muted', e.message || 'Search failed.'));
    }
  };

  const runAiGen = async (prompt) => {
    const pr = String(prompt || '').trim();
    if (!pr) return;
    grid.replaceChildren(el('span', 'muted', tx('Generating custom 16:9 visual with Eden AI…')));
    let imgData = null;
    await api.send(
      {
        messages: [{ role: 'user', content: `Create a photorealistic widescreen 16:9 presentation visual (no cluttered text): ${pr}` }],
        image: true,
        deck: false,
        settings: { level: 3 },
      },
      {
        onEvent: (t, d) => {
          if (t === 'image' && d && d.data && !imgData) imgData = { mime: d.mime || 'image/webp', data: d.data };
        },
      },
    ).catch(() => {});
    if (!imgData) {
      grid.replaceChildren(el('span', 'muted', tx('AI image generation wasn’t available for that prompt — try searching Web Photos or uploading a file.')));
      return;
    }
    const id = `ai${Date.now().toString(36)}${slideIdx}`;
    storeImage(c, id, `data:${imgData.mime};base64,${imgData.data}`, 1536, 1024);
    commit(setImage(deck, slideIdx, id, pr.slice(0, 120)), { toastText: tx(`Generated AI visual for slide ${slideIdx + 1}`) });
    const p = $('deckPanel');
    if (p) p.hidden = true;
  };

  const form = el('form', {
    class: 'deck-alt',
    style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
    onsubmit: (e) => { e.preventDefault(); if (mode === 'ai') runAiGen(qIn.value); else runWebSearch(qIn.value); },
  },
  el('strong', { style: { fontSize: '12.5px', marginRight: '4px' } }, `${tx('Slide')} ${slideIdx + 1} ${tx('Visuals')}:`),
  qIn,
  el('button', { type: 'button', class: 'cap primary', onclick: () => runWebSearch(qIn.value) }, tx('Search Photos')),
  !IN_APP ? el('button', { type: 'button', class: 'cap', onclick: () => runAiGen(qIn.value) }, tx('AI Generate')) : null,
  el('button', { type: 'button', class: 'cap', onclick: () => fileIn.click() }, tx('Upload…')),
  !IN_APP && s.image && c.deckImages && c.deckImages[s.image] ? el('button', { type: 'button', class: 'cap', 'data-deck': 'photo-tools', onclick: () => photoTools(slideIdx) }, tx('Photo tools…')) : null,
  state.jarvis && state.jarvis.available ? el('button', { type: 'button', class: 'cap', onclick: () => browseMacPicture() }, tx('From Mac…')) : null,
  el('button', { type: 'button', class: 'cap', onclick: () => { commit(toggleSlidePlaybook(deck, slideIdx), { toastText: tx(`Added X’s & O’s playbook diagram to slide ${slideIdx + 1}`) }); const p = $('deckPanel'); if (p) p.hidden = true; } }, tx('Playbook X/O')),
  fileIn);

  notice('', [form, grid]);
  qIn.focus();
  if (mode !== 'ai') runWebSearch(defaultQ);
}

/** AI photo tools for the slide's picture (deck-photo-tools.js, web only, loaded when first opened): every result is a new picture version. */
function photoTools(slideIdx = view.index >= 0 ? view.index : 0, tool) {
  const deck = currentDeck();
  const c = cur();
  const s = deck && deck.slides[slideIdx];
  if (IN_APP || !s || !c) return;
  const image = s.image && c.deckImages && c.deckImages[s.image];
  if (!image) { toast(tx('This slide has no picture yet. Add one with Picture…, then open Photo tools.')); return; }
  import('./deck-photo-tools.js').then((m) => m.openPhotoTools({
    c, slideIdx, image, alt: s.alt, tool, currentDeck: () => currentDeck(),
    storeImage: (id, data, w, h) => storeImage(c, id, data, w, h),
    commit: (d, o) => { commit(d, o); const p = $('deckPanel'); if (p) p.hidden = true; },
  }), () => toast(tx('Photo tools couldn’t load. Check your connection and try again.')));
}

function pictureFor(file) {
  const deck = currentDeck();
  const c = cur();
  const i = view.index >= 0 ? view.index : 0;
  if (!deck || !c) return;
  shrinkPicture(file).then((pic) => {
    const alt = el('input', { type: 'text', maxlength: 300, required: true, placeholder: tx('What does the picture show?'), 'aria-label': tx('Alt text: what the picture shows, for people who can’t see it') });
    const form = el('form', { class: 'deck-alt', onsubmit: (e) => {
      e.preventDefault();
      if (!alt.value.trim()) { alt.focus(); return; }
      const id = `i${Date.now().toString(36)}`;
      storeImage(c, id, pic.data, pic.w, pic.h);
      commit(setImage(deck, i, id, alt.value));
    } }, el('label', '', `${tx('Describe the picture for slide')} ${i + 1}`, alt), el('button', { type: 'submit', class: 'cap primary' }, 'Add picture'));
    notice('', [form]);
    alt.focus();
  }, () => toast('That picture couldn’t be read'));
}

function browseMacPicture() {
  const deck = currentDeck();
  const c = cur();
  const i = view.index >= 0 ? view.index : 0;
  if (!deck || !c) return;
  const qIn = el('input', { type: 'text', placeholder: tx('Search image files on your Mac (e.g. logo, chart, product)…'), 'aria-label': tx('Search Mac images') });
  const resultsBox = el('div', { class: 'mac-list', style: { maxHeight: '220px', overflowY: 'auto', marginTop: '8px' } });
  const searchBtn = el('button', { type: 'submit', class: 'cap primary' }, tx('Search Mac'));
  const pickMacFile = async (f) => {
    try {
      toast(`Loading ${f.name || 'image'} from your Mac…`);
      const read = await macFile({ action: 'read', path: f.path });
      if (!read || !read.data) throw new Error('Empty image data');
      const mime = read.mime || (/\.png$/i.test(f.path) ? 'image/png' : /\.webp$/i.test(f.path) ? 'image/webp' : /\.gif$/i.test(f.path) ? 'image/gif' : 'image/jpeg');
      const id = `i${Date.now().toString(36)}`;
      storeImage(c, id, `data:${mime};base64,${read.data}`);
      commit(setImage(deck, i, id, f.name ? f.name.replace(/\.[^.]+$/, '') : 'Mac image'), { toastText: `Added ${f.name} to slide ${i + 1}` });
      const p = $('deckPanel');
      if (p) p.hidden = true;
    } catch (e) {
      toast(`Couldn’t load that picture: ${e.message || e}`);
    }
  };
  const runSearch = async (q) => {
    resultsBox.replaceChildren(el('span', 'muted', tx('Searching your Mac for pictures…')));
    try {
      const res = await api.jarvis('files_search', { query: q || 'png jpg', kind: 'image', limit: 15 });
      const files = (res && Array.isArray(res.files) ? res.files : []).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.path || f.name || ''));
      if (!files.length) {
        resultsBox.replaceChildren(el('span', 'muted', tx('No matching PNG, JPEG, GIF, or WebP pictures found.')));
        return;
      }
      resultsBox.replaceChildren(...files.map((f) =>
        el('button', { type: 'button', class: 'mac-file', style: { display: 'flex', width: '100%', textAlign: 'left', padding: '6px 8px', gap: '8px', alignItems: 'center' }, onclick: () => pickMacFile(f) },
          ico('art', 14),
          el('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name || f.path),
          el('small', 'muted', f.display || '')),
      ));
    } catch (e) {
      resultsBox.replaceChildren(el('span', 'muted', e.message || 'Couldn’t search your Mac.'));
    }
  };
  const form = el('form', { class: 'deck-alt', onsubmit: (e) => { e.preventDefault(); runSearch(qIn.value.trim()); } },
    el('label', '', `${tx('Browse your Mac for a picture on slide')} ${i + 1}`, qIn),
    searchBtn);
  notice('', [form, resultsBox]);
  qIn.focus();
  runSearch('');
}

async function importFile(file, { themeOnly = false } = {}) {
  const c = cur();
  if (!c) return;
  toast(themeOnly ? 'Reading the brand…' : 'Reading the PowerPoint…');
  let r;
  try { r = await (await import('./deck-import.js')).importPptx(file); } catch (e) { r = { error: e.message || 'That file couldn’t be read.' }; }
  if (r.error) { toast(r.error); return; }
  if (themeOnly) {
    const deck = currentDeck();
    if (!deck) return;
    if (!IN_APP) { commit(setTheme(deck, r.theme)); toast(tx('Brand colors and fonts applied'), { label: tx('Save as brand kit'), run: () => saveThemeAsKit(r.theme, file.name) }); return; } // undo stays on the version arrows
    commit(setTheme(deck, r.theme), { toastText: tx('Brand colors and fonts applied') });
    return;
  }
  for (const [id, im] of Object.entries(r.images)) storeImage(c, id + Date.now().toString(36), im.data, im.w, im.h);
  const rename = Object.fromEntries(Object.keys(r.images).map((id) => [id, Object.keys(c.deckImages).find((k) => k.startsWith(id) && c.deckImages[k].data === r.images[id].data)]));
  const deck = { ...r.deck, slides: r.deck.slides.map((s) => (s.image && rename[s.image] ? { ...s, image: rename[s.image] } : s)) };
  c.mode = 'slides';
  c.deckVersions = addVersion(c.deckVersions, { at: Date.now(), kind: 'import', deck });
  save(c);
  openDeck(c);
  toast(`${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} imported: ask Eden to restyle or continue them`);
}

// ── exports ──

function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/** Magic Resize and Translate (web only): their dialogs, loaded when first opened (deck-resize.js, deck-translate.js). */
async function openDeckTool(which) {
  const c = cur(), deck = currentDeck();
  if (IN_APP || !c || !deck) return;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    if (which === 'resize') (await import('./deck-resize.js')).openResize({ deck, images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()), download: downloadBlob, tx, returnFocus });
    else (await import('./deck-translate.js')).openTranslate({ deck, commit: (d, toastText) => commit(d, { toastText }), tx, returnFocus });
  } catch (e) { toast(`Couldn’t open it: ${e.message}. Try again.`); }
}

async function exportPptx() {
  const c = cur(), deck = exportDeck(currentDeck()); // hidden slides left out unless chosen (deck-arrange.js)
  if (!c || !deck) return;
  if (missingAlt(deck).length) toast('Some pictures have no alt text: PowerPoint will have none for them');
  try {
    const { pptxBlob } = await import('./deck-pptx.js');
    const media = !IN_APP && deck.slides.some((s) => s.media) ? await pptxMediaFiles(deck, c) : null; // the video/audio files, inside the .pptx
    const { blob, name } = await pptxBlob(deck, { images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()), media });
    downloadBlob(blob, name);
    toast('Saved as a PowerPoint file');
  } catch (e) { toast(`PowerPoint export failed: ${e.message}`); }
}

async function exportPdf({ handout } = {}) { // handout (web only): deck-handouts-ui.js lays out notes pages, 2/3/6 a page or the outline
  const c = cur(), deck = exportDeck(currentDeck());
  if (!c || !deck) return;
  let R;
  try { R = await deckRender(); } catch (e) { toast(`Couldn’t load the slides: ${e.message}. Try again.`); return; }
  const { deckDocument, LABELS } = R;
  // a copy with no script at all, in a frame that can't run any: the browser's print, "Save as PDF"
  const html = deckDocument(deck, { mode: 'static', fonts: IN_APP ? undefined : await brandFonts(deck, { shared: true }), images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()), labels: labels(LABELS) });
  if (IN_APP) { appPdf(deck, html); return; }
  const f = el('iframe', { sandbox: 'allow-same-origin allow-modals', title: 'Print', 'aria-hidden': 'true', style: { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0' } });
  f.addEventListener('load', () => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { toast('Printing isn’t available here: download the PowerPoint instead'); }
    setTimeout(() => f.remove(), 60_000);
  }, { once: true });
  f.srcdoc = typeof handout === 'function' ? handout(html, deck) : html;
  document.body.append(f);
  toast(typeof handout === 'function' ? tx('Choose “Save as PDF” in the print dialog') : 'Choose “Save as PDF” in the print dialog (one slide a page)');
}

/**
 * The PDF in the Eden iPhone app, where window.print() does nothing (R2-8): the script-free copy
 * goes into a print view in this page (a shadow root, shown only when printing, its own styles
 * kept inside), and the app prints the page (its print sheet also saves a PDF to Files). An app
 * without print gets the PowerPoint instead, and says so.
 */
async function appPdf(deck, html) {
  const host = printView(html);
  const root = document.documentElement;
  root.classList.add('eden-printing');
  // the slide's page size while this prints (a page-wide @page would change any other print)
  const pageSize = el('style', { id: 'edenPrintPage' }, '@page{size:13.333in 7.5in;margin:0}');
  document.head.append(pageSize);
  const end = () => { root.classList.remove('eden-printing'); host.remove(); pageSize.remove(); };
  toast('Choose “Save to Files” or a printer in the print sheet (one slide a page)');
  // An app that doesn't say it prints and hasn't answered: an older Eden app, where nothing opens.
  // Say so, with the PowerPoint to share instead (a late print sheet still works).
  const onSlow = () => toast('No print sheet? This version of the Eden app can’t make a PDF', { label: 'Share the PowerPoint', run: () => exportPptx() });
  let r = 'unsupported';
  // (an app that says it prints, caps.print, is simply waited for: no fallback prompt behind its sheet)
  try { r = await appPrint(deck.title || 'Slides', appCanPrint() ? {} : { onSlow }); } catch { /* the app is gone */ }
  end();
  if (r === 'unsupported') {
    toast('This version of the Eden app can’t make a PDF: here’s the PowerPoint instead');
    exportPptx();
  }
}
/** The static deck as a print-only element of this page: no scripts, no handlers, styles in a shadow root. */
function printView(html) {
  const old = document.getElementById('edenPrint');
  if (old) old.remove();
  const doc = new DOMParser().parseFromString(html, 'text/html'); // (nothing in a parsed document runs)
  for (const x of doc.querySelectorAll('script, iframe, object, embed, link, meta, base, form')) x.remove();
  for (const x of doc.querySelectorAll('*')) {
    for (const a of [...x.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) x.removeAttribute(a.name);
    }
  }
  // the deck's own document styles its <body>: here that's a wrapper div
  const style = [...doc.querySelectorAll('style')].map((x) => x.textContent).join('\n')
    .replace(/(^|[\s{},>~+(])(html|body)(?=[\s{,.:#[>~+)])/g, '$1.dk-$2');
  const host = el('div', { id: 'edenPrint', 'aria-hidden': 'true' });
  const shadow = host.attachShadow({ mode: 'open' });
  const page = document.createElement('div');
  page.className = `dk-html`;
  const body = document.createElement('div');
  body.className = `dk-body ${doc.body.className}`;
  body.append(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  page.append(body);
  const st = document.createElement('style');
  st.textContent = `:host{display:block}${style}`;
  shadow.append(st, page);
  document.body.append(host);
  return host;
}

function googleSlides() {
  // Through Google Drive (drive.file only: the files Eden creates; sheet-google.js driveUpload): the PowerPoint,
  // converted to Google Slides in the person's Drive. It writes to their Drive, so it waits for this button.
  const status = el('p', { class: 'deck-gs-status', role: 'status' });
  const upload = el('button', { type: 'button', class: 'cap primary', onclick: async () => {
    const c = cur(), deck = exportDeck(currentDeck());
    if (!c || !deck) return;
    upload.disabled = true;
    status.textContent = tx('Uploading to your Google Drive…');
    try {
      const [{ pptxBlob }, { driveUpload }] = await Promise.all([import('./deck-pptx.js'), import('./sheet-google.js')]);
      const { blob, name } = await pptxBlob(deck, { images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()) });
      const r = await driveUpload({ name, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: new Uint8Array(await blob.arrayBuffer()) }, { convertTo: 'slides' });
      status.replaceChildren(tx('In your Google Drive as Google Slides: '), el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', 'data-no-i18n': '' }, r.name || deck.title));
    } catch (e) {
      status.textContent = e.code === 'scope' || e.code === 'not_connected' || e.status === 403 || e.status === 409
        ? tx('Eden isn’t connected to Google Drive yet (it asks only for the files it creates). Connect Google in Settings, or download the PowerPoint and import it in Google Slides.')
        : `${tx('Google Drive didn’t take it')}: ${e.message}`;
    } finally { upload.disabled = false; }
  } }, ico('globe', 14), 'Save to Google Slides');
  notice('', [el('div', 'deck-gs',
    el('b', '', 'Google Slides'),
    el('p', '', 'Save to Google Slides puts a copy in your Google Drive (Eden can see only the files it creates there). Or download the PowerPoint and, in Google Slides, choose File › Import slides.'),
    el('div', 'deck-gs-acts', upload,
      el('button', { type: 'button', class: 'cap', onclick: exportPptx }, ico('down', 14), 'Download PowerPoint'),
      el('a', { class: 'cap', href: 'https://docs.google.com/presentation/', target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 14), 'Open Google Slides')),
    status)]);
}

async function share() {
  const c = cur(), deck = exportDeck(currentDeck());
  if (!c || !deck) return;
  let R;
  try { R = await deckRender(); } catch (e) { toast(`Couldn’t load the slides: ${e.message}. Try again.`); return; }
  const { deckDocument, LABELS } = R;
  // a view-only copy: present mode, no editing, nothing sent back
  openPublish({ title: deck.title, html: deckDocument(deck, { mode: 'present', fonts: IN_APP ? undefined : await brandFonts(deck, { shared: true }), images: c.deckImages || {}, label: labelFor(c, deckCanvasVersion()), labels: labels(LABELS), embedded: false }) });
}

export { closeArtifact as closeDeck };

// "Make slides" on a research report in the canvas (index.html #btnArtSlides, shown by artifact.js)
const slidesBtn = typeof document !== 'undefined' && document.getElementById('btnArtSlides');
if (slidesBtn) slidesBtn.addEventListener('click', () => dispatchEvent(new CustomEvent('eden:report-slides')));
