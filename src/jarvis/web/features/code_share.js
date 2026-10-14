// Eden Code's Share live (features/code_share.py, Labs): a read-only live view of the open
// session for a teammate, by a link the phone companion's server serves on this Mac's
// network. The Share pane (More › Share live…): a share's link to copy, who is watching
// (each viewer's address, since when, the name on its suggestions) with Stop for one (round
// 3, S1b: it, and its address, can't watch that share again), when it ends, Revoke; a new share for 15 minutes to a day; and phase 2, behind
// its own switch, viewers' suggestions as cards here (copy one into the composer, or
// dismiss it): never sent to the session.
//
// Links, titles and suggestions are data: text only, marked data-no-i18n. Pure helpers are
// exported for node --test (tests/web/code-share.test.mjs).
(function (root) {
  'use strict';

  const MINUTES = [[15, '15 minutes'], [60, '1 hour'], [240, '4 hours'], [1440, '1 day']];
  const PREF = 'code_share_comments';

  // A share's viewers, in words.
  function watchingText(n) {
    if (!n) return 'Nobody watching';
    return n === 1 ? '1 watching' : `${n} watching`;
  }

  // When it ends, in words (expires: seconds since 1970).
  function endsText(expires, now) {
    const s = Math.round(expires - now);
    if (s <= 0) return 'Ended';
    if (s < 3600) return `Ends in ${Math.max(1, Math.round(s / 60))} min`;
    return `Ends in ${Math.round(s / 3600)} h`;
  }

  // What goes into the composer for a suggestion the owner takes up: theirs to edit and send.
  function composerText(comment) {
    return `Suggestion from ${comment.name || 'a viewer'}: ${comment.text}`;
  }

  // One viewer, in words, for the owner (w: code_share's watchers(); now: seconds since 1970).
  function watcherText(w, now) {
    const who = w.name ? `${w.name} at ${w.address || 'an unknown address'}` : `A viewer at ${w.address || 'an unknown address'}`;
    const minutes = Math.max(0, Math.round((now - (w.since || now)) / 60));
    return minutes < 1 ? `${who}, just now` : `${who}, for ${minutes} min`;
  }

  const api = { watchingText, endsText, composerText, watcherText, MINUTES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after this pane's own
  // buttons the focus would otherwise fall to the page (round 2, U5).
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const state = { shares: [], allowed: false, error: '', minutes: 60, comments: false, features: {} };
  let body = null;

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  function shareCard(share) {
    const card = el('section', 'jcx-share');
    card.setAttribute('aria-label', 'Live share');
    const head = el('div', 'jcx-share-head');
    const count = el('span', `jcx-chip${share.viewers ? ' busy' : ''}`, watchingText(share.viewers));
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');
    head.append(count, el('span', 'jc-dim', endsText(share.expires, Date.now() / 1000)));
    if (share.comments_on) head.append(el('span', 'jcx-chip', 'Suggestions on'));
    card.append(head);
    const link = mine(el('input', 'jc-field jcx-share-url'));
    link.readOnly = true;
    link.value = share.url;
    link.setAttribute('aria-label', 'Share link');
    link.addEventListener('focus', () => link.select());
    card.append(link);
    if (share.watchers && share.watchers.length) card.append(watcherList(share));
    const actions = el('div', 'jcx-share-actions');
    actions.append(
      button('Copy link', 'jc-btn small filled', async (b) => {
        try { await navigator.clipboard.writeText(share.url); b.textContent = t('Copied'); } catch (_) { link.select(); }
      }),
      button('Revoke', 'jc-btn small', () => send({ type: 'code_share_revoke', share: share.share }), 'The link stops working at once, for everyone'),
    );
    card.append(actions);
    if (share.fingerprint) {
      const fp = el('p', 'jc-dim jcx-share-note', `Their browser will warn about this Mac’s own certificate. Its fingerprint starts ${share.fingerprint}.`);
      card.append(fp);
    }
    for (const c of share.comments || []) card.append(commentCard(share, c));
    return card;
  }

  // Who is watching, each with Stop (that viewer, and its address, can't watch this share again).
  function watcherList(share) {
    const list = el('ul', 'jcx-share-watchers');
    list.setAttribute('aria-label', 'Watching now');
    const now = Date.now() / 1000;
    for (const w of share.watchers) {
      const li = el('li');
      const words = mine(el('span', '', ''));
      words.textContent = t(watcherText(w, now));  // (an address and a name the viewer gave: data)
      const stop = button('Stop', 'jc-btn small', () => send({ type: 'code_share_kick', share: share.share, viewer: w.viewer }),
        'They can’t watch this link again from that device; everyone else goes on');
      stop.setAttribute('aria-label', `${t('Stop')}: ${words.textContent}`);
      li.append(words, stop);
      list.append(li);
    }
    return list;
  }

  function commentCard(share, c) {
    const card = el('article', 'jcx-share-comment');
    card.setAttribute('aria-label', `Suggestion from ${c.name}`);
    card.append(mine(el('strong', '', c.name)), mine(el('p', '', c.text)));
    const actions = el('div', 'jcx-share-actions');
    actions.append(
      button('Copy into the composer', 'jc-btn small', () => {
        const input = document.getElementById('deck-input');
        if (input) { input.value = composerText(c); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
      }, 'Yours to edit and send; nothing is sent by itself'),
      button('Dismiss', 'jc-btn small', () => send({ type: 'code_share_dismiss', share: share.share, comment: c.id })),
    );
    card.append(actions);
    return card;
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcx-sharepane');
    const task = F.currentTask();
    if (!task) {
      wrap.append(el('p', 'jc-empty', 'Open a session to share it.'));
      keepFocus(target, () => target.replaceChildren(wrap));
      return;
    }
    wrap.append(el('p', 'jc-dim', 'A read-only live view of this session for a teammate on your network: its transcript, changes and status, with keys, tokens and this Mac’s paths taken out. They can’t do anything in it.'));
    if (state.error) { const e = el('p', 'jcx-share-error', state.error); e.setAttribute('role', 'alert'); wrap.append(mine(e)); }
    const mineShares = state.shares.filter((s) => s.id === task.id);
    for (const share of mineShares) wrap.append(shareCard(share));
    const form = el('div', 'jcx-share-form');
    const time = el('label', 'jcx-share-field');
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', 'How long the link works');
    for (const [m, label] of MINUTES) { const o = el('option', '', label); o.value = String(m); o.selected = m === state.minutes; pick.append(o); }
    pick.addEventListener('change', () => { state.minutes = Number(pick.value); });
    time.append(el('span', '', 'Link works for'), pick);
    form.append(time);
    const allow = el('label', 'jcx-share-switch');
    const allowBox = el('input');
    allowBox.type = 'checkbox';
    allowBox.checked = state.allowed;
    allowBox.addEventListener('change', () => {
      state.features = { ...state.features, [PREF]: allowBox.checked };
      send({ type: 'feature_prefs', changes: { [PREF]: allowBox.checked } });
    });
    allow.append(allowBox, el('span', '', 'Let viewers send suggestions (they come to you as cards, never to the session)'));
    form.append(allow);
    if (state.allowed) {
      const on = el('label', 'jcx-share-switch');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = state.comments;
      box.addEventListener('change', () => { state.comments = box.checked; });
      on.append(box, el('span', '', 'Suggestions on for this share'));
      form.append(on);
    }
    form.append(button(mineShares.length ? 'Share another link' : 'Share live', 'jc-btn filled jcx-share-start', () => {
      state.error = '';
      send({ type: 'code_share_start', id: task.id, minutes: state.minutes, comments: state.allowed && state.comments });
    }));
    form.append(el('p', 'jc-dim jcx-share-note', 'The link works on this Mac’s network while the phone companion is on, until it ends or you revoke it. Shares end when Eden quits.'));
    wrap.append(form);
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  function render() { if (body && body.isConnected && body.querySelector('.jcx-sharepane')) draw(body); }

  F.registerPane('share', { title: 'Share live', render(target) { draw(target); send({ type: 'code_share_state' }); } });
  F.registerMoreItem({ label: 'Share live…', note: 'A read-only live view for a teammate', run: () => F.openPane('share') });

  F.on('code_share', (ev) => {
    state.shares = ev.shares || [];
    state.allowed = ev.comments_allowed === true;
    state.error = ev.error || '';
    render();
  });
  F.on('code_share_comment', (ev) => {
    const share = state.shares.find((s) => s.share === ev.share);
    if (share && ev.comment) share.comments = [...(share.comments || []), ev.comment];
    render();
  });
  const prefs = (p) => { if (p && p.features) { state.features = p.features; state.allowed = p.features[PREF] === true; render(); } };
  F.on('hello', (ev) => prefs(ev.prefs), { replay: true });
  F.on('prefs', (ev) => prefs(ev));
  F.on('tasks', () => render());
})(typeof window === 'object' ? window : globalThis);
