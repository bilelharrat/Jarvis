// Pages made usable with a screen reader, in J.A.R.V.I.S.'s built-in browser (app/features/
// page-a11y.js registers it for the browser's tabs; it runs in each tab's main frame, in the
// same isolated world as page-preload.js, so the page's own scripts can't see or reach it).
//
// While screen-reader mode is on (J.A.R.V.I.S. Daredevil; Settings › Accessibility can turn
// these fixes off), each page is mended as it loads and as it changes:
// - labels: a button, link or form field with no name gets one from the best source there is
//   (a title inside it, the words beside a field, its placeholder, its icon's own words or
//   file name, its name or id, the link's address), marked as guessed; a picture with no alt
//   gets one from its title, its caption or its file name, and a decorative one is hidden;
// - headings: big bold lines that aren't headings become ones, skipped levels are closed up,
//   a page with no level 1 heading gets one, and main and navigation landmarks are added
//   where the page has none, so a screen reader's heading and landmark keys work;
// - cookie banners: the "reject" or "necessary only" button is pressed where there is one,
//   else the banner is hidden; newsletter and sign-up overlays are closed or hidden, and the
//   page can scroll again. Nothing that buys, signs in or sends a form is ever pressed, and an
//   overlay that opened just after the owner pressed something is left alone.
// Only attributes are added (and a stylesheet of the app's own hides what is hidden); turning
// the mode off puts every one back. <html data-jarvis-a11y-fixed> counts what was fixed.
//
// Whatever the mode, it answers summary: the page's title, landmarks, heading outline, how
// many links, buttons, forms and pictures it has, and how its main text starts (the
// page_summary tool, for "what's on this page?").
//
// The helpers at the top work on words alone: node --test loads this file without a page.
'use strict';

(() => {
  const squash = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  // ── words: an icon's class, a file's name or a link's address, as a name ──

  // What an icon or a file is often called, said the way a person says it.
  const SAYS = {
    close: 'Close', x: 'Close', times: 'Close', cross: 'Close', dismiss: 'Close', xmark: 'Close',
    search: 'Search', magnifier: 'Search', magnifying: 'Search', loupe: 'Search', find: 'Search',
    menu: 'Menu', hamburger: 'Menu', bars: 'Menu', burger: 'Menu', navicon: 'Menu',
    cart: 'Cart', basket: 'Basket', bag: 'Bag', trolley: 'Cart',
    user: 'Account', account: 'Account', profile: 'Account', avatar: 'Account', person: 'Account',
    home: 'Home', house: 'Home', heart: 'Favourites', favorite: 'Favourites', favourite: 'Favourites', wishlist: 'Wish list',
    share: 'Share', prev: 'Previous', previous: 'Previous', back: 'Back', next: 'Next', forward: 'Forward',
    play: 'Play', pause: 'Pause', stop: 'Stop', mute: 'Mute', volume: 'Volume',
    settings: 'Settings', gear: 'Settings', cog: 'Settings', bell: 'Notifications', notification: 'Notifications', notifications: 'Notifications',
    mail: 'Email', envelope: 'Email', email: 'Email', phone: 'Phone', download: 'Download', upload: 'Upload',
    edit: 'Edit', pencil: 'Edit', trash: 'Delete', bin: 'Delete', plus: 'Add', add: 'Add', minus: 'Less',
    info: 'Information', help: 'Help', question: 'Help', globe: 'Language', language: 'Language', print: 'Print',
    expand: 'Expand', collapse: 'Collapse', more: 'More', ellipsis: 'More', dots: 'More', kebab: 'More', filter: 'Filter', sort: 'Sort',
    facebook: 'Facebook', twitter: 'Twitter', instagram: 'Instagram', youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok', pinterest: 'Pinterest', whatsapp: 'WhatsApp', github: 'GitHub', rss: 'RSS feed',
  };
  // Two words that are one thing.
  const SAYS_TWO = {
    'chevron left': 'Previous', 'chevron right': 'Next', 'arrow left': 'Previous', 'arrow right': 'Next', 'angle left': 'Previous', 'angle right': 'Next',
    'caret left': 'Previous', 'caret right': 'Next', 'chevron down': 'Expand', 'chevron up': 'Collapse', 'caret down': 'Expand', 'caret up': 'Collapse',
    'arrow up': 'Up', 'arrow down': 'Down', 'shopping cart': 'Shopping cart', 'shopping bag': 'Shopping bag', 'log out': 'Log out', 'sign out': 'Sign out',
    'more vert': 'More', 'more horiz': 'More', 'more horizontal': 'More', 'more vertical': 'More', 'x mark': 'Close',
  };
  // Words that say nothing about what the thing does (how it's drawn, its size, its library).
  const NOISE = new Set(['icon', 'icons', 'ico', 'ic', 'fa', 'fas', 'far', 'fab', 'fal', 'fad', 'fa6', 'bi', 'glyphicon', 'glyph', 'svg', 'img', 'image', 'btn',
    'button', 'material', 'symbols', 'symbol', 'outlined', 'outline', 'rounded', 'round', 'sharp', 'solid', 'regular', 'light', 'thin', 'filled', 'fill', 'line',
    'small', 'large', 'sm', 'lg', 'md', 'xs', 'xl', 'xxl', 'white', 'black', 'dark', 'primary', 'secondary', 'default', 'js', 'active', 'disabled',
    'hidden', 'visible', 'mobile', 'desktop', 'only', 'wrapper', 'wrap', 'container', 'inner', 'outer', 'el', 'item', 'link', 'ui', 'c', 'u', 'o',
    'mdi', 'ion', 'ionicon', 'feather', 'lucide', 'heroicon', 'octicon', 'tabler', 'uil', 'ri', 'la', 'las', 'lar', 'lab', 'clickable', 'toggle', 'trigger',
    'jsx', 'css', 'sc', 'emotion', 'module', 'w', 'h', 'px', 'svgicon', 'sprite', 'new', 'v', 'cta', 'nav', 'header', 'footer', 'top', 'bar', 'web', 'site', 'main', 'global', 'common']);
  const STOP = new Set(['is', 'has', 'a', 'an', 'the', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with', 'by', 'at']);
  const FILE_JUNK = /^(img|dsc|dscn|dcim|image|photo|pic|picture|screenshot|screen shot|untitled|file|scan|thumb|thumbnail|banner|hero|bg|background|placeholder|spacer|pixel|blank|transparent|default|unnamed|download)[\s_-]*\d*$/i;

  // A token that is an id, a hash or a size rather than a word: "a8f9c0d2", "24px", "2x".
  function hashy(token) {
    const t = String(token).toLowerCase();
    if (!t) return true;
    if (/^\d+$/.test(t) || /^\d+(px|x|w|h|em|rem|pt)$/.test(t) || /^@?\d+x$/.test(t) || /^v\d+$/.test(t)) return true;
    if (/^[0-9a-f]{6,}$/.test(t) && /\d/.test(t)) return true;
    if (t.length >= 7 && /\d/.test(t) && /[a-z]/.test(t) && !/^[a-z]+\d{1,2}$/.test(t)) return true;
    if (t.length >= 10 && !/[aeiouy]/.test(t)) return true;
    return false;
  }

  // A class name, a file name or a piece of an address, as a name: "icon-shopping-cart" is
  // "Shopping cart", "fa-xmark" is "Close", "IMG_2034.jpg" is nothing.
  function words(raw) {
    let text = String(raw == null ? '' : raw);
    try { text = decodeURIComponent(text); } catch (_) { /* as it is */ }
    text = text.replace(/[?#].*$/, '').replace(/\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|html?|php|aspx?|jsp)$/i, '');
    if (FILE_JUNK.test(squash(text.replace(/[_-]+/g, ' ')))) return '';
    const tokens = text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[\s_./:+,|()[\]-]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t && !NOISE.has(t) && !hashy(t) && /[a-z]/.test(t));
    // Little words alone ("is-active" leaves "is") say nothing; in a phrase they stay.
    if (!tokens.length || tokens.every((t) => STOP.has(t))) return '';
    const joined = tokens.join(' ');
    if (SAYS_TWO[joined]) return SAYS_TWO[joined];
    if (tokens.length === 1 && SAYS[tokens[0]]) return SAYS[tokens[0]];
    for (let i = 0; i + 1 < tokens.length; i++) {
      const pair = `${tokens[i]} ${tokens[i + 1]}`;
      if (tokens.length <= 3 && SAYS_TWO[pair]) return SAYS_TWO[pair];
    }
    if (tokens.length <= 2) {
      const known = tokens.find((t) => SAYS[t]);
      if (known && tokens.every((t) => SAYS[t] || t.length <= 3)) return SAYS[known];
    }
    if (tokens.length > 6 || tokens.every((t) => t.length < 2)) return '';
    const said = tokens.join(' ').slice(0, 60);
    return said.charAt(0).toUpperCase() + said.slice(1);
  }

  // The words of an icon's classes: only the classes that name an icon ("fa-search",
  // "icon-cart", "bi-x-lg", "glyphicon-home"), never the page's layout classes.
  const ICON_CLASS = /^(fa[srlbdk]?|fa-solid|fa-regular|bi|glyphicon|icon|icons|ico|ic|mdi|ion|ionicon|la[srb]?|ri|uil|feather|lucide|tabler|octicon|heroicon|svg-icon|material-icons?|material-symbols(-[a-z]+)?)[-_]/i;
  function iconWords(className) {
    const named = String(className || '').split(/\s+/).filter((c) => ICON_CLASS.test(c) || /(^|[-_])icon[-_]/i.test(c) || /[-_]icon$/i.test(c));
    for (const c of named) {
      const said = words(c.replace(ICON_CLASS, ''));
      if (said) return said;
    }
    return '';
  }

  // A glyph standing for a word: "×" is Close, "☰" Menu, "›" Next.
  const GLYPHS = { '×': 'Close', '✕': 'Close', '✖': 'Close', '╳': 'Close', '☰': 'Menu', '≡': 'Menu', '‹': 'Previous', '«': 'Previous', '←': 'Previous', '<': 'Previous',
    '›': 'Next', '»': 'Next', '→': 'Next', '>': 'Next', '🔍': 'Search', '🔎': 'Search', '⌕': 'Search', '♥': 'Favourites', '❤': 'Favourites', '♡': 'Favourites', '+': 'Add',
    '−': 'Less', '⋮': 'More', '⋯': 'More', '…': 'More', '▶': 'Play', '►': 'Play', '⏸': 'Pause', '✓': 'Done', '✔': 'Done', '⚙': 'Settings', '🛒': 'Cart', '⌂': 'Home', '?': 'Help' };
  // Text that is only symbols, or a font's private glyphs: no name a screen reader can say.
  function symbolOnly(text) {
    const t = squash(text).replace(/[\ufe0f\u200d]/g, '');
    return Boolean(t) && !/[\p{L}\p{N}]/u.test(t);
  }
  function glyphWords(text) {
    const t = squash(text).replace(/[\ufe0f\u200d]/g, '');
    return GLYPHS[t] || '';
  }
  // A font's ligature icon ("shopping_cart" inside a material-icons span), as words.
  function ligatureWords(text) {
    const t = squash(text);
    return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(t) ? words(t) : '';
  }

  // A link's address as a name: the last meaningful part of its path ("/account/orders" is
  // "Orders"), its site for one to another site, "Home" for the site's front page.
  function linkWords(href, pageUrl) {
    const raw = String(href || '').trim();
    if (!raw || /^(javascript:|#)/i.test(raw)) return '';
    if (/^mailto:/i.test(raw)) { const to = squash(raw.slice(7).split('?')[0]); return to ? `Email ${to}` : 'Email'; }
    if (/^tel:/i.test(raw)) { const to = squash(raw.slice(4)); return to ? `Call ${to}` : 'Call'; }
    let url;
    let page = null;
    try { page = new URL(pageUrl || 'http://localhost/'); } catch (_) { page = null; }
    try { url = new URL(raw, page || undefined); } catch (_) { return ''; }
    if (!/^https?:$/.test(url.protocol)) return '';
    const host = url.hostname.replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean).filter((p) => !/^(index|default|home)(\.\w+)?$/i.test(p));
    for (let i = parts.length - 1; i >= 0; i--) {
      const said = words(parts[i]);
      if (said) {
        if (page && url.hostname !== page.hostname) return `${said}, on ${host}`;
        return said;
      }
    }
    if (page && url.hostname !== page.hostname) {
      const site = words(host.split('.').slice(-2, -1)[0] || '');
      return SAYS[(host.split('.').slice(-2, -1)[0] || '').toLowerCase()] || site || host;
    }
    return parts.length ? '' : 'Home';
  }

  // ── what a banner says, and which of its buttons is safe to press ──

  const CONSENT = /\bcookies?\b|\bconsent\b|\bgdpr\b|\bccpa\b|your privacy|privacy (preferences|settings|choices|center|centre)|we (and our (partners|vendors) )?(use|value your privacy|care about your privacy)|tracking technolog|personali[sz]ed (ads|advertising|content)|datenschutz|\bcookies? (settings|preferences)\b/i;
  const NEWSLETTER = /newsletter|subscribe|sign ?up|join (us|our|the)|get \d+ ?% off|\d+ ?% off your|discount|exclusive (offers|deals|access)|don['’]t miss|stay (in the loop|updated|informed)|be the first to|inbox|mailing list|special offers/i;
  const WALL = /sign ?up|sign ?in|log ?in|create (a|an|your) (free )?account|register|subscribe to (continue|read)|continue reading|members only/i;
  const REJECT = new RegExp('^(?:'
    + '(?:reject|decline|deny|refuse|disagree|disallow|opt out of)(?: all| everything)?(?: (?:optional|non-essential|nonessential|non essential|additional|marketing|other|unnecessary))?(?: cookies| tracking)?(?: and close| & close)?'
    + '|(?:use |accept |allow |continue with |only allow )?(?:only )?(?:strictly )?(?:necessary|essential|required|functional)(?: cookies)?(?: only)?'
    + '|(?:i )?do not (?:accept|agree|consent)|don[\'’]t (?:accept|agree|allow)|no,? thanks?(?: you)?|no,? i do not agree'
    + '|continue without (?:accepting|agreeing|consent(?:ing)?)|(?:accept|use) (?:only )?(?:necessary|essential|required)(?: cookies)?(?: only)?'
    + '|(?:alle )?ablehnen|nur (?:notwendige|erforderliche|essenzielle)(?: cookies)?|refuser(?: tout)?|tout refuser|continuer sans accepter'
    + '|rechazar(?: todo| todas| todas las cookies)?|rifiuta(?: tutto| tutti)?|weigeren|alles weigeren|recusar|rejeitar(?: tudo)?'
    + ')$', 'i');
  const CLOSE = /^(?:close|close (?:this|the|dialog|popup|pop-up|modal|window|banner|form|overlay)|dismiss|no,? thanks?(?: you)?|no thank you|not now|maybe later|not interested|i['’]m not interested|skip|later|continue (?:to (?:the )?(?:site|website|shopping|browsing)|browsing|without)|×|✕|✖|x|╳)$/i;
  // Words that buy, sign in or send something: never pressed, whatever else they say.
  const NEVER = /\b(buy|purchase|order|checkout|check out|pay|payment|subscribe|sign ?in|sign ?up|log ?in|register|submit|send|donate|upgrade|trial|join|claim|redeem|get (my|the|your) (code|offer|discount)|unlock|install|download)\b/i;

  // Whether a button's words are a reject or a plain close (both: only those, nothing more).
  function rejectWords(text) {
    const t = squash(text).replace(/[.!:]+$/, '');
    return Boolean(t) && t.length <= 60 && !NEVER.test(t) && REJECT.test(t);
  }
  function closeWords(text) {
    const t = squash(text).replace(/[.!:]+$/, '');
    return Boolean(t) && t.length <= 40 && !NEVER.test(t) && CLOSE.test(t);
  }
  // What kind of overlay this is by what it says: consent, newsletter, wall, or ''.
  function overlayKind(text, { email = false, covers = 0 } = {}) {
    const t = squash(text).slice(0, 4000);
    if (!t && !email) return '';
    if (CONSENT.test(t) && t.length < 4000) return 'consent';
    if (covers >= 0.2 && (email || NEWSLETTER.test(t)) && t.length < 1500) return 'newsletter';
    if (covers >= 0.4 && WALL.test(t) && t.length < 1500) return 'wall';
    return '';
  }

  // ── headings: levels with no gaps ──

  // Each heading's level with the skips closed up (a 2 followed by a 4 makes the 4 a 3), in
  // reading order; a level is only ever made smaller.
  function closeGaps(levels) {
    const stack = []; // [{ was, now }]
    return levels.map((was) => {
      while (stack.length && stack[stack.length - 1].was > was) stack.pop();
      let now = was;
      const top = stack[stack.length - 1];
      if (top && top.was === was) now = top.now;
      else if (top) now = Math.min(was, top.now + 1);
      else now = was;
      if (top && top.was === was) stack[stack.length - 1] = { was, now };
      else stack.push({ was, now });
      return now;
    });
  }

  // A level for a big bold line from how big it is beside the page's own headings: the one
  // nearest in size, or (with none) by how much bigger than the body text it is.
  function levelForSize(size, base, known = []) {
    if (known.length) {
      let best = null;
      for (const k of known) {
        const off = Math.abs(Math.log(size / k.size));
        if (!best || off < best.off - 1e-6 || (Math.abs(off - best.off) < 1e-6 && k.level > best.level)) best = { off, level: k.level };
      }
      return Math.max(2, best.level);
    }
    const ratio = size / (base || 16);
    if (ratio >= 1.75) return 2;
    if (ratio >= 1.35) return 3;
    return 4;
  }

  const H = { squash, words, iconWords, glyphWords, symbolOnly, ligatureWords, linkWords, hashy, rejectWords, closeWords, overlayKind, closeGaps, levelForSize, NEVER };
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = H;
    return;
  }
  if (window !== window.top) return; // the page itself only, never its frames
  if (!/^https?:|^file:/.test(location.href)) return;

  const { ipcRenderer, webFrame } = require('electron');

  // ── the page ──

  const MARK = 'data-jarvis-a11y';
  const STYLE = `[${MARK}-hidden] { display: none !important; }
html[${MARK}-scroll], body[${MARK}-scroll] { overflow: auto !important; overflow-y: auto !important; }
body[${MARK}-scroll="fixed"] { position: static !important; }`;
  const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="radio"], [role="combobox"], [role="searchbox"], [role="textbox"], [role="option"]';
  const FIELD_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  const MAX_SCAN = 6000; // elements looked at for big bold lines in one pass
  const GESTURE_MS = 2500; // an overlay that opens this soon after a press is the owner's

  let on = false;
  let cssKey = null;
  let observer = null;
  let timer = 0;
  let lastPass = 0;
  let startedAt = 0;
  let lastGesture = 0;
  let closedAny = false; // an overlay was closed or hidden on this page
  const changes = []; // [{ el, attr, was }] in the order made, to put back
  let seen = new WeakSet(); // controls and pictures already looked at
  let scanned = new WeakSet(); // elements already weighed as big bold lines
  const firstSeen = new WeakMap(); // overlay -> { at, owners: opened just after a press }
  const levelWas = new WeakMap(); // heading -> its level before any fix
  const ariaWas = new WeakMap(); // heading -> the page's own aria-level (or null) before ours
  const levelFixed = new WeakSet(); // headings whose level was closed up (counted once)
  const counts = { labels: 0, images: 0, decorative: 0, headings: 0, levels: 0, h1: 0, landmarks: 0, banners: 0, rejected: 0, closed: 0, scroll: 0 };

  function set(el, attr, value) {
    if (!el || !el.setAttribute) return;
    const was = el.hasAttribute(attr) ? el.getAttribute(attr) : null;
    if (was === value) return;
    changes.push({ el, attr, was });
    el.setAttribute(attr, value);
  }
  function unset(el, attr) {
    if (!el || !el.hasAttribute || !el.hasAttribute(attr)) return;
    changes.push({ el, attr, was: el.getAttribute(attr) });
    el.removeAttribute(attr);
  }

  function shows(el) {
    if (!el || !el.isConnected) return false;
    if (typeof globalThis.jarvisSight === 'function') {
      try { return globalThis.jarvisSight().shows(el); } catch (_) { /* below */ }
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  const rendered = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // The text of the elements an aria-labelledby (or -describedby) names, hidden ones too.
  function idsText(ids) {
    return squash(String(ids || '').split(/\s+/).filter(Boolean).map((id) => {
      const n = document.getElementById(id);
      return n ? n.textContent : '';
    }).join(' '));
  }

  // The words a screen reader would take from inside an element: its text, pictures' alt and
  // icons' own labels, leaving out what is hidden from it.
  function contentName(el, depth = 0) {
    if (depth > 12) return '';
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { out += node.nodeValue; continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') continue;
      if (node.getAttribute('aria-hidden') === 'true' || node.hidden) continue;
      const label = node.getAttribute('aria-label');
      if (label && squash(label)) { out += ` ${label} `; continue; }
      if (tag === 'IMG' || tag === 'AREA') { out += ` ${node.getAttribute('alt') || ''} `; continue; }
      if (tag === 'svg' || tag === 'SVG') {
        const t = node.querySelector('title');
        out += ` ${t ? t.textContent : ''} `;
        continue;
      }
      out += ` ${contentName(node, depth + 1)} `;
    }
    return squash(out);
  }

  const isField = (el) => FIELD_TAGS.has(el.tagName) || /^(combobox|searchbox|textbox|checkbox|switch|radio)$/.test(el.getAttribute('role') || '');
  const iconFont = (el) => /material-(icons|symbols)|material-symbols/.test(String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || ''));

  // The element's name as a screen reader finds it now: '' when it has none it can say.
  function nameOf(el) {
    const label = squash(el.getAttribute('aria-label'));
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = idsText(by); if (t) return t; }
    if (FIELD_TAGS.has(el.tagName)) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['submit', 'reset', 'button'].includes(type)) return squash(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      if (type === 'image') return squash(el.getAttribute('alt')) || squash(el.title);
      for (const l of el.labels || []) { const t = squash(l.textContent); if (t) return t; }
      return squash(el.title);
    }
    if (squash(el.title)) return squash(el.title);
    const inside = contentName(el);
    if (!inside || symbolOnly(inside)) return '';
    // A font's ligature ("shopping_cart") is read letter by letter: no name.
    if (ligatureWords(inside) && (iconFont(el) || el.querySelector('.material-icons, .material-symbols-outlined, .material-symbols-rounded, [class*="material-icons"], [class*="material-symbols"]'))) return '';
    return inside;
  }

  // The words written next to a field: a label with no "for", the text just before it, its
  // table cell's neighbour.
  function besideWords(el) {
    const ok = (t) => { const s = squash(t); return s && s.length <= 60 && !/[\n]/.test(s) ? s.replace(/[:*]+$/, '').trim() : ''; };
    const parent = el.parentElement;
    if (parent) {
      const label = [...parent.children].find((c) => c.tagName === 'LABEL' && !c.htmlFor && !c.contains(el));
      if (label && ok(label.textContent)) return ok(label.textContent);
      const fields = parent.querySelectorAll('input:not([type="hidden"]), select, textarea');
      if (fields.length === 1) {
        const own = ok([...parent.childNodes].filter((n) => n !== el && (n.nodeType === 3 || (n.nodeType === 1 && !n.contains(el)))).map((n) => n.textContent).join(' '));
        if (own) return own;
      }
    }
    let prev = el.previousSibling;
    for (let i = 0; prev && i < 3; i++, prev = prev.previousSibling) {
      if (prev.nodeType === 3 && ok(prev.nodeValue)) return ok(prev.nodeValue);
      if (prev.nodeType === 1) {
        if (prev.querySelector && prev.querySelector('input, select, textarea, button')) break;
        if (ok(prev.textContent)) return ok(prev.textContent);
      }
    }
    const cell = el.closest('td');
    if (cell && cell.previousElementSibling && ok(cell.previousElementSibling.textContent)) return ok(cell.previousElementSibling.textContent);
    return '';
  }

  // An icon's own words: an svg's title, a <use> pointing at "#icon-search", the icon's
  // classes, a ligature, a glyph, a picture's file name or a background's.
  function iconOf(el) {
    const nodes = [el, ...el.querySelectorAll('svg, use, i, span, img, em, b')].slice(0, 30);
    for (const n of nodes) {
      if (n.tagName && n.tagName.toLowerCase() === 'svg') {
        const t = n.querySelector('title, desc');
        if (t && squash(t.textContent)) return squash(t.textContent);
      }
    }
    for (const n of nodes) {
      if (n.tagName && n.tagName.toLowerCase() === 'use') {
        const ref = n.getAttribute('href') || n.getAttribute('xlink:href') || '';
        const said = words(ref.split('#').pop());
        if (said) return said;
      }
    }
    for (const n of nodes) {
      const cls = n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className;
      const said = iconWords(cls);
      if (said) return said;
      if (iconFont(n)) { const lig = ligatureWords(n.textContent); if (lig) return lig; }
      for (const attr of ['data-icon', 'data-testid', 'data-feather', 'data-lucide']) {
        const v = n.getAttribute && n.getAttribute(attr);
        if (v) { const w = words(v); if (w) return w; }
      }
    }
    const glyph = glyphWords(el.textContent);
    if (glyph) return glyph;
    for (const n of nodes) {
      if (n.tagName === 'IMG') { const w = words((n.getAttribute('src') || '').split('/').pop()); if (w) return w; }
    }
    for (const n of nodes.slice(0, 4)) {
      const bg = getComputedStyle(n).backgroundImage || '';
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m && !m[1].startsWith('data:')) { const w = words(m[1].split('/').pop()); if (w) return w; }
    }
    return '';
  }

  // The best name there is for a control with none, and where it came from.
  function guessName(el) {
    const field = isField(el);
    const tries = [];
    const titled = el.querySelector && el.querySelector('[title]');
    tries.push(['title', () => (titled ? squash(titled.getAttribute('title')) : '')]);
    if (field) tries.push(['beside', () => besideWords(el)]);
    if (field) tries.push(['placeholder', () => squash(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'))]);
    tries.push(['described', () => { const t = idsText(el.getAttribute('aria-describedby')); return t.length <= 80 ? t : ''; }]);
    if (!field || el.tagName === 'BUTTON') tries.push(['icon', () => iconOf(el)]);
    // A link's address says more than its id or classes; a button's id or classes ("search-btn") may.
    if (el.tagName === 'A' || el.getAttribute('role') === 'link') tries.push(['address', () => linkWords(el.getAttribute('href'), location.href)]);
    tries.push(['name', () => words(el.getAttribute('name') || '') || words(el.id || '')]);
    if (!field) tries.push(['class', () => words(String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').split(/\s+/).filter((c) => !/^(css|sc|jsx|emotion)-/.test(c)).slice(0, 3).join(' '))]);
    for (const [from, fn] of tries) {
      let said = '';
      try { said = fn(); } catch (_) { said = ''; }
      if (said && !symbolOnly(said)) return { name: said.slice(0, 80), from };
    }
    return null;
  }

  function fixLabels() {
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (seen.has(el)) continue;
      if (el.closest('[aria-hidden="true"]') || !rendered(el)) continue; // looked at again once it shows
      seen.add(el);
      if (nameOf(el)) continue;
      const guess = guessName(el);
      if (!guess) continue;
      set(el, 'aria-label', guess.name);
      set(el, `${MARK}-label`, `guessed:${guess.from}`);
      if (!el.hasAttribute('aria-description') && !el.hasAttribute('aria-describedby')) set(el, 'aria-description', 'Label guessed by Jarvis');
      counts.labels += 1;
    }
  }

  function fixImages() {
    for (const img of document.querySelectorAll('img:not([alt])')) {
      if (seen.has(img)) continue;
      if (!img.complete && !img.getAttribute('width')) continue; // its size isn't known yet
      seen.add(img);
      if (squash(img.getAttribute('aria-label')) || img.getAttribute('aria-labelledby') || img.getAttribute('aria-hidden') === 'true') continue;
      const r = img.getBoundingClientRect();
      const w = Number(img.getAttribute('width')) || r.width || img.naturalWidth;
      const h = Number(img.getAttribute('height')) || r.height || img.naturalHeight;
      const role = img.getAttribute('role');
      const holder = img.closest('a[href], button, [role="button"], [role="link"]');
      const holderSays = holder && squash(holder.textContent).length > 1;
      if ((w && w <= 3) || (h && h <= 3) || role === 'presentation' || role === 'none' || holderSays) {
        set(img, 'aria-hidden', 'true');
        set(img, `${MARK}-alt`, 'decorative');
        counts.decorative += 1;
        continue;
      }
      const figure = img.closest('figure');
      const caption = figure && figure.querySelector('figcaption');
      const src = img.currentSrc || img.getAttribute('src') || '';
      const from = [
        ['title', squash(img.title)],
        ['caption', caption ? squash(caption.textContent).slice(0, 150) : ''],
        ['file', /^data:/.test(src) ? '' : words(src.split('/').pop())],
      ].find(([, said]) => said);
      if (!from) continue;
      set(img, 'alt', from[1]);
      set(img, `${MARK}-alt`, `guessed:${from[0]}`);
      counts.images += 1;
    }
  }

  // ── headings and landmarks ──

  const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  function levelNow(el) {
    const aria = Number(el.getAttribute('aria-level'));
    if (aria >= 1 && aria <= 9) return aria;
    const m = /^H([1-6])$/.exec(el.tagName);
    return m ? Number(m[1]) : 2;
  }
  const textSize = (el) => parseFloat(getComputedStyle(el).fontSize) || 16;

  // The element that holds a block's words, following lone children ("<div><span>Hi</span></div>").
  function holderOf(el) {
    let n = el;
    for (let i = 0; i < 6; i++) {
      const kids = [...n.children].filter((c) => squash(c.textContent));
      if (kids.length !== 1 || squash(kids[0].textContent) !== squash(n.textContent)) break;
      n = kids[0];
    }
    return n;
  }

  // Big bold lines that read as headings but aren't marked as ones.
  function findFakeHeadings(base, known) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n = walker.nextNode();
    let looked = 0;
    while (n && looked < MAX_SCAN) {
      const el = n;
      n = walker.nextNode();
      if (scanned.has(el)) continue;
      looked += 1;
      const tag = el.tagName;
      if (!/^(DIV|SPAN|P|B|STRONG|FONT|TD|TH|DT|LEGEND|CENTER)$/.test(tag)) continue;
      const text = squash(el.textContent);
      if (text.length < 2 || text.length > 90) { if (text.length > 90) scanned.add(el); continue; }
      scanned.add(el);
      if (el.getAttribute('role') || el.closest(`${HEADINGS}, button, label, nav, footer, [role="navigation"], [role="button"], [role="dialog"], [role="alert"], [${MARK}-hidden], [aria-hidden="true"], table[role="presentation"]`)) continue;
      if (el.closest(`[${MARK}-heading]`) || el.querySelector(`${HEADINGS}, input, select, textarea, button, img, p, li`)) continue;
      const linked = el.closest('a');
      if (linked) continue;
      const links = el.querySelectorAll('a');
      if (links.length > 1) continue;
      if (/^[\d\s$€£¥₹.,:;%+\-/()]+$/.test(text) || /^[$€£¥₹]\s?\d/.test(text) || /\d\s?[$€£¥₹]$/.test(text) || /[.!?,;]\s+\S/.test(text.slice(0, -1))) continue;
      // Something to press drawn big and bold (a "button" made of a div) is no heading.
      if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) continue;
      const style = getComputedStyle(el);
      if (!/^(block|flex|grid|list-item|table-cell|flow-root)$/.test(style.display) || style.cursor === 'pointer') continue;
      const holder = holderOf(el);
      const hs = getComputedStyle(holder);
      const size = parseFloat(hs.fontSize) || 16;
      const weight = Number(hs.fontWeight) || (hs.fontWeight === 'bold' ? 700 : 400);
      const big = size >= base * 1.3 || (weight >= 600 && size >= base * 1.15);
      if (!big || !rendered(el) || !shows(holder)) continue;
      const level = levelForSize(size, base, known);
      set(el, 'role', 'heading');
      set(el, 'aria-level', String(level));
      set(el, `${MARK}-heading`, 'made');
      levelWas.set(el, level);
      counts.headings += 1;
    }
  }

  function fixHeadings() {
    const base = textSize(document.body);
    const real = [...document.querySelectorAll(HEADINGS)].filter((h) => !h.hasAttribute(`${MARK}-heading`));
    const known = [];
    for (const h of real) {
      if (!levelWas.has(h)) levelWas.set(h, levelNow(h));
      if (/^H[1-6]$/.test(h.tagName) && shows(h)) known.push({ level: levelWas.get(h), size: textSize(h) });
    }
    if (counts.headings < 80) findFakeHeadings(base, known);
    const all = [...document.querySelectorAll(HEADINGS)].filter((h) => levelWas.has(h) && shows(h) && squash(h.textContent));
    if (!all.length) return;
    // A page with no level 1: its biggest heading in the main part (the first of the biggest) is.
    let top = null;
    const hasOne = all.some((h) => levelWas.get(h) === 1 && !h.hasAttribute(`${MARK}-h1`));
    if (!hasOne) {
      const main = document.querySelector('main, [role="main"]');
      const pool = (main ? all.filter((h) => main.contains(h)) : []).length ? all.filter((h) => main.contains(h)) : all;
      for (const h of pool.slice(0, 12)) if (!top || textSize(h) > textSize(top) + 0.5) top = h;
    }
    const was = all.map((h) => (h === top ? 1 : levelWas.get(h)));
    const now = closeGaps(was);
    all.forEach((h, i) => {
      const own = levelWas.get(h);
      if (h.hasAttribute(`${MARK}-heading`)) { // one of ours: its level is ours to set
        if (now[i] !== levelNow(h)) set(h, 'aria-level', String(now[i]));
        if (h === top) { set(h, `${MARK}-h1`, 'made'); counts.h1 = 1; }
        return;
      }
      if (now[i] !== own) {
        if (!ariaWas.has(h)) ariaWas.set(h, h.getAttribute('aria-level'));
        if (now[i] !== levelNow(h)) set(h, 'aria-level', String(now[i]));
        if (h === top) { set(h, `${MARK}-h1`, 'made'); counts.h1 = 1; } else if (!levelFixed.has(h)) { levelFixed.add(h); counts.levels += 1; }
      } else if (ariaWas.has(h) && levelNow(h) !== own) { // a fix the page no longer needs
        const page = ariaWas.get(h);
        if (page === null) unset(h, 'aria-level'); else set(h, 'aria-level', page);
        unset(h, `${MARK}-h1`);
      }
    });
  }

  const MAIN_GUESS = '#main, #content, #main-content, #maincontent, #primary, #page-content, .main-content, .page-content, #mainContent, .site-content, #site-content, #contents';
  function fixLandmarks() {
    if (!document.querySelector('main, [role="main"]')) {
      let main = [...document.querySelectorAll(MAIN_GUESS)].find((n) => rendered(n) && !n.closest('header, nav, footer, aside') && !n.querySelector('header, nav[role], footer') && squash(n.textContent).length > 40);
      if (!main) {
        const articles = [...document.querySelectorAll('article')].filter(rendered);
        if (articles.length === 1) main = articles[0];
      }
      if (!main) {
        const h1 = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')].find((h) => rendered(h) && !h.closest('header, nav, footer, aside, [role="banner"]'));
        let n = h1 ? h1.parentElement : null;
        while (n && n.parentElement && n.parentElement !== document.body && !n.parentElement.querySelector('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) n = n.parentElement;
        if (n && n !== document.body && !n.querySelector('nav, header, footer')) main = n;
      }
      if (main) {
        set(main, 'role', 'main');
        set(main, `${MARK}-landmark`, 'main');
        counts.landmarks += 1;
      }
    }
    if (!document.querySelector('nav, [role="navigation"]')) {
      const picks = [];
      for (const n of document.querySelectorAll('[id*="nav" i], [class*="nav" i], [id*="menu" i], [class*="menu" i], header ul')) {
        if (picks.length >= 3) break;
        if (picks.some((p) => p.contains(n) || n.contains(p)) || n.closest('main, [role="main"], article') || n === document.body) continue;
        if (/^(A|BUTTON|LI|SPAN|I|SVG|IMG)$/i.test(n.tagName)) continue;
        const links = [...n.querySelectorAll('a[href]')].filter(rendered);
        if (links.length < 3 || !rendered(n)) continue;
        const text = squash(n.textContent);
        const linkText = links.reduce((sum, a) => sum + squash(a.textContent).length, 0);
        if (!text || linkText / text.length < 0.6) continue;
        picks.push(n);
      }
      for (const n of picks) {
        set(n, 'role', 'navigation');
        set(n, `${MARK}-landmark`, 'navigation');
        counts.landmarks += 1;
      }
    }
  }

  // ── cookie banners and overlays ──

  const OVERLAY_GUESS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="cmp" i], [class*="cmp-" i], [id*="onetrust" i], [id*="Cookiebot" i], [id*="didomi" i], [id*="usercentrics" i], [id^="sp_message_container"], [class*="fc-consent" i], [id*="truste" i], [class*="modal" i], [class*="popup" i], [id*="popup" i], [class*="newsletter" i], [id*="newsletter" i], [class*="overlay" i], [class*="lightbox" i], [class*="klaviyo" i], [class*="privy" i], [class*="optin" i], [class*="signup" i]';

  // The outermost box an overlay is drawn in: the element itself, or the fixed one around it.
  function overlayRoot(el) {
    let n = el;
    let found = null;
    for (let i = 0; n && n !== document.body && n !== document.documentElement && i < 8; i++, n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') found = n;
    }
    return found;
  }
  function covers(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return innerWidth && innerHeight ? (w * h) / (innerWidth * innerHeight) : 0;
  }
  // The buttons in a box, its open shadow roots too (Usercentrics draws there).
  function buttonsIn(root) {
    const out = [];
    const sel = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
    const walk = (r, depth) => {
      if (!r || depth > 3) return;
      out.push(...r.querySelectorAll(sel));
      for (const host of r.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot, depth + 1);
    };
    if (root.shadowRoot) walk(root.shadowRoot, 0);
    walk(root, 0);
    return out;
  }
  function textIn(root) {
    let text = root.innerText || root.textContent || '';
    if (root.shadowRoot) text += ` ${root.shadowRoot.textContent || ''}`;
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) text += ` ${host.shadowRoot.textContent || ''}`;
    return squash(text);
  }
  const buttonWords = (b) => squash(b.getAttribute('aria-label') || b.innerText || b.textContent || b.value || b.title);
  // Whether pressing it can only close something: no form sent, no other page opened, no
  // words that buy or sign in.
  function safeToPress(b) {
    const words = `${buttonWords(b)} ${b.title || ''}`;
    if (NEVER.test(words)) return false;
    if (b.tagName === 'A') {
      const href = (b.getAttribute('href') || '').trim();
      if (href && !/^(#|javascript:)/i.test(href)) return false;
    }
    const type = (b.getAttribute('type') || '').toLowerCase();
    const form = b.form || (b.closest && b.closest('form'));
    if (form && (b.tagName === 'INPUT' ? type === 'submit' : (b.tagName === 'BUTTON' && (type === '' || type === 'submit')))) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function hideOverlay(root, kind) {
    set(root, `${MARK}-hidden`, kind);
    set(root, 'aria-hidden', 'true');
    // Its backdrop: an empty box over the whole page beside it.
    const parent = root.parentElement;
    for (const sib of parent ? parent.children : []) {
      if (sib === root || sib.hasAttribute(`${MARK}-hidden`)) continue;
      const pos = getComputedStyle(sib).position;
      if ((pos === 'fixed' || pos === 'absolute') && covers(sib) > 0.8 && !squash(sib.textContent)) set(sib, `${MARK}-hidden`, 'backdrop');
    }
  }

  // The page scrolls again, and what the overlay hid from the screen reader shows again.
  function freePage() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const s = getComputedStyle(el);
      if (s.overflow === 'hidden' || s.overflowY === 'hidden' || (el === document.body && s.position === 'fixed')) {
        set(el, `${MARK}-scroll`, el === document.body && s.position === 'fixed' ? 'fixed' : 'on');
        counts.scroll = 1;
      }
    }
    // (Only what is on screen: a menu kept off to the side stays hidden, as the page meant.)
    for (const kid of document.body ? document.body.children : []) {
      if (kid.hasAttribute(`${MARK}-hidden`) || !(kid.getAttribute('aria-hidden') === 'true' || kid.hasAttribute('inert'))) continue;
      if (squash(kid.textContent).length <= 40 || !rendered(kid)) continue;
      const r = kid.getBoundingClientRect();
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth) continue;
      unset(kid, 'aria-hidden');
      unset(kid, 'inert');
    }
  }

  const INLINE_CONSENT = '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [id*="onetrust" i], [id*="Cookiebot" i], [id*="didomi" i]';
  function refuseInline(el) {
    if (!shows(el)) return;
    const text = textIn(el);
    if (text.length > 1500 || overlayKind(text) !== 'consent') return;
    const press = buttonsIn(el).filter(safeToPress).find((b) => rejectWords(buttonWords(b)));
    if (!press) return;
    set(el, `${MARK}-banner`, 'rejected');
    try { press.click(); } catch (_) { /* the page's own handler threw */ }
    counts.rejected += 1;
    counts.banners += 1;
  }

  function fixOverlays() {
    const now = Date.now();
    const roots = new Set();
    for (const el of document.querySelectorAll(OVERLAY_GUESS)) {
      if (el.closest(`[${MARK}-hidden]`)) continue;
      const root = overlayRoot(el) || (el.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]') ? el : null);
      if (root && !root.hasAttribute(`${MARK}-hidden`) && !root.hasAttribute(`${MARK}-banner`)) roots.add(root);
      // A cookie banner in the page's own flow (at its top, not over it): its reject button is
      // pressed; it is never hidden (it may be the page itself: a privacy page's settings).
      else if (!root && el.matches(INLINE_CONSENT) && !el.hasAttribute(`${MARK}-banner`) && !el.closest(`[${MARK}-banner]`)) refuseInline(el);
    }
    let freed = false;
    for (const root of roots) {
      if (!shows(root)) continue;
      if (!firstSeen.has(root)) firstSeen.set(root, { at: now, owners: now - lastGesture < GESTURE_MS });
      const text = textIn(root);
      const kind = overlayKind(text, { email: Boolean(root.querySelector('input[type="email"], input[name*="email" i]')), covers: covers(root) });
      if (!kind) continue;
      if (kind !== 'consent' && firstSeen.get(root).owners) continue; // the owner opened it
      if (kind === 'wall' && root.querySelector('input[type="password"]') && firstSeen.get(root).owners) continue;
      const buttons = buttonsIn(root).filter(safeToPress);
      const press = kind === 'consent'
        ? buttons.find((b) => rejectWords(buttonWords(b)))
        : buttons.find((b) => closeWords(buttonWords(b)) || /^(close|dismiss)\b/i.test(squash(b.getAttribute('aria-label') || b.title)));
      if (press) {
        set(root, `${MARK}-banner`, kind === 'consent' ? 'rejected' : 'closed');
        try { press.click(); } catch (_) { /* the page's own handler threw */ }
        counts[kind === 'consent' ? 'rejected' : 'closed'] += 1;
        counts.banners += 1;
        // A banner still there a moment later is hidden after all.
        setTimeout(() => { if (on && root.isConnected && shows(root)) { hideOverlay(root, kind); freePage(); count(); } }, 700);
      } else {
        set(root, `${MARK}-banner`, 'hidden');
        hideOverlay(root, kind);
        freePage();
        counts.banners += 1;
      }
      freed = true;
    }
    if (freed) { closedAny = true; setTimeout(() => { if (on) { freePage(); count(); } }, 150); }
    // A page that locks itself again a moment after its overlay went (or hid the rest from
    // the screen reader late) is freed again, unless a dialog is open now.
    else if (closedAny && ![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')].some((d) => !d.closest(`[${MARK}-hidden]`) && shows(d))) freePage();
  }

  // ── passes ──

  function count() {
    const html = document.documentElement;
    const total = counts.labels + counts.images + counts.decorative + counts.headings + counts.levels + counts.h1 + counts.landmarks + counts.banners + counts.scroll;
    html.setAttribute(MARK, 'on');
    html.setAttribute(`${MARK}-fixed`, String(total));
    html.setAttribute(`${MARK}-counts`, Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '));
  }

  function pass() {
    if (!on || !document.body) return;
    lastPass = Date.now();
    for (const step of [fixOverlays, fixImages, fixLabels, fixLandmarks, fixHeadings]) {
      try { step(); } catch (err) { /* one step failing leaves the others */ }
    }
    count();
  }
  // As the page changes: at most one pass every half second.
  // A page that keeps changing long after it loaded (a feed, a ticker) is looked at less often.
  function soon() {
    if (!on || timer) return;
    const every = Date.now() - startedAt < 10000 ? 500 : 1500;
    const wait = Math.max(120, every - (Date.now() - lastPass));
    timer = setTimeout(() => { timer = 0; pass(); }, wait);
  }

  function start() {
    startedAt = Date.now();
    const go = () => {
      // The app's own stylesheet, once the page's document is there (one put in before it may
      // go with the empty document a navigation starts from).
      if (cssKey === null) { try { cssKey = webFrame.insertCSS(STYLE, { cssOrigin: 'user' }); } catch (_) { cssKey = ''; } }
      pass();
      if (!observer && document.documentElement) {
        observer = new MutationObserver(soon);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      for (const ms of [1200, 3000, 6000]) setTimeout(() => { if (on) pass(); }, ms);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }

  // Everything put back as the page had it (what was pressed stays pressed).
  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(timer);
    timer = 0;
    for (let i = changes.length - 1; i >= 0; i--) {
      const { el, attr, was } = changes[i];
      try { if (was === null) el.removeAttribute(attr); else el.setAttribute(attr, was); } catch (_) { /* gone */ }
    }
    changes.length = 0;
    if (cssKey) { try { webFrame.removeInsertedCSS(cssKey); } catch (_) { /* gone */ } }
    cssKey = null;
    for (const key of Object.keys(counts)) counts[key] = 0;
    closedAny = false;
    seen = new WeakSet(); // looked at afresh if the mode comes back
    scanned = new WeakSet();
    const html = document.documentElement;
    if (html) for (const attr of [MARK, `${MARK}-fixed`, `${MARK}-counts`]) html.removeAttribute(attr);
  }

  function setMode(want) {
    want = Boolean(want);
    if (want === on) return;
    on = want;
    if (on) start(); else stop();
  }

  // ── what's on this page (page_summary) ──

  const LANDMARKS = [
    ['main, [role="main"]', 'main'], ['nav, [role="navigation"]', 'navigation'], ['[role="search"], search', 'search'],
    ['header, [role="banner"]', 'banner'], ['footer, [role="contentinfo"]', 'contentinfo'], ['aside, [role="complementary"]', 'complementary'],
    ['form[aria-label], form[aria-labelledby], [role="form"]', 'form'], ['section[aria-label], section[aria-labelledby], [role="region"]', 'region'],
  ];
  function landmarkLabel(el) { return squash(el.getAttribute('aria-label')) || idsText(el.getAttribute('aria-labelledby')); }

  function summary({ limit = 800 } = {}) {
    const out = { ok: true, url: location.href, title: squash(document.title).slice(0, 300), lang: document.documentElement.lang || '' };
    const landmarks = [];
    for (const [sel, role] of LANDMARKS) {
      for (const el of document.querySelectorAll(sel)) {
        if (landmarks.length >= 30 || !shows(el)) continue;
        // A header or footer inside an article or section is no landmark.
        if ((role === 'banner' || role === 'contentinfo') && el.matches('header, footer') && !el.getAttribute('role') && el.closest('article, aside, main, nav, section')) continue;
        landmarks.push({ role, label: landmarkLabel(el).slice(0, 80) });
      }
    }
    out.landmarks = landmarks;
    out.headings = [...document.querySelectorAll(HEADINGS)].filter((h) => shows(h) && squash(h.textContent)).slice(0, 80)
      .map((h) => ({ level: levelNow(h), text: squash(h.innerText || h.textContent).slice(0, 120) }));
    const visible = (sel) => [...document.querySelectorAll(sel)].filter(shows);
    const imgs = visible('img, [role="img"], svg[role="img"]');
    out.counts = {
      links: visible('a[href], [role="link"]').length,
      buttons: visible('button, [role="button"], input[type="submit"], input[type="button"]').length,
      forms: visible('form').length,
      fields: visible('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').length,
      images: imgs.filter((i) => i.getAttribute('aria-hidden') !== 'true').length,
      unlabeled: imgs.filter((i) => i.getAttribute('aria-hidden') !== 'true' && !squash(i.getAttribute('alt')) && !squash(i.getAttribute('aria-label')) && !i.getAttribute('aria-labelledby') && i.getAttribute('alt') !== '').length,
      tables: visible('table:not([role="presentation"])').length,
    };
    const dialogs = visible('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]').filter((d) => !d.closest(`[${MARK}-hidden]`));
    out.dialogs = dialogs.slice(0, 3).map((d) => landmarkLabel(d) || squash(d.innerText).slice(0, 100));
    const main = document.querySelector('main, [role="main"]') || document.querySelector('article') || document.body;
    let text = '';
    if (main) {
      try {
        text = typeof globalThis.jarvisSight === 'function' ? globalThis.jarvisSight().text(main, Math.max(200, limit) * 3) : main.innerText;
      } catch (_) { text = main.innerText || ''; }
    }
    const max = Math.max(200, Math.min(4000, Number(limit) || 800));
    const squashed = squash(text);
    out.start = squashed.slice(0, max);
    out.more = squashed.length > max;
    if (on) out.fixed = { ...counts };
    return out;
  }

  // ── the app ──

  window.addEventListener('pointerdown', (e) => { if (e.isTrusted) lastGesture = Date.now(); }, true);
  window.addEventListener('keydown', (e) => { if (e.isTrusted) lastGesture = Date.now(); }, true);

  const COMMANDS = {
    summary: (args) => summary(args),
    stats: () => ({ ok: true, on, counts: { ...counts }, changes: changes.length }),
    pass: () => { pass(); return { ok: true, on, counts: { ...counts } }; },
  };
  ipcRenderer.on('page-a11y:command', async (_event, message) => {
    const { id, action, args } = message || {};
    let result;
    try {
      const fn = COMMANDS[action];
      result = fn ? await fn(args || {}) : { ok: false, message: `Unknown command ${action}` };
    } catch (err) {
      result = { ok: false, message: String(err && err.message ? err.message : err) };
    }
    ipcRenderer.send('page-a11y:result', { id, result });
  });
  ipcRenderer.on('page-a11y:mode', (_event, value) => setMode(value));
  let first = false;
  try { first = Boolean(ipcRenderer.sendSync('page-a11y:start')); } catch (_) { first = false; }
  setMode(first);
})();
