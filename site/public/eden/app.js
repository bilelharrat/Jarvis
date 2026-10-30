// Eden Secretary Chat — the page's wiring: layout (source list, conversation, inspector), the
// transcript, conversations, palette, settings, dialogs, shortcuts and Esc order.

import './i18n.js'; // first of all: the page's language (French loads its strings before any module draws)
import './practice.js'; // first: practice mode (the tour's sandbox) scopes storage before any module reads it
import { keyStatus, providerGlyph } from './settings-model.js';
import { $, el, ico, qsa, toast, lazy, whileVisible, retryWait, copyText, copyRich, download, fmtCost, relDay, fmtTimestamp, isMobile, isNarrow, isTouch, setSeg, store, shortModel } from './util.js';
import { LANGS, langPref, setLang, isFr, locale, t as tx } from './i18n.js';
import { state, ui, saveSettings, savePersonas, loadConversations, saveConversation, addConversation, deleteConversation, newConversation, path, selectSibling, nodeText, sessionCost, persona, conversationMarkdown } from './state.js';
import { api, isMock, API_ROOT } from './api.js';
// The apps page (Eden Secretary, Eden Messenger) lives on askeden.com; a local Eden links there.
const DOWNLOAD_URL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'https://askeden.com/download' : '/download';
import { initMail, connectGmail, emailText, queueTeamOpen } from './mail.js';
import { openCompose, initSignatures } from './compose-entry.js'; // compose.js loads with the first email written (efficiency pass 2)
import { initMailkit } from './mailkit.js';
import { parseEmailDraft } from './md-plain.js';
import { renderMessage, emptyState, ui_open, artifactsIn } from './render.js';
import { routeSettings, initRouteControls, renderRouteControls, renderTurnCard, routePopContent, openChipPop, closeChipPop, chipPopOpenFor, initChipPop, hoverIntent, setOverride, setLevel, availableModels, currentOverride, modelInfo, schedulePreview, levels } from './router.js';
import { initComposer, renderComposer, composerEscape, focusComposer, setComposerText, addContext, setMode, modelMenu, openMenu, closeMenu, clearAttachments, renderAttachments, addFile } from './composer.js';
import { sendMessage, runChat, stop, retry, regenerate, editResend, answerPermission, queueFollowUp, steerNow, dropQueued, runCode } from './chat.js';
import { initArtifact, openArtifact, closeArtifact, artifactOpen, refreshArtifact } from './artifact.js';
import { sheetCommands, sheetReturnPending, resumeSheet } from './sheet-entry.js'; // Q15: the spreadsheet canvas, loaded on first use
import { initPageUpdate } from './page-update.js'; // a page left open picks up a deploy; the app's text follows the system size
import { initDesk, setLayout, layout } from './desk.js'; // the Desktop layout (Settings › Appearance › Layout)
import { initPanels, openSpace, closeSpace, spaceOpen, checkJarvis, renderMemoryTab, searchNotes, attachNote, notify, inMailOnly, leaveMailOnly } from './panels.js';
import { initAccount } from './account.js';
import { planCommand } from './plan.js';
import { initPrivacy, paint as paintPrivacy, privacyBody, privacySettings } from './privacy.js';
import { initPublish } from './publish.js';
import { initCode, projectPicker, loadProjects, renderPlan, loadChanges, setHunk, renderActivity, toggleDrawer, parseCodeWhenAndTask, parseNaturalCodeTimedMessage, scheduleCodeTask, scheduleTaskDialog, ensureScheduleLoop } from './code.js';
import { initCalendar, openCalendar, calendarReturnPending, RETURN_KEY as CAL_RETURN_KEY } from './calendar-entry.js'; // calendar.js loads when it opens (efficiency pass 2)
import { initMemory } from './memory.js';
import { importLabel } from './import-label.js'; // the sidebar's "Imported from …" (the readers load with the Import dialog)
import { initBrief, openBrief } from './brief.js';
import { initFiles, openFiles, closePane } from './files.js';
import { initKnowledge, knowledgeItem } from './knowledge.js';
import { initFolders, folders as folderRows, chatsIn, newFolder, renameFolder, deleteFolder, moveChat, moveItems, tidyUp, tidyCard, tidyLast, tidyDismiss } from './folders.js';
import { folderList, unfiled, shouldNudge, cleanName } from './folders-model.js';
import { voiceSettings } from './voice.js';
import { bootSoundSettings } from './boot-sound.js'; // the desktop apps' boot-up sound, in Settings › Appearance
import { initTasks, openTasks, pendingApprovals } from './tasks.js';
import { initWorkflows, openWorkflows, saveWorkflowFrom } from './workflows.js';
import { openNews, closeNews } from './news-panel.js';
import { initLearned, learnedSettings } from './learned.js';
import { initAutopilot, autopilotSettings, refreshSpend, spendStatus, monthSavings } from './autopilot.js';
import { decorateEves, evesSettings, drawEvesPane } from './eves.js'; // N13: EVES's progress line and badge on a reply, and its switch in Settings › Routing & EVES pane
import { decorateVerify } from './verify.js'; // N13: the label under a reply
import { acting, actingHas } from './acting.js';
import { initTour, startTour } from './tour.js'; // I1: the try-it tour
import { reportFileName, reportTitle } from './research-model.js'; // Q2: the research report's title and file name
import { decorateFirstRun, initFirstRun } from './first-run.js'; // Q4: the first minute
import { initHelp, helpCommands, helpButton } from './help.js'; // Help Center: FAQ and Ask Help
import { IN_APP, IN_APP_SHELL, openAppSettings, AI_CONSENT_WORDS, reviewAiConsent } from './native.js';
import { essayCommand, essayStyleIn } from './eden-tools.js';
// The essay writer (essay.js, ROADMAP T11–T12): askeden.com in a browser only. The iPhone/Android app never shows it
// (no Essays button, no /essay-style command, no paste-into-essay) and never loads its modules.
const ESSAYS = !IN_APP;
let essayChat = null; // essay-chat.js once loaded (website only): an open essay stays with its chat (T20e)
import { imagesAvailable, videosAvailable } from './image-mode.js'; // Image & Video modes' send extra and /image, /video commands
import {
  initSplitView, updateSplitMessage, renderSplitPaneFor, command as splitCmd,
  handleSplitKey, takeConv, onOwnChanged, onConvDeleted, rowItem as splitRowItem,
  splitMenuItems, splitPaletteCommands, splitState,
} from './split-view.js';
import './edu-budget.js'; // its send extra (`eduOwn` on a course chat sent from here) must be on at startup, before Courses ever opens (R2C-6); small: util + api only

/* ---------- features loaded when first used, not at startup (efficiency pass 1) ---------- */
// Each module loads once and is handed what it needs from here; a load that fails (offline) says so and is tried again next time.
// A background load (`{ quiet: true }`) fails without a word: only a load someone asked for says so (R2C-19).
// Q3: share a chat as a read-only link (share.js, its model and share.css)
const shareMod = lazy(() => import('./share.js').then((m) => { m.initShare({ openDialog, closeDialog }); return m; }), [new URL('./share.js', import.meta.url).href]);
// Apple-style motion (motion.css): everywhere but the Eden and Edu iPhone apps, which must look unchanged while in App
// Review (CLAUDE.md freeze rule); the travel iPhone app has it
if (!/EdenApp\/|EdenEdu/.test(navigator.userAgent || '')) document.documentElement.classList.add('eden-motion');
// Eden Travel's own address is its own app from the first paint (travel.js STANDALONE; travel.css .travel-standalone)
if (!IN_APP && /(^|\.)askedentravel\.com$|^travel\.localhost$/.test(location.hostname)) { document.body.classList.add('travel-standalone'); const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'travel.css?v=20261029c'; document.head.append(css); }
const openShare = (c) => shareMod().then((m) => m.openShare(c), () => {});
// Import chats from ChatGPT, Claude or Gemini (import-chatgpt.js and the three readers, import-chatgpt.css)
const importMod = lazy(() => import('./import-chatgpt.js').then((m) => { m.initImportChatGPT({ openDialog, closeDialog, toast }); return m; }), [new URL('./import-chatgpt.js', import.meta.url).href]);
const openImportChats = () => importMod().then((m) => m.openImportChats(), () => {});
/** Settings › Memory: a line on what Import does and a button that opens the dialog. */
function importCard() {
  return el('div', 'set-sec', el('h3', '', 'Import chats'),
    el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Bring your chats from ChatGPT, Claude or Gemini'),
      el('div', 'p-c', 'Export your data there, drop the file here, and your chats appear in Eden: searchable, and synced end-to-end encrypted like the rest. It’s read in this browser and never uploaded.')),
    el('button', { type: 'button', class: 'btn', onclick: () => openImportChats() }, 'Import…'))));
}
// The browser panel (browser-pane.js, browser-model.js). In the Eden app the app's own browser opens
// instead, so there it loads on first use; elsewhere just after startup (it reopens if it was open).
let browserPane = null;
const browserMod = lazy(() => import('./browser-pane.js').then((m) => {
  m.initBrowserPane({ openSpace, addContext, sendMessage, focusComposer, openPalette });
  browserPane = m;
  return m;
}), [new URL('./browser-pane.js', import.meta.url).href]);
// Before the panel has loaded, a toggle means "open" (it's closed): decided now, not once loaded, so
// a tap or ⌘⇧B during the load can't open it and shut it again after the reopen at init (R2C-19).
const toggleBrowser = (force, ...rest) => {
  const want = force === undefined ? (browserPane ? undefined : !document.body.classList.contains('browser-open')) : force;
  return browserMod().then((m) => m.toggleBrowser(want, ...rest), () => {});
};
const closeBrowser = () => (browserPane ? browserPane.closeBrowser() : false); // focus in the panel: it's loaded

/* ================= theme ================= */
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const COLOR_PRESETS = [
  ['blue', 'Eden Blue', '#007aff'],
  ['indigo', 'Indigo', '#5e5ce6'],
  ['purple', 'Purple', '#af52de'],
  ['rose', 'Rose', '#ff2d55'],
  ['red', 'Red', '#ff3b30'],
  ['orange', 'Orange', '#ff9500'],
  ['emerald', 'Emerald', '#34c759'],
  ['teal', 'Teal', '#30b0c7'],
  ['neutral', 'Neutral Slate', '#2c2c2e'],
  ['black', 'Black', '#000000'],
];
const DEFAULT_GLASS_STYLE = 'capsule';
const GLASS_STYLES = [
  ['capsule', 'Liquid Glass Capsule', 'Specular lens sheen + colored glow'],
  ['obsidian', 'Smoked Obsidian Rim', 'Dark smoked glass + 1px neon rim'],
  ['crystal', 'VisionOS Frosted Crystal', 'Airy high-refraction bevel'],
  ['seaglass', 'Deep Caustic Sea Glass', 'Rich inner cushion + caustic core'],
  ['classic', 'Classic Solid', 'Original flat solid fill'],
];
function normGlassStyle(s) {
  if (typeof s !== 'string') return '';
  const v = s.trim().toLowerCase();
  return GLASS_STYLES.some(([id]) => id === v) ? v : '';
}
function glassSurfaceRulesFor(r, g, b, effHex, contrast, styleId, dark) {
  const style = normGlassStyle(styleId) || DEFAULT_GLASS_STYLE;
  const comma = `${r}, ${g}, ${b}`;
  if (style === 'classic') {
    return {
      bg: effHex,
      sh: `inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 1px 3px rgba(0, 0, 0, ${dark ? '0.28' : '0.12'})`,
      filter: 'none',
      sheen: 'none',
      radius: '19px 19px 5px 19px',
      ink: contrast,
    };
  }
  if (style === 'obsidian') {
    const baseBg = dark ? 'rgba(8, 11, 18, 0.78)' : 'rgba(14, 18, 28, 0.76)';
    return {
      bg: `linear-gradient(155deg, rgba(${comma}, 0.24) 0%, ${baseBg} 100%)`,
      sh: `inset 0 1px 0 rgba(255, 255, 255, 0.16), inset 0 0 0 1px rgba(${comma}, 0.36), 0 4px 12px -4px rgba(0, 0, 0, 0.36)`,
      filter: 'blur(28px) saturate(175%)',
      sheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0) 100%)',
      radius: '16px 16px 4px 16px',
      ink: '#ffffff',
    };
  }
  if (style === 'crystal') {
    const midAlpha = dark ? '0.22' : '0.32';
    const endAlpha = dark ? '0.12' : '0.18';
    return {
      bg: `linear-gradient(145deg, rgba(255, 255, 255, ${dark ? '0.18' : '0.38'}) 0%, rgba(${comma}, ${midAlpha}) 52%, rgba(${comma}, ${endAlpha}) 100%)`,
      sh: `inset 0 1px 0 rgba(255, 255, 255, ${dark ? '0.30' : '0.62'}), inset 0 0 0 1px rgba(${comma}, ${dark ? '0.28' : '0.22'}), 0 4px 12px -4px rgba(0, 0, 0, ${dark ? '0.28' : '0.10'})`,
      filter: 'blur(34px) saturate(195%)',
      sheen: 'linear-gradient(155deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.02) 60%, transparent 100%)',
      radius: '21px 21px 5px 21px',
      ink: dark ? '#ffffff' : '#0f172a',
    };
  }
  if (style === 'seaglass') {
    return {
      bg: dark
        ? `linear-gradient(160deg, rgba(255, 255, 255, 0.12) 0%, rgba(${comma}, 0.30) 56%, rgba(8, 20, 28, 0.44) 100%)`
        : `linear-gradient(160deg, rgba(255, 255, 255, 0.62) 0%, rgba(${comma}, 0.36) 56%, rgba(${comma}, 0.24) 100%)`,
      sh: `inset 0 1px 0 rgba(255, 255, 255, ${dark ? '0.24' : '0.65'}), inset 0 0 0 1px rgba(${comma}, ${dark ? '0.30' : '0.24'}), 0 4px 12px -4px rgba(0, 0, 0, ${dark ? '0.28' : '0.09'})`,
      filter: 'blur(26px) saturate(190%)',
      sheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0) 100%)',
      radius: '18px 18px 5px 18px',
      ink: dark ? '#ffffff' : '#0f172a',
    };
  }
  return {
    bg: dark
      ? `linear-gradient(160deg, rgba(255, 255, 255, 0.11) 0%, rgba(${comma}, 0.24) 55%, rgba(255, 255, 255, 0.05) 100%)`
      : `linear-gradient(160deg, rgba(255, 255, 255, 0.66) 0%, rgba(${comma}, 0.28) 55%, rgba(${comma}, 0.18) 100%)`,
    sh: `inset 0 1px 0 rgba(255, 255, 255, ${dark ? '0.22' : '0.68'}), inset 0 0 0 1px rgba(${comma}, ${dark ? '0.26' : '0.22'}), 0 4px 12px -4px rgba(0, 0, 0, ${dark ? '0.28' : '0.08'})`,
    filter: 'blur(28px) saturate(190%)',
    sheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0) 100%)',
    radius: '16px 16px 4px 16px',
    ink: dark ? 'rgba(255, 255, 255, 0.96)' : '#0f172a',
  };
}
function clampNum(n, a, b) { const v = Number(n); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a; }
function normHex(s) {
  if (typeof s !== 'string') return '';
  const r = s.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(r)) return `#${r[0]}${r[0]}${r[1]}${r[1]}${r[2]}${r[2]}`;
  return /^[0-9a-f]{6}$/.test(r) ? `#${r}` : '';
}
function hexRgb(hex) {
  const n = parseInt((normHex(hex) || '#007aff').slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbHex(r, g, b) {
  const h = (c) => Math.round(clampNum(c, 0, 255)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function rgbHsv(r, g, b) {
  const rn = clampNum(r, 0, 255) / 255, gn = clampNum(g, 0, 255) / 255, bn = clampNum(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvRgb(h, s, v) {
  const hn = (((Number(h) || 0) % 360) + 360) % 360, sn = clampNum(s, 0, 1), vn = clampNum(v, 0, 1);
  const c = vn * sn, x = c * (1 - Math.abs(((hn / 60) % 2) - 1)), m = vn - c;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hn < 60) { r1 = c; g1 = x; } else if (hn < 120) { r1 = x; g1 = c; }
  else if (hn < 180) { g1 = c; b1 = x; } else if (hn < 240) { g1 = x; b1 = c; }
  else if (hn < 300) { r1 = x; b1 = c; } else { r1 = c; b1 = x; }
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}
function ensureAccentStyleTag() {
  if (!document.head) return null;
  let tag = document.getElementById('eden-chat-color-vars');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'eden-chat-color-vars';
    document.head.append(tag);
  }
  return tag;
}
function applyAccentColor() {
  let saved = normHex(state.settings.accentColor || '');
  if (!saved && state.settings.accentColor === undefined) {
    try { saved = normHex(localStorage.getItem('eden.code.color') || ''); } catch { /* ignore */ }
    if (saved) state.settings.accentColor = saved;
  }
  let savedGlass = normGlassStyle(state.settings.glassStyle || '');
  if (!savedGlass && state.settings.glassStyle === undefined) {
    try { savedGlass = normGlassStyle(localStorage.getItem('eden.code.glass_style') || ''); } catch { /* ignore */ }
    if (savedGlass) state.settings.glassStyle = savedGlass;
  }
  const hex = saved;
  const rootEl = document.documentElement;
  const tag = ensureAccentStyleTag();
  const dark = rootEl.dataset.theme === 'dark';
  const effectiveGlass = IN_APP ? 'classic' : (savedGlass || DEFAULT_GLASS_STYLE);
  if (!IN_APP) {
    rootEl.dataset.chatGlass = effectiveGlass;
    if (document.body) document.body.dataset.chatGlass = effectiveGlass;
  } else {
    delete rootEl.dataset.chatGlass;
    if (document.body) delete document.body.dataset.chatGlass;
  }

  if (!hex && IN_APP) {
    for (const k of ['--accent', '--accent-soft', '--accent-contrast', '--orb', '--wash1', '--wash2', '--c-accent', '--c-accent-hover', '--c-accent-soft', '--c-accent-ink', '--c-glow', '--lg-surface-bg', '--lg-surface-sh', '--lg-surface-filter', '--lg-surface-sheen', '--lg-bubble-radius', '--lg-surface-ink']) rootEl.style.removeProperty(k);
    if (tag) tag.textContent = '';
    return;
  }
  const activeHex = hex || (dark ? '#0a84ff' : '#007aff');
  const rawRgb = hexRgb(activeHex);
  const { h, s, v } = rgbHsv(rawRgb.r, rawRgb.g, rawRgb.b);
  const pitchBlack = Boolean(hex) && v <= 0.12;
  const effRgb = (dark && pitchBlack) ? { r: 38, g: 38, b: 43 } : rawRgb;
  const effHex = (dark && pitchBlack) ? '#26262b' : activeHex;
  const { r, g, b } = effRgb;
  const hi = hsvRgb(h, clampNum(s * 0.85, 0, 1), clampNum(Math.min(1, Math.max(v, 0.35) + 0.14), 0.3, 1));
  const lo = hsvRgb(h, clampNum(s * 1.05, 0, 1), clampNum(Math.max(v, 0.25) * 0.84, 0.15, 1));
  const ink = dark
    ? (pitchBlack ? { r: 220, g: 220, b: 228 } : hsvRgb(h, clampNum(s * 0.65, 0, 0.8), clampNum(Math.max(v, 0.78), 0.72, 1)))
    : (pitchBlack ? { r: 20, g: 20, b: 24 } : hsvRgb(h, clampNum(s * 1.05, 0, 1), clampNum(Math.min(v, 0.68), 0.22, 0.68)));
  const softRgb = dark
    ? hsvRgb(h, clampNum(s * 0.75, 0, 0.85), 0.24)
    : hsvRgb(h, clampNum(s * 0.18, 0, 0.25), 0.97);
  const w1 = hsvRgb(h, clampNum(s * (dark ? 0.65 : 0.22), 0.08, 0.7), dark ? 0.28 : 0.97);
  const w2 = hsvRgb((h + 32) % 360, clampNum(s * (dark ? 0.55 : 0.18), 0.06, 0.6), dark ? 0.24 : 0.96);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const contrast = lum > 0.55 ? '#0f172a' : '#ffffff';
  const glass = glassSurfaceRulesFor(r, g, b, effHex, contrast, effectiveGlass, dark);

  if (hex) {
    rootEl.style.setProperty('--accent', effHex);
    rootEl.style.setProperty('--accent-contrast', contrast);
    rootEl.style.setProperty('--accent-soft', (dark && pitchBlack) ? 'rgba(255,255,255,0.12)' : `rgba(${r},${g},${b},${dark ? 0.18 : 0.12})`);
    rootEl.style.setProperty('--orb', `linear-gradient(135deg,${rgbHex(hi.r, hi.g, hi.b)},${rgbHex(lo.r, lo.g, lo.b)})`);
    rootEl.style.setProperty('--wash1', pitchBlack && dark ? 'rgba(0,0,0,0)' : `rgba(${w1.r},${w1.g},${w1.b},${dark ? 0.58 : 0.9})`);
    rootEl.style.setProperty('--wash2', pitchBlack && dark ? 'rgba(0,0,0,0)' : `rgba(${w2.r},${w2.g},${w2.b},${dark ? 0.5 : 0.9})`);
    rootEl.style.setProperty('--c-accent', `${r} ${g} ${b}`);
    rootEl.style.setProperty('--c-accent-hover', `${lo.r} ${lo.g} ${lo.b}`);
    rootEl.style.setProperty('--c-accent-soft', `${softRgb.r} ${softRgb.g} ${softRgb.b}`);
    rootEl.style.setProperty('--c-accent-ink', `${ink.r} ${ink.g} ${ink.b}`);
    rootEl.style.setProperty('--c-glow', `${hi.r} ${hi.g} ${hi.b}`);
  } else {
    for (const k of ['--accent', '--accent-soft', '--accent-contrast', '--orb', '--wash1', '--wash2', '--c-accent', '--c-accent-hover', '--c-accent-soft', '--c-accent-ink', '--c-glow']) rootEl.style.removeProperty(k);
  }
  rootEl.style.setProperty('--lg-surface-bg', glass.bg);
  rootEl.style.setProperty('--lg-surface-sh', glass.sh);
  rootEl.style.setProperty('--lg-surface-filter', glass.filter);
  rootEl.style.setProperty('--lg-surface-sheen', glass.sheen);
  rootEl.style.setProperty('--lg-bubble-radius', glass.radius);
  rootEl.style.setProperty('--lg-surface-ink', glass.ink);

  if (tag) {
    const edenMarkWhite = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='43 81 410 422'%3E%3Cg fill='%23ffffff' stroke='%23ffffff' stroke-width='18' stroke-linejoin='round'%3E%3Cpolygon points='211%2C93 314%2C90 444%2C236 343%2C353 249%2C352 333%2C251'/%3E%3Cpolygon points='252%2C235 160%2C346 282%2C491 186%2C494 52%2C350 151%2C234'/%3E%3C/g%3E%3C/svg%3E")`;
    const comma = `${r}, ${g}, ${b}`;
    let composerBg;
    let composerBorder;
    let composerSh;
    let composerFilter = glass.filter === 'none' ? 'blur(22px) saturate(175%)' : glass.filter;
    if (effectiveGlass === 'classic') {
      composerBg = dark ? 'rgba(28, 28, 32, 0.90)' : 'rgba(255, 255, 255, 0.92)';
      composerBorder = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(15, 23, 42, 0.10)';
      composerSh = dark
        ? `inset 0 1px 0 rgba(255, 255, 255, 0.10), 0 8px 24px -10px rgba(0, 0, 0, 0.45)`
        : `inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 8px 22px -10px rgba(15, 23, 42, 0.10)`;
    } else if (effectiveGlass === 'obsidian') {
      composerBg = dark ? 'rgba(10, 12, 18, 0.86)' : 'rgba(18, 22, 32, 0.82)';
      composerBorder = `rgba(${comma}, 0.34)`;
      composerSh = `inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 10px 26px -10px rgba(0, 0, 0, 0.50)`;
    } else if (effectiveGlass === 'crystal') {
      composerBg = dark ? 'rgba(24, 28, 38, 0.64)' : 'rgba(255, 255, 255, 0.74)';
      composerBorder = hex ? `rgba(${comma}, ${dark ? '0.28' : '0.22'})` : (dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(15, 23, 42, 0.10)');
      composerSh = `inset 0 1px 0 rgba(255, 255, 255, ${dark ? '0.20' : '0.88'}), 0 10px 26px -10px rgba(0, 0, 0, ${dark ? '0.45' : '0.10'})`;
    } else if (effectiveGlass === 'seaglass') {
      composerBg = dark ? 'rgba(14, 24, 30, 0.74)' : 'rgba(246, 251, 255, 0.80)';
      composerBorder = `rgba(${comma}, ${dark ? '0.26' : '0.20'})`;
      composerSh = `inset 0 1px 0 rgba(255, 255, 255, ${dark ? '0.18' : '0.85'}), 0 8px 24px -10px rgba(0, 0, 0, ${dark ? '0.42' : '0.08'})`;
    } else {
      composerBg = dark ? 'rgba(26, 28, 34, 0.74)' : 'rgba(255, 255, 255, 0.80)';
      composerBorder = hex ? `rgba(${comma}, ${dark ? '0.26' : '0.20'})` : (dark ? 'rgba(255, 255, 255, 0.13)' : 'rgba(15, 23, 42, 0.10)');
      composerSh = dark
        ? `inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 10px 26px -10px rgba(0, 0, 0, 0.45)`
        : `inset 0 1px 0 rgba(255, 255, 255, 0.88), 0 8px 24px -10px rgba(15, 23, 42, 0.10)`;
    }
    const webGlassCss = !IN_APP ? `
.msg.user .bubble {
  position: relative;
  overflow: hidden;
  background: ${glass.bg} !important;
  color: ${glass.ink} !important;
  box-shadow: ${glass.sh} !important;
  backdrop-filter: ${glass.filter} !important;
  -webkit-backdrop-filter: ${glass.filter} !important;
  border-radius: ${glass.radius} !important;
}
.msg.user .bubble::before {
  content: "";
  position: absolute;
  inset: 1px 1px auto 1px;
  height: 40%;
  border-radius: inherit;
  background: ${glass.sheen} !important;
  pointer-events: none;
}
.msg.user .bubble .utext, .msg.user .bubble a, .msg.user .bubble .more {
  position: relative;
  z-index: 1;
  color: ${glass.ink} !important;
}
html:not(.eden-app)[data-chat-glass] .jc-composer {
  background: ${composerBg} !important;
  border: 1px solid ${composerBorder} !important;
  box-shadow: ${composerSh} !important;
  backdrop-filter: ${composerFilter} !important;
  -webkit-backdrop-filter: ${composerFilter} !important;
}
html:not(.eden-app)[data-chat-glass] .jc-composer:focus-within {
  border-color: ${dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.15)'} !important;
  box-shadow: ${composerSh} !important;
}
.jc-send:not(.stop), .jc-composer.expanded .jc-orb {
  position: relative;
  overflow: hidden;
  background: ${glass.bg} !important;
  color: ${glass.ink} !important;
  box-shadow: ${glass.sh} !important;
  backdrop-filter: ${glass.filter} !important;
  -webkit-backdrop-filter: ${glass.filter} !important;
}
.jc-send:not(.stop)::before {
  content: "";
  position: absolute;
  inset: 1px 1px auto 1px;
  height: 48%;
  border-radius: 999px 999px 8px 8px;
  background: ${glass.sheen} !important;
  pointer-events: none;
}` : `
.msg.user .bubble, .jc-send:not(.stop), .jc-composer.expanded .jc-orb {
  background: var(--accent) !important;
  color: var(--accent-contrast, #fff) !important;
  box-shadow: 0 1px 3px rgba(${r}, ${g}, ${b}, ${dark ? 0.48 : 0.32}), inset 0 0 0 1px rgba(${dark ? '255,255,255,0.14' : '0,0,0,0.08'}) !important;
}
.msg.user .bubble .utext, .msg.user .bubble a, .msg.user .bubble .more {
  color: var(--accent-contrast, #fff) !important;
}`;
    const accentCss = hex ? `
:root, [data-theme="light"], [data-theme="dark"], .jc, [data-theme="dark"] .jc {
  --accent: ${effHex};
  --accent-contrast: ${contrast};
  --c-accent: ${r} ${g} ${b};
  --c-accent-hover: ${lo.r} ${lo.g} ${lo.b};
  --c-accent-soft: ${softRgb.r} ${softRgb.g} ${softRgb.b};
  --c-accent-ink: ${ink.r} ${ink.g} ${ink.b};
  --c-glow: ${hi.r} ${hi.g} ${hi.b};
}
.sitem.active, #desk #sideScroll .sitem.active, .btn.primary, .cap.primary, #setSeg button.on, .pal-it.sel {
  background: var(--accent) !important;
  color: var(--accent-contrast, #fff) !important;
  box-shadow: 0 1px 3px rgba(${r}, ${g}, ${b}, ${dark ? 0.48 : 0.32}), inset 0 0 0 1px rgba(${dark ? '255,255,255,0.14' : '0,0,0,0.08'}) !important;
}
.sitem.active .ic, .sitem.active .lbl, .sitem.active .sub, .sitem.active .pin-ic {
  color: var(--accent-contrast, #fff) !important;
}
.orb {
  background: ${edenMarkWhite} center / 56% no-repeat, linear-gradient(135deg, ${rgbHex(hi.r, hi.g, hi.b)}, ${rgbHex(lo.r, lo.g, lo.b)}) !important;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22), 0 1px 3px rgba(${r}, ${g}, ${b}, 0.38) !important;
}
.jc-popover button.active, .jc-popover button:hover, .jc-menu button:hover:not(.danger):not([disabled]), .jc-menu button:focus-visible:not(.danger):not([disabled]) {
  background: rgb(var(--c-accent)) !important;
  color: var(--accent-contrast, #fff) !important;
}${pitchBlack && dark ? '\n[data-theme="dark"], [data-theme="dark"] body { --bg: #000000 !important; --content: #0a0a0c !important; --content2: #121215 !important; }' : ''}` : '';
    tag.textContent = `${accentCss}\n${webGlassCss}`.trim();
  }
}
function setGlassStyle(styleId) {
  const clean = normGlassStyle(styleId);
  state.settings.glassStyle = clean && clean !== DEFAULT_GLASS_STYLE ? clean : '';
  try {
    if (state.settings.glassStyle) localStorage.setItem('eden.code.glass_style', state.settings.glassStyle);
    else localStorage.removeItem('eden.code.glass_style');
  } catch { /* ignore */ }
  saveSettings();
  applyAccentColor();
}
function setAccentColor(hex) {
  const clean = normHex(hex);
  state.settings.accentColor = clean;
  try {
    if (state.settings.accentColor) localStorage.setItem('eden.code.color', state.settings.accentColor);
    else localStorage.removeItem('eden.code.color');
  } catch { /* ignore */ }
  saveSettings();
  applyAccentColor();
}
function applyTheme() {
  const t = state.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeIco').firstElementChild.setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('btnTheme').title = `Appearance: ${t[0].toUpperCase()}${t.slice(1)} (click to switch)`;
  applyAccentColor();
}
function setTheme(t) { state.settings.theme = t; saveSettings(); applyTheme(); }
darkMQ.addEventListener('change', applyTheme);

/* ================= layout ================= */
function syncScrim() {
  const s = $('sidebar');
  const on = (isMobile() && s.classList.contains('open')) || (isNarrow() && !isMobile() && !docksSidebar() && s.classList.contains('expanded')) || (isMobile() && $('inspector').classList.contains('open'));
  $('scrim').classList.toggle('on', on);
}
function toggleSidebar(force) {
  const s = $('sidebar');
  if (isMobile()) s.classList.toggle('open', force);
  else if (isNarrow()) { s.classList.toggle('expanded', force); if (docksSidebar()) store.set('jchat:sidebar', s.classList.contains('expanded')); }
  else { s.classList.toggle('closed', force === undefined ? undefined : !force); store.set('jchat:sidebar', !s.classList.contains('closed')); }
  syncScrim();
}
function closeOverlays() {
  $('sidebar').classList.remove('open', 'expanded');
  if (isNarrow()) $('inspector').classList.remove('open');
  syncScrim();
}
/** On a phone a sheet (Settings, a dialog, the palette, a panel) replaces the drawer and the inspector sheet: they stayed open behind it. */
function clearPhoneOverlays() { if (isMobile()) closeOverlays(); }
function inspectorVisible() { const i = $('inspector'); return isNarrow() ? i.classList.contains('open') : !i.classList.contains('closed'); }
function openInspector(tab) {
  const i = $('inspector');
  if (isNarrow()) i.classList.add('open');
  i.classList.remove('closed');
  if (!isNarrow()) store.set('jchat:inspector', true);
  if (tab) inspTab(tab);
  syncScrim();
}
function closeInspector() {
  const i = $('inspector');
  if (isNarrow()) i.classList.remove('open', 'full', 'peek');
  else { i.classList.add('closed'); store.set('jchat:inspector', false); }
  syncScrim();
}
function toggleInspector() { if (inspectorVisible()) closeInspector(); else openInspector(); }
const TABS = ['Route', 'Plan', 'Changes', 'Memory'];
let curTab = 'Route';
function inspTab(name) {
  curTab = name;
  setSeg($('inspSeg'), TABS.indexOf(name));
  qsa('.itab').forEach((t) => t.classList.toggle('on', t.id === `tab-${name}`));
  if (name === 'Changes') loadChanges();
  if (name === 'Memory') renderMemoryTab();
  if (name === 'Plan') renderPlan();
}
// crossing a breakpoint clears the other layout's classes (no stuck scrim or sheets)
for (const q of ['(max-width:1100px)', '(max-width:640px)']) {
  matchMedia(q).addEventListener('change', () => {
    $('sidebar').classList.remove('open', 'expanded');
    const i = $('inspector');
    const wasOpen = i.classList.contains('open') || !i.classList.contains('closed');
    i.classList.remove('open', 'full', 'peek');
    if (!isNarrow()) i.classList.toggle('closed', !(wasOpen && store.get('jchat:inspector', false)));
    else i.classList.add('closed');
    $('scrim').classList.remove('on');
    closeChipPop(); closeMenu();
  });
}
// Eden's iPad app (it marks the page .eden-ipad): from 820 to 1100px the whole sidebar docks
// beside the chat (mobile.css docks the rail's "expanded"), open unless closed with ⌘B or the
// sidebar button, as on a wide screen (jchat:sidebar). Registered after the listeners above,
// so it runs after they've cleared the classes.
const dockMQ = matchMedia('(min-width:820px) and (max-width:1100px)');
function docksSidebar() { return document.documentElement.classList.contains('eden-ipad') && dockMQ.matches; }
function syncDock() {
  if (!document.documentElement.classList.contains('eden-ipad')) return;
  const open = store.get('jchat:sidebar', true) !== false;
  $('sidebar').classList.toggle('expanded', docksSidebar() && open);
  if (!isNarrow()) $('sidebar').classList.toggle('closed', !open);
  syncScrim();
}
dockMQ.addEventListener('change', syncDock);
matchMedia('(max-width:1100px)').addEventListener('change', syncDock);

/* ================= conversations ================= */
/** A chat's title as shown: the person's (or Eden's) words as written; only the default names follow the page's language. */
function titleOf(c) {
  if (!c) return '';
  if (c.title === 'New chat' || c.title === 'Temporary chat') return tx(c.title);
  if (isFr && c.kind === 'code' && c.project && c.title === `${c.project.name} session`) return `Session ${c.project.name}`;
  return c.title;
}
function selectHere(c) {
  const prev = state.current ? state.current.id : null;
  state.current = c;
  ui_open.editing = null;
  state.selectedNode = c ? [...path(c)].reverse().find((n) => n.role === 'assistant' && n.route) || null : null;
  store.set('jchat:current', c && !c.temp ? c.id : null);
  if (!(essayChat && essayChat.essayStays(c))) closeArtifact(); // T20e (essay-chat.js): an open essay stays for a new chat or its own chat
  closeChipPop();
  renderAll();
  onOwnChanged(c ? c.id : null, prev);
  dispatchEvent(new CustomEvent('eden:conv-opened', { detail: { conv: c } })); // import-chatgpt.js loads an imported chat's images
  if (essayChat) essayChat.essayFollows(c); // that chat's essay comes back beside it (c.essayId)
  if (curTab === 'Changes' && inspectorVisible()) loadChanges();
  if (isMobile()) closeOverlays();
  schedulePreview();
}
function switchTo(c) {
  closeNews(); // a chat picked from the sidebar comes to the front
  if (takeConv(c)) {
    if (c && c.remote) dispatchEvent(new CustomEvent('eden:conv-opened', { detail: { conv: c } }));
    if (isMobile()) closeOverlays();
    return;
  }
  if (state.current === c) {
    if (c && c.remote) dispatchEvent(new CustomEvent('eden:conv-opened', { detail: { conv: c } })); // a stub still loading: asked for again
    if (isMobile()) closeOverlays();
    return;
  }
  const prev = state.current ? state.current.id : null;
  state.current = c;
  ui_open.editing = null;
  state.selectedNode = c ? [...path(c)].reverse().find((n) => n.role === 'assistant' && n.route) || null : null;
  store.set('jchat:current', c && !c.temp ? c.id : null);
  if (!(essayChat && essayChat.essayStays(c))) closeArtifact(); // T20e (essay-chat.js): an open essay stays for a new chat or its own chat
  closeChipPop();
  renderAll();
  onOwnChanged(c ? c.id : null, prev);
  dispatchEvent(new CustomEvent('eden:conv-opened', { detail: { conv: c } })); // import-chatgpt.js loads an imported chat's images
  if (essayChat) essayChat.essayFollows(c); // that chat's essay comes back beside it (c.essayId)
  if (curTab === 'Changes' && inspectorVisible()) loadChanges();
  if (isMobile()) closeOverlays();
  schedulePreview();
  focusComposer();
}
function newChat() {
  closeNews();
  // (an empty chat is already a new one; a chat from another device still downloading isn't: c.remote)
  if (state.current && !state.current.temp && !state.current.remote && !Object.keys(state.current.nodes).length && state.current.kind === 'chat') { focusComposer(); return; }
  state.pendingMode = 'chat';
  switchTo(null);
}
addEventListener('eden:new-chat', () => newChat()); // news-panel.js: a story's question starts its own chat
function newTemp() {
  const c = newConversation({ temp: true });
  c.title = 'Temporary chat';
  state.convs.unshift(c);
  switchTo(c);
  toast('Temporary chat — nothing is saved');
}
function newCodeSession(project) {
  const c = newConversation({ kind: 'code', project });
  addConversation(c);
  switchTo(c);
}
function renameConversation(c, title) {
  const t = String(title || '').trim();
  if (!c || !t) return;
  c.title = t.slice(0, 120);
  c.titleSet = true;
  c.metaAt = Date.now(); // other devices take the newer rename (sync-model.js merge; AS2)
  saveConversation(c);
  renderTitle(); renderSidebar();
}
function togglePin(c) { if (!c || c.temp) return; c.pinned = !c.pinned; c.metaAt = Date.now(); saveConversation(c); renderSidebar(); toast(c.pinned ? 'Pinned' : 'Unpinned'); }
function removeConversation(c) {
  if (!c) return;
  confirmDialog(`Delete “${c.title}”? This can’t be undone.`, 'Delete', () => {
    stop(c);
    onConvDeleted(c);
    deleteConversation(c);
    if (state.current === c) selectHere(null);
    renderSidebar();
    toast('Deleted');
  }, true);
}
function exportConversation(c) {
  if (!c || !path(c).length) { toast('Nothing to export yet'); return; }
  const slug = c.title.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chat';
  download(`${slug}.md`, conversationMarkdown(c));
}
function setPersona(id) {
  const c = state.current;
  if (c) { c.personaId = id || null; c.metaAt = Date.now(); saveConversation(c); }
  else state.draftPersona = id || null;
  const p = persona(id);
  toast(p ? `Persona: ${p.name}` : 'No persona');
  renderAttachments(); renderTitle(); renderSidebar();
  if (c && !path(c).length) renderTranscript();
}

/* ================= sidebar ================= */
const secState = store.get('jchat:secs', {});
function section(id, title, items, { add, extra = [], grow = false, cls = '' } = {}) {
  if ((id === 'folders' || id === 'projects') && secState[id] === undefined) secState[id] = true; // folders and projects start folded: one click opens them
  const closed = !!secState[id];
  const sec = el('div', { class: `sec${closed ? ' closed' : ''}${grow ? ' grow' : ''}${cls ? ` ${cls}` : ''}` });
  const head = el('div', { style: { display: 'flex', alignItems: 'center' } },
    el('button', { type: 'button', class: 'sec-h', 'aria-label': title, 'aria-expanded': String(!closed), onclick: () => { secState[id] = !secState[id]; store.set('jchat:secs', secState); renderSidebar(); } },
      el('span', 'txt', title), ico('chevd', 11, 'chev')));
  for (const x of extra) head.append(el('button', { type: 'button', class: 'sec-add', title: x.title, 'aria-label': x.title, onclick: x.run }, ico(x.icon)));
  if (add) head.append(el('button', { type: 'button', class: 'sec-add', title: add.title, 'aria-label': add.title, onclick: add.run }, ico('plus')));
  sec.append(head, el('div', 'sec-items', el('div', '', ...items)));
  return sec;
}
function convTooltip(c) {
  const base = importLabel(c) ? `${c.title} (imported from ${importLabel(c)})` : c.title;
  const time = fmtTimestamp(c.updated || c.created);
  return time ? `${base} · ${time}` : base;
}
function convItem(c, { child } = {}) {
  const streaming = state.streams.has(c.id);
  const lbl = el('span', { class: 'lbl', 'data-no-i18n': '' }, titleOf(c)); // the chat's own title: never translated
  if (c.kind === 'code' && !child) lbl.append(el('span', 'sub', c.project ? c.project.name : 'Code'));
  const st = streaming ? 'run' : c.status === 'waiting' ? 'wait' : null;
  const sv = splitState();
  const isActive = sv.on ? sv.focusedConv() === c : state.current === c;
  const inPane = sv.on && sv.shows(c.id);
  return el('button', { type: 'button', 'data-chat-id': c.id, class: `sitem${child ? ' child' : ''}${isActive ? ' active' : ''}${inPane ? ' in-pane' : ''}`, 'aria-current': isActive ? 'page' : null, title: convTooltip(c), onclick: () => switchTo(c),
    draggable: c.temp ? null : 'true', ondragstart: (e) => { try { e.dataTransfer.setData('text/eden-chat', c.id); e.dataTransfer.setData('text/plain', titleOf(c)); e.dataTransfer.effectAllowed = 'copyMove'; } catch {} },
    oncontextmenu: (e) => { e.preventDefault(); convMenu(e.currentTarget, c); } },
    ico(c.temp ? 'clock' : c.kind === 'code' ? 'term' : 'chat'), lbl,
    c.pinned && !child ? ico('pin', 11, 'pin-ic') : null,
    st ? el('span', 'dots', el('span', { class: `dot ${st}`, title: st === 'run' ? tx('running') : tx('waiting for you') })) : null);
}
let moreState = { apps: [], as: null, temps: [] };
/** The card under the strip: what is waiting or unfinished. Nothing when there's nothing to pick up. */
function continueCard(as, approvals) {
  if (as) return null;
  const cur = state.current;
  const other = (c) => !c.temp && c !== cur && c.kind !== 'code';
  const busy = state.convs.find((c) => other(c) && state.streams.has(c.id)) || state.convs.find((c) => other(c) && c.status === 'waiting');
  let t = null;
  if (busy) t = { icon: 'chat', title: state.streams.has(busy.id) ? 'Still replying' : 'Waiting for you', sub: titleOf(busy), own: true, run: () => switchTo(busy) };
  else if (approvals) t = { icon: 'list', title: `${approvals} ${approvals === 1 ? 'task is' : 'tasks are'} waiting`, sub: 'Open Tasks to approve', run: () => openTasks() };
  else if (!cur || !path(cur).length) {
    const last = state.convs.filter((c) => other(c) && (c.remote || path(c).length)).sort((a, b) => b.updated - a.updated)[0];
    if (last && Date.now() - last.updated < 864e5) t = { icon: 'chat', title: 'Continue', sub: titleOf(last), own: true, run: () => switchTo(last) };
  }
  if (!t) return null;
  return el('button', { type: 'button', class: 'cont-card', onclick: t.run }, ico(t.icon, 14), el('span', '', el('b', '', t.title), el('small', t.own ? { 'data-no-i18n': '' } : '', t.sub)));
}
/** The footer's More menu: what the sidebar leaves out because it's used now and then. */
function moreMenu(anchor) {
  const { apps, as, temps } = moreState;
  const personas = state.personas || [];
  openMenu(anchor, [
    ...apps.map((x) => ({ label: x.t, run: x.run })),
    ...(!as && !state.jarvis.available ? [{ label: IN_MAC_APP() ? 'Connecting to this Mac…' : 'Connect your Mac', run: go2(connectMacDialog) }] : []),
    ...(apps.length || (!as && !state.jarvis.available) ? ['-'] : []),
    { label: 'New temporary chat', run: () => newTemp() },
    ...temps.map((c) => ({ label: c.title || 'Temporary chat', note: 'temporary', run: () => switchTo(c) })),
    ...(as ? [] : ['-', { heading: 'Personas' },
      ...personas.map((p) => ({ label: p.name, run: () => { newChat(); setPersona(p.id); } })),
      { label: personas.length ? 'Edit or add a persona…' : 'New persona…', run: () => (personas.length ? personaManager(anchor) : editPersona(null)) }]),
  ]);
}
const go2 = (f) => () => { clearPhoneOverlays(); f(); };
function personaManager(anchor) {
  openMenu(anchor, [{ heading: 'Edit a persona' }, ...state.personas.map((p) => ({ label: p.name, run: () => editPersona(p.id) })), '-', { label: 'New persona…', run: () => editPersona(null) }]);
}
let chatLimit = 120;
const folderMore = new Map();
function folderMenu(anchor, name) {
  openMenu(anchor, [
    { label: 'Rename…', run: () => renameFolder(name) },
    { label: 'Tidy up with Eden', run: () => tidyUp() },
    '-',
    { label: 'Delete folder…', danger: true, run: () => deleteFolder(name) },
  ]);
}
function statusDot(c) { return state.streams.has(c.id) ? 'run' : c.status === 'waiting' ? 'wait' : 'done'; }
function renderSidebar() {
  const nav = $('sideScroll');
  const scroll = nav.scrollTop;
  const saved = state.convs.filter((c) => !c.temp);
  const pinned = saved.filter((c) => c.pinned).sort((a, b) => b.updated - a.updated);
  // projects: every listed project, with its sessions
  const byProject = new Map();
  for (const p of state.projects) byProject.set(p.path, { project: p, convs: [] });
  for (const c of saved.filter((x) => x.kind === 'code' && x.project)) {
    if (!byProject.has(c.project.path)) byProject.set(c.project.path, { project: c.project, convs: [] });
    byProject.get(c.project.path).convs.push(c);
  }
  const projItems = [];
  for (const { project, convs } of byProject.values()) {
    convs.sort((a, b) => b.updated - a.updated);
    const branch = (convs[0] && convs[0].project.branch) || project.branch;
    const openKey = `p:${project.path}`;
    const expanded = secState[openKey] !== false;
    projItems.push(el('button', { type: 'button', class: 'sitem', title: `${project.path}${branch ? ` · ${branch}` : ''}`, 'aria-expanded': convs.length ? String(expanded) : null,
      onclick: () => { if (!convs.length) newCodeSession(project); else { secState[openKey] = !expanded; store.set('jchat:secs', secState); renderSidebar(); } } },
    ico('folder'), el('span', 'lbl', el('span', { 'data-no-i18n': '' }, project.name), el('span', 'sub', `${branch || 'no branch'}${convs.length ? ` · ${convs.length} session${convs.length === 1 ? '' : 's'}` : ' · new session'}`)),
    convs.length ? el('span', 'dots', ...convs.slice(0, 4).map((c) => el('span', { class: `dot ${statusDot(c)}`, title: `${c.title} — ${statusDot(c) === 'run' ? 'running' : statusDot(c) === 'wait' ? 'waiting' : 'done'}` }))) : null));
    if (expanded) for (const c of convs.slice(0, 6)) projItems.push(convItem(c, { child: true }));
  }
  if (!projItems.length) projItems.push(el('div', 'side-empty', 'No projects yet.'));
  projItems.push(knowledgeItem()); // H11: folders indexed on the Mac, attached to projects (knowledge.js)
  // chats: folders first, then the rest by day (the first CHAT_PAGE, more on request)
  const chats = saved.filter((c) => c.kind !== 'code' && !c.pinned && !cleanName(c.folder)).sort((a, b) => b.updated - a.updated);
  const chatItems = [];
  const working = tidyCard(); // a tidy-up running, or waiting for review: shown above the list, even when Chats is folded
  if (!working && shouldNudge(state.convs, tidyLast())) {
    const n = unfiled(state.convs).length;
    chatItems.push(el('div', { class: 'tidy-nudge' },
      el('button', { type: 'button', class: 'tidy-go', onclick: () => tidyUp() }, ico('spark', 14), el('span', '', el('b', '', 'Tidy up with Eden'), el('small', '', `${n.toLocaleString(locale())} chats aren’t in a folder`))),
      el('button', { type: 'button', class: 'iconbtn tidy-x', title: 'Not now', 'aria-label': 'Not now', onclick: () => tidyDismiss() }, '×')));
  }
  const folderItems = [];
  for (const f of folderRows()) {
    const openKey = `f:${f.name.toLowerCase()}`;
    const expanded = secState[openKey] === true;
    const inside = chatsIn(f.name).filter((c) => !c.pinned).sort((a, b) => b.updated - a.updated);
    const more = folderMore.get(openKey) || 40;
    folderItems.push(el('div', { class: 'srow folder-row', ondragover: (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('text/eden-chat')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } }, ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const c = state.convs.find((x) => x.id === e.dataTransfer.getData('text/eden-chat')); if (c) { moveChat(c, f.name); secState[openKey] = true; store.set('jchat:secs', secState); renderSidebar(); } } },
      el('button', { type: 'button', class: 'sitem', 'aria-expanded': String(expanded), title: `${f.name} · ${f.count} chat${f.count === 1 ? '' : 's'}`, onclick: () => { secState[openKey] = !expanded; store.set('jchat:secs', secState); renderSidebar(); } },
        ico(expanded ? 'chevd' : 'chevr', 12, 'f-chev'), ico('folder'), el('span', { class: 'lbl', 'data-no-i18n': '' }, f.name), el('span', 'f-count', f.count.toLocaleString(locale()))),
      el('button', { type: 'button', class: 'iconbtn srow-edit', title: `${f.name} options`, 'aria-label': `Options for folder ${f.name}`, onclick: (e) => folderMenu(e.currentTarget, f.name) }, '⋯')));
    if (expanded) {
      for (const c of inside.slice(0, more)) folderItems.push(convItem(c, { child: true }));
      if (inside.length > more) folderItems.push(el('button', { type: 'button', class: 'sitem more-row child', onclick: () => { folderMore.set(openKey, more + 200); renderSidebar(); } }, el('span', 'lbl', `Show ${Math.min(200, inside.length - more)} more`)));
      if (!inside.length) folderItems.push(el('div', 'side-empty child', 'Empty. Drag a chat here.'));
    }
  }
  if (!folderItems.length) folderItems.push(el('div', 'side-empty', 'Group chats into folders. Add one with +.'));
  let lastDay = '';
  for (const c of chats.slice(0, chatLimit)) {
    const d = relDay(c.updated);
    if (d !== lastDay) { chatItems.push(el('div', 'sec-sub', d)); lastDay = d; }
    chatItems.push(convItem(c));
  }
  if (chats.length > chatLimit) chatItems.push(el('button', { type: 'button', class: 'sitem more-row', onclick: () => { chatLimit += 200; renderSidebar(); } }, el('span', 'lbl', `Show ${Math.min(200, chats.length - chatLimit).toLocaleString(locale())} more · ${(chats.length - chatLimit).toLocaleString(locale())} left`)));
  if (!chatItems.length) chatItems.push(el('div', 'side-empty', 'Your chats show here.'));
  const temps = state.convs.filter((c) => c.temp);
  // Acting for someone at askeden.com (acting.js): only what that grant can do here. The Mac,
  // Code and background tasks stay with this person's own account (they'd be refused); a
  // delegate's shared mail and calendar stay.
  const as = acting();
  const go = (f) => () => { clearPhoneOverlays(); f(); };
  const apps = [
    { k: 'brief', t: 'Brief', tip: 'Brief: your day, and meeting prep', i: 'sun', run: go(openBrief) },
    { k: 'memory', t: 'Memory', i: 'bulb', run: go(() => openSpace('memory')) },
    { k: 'brain', t: 'Second Brain', i: 'search', run: go(() => openSpace('brain')) },
    { k: 'files', t: 'Files', tip: 'Files on your Mac', i: 'folder', run: () => openFiles() },
    { k: 'calendar', t: 'Calendar', i: 'cal', run: go(openCalendar) },
    { k: 'mail', t: 'Mail', i: 'mail', run: go(() => openSpace('mail')) },
    { k: 'routines', t: 'Routines', i: 'routine', run: go(() => openSpace('routines')) },
    ...[['meetings', 'Meetings', 'quote'], ['web', 'On a website', 'globe'], ['activity', 'Activity', 'clock']].map(([k, t, i]) => ({ k, t, i, run: go(() => openSpace(k)) })), // H5–H7
    // Courses (courses.js) is off the menus; the code and the ?courses=1 link stay.
  ].filter((x) => !as || ((x.k === 'mail' || x.k === 'calendar') && actingHas(x.k))).filter((x) => as || state.jarvis.available || MAC_FREE.has(x.k));
  const approvals = pendingApprovals();
  // The strip under the header: the few places used every day, with a badge when something waits.
  const strip = [
    ...['mail', 'calendar'].map((k) => apps.find((x) => x.k === k)).filter(Boolean),
    // One pencil (owner, 2026-10-16): on the website the pencil is Essays (New chat is the button above); the app keeps New chat
    ...(ESSAYS && !as ? [] : [{ k: 'newchat', t: 'New chat', tip: 'New chat (⌘N)', i: 'edit', run: () => newChat() }]),
    ...['brief'].map((k) => apps.find((x) => x.k === k)).filter(Boolean),
    ...(as || !ESSAYS ? [] : [{ k: 'essays', t: 'Essays', tip: 'Essays: MLA, APA, Chicago or Harvard, laid out for you', i: 'edit', run: () => openEssayWriter() }]),
    ...(as ? [] : [{ k: 'tasks', t: 'Tasks', tip: 'Tasks: watches Eden runs in the background', i: 'list', run: () => openTasks(), badge: approvals }]),
  ];
  // News in the strip (owner, 2026-10-16); Workflows moves to More (still one tap away there, and ⌘K)
  if (state.meta && state.meta.newsInApp && !as) strip.splice(2, 0, { k: 'news', t: 'News', tip: 'News: today\u2019s stories, summed up from their sources', i: 'news', run: go(() => openNews()) });
  else strip.push({ k: 'workflows', t: 'Workflows', tip: 'Workflows: saved recipes you run in one tap', i: 'spark', run: () => openWorkflows() });
  const workflowsRow = { k: 'workflows', t: 'Workflows', tip: 'Workflows: saved recipes you run in one tap', i: 'spark', run: () => openWorkflows() };
  moreState = { apps: [...apps.filter((x) => !strip.some((y) => y.k === x.k)), ...(strip.some((y) => y.k === 'workflows') || as ? [] : [workflowsRow])], as, temps };
  const head = el('div', 'side-head',
    el('div', 'apps-strip', ...strip.map((x) => el('button', { type: 'button', class: 'ap', title: x.tip || x.t, 'aria-label': x.badge ? `${x.t}, ${x.badge} waiting` : x.t, onclick: x.run },
      ico(x.i, 16), x.badge ? el('b', { class: 'ap-b', title: 'Waiting for your approval' }, String(x.badge)) : null))),
    continueCard(as, approvals));
  const midScroll = nav.querySelector('.sec.grow .sec-items');
  const midTop = midScroll ? midScroll.scrollTop : 0;
  const top = el('div', 'side-top',
    pinned.length ? section('pinned', 'Pinned', pinned.map((c) => convItem(c))) : '',
    as ? '' : section('projects', 'Projects', projItems, { add: { title: 'New code session', run: projectPicker } }));
  const mid = el('div', { class: 'side-mid', ondragover: (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('text/eden-chat')) e.preventDefault(); },
    ondrop: (e) => { const c = state.convs.find((x) => x.id === e.dataTransfer.getData('text/eden-chat')); if (c && c.folder && !e.target.closest('.folder-row')) { e.preventDefault(); moveChat(c, ''); toast('Moved out of its folder'); } } },
  working,
  section('folders', 'Folders', folderItems, { cls: 'folders', extra: [{ title: 'Tidy up with Eden', icon: 'spark', run: () => tidyUp() }], add: { title: 'New folder', run: () => newFolder() } }),
  section('chats', 'Chats', chatItems, { grow: true, add: { title: 'New chat (⌘N)', run: newChat } }));
  nav.replaceChildren(head, top, mid);
  const again = nav.querySelector('.sec.grow .sec-items');
  if (again) again.scrollTop = midTop;
  nav.scrollTop = scroll;
}

/* ================= titlebar ================= */
const activeConv = () => { const sv = splitState(); return sv.on ? sv.focusedConv() : state.current; };
function renderTitle() {
  const c = activeConv();
  const t = $('tbTitle');
  if (!t.isContentEditable) t.textContent = c ? titleOf(c) : document.body.classList.contains('travel-standalone') ? 'Ask Eden' : tx('New chat'); // #tbTitle is data-no-i18n: the chat's own title
  const titleTime = c ? fmtTimestamp(c.updated || c.created) : '';
  t.title = titleTime ? `${tx('Double-click to rename')} · ${titleTime}` : tx('Double-click to rename');
  const site = inMailOnly() ? 'Eden Mail' : isMock ? 'Eden (mock)' : document.body.classList.contains('travel-standalone') ? 'Ask Eden Travel' : 'Eden';
  if (inMailOnly()) { document.title = site; return; }
  document.title = c && path(c).length ? `${c.title} — ${site}` : site;
  const code = c && c.kind === 'code';
  $('tbBranch').hidden = !(code && c.project && c.project.branch);
  $('tbBranchName').textContent = code && c.project ? c.project.branch || '' : '';
  $('tbDots').replaceChildren(...(code ? [el('span', { class: `dot ${statusDot(c)}`, title: statusDot(c) === 'run' ? 'running' : statusDot(c) === 'wait' ? 'waiting for you' : 'idle' })] : []));
  const tags = [];
  if (c && c.temp) tags.push(el('span', 'tag temp', 'Temporary'));
  if (importLabel(c)) tags.push(el('span', 'tag', `Imported from ${importLabel(c)}`));
  const p = persona(c ? c.personaId : state.draftPersona);
  if (p) tags.push(el('span', { class: 'tag', 'data-no-i18n': '' }, p.name));
  if (code && c.project) tags.push(el('span', { class: 'tag', 'data-no-i18n': '' }, c.project.name));
  $('tbTags').replaceChildren(...tags);
  const s = sessionCost(c);
  $('tbCtx').hidden = !code;
  $('tbCost').textContent = `${fmtCost(s.total)}${s.notional ? '*' : ''}`;
  $('tbCost').title = s.notional ? 'Session cost (* Claude via subscription: counted, not billed)' : 'Session cost';
  const pct = Number(($('jc-ctx-text').textContent || '0').replace('%', '')) || 0;
  $('tbCtxPct').textContent = `${pct}%`;
  $('ctxArc').setAttribute('stroke-dashoffset', String(40.2 * (1 - pct / 100)));
  $('tbCtx').title = `Context window: ${pct}% · session ${fmtCost(s.total)}`;
  $('btnConvMenu').disabled = false; // ••• always opens: a new chat gets its own short menu (convMenu)
  paintPrivacy(); // G9: the title bar's lock follows the chat
}

/* ================= transcript ================= */
const scrollcol = () => $('scrollcol');
let userScrolledTurn = false;
function toBottom() { const s = scrollcol(); s.scrollTop = s.scrollHeight; }
// Anchor the current turn's question and the top of the new output at the top of the viewport (like Claude, ChatGPT, and Gemini),
// reserving bottom runway on #transcript so the turn can scroll to the top immediately and stream downward without jumping.
function followReply(msg, { snapToTop = true } = {}) {
  const s = scrollcol();
  const box = $('transcript');
  if (!s || !box || !msg) return;
  const q = msg.previousElementSibling && msg.previousElementSibling.classList.contains('user') ? msg.previousElementSibling : msg;
  const sRect = s.getBoundingClientRect();
  const qRect = q.getBoundingClientRect();
  const mRect = msg.getBoundingClientRect();
  const qTop = s.scrollTop + (qRect.top - sRect.top);
  const mTop = s.scrollTop + (mRect.top - sRect.top);
  const mBottom = s.scrollTop + (mRect.bottom - sRect.top);
  const mdEl = msg.querySelector(':scope > .bubble > .md');
  const mdTop = mdEl ? s.scrollTop + (mdEl.getBoundingClientRect().top - sRect.top) : mTop;
  let targetTop;
  if (mdEl && (mdTop - qTop) > Math.max(220, s.clientHeight * 0.42)) {
    targetTop = Math.max(0, Math.round(mdTop - 88));
  } else if (q !== msg && qRect.height > Math.max(140, s.clientHeight * 0.28)) {
    targetTop = Math.max(0, Math.round(mTop - 52));
  } else {
    targetTop = Math.max(0, Math.round(qTop - 12));
  }
  const turnSpan = Math.max(0, mBottom - targetTop);
  const runway = Math.max(24, Math.ceil(s.clientHeight - turnSpan - 12));
  box.style.paddingBottom = `${runway}px`;
  if (snapToTop) {
    s.scrollTop = targetTop;
  }
}
function scrollTurnToTop() {
  const box = $('transcript');
  const lastMsg = box && box.lastElementChild;
  if (lastMsg && lastMsg.classList.contains('msg')) followReply(lastMsg, { snapToTop: true });
  else toBottom();
}
/** Q2: a research reply's report in the canvas (Markdown, drawn as a page; Download there saves the .md). */
function openReport(node) {
  const md = nodeText(node);
  if (!md) return;
  openArtifact({ title: reportTitle(md, node.research && node.research.report ? node.research.report.title : undefined), lang: 'markdown', code: md, nodeId: node.id, report: true });
}
// the report is ready: open it beside the chat (not on a phone, where the canvas would cover the chat)
addEventListener('eden:research-report', (e) => { const { c, node } = e.detail || {}; if (c && node && c === state.current && !isMobile()) openReport(node); });
function msgEl(c, n, last) {
  const m = renderMessage(c, n, { last });
  decorateVerify(m, c, n); // the label under a reply (verify.js)
  decorateEves(m, c, n); // EVES: the progress line while it runs, the badge and the work after (eves.js)
  decorateFirstRun(m, c, n); // Q4: a new person's first answer explained, with starter prompts (first-run.js)
  const chip = m.querySelector('.route-chip');
  if (chip) hoverIntent(chip, () => routePopContent(n.route, n.usage, { onOpenConsole: () => { closeChipPop(); selectTurn(n); } }));
  return m;
}
/**
 * A chat listed from another device whose messages haven't arrived (cloud-sync.js stub): "Loading this chat…", or why
 * it couldn't load with Retry. Never the new-chat screen, which invited typing into it.
 */
function stubState(c) {
  const retry = () => { delete c.loadError; renderTranscript(); dispatchEvent(new CustomEvent('eden:conv-opened', { detail: { conv: c } })); };
  return el('div', { id: 'empty', class: 'stub-state', role: 'status' },
    el('h1', '', c.loadError ? 'Couldn’t load this chat' : 'Loading this chat…'),
    el('p', 'lead', c.loadError ? c.loadError : 'Its messages are on their way from your account.'),
    c.loadError ? el('div', 'sugg', el('button', { type: 'button', onclick: retry }, el('b', '', 'Retry'), el('span', '', 'Ask askeden.com for it again'))) : null);
}
function renderTranscript() {
  const c = state.current;
  const box = $('transcript');
  if (c && c.remote && !Object.keys(c.nodes || {}).length) { box.replaceChildren(stubState(c)); return; }
  const nodes = path(c);
  if (!nodes.length) {
    box.replaceChildren(emptyState(c, { onSuggest: (text) => setComposerText(text) }));
    return;
  }
  // Incremental append: if the current DOM already renders the prefix of the conversation path,
  // append only newly added nodes instead of wiping and re-rendering the entire transcript DOM tree.
  const existingMsgs = box.querySelectorAll(':scope > .msg');
  if (existingMsgs.length > 0 && !box.querySelector('#empty') && existingMsgs.length < nodes.length) {
    let match = true;
    for (let i = 0; i < existingMsgs.length; i++) {
      if (existingMsgs[i].dataset.id !== nodes[i].id) { match = false; break; }
    }
    if (match) {
      // The previous last message might have follow-ups or styling specific to `last`
      const prevLastIdx = existingMsgs.length - 1;
      const prevLastEl = existingMsgs[prevLastIdx];
      const freshPrevLast = msgEl(c, nodes[prevLastIdx], false);
      prevLastEl.replaceWith(freshPrevLast);

      for (let i = existingMsgs.length; i < nodes.length; i++) {
        box.appendChild(msgEl(c, nodes[i], i === nodes.length - 1));
      }
      userScrolledTurn = false;
      scrollTurnToTop();
      requestAnimationFrame(scrollTurnToTop);
      return;
    }
  }
  box.replaceChildren(...nodes.map((n, i) => msgEl(c, n, i === nodes.length - 1)));
  if (nodes.length > 0) {
    scrollTurnToTop();
    requestAnimationFrame(scrollTurnToTop);
  } else {
    box.style.paddingBottom = '';
  }
}
// Ask Eden for Mac (window.askEdenMac, set by the app's preload; nothing on the web): a native
// notification when something needs the person and the window is in the background.
function macNotify(title, body) {
  try {
    const m = window.askEdenMac;
    if (m && typeof m.notify === 'function' && (document.hidden || !document.hasFocus())) m.notify(String(title || 'Eden'), String(body || ''));
  } catch (e) { /* the page works without it */ }
}
addEventListener('eden:notify', (e) => macNotify(e.detail && e.detail.title, e.detail && e.detail.body));
function macNotifyTurn(c, node) {
  if (node.error) return;
  const waiting = c.status === 'waiting';
  macNotify(c.title || 'Eden', tx(waiting ? 'Eden is waiting for your approval.' : 'Your reply is ready.'));
}
function updateMessage(c, node, { final, keepScroll } = {}) {
  if (final) macNotifyTurn(c, node);
  updateSplitMessage(c, node, { final });
  if (c !== state.current) { if (final) renderSidebar(); return; }
  const old = $('transcript').querySelector(`.msg[data-id="${node.id}"]`);
  const keepTop = scrollcol().scrollTop;
  const nodes = path(c);
  if (!old) { renderTranscript(); return; }
  const isLast = nodes.at(-1) === node;
  const focusAct = document.activeElement && old.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  const fresh = msgEl(c, node, isLast);
  old.replaceWith(fresh);
  if (!IN_APP && node.streaming) {
    const vp = fresh.querySelector('.ath-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  }
  if (focusAct) { const f = fresh.querySelector(`[data-act="${focusAct}"]`); if (f) f.focus({ preventScroll: true }); }
  if (isLast && !keepScroll) {
    followReply(fresh, { snapToTop: !userScrolledTurn });
    if (userScrolledTurn) scrollcol().scrollTop = keepTop;
  } else {
    scrollcol().scrollTop = keepTop;
  }
  if (final) { renderComposer(); renderTitle(); refreshArtifact(); if (c.kind === 'code') renderPlan(); }
  else { renderTitle(); }
}
function selectTurn(node) {
  state.selectedNode = node;
  renderTurnCard(node);
  openInspector('Route');
}
function renderAll() { renderSidebar(); renderTitle(); renderTranscript(); renderComposer(); renderTurnCard(state.selectedNode); renderPlan(); renderActivity(); }

function animateOpen(body, open) {
  if (open) {
    body.style.maxHeight = `${body.scrollHeight}px`;
    const done = () => { body.style.maxHeight = 'none'; body.removeEventListener('transitionend', done); };
    body.addEventListener('transitionend', done);
    setTimeout(done, 450);
  } else {
    body.style.maxHeight = `${body.scrollHeight}px`;
    void body.offsetHeight;
    body.style.maxHeight = '0px';
  }
}

function nodeOf(target, conv = state.current) {
  const m = target.closest('.msg');
  const c = conv || state.current;
  return m && c ? c.nodes[m.dataset.id] : null;
}

function citePop(anchor, node, n) {
  const src = node && node.citations && node.citations[n - 1];
  if (!src) return;
  const pop = $('citePop');
  let href = null;
  try { const u = new URL(src.url); if (u.protocol === 'http:' || u.protocol === 'https:') href = u.href; } catch { href = null; }
  pop.replaceChildren(el('b', { 'data-no-i18n': '' }, src.title || src.url), el('span', { class: 'u', 'data-no-i18n': '' }, src.url),
    el('div', 'acts', href ? el('a', { class: 'cap primary', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open') : null,
      el('button', { type: 'button', class: 'cap', onclick: () => copyText(src.url) }, 'Copy link')));
  pop.classList.add('open');
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(innerWidth - 296, Math.max(8, r.left - 20))}px`;
  pop.style.top = `${r.bottom + 140 > innerHeight ? r.top - 120 : r.bottom + 8}px`;
  pop._anchor = anchor;
  requestAnimationFrame(() => { const a = pop.querySelector('a, button'); if (a) a.focus(); });
}
function closeCite() { const p = $('citePop'); if (!p.classList.contains('open')) return false; p.classList.remove('open'); if (p._anchor && document.contains(p._anchor)) p._anchor.focus(); return true; }

function regenMenu(anchor, c, node) {
  const models = availableModels();
  const cur = node.route && node.route.model;
  openMenu(anchor, [
    { label: 'Try again', note: 'The router picks again (may choose the same model)', run: () => regenerate(c, node) },
    { label: 'With another model', note: 'A new draft on the model you pick', sub: () => models.map((m) => ({ label: m.name, note: m.id === cur ? 'This draft’s model' : '', run: () => { dispatchEvent(new CustomEvent('eden:choice', { detail: { kind: 'regenerate', c, node, to: m.id } })); regenerate(c, node, { model: m.id, effort: m.defaultEffort }); } })) }, // H2: learned.js
    '-',
    { label: 'More capable (Level 5)', note: 'Max performance for this draft', run: () => { const prev = state.settings.level; setLevel(5); regenerate(c, node); setTimeout(() => setLevel(prev), 0); } },
    { label: 'Cheaper (Level 1)', note: 'Max efficiency for this draft', run: () => { const prev = state.settings.level; setLevel(1); regenerate(c, node); setTimeout(() => setLevel(prev), 0); } },
  ]);
}

function onTranscriptClick(e, conv = state.current, box = $('transcript'), setPaneInput = setComposerText) {
  const c = conv || state.current;
  const cite = e.target.closest('[data-cite]');
  if (cite) { e.stopPropagation(); citePop(cite, nodeOf(cite, c), Number(cite.dataset.cite)); return; }
  const b = e.target.closest('[data-act]');
  if (!b) {
    // Tapping a reply bubble in a split pane toggles its model details just like the main transcript
    if (box !== $('transcript')) {
      const bubble = e.target.closest?.('.msg.assistant > .bubble');
      if (!bubble || e.target.closest?.('a, button, input, textarea, select, label, summary, [role="button"], [contenteditable="true"], [data-act], .route-chip, .codeblk, pre') || String(window.getSelection?.() || '')) return;
      const m = bubble.parentElement, id = m && m.dataset.id;
      if (!id || !m.querySelector(':scope > .msg-head')) return;
      const show = !ui_open.meta.has(id);
      if (show) ui_open.meta.add(id); else ui_open.meta.delete(id);
      m.classList.toggle('meta-hidden', !show);
    }
    return;
  }
  if (!c) return;
  const node = nodeOf(b, c);
  if (!node) return;
  const redraw = () => { if (c === state.current) renderTranscript(); else renderSplitPaneFor(c); };
  const act = b.dataset.act;
  switch (act) {
    case 'chip':
      if (chipPopOpenFor(b)) closeChipPop();
      else openChipPop(b, routePopContent(node.route, node.usage, { onOpenConsole: () => { closeChipPop(); selectTurn(node); } }));
      state.selectedNode = node; renderTurnCard(node);
      break;
    case 'think': {
      const card = b.closest('.auto-think-glass');
      if (card && !IN_APP) {
        const activelyThinking = Boolean(node.streaming && (node.thinkingLive || !nodeText(node).trim()));
        if (activelyThinking) {
          if (ui_open.thinkClosed.has(node.id)) ui_open.thinkClosed.delete(node.id);
          else ui_open.thinkClosed.add(node.id);
        } else {
          if (ui_open.thinks.has(node.id)) ui_open.thinks.delete(node.id);
          else ui_open.thinks.add(node.id);
        }
        updateMessage(c, node, { keepScroll: true });
        break;
      }
      const open = !ui_open.thinks.has(node.id);
      if (open) ui_open.thinks.add(node.id); else ui_open.thinks.delete(node.id);
      b.setAttribute('aria-expanded', String(open));
      animateOpen(b.nextElementSibling, open);
      break;
    }
    case 'tool': {
      const card = b.closest('.tool');
      const id = card.dataset.tool;
      const open = !ui_open.tools.has(id);
      if (open) ui_open.tools.add(id); else ui_open.tools.delete(id);
      card.classList.toggle('open', open);
      b.setAttribute('aria-expanded', String(open));
      animateOpen(card.querySelector('.tool-body'), open);
      break;
    }
    case 'sib-prev': case 'sib-next': {
      if (state.streams.has(c.id)) { toast('Wait for the reply, or stop it first'); return; }
      const n = selectSibling(c, node, act === 'sib-prev' ? -1 : 1);
      if (n) { saveConversation(c); redraw(); if (c === state.current) { renderComposer(); renderTitle(); } const m = box.querySelector(`.msg[data-id="${n.id}"] [data-act="${act}"]`); if (m && !m.disabled) m.focus(); }
      break;
    }
    case 'to-essay': if (ESSAYS) import('./essay.js').then((m) => m.pasteIntoEssay(nodeText(node))).catch((e) => toast(`Couldn’t open the essay writer: ${e.message}`)); break;
    case 'eves-check': import('./eves-check.js').then((m) => m.runEvesCheck(c, node, nodeText(node), () => updateMessage(c, node, { keepScroll: true }))).catch((e) => toast(`Couldn’t start EVES: ${e.message}`)); break; // off by default, never in the iPhone app (eves-check.js)
    case 'copy-msg': if (node.role === 'user') copyText(node.content || ''); else copyRich(nodeText(node)); break;
    case 'open-mail': { const d = parseEmailDraft(nodeText(node)); if (d) openCompose({ to: d.to, cc: d.cc, subject: d.subject, body: d.body }); break; } // the user reviews and sends
    case 'expand-user':
      if (ui_open.expanded.has(node.id)) ui_open.expanded.delete(node.id); else ui_open.expanded.add(node.id);
      updateMessage(c, node);
      break;
    case 'edit':
      ui_open.editing = node.id;
      redraw();
      requestAnimationFrame(() => { const ta = box.querySelector('textarea[data-edit]'); if (ta) { ta.focus(); ta.selectionStart = ta.value.length; ta.style.height = `${Math.min(300, ta.scrollHeight)}px`; } });
      break;
    case 'edit-cancel': ui_open.editing = null; redraw(); break;
    case 'edit-send': {
      const ta = b.closest('.msg').querySelector('textarea[data-edit]');
      const text = ta.value.trim();
      ui_open.editing = null;
      if (!text) { redraw(); return; }
      editResend(c, node, text);
      break;
    }
    case 'regen': regenMenu(b, c, node); break;
    case 'inspect': selectTurn(node); break;
    case 'retry': retry(c, node); break;
    case 'continue': if (c === state.current) sendFromComposer('Continue exactly where you stopped, without repeating anything.', [], []); else sendMessage('Continue exactly where you stopped, without repeating anything.', [], { conv: c }); break; // a reply cut off at the output limit
    case 'followup': {
      const prompt = (b.dataset.prompt || '').trim();
      if (!prompt) break;
      if (e.shiftKey || e.altKey || state.streams.has(c.id)) setPaneInput(prompt);
      else if (c === state.current) sendFromComposer(prompt, [], []);
      else sendMessage(prompt, [], { conv: c });
      break;
    }
    case 'perm': answerPermission(c, node, Number(b.closest('[data-perm]').dataset.perm), b.dataset.choice); break;
    case 'hunk': {
      const h = b.closest('[data-hunk]');
      const id = h.dataset.hunk;
      setHunk(c, id, b.dataset.state, { quiet: b.dataset.state === 'pending' });
      if (b.dataset.state === 'revert') {
        const part = (node.parts || []).find((p) => p.id === id.split(':')[0]);
        const file = b.dataset.file || (part && part.input && part.input.file_path) || 'that file';
        setPaneInput(`Revert edit ${Number(id.split(':')[1]) + 1} you made to ${file}.`);
      }
      updateMessage(c, node);
      break;
    }
    case 'copy-code': { const blk = b.closest('.cblock'); if (blk) copyText(blk._code || ''); break; }
    case 'canvas': case 'codeview': {
      const blk = b.closest('.cblock');
      if (!blk) return;
      const arts = artifactsIn(nodeText(node));
      const a = arts.find((x) => x.code === blk._code);
      openArtifact({ title: a ? a.title : act === 'canvas' ? 'Artifact' : `${blk._lang || 'Code'} snippet`, lang: blk._lang === 'htm' ? 'html' : blk._lang, code: blk._code, nodeId: node.id });
      break;
    }
    case 'open-art': { const a = artifactsIn(nodeText(node))[Number(b.dataset.k)]; if (a) openArtifact({ ...a, nodeId: node.id }); break; }
    case 'research-open': openReport(node); break; // Q2: the checked research report in the canvas
    case 'research-md': { const md = nodeText(node); download(reportFileName(reportTitle(md, node.research && node.research.report ? node.research.report.title : undefined)), md); break; }
    case 'open-keys': openSettings(0); break;
    default: break;
  }
}

/* ================= palette ================= */
let palIdx = 0, palItems = [];
function commands() {
  const c = state.current;
  const list = [
    { t: 'New chat', s: '⌘N', i: 'edit', run: newChat },
    { t: 'New temporary chat', s: 'Not saved', i: 'clock', run: newTemp },
    { t: 'New code session…', s: 'Code', i: 'term', run: projectPicker },
    { t: 'Open Route console', s: 'Inspector', i: 'sliders', run: () => openInspector('Route') },
    { t: 'Open Plan', s: 'Inspector', i: 'list', run: () => openInspector('Plan') },
    { t: 'Open Changes', s: 'Inspector', i: 'edit', run: () => openInspector('Changes') },
    { t: 'Toggle inspector', s: '⌘⌥0', i: 'insp', run: toggleInspector },
    { t: 'Toggle sidebar', s: '⌘B', i: 'side', run: () => toggleSidebar() },
    ...splitPaletteCommands(),
    { t: 'Code activity', s: '⌘J', i: 'term', run: () => toggleDrawer() },
    { t: 'Morning brief', s: 'Calendar · mail · notes', i: 'sun', run: () => openBrief() },
    { t: 'Memory', s: 'Your Mac', i: 'bulb', run: () => openSpace('memory') },
    { t: 'Import chats', s: 'From ChatGPT, Claude or Gemini · your chats and memories', i: 'spark', run: () => openImportChats() },
    { t: 'Share this chat…', s: 'A read-only link to the messages you pick', i: 'globe', run: () => openShare(state.current) },
    { t: 'Search Second Brain', s: 'Your Mac', i: 'search', run: () => openSpace('brain') },
    { t: 'Calendar', s: 'Your Mac · Google', i: 'cal', run: () => openCalendar() },
    { t: 'New calendar event…', s: 'Calendar', i: 'cal', run: () => openCalendar({ newEvent: true }) },
    { t: 'Open Mail', s: 'Gmail · Mail on your Mac', i: 'mail', run: () => openSpace('mail') },
    { t: 'Tasks', s: 'Background watches · approvals', i: 'list', run: () => openTasks() },
    { t: 'Workflows', s: 'Saved recipes', i: 'spark', run: () => openWorkflows() },
    ...(ESSAYS ? [{ t: 'Essays', s: 'MLA · APA · Chicago · Harvard', i: 'edit', run: () => openEssayWriter() },
      ...['mla', 'apa', 'chicago', 'harvard'].map((k) => ({ t: `New ${k === 'mla' || k === 'apa' ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)} essay`, s: 'Essays · formatted for you', i: 'edit', run: () => openEssayWriter(k) }))] : []),
    { t: 'New email…', s: 'Compose · Gmail or Mail on your Mac', i: 'mail', run: () => openCompose({}) },
    { t: 'Send me a heads-up…', s: 'Your Mac · notify', i: 'bell', run: () => openSpace('routines') },
    { t: 'Meetings', s: 'Your Mac · notes and action items', i: 'quote', run: () => openSpace('meetings') },
    { t: 'Browser', s: '⌘⇧B', i: 'globe', run: () => toggleBrowser() },
    { t: 'Do this on a website…', s: 'Your Mac · the built-in browser', i: 'globe', run: () => openSpace('web') },
    { t: 'Activity: what Eden did', s: 'Undo', i: 'clock', run: () => openSpace('activity') },
    ...sheetCommands(),
    { t: 'Choose model…', s: '⌘⇧I', i: 'spark', run: () => { modelMenu(); } },
    { t: 'Use the router (auto)', s: 'Model', i: 'sliders', run: () => setOverride(null) },
    ...[1, 2, 3, 4, 5].map((n) => ({ t: `Router level ${n}`, s: 'Optimization', i: 'chart', run: () => { setLevel(n); toast(`Level ${n}`); } })),
    { t: 'New persona…', s: 'Personas', i: 'spark', run: () => editPersona(null) },
    { t: 'API Keys & Spend Dashboard', s: '⌘,', i: 'key', run: () => openSettings(0) },
    { t: 'Settings & API keys', s: '⌘,', i: 'gear', run: () => openSettings(0) },
    { t: 'Switch appearance', s: 'Light / Dark / System', i: 'moon', run: cycleTheme },
    { t: 'Take the tour', s: 'Try every feature, safely', i: 'spark', run: () => startTour() },
    { t: 'Download apps', s: 'Eden for Mac, Eden Messenger', i: 'down', run: () => { location.href = DOWNLOAD_URL; } },
    ...helpCommands(),
  ];
  const plus = planCommand(); // Eden Plus (plan.js): free with billing here, or Manage billing
  if (plus) list.push(plus);
  if (c) list.push(
    { t: c.pinned ? 'Unpin this chat' : 'Pin this chat', s: 'Chat', i: 'pin', run: () => togglePin(c) },
    { t: 'Rename this chat', s: 'Double-click the title', i: 'edit', run: startRename },
    { t: 'Export as Markdown', s: 'Chat', i: 'down', run: () => exportConversation(c) },
    { t: 'Delete this chat…', s: 'Chat', i: 'trash', run: () => removeConversation(c) });
  for (const p of state.personas) list.push({ t: `Edit persona: ${p.name}`, s: 'Personas', i: 'spark', run: () => editPersona(p.id) });
  return list;
}
function openPalette() {
  clearPhoneOverlays();
  $('palette').classList.add('open');
  const inp = $('palInput');
  inp.value = '';
  renderPal('');
  // focus now: with a delay, keys typed straight after ⌘K went to the chat composer and Enter ran the
  // unfiltered top item (a recent code session) instead of what was typed (ROADMAP F13)
  inp.focus();
  setTimeout(() => { if ($('palette').classList.contains('open') && document.activeElement !== inp) inp.focus(); }, 30);
}
function closePalette() { if (!$('palette').classList.contains('open')) return false; $('palette').classList.remove('open'); focusComposer(); return true; }
function renderPal(q) {
  q = q.toLowerCase().trim();
  const convs = state.convs.filter((c) => {
    if (!q) return true;
    if (c.title.toLowerCase().includes(q)) return true;
    return Object.values(c.nodes).some((n) => (n.role === 'user' ? n.content || '' : nodeText(n)).toLowerCase().includes(q));
  }).sort((a, b) => b.updated - a.updated).slice(0, q ? 12 : 6)
    .map((c) => ({ t: titleOf(c), s: c.kind === 'code' ? `Code · ${c.project ? c.project.name : ''}` : c.temp ? 'Temporary' : relDay(c.updated), i: c.kind === 'code' ? 'term' : 'chat', run: () => switchTo(c), group: 'Conversations' }));
  const cmds = commands().filter((x) => !q || `${x.t} ${x.s} ${tx(x.t)} ${tx(x.s || '')}`.toLowerCase().includes(q)) // the French names find them too.map((x) => ({ ...x, group: 'Actions' }));
  palItems = [...convs, ...cmds];
  palIdx = 0;
  const list = $('palList');
  if (!palItems.length) { list.replaceChildren(el('div', 'pal-empty', 'No results')); return; }
  const kids = [];
  let g = '';
  const touch = isTouch(); // shortcut-only subtitles (⌘N) mean nothing on a touch screen
  palItems.forEach((it, i) => {
    if (it.group !== g) { kids.push(el('div', { class: 'pal-grp', role: 'presentation' }, it.group)); g = it.group; }
    const row = el('div', { class: `pal-it${i === palIdx ? ' sel' : ''}`, role: 'option', id: `pal-${i}`, 'aria-selected': String(i === palIdx) }, ico(it.i), el('span', it.group === 'Conversations' ? { class: 't', 'data-no-i18n': '' } : 't', it.t), el('span', 'sub', touch && /^[⌘⇧⌥]/.test(it.s || '') ? '' : it.s));
    row.addEventListener('mousemove', () => { if (palIdx !== i) { palIdx = i; paintPal(); } });
    row.addEventListener('click', () => execPal(i));
    kids.push(row);
  });
  list.replaceChildren(...kids);
  $('palInput').setAttribute('aria-activedescendant', 'pal-0');
}
function paintPal() {
  qsa('#palList .pal-it').forEach((r) => { const i = Number(r.id.slice(4)); r.classList.toggle('sel', i === palIdx); r.setAttribute('aria-selected', String(i === palIdx)); });
  const sel = $(`pal-${palIdx}`);
  if (sel) sel.scrollIntoView({ block: 'nearest' });
  $('palInput').setAttribute('aria-activedescendant', `pal-${palIdx}`);
}
function execPal(i) { const it = palItems[i]; if (!it) return; $('palette').classList.remove('open'); it.run(); }

/* ================= dialogs ================= */
let dlgReturn = null;
// Spaces that work without the Mac (Gmail and Google Calendar through askeden.com, Courses); the rest need Eden on a Mac.
const MAC_FREE = new Set(['mail', 'calendar', 'courses']);
/** The essay writer, loaded when first opened: its list, or a new essay in a style (website only). */
const openEssayWriter = (style) => (ESSAYS ? import('./essay.js').then((m) => (style ? m.newEssayIn(style) : m.openEssays())).catch((e) => toast(`Couldn’t open the essay writer: ${e.message}`)) : Promise.resolve());
// A dropped rubric or assignment sheet (composer.js eden:attached): the essay writer opens, set up from it (essay-model.js rubricOf)
if (ESSAYS) addEventListener('eden:attached', (ev) => {
  const d = ev.detail || {};
  if (state.current && state.current.kind === 'code') return;
  import('./essay-model.js').then(({ rubricOf }) => {
    const r = rubricOf(d.name, d.text);
    if (r) import('./essay.js').then((m) => m.startFromRubric(r));
  }).catch(() => {});
});
const IN_MAC_APP = () => document.documentElement.classList.contains('eden-desktop');
function connectMacDialog() {
  const p = (t) => el('p', { style: { fontSize: '14px', lineHeight: '1.45', color: 'var(--text2)', margin: '0 0 10px' } }, t);
  if (IN_MAC_APP()) {
    openDialog('Connecting to this Mac', el('div', '',
      p('Ask Eden is connecting to this Mac. This usually takes a few seconds.'),
      el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
        el('button', { type: 'button', class: 'btn', onclick: () => { try { window.askEdenMac?.relink?.(); } catch {} } }, 'Try again'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => closeDialog() }, 'Close'))));
    return;
  }
  openDialog('Connect your Mac', el('div', '',
    p('With Eden on your Mac you also get Brief, Memory, Second Brain, Files, Routines, Meetings, Activity, and Eden doing things on websites for you.'),
    p('Ask Eden for Mac is a free download. It runs Eden on your Mac and connects to your account by itself.'),
    p('Beta: this early build is not yet signed by Apple, so the first time you open it, Control-click the app and choose Open.'),
    el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
      el('button', { type: 'button', class: 'btn', onclick: () => closeDialog() }, 'Not now'),
      el('a', { class: 'btn primary', href: '/download/mac', download: '' }, 'Download for Mac (beta)'))));
}
function openDialog(title, body) {
  dlgReturn = document.activeElement;
  clearPhoneOverlays();
  $('dlgTitle').textContent = title;
  if (body !== $('dlgBody')) $('dlgBody').replaceChildren(body);
  $('dlg').classList.add('open');
  requestAnimationFrame(() => { const f = $('dlgBody').querySelector('input, textarea, button'); (f || $('btnDlgClose')).focus(); });
}
function closeDialog() {
  if (!$('dlg').classList.contains('open')) return false;
  $('dlg').classList.remove('open');
  if (dlgReturn && document.contains(dlgReturn)) dlgReturn.focus();
  return true;
}
function confirmDialog(text, okLabel, run, danger) {
  openDialog('Are you sure?', el('div', '', el('p', { style: { fontSize: '14px', lineHeight: '1.45', color: 'var(--text2)' } }, text),
    el('div', { class: 'dlg-acts', style: { marginTop: '16px' } },
      el('button', { type: 'button', class: 'btn', onclick: closeDialog }, 'Cancel'),
      el('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { closeDialog(); run(); } }, okLabel))));
}
// The iPhone app has no OK for AI providers yet (caps.aiConsent === false): chat.js sends nothing and asks here.
addEventListener('eden:ai-consent', () => {
  openDialog('Allow AI providers?', el('div', '',
    el('p', { style: { fontSize: '14px', lineHeight: '1.45', color: 'var(--text2)' } }, AI_CONSENT_WORDS),
    el('div', { class: 'dlg-acts', style: { marginTop: '16px' } },
      el('button', { type: 'button', class: 'btn', onclick: closeDialog }, 'Not now'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => { closeDialog(); reviewAiConsent(); } }, 'Review'))));
});
function editPersona(id) {
  const p = id ? persona(id) : null;
  const name = el('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Code Reviewer' });
  const sys = el('textarea', { placeholder: 'How it should answer: tone, format, what to focus on…' });
  name.value = p ? p.name : '';
  sys.value = p ? p.system : '';
  const save = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    if (p) Object.assign(p, { name: n, system: sys.value.trim() });
    else state.personas.push({ id: `p${Date.now().toString(36)}`, name: n, system: sys.value.trim() });
    savePersonas();
    closeDialog();
    renderSidebar(); renderAttachments(); renderTitle();
    toast(p ? 'Persona saved' : `Persona “${n}” added`);
  };
  openDialog(p ? 'Edit persona' : 'New persona', el('div', '',
    el('label', 'field', 'Name', name),
    el('label', 'field', 'Instructions (sent as the system prompt)', sys),
    el('div', 'dlg-acts',
      p ? el('button', { type: 'button', class: 'btn danger', onclick: () => {
        state.personas = state.personas.filter((x) => x !== p);
        savePersonas();
        for (const c of state.convs) if (c.personaId === p.id) { c.personaId = null; c.metaAt = Date.now(); saveConversation(c); }
        closeDialog(); renderSidebar(); renderAttachments(); toast('Persona deleted');
      } }, 'Delete') : null,
      el('span', 'grow'),
      el('button', { type: 'button', class: 'btn', onclick: closeDialog }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save'))));
}
/** The title bar's buttons a narrow phone moves into ⋯ (mobile.css, R2-7): here, so none is lost. */
function narrowItems() {
  const items = [];
  if (matchMedia('(max-width:430px)').matches) {
    if (document.body.classList.contains('canvas-hidden') && $('btnCanvasBack')) items.push({ label: 'Show canvas', run: () => $('btnCanvasBack').click() });
    if ($('btnHelp')) items.push({ label: 'Help', run: () => $('btnHelp').click() });
  }
  if (matchMedia('(max-width:380px)').matches) items.push({ label: 'Inspector', run: () => toggleInspector() });
  return items.length ? ['-', ...items] : [];
}
function convMenu(anchor, c) {
  if (document.body.classList.contains('travel-standalone')) { // Eden Travel: this chat about the trip, nothing of Eden's
    openMenu(anchor, [
      { label: 'New chat', run: () => document.dispatchEvent(new CustomEvent('eden:new-chat')) },
      c ? { label: 'Rename', run: () => { if (state.current !== c) switchTo(c); startRename(); } } : null,
      '-',
      { label: 'Settings', key: '⌘,', run: () => openSettings(0) },
      c ? '-' : null,
      c ? { label: 'Delete…', danger: true, run: () => removeConversation(c) } : null,
    ]);
    return;
  }
  if (!c) { // a new chat, nothing sent yet: still a menu, never a dead button
    openMenu(anchor, [
      { heading: 'New chat' },
      { label: 'Rename', disabled: true, note: 'Send a message first' },
      ...splitMenuItems(),
      { label: 'Browser', key: '⌘⇧B', run: () => toggleBrowser() },
      { label: 'Command palette', key: '⌘K', run: () => openPalette() },
      { label: 'Settings', key: '⌘,', run: () => openSettings(0) },
      ...(anchor && anchor.id === 'btnConvMenu' ? narrowItems() : []),
    ]);
    return;
  }
  const narrow = anchor && anchor.id === 'btnConvMenu' ? narrowItems() : []; // the title bar's ⋯ only: ['-', …] or []
  const rowSplit = anchor && anchor.id !== 'btnConvMenu' ? splitRowItem(c) : null;
  const barSplit = anchor && anchor.id === 'btnConvMenu' ? splitMenuItems() : [];
  openMenu(anchor, [
    ...narrow.slice(1), ...narrow.slice(0, 1),
    { label: 'Rename', run: () => { if (state.current !== c) switchTo(c); startRename(); } },
    ...(rowSplit ? [rowSplit] : []),
    ...(c.temp ? [] : [{ label: c.pinned ? 'Unpin' : 'Pin', run: () => togglePin(c) }]),
    ...(c.temp || c.kind === 'code' ? [] : [moveItems(c, openMenu, anchor)]),
    ...(c.temp || c.kind === 'code' ? [] : [{ label: 'Share a read-only link…', run: () => openShare(c) }]), // Q3
    { label: 'Export as Markdown', run: () => exportConversation(c) },
    ...(c.kind !== 'code' ? [{ label: 'Save as workflow…', run: () => saveWorkflowFrom(c) }] : []), // H9
    ...(c.kind === 'code' ? [{ label: 'Code activity', key: '⌘J', run: () => toggleDrawer(true) }, { label: 'Changes', run: () => openInspector('Changes') }] : []),
    ...(barSplit.length ? ['-', ...barSplit] : []),
    '-',
    { label: 'Delete…', danger: true, run: () => removeConversation(c) },
  ]);
}
function startRename() {
  const t = $('tbTitle');
  const c = activeConv();
  if (!c) { toast('Send a message first'); return; }
  t.contentEditable = 'true';
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function finishRename(save) {
  const t = $('tbTitle');
  if (t.contentEditable !== 'true') return;
  t.contentEditable = 'false';
  const c = activeConv();
  if (save && c) { renameConversation(c, t.textContent); renderSplitPaneFor(c); }
  renderTitle();
}

/* ================= settings ================= */
let setTabI = 0;
function paintColorWheel(canvas, brightness = 1) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const size = 132, dpr = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1)), px = Math.round(size * dpr);
  if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return;
  const img = ctx.createImageData(px, px), data = img.data, half = px / 2, val = clampNum(brightness, 0.2, 1);
  for (let y = 0; y < px; y += 1) {
    const dy = y + 0.5 - half;
    for (let x = 0; x < px; x += 1) {
      const dx = x + 0.5 - half, dist = Math.hypot(dx, dy);
      if (dist > half + 0.8) continue;
      let angle = Math.atan2(dy, dx) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      const rgb = hsvRgb(angle, Math.min(1, dist / half), val);
      const a = dist > half - 1 ? clampNum(half + 0.8 - dist, 0, 1) : 1;
      const i = (y * px + x) * 4;
      data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b; data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}
function colorPickerSection() {
  const card = el('div', 'icard ecp-card');
  const resetBtn = el('button', { type: 'button', class: 'ecp-reset', onclick: () => { setAccentColor(''); sync(); } }, 'Reset');
  const top = el('div', 'ecp-top',
    el('div', 'ecp-head', el('span', 'ecp-title', 'Theme color'), el('span', 'ecp-sub', 'Choose a preset color or spin the RGB wheel.')),
    resetBtn);
  const swatchBtns = new Map();
  const presets = el('div', { class: 'ecp-presets', role: 'radiogroup', 'aria-label': 'Preset colors' },
    ...COLOR_PRESETS.map(([, label, hex]) => {
      const b = el('button', { type: 'button', class: 'ecp-swatch', role: 'radio', 'data-color': hex, 'aria-label': label, title: label, onclick: () => { setAccentColor(hex); sync(); } });
      b.style.setProperty('--sw-color', hex);
      b.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>';
      swatchBtns.set(hex, b);
      return b;
    }));
  const canvas = el('canvas', 'ecp-wheel-canvas');
  const thumb = el('span', 'ecp-wheel-thumb');
  const wheelWrap = el('div', { class: 'ecp-wheel-wrap', tabindex: '0', role: 'slider', 'aria-label': 'RGB color wheel' }, canvas, thumb);
  const previewDot = el('span', 'ecp-preview-dot');
  const hexInput = el('input', { type: 'text', class: 'ecp-hex', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Hex color', 'data-no-i18n': '' });
  const brightVal = el('span', { 'data-no-i18n': '' }, '100%');
  const brightSlider = el('input', { type: 'range', class: 'ecp-bright', min: '0', max: '100', step: '1', value: '100', 'aria-label': 'Brightness' });
  const makeCh = (lbl, aria) => {
    const inp = el('input', { type: 'number', min: '0', max: '255', 'aria-label': aria, 'data-no-i18n': '' });
    return { wrap: el('label', 'ecp-rgb-field', el('span', { 'data-no-i18n': '' }, lbl), inp), inp };
  };
  const rCh = makeCh('R', 'Red channel'), gCh = makeCh('G', 'Green channel'), bCh = makeCh('B', 'Blue channel');
  const controls = el('div', 'ecp-controls',
    el('div', 'ecp-preview-row', previewDot, hexInput),
    el('div', 'ecp-bright-row', el('div', 'ecp-bright-head', el('span', '', 'Brightness'), brightVal), brightSlider),
    el('div', 'ecp-rgb-row', rCh.wrap, gCh.wrap, bCh.wrap));
  card.append(top, presets, el('div', 'ecp-wheel-row', wheelWrap, controls));
  let curHsv = rgbHsv(0, 122, 255), lastV = -1, dragging = false;
  const pickAt = (e) => {
    const rect = wheelWrap.getBoundingClientRect(), r = (rect.width || 132) / 2;
    const dx = e.clientX - (rect.left + r), dy = e.clientY - (rect.top + r);
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (angle < 0) angle += 360;
    const vUse = curHsv.v > 0.05 ? curHsv.v : 1;
    curHsv = { h: angle, s: clampNum(Math.hypot(dx, dy) / r, 0, 1), v: vUse };
    const rgb = hsvRgb(curHsv.h, curHsv.s, curHsv.v);
    setAccentColor(rgbHex(rgb.r, rgb.g, rgb.b));
    sync();
  };
  wheelWrap.addEventListener('pointerdown', (e) => { dragging = true; try { wheelWrap.setPointerCapture(e.pointerId); } catch {} pickAt(e); });
  wheelWrap.addEventListener('pointermove', (e) => { if (dragging) pickAt(e); });
  wheelWrap.addEventListener('pointerup', (e) => { if (dragging) { dragging = false; pickAt(e); } });
  wheelWrap.addEventListener('pointercancel', () => { dragging = false; });
  wheelWrap.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowRight') curHsv.h = (curHsv.h + step) % 360;
    else if (e.key === 'ArrowLeft') curHsv.h = (curHsv.h - step + 360) % 360;
    else if (e.key === 'ArrowUp') curHsv.s = clampNum(curHsv.s + 0.05, 0, 1);
    else if (e.key === 'ArrowDown') curHsv.s = clampNum(curHsv.s - 0.05, 0, 1);
    else return;
    e.preventDefault();
    const rgb = hsvRgb(curHsv.h, curHsv.s, curHsv.v || 1);
    setAccentColor(rgbHex(rgb.r, rgb.g, rgb.b));
    sync();
  });
  brightSlider.addEventListener('input', () => {
    curHsv.v = clampNum(Number(brightSlider.value) / 100, 0, 1);
    const rgb = hsvRgb(curHsv.h, curHsv.s, curHsv.v);
    setAccentColor(rgbHex(rgb.r, rgb.g, rgb.b));
    sync();
  });
  hexInput.addEventListener('change', () => { const c = normHex(hexInput.value); if (c) setAccentColor(c); sync(); });
  for (const ch of [rCh, gCh, bCh]) ch.inp.addEventListener('change', () => {
    setAccentColor(rgbHex(rCh.inp.value, gCh.inp.value, bCh.inp.value));
    sync();
  });
  function sync() {
    const active = normHex(state.settings.accentColor || '') || '#007aff';
    const rgb = hexRgb(active), hsv = rgbHsv(rgb.r, rgb.g, rgb.b);
    curHsv = hsv;
    const pure = hsvRgb(hsv.h, Math.max(0.2, hsv.s), 1);
    card.style.setProperty('--ecp-current', active);
    card.style.setProperty('--ecp-pure', rgbHex(pure.r, pure.g, pure.b));
    for (const [hex, b] of swatchBtns.entries()) b.setAttribute('aria-checked', String(hex === active));
    const rad = (hsv.h * Math.PI) / 180, dist = hsv.s * 58;
    thumb.style.left = `${66 + Math.cos(rad) * dist}px`;
    thumb.style.top = `${66 + Math.sin(rad) * dist}px`;
    thumb.style.background = active;
    if (document.activeElement !== hexInput) hexInput.value = active.toUpperCase();
    const pct = Math.round(clampNum(hsv.v, 0, 1) * 100);
    brightSlider.value = String(pct);
    brightVal.textContent = `${pct}%`;
    if (document.activeElement !== rCh.inp) rCh.inp.value = String(rgb.r);
    if (document.activeElement !== gCh.inp) gCh.inp.value = String(rgb.g);
    if (document.activeElement !== bCh.inp) bCh.inp.value = String(rgb.b);
    wheelWrap.setAttribute('aria-valuetext', active.toUpperCase());
    resetBtn.disabled = !state.settings.accentColor;
    const rv = Math.round(clampNum(hsv.v, 0.25, 1) * 50) / 50;
    if (lastV !== rv) { lastV = rv; paintColorWheel(canvas, rv); }
  }
  if (!IN_APP) {
    const glassReset = el('button', { type: 'button', class: 'ecp-reset', onclick: () => { setGlassStyle(''); syncGlass(); } }, 'Reset');
    const glassTop = el('div', 'ecp-top',
      el('div', 'ecp-head', el('span', 'ecp-title', 'Liquid Glass style'), el('span', 'ecp-sub', 'Choose how message bubbles and the input bar refract.')),
      glassReset);
    const styleBtns = new Map();
    const grid = el('div', { class: 'ecp-glass-grid', role: 'radiogroup', 'aria-label': 'Glass styles' },
      ...GLASS_STYLES.map(([id, label, sub], i) => {
        const pill = el('span', { class: 'ecp-glass-pill', 'data-no-i18n': '' }, `0${i + 1}`);
        const sendDot = el('span', 'ecp-glass-send');
        sendDot.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"/></svg>';
        const b = el('button', { type: 'button', role: 'radio', 'data-glass-style': id, 'aria-label': label, class: `ecp-glass-opt ecp-glass-${id}`, onclick: () => { setGlassStyle(id === DEFAULT_GLASS_STYLE ? '' : id); syncGlass(); } },
          el('div', 'ecp-glass-preview', pill, sendDot),
          el('div', 'ecp-glass-meta', el('span', 'ecp-glass-name', label), el('span', 'ecp-glass-desc', sub)));
        styleBtns.set(id, b);
        return b;
      }));
    const syncGlass = () => {
      const activeGlass = normGlassStyle(state.settings.glassStyle || '') || DEFAULT_GLASS_STYLE;
      for (const [id, b] of styleBtns.entries()) {
        const checked = id === activeGlass;
        b.setAttribute('aria-checked', String(checked));
        b.classList.toggle('active', checked);
      }
      glassReset.disabled = !state.settings.glassStyle || state.settings.glassStyle === DEFAULT_GLASS_STYLE;
    };
    card.append(el('hr', 'ecp-divider'), glassTop, grid);
    syncGlass();
  }
  sync();
  return card;
}
/** In the iPhone and iPad app: a row that opens the app's own Settings (server, Delete Account…, the welcome): R2-11. */
function appSettingsCard() {
  if (!IN_APP_SHELL) return null;
  return el('div', 'set-sec', el('h3', '', 'This app'),
    el('div', 'icard', el('div', 'prov',
      el('div', 'grow', el('div', 'p-n', 'App settings'), el('div', 'p-c', 'The Eden app’s own settings: the server, Delete Account…, and the welcome tour.')),
      el('button', { type: 'button', class: 'btn', onclick: () => { closeSettings(); openAppSettings(); } }, 'Open'))));
}
function openSettings(i = 0) {
  if (i === 'accounts') i = 1;
  else if (i === 'eves') i = 6;
  clearPhoneOverlays();
  $('settingsSheet').classList.add('open');
  setTabI = i;
  drawSettings();
  requestAnimationFrame(() => $('setSeg').querySelectorAll('button')[i]?.focus());
}
function closeSettings() { if (!$('settingsSheet').classList.contains('open')) return false; $('settingsSheet').classList.remove('open'); focusComposer(); return true; }
/** Settings › Memory (askeden.com): memory across chats on/off, the saved memories, delete one or all. */
async function drawMemory(body, hosted) {
  const hero = setHero('bulb', 'Memory', 'Eden remembers helpful details across chats, like your name, preferences and projects.', 'mem');
  if (!hosted) { body.replaceChildren(hero, el('div', 'set-sec', el('div', 'icard', el('p', '', 'On this Mac, memory across chats comes from the Eden app. Saved memories are an askeden.com feature.'))), importCard()); return; }
  body.replaceChildren(hero, el('div', 'set-skel', el('span', 'sk'), el('span', 'sk')));
  let m;
  try { m = await api.memory(); } catch (e) { body.replaceChildren(hero, el('div', 'sp-warn', el('b', '', 'Couldn’t read your memory'), e.message)); return; }
  if (setTabI !== 4) return;
  const act = async (req, done) => {
    try { m = await api.memoryDo(req); if (done) toast(done); } catch (e) { toast(`Couldn’t change memory: ${e.message}`); }
    if (setTabI === 4) paint();
  };
  const paint = () => {
    const sw = el('input', { type: 'checkbox', 'aria-label': 'Use memory across chats' });
    sw.checked = m.on !== false;
    sw.addEventListener('change', () => act({ action: 'prefs', on: sw.checked }, sw.checked ? 'Memory on' : 'Memory off: nothing is read or saved'));
    const rows = (m.items || []).map((x) => el('div', 'mem-row',
      el('div', 'grow', el('span', { 'data-no-i18n': '' }, x.text), el('span', 'muted', `${x.how === 'explicit' ? 'You asked' : x.how === 'manual' || x.how === 'edited' ? 'Added in Settings' : 'Picked up from a chat'} · ${new Date(x.updated).toLocaleDateString(locale())}`)),
      el('button', { type: 'button', class: 'btn icon', title: 'Delete this memory', 'aria-label': 'Delete this memory', onclick: () => act({ action: 'delete', id: x.id }, 'Memory deleted') }, ico('trash', 14))));
    const clear = el('button', { type: 'button', class: 'btn', disabled: !rows.length, onclick: () => { if (confirm('Delete all saved memories? This can’t be undone.')) act({ action: 'clear' }, 'All memories deleted'); } }, ico('trash', 14), 'Delete all');
    body.replaceChildren(hero,
      m.notice ? el('div', 'notice', 'New: Eden now remembers helpful details across chats, and you can say “remember that…” or “forget that…”. Temporary chats never use memory. Turn it off here any time.') : null,
      el('div', 'set-sec', el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Use memory across chats'), el('div', 'p-c', 'Eden saves useful details from your chats and uses them in later ones. Off: nothing is read or saved. Temporary chats never use memory.')), el('label', 'switch', sw, el('span', 'tr'))))),
      el('div', 'set-sec', el('h3', '', `Saved memories (${rows.length})`), el('div', 'icard', ...(rows.length ? rows : [el('p', 'muted', 'Nothing saved yet. Say “remember that…” in a chat, or just chat: Eden picks up useful details.')])),
        el('p', 'sp-note', 'Stored encrypted on your account, never shared with delegates or team spaces. Deleting your account deletes them.'),
        el('div', 'dlg-acts', clear)),
      importCard());
    if (m.notice) { m.notice = false; api.memoryDo({ action: 'prefs', noticed: true }).catch(() => {}); }
  };
  paint();
}
addEventListener('eden:open-memory', () => openSettings(4));
/** A settings page's header: its icon tile, title and a line on what it's for. */
function setHero(icon, title, desc, tone) {
  return el('div', `set-hero t-${tone}`, el('span', 'set-tile', ico(icon, 18)), el('div', 'grow', el('h3', 'set-h', title), el('p', 'set-d', desc)));
}
async function drawSettings() {
  setSeg($('setSeg'), setTabI);
  const body = $('setBody');
  body.scrollTop = 0;
  body.dataset.tab = String(setTabI);
  const hosted = !!(state.meta && state.meta.hosted);
  if (setTabI === 0) {
    body.replaceChildren(
      setHero('key', 'API Keys & Spend Control', 'Manage default & backup API keys, automatic quota failover, live API spend, and model routing in one panel.', 'key'),
      el('div', 'set-skel', el('span', 'sk'), el('span', 'sk'), el('span', 'sk')),
    );
    let keys, spend;
    try {
      [keys, spend] = await Promise.all([api.keys(), refreshSpend().catch(() => spendStatus())]);
    } catch (e) {
      body.replaceChildren(
        setHero('key', 'API Keys & Spend Control', 'Manage default & backup API keys, automatic quota failover, live API spend, and model routing in one panel.', 'key'),
        el('div', 'sp-warn', el('b', '', 'Couldn’t read the keys'), e.message),
      );
      return;
    }
    if (setTabI !== 0) return;
    const provs = (state.meta && state.meta.providers) || Object.keys(keys).map((id) => ({ id, name: id }));
    const rows = provs.map((p) => keyRow(p, keys[p.id] || { set: false, source: null }, spend));
    const explain = hosted
      ? el('div', 'key-explain',
        el('div', 'kx', el('span', 'kx-ic inc', ico('spark', 15)), el('div', '', el('b', '', 'Default + Backup Failover'), el('p', '', 'Eden uses your Default key first. If it hits its monthly quota or rate limit, Eden automatically switches to your Backup keys in order.'))),
        el('div', 'kx', el('span', 'kx-ic own', ico('key', 15)), el('div', '', el('b', '', 'Your Own Keys & Included AI'), el('p', '', 'Your own keys are encrypted on your account and don’t count against your plan allowance. Included AI is used whenever no custom key is set.'))))
      : el('div', 'key-explain',
        el('div', 'kx', el('span', 'kx-ic inc', ico('lock', 15)), el('div', '', el('b', '', 'Default + Automatic Monthly Failover'), el('p', '', 'Eden uses your Default key until it hits its monthly limit, then automatically fails over to your Backup keys in order.'))),
        el('div', 'kx', el('span', 'kx-ic own', ico('key', 15)), el('div', '', el('b', '', 'Synced Across Eden Code & Ask Eden'), el('p', '', 'Keys live in ~/.config/model-router/keys.json and your Mac Keychain, readable only by you.'))));
    body.replaceChildren(
      setHero('key', 'API Keys & Spend Control', 'Manage default & backup API keys, automatic quota failover, live API spend, and model routing in one panel.', 'key'),
      spendDashboardCard(spend, provs, keys),
      el('div', 'set-sec',
        el('h3', '', 'API Keys & Automatic Failover Queue'),
        el('div', 'icard keys', ...rows),
        el('p', 'sp-note', hosted
          ? 'Your keys are stored encrypted on your account and used only for your chats. When a Default key reaches its monthly limit, Eden automatically falls back to the next Backup key.'
          : 'Keys never leave this Mac except to their provider. When a Default key hits its monthly usage limit, Eden automatically switches to the next Backup key.')),
      quickControlDashboardCard(),
      explain,
    );
  } else if (setTabI === 1) {
    drawAccounts(body);
  } else if (setTabI === 2) {
    const cur = state.settings.theme || 'system';
    const tiles = el('div', { class: 'theme-tiles', role: 'radiogroup', 'aria-label': 'Appearance' },
      ...[['system', 'System', 'Follows macOS'], ['light', 'Light', 'Bright and airy'], ['dark', 'Dark', 'Easy at night']].map(([t, label, sub]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === t), class: `theme-tile${cur === t ? ' on' : ''}`, onclick: () => { setTheme(t); drawSettings(); } },
        el('span', `tt-prev tt-${t}`, el('span', 'tt-win', el('span', 'tt-side', el('i'), el('i'), el('i')), el('span', 'tt-main', el('i', 'b1'), el('i', 'b2'), el('i', 'b3')))),
        el('span', 'tt-label', el('span', 'tt-radio'), el('b', '', label), el('span', '', sub)))));
    // Language (i18n.js): Automatic follows the browser; English and Français are always shown as written. Picking one reloads the page.
    const langSeg = el('div', { class: 'seg lang-seg', role: 'radiogroup', 'aria-label': 'Language', style: { '--n': LANGS.length, maxWidth: '380px' } }, el('span', 'seg-thumb'),
      ...LANGS.map(([v, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(langPref === v), class: langPref === v ? 'on' : '', 'data-no-i18n': v === 'auto' ? null : '', onclick: () => { if (v !== langPref) setLang(v); } }, label)));
    body.replaceChildren(setHero('palette', 'Appearance', 'How Eden looks, and how it sounds.', 'pal'),
      el('div', 'set-sec', el('h3', '', 'Theme'), tiles,
        el('p', 'sp-note', 'System follows macOS. Reduced motion and reduced transparency in System Settings › Accessibility are honored.')),
      el('div', 'set-sec', el('h3', '', 'Color'), colorPickerSection()),
      el('div', 'set-sec', el('h3', '', 'Language'), langSeg,
        el('p', 'sp-note', 'Menus, buttons and Eden’s replies follow this. Automatic uses your browser’s language.')), ...[bootSoundSettings()].filter(Boolean), ...[voiceSettings()].filter(Boolean), ...[appSettingsCard()].filter(Boolean));
    setSeg(langSeg, Math.max(0, LANGS.findIndex(([v]) => v === langPref)));
  } else if (setTabI === 4) {
    drawMemory(body, hosted);
  } else if (setTabI === 6) {
    drawEvesPane(body);
  } else if (setTabI === 3) {
    const autoSw = el('input', { type: 'checkbox', 'aria-label': 'Search the web automatically' });
    autoSw.checked = state.settings.autoSearch !== false;
    autoSw.addEventListener('change', () => { state.settings.autoSearch = autoSw.checked; saveSettings(); toast(autoSw.checked ? 'Eden searches the web when a message needs it' : 'Auto-search is off'); });
    // N19: the two fact-check switches (on unless turned off; sent with each message by chat.js factCheckSettings),
    // drawn only when the server says it runs that check (GET /api/chat/meta `premiseCheck: true` / `answerCheck: true`)
    const serverChecks = (k) => !!(state.meta && state.meta[k] === true);
    const checkSw = (key, label, on, off) => {
      const x = el('input', { type: 'checkbox', 'aria-label': label });
      x.checked = state.settings[key] !== false;
      x.addEventListener('change', () => { state.settings[key] = x.checked; saveSettings(); toast(x.checked ? on : off); });
      return x;
    };
    const premiseSw = checkSw('premiseCheck', 'Check the question’s assumptions', 'Eden checks what a question takes for granted', 'Assumption check is off');
    const answerSw = checkSw('answerCheck', 'Double-check answers that didn’t use the web', 'Eden double-checks answers that didn’t use the web', 'Answer double-check is off');
    const queueSw = checkSw('queueFollowUps', 'Queue follow-ups', 'Follow-ups wait in the queue until the current step ends', 'Follow-ups steer the running step right away');
    const sw = el('input', { type: 'checkbox', 'aria-label': 'Claude counts as subscription' });
    sw.checked = !!state.settings.subscriptionClaude;
    sw.addEventListener('change', () => { state.settings.subscriptionClaude = sw.checked; saveSettings(); schedulePreview(); toast(sw.checked ? 'Claude priced as subscription quota' : 'Claude priced at API rates'); });
    const ov = currentOverride();
    const lv = Number(state.settings.level) || 3;
    const info = levels().find((x) => x.level === lv) || {};
    body.replaceChildren(setHero('route', 'Routing', 'How Eden picks a model for each message.', 'route'),
      el('div', 'route-cards',
        el('button', { type: 'button', class: 'route-card', onclick: () => { closeSettings(); openInspector('Route'); } },
          el('span', 'rc-k', 'Level'),
          el('span', 'rc-v', info.label || `Level ${lv}`),
          el('span', { class: 'rc-meter', 'aria-hidden': 'true' }, ...[1, 2, 3, 4, 5].map((i) => el('i', i <= lv ? 'on' : ''))),
          el('span', 'rc-s', 'Efficiency ⟷ performance')),
        el('button', { type: 'button', class: 'route-card', onclick: () => { closeSettings(); openInspector('Route'); } },
          el('span', 'rc-k', 'Model'),
          el('span', 'rc-v', ov ? (modelInfo(ov.model)?.name || ov.model) : 'Auto'),
          el('span', 'rc-s', ov ? 'Pinned for every message' : 'The router picks per message'))),
      el('div', 'set-sec', el('h3', '', 'Pricing'),
        el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Search the web automatically'), el('div', 'p-c', 'When a message needs current information (news, weather, prices, scores, “near me”, a link), Eden searches the web first and shows the sources. Never in temporary or private chats. Searches use your included AI.')), el('label', 'switch', autoSw, el('span', 'tr')))),
        el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Queue follow-ups'), el('div', 'p-c', 'Messages sent while Eden is working wait until its current step ends. Off: Return steers it right away without stopping the reply (⌘↩ or Steer always steers right away).')), el('label', 'switch', queueSw, el('span', 'tr')))),
        serverChecks('premiseCheck') ? el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Check the question’s assumptions'), el('div', 'p-c', 'When a question takes a fact for granted (“why did … win …?”), Eden checks that fact on the web first and corrects it if it’s wrong. About 1¢, only on such questions.')), el('label', 'switch', premiseSw, el('span', 'tr')))) : null,
        serverChecks('answerCheck') ? el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Double-check answers that didn’t use the web'), el('div', 'p-c', 'After a factual answer from the model’s memory, Eden looks on the web for evidence against it, and answers again with sources when it finds some. About 2¢, only on such answers.')), el('label', 'switch', answerSw, el('span', 'tr')))) : null,
        el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Claude counts as subscription'), el('div', 'p-c', 'Claude through the Claude Code CLI is priced as a fraction of your plan’s quota, not API dollars, so the router uses it more freely.')), el('label', 'switch', sw, el('span', 'tr')))),
        el('p', 'sp-note', `Level ${state.settings.level}${ov ? ` · pinned to ${modelInfo(ov.model)?.name || ov.model}` : ' · auto'}. Levels, sliders, providers and the override live in the inspector’s Route tab.`),
        el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => { closeSettings(); openInspector('Route'); } }, ico('sliders', 14), 'Open Route console'))), privacySettings(), evesSettings(), autopilotSettings(), learnedSettings()); // H3, H2, N13
  } else {
    const ver = state.meta && state.meta.version;
    body.replaceChildren(el('div', 'about-hero',
      el('span', { class: 'orb about-orb', 'aria-hidden': 'true' }),
      el('h3', '', 'Eden'),
      el('p', 'about-tag', 'One chat for every model you have.'),
      el('div', 'about-chips', ver ? el('span', 'chip-s', `Version ${ver}`) : null, el('span', 'chip-s', hosted ? 'askeden.com' : 'On this Mac'), isMock ? el('span', 'chip-s warn', 'Mock mode') : null)),
    el('div', 'set-sec about',
      el('div', 'icard about-card',
        el('p', '', 'Each message is routed by the Model Router (rules, rated by Gemini) and streamed from the model it picks, with your second brain, memory and calendar through the Eden app on your Mac, and Code sessions for your projects.'),
        IN_APP ? null : el('p', '', 'Voice: dictate with the mic in the input bar, have replies read aloud in the Eden voice, or talk with the waveform button. The microphone is used only when you press one of them.'), // no voice in the iPhone app for now (voice.js)
        state.meta && state.meta.scope ? el('p', '', state.meta.scope) : null,
        isMock ? el('p', '', el('b', '', 'Mock mode: '), 'every answer on this page is simulated in the browser (?mock=1).') : null),
      el('p', 'sp-note', 'Eden · design: Kimi K3 (Atelier). Input bar: from Eden Code.'),
      el('div', 'dlg-acts about-acts', helpButton(closeSettings), el('a', { class: 'btn', href: DOWNLOAD_URL }, ico('down', 14), 'Download apps'), el('button', { type: 'button', class: 'btn primary', onclick: () => { closeSettings(); startTour(); } }, 'Take the tour'))),
    ...[appSettingsCard()].filter(Boolean));
  }
}
const accountsHero = () => setHero('user', 'Accounts', 'The mail and calendars Eden can read for you.', 'acct');
async function drawAccounts(body) {
  body.replaceChildren(accountsHero(), el('div', 'muted', 'Loading…'));
  let st;
  try { st = await api.googleStatus(); } catch (e) { body.replaceChildren(accountsHero(), el('div', 'sp-warn', el('b', '', 'Couldn’t read the Gmail status'), e.message)); return; }
  if (setTabI !== 1) return;
  if (st.hosted || (state.meta && state.meta.hosted)) { drawHostedAccounts(body, st); return; } // askeden.com: no client to set up
  const id = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'xxxxxxxx.apps.googleusercontent.com', 'aria-label': 'Google OAuth client ID' });
  const secret = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: st.configured ? 'Saved (enter a new one to replace)' : 'Client secret', 'aria-label': 'Google OAuth client secret' });
  // the server always signs in with http://localhost:<port>/… (google-routes.ts localRedirectUri),
  // so show that one even when this page is open at 127.0.0.1 or [::1]
  const loopback = /^(127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const redirect = `${loopback ? `${location.protocol}//localhost${location.port ? `:${location.port}` : ''}` : location.origin}${API_ROOT}/api/chat/google/callback`;
  const save = async () => {
    if (!id.value.trim() || !secret.value.trim()) { toast('Enter both the client ID and the secret'); return; }
    try { await api.googleConfig(id.value.trim(), secret.value.trim()); id.value = ''; secret.value = ''; toast('Gmail client saved'); drawAccounts(body); }
    catch (e) { toast(`Couldn’t save: ${e.message}`); }
  };
  const status = st.connected ? `Connected as ${st.email || 'your Google account'}` : st.configured ? 'Set up — not connected yet' : 'Not set up';
  body.replaceChildren(accountsHero(), el('div', 'set-sec', el('h3', '', 'Gmail'),
    el('div', 'icard',
      el('div', 'prov', el('span', { class: 'pglyph', style: { '--g1': '#ff6b5e', '--g2': '#d93025' }, 'aria-hidden': 'true' }, ico('mail', 17)), el('div', 'grow', el('div', 'p-n', 'Gmail'), el('div', `p-c${st.connected ? ' ok' : ''}`, status)),
        st.connected ? el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await api.googleDisconnect(); toast('Gmail disconnected'); drawAccounts(body); } catch (e) { toast(e.message); } } }, 'Disconnect')
          : st.configured ? el('button', { type: 'button', class: 'cap primary', onclick: connectGmail }, 'Connect Gmail') : null),
      el('div', { class: 'field', style: { marginTop: '10px' } }, 'OAuth client ID', id),
      el('div', 'field', 'Client secret', secret),
      el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: save }, st.configured ? 'Replace client' : 'Save'))),
    el('p', 'sp-note', 'How to: in Google Cloud Console › APIs & Services, enable the Gmail API, then create an OAuth client ID of type “Web application” with this authorized redirect URI:'),
    el('code', { class: 'readout', style: { display: 'block', userSelect: 'all' } }, redirect),
    el('p', 'sp-note', 'Paste its client ID and secret here. They’re stored on this Mac by the server and never shown again. Then press Connect Gmail and sign in.')),
  el('div', 'set-sec', el('h3', '', 'Mail on your Mac'),
    el('p', 'sp-note', state.jarvis.available ? 'Connected through the Eden app on your Mac: your Mail accounts show in the Mail panel.' : `Not connected: ${state.jarvis.reason || 'open the Eden app on your Mac'}.`)));
}

// askeden.com: Google is askeden.com's own sign-in client, so there's no client ID or secret to
// enter (that form is the Mac's): connect Gmail and Calendar, or disconnect.
function drawHostedAccounts(body, st) {
  const as = `Connected as ${st.email || 'your Google account'}`;
  const connectCalendar = async () => {
    try {
      const r = await api.googleConnect('calendar');
      if (!r || !r.url) { toast('Couldn’t start the Google sign-in'); return; }
      try { sessionStorage.setItem(CAL_RETURN_KEY, '1'); } catch { /* private mode */ } // back to the Calendar
      location.assign(r.url);
    } catch (e) { toast(`Couldn’t connect Google Calendar: ${e.message}`); }
  };
  const tile = (name) => el('span', { class: 'pglyph', style: name === 'Gmail' ? { '--g1': '#ff6b5e', '--g2': '#d93025' } : { '--g1': '#7aa2f7', '--g2': '#1a73e8' }, 'aria-hidden': 'true' }, ico(name === 'Gmail' ? 'mail' : 'cal', 17));
  const row = (name, on, button) => el('div', 'prov', tile(name), el('div', 'grow', el('div', 'p-n', name, el('span', `kpill ${on ? 'k-own' : 'k-off'}`, on ? 'Connected' : 'Not connected')), el('div', `p-c${on ? ' ok' : ''}`, on ? as : 'Connect it to let Eden read it for you')), button);
  body.replaceChildren(accountsHero(), el('div', 'set-sec', el('h3', '', 'Google'),
    el('div', 'icard',
      row('Gmail', st.gmail, st.gmail ? null : el('button', { type: 'button', class: 'cap primary', onclick: connectGmail }, 'Connect Gmail')),
      row('Google Calendar', st.calendar, st.calendar ? null : el('button', { type: 'button', class: 'cap primary', onclick: connectCalendar }, 'Connect Calendar')),
      st.gmail || st.calendar ? el('div', 'dlg-acts', el('button', { type: 'button', class: 'cap rev', onclick: async () => { try { await api.googleDisconnect(); toast('Google disconnected'); drawAccounts(body); } catch (e) { toast(e.message); } } }, 'Disconnect Google')) : null),
    el('p', 'sp-note', 'On askeden.com, Eden asks Google for Gmail and for Calendar separately, through askeden.com’s own Google sign-in: there’s nothing to set up here. Your Google tokens are kept encrypted in your account and never reach this page; Disconnect also removes Eden’s access at Google.')),
  el('div', 'set-sec', el('h3', '', 'Mail on your Mac'),
    el('p', 'sp-note', state.jarvis.available ? 'Connected through the Eden app on your Mac: your Mail accounts show in the Mail panel.' : `Not connected: ${String(state.jarvis.reason || 'open the Eden app on your Mac').replace(/\.+$/, '')}.`)));
}

function spendDashboardCard(spend, provs, keys) {
  const hosted = !!(state.meta && state.meta.hosted);
  const s = spend || {};
  const st = s.autopilot || {};
  const spent = typeof s.totalUSD === 'number' ? s.totalUSD : (st.spentUSD || 0);
  const budget = st.budgetUSD || s.budgetUSD || 0;
  const forecast = typeof st.forecastUSD === 'number' ? st.forecastUSD : spent;
  const sv = monthSavings();
  const cacheSaved = typeof s.cacheSavedUSD === 'number' && s.cacheSavedUSD > 0 ? s.cacheSavedUSD : 0;
  const totalSaved = Math.max(0, (sv && sv.usd ? sv.usd : 0)) + cacheSaved;
  const msgs = Number(s.messages) || (sv && sv.turns) || 0;
  const frac = budget > 0 ? Math.min(1, Math.max(0, spent / budget)) : 0;
  const fcFrac = budget > 0 ? Math.min(1, Math.max(0, forecast / budget)) : 0;

  // Compute session/browser spend per provider & model when server byModel isn't populated (e.g. hosted or fresh)
  const localByModel = new Map();
  for (const c of state.convs || []) {
    for (const n of Object.values(c.nodes || {})) {
      if (n.role !== 'assistant' || !n.usage) continue;
      const mId = (n.route && n.route.model) || n.model || 'unknown';
      const info = modelInfo(mId);
      const prov = (n.route && n.route.provider) || (info && info.provider) || (mId.startsWith('claude') ? 'anthropic' : mId.startsWith('gpt') || mId.startsWith('o') ? 'openai' : mId.startsWith('gemini') ? 'gemini' : 'kimi');
      const cur = localByModel.get(mId) || { model: mId, name: (info && info.name) || mId, provider: prov, usd: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
      cur.usd += Number(n.usage.costUSD) || 0;
      cur.calls += 1;
      cur.inputTokens += Number(n.usage.inputTokens) || 0;
      cur.outputTokens += Number(n.usage.outputTokens) || 0;
      localByModel.set(mId, cur);
    }
  }
  const byModelRaw = Array.isArray(s.byModel) && s.byModel.length ? s.byModel : [...localByModel.values()];
  const byModel = [...byModelRaw].sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const localTotal = [...localByModel.values()].reduce((acc, r) => acc + (r.usd || 0), 0);
  const displaySpent = spent > 0 ? spent : localTotal;

  // Group spend by provider
  const byProv = new Map();
  for (const p of provs || []) byProv.set(p.id, { id: p.id, name: p.name || p.id, usd: 0, calls: 0, tokens: 0 });
  for (const r of byModel) {
    const pid = r.provider || (String(r.model || '').startsWith('claude') ? 'anthropic' : String(r.model || '').startsWith('gpt') ? 'openai' : String(r.model || '').startsWith('gemini') ? 'gemini' : 'kimi');
    const row = byProv.get(pid) || { id: pid, name: pid, usd: 0, calls: 0, tokens: 0 };
    row.usd += Number(r.usd) || 0;
    row.calls += Number(r.calls) || 0;
    row.tokens += (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
    byProv.set(pid, row);
  }
  const provSpendRows = [...byProv.values()];
  const maxProvUsd = Math.max(...provSpendRows.map((r) => r.usd), 1e-6);
  const maxModelUsd = Math.max(...byModel.map((r) => r.usd || 0), 1e-6);

  // Budget inline editor
  const budgetInput = el('input', {
    type: 'number',
    class: 'kd-budget-in',
    min: '0',
    max: '100000',
    step: '5',
    placeholder: 'No cap',
    'aria-label': 'Monthly API spend cap in USD',
    value: budget > 0 ? String(budget) : '',
  });
  const saveBudget = async () => {
    const v = budgetInput.value.trim();
    try {
      await api.setSpend({ budgetUSD: v === '' ? 0 : Number(v) });
      await refreshSpend();
      toast(v && Number(v) > 0 ? `Monthly API budget set to $${Number(v).toFixed(2)}` : 'Monthly budget cap cleared');
      drawSettings();
    } catch (e) { toast(`Couldn’t save budget: ${e.message}`); }
  };
  budgetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBudget(); } });

  const meterEl = el('div', { class: `ap-meter s${st.stage || 0}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(frac * 100)) },
    el('span', 'ap-fill'), el('span', 'ap-fc'));
  meterEl.style.setProperty('--w', `${(frac * 100).toFixed(1)}%`);
  meterEl.style.setProperty('--f', `${(fcFrac * 100).toFixed(1)}%`);

  return el('div', 'set-sec',
    el('h3', '', 'API Spend & Monthly Budget'),
    el('div', 'icard kd-spend-card',
      el('div', 'kd-metrics',
        el('div', 'kd-metric',
          el('span', 'kd-mk', 'Monthly Spend'),
          el('b', 'kd-mv', fmtCost(displaySpent)),
          el('span', 'kd-ms', `${msgs} turn${msgs === 1 ? '' : 's'} this month`)),
        el('div', 'kd-metric',
          el('span', 'kd-mk', 'Monthly Cap'),
          el('b', 'kd-mv', budget > 0 ? fmtCost(budget) : 'Unlimited'),
          el('span', 'kd-ms', budget > 0 ? `${Math.max(0, Math.round((1 - frac) * 100))}% remaining` : 'Set a cap below')),
        el('div', 'kd-metric',
          el('span', 'kd-mk', 'Month Forecast'),
          el('b', 'kd-mv', fmtCost(forecast > 0 ? forecast : displaySpent)),
          el('span', 'kd-ms', st.stage ? st.label : 'On track')),
        el('div', 'kd-metric kd-saved',
          el('span', 'kd-mk', 'Saved vs Always-Opus'),
          el('b', 'kd-mv', fmtCost(totalSaved)),
          el('span', 'kd-ms', cacheSaved > 0 ? `Includes ${fmtCost(cacheSaved)} cache savings` : 'Router + caching savings'))),
      budget > 0 ? el('div', 'kd-meter-wrap', meterEl) : null,
      !hosted ? el('div', 'kd-budget-row',
        el('div', 'grow',
          el('div', 'p-n', 'Monthly Spend Cap ($)'),
          el('div', 'p-c', 'Autopilot steps routing down at 80% & 95% of your cap so you never run out unexpectedly.')),
        el('div', 'ap-budget', budgetInput, el('button', { type: 'button', class: 'cap primary', onclick: saveBudget }, 'Save cap'))) : null,
      el('div', 'kd-breakdown',
        el('div', 'kd-bk-head', el('span', '', 'Spend by Provider'), el('span', 'muted', 'Default + Backup status')),
        ...provSpendRows.map((r) => {
          const k = (keys && keys[r.id]) || {};
          const g = providerGlyph(r.id, r.name);
          const bar = el('span', 'kd-bar', el('i'));
          bar.querySelector('i').style.width = `${r.usd > 0 ? Math.max(4, (r.usd / maxProvUsd) * 100) : 0}%`;
          const fbCount = k.fallbackCount || (Array.isArray(k.fallbacks) ? k.fallbacks.length : 0);
          return el('div', 'kd-bk-row',
            el('span', { class: 'pglyph sm', style: { '--g1': g.from, '--g2': g.to }, 'aria-hidden': 'true' }, g.mark),
            el('div', 'kd-bk-info',
              el('div', 'kd-bk-top',
                el('span', 'kd-bk-name', r.name),
                k.set ? el('span', 'kpill k-own', `Default ${k.hint || (k.last4 ? `····${k.last4}` : 'set')}${fbCount ? ` + ${fbCount} backup` : ''}`) : el('span', 'kpill k-off', hosted ? 'Included AI' : 'No key'),
                el('b', 'kd-bk-val', fmtCost(r.usd))),
              bar,
              el('div', 'kd-bk-sub', `${r.calls} call${r.calls === 1 ? '' : 's'} · ${(r.tokens || 0).toLocaleString(locale())} tokens`)));
        })),
      byModel.length ? el('div', 'kd-breakdown kd-models-bk',
        el('div', 'kd-bk-head', el('span', '', 'Spend by Model'), el('span', 'muted', 'Calls & tokens')),
        ...byModel.slice(0, 8).map((r) => {
          const bar = el('span', 'kd-bar', el('i'));
          bar.querySelector('i').style.width = `${r.usd > 0 ? Math.max(4, ((r.usd || 0) / maxModelUsd) * 100) : 0}%`;
          const toks = (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
          return el('div', 'kd-bk-row compact',
            el('div', 'kd-bk-info',
              el('div', 'kd-bk-top',
                el('span', 'kd-bk-name', r.name || r.model),
                el('span', 'muted', `${r.calls || 0} calls · ${toks.toLocaleString(locale())} tok`),
                el('b', 'kd-bk-val', fmtCost(r.usd || 0))),
              bar));
        })) : null));
}

function quickControlDashboardCard() {
  const lv = Number(state.settings.level) || 3;
  const ov = currentOverride();
  const models = availableModels();
  const levelBtns = [1, 2, 3, 4, 5].map((n) => {
    const L = levels().find((x) => x.level === n) || { level: n, label: `L${n}` };
    return el('button', {
      type: 'button',
      class: `kd-lvl-btn${lv === n ? ' on' : ''}`,
      onclick: () => { setLevel(n); toast(`Router Level ${n}: ${L.label}`); drawSettings(); },
    }, el('b', '', `L${n}`), el('span', '', L.label));
  });

  const modelSel = el('select', { class: 'kd-select', 'aria-label': 'Default or pinned model' },
    el('option', { value: '' }, 'Auto (Model Router picks per message)'),
    ...models.map((m) => el('option', { value: m.id, selected: ov && ov.model === m.id ? 'selected' : null }, `${m.name || m.id} (${m.provider})`)));
  modelSel.value = ov ? ov.model : '';
  modelSel.addEventListener('change', () => {
    setOverride(modelSel.value || null);
    toast(modelSel.value ? `Pinned to ${modelInfo(modelSel.value)?.name || modelSel.value}` : 'Switched to Automatic Model Router');
    drawSettings();
  });

  const subSw = el('input', { type: 'checkbox', 'aria-label': 'Claude counts as subscription quota' });
  subSw.checked = !!state.settings.subscriptionClaude;
  subSw.addEventListener('change', () => {
    state.settings.subscriptionClaude = subSw.checked;
    saveSettings();
    schedulePreview();
    toast(subSw.checked ? 'Claude priced as subscription quota' : 'Claude priced at API rates');
  });

  const autoSearchSw = el('input', { type: 'checkbox', 'aria-label': 'Auto web search' });
  autoSearchSw.checked = state.settings.autoSearch !== false;
  autoSearchSw.addEventListener('change', () => {
    state.settings.autoSearch = autoSearchSw.checked;
    saveSettings();
    toast(autoSearchSw.checked ? 'Auto web search on' : 'Auto web search off');
  });

  return el('div', 'set-sec',
    el('h3', '', 'Router & Model Controls'),
    el('div', 'icard kd-controls-card',
      el('div', 'prov kd-ctrl-block',
        el('div', 'grow',
          el('div', 'p-n', 'Optimization Level'),
          el('div', 'p-c', 'Choose how aggressively Eden balances API cost vs maximum model capability.')),
        el('div', 'kd-lvl-bar', ...levelBtns)),
      el('div', 'prov',
        el('div', 'grow',
          el('div', 'p-n', 'Default / Pinned Model'),
          el('div', 'p-c', ov ? `Currently pinned to ${modelInfo(ov.model)?.name || ov.model} for every turn.` : 'Automatic: Model Router selects the best model for each prompt.')),
        modelSel),
      el('div', 'prov',
        el('div', 'grow',
          el('div', 'p-n', 'Automatic Web Search'),
          el('div', 'p-c', 'Search the web automatically when a prompt asks for live or current information.')),
        el('label', 'switch', autoSearchSw, el('span', 'tr'))),
      el('div', 'prov',
        el('div', 'grow',
          el('div', 'p-n', 'Price Claude as Subscription Quota'),
          el('div', 'p-c', 'Off: Claude is billed and tracked in API dollars on your API key. On: treated as subscription quota.')),
        el('label', 'switch', subSw, el('span', 'tr'))),
      el('div', 'dlg-acts',
        el('button', { type: 'button', class: 'btn', onclick: () => { setTabI = 3; drawSettings(); } }, ico('route', 14), 'All Routing Settings'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => { closeSettings(); openInspector('Route'); } }, ico('sliders', 14), 'Open Live Route Console'))));
}

function keyRow(p, k) {
  const hosted = !!(state.meta && state.meta.hosted);
  const st = keyStatus(p, k, hosted);
  const g = providerGlyph(p.id, p.name);
  const row = el('div', 'key-row kd-provider-block');
  const fallbacks = Array.isArray(k.fallbacks) ? k.fallbacks : [];
  const enabled = state.settings.providers[p.id] !== false;

  const draw = (editMode) => {
    // editMode: false | 'replace' | 'fallback'
    const isFallbackEdit = editMode === 'fallback';
    const input = el('input', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: isFallbackEdit ? `Paste backup ${p.name || p.id} API key (used when default runs out)` : `Paste default ${p.name || p.id} API key`,
      'aria-label': `${p.name || p.id} API key`,
    });
    const save = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      try {
        const r = await api.setKey(p.id, v, { mode: isFallbackEdit ? 'fallback' : 'replace' });
        input.value = '';
        toast(isFallbackEdit ? `${p.name || p.id}: backup key added to failover queue` : (r && r.check && r.check.ok ? `${p.name || p.id}: default key works, saved` : `${p.name || p.id} default key saved`));
        await reloadMeta();
        drawSettings();
      } catch (e) { toast(`Couldn’t save: ${e.message}`); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.stopPropagation(); draw(false); }
    });

    const provToggle = el('input', { type: 'checkbox', 'aria-label': `Enable ${p.name || p.id} in router` });
    provToggle.checked = enabled;
    provToggle.addEventListener('change', () => {
      state.settings.providers[p.id] = provToggle.checked;
      saveSettings();
      renderRouteControls();
      schedulePreview();
      toast(provToggle.checked ? `${p.name || p.id} enabled in router` : `${p.name || p.id} paused in router`);
      drawSettings();
    });

    const primaryHint = k.hint || (k.last4 ? `····${k.last4}` : '');
    const mainLine = el('div', 'kd-key-main',
      el('span', { class: 'pglyph', style: { '--g1': g.from, '--g2': g.to }, 'aria-hidden': 'true' }, g.mark),
      el('div', 'grow',
        el('div', 'p-n',
          p.name || p.id,
          el('span', `kpill k-${st.tone}`, k.set ? `Default: ${primaryHint || st.pill}` : st.pill),
          fallbacks.length ? el('span', 'kpill k-included', `${fallbacks.length} backup${fallbacks.length === 1 ? '' : 's'} ready`) : null,
          !enabled ? el('span', 'kpill k-off', 'Paused') : null),
        el('div', `p-c${st.tone === 'own' || st.tone === 'sub' ? ' ok' : ''}`, st.detail)),
      editMode ? null : el('div', 'kd-key-acts',
        el('button', { type: 'button', class: `cap${k.set ? '' : ' primary'}`, onclick: () => draw('replace') }, k.set ? 'Replace default' : 'Set default key'),
        k.set ? el('button', { type: 'button', class: 'cap', onclick: () => draw('fallback'), title: 'Add a backup key that Eden switches to automatically if the default key hits its monthly limit' }, '+ Backup key') : null,
        !k.set || k.source === 'env' ? null : el('button', { type: 'button', class: 'cap rev', onclick: async () => {
          try { await api.setKey(p.id, '', { mode: 'replace' }); toast(`${p.name || p.id} key removed`); await reloadMeta(); drawSettings(); } catch (e) { toast(`Couldn’t remove: ${e.message}`); }
        } }, 'Remove'),
        el('label', { class: 'switch', title: enabled ? 'Active in Model Router (click to pause)' : 'Paused in Model Router (click to enable)' }, provToggle, el('span', 'tr'))));

    const editBox = editMode ? el('div', 'key-edit kd-key-edit',
      input,
      el('button', { type: 'button', class: 'btn primary', onclick: save }, isFallbackEdit ? 'Add backup' : 'Save default'),
      el('button', { type: 'button', class: 'btn', onclick: () => draw(false) }, 'Cancel')) : null;

    const fbList = fallbacks.length ? el('div', 'kd-fallbacks',
      el('div', 'kd-fb-title', 'Automatic Failover Queue (used in order when Default hits its monthly limit):'),
      ...fallbacks.map((fbHint, idx) => el('div', 'kd-fb-row',
        el('span', 'kd-fb-badge', `Backup #${idx + 1}`),
        el('code', 'kd-fb-hint', typeof fbHint === 'string' && fbHint.length === 4 ? `····${fbHint}` : String(fbHint)),
        el('span', 'kd-fb-note', 'Auto-activates on quota/rate limit'),
        el('span', 'grow'),
        el('button', {
          type: 'button',
          class: 'cap',
          title: 'Promote this backup key to be the Default key (current default moves to backup)',
          onclick: async () => {
            try {
              await api.setKey(p.id, '', { mode: 'promote_fallback', index: idx });
              toast(`Promoted Backup #${idx + 1} to Default for ${p.name || p.id}`);
              await reloadMeta();
              drawSettings();
            } catch (e) { toast(`Couldn’t promote key: ${e.message}`); }
          },
        }, 'Make default'),
        el('button', {
          type: 'button',
          class: 'cap rev',
          title: 'Remove this backup key',
          onclick: async () => {
            try {
              await api.setKey(p.id, '', { mode: 'remove_fallback', index: idx });
              toast(`Removed Backup #${idx + 1}`);
              await reloadMeta();
              drawSettings();
            } catch (e) { toast(`Couldn’t remove backup key: ${e.message}`); }
          },
        }, 'Remove')))) : null;

    row.replaceChildren(...[mainLine, editBox, fbList].filter(Boolean));
    if (editMode) requestAnimationFrame(() => input.focus());
  };
  draw(false);
  return row;
}
function cycleTheme() { const order = ['system', 'light', 'dark']; setTheme(order[(order.indexOf(state.settings.theme || 'system') + 1) % 3]); toast(`Appearance: ${state.settings.theme}`); }

/* ================= slash commands ================= */
function slash(name, arg) {
  const c = state.current;
  switch (name) {
    case 'new': newChat(); return true;
    case 'temp': newTemp(); return true;
    case 'code': projectPicker(); return true;
    case 'chat': case 'search': case 'research':
      if (c && c.kind === 'code') return false;
      setMode(name);
      if (arg) setTimeout(() => sendFromComposer(arg, [], []), 0);
      return true;
    case 'image': // Image mode: Eden draws (image-mode.js)
      if ((c && c.kind === 'code') || !imagesAvailable()) return false;
      setMode('image');
      if (arg) setTimeout(() => sendFromComposer(arg, [], []), 0);
      return true;
    case 'video': // Video mode: Eden makes a short video clip (image-mode.js)
      if ((c && c.kind === 'code') || !videosAvailable()) return false;
      setMode('video');
      if (arg) setTimeout(() => sendFromComposer(arg, [], []), 0);
      return true;
    case 'slides': // Q14: Slides mode; with no words, the chat's deck (or how to start one) in the canvas (deck.js)
      if (c && c.kind === 'code') return false;
      setMode('slides');
      if (arg) setTimeout(() => sendFromComposer(arg, [], []), 0);
      else if (c) dispatchEvent(new CustomEvent('eden:open-deck', { detail: { c } }));
      return true;
    case 'manual': case 'edits': case 'plan': case 'auto':
      if (!c || c.kind !== 'code') return false;
      setMode({ manual: 'default', edits: 'acceptEdits', plan: 'plan', auto: 'bypassPermissions' }[name]);
      if (arg && name !== 'auto') setTimeout(() => sendFromComposer(arg, [], []), 0);
      return true;
    case 'model': {
      if (!arg) { modelMenu(); return true; }
      if (/^(auto|router)$/i.test(arg)) { setOverride(null); toast('Model Router (auto)'); return true; }
      const q = arg.toLowerCase();
      const m = availableModels().find((x) => x.id.toLowerCase() === q) || availableModels().find((x) => x.name.toLowerCase().includes(q) || x.id.includes(q));
      if (!m) { toast(`No available model matches “${arg}”`); return true; }
      setOverride(m.id); toast(`Model: ${m.name}`); return true;
    }
    case 'effort': {
      const o = currentOverride();
      if (!o) { toast('The router picks the effort; choose a model first'); return true; }
      const m = modelInfo(o.model);
      const e = String(arg || '').toLowerCase().replace(/^extra[- ]?high$/, 'xhigh');
      if (!m.efforts.includes(e)) { toast(`${m.name}: ${m.efforts.join(', ')}`); return true; }
      setOverride(o.model, e); toast(`Effort: ${e}`); return true;
    }
    case 'level': { const n = Number(arg); if (n >= 1 && n <= 5) { setLevel(n); toast(`Level ${n}`); } else toast('/level 1–5'); return true; }
    case 'persona': {
      if (!arg || /^none$/i.test(arg)) { setPersona(null); return true; }
      const p = state.personas.find((x) => x.name.toLowerCase().includes(arg.toLowerCase()));
      if (p) setPersona(p.id); else toast(`No persona called “${arg}”`);
      return true;
    }
    case 'note': case 'brain': openSpace('brain', { query: arg }); return true;
    case 'memory': openSpace('memory'); return true;
    case 'meetings': openSpace('meetings'); return true;
    case 'web': openSpace('web', { goal: arg }); return true;
    case 'undo': openSpace('activity'); return true; // (/activity is Code mode's tool activity)
    case 'brief': openBrief(); return true;
    case 'calendar': openCalendar(); return true;
    case 'canvas': {
      const n = [...path(c)].reverse().find((x) => x.role === 'assistant' && artifactsIn(nodeText(x)).length);
      if (n) openArtifact({ ...artifactsIn(nodeText(n)).at(-1), nodeId: n.id }); else toast('No artifact in this chat yet: ask for an HTML page or an SVG');
      return true;
    }
    case 'rename': if (arg) renameConversation(c, arg); else startRename(); return true;
    case 'export': exportConversation(c); return true;
    case 'pin': togglePin(c); return true;
    case 'copy': { const n = [...path(c)].reverse().find((x) => x.role === 'assistant'); if (n) copyRich(nodeText(n)); else toast('No reply to copy yet'); return true; }
    case 'clear': clearConversation(); return true;
    case 'compact': compact(); return true;
    case 'route': openInspector('Route'); return true;
    case 'split': return splitCmd(arg);
    case 'changes': openInspector('Changes'); return true;
    case 'todos': openInspector('Plan'); return true;
    case 'activity': toggleDrawer(true); return true;
    case 'later': case 'schedule': {
      if (!c || c.kind !== 'code') { openTasks({ prefill: arg ? { prompt: arg } : null }); return true; }
      const trimmed = String(arg || '').trim();
      if (!trimmed) { scheduleTaskDialog(c); return true; }
      const parsed = parseCodeWhenAndTask(trimmed);
      if (!parsed) { scheduleTaskDialog(c, trimmed); return true; }
      scheduleCodeTask(c, parsed);
      return true;
    }
    case 'settings': case 'keys': case 'spend': case 'dashboard': openSettings(0); return true;
    case 'theme': if (['light', 'dark', 'system'].includes(arg)) setTheme(arg); else cycleTheme(); return true;
    case 'stop': if (!stop()) toast('Nothing to stop'); return true;
    case 'tour': startTour(); return true;
    case 'help': setTimeout(() => setComposerText('?'), 0); setTimeout(() => $('deck-input').dispatchEvent(new Event('input')), 10); return true;
    default: return false;
  }
}

function clearConversation() {
  const c = state.current;
  if (!c) return;
  if (c.kind === 'code') newCodeSession(c.project);
  else { const pid = c.personaId; newChat(); if (pid) setPersona(pid); }
  toast('Fresh start');
}
async function compact() {
  const c = state.current;
  if (!c || c.kind !== 'code') { toast('Eden Chat compacts context automatically.'); return; }
  if (!path(c).length) { toast('Nothing to compact yet'); return; }
  sendMessage('/compact', []);
}

/* ================= sending from the composer ================= */
function sendFromComposer(text, attachments, context) {
  // "open the essay writer", "start an APA essay": opened here, at once, with nothing sent (eden-tools.js essayCommand; website only)
  if (ESSAYS && !(attachments && attachments.length) && !(state.current && state.current.kind === 'code') && essayCommand(text)) { openEssayWriter(essayStyleIn(text) || undefined); return true; }
  const meta = state.meta;
  const c = state.current;
  if (c && c.kind === 'code') {
    if (meta && meta.code && meta.code.available === false) { toast(`Code mode is unavailable: ${meta.code.reason || ''}`); return false; }
    if (!attachments || !attachments.length) {
      const timed = parseNaturalCodeTimedMessage(text);
      if (timed) {
        scheduleCodeTask(c, timed);
        return true;
      }
    }
  } else if (meta && !(meta.providers || []).some((p) => p.available) && !currentOverride()) {
    toast('No model provider is available. Add an API key in Settings.', { label: 'Settings', run: () => openSettings(0) });
    return false;
  }
  if (!c && state.pendingMode && state.pendingMode !== 'chat') {
    const ok = sendMessage(text, attachments, { context });
    if (ok && state.current) { state.current.mode = state.pendingMode; state.pendingMode = 'chat'; }
    return ok;
  }
  const ok = sendMessage(text, attachments, { context });
  if (ok) clearAttachments();
  return ok;
}

/* ================= global keys + Esc order ================= */
function onKey(e) {
  if (handleSplitKey(e)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && k === 'k') { e.preventDefault(); if (!closePalette()) openPalette(); return; }
  if (mod && !e.altKey && !e.shiftKey && k === 'n') { e.preventDefault(); newChat(); return; }
  if (mod && e.shiftKey && k === 'o') { e.preventDefault(); newChat(); return; }
  if (mod && !e.altKey && !e.shiftKey && k === 'b') { e.preventDefault(); toggleSidebar(); return; }
  if (mod && !e.altKey && e.shiftKey && k === 'b') { e.preventDefault(); toggleBrowser(); return; }
  if (mod && e.altKey && e.code === 'Digit0') { e.preventDefault(); toggleInspector(); return; }
  if (mod && !e.altKey && !e.shiftKey && k === 'j') { e.preventDefault(); toggleDrawer(); return; }
  if (mod && !e.altKey && k === ',') { e.preventDefault(); openSettings(0); return; }
  if (e.key !== 'Escape') return;
  if ($('tbTitle').isContentEditable) { finishRename(false); return; }
  if (closeDialog() || closeSettings()) { e.preventDefault(); return; }
  if (closePalette()) return;
  if (closeCite()) return;
  if (closeChipPop(true)) return;
  if (composerEscape(e)) { e.preventDefault(); return; }
  if (closeSpace()) return;
  if (closePane()) return;
  if (ui_open.editing) { ui_open.editing = null; renderTranscript(); return; }
  // the running turn stops before panes close (as Eden Code interrupts first)
  // Esc stops the running reply (as in Eden Code), never with unsent text in the composer
  const tag = document.activeElement && document.activeElement.tagName;
  const inField = (tag === 'INPUT' || tag === 'TEXTAREA') && document.activeElement.id !== 'deck-input';
  const draft = document.activeElement && document.activeElement.id === 'deck-input' && $('deck-input').value.trim();
  if (!inField && !draft && stop()) { toast('Stopped'); return; }
  if (artifactOpen()) { closeArtifact(); return; }
  if (document.activeElement && document.activeElement.closest('#browserPane') && closeBrowser()) return;
  if ($('drawer').classList.contains('open')) { toggleDrawer(false); return; }
  if (isNarrow() && $('inspector').classList.contains('open')) { closeInspector(); return; }
  if ($('sidebar').classList.contains('open') || ($('sidebar').classList.contains('expanded') && !docksSidebar())) { closeOverlays(); }
}

/* ================= inspector sheet grabber (≤640px) ================= */
function initGrab() {
  const g = $('inspGrab'), i = $('inspector');
  let y0 = null;
  g.addEventListener('pointerdown', (e) => { y0 = e.clientY; g.setPointerCapture(e.pointerId); });
  g.addEventListener('pointerup', (e) => {
    if (y0 === null) return;
    const dy = e.clientY - y0;
    y0 = null;
    if (dy < -50) { if (i.classList.contains('peek')) i.classList.remove('peek'); else i.classList.add('full'); }
    else if (dy > 50) { if (i.classList.contains('full')) i.classList.remove('full'); else if (!i.classList.contains('peek')) i.classList.add('peek'); else closeInspector(); }
    else i.classList.toggle('full');
  });
}

/* ================= meta ================= */
async function reloadMeta() {
  try { state.meta = await api.meta(); state.metaError = null; }
  catch (e) { state.metaError = e.message; }
  renderRouteControls();
  renderComposer();
  if (!state.current || !path(state.current).length) renderTranscript();
}

/* ================= init ================= */
async function init() {
  // The iOS app: no pinch zoom, and no zoom-in when a field gets focus (mobile.css also sets touch-action).
  // The app's bridge can add .eden-app after this runs (WebKit runs module scripts before
  // document-end user scripts), so lock as soon as the class shows up, not only if it's already there.
  const root = document.documentElement;
  const lockZoom = () => root.classList.contains('eden-app') && (document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'), true);
  if (!lockZoom()) { const mo = new MutationObserver(() => { if (lockZoom()) mo.disconnect(); }); mo.observe(root, { attributes: true, attributeFilter: ['class'] }); }
  applyTheme();
  await loadConversations();
  const cur = store.get('jchat:current', null);
  state.current = state.convs.find((c) => c.id === cur) || null;
  if (state.current) state.selectedNode = [...path(state.current)].reverse().find((n) => n.role === 'assistant' && n.route) || null;
  if (!isNarrow()) {
    if (store.get('jchat:sidebar', true) === false) $('sidebar').classList.add('closed');
    $('inspector').classList.toggle('closed', !store.get('jchat:inspector', false));
  }
  syncDock();
  Object.assign(ui, { render: () => { renderTranscript(); renderTitle(); renderComposer(); }, renderSidebar, renderTitle, renderComposer, updateMessage, renderInspector: () => renderTurnCard(state.selectedNode), renderPlan, loadChanges: (quiet) => { if (curTab === 'Changes' && inspectorVisible()) loadChanges(quiet); }, renderActivity, renderPane: renderSplitPaneFor });

  initRouteControls();
  initChipPop();
  initComposer({
    send: sendFromComposer, stop: () => stop(), slash,
    queue: (t, opts) => {
      const c = state.current;
      const item = queueFollowUp(c, t, opts);
      if (!item) return false;
      if (c && c.kind !== 'code' && !(opts && opts.steer)) toast('Queued: sends when Eden finishes');
      return true;
    },
    steerNow: (id) => steerNow(state.current, id), dropQueued: (id) => dropQueued(state.current, id),
    setPersona, editPersona, newTemp, openSettings, openInspector, openBrain: () => openSpace('brain'),
    searchNotes, attachNote, save: (c) => { saveConversation(c); renderTitle(); renderSidebar(); }, confirm: (text, ok, run) => confirmDialog(text, ok, run, true),
    compact, clear: clearConversation,
  });
  initSplitView({
    msgEl, titleOf, selectHere, toggleSidebar, renderSidebar, renderTitle, renderInspector: () => renderTurnCard(state.selectedNode),
    setComposerText, slash, save: (c) => { saveConversation(c); renderTitle(); renderSidebar(); },
    onPaneTranscriptClick: (e, c, box, setPaneInput) => onTranscriptClick(e, c, box, setPaneInput),
  });
  initArtifact({ quote: (t) => setComposerText(t, { append: true }), send: (t, opts) => sendMessage(t, [], opts || {}) });
  // the chat open at startup gets its essay back beside it (essay-chat.js, T20e; website only, loaded after the page)
  if (ESSAYS) import('./essay-chat.js').then((m) => { essayChat = m; m.initEssayChat(); }).catch(() => {});
  initPrivacy({ confirm: (text, ok, run) => confirmDialog(text, ok, run, true), schedulePreview });
  initPublish({ openDialog, closeDialog });
  initPanels({ addContext: (b) => { addContext(b); closeSpace(); } });
  initDesk({ switchTo, newChat, titleOf, openSpace, openBrief, openCalendar, openFiles, openTasks, openWorkflows, projectPicker, ...(ESSAYS ? { openEssayWriter } : {}) });
  initCalendar({ addContext: (b) => addContext(b), openSettings });
  initMemory({ addContext: (b) => addContext(b) });
  initBrief({ addContext: (b) => addContext(b) });
  initFiles({ addContext: (b) => addContext(b), addFile, setComposerText, focusComposer, renderComposer, clearPhoneOverlays }); // G2/H4 (files.js)
  initKnowledge({ switchTo, renderSidebar, renderComposer, clearPhoneOverlays }); // H11 (knowledge.js)
  initFolders({ openDialog, closeDialog, render: renderSidebar }); // folders and Tidy up with Eden (folders.js)
  initCode({ closeDialog, openDialog, newCodeSession, renderTitle, renderSidebar, quote: (t) => setComposerText(t, { append: true }) });
  ensureScheduleLoop();
  initMail({
    openDialog, closeDialog, openSettings, jarvisAvailable: () => state.jarvis.available, jarvisReason: () => state.jarvis.reason,
    summarize: (m) => {
      leaveMailOnly();
      closeSpace();
      if (state.current && (state.current.kind === 'code' || state.streams.has(state.current.id))) newChat();
      sendFromComposer('Summarize this email: key points, asks, deadlines.', [], [{ title: `Email: ${m.subject}`.slice(0, 80), text: emailText(m), source: 'mail', hidden: m.hidden || 0 }]);
    },
    askEden: (m) => { // a row's or the reading pane's "Ask Eden": the email goes with the next message
      leaveMailOnly();
      closeSpace();
      addContext({ title: `Email: ${m.subject}`.slice(0, 80), text: emailText(m), source: 'mail', hidden: m.hidden || 0 });
      focusComposer();
    },
    writeReply: async (m) => {
      let out = '';
      await api.send({
        messages: [{ role: 'user', content: 'Write a reply to this email for me to send. Output only the body of the reply (greeting to sign-off), no subject line, no notes.' }],
        settings: routeSettings(), mode: 'chat', context: [{ title: `Email: ${m.subject}`, text: emailText(m), source: 'mail', hidden: m.hidden || 0 }],
      }, { onEvent: (t, d) => { if (t === 'text') out += d.text || ''; if (t === 'error') throw new Error(d.message || 'failed'); } });
      return out.trim();
    },
  });
  initGrab();
  // back from Google's sign-in
  const gh = /#gmail=(\w+)/.exec(location.hash);
  if (gh && sheetReturnPending()) { history.replaceState(null, '', location.pathname + location.search); resumeSheet(gh[1] === 'connected'); } // Google Sheets' own Connect (Q15)
  else if (gh && (() => { try { return sessionStorage.getItem('eden:mail-only-return') === '1'; } catch { return false; } })()) {
    try { sessionStorage.removeItem('eden:mail-only-return'); } catch { /* blocked */ }
    location.replace(`/mail${location.hash}`);
  } else if (gh) {
    history.replaceState(null, '', location.pathname + location.search);
    // Calendar's own Connect (or Settings') left a note to come back to it: say what was connected.
    const toCalendar = gh[1] === 'connected' && calendarReturnPending();
    toast(gh[1] === 'connected' ? (toCalendar ? 'Google Calendar connected' : 'Gmail connected') : 'Google sign-in didn’t finish. Try again.');
    if (gh[1] === 'connected') setTimeout(() => (toCalendar ? openCalendar() : openSpace('mail')), 300);
  }
  // a link to Settings › Models & API keys (askeden.com's "Add your Anthropic API key…")
  addEventListener('eden:open-settings', (e) => openSettings((e.detail && e.detail.tab) || 0));
  if (location.hash === '#settings=keys' || location.hash === '#keys' || location.hash === '#spend' || location.hash === '#dashboard') {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => openSettings(0), 0);
  }
  // The native iOS app opens a secondary space in a sheet: /#open=mail (calendar, tasks, brief…).
  const op = /^#open=(\w+)$/.exec(location.hash);
  // Eden Travel (travel.js, loaded when first opened): askeden.com/travel or askedentravel.com, #open=travel, and "Open in Eden Travel" on a trip card. Never in the app.
  const travel = (id) => { if (!IN_APP) import('./travel.js').then((m) => m.openTravel(id)); };
  addEventListener('eden:travel-open', (e) => travel(e.detail && e.detail.id));
  document.addEventListener('eden:new-chat', () => newChat()); // Eden Travel's own address has no sidebar: its menu starts one
  document.addEventListener('eden:trip-shown', () => { if (!path(state.current).length) renderTranscript(); }); // Eden Travel: the empty chat's suggestions are the trip's (render.js)
  if (location.pathname === '/travel' || (/(^|\.)askedentravel\.com$|^travel\.localhost$/.test(location.hostname) && location.pathname === '/')) travel(); // its own address too (travel.js TRAVEL_HOST)
  const opens = { travel: () => travel(), brief: openBrief, calendar: openCalendar, files: openFiles, mail: () => openSpace('mail'), routines: () => openSpace('routines'), brain: () => openSpace('brain'), memory: () => openSpace('memory'), meetings: () => openSpace('meetings'), activity: () => openSpace('activity') };
  if (op && opens[op[1]]) {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(opens[op[1]], 300);
  }
  // Eden Mail on its own (askeden.com/mail, from askedenmail.com): Mail is the whole page (util.js MAIL_ONLY).
  if (inMailOnly()) openSpace('mail');
  // G3 background tasks (their approval card shows anywhere) and H9 saved workflows.
  initTasks({ beforeOpen: clearPhoneOverlays });
  initWorkflows({
    beforeOpen: clearPhoneOverlays,
    current: () => state.current,
    messagesOf: (c) => path(c).filter((n) => n.role === 'user').map((n) => ({ role: 'user', content: n.content || '', attachments: n.attachments || [] })),
    run: (text, attachments, { mode } = {}) => {
      closeSpace();
      newChat();
      if (mode && mode !== 'chat' && !state.current) state.pendingMode = mode;
      return sendFromComposer(text, attachments);
    },
    openTasks,
  });

  $('transcript').addEventListener('click', onTranscriptClick);
  $('transcript').addEventListener('keydown', (e) => {
    const cite = e.target.closest('sup.cite');
    if (cite && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); citePop(cite, nodeOf(cite), Number(cite.dataset.cite)); return; }
    const ta = e.target.closest('textarea[data-edit]');
    if (ta && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.closest('.msg').querySelector('[data-act="edit-send"]').click(); }
  });
  $('transcript').addEventListener('input', (e) => { const ta = e.target.closest('textarea[data-edit]'); if (ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(300, ta.scrollHeight)}px`; } });
  document.addEventListener('pointerdown', (e) => {
    if ($('citePop').classList.contains('open') && !e.target.closest('#citePop, [data-cite]')) $('citePop').classList.remove('open');
    // the narrow inspector closes on a click outside it (it's an overlay there)
    if (isNarrow() && !isMobile() && $('inspector').classList.contains('open') && !e.target.closest('#inspector, #btnInspector, .route-chip, [data-act="inspect"], .jc-menu, #chipPop, #palette, .sheet')) closeInspector();
  });
  addEventListener('keydown', onKey);

  $('btnSearch').addEventListener('click', openPalette);
  $('btnPalette').addEventListener('click', openPalette);
  $('btnNew').addEventListener('click', newChat);
  $('btnMore').addEventListener('click', (e) => moreMenu(e.currentTarget));
  $('btnTheme').addEventListener('click', cycleTheme);
  $('btnSettings').addEventListener('click', () => openSettings(0));
  $('btnHamburger').addEventListener('click', () => toggleSidebar());
  $('btnSidebarDesk').addEventListener('click', () => toggleSidebar());
  $('btnInspector').addEventListener('click', toggleInspector);
  $('btnInspClose').addEventListener('click', closeInspector);
  $('btnConvMenu').addEventListener('click', () => { const b = $('btnConvMenu'); if (!$('jc-menu').hidden && $('jc-menu')._anchor === b) closeMenu(); else convMenu(b, state.current); });
  $('btnDrawerClose').addEventListener('click', () => toggleDrawer(false));
  $('scrim').addEventListener('click', closeOverlays);
  $('inspSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) inspTab(b.dataset.tab); });
  $('inspSeg').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = (TABS.indexOf(curTab) + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    inspTab(TABS[i]);
    $('inspSeg').querySelectorAll('button')[i].focus();
  });
  $('setSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (b) { setTabI = Number(b.dataset.i); drawSettings(); } });
  $('btnSetClose').addEventListener('click', closeSettings);
  $('settingsSheet').addEventListener('click', (e) => { if (e.target === $('settingsSheet')) closeSettings(); });
  $('btnDlgClose').addEventListener('click', closeDialog);
  $('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) closeDialog(); });
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette(); });
  $('palInput').addEventListener('input', (e) => renderPal(e.target.value));
  $('palInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); paintPal(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); paintPal(); }
    else if (e.key === 'Enter') { e.preventDefault(); execPal(palIdx); }
  });
  const title = $('tbTitle');
  title.addEventListener('dblclick', startRename);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finishRename(true); } });
  title.addEventListener('blur', () => finishRename(true));
  // trap Tab inside modal sheets
  for (const id of ['dlg', 'settingsSheet', 'palette']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...$(id).querySelectorAll('button:not([disabled]), input, textarea, select, a[href], [tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    });
  }

  renderRouteControls();
  renderAll();
  addEventListener('eden:open-team-mail', (e) => { queueTeamOpen(e.detail || {}); clearPhoneOverlays(); openSpace('mail'); }); // a team space's shared email (spaces.js)
  const firstMeta = reloadMeta();
  firstMeta.then(() => { renderAll(); initAccount({ beforeOpen: clearPhoneOverlays, closeSettings }); initLearned(); initAutopilot(); initSignatures(); initMailkit(); }); // H2/H3, signatures: after meta (askeden.com or the Mac)
  // Meta didn't load (offline at launch, a server blip): asked again until it does, sooner back online or back on the page.
  firstMeta.then(async () => { for (let tries = 0; !state.meta && state.metaError; tries++) { await retryWait(tries); await reloadMeta(); if (state.meta) renderAll(); } });
  if (!document.body.classList.contains('travel-standalone')) initTour(); // I1: practice mode's tour, or the welcome on a first visit (not on Eden Travel's own address)
  initFirstRun({ setComposerText: (t) => { setComposerText(t); focusComposer(); }, startTour: () => startTour() }); // Q4: a new person's first answer explained
  // an imported ChatGPT chat's images are kept in this browser (IndexedDB): the importer loads to bring them back
  const importedOpen = (c) => { if (c && c.source === 'chatgpt') importMod({ quiet: true }).then((m) => m.hydrateImport(c), () => {}); };
  addEventListener('eden:conv-opened', (e) => importedOpen(e.detail && e.detail.conv));
  setTimeout(() => importedOpen(state.current), 1500); // a reload with an imported chat open
  initHelp({ runCommand: (t) => commands().find((x) => x.t === t)?.run(), hasCommand: (t) => commands().some((x) => x.t === t), openSettings, openPalette, startTour, beforeOpen: clearPhoneOverlays });
  addEventListener('eden:open-settings', (e) => openSettings((e.detail && e.detail.tab) || 0)); // autopilot.js
  addEventListener('eden:acting', () => { renderSidebar(); checkJarvis().then(() => renderComposer()); }); // account.js: acting for someone began or ended under the page
  addEventListener('eden:open-inspector', (e) => openInspector((e.detail && e.detail.tab) || 'Route'));
  addEventListener('eden:open-space', (e) => { clearPhoneOverlays(); openSpace(e.detail && e.detail.key); }); // apps-menu.js: Eden for Education
  // askeden.com/?courses=1 (the apps menu on the Mac links here): the Courses panel, once meta says it's askeden.com
  if (new URLSearchParams(location.search).has('courses')) reloadMeta().then(() => { if (state.meta && state.meta.hosted) openSpace('courses'); });
  // Courses › Study (courses.js): a new chat in the course, answered from its materials; Quiz me / Flashcards send their request
  addEventListener('eden:course-chat', (e) => {
    const { course, prompt, focus } = e.detail || {};
    if (!course) return;
    const c = newConversation();
    c.course = focus && focus.doc ? { ...course, focus: { doc: String(focus.doc), loc: String(focus.loc || '') } } : course; // "Explain this slide" (Q8)
    c.title = course.name;
    c.titleSet = true;
    addConversation(c);
    closeSpace();
    switchTo(c);
    if (prompt) sendMessage(prompt);
  });
  loadProjects().then(() => renderSidebar());
  const btnBrowser = $('btnBrowser');
  if (btnBrowser) btnBrowser.addEventListener('click', () => { if (!browserPane) toggleBrowser(); }); // once loaded, browser-pane.js handles it
  // Eden at the controls (chat.js, browser-agent.js): load the panel, then hand it the event
  for (const type of ['eden:browser-open', 'eden:browser-takeover']) {
    addEventListener(type, (e) => { if (!browserPane) browserMod().then(() => dispatchEvent(new CustomEvent(type, { detail: e.detail })), () => {}); });
  }
  if (!IN_APP) setTimeout(() => browserMod({ quiet: true }).catch(() => {}), 0); // quietly: nobody asked yet
  checkJarvis().then(() => { renderComposer(); if (curTab === 'Memory') renderMemoryTab(true); });
  // The Mac's line comes up some seconds after the page loads (Ask Eden for Mac links itself at launch): look again until it answers.
  const recheckJarvis = () => { const was = state.jarvis.available; return checkJarvis().then(() => { if (state.jarvis.available !== was) { renderSidebar(); renderComposer(); } }); };
  // Never two looks at once (checkJarvis shares the one in flight, 8 s at most), and none while the page is hidden (B1, C3).
  whileVisible(() => { if (!state.jarvis.available) recheckJarvis().catch(() => {}); }, 8000); // (no timer at all while hidden)
  addEventListener('focus', () => { if (!state.jarvis.available && !document.hidden) recheckJarvis().catch(() => {}); });
  // A Eden Secretary call waiting on the owner's "Let Eden use Eden Secretary?" card (api.js): say so instead of spinning.
  addEventListener('eden:jarvis-approval', (e) => {
    const w = !!(e.detail && e.detail.waiting);
    if (w) macNotify('Eden', tx('Eden is asking “Let Eden use Eden Secretary?” on your Mac.'));
    // On every device, where the person is looking (a phone's sidebar is closed): A1, C2. The open panel says it too (panels.js).
    if (w) toast('Approve Eden on your Mac: it’s asking “Let Eden use Eden Secretary?”');
    $('jarvisState').classList.toggle('wait', w);
    $('jarvisState').title = w ? 'Eden is asking “Let Eden use Eden Secretary?” on your Mac' : state.jarvis.available ? 'Connected through the Eden app on your Mac: second brain, memory, calendar' : (state.jarvis.reason || 'The Eden app on your Mac isn’t reachable');
    $('jarvisStateText').textContent = w ? 'approve Eden on your Mac' : state.jarvis.available ? 'connected' : 'not connected';
  });
  if (isMock && !inMailOnly()) document.title = 'Eden (mock)';
  initPageUpdate();
  // Ready to type with a keyboard. Not on a touch screen (an iPhone, an iPad without a keyboard): the
  // on-screen keyboard came up by itself at launch and after the app's background reload (R2-17).
  if (!isTouch()) focusComposer();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

export { runChat, runCode, notify, shortModel };

// Scrollbars show only while scrolling (app.css .is-scrolling): on the element that scrolls, for a moment.
const scrollHide = new WeakMap();
document.addEventListener('scroll', (e) => {
  const box = e.target === document ? document.documentElement : e.target;
  if (!(box instanceof Element)) return;
  box.classList.add('is-scrolling');
  clearTimeout(scrollHide.get(box));
  scrollHide.set(box, setTimeout(() => box.classList.remove('is-scrolling'), 900));
}, { capture: true, passive: true });

// The sidebar's edge (#side-split, app.css): drag to set its width (200–480px, kept in this browser), double-click resets.
(() => {
  const side = document.getElementById('sidebar');
  if (!side) return;
  const KEY = 'eden:sideW';
  const root = document.documentElement;
  const set = (px) => { const w = Math.round(Math.min(480, Math.max(200, px))); root.style.setProperty('--side-w', `${w}px`); return w; };
  try { const saved = Number(localStorage.getItem(KEY)); if (saved > 0) set(saved); } catch { /* blocked */ }
  const h = document.createElement('div');
  h.id = 'side-split';
  h.tabIndex = 0;
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'vertical');
  h.setAttribute('aria-label', 'Resize the sidebar');
  h.title = 'Drag to resize · double-click to reset';
  side.after(h);
  const save = (w) => { try { localStorage.setItem(KEY, String(w)); } catch { /* blocked */ } };
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('drag');
    document.body.classList.add('side-resizing');
    const left = side.getBoundingClientRect().left;
    let w = side.offsetWidth;
    const move = (ev) => { w = set(ev.clientX - left); };
    const up = () => { h.removeEventListener('pointermove', move); h.classList.remove('drag'); document.body.classList.remove('side-resizing'); save(w); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up, { once: true });
    h.addEventListener('pointercancel', up, { once: true });
  });
  h.addEventListener('dblclick', () => { root.style.removeProperty('--side-w'); try { localStorage.removeItem(KEY); } catch { /* blocked */ } });
  h.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    save(set(side.offsetWidth + (e.key === 'ArrowRight' ? 20 : -20)));
  });
})();

// Phone: swipe the sidebar open (a rightward swipe anywhere on the chat) and shut (leftward, on it or the dimmed
// page), following the finger like ChatGPT's. Horizontal scrollers (code, tables), sheets and text selection keep their gestures.
(() => {
  const side = $('sidebar'), scrim = $('scrim');
  if (!side || !('ontouchstart' in window)) return;
  let g = null; // { x0, y0, t0, open, lock: null|'x'|'y', w, dx }
  const blocked = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches?.('input, textarea, [contenteditable="true"], .sheet, .sheet-card, dialog, .mx, .bw, .pal-box, #inspector, [data-noswipe]')) return true;
      if (n.scrollWidth > n.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  const paint = (x) => { // x: 0 = shut, w = open
    side.style.transition = 'none';
    side.style.visibility = 'visible';
    side.style.transform = `translateX(${-(g.w + 12) * (1 - x / g.w)}px)`; // 0 = docked open, past the left edge = shut
    scrim.classList.add('on');
    scrim.style.transition = 'none';
    scrim.style.opacity = String(Math.max(0, Math.min(1, x / g.w)));
  };
  const reset = () => { side.style.transition = side.style.transform = side.style.visibility = ''; scrim.style.opacity = scrim.style.transition = ''; };
  document.addEventListener('touchstart', (e) => {
    if (!isMobile() || e.touches.length !== 1) return;
    const open = side.classList.contains('open');
    if (!open && (blocked(e.target) || document.querySelector('.sheet.on, .sheet-card.on, dialog[open]'))) return;
    if (open && !side.contains(e.target) && e.target !== scrim) return;
    const t = e.touches[0];
    g = { x0: t.clientX, y0: t.clientY, t0: performance.now(), open, lock: null, w: side.offsetWidth || 300, dx: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0], dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.lock) {
      // A finger rolls a few px sideways as it starts to scroll; claiming that (preventDefault) froze
      // the page's scrolling. Any real vertical movement means a scroll; only a clearly sideways drag is ours.
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ay >= 8) g.lock = 'y';
      else if (ax < 16) return;
      else g.lock = ax > ay * 2 && (g.open ? dx < 0 : dx > 0) ? 'x' : 'y';
      if (g.lock === 'y' || (window.getSelection && String(window.getSelection()))) { g = null; return; }
    }
    g.dx = dx;
    e.preventDefault(); // the page doesn't scroll sideways under the drawer
    paint(g.open ? Math.max(0, g.w + dx) : Math.min(g.w, dx));
  }, { passive: false });
  const end = () => {
    if (!g) return;
    const { dx, open, w, t0, lock } = g;
    g = null;
    if (lock !== 'x') return;
    const v = dx / Math.max(1, performance.now() - t0); // px per ms
    const shouldOpen = open ? !(dx < -w * 0.3 || v < -0.4) : dx > w * 0.3 || v > 0.4;
    reset();
    toggleSidebar(shouldOpen);
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', () => { if (g) { g = null; reset(); syncScrim(); } }, { passive: true });
})();

// Phone gestures copied from the ChatGPT app: with the keyboard up, a swipe down on the chat or a tap on it closes the
// keyboard (iOS's own interactive dismiss can't fire: the chat is its own scroller, not the page). And a round ↓ button
// above the composer while you're scrolled up, back to the latest message (2026-10-12, owner's request).
(() => {
  const col = scrollcol();
  if (!col) return;
  const typing = () => { const a = document.activeElement; return a && a !== document.body && a.matches?.('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), [contenteditable="true"]'); };
  let keyboardTapAt = -1e9;
  const interactive = (el) => el.closest?.('a, button, input, textarea, select, label, summary, [role="button"], [contenteditable="true"], [data-act], .route-chip, .codeblk, pre');
  if ('ontouchstart' in window) {
    let t = null; // { x0, y0, t0, done }
    col.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || !typing() || col.contains(document.activeElement)) { t = null; return; } // editing a message in the chat keeps its keyboard
      t = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, t0: performance.now(), done: false };
    }, { passive: true });
    col.addEventListener('touchmove', (e) => {
      if (!t || t.done) return;
      const dx = e.touches[0].clientX - t.x0, dy = e.touches[0].clientY - t.y0;
      if (dy > 30 && dy > Math.abs(dx) * 1.5) { t.done = true; document.activeElement.blur(); } // a swipe down: the keyboard goes
    }, { passive: true });
    col.addEventListener('touchend', (e) => {
      if (!t || t.done) { t = null; return; }
      const c = e.changedTouches[0], moved = Math.hypot(c.clientX - t.x0, c.clientY - t.y0);
      if (moved < 10 && performance.now() - t.t0 < 350 && !interactive(e.target)) { document.activeElement.blur(); keyboardTapAt = performance.now(); } // a tap on the chat
      t = null;
    }, { passive: true });
  }
  // A tap on a reply shows which model answered it (and where, why, any fallback); another tap hides it again.
  // Not when that tap only closed the keyboard, and not on links, buttons, code or while selecting text.
  $('transcript').addEventListener('click', (e) => {
    const b = e.target.closest?.('.msg.assistant > .bubble');
    if (!b || interactive(e.target) || performance.now() - keyboardTapAt < 600 || String(window.getSelection?.() || '')) return;
    const m = b.parentElement, id = m.dataset.id;
    if (!id || !m.querySelector(':scope > .msg-head')) return;
    const show = !ui_open.meta.has(id);
    if (show) ui_open.meta.add(id); else ui_open.meta.delete(id);
    m.classList.toggle('meta-hidden', !show);
  });
  const svgNS = 'http://www.w3.org/2000/svg';
  const ic = document.createElementNS(svgNS, 'svg');
  ic.setAttribute('viewBox', '0 0 24 24'); ic.setAttribute('aria-hidden', 'true'); ic.classList.add('ic');
  const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', 'M12 5v14M6.5 13.5L12 19l5.5-5.5'); ic.append(p);
  const down = el('button', { type: 'button', class: 'jump-down glass', 'aria-label': 'Scroll to the latest message', title: 'Latest message', tabindex: '-1' }, ic);
  col.parentElement.append(down);
  const sync = () => down.classList.toggle('on', col.scrollHeight - col.scrollTop - col.clientHeight > 240);
  // The keyboard opening or closing changes the chat's height. Like ChatGPT, the bottom stays put: what was just above
  // the composer stays just above it (scrolled to the end stays at the end), instead of the latest lines sliding out of view.
  let fromBottom = 0, lastH = col.clientHeight;
  col.addEventListener('wheel', () => { if (state.current && state.streams.has(state.current.id)) userScrolledTurn = true; }, { passive: true });
  col.addEventListener('touchmove', () => { if (state.current && state.streams.has(state.current.id)) userScrolledTurn = true; }, { passive: true });
  col.addEventListener('pointerdown', (e) => { if (e.target === col && e.offsetX > col.clientWidth - 20 && state.current && state.streams.has(state.current.id)) userScrolledTurn = true; }, { passive: true });
  col.addEventListener('scroll', () => { if (col.clientHeight === lastH) fromBottom = col.scrollHeight - col.scrollTop - col.clientHeight; sync(); }, { passive: true });
  new ResizeObserver(() => {
    if (col.clientHeight !== lastH) {
      lastH = col.clientHeight;
      if (state.current && state.streams.has(state.current.id) && !userScrolledTurn) scrollTurnToTop();
      else col.scrollTop = col.scrollHeight - col.clientHeight - fromBottom;
    }
    sync();
  }).observe(col);
  new ResizeObserver(sync).observe($('transcript'));
  down.addEventListener('click', () => col.scrollTo({ top: col.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
})();
