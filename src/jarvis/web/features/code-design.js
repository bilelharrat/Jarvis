// Eden Code builds from a design (features/code_design.py): "Match a design…" in the More
// menu (or a picture sent with "build this"), each comparison in the transcript (the design
// and the page side by side, an overlay with a slider, a heat-map of where they differ, the
// score and how it has moved), and Refine, one round per press. The page is rendered and
// pictured by the app (app/features/design-match.js), asked from here.
//
// Everything shown from the backend is data: text only (textContent), user data marked
// data-no-i18n. Pure helpers are exported for node --test (tests/web/code-design.test.mjs).
(function (root) {
  'use strict';

  const DESIGN_BYTES = 8000000;
  const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  // A score (0..1) as a percentage.
  function percent(score) {
    const n = Number(score);
    return Number.isFinite(n) ? `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%` : '–';
  }

  // How the score moved: "62% → 74% → 82%", and the change since the first.
  function progression(scores) {
    const list = (scores || []).filter((s) => Number.isFinite(Number(s)));
    if (!list.length) return { text: '', delta: 0 };
    const delta = Math.round((list[list.length - 1] - list[0]) * 100);
    return { text: list.map(percent).join(' → '), delta };
  }

  // The sparkline of the scores, as an SVG path in a w × h box (0% at the bottom).
  function sparkPath(scores, w = 120, h = 28) {
    const list = (scores || []).map(Number).filter(Number.isFinite);
    if (!list.length) return '';
    const step = list.length > 1 ? w / (list.length - 1) : 0;
    return list.map((s, i) => `${i ? 'L' : 'M'}${(list.length > 1 ? i * step : w / 2).toFixed(1)},${(h - Math.max(0, Math.min(1, s)) * h).toFixed(1)}`).join(' ');
  }

  // A heat-map cell's colour: clear where alike, through amber to red where nothing is.
  function heatColor(v) {
    const x = Math.max(0, Math.min(255, Number(v) || 0)) / 255;
    if (x < 0.06) return [0, 0, 0, 0];
    const r = 255;
    const g = Math.round(200 * (1 - x));
    const a = Math.min(0.75, 0.15 + x * 0.8);
    return [r, g, 40, a];
  }

  // A picture the backend sent, as an image address: plain base64 only.
  function jpegSrc(data) {
    return typeof data === 'string' && data && /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? `data:image/jpeg;base64,${data}` : '';
  }

  // A file picked for "Match a design…": a picture of a kind and size the backend takes.
  function usable(file) {
    return Boolean(file && TYPES.includes(file.type) && file.size > 0 && file.size <= DESIGN_BYTES);
  }

  // The refine button's words: the round it would send.
  function refineLabel(entry) {
    return `Refine (round ${(entry.refined || 0) + 1} of ${entry.rounds || 0})`;
  }

  const api = { percent, progression, sparkPath, heatColor, jpegSrc, usable, refineLabel };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const matches = new Map();  // session id -> its latest dm_state

  function button(label, cls, run) {
    const b = el('button', cls || 'jc-mini', label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  // ── the app renders and pictures the page ──

  F.on('dm_render', async (ev) => {
    const app = root.jarvisApp;
    if (!app || !app.feature) return;  // a window without the app: the app window answers
    let result;
    try {
      const r = await fetch(ev.design, { cache: 'no-store' });
      if (!r.ok) throw new Error('The design picture isn’t there any more.');
      const design = new Uint8Array(await r.arrayBuffer());
      result = await app.feature.invoke('feature:design-match:compare', { url: ev.url, design });
    } catch (err) {
      result = { error: String(err && err.message ? err.message : err) };
    }
    F.send({ type: 'dm_render_result', call: ev.call, result });
  });

  // ── "Match a design…" ──

  const picker = el('input');
  picker.type = 'file';
  picker.accept = TYPES.join(',');
  picker.hidden = true;
  picker.id = 'dm-picker';
  document.body.append(picker);
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';
    const task = F.currentTask();
    if (!file || !task) return;
    if (!usable(file)) {
      if (typeof jcNote === 'function') jcNote(t('That picture can’t be used: PNG, JPEG, WebP or GIF, up to 8 MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '').split(',')[1] || '';
      F.send({ type: 'dm_start', id: task.id, image: { media_type: file.type, data, name: file.name } });
    };
    reader.readAsDataURL(file);
  });
  F.registerMoreItem({
    label: 'Match a design…',
    note: 'Eden Code builds it, then compares the page with your picture',
    when: (task) => !!task,
    run: () => picker.click(),
  });

  // ── a comparison in the transcript ──

  function viewer(e, card) {
    const box = el('div', 'dm-viewer');
    const modes = el('div', 'dm-modes');
    modes.setAttribute('role', 'tablist');
    const stage = el('div', 'dm-stage');
    const design = el('img', 'dm-design');
    design.alt = t('The design');
    design.src = jpegSrc(e.design_thumb);
    const page = el('img', 'dm-page');
    page.alt = t('The page as built');
    page.src = jpegSrc(e.render_thumb);
    const pair = el('div', 'dm-pair');
    const left = el('figure');
    left.append(design, el('figcaption', '', 'Design'));
    const right = el('figure');
    right.append(page, el('figcaption', '', 'Page'));
    pair.append(left, right);
    // The overlay: the page over the design, cut at the slider.
    const overlay = el('div', 'dm-overlay');
    const under = el('img', 'dm-under');
    under.alt = t('The design');
    under.src = design.src;
    const over = el('img', 'dm-over');
    over.alt = t('The page as built');
    over.src = page.src;
    const line = el('div', 'dm-split');
    overlay.append(under, over, line);
    const slider = el('input', 'dm-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '50';
    slider.setAttribute('aria-label', t('Design or page'));
    const cut = () => {
      over.style.clipPath = `inset(0 0 0 ${slider.value}%)`;
      line.style.left = `${slider.value}%`;
    };
    slider.addEventListener('input', cut);
    cut();
    const overlayBox = el('div', 'dm-overlay-box');
    overlayBox.append(overlay, slider);
    // The heat-map: the page, with where it differs painted over it.
    const heat = el('div', 'dm-heat');
    const heatPage = el('img');
    heatPage.alt = t('The page as built');
    heatPage.src = page.src;
    const canvas = el('canvas', 'dm-heat-canvas');
    canvas.width = Math.max(1, e.cols || 1);
    canvas.height = Math.max(1, e.rows || 1);
    const g = canvas.getContext && canvas.getContext('2d');
    if (g && Array.isArray(e.heat) && e.heat.length === canvas.width * canvas.height) {
      const img = g.createImageData(canvas.width, canvas.height);
      e.heat.forEach((v, i) => {
        const [r, gg, b, a] = heatColor(v);
        img.data.set([r, gg, b, Math.round(a * 255)], i * 4);
      });
      g.putImageData(img, 0, 0);
    }
    heat.append(heatPage, canvas);
    const views = { side: pair, overlay: overlayBox, heat };
    const labels = [['side', 'Side by side'], ['overlay', 'Overlay'], ['heat', 'Heat-map']];
    const show = (mode) => {
      stage.replaceChildren(views[mode]);
      modes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
      card.dataset.mode = mode;
    };
    for (const [mode, label] of labels) {
      const b = button(label, 'dm-mode', () => show(mode));
      b.dataset.mode = mode;
      b.setAttribute('role', 'tab');
      modes.append(b);
    }
    const larger = button('See larger', 'jc-mini dm-larger', () => {
      const big = !card.classList.contains('large');
      card.classList.toggle('large', big);
      larger.textContent = t(big ? 'See smaller' : 'See larger');
      if (big && !card.dataset.full) {
        card.dataset.full = '1';
        if (e.design_proof) F.send({ type: 'dm_image', proof: e.design_proof });
        if (e.render_proof) F.send({ type: 'dm_image', proof: e.render_proof });
      }
    });
    modes.append(el('span', 'jc-spacer'), larger);
    box.append(modes, stage);
    show('side');
    box.images = { design: [design, under], page: [page, over, heatPage] };
    return box;
  }

  const cards = new Set();  // rendered comparison cards: their buttons follow the match's state
  const fullImages = new Map();  // proof id -> [img…] waiting for the full picture

  function compared(e) {
    const li = el('li', `dm-card${e.good ? ' good' : ''}`);
    li.dataset.compared = String(e.compared || 0);
    const head = el('div', 'dm-head');
    head.append(el('strong', '', 'Design match'), mine(el('span', 'dm-score', percent(e.score))));
    if (e.good) head.append(el('span', 'cv-chip dm-close', 'Close match'));
    li.append(head);
    const prog = progression(e.scores);
    if ((e.scores || []).length > 1) {
      const row = el('div', 'dm-progress');
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 120 28');
      svg.setAttribute('class', 'dm-spark');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', sparkPath(e.scores));
      svg.append(path);
      const delta = el('span', `dm-delta ${prog.delta >= 0 ? 'up' : 'down'}`);
      delta.textContent = `${prog.delta >= 0 ? '+' : ''}${prog.delta} pts`;
      mine(delta);
      row.append(svg, mine(el('span', 'dm-steps', prog.text)), delta);
      li.append(row);
    }
    const parts = el('div', 'dm-parts');
    parts.append(el('span', 'cv-kind', 'Layout'), mine(el('span', '', percent(e.structure))),
      el('span', 'cv-kind', 'Colour'), mine(el('span', '', percent(e.colour))));
    li.append(parts);
    const box = viewer(e, li);
    for (const [proof, imgs] of [[e.design_proof, box.images.design], [e.render_proof, box.images.page]]) {
      if (proof) fullImages.set(proof, [...(fullImages.get(proof) || []), ...imgs]);
    }
    li.append(box);
    const worst = (e.regions || []).filter(([, v]) => v >= 0.08).slice(0, 3);
    if (worst.length) {
      const where = el('div', 'dm-where');
      where.append(el('span', 'cv-kind', 'Differs most'));
      for (const [name, v] of worst) where.append(el('span', 'dm-region', `${name} ${percent(v)}`));
      li.append(where);
    }
    const actions = el('div', 'dm-actions');
    const refine = button(refineLabel(e), 'jc-mini dm-refine', () => {
      const task = F.currentTask();
      if (!task) return;
      refine.disabled = true;
      F.send({ type: 'dm_refine', id: task.id, compared: e.compared });
    });
    const again = button('Compare again', 'jc-mini', () => { const task = F.currentTask(); if (task) F.send({ type: 'dm_compare', id: task.id }); });
    const stop = button('Stop matching', 'jc-mini', () => { const task = F.currentTask(); if (task) F.send({ type: 'dm_stop', id: task.id }); });
    actions.append(refine, again, stop);
    const cost = el('small', 'cv-check-note dm-cost', 'Each round is one more turn of the session, with your go-ahead.');
    li.append(actions, cost);
    li.update = (m) => {
      const latest = m && !m.stopped && m.compared === e.compared;
      const left = latest && m.refined < m.rounds;
      refine.hidden = !left;
      refine.disabled = !left || m.waiting || m.comparing;
      again.hidden = stop.hidden = !(m && !m.stopped);
      again.disabled = !!(m && (m.waiting || m.comparing));
      cost.hidden = refine.hidden;
      if (latest && !left) cost.hidden = true;
    };
    cards.add(li);
    const task = F.currentTask();
    li.update(task ? matches.get(task.id) : null);
    if (task && !matches.has(task.id)) F.send({ type: 'dm_state', id: task.id });
    return li;
  }

  function designEntry(e) {
    if (e.status === 'compared') return compared(e);
    const li = el('li', `dm-card dm-note ${e.status || ''}`);
    if (e.status === 'sent') {
      li.append(el('span', 'cv-kind', 'Design match'), el('span', '', `Refinement round ${e.refined} of ${e.rounds} sent to Eden Code.`));
      return li;
    }
    const head = el('div', 'dm-head');
    head.append(el('strong', '', 'Design match'), el('span', 'cv-chip', 'Not compared'));
    li.append(head, el('small', 'cv-check-note', e.why || ''));
    const again = button('Compare now', 'jc-mini', () => { const task = F.currentTask(); if (task) F.send({ type: 'dm_compare', id: task.id }); });
    li.append(again);
    return li;
  }
  F.registerEntry('design', designEntry);

  F.on('dm_state', (ev) => {
    if (ev.stopped) matches.set(ev.id, { stopped: true });
    else matches.set(ev.id, ev);
    const task = F.currentTask();
    if (!task || task.id !== ev.id) return;
    for (const card of [...cards]) {
      if (!card.isConnected) { cards.delete(card); continue; }
      card.update(matches.get(ev.id));
    }
  });
  F.on('dm_image', (ev) => {
    const src = jpegSrc(ev.jpeg);
    if (!src) return;
    for (const img of fullImages.get(ev.proof) || []) if (img.isConnected) img.src = src;
  });
  F.on('dm_error', (ev) => { if (typeof jcNote === 'function') jcNote(ev.text); });
})(typeof window === 'object' ? window : globalThis);
