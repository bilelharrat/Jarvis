// JARVIS in the owner's calls (the backend is jarvis.features.meeting_agent): a side panel
// while notes run, with the transcript (You, Them, Jarvis), live decisions, action items and
// open questions, private answers to "what did they just say about…", an Ask box, a Say box
// (the owner's own words spoken into the call through their virtual audio route) and each
// reply about to be spoken with its 3-second Cancel. Afterwards: the summary, each action
// item to Reminders or Calendar, and Draft follow-up (a Mail draft, never sent). Settings ›
// Meetings gains Live call notes, Say private answers aloud and Speak into calls through.
//
// Other people's words and anything the backend wrote are shown with textContent and marked
// data-no-i18n (the backend already put its own sentences in the owner's language). Pure
// helpers are exported for node --test (tests/web/meeting_agent.test.mjs).
(function (root) {
  'use strict';

  const WHO = { You: 'You', Them: 'Them', Jarvis: 'Jarvis' };
  const SAY_STATES = {
    pending: 'About to say',
    speaking: 'Saying into the call',
    spoken: 'Said into the call',
    cancelled: 'Cancelled',
    failed: 'Couldn’t say it',
  };

  function speakerLabel(who) {
    return WHO[who] || '';
  }

  function sayLabel(state) {
    return SAY_STATES[state] || SAY_STATES.pending;
  }

  // Whole seconds left of a reply's cancel (0 once it's over).
  function secondsLeft(wait, shownAt, now) {
    const left = Number(wait) * 1000 - (now - shownAt);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  // A datetime-local value: the next 9:00 after now (today's, or tomorrow's).
  function nextMorning(now) {
    const at = new Date(now);
    at.setHours(9, 0, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  // Words from a box: one line, at most max characters ("" for nothing).
  function words(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // The Settings route list: "Off", the virtual devices found, and the chosen one even
  // when it isn't connected now.
  function routeOptions(routes, chosen) {
    const list = (Array.isArray(routes) ? routes : []).filter((r) => typeof r === 'string' && r);
    if (chosen && !list.includes(chosen)) list.push(chosen);
    return [['', 'Off'], ...list.map((r) => [r, r])];
  }

  const api = { speakerLabel, sayLabel, secondsLeft, nextMorning, words, routeOptions, WHO, SAY_STATES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let features = {};
  let routes = null;  // {routes, route, found}: what Settings shows
  let call = null;  // {title, started}
  let writing = '';
  let transcript = [];
  let notes = null;
  const answers = [];  // newest last, at most 3
  const says = new Map();  // id -> {text, exact, wait, state, why, shownAt}
  let after = null;  // {path, title, summary, actions, minutes}
  const items = new Map();  // `${index}:${action}` -> {ok, text}
  let note = '';
  let collapsed = false;
  let panel = null;
  let ticker = 0;

  function button(label, cls, onClick, aria) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', t(aria));
    b.addEventListener('click', onClick);
    return b;
  }

  // ── the panel ──

  function box(id, placeholder, label, type, max) {
    const form = el('form', 'ma-row');
    const field = el('input', 'ma-field');
    field.type = 'text';
    field.id = id;
    field.maxLength = max;
    field.placeholder = t(placeholder);
    field.setAttribute('aria-label', t(placeholder));
    form.append(field, button(label, 'btn', () => form.requestSubmit()));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const said = words(field.value, max);
      if (!said) return;
      send({ type, text: said });
      field.value = '';
    });
    return form;
  }

  function list(title, lines, cls) {
    const section = el('section', `ma-list ${cls}`);
    section.append(el('h4', '', title));
    const ul = el('ul');
    for (const line of lines) ul.append(mine(el('li', '', line)));
    if (!lines.length) ul.append(el('li', 'ma-none', 'Nothing yet'));
    section.append(ul);
    return section;
  }

  function sayRow(id, s) {
    const row = el('div', `ma-say ma-say-${s.state}`);
    row.dataset.say = id;
    const head = el('div', 'ma-say-head');
    head.append(el('span', 'ma-say-state', sayLabel(s.state)));
    if (s.state === 'pending' && s.wait > 0) {
      const left = el('span', 'ma-say-left');
      left.dataset.wait = String(s.wait);
      left.dataset.at = String(s.shownAt);
      left.textContent = String(secondsLeft(s.wait, s.shownAt, Date.now()));
      head.append(left);
    }
    row.append(head, mine(el('p', 'ma-say-text', s.text)));
    if (s.why) row.append(mine(el('p', 'ma-say-why', s.why)));
    if (s.state === 'pending' || s.state === 'speaking') {
      row.append(button('Cancel', 'btn ma-cancel', () => send({ type: 'meeting_agent_cancel', id })));
    }
    return row;
  }

  function livePart() {
    const out = [el('p', 'ma-consent', 'Let everyone on the call know notes are being taken.')];
    const pending = [...says.entries()];
    if (pending.length) {
      const section = el('section', 'ma-says');
      section.setAttribute('aria-live', 'assertive');
      section.append(...pending.map(([id, s]) => sayRow(id, s)));
      out.push(section);
    }
    if (answers.length) {
      const section = el('section', 'ma-answers');
      section.setAttribute('aria-live', 'polite');
      for (const a of answers) {
        const item = el('div', 'ma-answer');
        item.append(mine(el('p', 'ma-q', a.q)), mine(el('p', 'ma-a', a.text)));
        section.append(item);
      }
      out.push(section);
    }
    out.push(
      box('ma-ask', 'Ask about the call…', 'Ask', 'meeting_agent_ask', 500),
      box('ma-say-box', 'Say into the call…', 'Say', 'meeting_agent_say', 300),
    );
    if (note) out.push(mine(el('p', 'ma-note', note)));
    if (features.call_live !== false) {
      const live = el('div', 'ma-live');
      const n = notes || {};
      live.append(
        list('Decisions', n.decisions || [], 'ma-decisions'),
        list('Action items', n.actions || [], 'ma-actions'),
        list('Open questions', n.questions || [], 'ma-questions'),
      );
      if (n.error) live.append(mine(el('p', 'ma-note', n.error)));
      else if (n.at) {
        const at = el('p', 'ma-updated');
        at.append(el('span', '', 'Updated'), document.createTextNode(' '), mine(el('span', '', n.at)));
        live.append(at);
      }
      out.push(live);
    }
    const ol = el('ol', 'ma-transcript');
    ol.setAttribute('aria-label', t('Transcript'));
    for (const r of transcript) {
      const li = el('li', `ma-line ma-${String(r.who || 'none').toLowerCase()}`);
      const meta = el('span', 'ma-meta');
      if (r.who) meta.append(r.who === 'Jarvis' ? mine(el('span', 'ma-who', 'Jarvis')) : el('span', 'ma-who', speakerLabel(r.who)));
      meta.append(mine(el('time', '', r.t || '')));
      li.append(meta, mine(el('span', 'ma-words', r.text)));
      ol.append(li);
    }
    if (!transcript.length) ol.append(el('li', 'ma-none', 'Listening…'));
    out.push(ol);
    return out;
  }

  function itemRow(a, index) {
    const li = el('li', 'ma-item');
    li.append(mine(el('span', 'ma-item-text', a)));
    const row = el('div', 'ma-row ma-item-actions');
    const r = items.get(`${index}:reminders`);
    const c = items.get(`${index}:calendar`);
    const remind = button('Reminders', 'btn', () => {
      remind.disabled = true;
      send({ type: 'meeting_agent_item', path: after.path, index, action: 'reminders' });
    }, 'Add to Reminders');
    remind.disabled = Boolean(r && r.ok);
    const when = el('input', 'ma-when');
    when.type = 'datetime-local';
    when.value = nextMorning(new Date());
    when.setAttribute('aria-label', t('When'));
    const cal = button('Calendar', 'btn', () => {
      cal.disabled = true;
      send({ type: 'meeting_agent_item', path: after.path, index, action: 'calendar', start: when.value });
    }, 'Add to Calendar');
    cal.disabled = Boolean(c && c.ok);
    row.append(remind, when, cal);
    li.append(row);
    for (const done of [r, c]) if (done && done.text) li.append(mine(el('p', 'ma-note', done.text)));
    return li;
  }

  function afterPart() {
    const out = [];
    if (after.minutes) {
      const m = el('p', 'ma-updated');
      m.append(mine(el('span', '', String(after.minutes))), document.createTextNode(' '), el('span', '', 'min'));
      out.push(m);
    }
    out.push(list('Summary', after.summary || [], 'ma-summary'));
    const section = el('section', 'ma-list ma-after-actions');
    section.append(el('h4', '', 'Action items'));
    const ul = el('ul');
    (after.actions || []).forEach((a, i) => ul.append(itemRow(a, i)));
    if (!(after.actions || []).length) ul.append(el('li', 'ma-none', 'No action items'));
    section.append(ul);
    out.push(section);
    const row = el('div', 'ma-row ma-end');
    if ((after.actions || []).length) {
      const draft = button('Draft follow-up', 'btn primary', () => {
        draft.disabled = true;
        send({ type: 'meeting_followup', path: after.path, action: 'email' });
      });
      row.append(draft);
    }
    row.append(button('Close', 'btn', () => { after = null; items.clear(); render(); }));
    out.push(row, el('p', 'ma-note', 'The follow-up opens as a draft in Mail. Nothing is sent.'));
    return out;
  }

  function render() {
    const showing = call || writing || after;
    if (!showing) {
      if (panel) { panel.remove(); panel = null; }
      clearInterval(ticker);
      ticker = 0;
      return;
    }
    const typed = new Map();
    if (panel) for (const f of panel.querySelectorAll('.ma-field')) typed.set(f.id, [f.value, f === document.activeElement]);
    const scroll = panel && panel.querySelector('.ma-transcript');
    const atEnd = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    if (!panel) {
      panel = el('aside', 'ma-panel');
      panel.id = 'meeting-agent';
      panel.setAttribute('aria-label', t('Live notes'));
      document.body.append(panel);
    }
    panel.classList.toggle('ma-collapsed', collapsed);
    const head = el('header', 'ma-head');
    const title = el('div', 'ma-title');
    title.append(el('span', `ma-dot${call ? '' : ' ma-done'}`), mine(el('strong', '', (call && call.title) || writing || (after && after.title) || '')));
    head.append(title, el('span', 'ma-kicker', call ? 'Live notes' : writing ? 'Writing up…' : 'After the call'));
    head.append(button(collapsed ? 'Show' : 'Hide', 'btn ma-toggle', () => { collapsed = !collapsed; render(); }, collapsed ? 'Show live notes' : 'Hide live notes'));
    const body = el('div', 'ma-body');
    if (!collapsed) body.append(...(call ? livePart() : writing ? [el('p', 'ma-note', 'Writing up the notes…')] : afterPart()));
    panel.replaceChildren(head, body);
    for (const f of panel.querySelectorAll('.ma-field')) {
      const kept = typed.get(f.id);
      if (kept) { f.value = kept[0]; if (kept[1]) f.focus(); }
    }
    const list2 = panel.querySelector('.ma-transcript');
    if (list2 && atEnd) list2.scrollTop = list2.scrollHeight;
    if (!ticker && says.size) {
      ticker = setInterval(() => {
        if (!panel) return;
        for (const left of panel.querySelectorAll('.ma-say-left')) {
          left.textContent = String(secondsLeft(Number(left.dataset.wait), Number(left.dataset.at), Date.now()));
        }
      }, 250);
    } else if (ticker && !says.size) { clearInterval(ticker); ticker = 0; }
  }

  F.on('meeting_agent', (ev) => {
    if ('active' in ev) {
      call = ev.active && typeof ev.active === 'object' ? ev.active : null;
      if (call) { writing = ''; after = null; transcript = []; notes = null; answers.length = 0; says.clear(); items.clear(); note = ''; collapsed = false; } else writing = '';
    }
    if ('writing' in ev) { writing = String(ev.writing || '') || ' '; call = null; says.clear(); }
    if (Array.isArray(ev.transcript)) transcript = ev.transcript;
    if (ev.notes) notes = ev.notes;
    if (ev.answer) { answers.push(ev.answer); while (answers.length > 3) answers.shift(); collapsed = false; }
    if (ev.say) {
      const s = ev.say;
      const before = says.get(s.id);
      const entry = { ...(before || { shownAt: Date.now() }), ...s };
      if (s.state === 'pending' && !before) entry.shownAt = Date.now();
      says.set(s.id, entry);
      if (s.state === 'pending') collapsed = false;
      if (['spoken', 'cancelled', 'failed'].includes(s.state)) {
        setTimeout(() => { if (says.get(s.id) === entry) { says.delete(s.id); render(); } }, s.state === 'failed' ? 8000 : 4000);
      }
    }
    if (typeof ev.note === 'string') note = ev.note;
    if (ev.after) { after = ev.after; writing = ''; call = null; items.clear(); }
    if (ev.item && after && ev.item.path === after.path) items.set(`${ev.item.index}:${ev.item.action}`, ev.item);
    if (ev.routes) { routes = ev.routes; renderSettings(); return; }
    render();
  }, { replay: true });

  // ── Settings › Meetings ──

  function toggle(id, label, onClick) {
    const sw = button('', 'switch', onClick, label);
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    return sw;
  }

  function row(title, small, ...controls) {
    const r = el('div', 'row');
    const w = el('span');
    w.append(el('strong', '', title));
    if (small) w.append(el('small', '', small));
    r.append(w, ...controls);
    return r;
  }

  const setFeatures = (changes) => send({ type: 'feature_prefs', changes });

  function buildSettings() {
    const group = F.$('meetings-group');
    if (!group || F.$('sw-call-live')) return Boolean(group);
    const live = toggle('sw-call-live', 'Live call notes', () => setFeatures({ call_live: features.call_live === false }));
    const spoken = toggle('sw-call-private-spoken', 'Say private answers aloud', () => setFeatures({ call_private_spoken: !features.call_private_spoken }));
    const select = el('select', 'ma-route');
    select.id = 'call-route';
    select.setAttribute('aria-label', t('Speak into calls through'));
    select.addEventListener('change', () => setFeatures({ call_route: select.value }));
    select.addEventListener('focus', () => send({ type: 'meeting_agent_state' }));
    const status = el('p', 'group-note ma-route-status');
    status.id = 'call-route-status';
    const routeRow = el('label', 'row stack');
    routeRow.htmlFor = 'call-route';
    const w = el('span');
    w.append(
      el('strong', '', 'Speak into calls through'),
      el('small', '', 'When you say “tell them…” or “answer that”, I speak a short reply into the call through a virtual audio device (BlackHole or Loopback) that your call app uses as its microphone, mixed with yours. Anything I wrote myself shows first, with 3 seconds to cancel. I never speak into a call unless you ask.'),
    );
    routeRow.append(w, select);
    const consent = el('p', 'group-note ma-consent-note', 'Live notes transcribe everyone on the call, here on your Mac; only the transcript’s text goes to the model. Tell the other participants that notes are being taken.');
    consent.id = 'call-consent-note';
    group.append(
      row('Live call notes', 'While notes run, a side panel shows who said what, with decisions, action items and open questions updated about every minute.', live),
      row('Say private answers aloud', 'Answers to “what did they just say about…” stay on the panel. Turn this on only with headphones, when your Mac’s sound isn’t shared into the call.', spoken),
      routeRow,
      status,
      consent,
    );
    renderSettings();
    send({ type: 'meeting_agent_state' });
    return true;
  }

  function renderSettings() {
    F.$('sw-call-live')?.setAttribute('aria-checked', String(features.call_live !== false));
    F.$('sw-call-private-spoken')?.setAttribute('aria-checked', String(Boolean(features.call_private_spoken)));
    const select = F.$('call-route');
    if (!select) return;
    const chosen = typeof features.call_route === 'string' ? features.call_route : '';
    const options = routeOptions(routes && routes.routes, chosen);
    if (document.activeElement !== select || select.options.length !== options.length) {
      select.replaceChildren(...options.map(([value, label]) => {
        const o = el('option', '', label);
        o.value = value;
        if (value) o.setAttribute('data-no-i18n', '');
        return o;
      }));
      select.value = chosen;
    }
    const status = F.$('call-route-status');
    if (!status || !routes) return;
    if (chosen && !routes.found) {
      status.replaceChildren(mine(el('span', '', chosen)), document.createTextNode(' '), el('span', '', 'isn’t connected right now.'));
    } else if (!(routes.routes || []).length) {
      status.textContent = 'No virtual audio device found. To speak into calls, install BlackHole or Loopback yourself, then choose it here.';
    } else {
      status.textContent = chosen ? '' : 'Off: I won’t speak into calls.';
    }
    status.hidden = !status.textContent;
  }

  function onPrefs(p) {
    if (!p) return;
    if (p.features) features = p.features;
    buildSettings();
    renderSettings();
    if (panel) render();
  }

  F.on('hello', (ev) => onPrefs(ev.prefs), { replay: true });
  F.on('prefs', onPrefs, { replay: true });
  // Settings › Meetings is made by proactive.js, which loads after this script.
  if (!buildSettings()) root.addEventListener('jarvis-features-ready', buildSettings, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
