// JARVIS's reading of a page in the built-in browser, for the browser-ai feature
// (app/features/browser-ai.js registers it for the browser's tabs; it runs in each tab's main
// frame, in the same isolated world as page-preload.js, so the page's own scripts can't see
// or reach it):
// - context: the page's address, title and what the owner has selected, and its readable
//   text when asked;
// - extract: the page's article, the way a reader view finds it (Readability-like: the
//   block with the most prose and the fewest links), as headings and paragraphs;
// - imageAt: the picture under the pointer (the page's menu), its box and its words;
// - handback: whether the page needs the owner (a captcha, a password, a one-time code, a
//   sign-in wall);
// - mainPrice: the page's own price, as a shop shows it (page watchers);
// - record: the owner's clicks and typing in this tab, told as steps while it's on (record
//   and replay), never a password, a card or a code; probe: whether what a step pressed or
//   typed into is still on the page (replay's check before each step).
// Text no one can see is left out, weighed as page-preload.js weighs it for every read
// (globalThis.jarvisSight). Nothing here changes the page.
'use strict';

(() => {
  const { ipcRenderer } = require('electron');

  const MAX_BLOCKS = 400;
  const MAX_TEXT = 100000;
  const SELECTION_MAX = 8000;
  const GOOD = /article|body|content|entry|main|page|post|text|blog|story|prose|recipe|column/i;
  const BAD = /comment|meta|foot|footnote|sidebar|sponsor|\bads?\b|ad-|advert|share|social|related|promo|nav|menu|header|breadcrumb|widget|subscribe|newsletter|popup|modal|cookie|banner|masthead|outbrain|taboola|disqus|signup|login|rail|toolbar|pagination|tags?\b|byline-?share/i;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'ASIDE', 'FOOTER', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'JARVIS-HAND', 'JARVIS-MARKS', 'JARVIS-READER', 'DIALOG']);
  const BLOCKS = { H1: 'h', H2: 'h', H3: 'h', H4: 'h', H5: 'h', H6: 'h', P: 'p', LI: 'li', BLOCKQUOTE: 'quote', PRE: 'pre', FIGCAPTION: 'caption', DT: 'p', DD: 'p', TD: 'p' };
  const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

  // The read's judge of what shows (page-preload.js); without it, the element's own words.
  function judge() {
    if (typeof globalThis.jarvisSight === 'function') return globalThis.jarvisSight();
    return { shows: () => true, textShows: () => true, text: (el, max = MAX_TEXT) => String((el && el.innerText) || '').slice(0, max) };
  }

  function meta(...names) {
    for (const name of names) {
      const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`);
      const value = el && squash(el.getAttribute('content'));
      if (value) return value.slice(0, 300);
    }
    return '';
  }

  function linkDensity(el, sight, length) {
    if (!length) return 0;
    let linked = 0;
    for (const a of el.querySelectorAll('a')) linked += squash(sight.text(a, 2000)).length;
    return Math.min(1, linked / length);
  }

  function weightOf(el) {
    const words = `${el.className && typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
    let w = 0;
    if (GOOD.test(words)) w += 25;
    if (BAD.test(words)) w -= 25;
    if (el.tagName === 'ARTICLE' || el.tagName === 'MAIN') w += 30;
    return w;
  }

  // The element holding the page's article: paragraphs score their parent (and half their
  // grandparent) by length and commas; links and navigation-like names count against it.
  function mainBlock(sight) {
    const scores = new Map();
    const add = (el, n) => { if (el && el !== document.documentElement) scores.set(el, (scores.get(el) || 0) + n); };
    let seen = 0;
    for (const p of document.querySelectorAll('p, pre, td, blockquote, li')) {
      if (++seen > 4000) break;
      if (p.closest('nav, aside, footer, form, header, [role="navigation"], [role="complementary"], [aria-hidden="true"]')) continue;
      if (!sight.shows(p)) continue;
      const text = squash(sight.text(p, 4000));
      if (text.length < 25) continue;
      const score = 1 + (text.match(/[,，、]/g) || []).length + Math.min(3, Math.floor(text.length / 100));
      add(p.parentElement, score);
      add(p.parentElement && p.parentElement.parentElement, score / 2);
    }
    let best = null;
    let bestScore = 0;
    for (const [el, raw] of scores) {
      const length = squash(sight.text(el, 20000)).length;
      const score = (raw + weightOf(el)) * (1 - linkDensity(el, sight, length));
      if (score > bestScore) { best = el; bestScore = score; }
    }
    // A page's one <article> with plenty in it is the article itself (several are a feed).
    const articles = [...document.querySelectorAll('article')].filter((a) => sight.shows(a));
    if (articles.length === 1 && squash(sight.text(articles[0], 5000)).length > 500) return articles[0];
    return best;
  }

  // The article's headings and paragraphs, in order, each once.
  function blocksOf(root, sight) {
    const out = [];
    let length = 0;
    const walk = (el) => {
      if (out.length >= MAX_BLOCKS || length >= MAX_TEXT) return;
      if (SKIP.has(el.tagName) || !sight.shows(el)) return;
      const kind = BLOCKS[el.tagName];
      if (kind && !(kind === 'p' && el.querySelector('p, li, h1, h2, h3, pre, blockquote'))) {
        const text = kind === 'pre' ? String(sight.text(el, 8000)).trim() : squash(sight.text(el, 8000));
        if (text && !(kind !== 'h' && text.length < 3)) {
          const links = kind === 'p' || kind === 'li' ? linkDensity(el, sight, text.length) : 0;
          if (links < 0.6 || text.length > 200) {
            out.push({ kind, text });
            length += text.length;
          }
        }
        return;
      }
      if (/^(DIV|SECTION|ARTICLE|MAIN|SPAN|FIGURE|HEADER|CENTER|FONT)$/.test(el.tagName) && !el.querySelector('p, li, h1, h2, h3, h4, pre, blockquote, figcaption')) {
        const text = squash(sight.text(el, 8000)); // prose straight in a <div>
        if (text.length >= 40 && linkDensity(el, sight, text.length) < 0.5) { out.push({ kind: 'p', text }); length += text.length; }
        return;
      }
      if (el.tagName !== 'ARTICLE' && el !== root && BAD.test(`${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`) && !GOOD.test(`${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`)) return;
      for (const kid of el.children) walk(kid);
    };
    walk(root);
    return out;
  }

  function titleOf(blocks) {
    const og = meta('og:title', 'twitter:title');
    if (og) return og;
    const h1 = document.querySelector('h1');
    const heading = h1 ? squash(h1.innerText) : '';
    if (heading && heading.length < 300) return heading;
    return squash(document.title).replace(/\s+[|·–—-]\s+[^|·–—-]{2,40}$/, '') || (blocks[0] && blocks[0].kind === 'h' ? blocks[0].text : '');
  }

  function bylineOf() {
    const by = meta('author', 'article:author', 'byl');
    if (by && !/^https?:/.test(by)) return by.replace(/^by\s+/i, '');
    const el = document.querySelector('[rel="author"], [itemprop="author"], .byline, .author, [class*="byline"]');
    const text = el ? squash(el.innerText) : '';
    return text && text.length < 120 ? text.replace(/^by\s+/i, '') : '';
  }

  function extract(args = {}) {
    const sight = judge();
    const root = mainBlock(sight);
    let blocks = root ? blocksOf(root, sight) : [];
    const prose = blocks.filter((b) => b.kind !== 'h').reduce((n, b) => n + b.text.length, 0);
    const article = prose >= 400 && blocks.filter((b) => b.kind === 'p').length >= 2;
    if (!article) {
      // No article to speak of (a search page, a shop's grid): the page's visible text.
      const main = document.querySelector('main') || document.body;
      const text = main ? String(sight.text(main, MAX_TEXT)) : '';
      blocks = text.split(/\n{2,}|\n/).map(squash).filter(Boolean).slice(0, MAX_BLOCKS).map((t) => ({ kind: 'p', text: t }));
    }
    const title = titleOf(blocks);
    if (blocks[0] && blocks[0].kind === 'h' && squash(blocks[0].text) === title) blocks = blocks.slice(1);
    let text = blocks.map((b) => (b.kind === 'h' ? `## ${b.text}` : b.kind === 'li' ? `- ${b.text}` : b.text)).join('\n\n');
    const limit = Math.max(1000, Math.min(MAX_TEXT, Number(args.limit) || MAX_TEXT));
    const more = text.length > limit;
    text = text.slice(0, limit);
    return {
      ok: true, url: location.href, title, byline: bylineOf(), site: meta('og:site_name', 'application-name'),
      lang: (document.documentElement.lang || '').slice(0, 20), published: meta('article:published_time', 'datePublished', 'date'),
      article, blocks: args.blocks === false ? undefined : blocks, text, more, words: text.split(/\s+/).filter(Boolean).length,
    };
  }

  // What the owner has selected, as it shows: text hidden inside the selection stays out.
  function selectionText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      if (active.type === 'password') return '';
      const value = String(active.value || '').slice(active.selectionStart || 0, active.selectionEnd || 0);
      return squash(value).slice(0, SELECTION_MAX);
    }
    const sight = judge();
    const parts = [];
    let length = 0;
    for (let i = 0; i < selection.rangeCount && length < SELECTION_MAX; i += 1) {
      const range = selection.getRangeAt(i);
      const root = range.commonAncestorContainer;
      if (root.nodeType === 3) {
        if (sight.textShows(root)) parts.push(root.data.slice(range.startOffset, range.endOffset));
        continue;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && length < SELECTION_MAX; node = walker.nextNode()) {
        if (!range.intersectsNode(node) || !node.data.trim()) continue;
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || !sight.textShows(node)) continue;
        let piece = node.data;
        if (node === range.endContainer) piece = piece.slice(0, range.endOffset);
        if (node === range.startContainer) piece = piece.slice(range.startOffset);
        parts.push(piece);
        length += piece.length;
      }
    }
    return squash(parts.join(' ')).slice(0, SELECTION_MAX);
  }

  function context(args = {}) {
    const out = { ok: true, url: location.href, title: document.title.slice(0, 300), selection: selectionText(), lang: (document.documentElement.lang || '').slice(0, 20) };
    if (args.text) {
      const page = extract({ limit: args.limit, blocks: false });
      Object.assign(out, { text: page.text, more: page.more, article: page.article, byline: page.byline, site: page.site });
    }
    return out;
  }

  // The picture under the owner's pointer (the page's menu: Ask Jarvis): its box on the page
  // and its words, for the app to take a picture of it.
  function imageAt(args = {}) {
    const hit = document.elementFromPoint(Number(args.x) || 0, Number(args.y) || 0);
    let el = hit && (hit.closest('img, picture, svg, canvas, video') || null);
    if (el && el.tagName === 'PICTURE') el = el.querySelector('img') || el;
    if (!el && hit && hit.querySelector) el = hit.querySelector('img');
    if (!el) return { ok: false, message: 'There is no picture there.' };
    const r = el.getBoundingClientRect();
    const alt = squash(el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 300);
    return { ok: true, box: { x: r.left, y: r.top, width: r.width, height: r.height }, scroll: { x: window.scrollX, y: window.scrollY }, alt };
  }

  // Where the page needs the owner, not JARVIS (hand back): a captcha (JARVIS never tries
  // one), a password, card details, a one-time code (codes: whether JARVIS may type those),
  // or a wall that asks to sign in first. Only what shows counts: a field hidden from view, a sliver,
  // or an invisible reCAPTCHA's badge doesn't.
  const CAPTCHA_FRAME = /(?:google\.com|recaptcha\.net)\/recaptcha\/|hcaptcha\.com\/|challenges\.cloudflare\.com\/|arkoselabs\.com\/|funcaptcha\.com\/|geetest\.com\/|captcha-delivery\.com\/|perimeterx\.net\//i;
  const CAPTCHA_BOX = '.g-recaptcha:not(.grecaptcha-badge), .h-captcha, .cf-turnstile, #px-captcha, .geetest_holder, #FunCaptcha, #arkose-iframe, [data-hcaptcha-widget-id]';
  const CHALLENGE = /verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|i'?m not a robot|checking if the site connection is secure|checking your browser before accessing|press (?:&|and) hold|complete the security check|solve (?:this|the) (?:puzzle|captcha)|人机验证|我不是机器人|请完成安全验证|验证您是真人|拖动滑块/i;
  const CODE_WORDS = /\b(?:otp|2fa|mfa|totp|one[\s-]?time[\s-]?(?:pass)?code|verification[\s-]?code|security[\s-]?code|auth(?:entication|enticator)?[\s-]?code|sms[\s-]?code|6[\s-]?digit)\b|验证码|动态码|校验码/i;
  const CARD_WORDS = /\bcard[\s-]?(?:number|no\b)|\bcardnumber\b|\bcvv2?\b|\bcvc\b|\bcsc\b|\bexpir(?:y|ation)\b|信用卡|银行卡号|卡号|安全码/i;
  const LOGIN_WALL = /\b(?:sign|log)\s?in\b[^.!?\n]{0,40}?\bto (?:continue|view|see|read|access|keep reading|comment|proceed|watch|download)\b|\byou(?:'ll)? (?:need|have|must) (?:to )?(?:be )?(?:sign(?:ed)?|log(?:ged)?)\s?in\b|\bplease (?:sign|log)\s?in\b|\bsign in required\b|登录后(?:继续|查看|阅读|才能|可)|请先登录|需要登录|登录以继续/i;
  const seenBox = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight * 3;
  };
  function handback(args = {}) {
    const sight = judge();
    const shows = (el) => sight.shows(el) && seenBox(el);
    const none = { ok: true, kind: '' };
    for (const frame of document.querySelectorAll('iframe')) {
      const src = String(frame.src || frame.getAttribute('src') || '');
      if (CAPTCHA_FRAME.test(src) && !/size=invisible/.test(src) && shows(frame)) return { ok: true, kind: 'captcha', what: 'a captcha' };
    }
    for (const el of document.querySelectorAll(CAPTCHA_BOX)) if (shows(el)) return { ok: true, kind: 'captcha', what: 'a captcha' };
    const text = document.body ? String(sight.text(document.body, 30000)) : '';
    if (CHALLENGE.test(text.slice(0, 6000))) return { ok: true, kind: 'captcha', what: 'a check that you are human' };
    const fields = [...document.querySelectorAll('input')].filter((i) => !i.disabled && shows(i));
    if (fields.some((i) => String(i.type).toLowerCase() === 'password')) return { ok: true, kind: 'password', what: 'a password' };
    const words = (i) => [i.name, i.id, i.getAttribute('aria-label'), i.placeholder, i.labels ? [...i.labels].map((l) => l.innerText).join(' ') : ''].filter(Boolean).join(' ');
    if (fields.some((i) => /^cc-/.test(String(i.autocomplete || '').toLowerCase()) || CARD_WORDS.test(words(i)))) return { ok: true, kind: 'card', what: 'your card details' };
    const coded = fields.some((i) => String(i.autocomplete || '').toLowerCase() === 'one-time-code' || CODE_WORDS.test(words(i)));
    const boxes = fields.filter((i) => String(i.getAttribute('maxlength')) === '1');
    if (!args.codes && (coded || boxes.length >= 4)) return { ok: true, kind: 'code', what: 'a one-time code' };
    if (text.length < 4000 && LOGIN_WALL.test(text)) return { ok: true, kind: 'login', what: 'signing in' };
    return none;
  }

  // The page's own price, as a shop shows it (page watchers: "when the price drops below"):
  // of the amounts in view near the top, the one in the biggest type. Its words before it
  // (anchor) find it again on the next look.
  const MONEY = /(?:[$€£¥₹₩]|US\$|CA\$|A\$|HK\$|S\$|R\$|CHF|USD|EUR|GBP|CNY|RMB|JPY)\s?\d(?:[\d,.']*\d)?|\d(?:[\d,.']*\d)?\s?(?:€|zł|kr|元|円|USD|EUR|GBP|CNY)/;
  function mainPrice() {
    const sight = judge();
    let best = null;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node && seen < 20000; node = walker.nextNode()) {
      seen += 1;
      const text = node.data;
      const m = text && MONEY.exec(text);
      if (!m) continue;
      const el = node.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|S|DEL|STRIKE)$/.test(el.tagName) || el.closest('s, del, strike, nav, footer') || !sight.textShows(node)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight * 2) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize) || 0;
      const score = size * 10 - r.top / 100;
      if (!best || score > best.score) {
        const block = el.closest('p, div, li, td, section, article') || el;
        const before = squash(String(block.innerText || '')).split(squash(m[0]))[0].slice(-40).trim();
        best = { score, text: squash(m[0]), anchor: before };
      }
    }
    return best ? { ok: true, text: best.text, anchor: best.anchor } : { ok: true, text: '' };
  }

  // ── recording (record and replay): the owner's clicks and typing, as steps ──
  // Only while the app says this tab records, only the owner's own input (isTrusted), and
  // never a secret: a password, a card, a one-time code is a step that says the owner types
  // there, without what they typed.
  let recording = false;
  const TEXT_TYPES = /^(?:text|search|email|url|tel|number|)$/;
  const PRESSABLE = 'a, button, summary, label, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], input';
  const quoted = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  function selectorFor(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && !/\d{4,}|^[a-f0-9-]{16,}$/i.test(el.id) && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value && value.length < 80 && unique(`${tag}[${attr}=${quoted(value)}]`)) return `${tag}[${attr}=${quoted(value)}]`;
    }
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body && parts.length < 6; node = node.parentElement) {
      if (node !== el && node.id && !/\d{4,}/.test(node.id) && unique(`#${CSS.escape(node.id)}`)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [node];
      parts.unshift(same.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})` : node.tagName.toLowerCase());
    }
    return parts.join(' > ').slice(0, 300);
  }
  const fieldOf = (el) => squash([el.labels ? [...el.labels].map((l) => l.innerText).join(' ') : '', el.getAttribute('aria-label'), el.placeholder, el.name].find(Boolean) || '').slice(0, 80);
  // What a press is called: a checkbox by its label, a submit input by its value, the rest
  // by the words on them.
  function wordsOf(el) {
    const type = String(el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && /^(?:checkbox|radio)$/.test(type)) return fieldOf(el);
    const value = el.tagName === 'INPUT' && /^(?:button|submit|reset)$/.test(type) ? el.value : '';
    return squash(el.getAttribute('aria-label') || el.innerText || value || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 120);
  }
  function secret(el) {
    const type = String(el.type || '').toLowerCase();
    const auto = String(el.autocomplete || '').toLowerCase();
    const digits = String(el.value || '').replace(/[\s-]/g, '');
    return type === 'password' || /^cc-|one-time-code/.test(auto) || CARD_WORDS.test(fieldOf(el)) || CODE_WORDS.test(fieldOf(el)) || /^\d{13,19}$/.test(digits);
  }
  const typable = (el) => el && ((el.tagName === 'INPUT' && TEXT_TYPES.test(String(el.type || '').toLowerCase())) || el.tagName === 'TEXTAREA' || el.isContentEditable || String(el.type || '').toLowerCase() === 'password');
  function step(s) {
    if (recording) ipcRenderer.send('page-ai:event', { kind: 'step', step: { ...s, url: location.href } });
  }
  // Enter in a box sends what's in it: the box's own change after that, and the click its
  // form gives its default button, are the same step, not new ones.
  let entered = { el: null, value: '', at: 0 };
  const valueOf = (el) => String(el.value !== undefined ? el.value : el.innerText || '');
  function typed(el, change = false, value = valueOf(el)) {
    if (change && entered.el === el && entered.value === value && Date.now() - entered.at < 5000) return;
    const base = { kind: 'type', selector: selectorFor(el), field: fieldOf(el) };
    step(secret(el) ? { ...base, secret: true } : { ...base, text: value.slice(0, 2000) });
  }
  document.addEventListener('click', (e) => {
    if (!recording || !e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target.closest(PRESSABLE) || e.target;
    if (typable(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return; // typing and choosing are their own steps
    if (el.tagName === 'LABEL' && el.control) return; // its box gets the click next (or only the focus)
    if (e.detail === 0 && entered.el && el.form && el.form === entered.el.form && Date.now() - entered.at < 1000) return;
    step({ kind: 'click', selector: selectorFor(el), text: wordsOf(el), tag: el.tagName.toLowerCase() });
  }, true);
  document.addEventListener('change', (e) => {
    if (!recording || !e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target;
    if (el.tagName === 'SELECT') {
      const chosen = el.selectedOptions && el.selectedOptions[0];
      step({ kind: 'select', selector: selectorFor(el), field: fieldOf(el), text: chosen ? squash(chosen.label || chosen.text).slice(0, 200) : '' });
    } else if (typable(el)) typed(el, true);
  }, true);
  // Enter in a one-line box sends it; in a box of many lines it's a new line (typing), unless
  // the page takes it to send (a chat's box): then it's a press too.
  function entering(el, value) {
    typed(el, false, value); // what's in the box first: Enter sends it before its change fires
    step({ kind: 'press', key: "Enter", selector: selectorFor(el) });
    entered = { el, value, at: Date.now() };
  }
  document.addEventListener('keydown', (e) => {
    if (!recording || !e.isTrusted || e.key !== "Enter" || e.shiftKey || !typable(e.target)) return; // (a key's name, not shown)
    const el = e.target;
    const value = valueOf(el);
    if (el.tagName === 'INPUT') entering(el, value);
    else setTimeout(() => { if (e.defaultPrevented) entering(el, value); }, 0); // (the page's own handlers first)
  }, true);
  function record(args = {}) {
    recording = Boolean(args.on);
    return { ok: true, recording, url: location.href, title: document.title.slice(0, 300) };
  }

  // ── replay: is what a step pressed, typed into or chose in still here? ──
  // What the recorded selector finds, if it's still the same thing (the same words on it,
  // the same label on the box); and how many on show have those words, and which of them
  // it is (nth, in the page's order: a snapshot lists them in the same order), so replay
  // never guesses between two. Only selectors and counts go back: nothing is read out.
  const same = (a, b) => squash(a).toLowerCase() === squash(b).toLowerCase();
  const onShow = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const inOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  function probe(args = {}) {
    const kind = String(args.kind || '');
    const want = kind === 'click' ? String(args.text || '') : String(args.field || '');
    const fits = kind === 'click' ? () => true : kind === 'select' ? (el) => el.tagName === 'SELECT' : typable;
    const words = kind === 'click' ? wordsOf : fieldOf;
    let el = null;
    try { el = args.selector ? document.querySelector(String(args.selector)) : null; } catch { el = null; }
    const target = el && onShow(el) && fits(el) && (!want || same(words(el), want)) ? el : null;
    let all = target ? [target] : [];
    if (want) {
      const pool = kind === 'click' ? PRESSABLE : kind === 'select' ? 'select' : 'input, textarea, [contenteditable="true"]';
      // (a label that has a box is its box's: the box's click is the step, never the label's)
      all = [...document.querySelectorAll(pool)].filter((c) => onShow(c) && fits(c) && same(words(c), want) && !(c.tagName === 'LABEL' && c.control));
      if (target && !all.includes(target)) all = [...all, target].sort(inOrder);
    }
    const found = target || (all.length === 1 ? all[0] : null);
    const out = { ok: true, count: all.length, nth: found ? all.indexOf(found) : -1, selector: '' };
    if (!found) return out;
    out.selector = found === el ? String(args.selector) : selectorFor(found);
    if (kind === 'type') out.secret = secret(found);
    if (kind === 'select') out.has = [...found.options].some((o) => same(o.label || o.text, args.text));
    return out;
  }

  const COMMANDS = { context, extract, imageAt, handback, mainPrice, record, probe };

  // How much the owner has selected (never what): a request right after a selection then
  // carries it (the hub asks for the words themselves only then).
  let selectionTimer = 0;
  let selectionSaid = 0;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      const length = selection && !selection.isCollapsed ? Math.min(1000000, String(selection).trim().length) : 0;
      if (length === selectionSaid) return;
      selectionSaid = length;
      ipcRenderer.send('page-ai:event', { kind: 'selection', length });
    }, 350);
  });

  ipcRenderer.on('page-ai:command', async (_event, message) => {
    const { id, action, args } = message || {};
    let result;
    try {
      const fn = COMMANDS[action];
      result = fn ? await fn(args || {}) : { ok: false, message: `Unknown command ${action}` };
    } catch (err) {
      result = { ok: false, message: String(err && err.message ? err.message : err) };
    }
    ipcRenderer.send('page-ai:result', { id, result });
  });
})();
