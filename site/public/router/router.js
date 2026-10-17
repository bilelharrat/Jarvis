// edenrouter.com: the interactive chart. The page works without this (a static chart, a table); with it the dial moves the
// highlight and the numbers, the route draws itself, and the EVES bars fill in. No libraries; reduced motion skips the animation.
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  var chart = $('chart');
  if (!chart) return;
  var points = Array.prototype.slice.call(chart.querySelectorAll('.pt'));
  var byLevel = {};
  var OPUS = 0.031, SOL = 0.0078;
  points.forEach(function (g) {
    var c = g.querySelector('circle.dot');
    g.d = { name: g.dataset.name, pass: +g.dataset.pass, score: +g.dataset.score, cost: +g.dataset.cost, level: +g.dataset.level, cx: +c.getAttribute('cx'), cy: +c.getAttribute('cy') };
    if (g.d.level) byLevel[g.d.level] = g;
  });
  var ring = $('ring'), lvl = $('lvl'), nameEl = $('lvlName'), says = $('says'), cap = $('cap');
  var rPass = $('rPass'), rCost = $('rCost');
  var shown = { pass: +rPass.textContent.replace('%', ''), cost: +rCost.textContent.replace('$', ''), cx: +ring.getAttribute('cx'), cy: +ring.getAttribute('cy') };
  var raf = 0;

  function money(c) { return '$' + (c >= 0.01 ? c.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : c.toFixed(4).replace(/0+$/, '')); }
  function ratio(r) { return (Math.round(r * 10) / 10).toFixed(1) + '×'; }
  function sentence(d) {
    var vsOpus = d.cost <= OPUS ? ratio(OPUS / d.cost) + ' cheaper than' : ratio(d.cost / OPUS) + ' the cost of';
    var vsSol = d.cost <= SOL ? ratio(SOL / d.cost) + ' cheaper than' : ratio(d.cost / SOL) + ' the cost of';
    var short = d.pass < 100 ? ' (which passed 100%)' : '';
    return 'Level ' + d.level + ' passes <b>' + d.pass + '%</b> of tasks at <b>' + money(d.cost) + '</b> each: ' + vsOpus + ' always using Claude Opus 5.5, and ' + vsSol + ' always using GPT-6.1 Sol' + short + '.';
  }
  function draw() {
    rPass.textContent = Math.round(shown.pass) + '%';
    rCost.textContent = money(shown.cost);
    ring.setAttribute('cx', shown.cx);
    ring.setAttribute('cy', shown.cy);
  }
  function go(level, instant) {
    var g = byLevel[level];
    if (!g) return;
    var d = g.d, from = { pass: shown.pass, cost: shown.cost, cx: shown.cx, cy: shown.cy };
    nameEl.textContent = d.name;
    says.innerHTML = sentence(d);
    cap.innerHTML = '<b>' + d.name + '</b>: passed ' + d.pass + '% of tasks, mean score ' + d.score.toFixed(2) + ', ' + money(d.cost) + ' per task.';
    cancelAnimationFrame(raf);
    if (instant || reduce) { shown = { pass: d.pass, cost: d.cost, cx: d.cx, cy: d.cy }; draw(); return; }
    var t0 = null;
    (function step(t) {
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / 650), e = 1 - Math.pow(1 - k, 3);
      shown = { pass: from.pass + (d.pass - from.pass) * e, cost: from.cost + (d.cost - from.cost) * e, cx: from.cx + (d.cx - from.cx) * e, cy: from.cy + (d.cy - from.cy) * e };
      draw();
      if (k < 1) raf = requestAnimationFrame(step);
    })(performance.now());
  }

  lvl.addEventListener('input', function () { stopSweep(); go(+lvl.value); });

  points.forEach(function (g) {
    function tell() {
      var d = g.d;
      cap.innerHTML = '<b>' + d.name + '</b>: passed ' + d.pass + '% of tasks, mean score ' + d.score.toFixed(2) + ', ' + money(d.cost) + ' per task.';
    }
    g.addEventListener('mouseenter', tell);
    g.addEventListener('focus', tell);
    g.addEventListener('click', function () { tell(); if (g.d.level) { stopSweep(); lvl.value = g.d.level; go(g.d.level); } });
    g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); g.dispatchEvent(new Event('click')); } });
  });

  var timer = 0, btn = $('sweep');
  function stopSweep() { if (timer) { clearInterval(timer); timer = 0; btn.firstElementChild.textContent = '▶'; } }
  btn.addEventListener('click', function () {
    if (timer) { stopSweep(); return; }
    var n = 1;
    lvl.value = 1; go(1);
    btn.firstElementChild.textContent = '■';
    timer = setInterval(function () {
      n += 1;
      if (n > 5) { stopSweep(); return; }
      lvl.value = n; go(n);
    }, 1300);
  });

  // draw the route and pop the dots in when the chart scrolls into view
  var route = $('route');
  try { route.style.setProperty('--len', Math.ceil(route.getTotalLength()) + 'px'); } catch (e) { /* keeps the default */ }
  function reveal() { chart.classList.add('drawn'); }
  function inView(el, fn) {
    if (!('IntersectionObserver' in window) || reduce) { fn(); return; }
    var io = new IntersectionObserver(function (es) { if (es.some(function (x) { return x.isIntersecting; })) { io.disconnect(); fn(); } }, { threshold: 0.25 });
    io.observe(el);
  }
  inView(chart, reveal);
  var eb = $('ebars');
  if (eb) inView(eb, function () { Array.prototype.forEach.call(eb.querySelectorAll('.er'), function (r, i) { setTimeout(function () { r.classList.add('in'); }, i * 160); }); });
  go(3, true);
})();
