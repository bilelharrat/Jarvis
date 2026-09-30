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
//   sign-in wall).
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

  const COMMANDS = { context, extract, imageAt, handback };

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
