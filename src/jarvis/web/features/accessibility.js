// Screen-reader mode, the window's side (features/accessibility.py): J.A.R.V.I.S. for people who
// are blind or have low vision.
//
// While it is on (Settings › Accessibility: Auto turns it on when a screen reader is running,
// as Electron reports it):
//   - Replies and heads-ups reach the screen reader once, whole and in plain words, through two
//     live regions of its own (the page's streaming ones are turned off, so nothing is read in
//     pieces or twice). JARVIS's own voice stays quiet unless the owner picked it.
//   - A question that needs an answer is announced at once, with its choices and keys, and the
//     keyboard focus moves to it (and back when it is answered).
//   - Short sounds say what JARVIS is doing: listening, thinking, done, needs your OK, error.
//   - The decorative panels (system stats, weather, markets) are out of the reading order, a
//     "skip to the request box" link leads the page, Space no longer opens the microphone, and
//     the keyboard focus stays where the owner put it.
//   - Keys that don't clash with the screen reader's own: Alt+Shift (Windows) or ⌘⇧ (Mac) with
//     Y yes, N no, R read the last reply again, S stop, T talk, U status, W the setup again,
//     H this list. The Stop talking key (app/features/shell.js, Ctrl+Alt+Backspace on a PC) works
//     from any program: what JARVIS says stops, and so does the screen reader's reading of it.
//   - Approvals by switch (Settings: "Switch control"): one switch (it sends Space or Enter)
//     moves through a question's choices, each said, and a long press, or the second switch,
//     chooses. Y and N still work.
//   - Short lines from the backend ("a11y_say": a private window about to be read, the screen
//     sent to Claude, where the focus went) are announced.
// Everywhere (screen reader or not) the Mac's glyphs in the window's words become Windows' keys.
(function (root) {
  'use strict';

  const IS_MAC = /Mac|iPhone|iPad/i.test((root.navigator && root.navigator.platform) || '');

  // ── words ──

  // A reply as a listener should get it: no markdown marks, no emoji or drawing characters,
  // links by their name or site, a pause where a line ends without one.
  function plainForReader(text, marks) {
    let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => `Code: ${code.trim()}\nEnd of code.\n`);
    s = s.replace(/`([^`\n]+)`/g, '$1');
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt ? `Image: ${alt}.` : ''));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1');
    s = s.replace(/https?:\/\/(?:www\.)?([^\s/?#)]+)[^\s)]*/g, 'link to $1');
    s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s*>\s?/gm, '');
    s = s.replace(/^\s*[-*+•]\s+/gm, '');
    s = s.replace(/^\s*[-=_*]{3,}\s*$/gm, '');
    s = s.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '');
    s = s.split('\n').map((line) => (line.includes('|') ? line.replace(/^\s*\||\|\s*$/g, '').split('|').map((cell) => cell.trim()).filter(Boolean).join(', ') : line)).join('\n');
    s = s.replace(/[─-╿▀-▟]+/g, ' ');
    s = s.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '');
    s = s.replace(/[ \t]+/g, ' ');
    const speaker = root.jarvisPunctuation;
    if (marks && marks !== 'none' && speaker && speaker.toSpeech) {
      // The person wants the punctuation said: the lines stay lines (a line end is "new line", a gap "new
      // paragraph"), no full stops of ours, and the marks the text really has become words.
      const kept = s.split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const language = (root.document && root.document.documentElement.lang) || 'en';
      return speaker.toSpeech(kept, marks, language).replace(/\s{2,}/g, ' ').trim();
    }
    const lines = s.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => (/[.!?:;,)"”'’…]$/.test(line) ? line : `${line}.`));
    return lines.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  // The Mac's key glyphs as a Windows user says them: "⌘⇧\" is "Ctrl+Shift+\".
  const MODIFIERS = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
  const SPECIAL = { '⌥ Space': 'Ctrl+Alt+Space', '⌥⇧ Space': 'Alt+Shift+Space', '⌥Space': 'Ctrl+Alt+Space', '⌥⇧Space': 'Alt+Shift+Space' };
  const GLYPH_KEYS = { '↩': 'Enter', '⏎': 'Enter', '⌫': 'Backspace', '⎋': 'Esc', '⇥': 'Tab' };
  const GLYPH_RUN = /([⌘⌃⌥⇧]+)(\s?Space\b|[A-Za-z0-9](?![A-Za-z0-9])|[,.\\/;'=[\]-]|[↩⏎⌫⎋⇥])?/gu;
  function keyWords(text, mac = IS_MAC) {
    if (mac || !/[⌘⌃⌥⇧↩⏎⌫⎋⇥]/.test(text)) return String(text);
    let out = String(text);
    for (const [from, to] of Object.entries(SPECIAL)) out = out.split(from).join(to);
    out = out.replace(GLYPH_RUN, (_m, mods, key) => {
      const names = [...mods].map((g) => MODIFIERS[g]).filter((n, i, all) => all.indexOf(n) === i);
      const last = key ? (GLYPH_KEYS[key] || key.trim()) : '';
      return [...names, ...(last ? [last] : [])].join('+');
    });
    return out.replace(/[↩⏎⌫⎋⇥]/g, (g) => GLYPH_KEYS[g]);
  }

  // The window's words about a Mac, said about a PC. (Only the window's own words: never a
  // reply, a file or code; see SKIP below.)
  const PC_WORDS = [
    [/\bSystem Settings\b/g, 'Settings'], [/Privacy & Security\b/g, 'Privacy & security'], [/\bmacOS\b/g, 'Windows'], [/\bMac(?!\w)/g, 'PC'], [/\bKeychain\b/g, 'password store'],
    [/\bFinder\b/g, 'File Explorer'], [/\bSpotlight\b/g, 'search'], [/\bmenu bar\b/g, 'system tray'],
  ];
  function pcWords(text, mac = IS_MAC) {
    if (mac) return String(text);
    let out = String(text);
    for (const [re, to] of PC_WORDS) out = out.replace(re, to);
    return out;
  }

  // A question that needs an answer, as it is announced.
  function approvalWords({ question = '', detail = '', choices = [] } = {}, keys = {}, marks = '') {
    const names = choices.map((c) => String(c.label || c.id || '').trim()).filter(Boolean);
    const parts = ['Needs your OK.', plainForReader(question)];
    const more = plainForReader(detail, marks).slice(0, marks && marks !== 'none' ? 1200 : 300);
    if (more) parts.push(more);
    if (names.length) parts.push(`Choices: ${names.map((n, i) => `${i + 1}, ${n}`).join('; ')}.`);
    if (keys.yes && names.length) {
      parts.push(`Press ${keys.yes} for ${names[0]}${keys.no && names.length > 1 ? `, ${keys.no} to say no` : ''}, or Tab to the buttons.`);
    }
    return parts.filter(Boolean).join(' ');
  }

  // Short sounds, as notes: frequency (Hz) and seconds. 0 Hz is a rest.
  const CUES = {
    listening: [[660, 0.09], [880, 0.12]],
    heard: [[740, 0.07]],
    thinking: [[392, 0.06]],
    working: [[330, 0.05]],
    done: [[880, 0.08], [660, 0.14]],
    approval: [[880, 0.1], [0, 0.04], [880, 0.1], [0, 0.04], [1175, 0.18]],
    error: [[233, 0.14], [196, 0.22]],
    notice: [[988, 0.08]],
    stop: [[330, 0.07], [262, 0.1]],
  };

  // J.A.R.V.I.S. Daredevil is the Windows edition. On a Mac the same mode is just screen-reader mode, and the
  // window keeps its own name.
  const EDITION = IS_MAC ? 'Screen-reader mode' : 'J.A.R.V.I.S. Daredevil';
  const APP_NAME = IS_MAC ? 'J.A.R.V.I.S.' : EDITION; // what the app is called in a sentence about opening it
  const lib = { plainForReader, keyWords, pcWords, approvalWords, CUES, EDITION };
  root.jarvisAccessibility = lib;

  const F = root.jarvisFeatures;
  if (!F || !root.document) return;
  const doc = root.document;
  const { el, send } = F;
  const t = (s) => F.t(s);
  const $ = (id) => doc.getElementById(id);

  // ── what is set, and what is running ──

  const DEFAULTS = {
    a11y_mode: 'auto', a11y_voice: 'auto', a11y_cues: true, a11y_cue_volume: 60, a11y_verbosity: 'normal', a11y_focus: true,
    a11y_dictate_punct: 'auto', a11y_read_punct: 'none',
    a11y_say_state: false, a11y_colors: 'auto', a11y_text_size: 'auto',
    a11y_read_speed: 0, a11y_read_verbosity: 'full', a11y_switch: 'off', a11y_switch_key: 'space', a11y_switch_hold: 1000,
    a11y_screen_share: 'ask', a11y_say_focus: true, a11y_setup_done: false,
  };
  let prefs = { ...DEFAULTS };
  let detected = false; // a screen reader is running (Electron says so: it says so for any program reading the window too)
  let backend = null; // the last "a11y" event
  // Whether one really is: the backend's word when it has given it (on a PC it asks Windows), else Electron's.
  const seenReader = () => (backend && typeof backend.detected === 'boolean' ? backend.detected : detected);
  // The app named J.A.R.V.I.S. Daredevil opens this page with ?edition=daredevil, which server.daredevil_page writes on
  // <body>: for it, Auto is on, with or without a screen reader (it is the same program, opened in this mode).
  const editionOn = () => Boolean(doc.body && doc.body.dataset.edition === 'daredevil');
  const effective = () => prefs.a11y_mode === 'on' || (prefs.a11y_mode === 'auto' && (seenReader() || editionOn()));
  // Auto: the screen reader reads the replies when there is one, Jarvis does when there isn't.
  const readerSpeaks = () => effective() && (prefs.a11y_voice === 'reader' || (prefs.a11y_voice === 'auto' && seenReader()));
  // The colours and the size: Auto is yellow on black and larger text while the edition is on.
  const COLORS = ['yellow', 'white', 'yellow-bg', 'yellow-blue'];
  const colorsNow = () => (prefs.a11y_colors === 'auto' ? (effective() ? 'yellow' : 'off') : COLORS.includes(prefs.a11y_colors) ? prefs.a11y_colors : 'off');
  const sizeNow = () => (prefs.a11y_text_size === 'auto' ? (effective() ? 'large' : 'normal') : prefs.a11y_text_size);
  // J.A.R.V.I.S. Daredevil is showing: screen-reader mode, or its colours.
  const daredevil = () => effective() || colorsNow() !== 'off';

  // ── the announcers: two live regions of our own, read once ──

  const polite = el('div', 'sr-only');
  polite.id = 'sr-polite';
  polite.setAttribute('role', 'status');
  polite.setAttribute('aria-live', 'polite');
  polite.setAttribute('aria-relevant', 'additions');
  const urgent = el('div', 'sr-only');
  urgent.id = 'sr-urgent';
  urgent.setAttribute('role', 'alert');
  urgent.setAttribute('aria-live', 'assertive');
  doc.body.append(polite, urgent);

  let lastSaid = '';
  const spokenLog = [];
  function announce(text, { important = false } = {}) {
    const words = String(text || '').replace(/\s+/g, ' ').trim();
    if (!words) return;
    lastSaid = words;
    spokenLog.push(words);
    if (spokenLog.length > 30) spokenLog.shift();
    const region = important ? urgent : polite;
    const line = el('p', '', words); // a new node each time: the same words twice are still said twice
    region.append(line);
    root.setTimeout(() => line.remove(), 15000);
  }

  // ── the edition's name ──
  // Screen-reader mode is J.A.R.V.I.S. Daredevil: while it is on, the window, the title bar and the
  // top of the page say so. (Eden Code is its own app, and a persona keeps its own name.)

  const inEdenCode = () => doc.body && doc.body.dataset.app === 'eden-code';
  let baseTitle = null;
  let prefsSeen = false;
  let welcomed = false;
  // The top left says "Jarvis Daredevil"; the title bar and what is announced say J.A.R.V.I.S. Daredevil.
  const WORDMARK = IS_MAC ? 'Jarvis' : 'Jarvis Daredevil';
  lib.homeName = () => (!inEdenCode() && daredevil() ? WORDMARK : 'Jarvis');
  function brand(on) {
    if (inEdenCode()) return;
    if (baseTitle === null) baseTitle = doc.title;
    if (!IS_MAC) doc.title = on ? EDITION : baseTitle;
    const mark = $('wordmark');
    if (mark && (mark.textContent === 'Jarvis' || mark.textContent === WORDMARK)) mark.textContent = lib.homeName();
  }
  // Said once when it is on, after the settings have said whether it is: where to start.
  function welcome(on) {
    if (!on || welcomed || !prefsSeen || inEdenCode()) return;
    welcomed = true;
    const keys = IS_MAC ? 'Command Shift' : 'Alt Shift';
    announce(`${IS_MAC ? 'Screen-reader mode is on' : EDITION}. ${readerSpeaks() ? 'Your screen reader reads the replies. ' : ''}Press ${keys} T to talk, or Tab to the request box. ${keys} H lists the keys.`);
  }

  // ── sounds ──

  let audio = null;
  function context() {
    if (audio) return audio;
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) return null;
    try { audio = new Ctor(); } catch (_) { audio = null; }
    return audio;
  }
  function cue(name, { force = false } = {}) {
    if (!(force || (effective() && prefs.a11y_cues))) return;
    const notes = CUES[name];
    const ctx = context();
    if (!notes || !ctx) return;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
    const level = Math.max(0, Math.min(100, Number(prefs.a11y_cue_volume) || 0)) / 100 * 0.25;
    let at = ctx.currentTime + 0.02;
    for (const [freq, seconds] of notes) {
      if (freq > 0 && level > 0) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(level, at + 0.01);
        gain.gain.setValueAtTime(level, at + Math.max(0.011, seconds - 0.03));
        gain.gain.linearRampToValueAtTime(0.0001, at + seconds);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + seconds + 0.02);
      }
      at += seconds;
    }
  }

  // ── the page, arranged for a screen reader ──

  // The stats, weather and markets panels sit in either column, whichever look is on. For a
  // screen reader they are noise: out of the reading order and the tab order (the mouse still
  // works, for low vision). Everything they say is there by voice, or by U.
  const DECORATIVE = ['galaxy-canvas', 'console-clock', 'p-system', 'p-weather', 'p-markets', 'p-uptime'];
  let skip = null;

  function hide(node) {
    node.setAttribute('aria-hidden', 'true');
    node.dataset.srHidden = '1';
    for (const n of [node, ...node.querySelectorAll('[tabindex], button, a[href], input, select, textarea')]) {
      if (n.dataset.srTab === undefined) n.dataset.srTab = n.hasAttribute('tabindex') ? n.getAttribute('tabindex') : '';
      n.tabIndex = -1;
    }
  }
  function unhide(node) {
    if (!node.dataset.srHidden) return;
    node.removeAttribute('aria-hidden');
    delete node.dataset.srHidden;
    for (const n of [node, ...node.querySelectorAll('[data-sr-tab]')]) {
      if (n.dataset.srTab === undefined) continue;
      if (n.dataset.srTab === '') n.removeAttribute('tabindex'); else n.setAttribute('tabindex', n.dataset.srTab);
      delete n.dataset.srTab;
    }
    if (node.id === 'galaxy-canvas') node.setAttribute('aria-hidden', 'true');
  }

  // Text size: the window's own zoom where the app gives it (the layout follows, as with the browser's
  // Ctrl+Plus), else CSS zoom on the page (zz-contrast.css).
  const ZOOM = { normal: 1, large: 1.25, larger: 1.5, largest: 2 };
  function applySize(size) {
    const bridgeZoom = root.jarvisApp && root.jarvisApp.setZoom;
    if (bridgeZoom) {
      delete doc.documentElement.dataset.textSize;
      bridgeZoom(ZOOM[size] || 1);
    } else if (size === 'normal') delete doc.documentElement.dataset.textSize;
    else doc.documentElement.dataset.textSize = size;
  }

  function arrange() {
    const on = effective();
    doc.documentElement.dataset.sr = on ? '1' : '0';
    for (const node of DECORATIVE.map($).filter(Boolean)) { if (on) hide(node); else unhide(node); }
    // The page's own streaming live regions would read half-written replies and repeat ours.
    const caption = doc.querySelector('.caption');
    if (caption) caption.setAttribute('aria-live', on ? 'off' : 'polite');
    const cards = $('cards');
    if (cards) cards.setAttribute('aria-live', on ? 'off' : 'polite');
    if (on && !skip) {
      skip = el('a', 'sr-skip', 'Skip to the request box');
      skip.href = '#ask-input';
      skip.addEventListener('click', (e) => { e.preventDefault(); const box = $('ask-input'); if (box) box.focus(); });
      doc.body.prepend(skip);
    }
    if (skip) skip.hidden = !on;
    roving(on);
    const look = colorsNow();
    if (look === 'off') delete doc.documentElement.dataset.contrast; else doc.documentElement.dataset.contrast = look;
    const size = sizeNow();
    applySize(size);
    brand(daredevil());
    welcome(on);
    for (const id of OVERLAYS) {
      const node = $(id);
      if (!node) continue;
      if (on && !node.getAttribute('role')) { node.setAttribute('role', 'dialog'); node.dataset.srRole = '1'; }
      else if (!on && node.dataset.srRole) { node.removeAttribute('role'); delete node.dataset.srRole; }
    }
    renderSettings();
  }

  // Radio groups: one tab stop, the arrow keys move through them (the ARIA pattern).
  const arrowing = (e) => {
    const group = e.target.closest && e.target.closest('[role="radiogroup"]');
    if (!group || !effective()) return;
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const at = radios.indexOf(e.target.closest('[role="radio"]'));
    if (at < 0) return;
    e.preventDefault();
    const next = radios[(at + keys[e.key] + radios.length) % radios.length];
    next.focus();
    next.click();
  };
  let rovingOn = false;
  function roving(on) {
    if (!on && !rovingOn) return; // (nothing of ours to undo)
    rovingOn = on;
    doc.querySelectorAll('[role="radiogroup"]').forEach((group) => {
      const radios = [...group.querySelectorAll('[role="radio"]')];
      const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
      radios.forEach((r) => { if (on) r.tabIndex = r === checked ? 0 : -1; else r.removeAttribute('tabindex'); });
    });
  }
  doc.addEventListener('keydown', arrowing);
  new MutationObserver((records) => {
    if (effective() && records.some((r) => r.type === 'attributes')) roving(true);
  }).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });

  // Panels that open over the page: the focus goes in, and back to where it was when they close.
  const OVERLAYS = ['settings', 'activity', 'accounts'];
  const openers = new Map();
  OVERLAYS.forEach((id) => {
    const node = $(id);
    if (!node) return;
    new MutationObserver(() => {
      if (!effective()) return;
      if (!node.hidden) {
        openers.set(id, doc.activeElement);
        if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
        node.focus();
        const name = node.getAttribute('aria-label') || (node.querySelector('h2') || {}).textContent || id;
        announce(`${name} opened. Press Escape to close.`);
      } else {
        const back = openers.get(id);
        openers.delete(id);
        if (back && back.isConnected && back !== doc.body) back.focus();
      }
    }).observe(node, { attributes: true, attributeFilter: ['hidden'] });
  });

  // ── what to announce ──

  let pending = null; // { rid, text }: the reply being written
  let pendingTimer = 0;
  let announcedFor = '';
  let lastReply = '';

  function finishReply() {
    root.clearTimeout(pendingTimer);
    if (!pending) return;
    const { rid, text } = pending;
    pending = null;
    const words = plainForReader(text, prefs.a11y_read_punct);
    if (!words) return;
    lastReply = words;
    const mark = `${rid}|${words}`;
    if (mark === announcedFor || !readerSpeaks()) return;
    announcedFor = mark;
    cue('done');
    announce(words);
  }

  F.on('turn', () => { pending = null; root.clearTimeout(pendingTimer); });
  F.on('reply', (ev) => {
    if (!ev.text) return;
    pending = { rid: ev.rid || '', text: ev.text };
    // Most replies end with turn_done; one that doesn't is read when it has stopped changing.
    root.clearTimeout(pendingTimer);
    pendingTimer = root.setTimeout(() => { if (doc.body.dataset.state !== 'thinking') finishReply(); }, 1500);
  });
  F.on('turn_done', finishReply);
  // Short lines from the backend: a private window about to be read, the screen sent, where the focus went.
  F.on('a11y_say', (ev) => {
    if (!ev || !ev.text || !effective() || !readerSpeaks()) return;
    if (ev.important) cue('notice');
    announce(ev.text, { important: Boolean(ev.important) });
  });

  // Stop everything: Alt+Shift+S here, or the Stop talking key from any program (the shell feature
  // sends jarvis:stop-all). What waits to be announced goes, and an assertive word cuts off the screen
  // reader's reading of a reply mid-sentence.
  function stopAll({ say = true } = {}) {
    root.clearTimeout(pendingTimer);
    pending = null;
    polite.replaceChildren();
    urgent.replaceChildren();
    cue('stop', { force: effective() });
    if (say && effective()) announce('Stopped.', { important: true });
  }
  doc.addEventListener('jarvis:stop-all', () => stopAll());
  F.on('caption', (ev) => {
    if (!ev.text || !readerSpeaks()) return;
    lastReply = plainForReader(ev.text, prefs.a11y_read_punct);
    announce(lastReply);
  });

  // The orb's state: a sound for each step, and (when asked for) the words.
  let stateName = 'idle';
  let workingTimer = 0;
  const STATE_WORDS = { listening: 'Listening', transcribing: 'One moment', thinking: 'Thinking', speaking: 'Speaking' };
  F.on('state', (ev) => {
    const next = ev.value || 'idle';
    const was = stateName;
    if (next === was) return; // (the page asks again at every step of a turn)
    stateName = next;
    root.clearInterval(workingTimer);
    if (!effective()) return;
    if (next === 'listening') cue('listening');
    else if (next === 'thinking' && was !== 'thinking') {
      cue('thinking');
      workingTimer = root.setInterval(() => cue('working'), 4000);
    } else if (next === 'idle' && was === 'listening') cue('stop');
    if (prefs.a11y_say_state && STATE_WORDS[next]) announce(STATE_WORDS[next]);
  });

  // Cards: questions that need an answer, notices, errors.
  const keysFor = () => (IS_MAC ? { yes: '⌘ Shift Y', no: '⌘ Shift N' } : { yes: 'Alt Shift Y', no: 'Alt Shift N' });
  const askedAbout = new WeakSet();

  function cardWords(card) {
    const kicker = (card.querySelector('.card-kicker') || {}).textContent || '';
    const title = (card.querySelector('.card-title') || {}).textContent || '';
    const body = (card.querySelector('.card-text') || card.querySelector('pre') || {}).textContent || '';
    return { kicker, title, body };
  }

  function seeCard(card) {
    if (askedAbout.has(card)) return;
    askedAbout.add(card);
    if (card.classList.contains('needs-ok')) {
      const { title, body } = cardWords(card);
      const choices = [...card.querySelectorAll('.card-actions button')].map((b) => ({ label: b.textContent }));
      cue('approval');
      const words = approvalWords({ question: title, detail: body, choices }, keysFor(), prefs.a11y_read_punct);
      announce(`${words}${switchHint()}`, { important: true });
      if (prefs.a11y_focus) {
        const first = card.querySelector('button');
        if (first) { openers.set('approval', doc.activeElement); first.focus(); }
      }
    } else if (card.classList.contains('plain')) {
      const { kicker, title, body } = cardWords(card);
      const bad = /went wrong|error|couldn.t|failed/i.test(`${title} ${body}`);
      cue(bad ? 'error' : 'notice');
      announce([kicker, title, body].filter(Boolean).join('. '), { important: bad });
    }
  }
  const cards = $('cards');
  if (cards) {
    new MutationObserver((records) => {
      if (!effective()) return;
      for (const r of records) r.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.classList.contains('card')) seeCard(n); });
      const left = doc.querySelectorAll('.card.needs-ok').length;
      if (!left) {
        const back = openers.get('approval');
        openers.delete('approval');
        if (back && back.isConnected && back !== doc.body && (!doc.activeElement || doc.activeElement === doc.body || (cards.contains(doc.activeElement)))) back.focus();
      }
    }).observe(cards, { childList: true });
  }
  // Eden Code's own question sheets (in the transcript).
  const timeline = $('deck-timeline');
  if (timeline) {
    new MutationObserver((records) => {
      if (!effective()) return;
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (n.nodeType !== 1 || !n.classList.contains('jc-ask') || askedAbout.has(n)) return;
          askedAbout.add(n);
          const question = (n.querySelector('.jc-ask-head') || {}).textContent || '';
          const detail = (n.querySelector('pre, .jc-dim, p:not(.jc-ask-head):not(.jc-ask-hint)') || {}).textContent || '';
          const choices = [...n.querySelectorAll('.jc-choices button')].map((b) => ({ label: b.textContent.replace(/^\d+/, '').trim() }));
          cue('approval');
          announce(approvalWords({ question, detail, choices }, { yes: '1', no: choices.length > 1 ? String(choices.length) : '' }, prefs.a11y_read_punct), { important: true });
        });
      }
    }).observe(timeline, { childList: true });
  }

  // ── approvals by switch ──
  // A switch sends a key (Space or Enter). With Switch control on, while a question waits: the first
  // switch moves to the next choice and says it; holding it (a11y_switch_hold) or the second switch
  // chooses the one with the focus. With no question waiting the keys are the page's as ever.

  function switchHint() {
    if (prefs.a11y_switch === 'off') return '';
    const [one, two] = prefs.a11y_switch_key === 'enter' ? ['Enter', 'Space'] : ['Space', 'Enter'];
    return ` Press ${one} to move through the choices, and hold it${prefs.a11y_switch === 'two' ? ` or press ${two}` : ''} to choose.`;
  }
  function switchRole(e) {
    if (prefs.a11y_switch === 'off' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return '';
    const target = e.target;
    if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return ''; // (typing)
    const space = e.key === ' ' || e.code === 'Space';
    const enter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
    const first = prefs.a11y_switch_key === 'enter' ? enter : space;
    const second = prefs.a11y_switch_key === 'enter' ? space : enter;
    if (first) return 'next';
    return second && prefs.a11y_switch === 'two' ? 'choose' : '';
  }
  const waitingCard = () => doc.querySelector('.card.needs-ok') || doc.querySelector('.jc-ask');
  const choicesOf = (card) => [...card.querySelectorAll('.card-actions button, .jc-choices button')].filter((b) => !b.disabled && !b.hidden);
  const labelOf = (b) => (b.textContent || '').replace(/^\d+/, '').trim();
  function switchNext(card) {
    const buttons = choicesOf(card);
    if (!buttons.length) return;
    const at = buttons.indexOf(doc.activeElement);
    const next = buttons[(at + 1) % buttons.length];
    next.focus();
    cue('heard');
    announce(`${labelOf(next)}. ${buttons.indexOf(next) + 1} of ${buttons.length}.`, { important: true });
  }
  function switchChoose(card) {
    const buttons = choicesOf(card);
    const chosen = buttons.find((b) => b === doc.activeElement);
    if (!chosen) {
      announce(`Move to a choice first.${switchHint()}`, { important: true });
      return;
    }
    announce(`Chose ${labelOf(chosen)}.`, { important: true });
    chosen.click();
  }
  let press = null; // the first switch held down: { timer, chose }
  root.addEventListener('keydown', (e) => {
    if (!effective()) return;
    const role = switchRole(e);
    const card = role && waitingCard();
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // (held: the timer chooses)
    if (role === 'choose') { switchChoose(card); return; }
    if (press) root.clearTimeout(press.timer);
    const hold = Math.max(300, Number(prefs.a11y_switch_hold) || 1000);
    press = { chose: false, timer: root.setTimeout(() => { if (press) { press.chose = true; switchChoose(card); } }, hold) };
  }, true);
  root.addEventListener('keyup', (e) => {
    if (!press || switchRole(e) !== 'next') return;
    e.preventDefault();
    e.stopPropagation();
    root.clearTimeout(press.timer);
    const { chose } = press;
    press = null;
    const card = waitingCard();
    if (!chose && card) switchNext(card);
  }, true);

  // ── keys ──

  const COMBO = IS_MAC ? '⌘⇧' : 'Alt+Shift+';
  function combo(e, letter) {
    const held = IS_MAC ? e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey : e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    return held && e.code === `Key${letter}`;
  }
  function pendingChoice(which) {
    const card = doc.querySelector('.card.needs-ok') || doc.querySelector('.jc-ask');
    if (!card) return null;
    const buttons = [...card.querySelectorAll('.card-actions button, .jc-choices button')];
    if (!buttons.length) return null;
    if (which === 'yes') return buttons[0];
    return buttons.find((b) => /not now|deny|^no\b|don.t|decline|cancel|keep planning/i.test(b.textContent)) || (buttons.length > 1 ? buttons[buttons.length - 1] : null);
  }
  function status() {
    const bits = [];
    bits.push((($('online-text') || {}).textContent || 'Online').trim());
    const line = (($('state-line') || {}).textContent || '').trim();
    if (line) bits.push(line);
    const model = (($('model-chip') || {}).textContent || '').trim();
    if (model) bits.push(`Model ${model}`);
    const waiting = doc.querySelectorAll('.card.needs-ok, .jc-ask').length;
    bits.push(waiting ? `${waiting} ${waiting === 1 ? 'question is' : 'questions are'} waiting for your answer` : 'Nothing is waiting for your answer');
    announce(`${bits.join('. ')}.`);
  }
  const SHORTCUTS = [
    ['Y', 'Say yes to the question that is waiting'],
    ['N', 'Say no to it'],
    ['R', 'Read the last reply again'],
    ['S', 'Stop speaking and stop what Jarvis is doing'],
    ['T', 'Talk to Jarvis'],
    ['U', 'What is Jarvis doing now'],
    ['W', 'Run the setup again'],
    ['H', 'This list of keys'],
  ];
  doc.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.repeat || e.isComposing || !effective()) return;
    for (const [letter] of SHORTCUTS) {
      if (!combo(e, letter)) continue;
      e.preventDefault();
      e.stopPropagation();
      if (letter === 'Y' || letter === 'N') {
        const button = pendingChoice(letter === 'Y' ? 'yes' : 'no');
        if (button) { announce(letter === 'Y' ? 'Yes.' : 'No.'); button.click(); } else announce('Nothing is waiting for an answer.');
      } else if (letter === 'R') {
        if (lastReply) { announce(lastReply); } else announce('There is no reply yet.');
      } else if (letter === 'S') {
        send({ type: 'stop' });
        stopAll();
      } else if (letter === 'W') {
        if (lib.setup) lib.setup.open(); else announce('The setup is not available here.');
      } else if (letter === 'T') {
        const orb = $('orb');
        if (orb) orb.click();
      } else if (letter === 'U') status();
      else if (letter === 'H') openHelp();
      return;
    }
  }, true);

  // The list of keys, as a dialog.
  let help = null;
  let helpFrom = null;
  function closeHelp() {
    if (!help) return;
    help.remove();
    help = null;
    if (helpFrom && helpFrom.isConnected) helpFrom.focus();
  }
  function openHelp() {
    if (help) { closeHelp(); return; }
    helpFrom = doc.activeElement;
    help = el('div', 'sr-help');
    help.setAttribute('role', 'dialog');
    help.setAttribute('aria-modal', 'true');
    help.setAttribute('aria-labelledby', 'sr-help-title');
    const title = el('h2', '', t('Keys for screen-reader mode'));
    title.id = 'sr-help-title';
    const list = el('dl');
    const where = IS_MAC ? 'Command+Shift' : 'Alt+Shift';
    for (const [letter, what] of SHORTCUTS) {
      list.append(el('dt', '', `${where}+${letter}`), el('dd', '', t(what)));
    }
    list.append(el('dt', '', 'Escape'), el('dd', '', t('Close what is open, and stop speaking')));
    const shell = root.jarvisShell;
    const hot = askKeys();
    list.append(el('dt', '', hot), el('dd', '', t('Talk to Jarvis from any app')));
    const stopKey = (shell && shell.stopLabel && shell.stopLabel()) || (IS_MAC ? '⌘⌥.' : 'Ctrl+Alt+Backspace');
    list.append(el('dt', '', keyWords(stopKey, IS_MAC)), el('dd', '', t('Stop talking and reading, from any app')));
    if (prefs.a11y_switch !== 'off') {
      const [one, two] = prefs.a11y_switch_key === 'enter' ? ['Enter', 'Space'] : ['Space', 'Enter'];
      list.append(el('dt', '', one), el('dd', '', t('Switch: move to the next choice of a question; hold it to choose')));
      if (prefs.a11y_switch === 'two') list.append(el('dt', '', two), el('dd', '', t('Switch: choose')));
    }
    const close = el('button', 'btn primary', t('Close'));
    close.type = 'button';
    close.addEventListener('click', closeHelp);
    help.append(title, list, close);
    help.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHelp(); }
      if (e.key === 'Tab') { e.preventDefault(); close.focus(); }
    });
    doc.body.append(help);
    close.focus();
  }

  // ── Settings › Accessibility ──

  let group = null;
  const controls = {};

  function segmented(label, key, options, swatches = false) {
    const wrap = el('div', swatches ? 'segmented a11y-swatches' : 'segmented');
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', label);
    for (const [value, name] of options) {
      const b = el('button', '');
      if (swatches) {
        const sample = el('span', `a11y-sw sw-${value}`, 'Aa');
        sample.setAttribute('aria-hidden', 'true');
        b.append(sample, el('span', '', t(name)));
      } else {
        b.append(t(name));
      }
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = value;
      b.addEventListener('click', () => change({ [key]: value }));
      wrap.append(b);
    }
    controls[key] = wrap;
    return wrap;
  }
  function toggle(label, note, key) {
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', t(label)));
    if (note) words.append(el('small', '', t(note)));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(label));
    sw.addEventListener('click', () => change({ [key]: !prefs[key] }));
    row.append(words, sw);
    controls[key] = sw;
    return row;
  }
  function stacked(label, note, control) {
    const row = el('div', 'row stack');
    const words = el('span');
    words.append(el('strong', '', t(label)));
    if (note) words.append(el('small', '', t(note)));
    row.append(words, control);
    return row;
  }
  function change(changes) {
    prefs = { ...prefs, ...changes };
    send({ type: 'feature_prefs', changes });
    if ('a11y_mode' in changes) sendDetected();
    arrange();
  }
  // Opening it from anywhere: the keys as they are now (the shell feature knows them), in words.
  function askKeys() {
    const shell = root.jarvisShell;
    const label = shell && shell.askLabel ? shell.askLabel() : '';
    return label ? keyWords(label, IS_MAC) : (IS_MAC ? '⌥ Space' : 'Ctrl+Alt+J');
  }
  let openNote = null;
  function renderOpenNote() {
    const note = openNote;
    if (!note) return;
    note.textContent = t(`Press ${askKeys()} from any program to open ${APP_NAME} and start talking. ${IS_MAC ? '' : 'J is the key your index finger finds by touch. '}Change it under Shortcuts in General.`);
  }
  doc.addEventListener('jarvis:shortcuts', renderOpenNote);

  function buildSettings() {
    const sheet = $('settings');
    const first = sheet && sheet.querySelector('.group');
    if (!first || group) return;
    group = el('section', 'group');
    group.id = 'a11y-group';
    group.dataset.settingsPane = 'accessibility';
    group.dataset.keywords = 'accessibility screen reader blind low vision nvda jaws narrator voiceover sound cues shortcuts keyboard daredevil colors colours contrast yellow black white blue text size large zoom magnify';
    group.append(el('h3', '', t(IS_MAC ? 'Screen-reader mode' : EDITION)));
    group.append(el('p', 'group-note', t(`${EDITION} is for people who are blind or have low vision. It works with your screen reader, never talks over it, and everything can be done from the keyboard.`)));
    const status = el('p', 'small-status');
    status.id = 'a11y-status';
    status.setAttribute('role', 'status');
    group.append(status);
    group.append(stacked('Screen-reader mode', editionOn() ? 'In J.A.R.V.I.S. Daredevil, Auto keeps it on. Off turns it off.' : 'Auto turns it on when a screen reader (NVDA, JAWS, Narrator, VoiceOver) is running.',
      segmented('Screen-reader mode', 'a11y_mode', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']])));
    group.append(stacked('Who reads Jarvis’s replies aloud', 'Auto: your screen reader, when one is running, and Jarvis’s own voice when none is. Your screen reader keeps your own voice and speed.',
      segmented('Who reads replies aloud', 'a11y_voice', [['auto', 'Auto'], ['reader', 'My screen reader'], ['jarvis', 'Jarvis’s voice']])));
    group.append(stacked('Colours', 'For low vision: strong pairings with a solid edge round everything. Auto is yellow on black while ' + (IS_MAC ? 'screen-reader mode' : 'Daredevil') + ' is on.',
      segmented('Colours', 'a11y_colors', [
        ['auto', 'Auto'], ['yellow', 'Yellow on black'], ['white', 'White on black'], ['yellow-bg', 'Black on yellow'], ['yellow-blue', 'Yellow on blue'], ['off', 'Off'],
      ], true)));
    group.append(stacked('Text size', 'Everything in the window gets larger, and the layout follows. Auto is larger while ' + (IS_MAC ? 'screen-reader mode' : 'Daredevil') + ' is on.',
      segmented('Text size', 'a11y_text_size', [['auto', 'Auto'], ['normal', 'Normal'], ['large', 'Large'], ['larger', 'Larger'], ['largest', 'Largest']])));
    group.append(stacked('How much Jarvis says', 'Brief is one to three sentences.',
      segmented('How much Jarvis says', 'a11y_verbosity', [['brief', 'Brief'], ['normal', 'Normal'], ['detailed', 'Detailed']])));
    group.append(stacked('Say the punctuation I dictate', 'When you dictate an email, a note or a document, say “comma”, “period”, “question mark” or “new paragraph” and Jarvis writes the mark. Otherwise Jarvis punctuates for you.',
      segmented('Dictated punctuation', 'a11y_dictate_punct', [['auto', 'Jarvis adds it'], ['spoken', 'I say it']])));
    group.append(stacked('Read punctuation aloud', 'Jarvis says the marks as words: “Hello comma world period”, in what it speaks and in what your screen reader is given. Say “read the punctuation” or “stop reading punctuation” any time.',
      segmented('Reading punctuation', 'a11y_read_punct', [['none', 'Don’t read'], ['some', 'Main marks'], ['all', 'Every mark']])));
    group.append(toggle('Sounds for what Jarvis is doing', 'Short tones: listening, thinking, done, needs your OK, error.', 'a11y_cues'));
    const volume = el('input');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.step = '10';
    volume.setAttribute('aria-label', t('Sound volume'));
    volume.addEventListener('input', () => { volume.setAttribute('aria-valuetext', `${volume.value} percent`); });
    volume.addEventListener('change', () => { change({ a11y_cue_volume: Number(volume.value) }); cue('done', { force: true }); });
    controls.a11y_cue_volume = volume;
    group.append(stacked('Sound volume', '', volume));
    group.append(stacked('Reading speed', 'How fast Jarvis’s voice reads long texts: documents, emails and reports. Conversation keeps the speed in Speaking. Your screen reader keeps its own.',
      segmented('Reading speed', 'a11y_read_speed', [[0, 'Same as talking'], [80, '80%'], [100, '100%'], [125, '125%'], [150, '150%'], [175, '175%'], [200, '200%']])));
    group.append(stacked('How much of a long text to read', 'For documents, emails and reports. Conversation follows “How much Jarvis says”.',
      segmented('How much of a long text to read', 'a11y_read_verbosity', [['full', 'All of it'], ['summary', 'A summary first'], ['highlights', 'Key points']])));
    group.append(toggle('Move the focus to a question that needs an answer', 'So you can answer without searching for it.', 'a11y_focus'));
    group.append(stacked('Switch control for questions', 'For switches that send Space or Enter. One switch: press to move through a question’s choices, hold to choose. Two switches: the second one chooses.',
      segmented('Switch control for questions', 'a11y_switch', [['off', 'Off'], ['one', 'One switch'], ['two', 'Two switches']])));
    group.append(stacked('The first switch sends', '',
      segmented('The first switch sends', 'a11y_switch_key', [['space', 'Space'], ['enter', 'Enter']])));
    group.append(stacked('A long press is', '',
      segmented('A long press is', 'a11y_switch_hold', [[500, 'Half a second'], [1000, 'One second'], [2000, 'Two seconds']])));
    group.append(stacked('Send what is on my screen to the AI model', 'To read or describe your screen, its contents go to Claude. Ask me first: you are asked the first time. Jarvis says each time it sends the screen.',
      segmented('Send what is on my screen to the AI model', 'a11y_screen_share', [['ask', 'Ask me first'], ['on', 'Yes'], ['off', 'No']])));
    group.append(toggle('Say which app has the focus', 'After Jarvis opens, clicks or switches something, it says where you are now.', 'a11y_say_focus'));
    group.append(toggle('Say what Jarvis is doing', 'Also say “Listening” and “Thinking”, not only play the sounds.', 'a11y_say_state'));
    openNote = el('p', 'group-note');
    openNote.id = 'a11y-open-note';
    group.append(openNote);
    renderOpenNote();
    const keys = el('button', 'btn', t('Keys for screen-reader mode'));
    keys.type = 'button';
    keys.addEventListener('click', openHelp);
    group.append(stacked('Keyboard shortcuts', 'Y yes, N no, R read again, S stop, T talk, U status, W setup, H this list.', keys));
    // (the setup and the trusted person add their rows here: accessibility_setup.js)
    const more = el('div', 'a11y-more');
    more.id = 'a11y-more';
    group.append(more);
    first.before(group);
  }
  function renderSettings() {
    if (!group) return;
    for (const [key, node] of Object.entries(controls)) {
      if (node.getAttribute('role') === 'radiogroup') {
        node.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(prefs[key]))));
      } else if (node.getAttribute('role') === 'switch') {
        node.setAttribute('aria-checked', String(Boolean(prefs[key])));
      } else if (node.type === 'range') {
        node.value = String(prefs[key]);
        node.setAttribute('aria-valuetext', `${node.value} percent`);
      }
    }
    const on = effective();
    const says = seenReader() ? 'A screen reader is running.' : 'No screen reader found.';
    $('a11y-status').textContent = `${t(says)} ${t(on ? 'Screen-reader mode is on.' : 'Screen-reader mode is off.')}`;
    roving(on);
  }

  // ── the page's other half: the app tells whether a screen reader is running ──

  function sendDetected() { send({ type: 'a11y_state', screen_reader: detected }); }
  const bridge = root.jarvisApp && root.jarvisApp.a11y;
  if (bridge) {
    bridge.supported().then((on) => { detected = Boolean(on); sendDetected(); arrange(); }).catch(() => {});
    bridge.onChange((on) => { detected = Boolean(on); sendDetected(); arrange(); });
  }

  F.on('prefs', (ev) => {
    const f = (ev && ev.features) || {};
    const next = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (key in f) next[key] = f[key];
    prefs = next;
    prefsSeen = true;
    arrange();
  }, { replay: true });
  F.on('hello', () => sendDetected());
  F.on('a11y', (ev) => { backend = ev; arrange(); });

  // ── the Mac's key glyphs, in a Windows user's words ──

  if (!IS_MAC) {
    const GLYPHS = /[⌘⌃⌥⇧↩⏎⌫⎋⇥]/;
    const WORDS = /\bSystem Settings\b|\bmacOS\b|\bMac(?!\w)|\bKeychain\b|\bFinder\b|\bSpotlight\b|\bmenu bar\b/;
    // What is never rewritten: the user's and the assistant's words, code and terminals (as i18n.js).
    const SKIP = 'script, style, code, pre, textarea, [contenteditable="true"], [data-no-i18n], .xterm, .jc-code';
    const SKIP_ATTRS = 'script, style, [data-no-i18n], .xterm, .jc-code';
    const say = (text) => pcWords(keyWords(text, false), false);
    const needs = (text) => GLYPHS.test(text) || WORDS.test(text);
    const fixNode = (node) => {
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (parent && parent.closest(SKIP)) return;
        if (needs(node.nodeValue)) { const fixed = say(node.nodeValue); if (fixed !== node.nodeValue) node.nodeValue = fixed; }
      } else if (node.nodeType === 1) {
        if (!node.closest(SKIP_ATTRS)) {
          for (const attr of ['aria-label', 'title', 'placeholder']) {
            const v = node.getAttribute(attr);
            if (v && needs(v)) node.setAttribute(attr, say(v));
          }
          const keys = node.getAttribute('aria-keyshortcuts');
          if (keys && /Meta/.test(keys)) node.setAttribute('aria-keyshortcuts', keys.replace(/Meta/g, 'Control'));
        }
        if (node.matches(SKIP)) return;
        node.childNodes.forEach(fixNode);
      }
    };
    const watch = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') fixNode(r.target);
        else if (r.type === 'attributes') fixNode(r.target.nodeType === 1 ? r.target : r.target.parentNode);
        else r.addedNodes.forEach(fixNode);
      }
    });
    watch.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'placeholder'] });
    fixNode(doc.body);
    doc.title = say(doc.title);
    lib.say = say;
  }

  const mount = () => { buildSettings(); arrange(); };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();

  lib.help = openHelp;
  lib.announce = announce;
  lib.cue = cue;
  lib.change = change;
  lib.effective = effective;
  lib.readerSpeaks = readerSpeaks;
  lib.prefs = () => ({ ...prefs });
  lib.prefsSeen = () => prefsSeen;
  lib.inEdenCode = inEdenCode;
  lib.stopAll = stopAll;
  lib.askKeys = askKeys;
  lib.state = () => ({ effective: effective(), edition: editionOn(), readerSpeaks: readerSpeaks(), detected, colors: colorsNow(), textSize: sizeNow(), daredevil: daredevil(), prefs: { ...prefs }, backend, lastSaid, spoken: [...spokenLog] });
})(typeof window !== 'undefined' ? window : globalThis);
