// The iPhone and iPad apps (Eden, Eden Edu and Ask Eden Travel) are apps, not web pages: no pinch or double-tap zoom, no zoom-in
// when a field gets focus, and no sideways drift. This is a classic script, first in <head> of every page the apps
// load (index.html, edu.html, share.html), so it runs before paint and doesn't wait for app.js or the app's bridge.
// The app announces itself in the user agent ("EdenApp/…", WebController.swift), so it needs no native build.
// Every part is redundant on purpose (viewport meta, CSS, gesture events): test/app-lock.test.js (here and in the
// site's test folder, which gates the askeden.com deploy) fails if a page loses the script or this file loses a part.
// Do not remove or "simplify" it; if zoom or drift comes back, look for a page that doesn't load this file.
(function () {
  var d = document;
  // data-snap on the <script> tag: this page is one fixed screen (index, edu), so the document must never stay scrolled.
  // The share page is a real scrolling document and leaves it off.
  var snapOn = !!(d.currentScript && d.currentScript.hasAttribute('data-snap'));
  var root = d.documentElement;
  if (!/EdenApp|EdenEdu|EdenTravelApp/.test(navigator.userAgent || '') && !root.classList.contains('eden-app')) return;
  root.classList.add('eden-app');

  var VIEWPORT = 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  function lockViewport() {
    var m = d.querySelector('meta[name="viewport"]');
    if (!m) { m = d.createElement('meta'); m.name = 'viewport'; (d.head || root).appendChild(m); }
    if (m.getAttribute('content') !== VIEWPORT) m.setAttribute('content', VIEWPORT);
  }
  lockViewport();
  // anything that rewrites the viewport later (a page script, a swapped <head>) is put back
  new MutationObserver(lockViewport).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] });

  // the page itself pans up and down only; code blocks, tables and diffs scroll sideways inside themselves
  var CSS = 'html.eden-app,html.eden-app body{touch-action:pan-y;overscroll-behavior-x:none;overflow-x:clip;-webkit-text-size-adjust:100%}' +
    'html.eden-app pre,html.eden-app .codeblk,html.eden-app .md table,html.eden-app .diff pre,html.eden-app textarea,html.eden-app input{touch-action:pan-x pan-y}' +
    // keep scrolling past the end of a pane from moving the whole page (scroll chaining): the pane stops, the page stays
    'html.eden-app :is(#scrollcol,.edu-view,.edu-scroll,.side-scroll,.insp-body,.nb-pane-body,.sheet-body,.sp-body,#palList,.art-body,.art-report,.ed,.con-out,.dr-body,.jc-popover,.jc-menu,pre,.cblock pre){overscroll-behavior:contain}' +
    // the panes never scroll sideways: a wide answer scrolls inside its own code block or table, not the whole chat
    'html.eden-app :is(#scrollcol,.edu-view,.edu-scroll,.side-scroll,.insp-body,.nb-pane-body,.sheet-body,.sp-body){overflow-x:hidden}';
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    d.adoptedStyleSheets = d.adoptedStyleSheets.concat([sheet]);
  } catch (e) {
    var s = d.createElement('style');
    s.textContent = CSS;
    (d.head || root).appendChild(s);
  }

  // The layout is exactly one screen tall (inner panes scroll, the document doesn't). The document may rubber-band while a
  // finger is on it (pull to refresh), but it must never stay scrolled: that pushes the header under the status bar and
  // leaves a blank gap below the composer. So once the finger is up, or the keyboard closes, it goes back to the top.
  var touching = 0;
  var snapTimer = 0;
  function snap() {
    if (!snapOn) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function () {
      var y = window.pageYOffset || root.scrollTop || 0;
      var x = window.pageXOffset || root.scrollLeft || 0;
      if (!touching && (y > 0.5 || x > 0.5)) window.scrollTo(0, 0);
    }, 60);
  }
  ['touchstart', 'touchend', 'touchcancel'].forEach(function (t) {
    d.addEventListener(t, function (e) { touching = e.touches ? e.touches.length : 0; if (!touching) snap(); }, { passive: true, capture: true });
  });
  window.addEventListener('scroll', snap, { passive: true });
  window.addEventListener('resize', snap, { passive: true });
  d.addEventListener('focusout', snap, true);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', snap, { passive: true });
  window.addEventListener('pageshow', snap);
  d.addEventListener('visibilitychange', snap);

  // Drags. The app's web view always bounces (WebController.swift alwaysBounceVertical) and pans sideways when anything is a
  // little wider than the screen, whatever the CSS says. iOS lets a page cancel a drag only on its FIRST touchmove: once the
  // native scroll has started, later touchmoves can't be cancelled (e.cancelable is false). So each drag is decided on its
  // first movement and the decision holds until the finger lifts:
  //   - sideways: cancelled, unless it starts in something that scrolls sideways itself (code block, table, slider, field);
  //   - up/down (one-screen pages, data-snap): cancelled when nothing under the finger can scroll that way (the page would
  //     rubber-band and move); otherwise the pane under the finger scrolls, and its own bounce stays inside it.
  // The page's own panes (the chat, the sidebar, the Edu views) scroll up and down only. They were counted as
  // sideways scrollers when a wide answer made them a few pixels wider, so the whole chat slid left and right
  // (owner's screen recording, 2026-10-12): they're skipped here and can't scroll sideways at all (CSS above).
  var PANES = '#scrollcol,.edu-view,.edu-scroll,.side-scroll,.insp-body,.nb-pane-body,.sheet-body,.sp-body';
  function scrollsSideways(el) {
    for (var n = el; n && n.nodeType === 1 && n !== root; n = n.parentNode) {
      if (n.matches && n.matches(PANES)) continue;
      if (n.tagName === 'INPUT' && n.type === 'range') return true;
      if (n.isContentEditable || n.tagName === 'TEXTAREA') return true;
      var o = window.getComputedStyle(n).overflowX;
      if ((o === 'auto' || o === 'scroll') && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  }
  function canScrollY(el, dy) {
    for (var n = el; n && n.nodeType === 1 && n !== root && n !== d.body; n = n.parentNode) {
      if (n.tagName === 'TEXTAREA' && n.scrollHeight > n.clientHeight + 1) return true;
      var o = window.getComputedStyle(n).overflowY;
      if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
        if (dy > 0 && n.scrollTop > 0) return true; // finger down: it can scroll up
        if (dy < 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true; // finger up: it can scroll down
      }
    }
    return false;
  }
  var g = { x: 0, y: 0, el: null, decided: false, block: false };
  var late = 0; // drags iOS wouldn't let us cancel (for the report below)
  d.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { g.decided = true; g.block = false; return; }
    g.x = e.touches[0].clientX;
    g.y = e.touches[0].clientY;
    g.el = e.target;
    g.decided = false;
    g.block = false;
  }, { passive: true, capture: true });
  d.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    if (!g.decided) {
      var dx = e.touches[0].clientX - g.x;
      var dy = e.touches[0].clientY - g.y;
      if (!dx && !dy) return;
      g.decided = true;
      if (Math.abs(dx) > Math.abs(dy)) g.block = !scrollsSideways(g.el);
      else g.block = snapOn && !canScrollY(g.el, dy);
    }
    if (!g.block) return;
    if (e.cancelable) e.preventDefault();
    else late++;
  }, { passive: false, capture: true });

  // The report: when the page has moved anyway (it never should), the facts go to askeden.com's own log once a minute at
  // most, so the cause is seen on the real phone instead of guessed (2026-10-12). One line, no content of the chat.
  var lastReport = 0;
  function report(why) {
    var now = Date.now();
    if (now - lastReport < 60000) return;
    lastReport = now;
    try {
      var vv = window.visualViewport;
      var se = d.scrollingElement || root;
      var t = g.el && g.el.nodeType === 1 ? g.el : null;
      var path = [];
      for (var n = t; n && n.nodeType === 1 && path.length < 6; n = n.parentNode) path.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
      var info = {
        why: why, v: 7, sx: Math.round(window.pageXOffset), sy: Math.round(window.pageYOffset), set: Math.round(se.scrollTop), sel: Math.round(se.scrollLeft),
        vvx: vv ? Math.round(vv.offsetLeft) : null, vvy: vv ? Math.round(vv.offsetTop) : null, vvs: vv ? vv.scale : null, vvh: vv ? Math.round(vv.height) : null,
        iw: window.innerWidth, ih: window.innerHeight, sw: se.scrollWidth, sh: se.scrollHeight, bw: d.body ? d.body.scrollWidth : null, bh: d.body ? d.body.scrollHeight : null,
        late: late, block: g.block, path: path.join('<'), vp: (d.querySelector('meta[name="viewport"]') || {}).content || '',
      };
      fetch('/api/web/config?lockdiag=' + encodeURIComponent(JSON.stringify(info)), { credentials: 'same-origin', keepalive: true, cache: 'no-store' }).catch(function () {});
    } catch (err) { /* the report is an extra */ }
  }
  function check() {
    var vv = window.visualViewport;
    var moved = Math.abs(window.pageXOffset) > 1 || Math.abs(window.pageYOffset) > 1 || (vv && (Math.abs(vv.offsetLeft) > 1 || Math.abs(vv.offsetTop) > 1 || Math.abs(vv.scale - 1) > 0.01));
    if (moved) report(late ? 'moved-late' : 'moved');
  }
  window.addEventListener('scroll', check, { passive: true });
  if (window.visualViewport) { window.visualViewport.addEventListener('scroll', check, { passive: true }); window.visualViewport.addEventListener('resize', check, { passive: true }); }
  d.addEventListener('touchend', function () { setTimeout(check, 30); }, { passive: true, capture: true });
  setTimeout(function () { report('loaded'); lastReport = 0; }, 3000); // once per page load: proves this file runs on the phone

  // WebKit's own pinch events, and any two-finger move
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
    d.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
  });
  d.addEventListener('touchmove', function (e) { if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault(); }, { passive: false });
})();
