// The code interpreter's runs in the window (features/code_interpreter.py): each on a card,
// with its charts, what it printed (or its error), the files it wrote, the code folded away,
// and Show in Finder. Everything from the run is shown as text; a chart only as a PNG data:
// URL of base64 the backend read from the file. helpers is exported for node --test
// (tests/web/code-interpreter.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // A chart's picture, or '' for anything that isn't plain base64.
    chartSrc(chart) {
      const data = String((chart && chart.data) || '');
      return /^[A-Za-z0-9+/=]+$/.test(data) ? `data:image/png;base64,${data}` : '';
    },
    // The card's title: what kind of run it was.
    title(ev) {
      if (ev && ev.error) return 'The code hit an error';
      if (ev && ev.charts && ev.charts.length) return ev.charts.length === 1 ? 'Made a chart' : `Made ${ev.charts.length} charts`;
      return 'Ran Python';
    },
    // Long output folded to its first lines, with how much more there is.
    clip(text, lines = 40) {
      const all = String(text || '').replace(/\s+$/, '').split('\n');
      if (all.length <= lines) return { text: all.join('\n'), more: 0 };
      return { text: all.slice(0, lines).join('\n'), more: all.length - lines };
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const t = (s) => F.t(s);

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function button(label, run, cls = 'btn') {
    const b = el('button', cls, t(label));
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function show(ev) {
    const card = el('div', 'card plain ci-card');
    card.append(el('div', 'card-kicker', t('Analysis')), el('div', 'card-title', t(helpers.title(ev))));
    for (const chart of ev.charts || []) {
      const src = helpers.chartSrc(chart);
      if (!src) continue;
      const img = document.createElement('img');
      img.className = 'ci-chart';
      img.alt = String(chart.name || '');
      img.src = src;
      card.append(img);
    }
    const clipped = helpers.clip(ev.error || ev.output);
    if (clipped.text) {
      const pre = mine(el('pre', `ci-out${ev.error ? ' ci-error' : ''}`, clipped.text));
      card.append(pre);
      if (clipped.more) card.append(el('div', 'card-text ci-more', `… ${clipped.more} ${t('more lines')}`));
    }
    if ((ev.files || []).length) {
      const files = el('div', 'card-text ci-files');
      files.append(document.createTextNode(`${t('Files written:')} `), mine(el('span', '', ev.files.slice(0, 12).join(', '))));
      card.append(files);
    }
    const code = el('details', 'ci-code');
    code.append(el('summary', '', t('Code')), mine(el('pre', 'ci-src', String(ev.code || ''))));
    card.append(code);
    const actions = el('div', 'card-actions');
    actions.append(
      button('Show in Finder', () => send({ type: 'analysis_reveal' })),
      button('Dismiss', () => { card.remove(); if (typeof syncDismissAll === 'function') syncDismissAll(); }),
    );
    card.append(actions);
    const cards = F.$('cards');
    if (!cards) return;
    cards.append(card);
    if (typeof syncDismissAll === 'function') syncDismissAll();
  }

  /* global syncDismissAll */
  F.on('analysis_run', show);
})(typeof window !== 'undefined' ? window : globalThis);
