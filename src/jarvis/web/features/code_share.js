// Eden Code's Share live (features/code_share.py, Labs): a read-only live view of the open
// session for a teammate, by a link the phone companion's server serves on this Mac's
// network. The Share pane (More › Share live…): a share's link to copy, who is watching
// (each viewer's address, since when, the name on its suggestions) with Stop for one (round
// 3, S1b: it, and its address, can't watch that share again), when it ends, Revoke; a new share for 15 minutes to a day; and phase 2, behind
// its own switch, viewers' suggestions as cards here (copy one into the composer, or
// dismiss it): never sent to the session.
//
// Phase 3 (code_share_live.py, its own switch): a second link through askeden.com, sealed end
// to end. Phase 4 (code_share_drive.py): personal links, each for one person with a role
// (viewer, commenter, driver), made by name or for a team's members (code_teams.py, the Team
// section below); a driver's requests come here as cards naming them: Send (a plain message,
// as the owner's own), Answer (through the window's own answer, Touch ID and all:
// jarvisFeatures.answerApproval), Copy into the composer, or Dismiss; and the share's log of
// who asked for what.
//
// Links, titles and suggestions are data: text only, marked data-no-i18n. Pure helpers are
// exported for node --test (tests/web/code-share.test.mjs, code-share-live.test.mjs).
(function (root) {
  'use strict';

  const MINUTES = [[15, '15 minutes'], [60, '1 hour'], [240, '4 hours'], [1440, '1 day']];
  const PREF = 'code_share_comments';
  const PREF_INTERNET = 'code_share_internet';
  const PREF_DRIVERS = 'code_share_drivers';
  const PREF_TRUSTED = 'code_share_trusted_drivers';
  const ROLES = [['viewer', 'Viewer: watches'], ['commenter', 'Commenter: watches and suggests'], ['driver', 'Driver: can ask for messages and answers']];
  const TEAM_ROLES = [['member', 'Member'], ['admin', 'Admin']];

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

  // Who a viewer is, without how long, for its Stop button's name: the name its suggestions
  // carry and its address, both the viewer's own words (data, no English of the window's).
  // With the minutes in the name (round 3, U3-4) it changed every minute, so a redraw lost
  // the button the keys were on.
  function watcherWho(w) {
    return [w.name, w.address].filter(Boolean).join(', ') || '?';
  }

  // One viewer, in words, for the owner (w: code_share's watchers(); now: seconds since 1970).
  function watcherText(w, now) {
    const who = w.name ? `${w.name} at ${w.address || 'an unknown address'}` : `A viewer at ${w.address || 'an unknown address'}`;
    const minutes = Math.max(0, Math.round((now - (w.since || now)) / 60));
    return minutes < 1 ? `${who}, just now` : `${who}, for ${minutes} min`;
  }

  // A role, in words ('' : the link can do nothing now).
  function roleText(role) {
    return { viewer: 'Viewer', commenter: 'Commenter', driver: 'Driver' }[role] || 'No access';
  }

  // A driver's request, in words, for its card (r: code_share_drive's request).
  function requestText(r) {
    if (r.kind === 'approve') return `${r.name} suggests “${r.label || r.choice}” on: ${r.question || 'a question'}`;
    return `${r.name} asks to send: ${r.text}`;
  }

  // Whether the Send button may send it: a message, not a "!" or "/" command (only copied).
  function sendable(r) {
    return r.kind === 'message' && !/^\s*[!/]/.test(r.text || '');
  }

  // One line of the share's log, in words.
  function logText(e) {
    const what = {
      asked_message: 'asked to send a message', asked_approve: 'suggested an answer', sent: 'had a message sent by you',
      answered: 'had an answer given by you', dismissed: 'had a request dismissed', trusted_sent: 'sent a message (trusted)',
    }[e.action] || e.action;
    return `${e.who} (${roleText(e.role).toLowerCase()}) ${what}${e.via === 'internet' ? ', through askeden.com' : ''}`;
  }

  const api = { watchingText, endsText, composerText, watcherWho, watcherText, roleText, requestText, sendable, logText, MINUTES, ROLES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after this pane's own
  // buttons the focus would otherwise fall to the page (round 2, U5).
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const state = { shares: [], allowed: false, error: '', minutes: 60, comments: false, features: {},
    internetOn: false, internetReady: false, linked: false, drivers: false, trusted: false, teams: [], teamError: '',
    inviteName: '', inviteRole: 'viewer', inviteTrusted: false, teamsOpen: false, logOpen: {} };
  let body = null;

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }
  // A control that ends or starts something (Stop, Revoke, Share): never the keyboard's
  // stand-in for a gone one (code-focus.js).
  const spender = (b) => { b.dataset.spends = ''; return b; };

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
    if (share.internet && share.internet.state) card.append(internetRow(share));
    if (share.watchers && share.watchers.length) card.append(watcherList(share));
    const actions = el('div', 'jcx-share-actions');
    actions.append(
      button('Copy link', 'jc-btn small filled', async (b) => {
        try { await navigator.clipboard.writeText(share.url); b.textContent = t('Copied'); } catch (_) { link.select(); }
      }),
      spender(button('Revoke', 'jc-btn small', () => send({ type: 'code_share_revoke', share: share.share }), 'The link stops working at once, for everyone')),
    );
    card.append(actions);
    if (share.fingerprint) {
      const fp = el('p', 'jc-dim jcx-share-note', `Their browser will warn about this Mac’s own certificate. Its fingerprint starts ${share.fingerprint}.`);
      card.append(fp);
    }
    for (const c of share.comments || []) card.append(commentCard(share, c));
    for (const r of share.requests || []) card.append(requestCard(share, r));
    card.append(inviteBox(share));
    if (share.log && share.log.length) card.append(logList(share));
    return card;
  }

  async function copy(text, b) {
    try { await navigator.clipboard.writeText(text); b.textContent = t('Copied'); } catch (_) { /* (no clipboard: the field is there to select) */ }
  }

  // The link through askeden.com: its state, and the link (its key in the part after #).
  function internetRow(share) {
    const net = share.internet;
    const box = el('div', 'jcx-share-net');
    const words = { registering: 'Setting up the link that works anywhere…', live: 'Works anywhere, through askeden.com', failed: 'The link that works anywhere couldn’t be made', ended: 'The link that works anywhere has ended' };
    box.append(el('p', 'jc-dim', words[net.state] || ''));
    if (net.error) box.append(mine(el('p', 'jcx-share-error', net.error)));
    if (net.url) {
      const field = mine(el('input', 'jc-field jcx-share-url'));
      field.readOnly = true;
      field.value = net.url;
      field.setAttribute('aria-label', 'Link that works anywhere');
      field.addEventListener('focus', () => field.select());
      box.append(field, button('Copy the link that works anywhere', 'jc-btn small', (b) => copy(net.url, b)));
      box.append(el('p', 'jc-dim jcx-share-note', 'Sealed end to end: the key is in the link after #, which never reaches askeden.com. The page that reads it does come from askeden.com.'));
    }
    return box;
  }

  // Personal links: who each is for, what they may do now, their links, Revoke; and a new one.
  function inviteBox(share) {
    const box = el('div', 'jcx-share-invites');
    box.append(el('h4', '', 'Personal links'));
    const list = el('ul', 'jcx-share-watchers');
    list.setAttribute('aria-label', 'Personal links');
    for (const i of share.invites || []) {
      const li = el('li');
      li.dataset.focus = `invite:${share.share}:${i.invite}`;
      const who = mine(el('span', '', `${i.name} · ${t(roleText(i.role_now))}${i.trusted ? ` · ${t('trusted')}` : ''}${i.used ? '' : ` · ${t('not opened yet')}`}`));
      li.append(who, button('Copy link', 'jc-btn small', (b) => copy(i.url, b)));
      if (i.internet_url) li.append(button('Copy the link that works anywhere', 'jc-btn small', (b) => copy(i.internet_url, b)));
      const stop = spender(button('Revoke', 'jc-btn small', () => send({ type: 'code_share_uninvite', share: share.share, invite: i.invite }), 'Their link stops working at once'));
      stop.setAttribute('aria-label', `${t('Revoke')}: ${i.name}`);
      li.append(stop);
      list.append(li);
    }
    if ((share.invites || []).length) box.append(list);
    const form = el('div', 'jcx-share-form');
    const name = mine(el('input', 'jc-field'));
    name.value = state.inviteName;
    name.maxLength = 40;
    name.setAttribute('aria-label', 'Their name');
    name.placeholder = t('Their name');
    name.addEventListener('input', () => { state.inviteName = name.value; });
    const role = el('select', 'jcs-select');
    role.setAttribute('aria-label', 'What they may do');
    for (const [value, label] of ROLES) {
      if (value === 'driver' && !state.drivers) continue;
      if (value === 'commenter' && !state.allowed) continue;
      const o = el('option', '', label); o.value = value; o.selected = value === state.inviteRole; role.append(o);
    }
    role.addEventListener('change', () => { state.inviteRole = role.value; render(); });
    form.append(name, role);
    if (state.trusted && state.inviteRole === 'driver') {
      const sw = el('label', 'jcx-share-switch');
      const box2 = el('input'); box2.type = 'checkbox'; box2.checked = state.inviteTrusted;
      box2.addEventListener('change', () => { state.inviteTrusted = box2.checked; });
      sw.append(box2, el('span', '', 'Trusted: their plain messages go in without your tap (never answers, ! or / commands, or in Bypass)'));
      form.append(sw);
    }
    form.append(spender(button('Make a personal link', 'jc-btn small filled', () => {
      state.error = '';
      send({ type: 'code_share_invite', share: share.share, name: state.inviteName, role: role.value || 'viewer', trusted: state.inviteTrusted });
      state.inviteName = '';
    })));
    for (const team of state.teams) {
      if (!team.members.length) continue;
      form.append(spender(button(`Invite the team: ${team.name}`, 'jc-btn small', () => {
        for (const m of team.members) send({ type: 'code_share_invite', share: share.share, team: team.id, member: m.id, role: m.share_role });
      }, 'A personal link for each member, at the most their team role lets them be')));
    }
    box.append(form);
    return box;
  }

  // A driver's request: who, what; Send or Answer (the owner's own), Copy, Dismiss.
  function requestCard(share, r) {
    const card = el('article', 'jcx-share-comment jcx-share-request');
    card.setAttribute('aria-label', `Request from ${r.name}`);
    card.append(mine(el('strong', '', `${r.name} · ${t(roleText(r.role))}${r.via === 'internet' ? ' · askeden.com' : ''}`)), mine(el('p', '', requestText(r))));
    const actions = el('div', 'jcx-share-actions');
    const settle = (outcome) => send({ type: 'code_share_settle', share: share.share, request: r.id, outcome });
    if (r.kind === 'message' && sendable(r)) {
      actions.append(spender(button('Send as yours', 'jc-btn small filled', () => send({ type: 'code_share_send', share: share.share, request: r.id }), 'It goes to the session as your own message')));
    }
    if (r.kind === 'approve' && r.card) {
      actions.append(spender(button('Answer as suggested', 'jc-btn small filled', () => {
        // The window's own answer, so a risky step asks for Touch ID exactly as on its card.
        Promise.resolve(F.answerApproval ? F.answerApproval(r.card, r.choice) : false).then((ok) => { if (ok) settle('answered'); });
      }, 'Your answer, as if you tapped it on its card')));
    }
    if (r.kind === 'message') {
      actions.append(button('Copy into the composer', 'jc-btn small', () => {
        const input = document.getElementById('deck-input');
        if (input) { input.value = r.text; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
        settle('copied');
      }, 'Yours to edit and send; nothing is sent by itself'));
    }
    actions.append(button('Dismiss', 'jc-btn small', () => settle('dismissed')));
    card.append(actions);
    return card;
  }

  function logList(share) {
    const box = el('details', 'jcx-share-log');
    box.open = Boolean(state.logOpen[share.share]);
    box.addEventListener('toggle', () => { state.logOpen[share.share] = box.open; });
    box.append(el('summary', '', 'Who did what'));
    const list = el('ul');
    for (const e of share.log.slice().reverse()) list.append(mine(el('li', 'jc-dim', logText(e))));
    box.append(list);
    return box;
  }

  // Teams (code_teams.py): who the owner works with, and the most each may be in a share.
  function teamsBox() {
    const box = el('details', 'jcx-share-teams');
    box.open = state.teamsOpen;  // (kept open across redraws: each team change draws the pane again)
    box.addEventListener('toggle', () => { state.teamsOpen = box.open; });
    box.append(el('summary', '', 'Team'));
    box.append(el('p', 'jc-dim', 'Kept on this Mac. Only an admin can be a driver; removing someone ends their links at once.'));
    if (state.teamError) { const e = el('p', 'jcx-share-error', state.teamError); e.setAttribute('role', 'alert'); box.append(mine(e)); }
    for (const team of state.teams) {
      const sec = el('section', 'jcx-share-team');
      sec.setAttribute('aria-label', 'Team');
      sec.append(mine(el('h4', '', team.name)));
      const list = el('ul', 'jcx-share-watchers');
      for (const m of team.members) {
        const li = el('li');
        li.dataset.focus = `member:${team.id}:${m.id}`;
        li.append(mine(el('span', '', `${m.name}${m.joined ? '' : ` · ${t('invited')}`}`)));
        const role = el('select', 'jcs-select');
        role.setAttribute('aria-label', `${t('Team role')}: ${m.name}`);
        for (const [value, label] of TEAM_ROLES) { const o = el('option', '', label); o.value = value; o.selected = value === m.role; role.append(o); }
        role.addEventListener('change', () => send({ type: 'code_team_member', team: team.id, member: m.id, role: role.value }));
        const seat = el('select', 'jcs-select');
        seat.setAttribute('aria-label', `${t('The most they may be')}: ${m.name}`);
        for (const [value, label] of ROLES) {
          if (value === 'driver' && m.role !== 'admin') continue;
          const o = el('option', '', label); o.value = value; o.selected = value === m.share_role; seat.append(o);
        }
        seat.addEventListener('change', () => send({ type: 'code_team_member', team: team.id, member: m.id, share_role: seat.value }));
        const out = spender(button('Remove', 'jc-btn small', () => send({ type: 'code_team_remove', team: team.id, member: m.id }), 'Their links to your shares stop working at once'));
        out.setAttribute('aria-label', `${t('Remove')}: ${m.name}`);
        li.append(role, seat, out);
        list.append(li);
      }
      if (team.members.length) sec.append(list);
      const add = el('div', 'jcx-share-form');
      const name = mine(el('input', 'jc-field'));
      name.maxLength = 40;
      name.setAttribute('aria-label', 'Their name');
      name.placeholder = t('Their name');
      add.append(name, button('Invite', 'jc-btn small', () => {
        if (name.value.trim()) send({ type: 'code_team_invite', team: team.id, name: name.value, role: 'member', share_role: 'viewer' });
      }), spender(button('Delete the team', 'jc-btn small', () => send({ type: 'code_team_delete', team: team.id }), 'Every member’s links to your shares stop working')));
      sec.append(add);
      box.append(sec);
    }
    const make = el('div', 'jcx-share-form');
    const teamName = mine(el('input', 'jc-field'));
    teamName.maxLength = 60;
    teamName.setAttribute('aria-label', 'A new team’s name');
    teamName.placeholder = t('A new team’s name');
    make.append(teamName, button('Make a team', 'jc-btn small', () => { if (teamName.value.trim()) send({ type: 'code_team_create', name: teamName.value }); }));
    box.append(make);
    return box;
  }

  function switchRow(label, on, key) {
    const row = el('label', 'jcx-share-switch');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = on;
    box.addEventListener('change', () => {
      state.features = { ...state.features, [key]: box.checked };
      send({ type: 'feature_prefs', changes: { [key]: box.checked } });
    });
    row.append(box, el('span', '', label));
    return row;
  }

  // Who is watching, each with Stop (that viewer, and its address, can't watch this share again).
  // Each viewer's row is its own card for the keyboard (code-focus.js, data-focus by the
  // viewer's id), and Stop spends: after Stop on one viewer the focus went to the next one's
  // Stop, and a second Space blocked their address too (round 3, U3-4).
  function watcherList(share) {
    const list = el('ul', 'jcx-share-watchers');
    list.setAttribute('aria-label', 'Watching now');
    const now = Date.now() / 1000;
    for (const w of share.watchers) {
      const li = el('li');
      li.dataset.focus = `viewer:${share.share}:${w.viewer}`;
      const words = mine(el('span', '', ''));
      words.textContent = t(watcherText(w, now));  // (an address and a name the viewer gave: data)
      const stop = spender(button('Stop', 'jc-btn small', () => send({ type: 'code_share_kick', share: share.share, viewer: w.viewer }),
        'They, and anyone else at their network address, can’t watch this link again'));
      stop.setAttribute('aria-label', `${t('Stop')}: ${watcherWho(w)}`);
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
    state.drawnFor = task ? task.id : 0;
    if (!task) {
      wrap.append(el('p', 'jc-empty', 'Open a session to share it.'));
      keepFocus(target, () => target.replaceChildren(wrap));
      return;
    }
    wrap.append(el('p', 'jc-dim', 'A read-only live view of this session for a teammate on your network: its transcript, changes and status, with keys, tokens and this Mac’s paths taken out. They can’t do anything in it.'));
    if (state.drivers) wrap.append(el('p', 'jc-dim', 'A driver’s personal link can ask: nothing reaches the session without your tap, unless you made them a trusted driver.'));
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
    form.append(switchRow('Also make a link that works anywhere, through askeden.com (sealed end to end; needs this Mac linked to your Eden account)', state.internetOn, PREF_INTERNET));
    if (state.internetOn && !state.linked) form.append(el('p', 'jc-dim jcx-share-note', 'Link this Mac to your Eden account in Settings first.'));
    form.append(switchRow('Let drivers ask (a driver’s messages and answers come to you as cards; you send them)', state.drivers, PREF_DRIVERS));
    if (state.drivers) form.append(switchRow('Allow trusted drivers (their plain messages go in without your tap)', state.trusted, PREF_TRUSTED));
    form.append(spender(button(mineShares.length ? 'Share another link' : 'Share live', 'jc-btn filled jcx-share-start', () => {
      state.error = '';
      send({ type: 'code_share_start', id: task.id, minutes: state.minutes, comments: state.allowed && state.comments });
    })));
    form.append(el('p', 'jc-dim jcx-share-note', 'The link works on this Mac’s network while the phone companion is on, until it ends or you revoke it. Shares end when Eden quits.'));
    wrap.append(form);
    wrap.append(teamsBox());
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  function render() { if (body && body.isConnected && body.querySelector('.jcx-sharepane')) draw(body); }

  F.registerPane('share', { title: 'Share live', render(target) { draw(target); send({ type: 'code_share_state' }); send({ type: 'code_team_state' }); } });
  F.registerMoreItem({ label: 'Share live…', note: 'A read-only live view for a teammate', run: () => F.openPane('share') });

  F.on('code_share', (ev) => {
    state.shares = ev.shares || [];
    state.allowed = ev.comments_allowed === true;
    state.error = ev.error || '';
    state.internetOn = ev.internet_on === true;
    state.internetReady = ev.internet_ready === true;
    state.linked = ev.account_linked === true;
    state.drivers = ev.drivers_allowed === true;
    state.trusted = ev.trusted_allowed === true;
    render();
  });
  F.on('code_teams', (ev) => { state.teams = ev.teams || []; state.teamError = ev.error || ''; render(); });
  F.on('code_share_request', (ev) => {
    const share = state.shares.find((s) => s.share === ev.share);
    if (share && ev.request) share.requests = [...(share.requests || []), ev.request];
    render();
  });
  F.on('code_share_comment', (ev) => {
    const share = state.shares.find((s) => s.share === ev.share);
    if (share && ev.comment) share.comments = [...(share.comments || []), ev.comment];
    render();
  });
  const prefs = (p) => {
    if (!p || !p.features) return;
    state.features = p.features;
    state.allowed = p.features[PREF] === true;
    state.internetOn = p.features[PREF_INTERNET] === true;
    state.drivers = p.features[PREF_DRIVERS] === true;
    state.trusted = p.features[PREF_TRUSTED] === true;
    render();
  };
  F.on('hello', (ev) => prefs(ev.prefs), { replay: true });
  F.on('prefs', (ev) => prefs(ev));
  // The task list comes several times a second while a session works; the pane shows only
  // which session is open, so it's drawn again only when that changes (round 3, U3-4).
  F.on('tasks', () => { const task = F.currentTask(); if ((task ? task.id : 0) !== state.drawnFor) render(); });
})(typeof window === 'object' ? window : globalThis);
