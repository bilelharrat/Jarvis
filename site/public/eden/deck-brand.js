// Brand kits for Eden Slides (web only; deck.js builds this row only when !IN_APP). A kit holds logos, a named
// palette mapped onto the theme's seven colours, and fonts (a PowerPoint-safe face, or an uploaded .woff2/.ttf
// that the slide frame embeds and the .pptx swaps for a safe face). Kits are per browser, not per chat: they live
// in their own IndexedDB store (localStorage when IndexedDB is missing) and other tabs hear of changes over a
// BroadcastChannel. Applying a kit is one edit (an undoable version); its logo is copied into the chat's
// deckImages, so the deck keeps it if the kit is deleted. The pure part is deck-brand-model.js.

import { el, ico, toast, store } from './util.js';
import { t as tx } from './i18n.js';
import { IN_APP } from './native.js';
import { THEMES, themeOf } from './deck-model.js';
import {
  ROLES, ROLE_LABEL, CORNERS, SIZES, SAFE_FONTS, KIT_LIMITS, family, normalizeKit, kitFromTheme, applyKit, setLogo,
  paletteColors, contrast, fontFormat, logoData, fontNeeds, isSharedFont, freeFaces,
} from './deck-brand-model.js';
import { FREE_FAMILIES, closestFree } from './deck-fonts.js';

// ── storage ──

const LS_KEY = 'eden:brandKits';
let kits = [];
let loaded = null;
const chan = !IN_APP && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('eden-brand') : null; // the app opens nothing

function db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-brand', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kits', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function tx1(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  try {
    return await new Promise((resolve) => {
      const t = d.transaction('kits', mode);
      const req = fn(t.objectStore('kits'));
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : true);
      t.onerror = t.onabort = () => resolve(undefined);
    });
  } catch { return undefined; } finally { d.close(); }
}
const sorted = (list) => list.map(normalizeKit).filter(Boolean).sort((a, b) => b.updated - a.updated).slice(0, KIT_LIMITS.kits);

/** Every kit on this device (read once, then kept in memory). */
export function loadKits({ fresh = false } = {}) {
  if (loaded && !fresh) return loaded;
  loaded = (async () => {
    const got = await tx1('readonly', (s) => s.getAll());
    kits = sorted(Array.isArray(got) ? got : store.get(LS_KEY, []));
    return kits;
  })();
  return loaded;
}
async function putKit(kit) {
  const k = normalizeKit({ ...kit, updated: Date.now() });
  if (!k) return null;
  if (!kits.some((x) => x.id === k.id) && kits.length >= KIT_LIMITS.kits) { toast(tx(`You can keep ${KIT_LIMITS.kits} brand kits. Delete one first.`)); return null; }
  const ok = await tx1('readwrite', (s) => s.put(k));
  kits = sorted([k, ...kits.filter((x) => x.id !== k.id)]);
  if (ok === undefined && !store.set(LS_KEY, kits)) { toast(tx('This browser’s storage is full: the kit wasn’t saved.')); return null; }
  changed();
  return k;
}
async function deleteKit(id) {
  const ok = await tx1('readwrite', (s) => s.delete(id));
  kits = kits.filter((x) => x.id !== id);
  if (ok === undefined) store.set(LS_KEY, kits);
  changed();
}
function changed() { if (chan) chan.postMessage('changed'); refreshRow(); }
if (chan) chan.onmessage = () => { loadKits({ fresh: true }).then(refreshRow); };
if (!IN_APP) loadKits();

/**
 * The fonts a deck's frame embeds (its @font-face rules): the free families it names or falls back to, and, on this
 * device only, the kits' uploaded files. `shared` (a shared copy, the PDF) leaves the uploaded files out.
 */
export async function brandFonts(deck, { shared = false } = {}) {
  try {
    await loadKits(); // then `kits`, not the first load's list: a kit saved since counts
    const need = fontNeeds(deck, kits, { shared });
    return [...need.uploaded, ...(await Promise.all(need.free.map(freeFontData))).flat()];
  } catch { return []; }
}
const freeCache = new Map();
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
/** A free family's faces as data: URLs (the frame's CSP allows fonts only as data:), fetched once from web/chat/fonts/. */
function freeFontData(fam) {
  if (!freeCache.has(fam)) {
    freeCache.set(fam, Promise.all(freeFaces(fam).map(async (f) => {
      try {
        const r = await fetch(new URL(`./${f.path}`, import.meta.url));
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        return { family: f.family, weight: f.weight, style: f.style, data: `data:font/woff2;base64,${b64(bytes)}`, bytes };
      } catch { return null; } // offline, or not deployed: the font stack's next face draws
    })).then((faces) => { const ok = faces.filter(Boolean); if (!ok.length) freeCache.delete(fam); return ok; }));
  }
  return freeCache.get(fam);
}
/** A free family drawable in this page too (the kit dialog's preview). */
async function showFree(fam) {
  if (typeof FontFace === 'undefined' || !FREE_FAMILIES.includes(fam)) return;
  for (const f of await freeFontData(fam)) {
    try { const face = new FontFace(fam, f.bytes, { weight: String(f.weight), style: f.style }); await face.load(); document.fonts.add(face); } catch { /* the preview falls back */ }
  }
}

/** A theme as a new kit (from "Brand from a PowerPoint…", or the deck's current look). */
export async function saveThemeAsKit(theme, name = 'Brand kit') {
  await loadKits();
  const k = kitFromTheme(theme, { name: String(name).replace(/\.pptx$/i, '') || 'Brand kit' });
  const saved = k && await putKit(k);
  if (saved) toast(tx(`Saved “${saved.name}” as a brand kit`));
  return saved;
}

// ── the Design tray row ──

let live = null; // { box, api }: the row now in the tray, redrawn when kits change

function refreshRow() {
  if (!live || !live.box.isConnected) { live = null; return; }
  live.box.replaceChildren(...rowKids(live.api));
}

/**
 * The brand kit rows for the Design tray. api: { currentDeck, commit, storeImage(id, data, w, h), keepFocus, btn }
 * (deck.js's own helpers, so an apply is an ordinary edit and the tray keeps focus across the redraw).
 */
export function brandRow(deck, api) {
  const box = el('div', { class: 'deck-brand' });
  live = { box, api };
  box.append(...rowKids(api, deck));
  if (!loaded || !kits.length) loadKits().then(refreshRow);
  return box;
}

function swatches(kit) {
  const c = paletteColors(kit.palette);
  return el('span', { class: 'deck-brand-dots', 'aria-hidden': 'true' }, ...['bg', 'text', 'accent', 'accent2'].map((r) => el('span', { style: { background: c[r] } })));
}

function rowKids(api, deck = api.currentDeck()) {
  if (!deck) return [];
  const b = deck.brand || {};
  const applied = kits.find((k) => k.id === b.kit);
  const choice = (key, label, onclick, { pressed = null, kids = [] } = {}) => el('button', { type: 'button', class: 'deck-choice', 'data-key': key, ...(pressed === null ? {} : { 'aria-pressed': String(pressed) }), onclick: () => { api.keepFocus(key); onclick(); } }, ...kids, label);
  const kitRow = el('div', { class: 'deck-choices', role: 'group', 'aria-label': tx('Brand kits') },
    ...kits.map((k) => choice(`kit:${k.id}`, k.name, () => applyTo(k, api), { pressed: b.kit === k.id, kids: [swatches(k)] })),
    choice('kit:new', tx('New kit…'), () => openEditor(null, api), { kids: [el('span', { class: 'deck-layout-icon', 'aria-hidden': 'true' }, '+')] }));
  const head = el('div', 'deck-tool-head', el('h4', '', tx('Brand kit · whole deck')),
    applied ? api.btn(null, 'Edit kit…', () => openEditor(applied, api)) : kits.length ? null : el('p', { class: 'deck-brand-hint' }, tx('Save logos, colours and fonts once; apply them in one click.')));
  const out = [head, kitRow];
  if (b.logo) {
    const corner = { tl: '↖', tr: '↗', bl: '↙', br: '↘' };
    const cornerName = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' };
    out.push(el('div', { class: 'deck-choices', role: 'group', 'aria-label': tx('Logo on every slide') },
      el('span', { class: 'deck-brand-label', 'aria-hidden': 'true' }, tx('Logo')),
      ...CORNERS.map((c) => choice(`logo:${c}`, tx(cornerName[c]), () => edit(setLogo(api.currentDeck(), { corner: c }), api, tx('Logo moved')), { pressed: b.corner === c, kids: [el('span', { class: 'deck-layout-icon', 'aria-hidden': 'true' }, corner[c])] })),
      ...Object.keys(SIZES).map((s) => choice(`logo-size:${s}`, tx({ s: 'Small', m: 'Medium', l: 'Large' }[s]), () => edit(setLogo(api.currentDeck(), { size: s }), api, tx('Logo resized')), { pressed: b.size === s })),
      choice('logo:none', tx('No logo'), () => edit(setLogo(api.currentDeck(), { corner: 'none' }), api, tx('Logo removed')))));
  }
  return out;
}

function edit(next, api, toastText) { if (next) api.commit(next, { toastText }); }

/** One click: the kit's colours, fonts and (when it has one) logo on the deck, as a new version. */
function applyTo(kit, api) {
  const d = api.currentDeck();
  if (!d) return;
  const logo = kit.logos.find((l) => l.id === kit.logo.use);
  let logoId = '';
  if (logo) {
    logoId = `bk${kit.id}${logo.id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    api.storeImage(logoId, logo.data, logo.w, logo.h);
  }
  api.commit(applyKit(d, kit, { logoId, themes: THEMES }), { toastText: tx(`Applied “${kit.name}”`) });
}

// ── the kit editor (a modal dialog) ──

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const readAs = (file, how) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('That file couldn’t be read.')); r[how](file); });

/** A logo file as a PNG/JPEG data URL at most 512 px on its longest side; SVGs are drawn to PNG. */
export async function rasterLogo(file) {
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
  if (!svg && !/^image\/(png|jpeg)$/.test(file.type)) throw new Error(tx('Use a PNG, JPEG or SVG logo.'));
  if (file.size > 5 * 1024 * 1024) throw new Error(tx('That logo is over 5 MB.'));
  const url = URL.createObjectURL(svg ? new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' }) : file); // an <img> never runs an SVG's scripts
  try {
    const im = new Image();
    im.src = url;
    await im.decode();
    let w = im.naturalWidth || 512, h = im.naturalHeight || 512;
    const k = svg ? KIT_LIMITS.logoPx / Math.max(w, h) : Math.min(1, KIT_LIMITS.logoPx / Math.max(w, h));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const cv = el('canvas', { width: w, height: h });
    cv.getContext('2d').drawImage(im, 0, 0, w, h);
    const data = logoData(cv.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9));
    if (!data) throw new Error(tx('That logo is too large once drawn.'));
    return { data, w, h };
  } catch (e) {
    throw new Error(e && /logo/.test(e.message) ? e.message : tx('That picture couldn’t be read.'));
  } finally { URL.revokeObjectURL(url); }
}

/** An uploaded font file, checked (its bytes, its size, and that the browser can draw it). */
export async function readFont(file) {
  if (!/\.(woff2|ttf)$/i.test(file.name || '')) throw new Error(tx('Use a .woff2 or .ttf font file.'));
  if (file.size > KIT_LIMITS.fileBytes) throw new Error(tx('That font is over 1.5 MB.'));
  const data = await readAs(file, 'readAsDataURL');
  if (!fontFormat(data)) throw new Error(tx('That file isn’t a font Eden can use.'));
  const fam = family(String(file.name).replace(/\.(woff2|ttf)$/i, '').replace(/[-_]+/g, ' ').replace(/\b(regular|webfont)\b/gi, '')) || 'Brand Font';
  const name = isSharedFont(fam) ? `${fam} Brand` : fam; // never shadows a safe or free face
  const out = { family: name, data, fallback: closestFree(fam) }; // shared copies use the closest free family until changed
  if (!(await showFont(out))) throw new Error(tx('That font file is damaged.'));
  return out;
}
/** Make an uploaded face drawable in this page too (for the editor's preview). From bytes: the page's CSP has no font-src data:. */
async function showFont(f) {
  if (typeof FontFace === 'undefined') return true;
  try {
    const bin = atob(f.data.slice(f.data.indexOf(',') + 1));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const face = new FontFace(f.family, bytes.buffer);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch { return false; }
}

function openEditor(kit, api) {
  const deck = api.currentDeck();
  const draft = kit ? JSON.parse(JSON.stringify(kit)) : kitFromTheme(deck ? { ...deck.theme, colors: themeOf(deck).colors } : {}, { id: uid('k'), name: tx('My brand') }) || normalizeKit({ id: uid('k') });
  const dlg = el('dialog', { class: 'deck-brand-dialog', 'aria-labelledby': 'deckBrandTitle' });
  const err = el('p', { class: 'deck-brand-err', role: 'alert' });
  const fail = (e) => { err.textContent = e && e.message ? e.message : String(e); };
  const opener = document.activeElement;
  const close = () => { dlg.close(); dlg.remove(); if (opener && opener.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus(); };
  const name = el('input', { type: 'text', value: draft.name, maxlength: String(KIT_LIMITS.name), 'aria-label': tx('Kit name'), class: 'deck-brand-name' });

  // palette
  const pal = el('div', { class: 'deck-brand-palette' });
  const preview = el('div', { class: 'deck-brand-preview', 'aria-live': 'polite' });
  const drawPreview = () => {
    const c = paletteColors(draft.palette);
    const ratio = contrast(c.text, c.bg);
    preview.replaceChildren(el('span', { class: 'deck-brand-dots', 'aria-hidden': 'true' }, ...ROLES.map((r) => el('span', { title: ROLE_LABEL[r], style: { background: c[r] } }))),
      el('span', '', `${tx('Text on background')}: ${ratio.toFixed(1)}:1${ratio < 4.5 ? ` — ${tx('below AA, hard to read')}` : ''}`));
  };
  const drawPalette = () => {
    pal.replaceChildren(...draft.palette.map((c, i) => el('div', { class: 'deck-brand-color' },
      el('input', { type: 'color', value: c.hex, 'aria-label': `${tx('Colour')} ${i + 1}`, oninput: (e) => { c.hex = e.target.value; drawPreview(); } }),
      el('input', { type: 'text', value: c.name, maxlength: '30', placeholder: tx('Name'), 'aria-label': `${tx('Name of colour')} ${i + 1}`, oninput: (e) => { c.name = e.target.value; } }),
      el('select', { 'aria-label': `${tx('Use of colour')} ${i + 1}`, onchange: (e) => { const r = e.target.value; draft.palette.forEach((x) => { if (r && x.role === r) x.role = ''; }); c.role = r; drawPalette(); } },
        el('option', { value: '' }, tx('Auto')), ...ROLES.map((r) => el('option', { value: r, selected: c.role === r ? true : null }, tx(ROLE_LABEL[r])))),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': `${tx('Remove colour')} ${i + 1}`, onclick: () => { draft.palette.splice(i, 1); drawPalette(); } }, ico('x', 12)))));
    drawPreview();
  };
  const addColor = el('button', { type: 'button', class: 'cap', onclick: () => { if (draft.palette.length < KIT_LIMITS.palette) { draft.palette.push({ name: '', hex: '#2563eb', role: '' }); drawPalette(); } } }, ico('plus', 12), tx('Add colour'));
  const fromDeck = deck ? el('button', { type: 'button', class: 'cap', onclick: () => { draft.palette = kitFromTheme({ colors: themeOf(api.currentDeck() || deck).colors }, { id: draft.id }).palette; drawPalette(); } }, tx('Use this deck’s colours')) : null;

  // fonts
  const fontBox = el('div', { class: 'deck-brand-fonts' });
  const fontFile = el('input', { type: 'file', accept: '.woff2,.ttf', hidden: true, onchange: async () => {
    const f = fontFile.files[0]; fontFile.value = '';
    if (!f) return;
    if (draft.files.length >= KIT_LIMITS.files) { fail(tx(`A kit holds ${KIT_LIMITS.files} font files.`)); return; }
    try { const got = await readFont(f); if (!draft.files.some((x) => x.family === got.family)) draft.files.push(got); err.textContent = ''; drawFonts(); } catch (e) { fail(e); }
  } });
  const drawFonts = () => {
    const o = (v, label, cur) => el('option', { value: v, selected: cur === v ? true : null }, label);
    const shared = (cur) => [el('optgroup', { label: tx('Free fonts · in every copy') }, ...FREE_FAMILIES.map((n) => o(n, n, cur))),
      el('optgroup', { label: tx('PowerPoint-safe') }, ...SAFE_FONTS.map((x) => o(x.name, x.name, cur)))];
    const ext = ['heading', 'body'].map((k) => draft.fonts[k]).filter((f) => f && f.external).map((f) => f.family);
    const opts = (cur) => [...shared(cur),
      draft.files.length ? el('optgroup', { label: tx('Uploaded · this device only') }, ...draft.files.map((f) => o(f.family, f.family, cur))) : null,
      ext.length ? el('optgroup', { label: tx('From PowerPoint') }, ...[...new Set(ext)].map((n) => o(n, n, cur))) : null];
    const notes = {};
    const note = (k) => { // where this face shows, and what stands in for it elsewhere
      const f = draft.fonts[k], n = notes[k];
      if (!n) return;
      const file = f && draft.files.find((x) => x.family === f.family);
      n.textContent = !f || !f.family ? '' : isSharedFont(f.family) ? tx('In every copy') : file ? `${tx('Shared copies use')}: ${file.fallback}` : `${tx('Where it isn’t installed')}: ${closestFree(f.family)}`;
    };
    const pick = (k, label) => { notes[k] = el('span', { class: 'deck-brand-note' }); return el('label', { class: 'deck-brand-field' }, tx(label),
      el('select', { onchange: (e) => { const v = e.target.value; const was = draft.fonts[k]; if (!v) delete draft.fonts[k]; else draft.fonts[k] = { family: v, ...(was && was.family === v && was.external ? { external: true } : {}) }; note(k); showFree(v); } },
        el('option', { value: '' }, tx('Theme default')), ...opts(draft.fonts[k] && draft.fonts[k].family)), notes[k]); };
    fontBox.replaceChildren(pick('heading', 'Headings'), pick('body', 'Text'),
      ...draft.files.map((f, i) => el('div', { class: 'deck-brand-file' },
        el('span', { style: { fontFamily: `"${f.family}", sans-serif` } }, f.family),
        el('label', { class: 'deck-brand-field' }, tx('Shared copies use'), el('select', { 'aria-label': `${tx('Shared copies, the PDF and PowerPoint use instead of')} ${f.family}`, onchange: (e) => { f.fallback = e.target.value; note('heading'); note('body'); showFree(f.fallback); } }, ...shared(f.fallback))),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': `${tx('Remove font')} ${f.family}`, onclick: () => { draft.files.splice(i, 1); for (const k of ['heading', 'body']) if (draft.fonts[k] && draft.fonts[k].family === f.family) delete draft.fonts[k]; drawFonts(); } }, ico('x', 12)))),
      el('button', { type: 'button', class: 'cap', onclick: () => fontFile.click() }, ico('plus', 12), tx('Upload a font (.woff2, .ttf)…')), fontFile);
    note('heading'); note('body');
    for (const k of ['heading', 'body']) if (draft.fonts[k]) showFree(draft.fonts[k].family);
    for (const f of draft.files) showFree(f.fallback);
  };

  // logos
  const logoBox = el('div', { class: 'deck-brand-logos' });
  const logoFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,.svg', hidden: true, onchange: async () => {
    const f = logoFile.files[0]; logoFile.value = '';
    if (!f) return;
    if (draft.logos.length >= KIT_LIMITS.logos) { fail(tx(`A kit holds ${KIT_LIMITS.logos} logos.`)); return; }
    try { const r = await rasterLogo(f); const id = uid('l'); draft.logos.push({ id, name: f.name, ...r }); draft.logo.use = id; err.textContent = ''; drawLogos(); } catch (e) { fail(e); }
  } });
  const drawLogos = () => {
    const cornerName = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' };
    logoBox.replaceChildren(
      el('div', { class: 'deck-choices', role: 'radiogroup', 'aria-label': tx('Logo to use') },
        el('button', { type: 'button', class: 'deck-choice', role: 'radio', 'aria-checked': String(!draft.logo.use), onclick: () => { draft.logo.use = ''; drawLogos(); } }, tx('No logo')),
        ...draft.logos.map((l) => el('span', { class: 'deck-brand-logo' },
          el('button', { type: 'button', class: 'deck-choice', role: 'radio', 'aria-checked': String(draft.logo.use === l.id), onclick: () => { draft.logo.use = l.id; drawLogos(); } }, el('img', { src: l.data, alt: '' }), l.name || tx('Logo')),
          el('button', { type: 'button', class: 'iconbtn', 'aria-label': `${tx('Remove logo')} ${l.name}`, onclick: () => { draft.logos = draft.logos.filter((x) => x !== l); if (draft.logo.use === l.id) draft.logo.use = draft.logos[0] ? draft.logos[0].id : ''; drawLogos(); } }, ico('x', 12)))),
        el('button', { type: 'button', class: 'cap', onclick: () => logoFile.click() }, ico('plus', 12), tx('Add a logo (PNG, JPEG, SVG)…')), logoFile),
      el('label', { class: 'deck-brand-field' }, tx('Corner'), el('select', { onchange: (e) => { draft.logo.corner = e.target.value; } }, ...CORNERS.map((c) => el('option', { value: c, selected: draft.logo.corner === c ? true : null }, tx(cornerName[c]))))),
      el('label', { class: 'deck-brand-field' }, tx('Size'), el('select', { onchange: (e) => { draft.logo.size = e.target.value; } }, ...Object.keys(SIZES).map((s) => el('option', { value: s, selected: draft.logo.size === s ? true : null }, tx({ s: 'Small', m: 'Medium', l: 'Large' }[s]))))));
  };

  let armed = false;
  const del = kit ? el('button', { type: 'button', class: 'cap deck-brand-del', onclick: async (e) => {
    if (!armed) { armed = true; e.currentTarget.textContent = tx('Click again to delete'); return; }
    await deleteKit(kit.id); close(); toast(tx(`Deleted “${kit.name}”. Decks keep its colours and logo.`));
  } }, tx('Delete kit')) : null;
  const save = async (andApply) => {
    draft.name = name.value;
    const saved = await putKit(draft);
    if (!saved) { fail(tx('The kit wasn’t saved.')); return; }
    close();
    if (andApply) applyTo(saved, api); else toast(tx(`Saved “${saved.name}”`));
  };
  dlg.append(
    el('h3', { id: 'deckBrandTitle' }, kit ? tx('Edit brand kit') : tx('New brand kit')), name,
    el('h4', '', tx('Colours')), pal, el('div', 'deck-brand-acts', addColor, fromDeck), preview,
    el('h4', '', tx('Fonts')), el('p', { class: 'deck-brand-hint' }, tx('Free fonts appear in every copy. An uploaded font stays on this device: shared copies, the PDF and PowerPoint use the free font you pick for it.')), fontBox,
    el('h4', '', tx('Logo')), logoBox,
    err,
    el('div', 'deck-brand-acts deck-brand-foot', del, el('span', 'grow'),
      el('button', { type: 'button', class: 'cap', onclick: close }, tx('Cancel')),
      el('button', { type: 'button', class: 'cap', onclick: () => save(false) }, tx('Save')),
      el('button', { type: 'button', class: 'cap primary', onclick: () => save(true) }, tx('Save and apply'))));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); }); // Escape closes the dialog only, never the canvas
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  drawPalette(); drawFonts(); drawLogos();
  for (const f of draft.files) showFont(f);
  document.body.append(dlg);
  dlg.showModal();
  name.focus();
  name.select();
}
