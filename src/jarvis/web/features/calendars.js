// Settings › Calendars (features/wincalendar.py): the calendars Jarvis reads on a PC (on a Mac, the Calendar
// app is used and this page never appears: the backend doesn't answer). Jarvis keeps a calendar of its
// own, and reads the ones you already use from their "subscribe" links (Brightspace, Outlook on the web,
// Google Calendar), read only. The link goes to the backend once, straight to the system's secret store,
// and the field is cleared; it is never shown again. Every control has a label, the results are announced
// (role=status), and nothing needs a mouse.
(function (root) {
  'use strict';

  const lib = {
    // What to say about a list of calendars.
    summary(calendars) {
      const links = calendars.filter((c) => c.kind === 'feed').length;
      if (!links) return 'Jarvis’s own calendar only. Add a calendar link to read the one you already use.';
      return `Jarvis’s own calendar and ${links} ${links === 1 ? 'calendar link' : 'calendar links'}.`;
    },
    // A calendar link is a web address; the page says so before it goes anywhere.
    looksLikeLink(text) {
      return /^(https|webcal|webcals):\/\/\S+$/i.test(String(text || '').trim());
    },
    // One calendar's line: its name, what it is, and when it was last read, or what went wrong.
    line(calendar) {
      if (calendar.kind === 'outlook') return `Outlook on this PC, read only${calendar.error ? `: ${calendar.error}` : calendar.checked ? `, read ${calendar.checked.replace('T', ' ').slice(0, 16)}` : ''}`;
      if (calendar.kind !== 'feed') return `${calendar.title}, kept on this computer, you can add events to it`;
      if (calendar.error) return `${calendar.title}, a calendar link: ${calendar.error}`;
      return `${calendar.title}, a calendar link, read only${calendar.checked ? `, read ${calendar.checked.replace('T', ' ').slice(0, 16)}` : ''}`;
    },
  };
  root.jarvisCalendars = lib;

  const F = root.jarvisFeatures;
  if (!F || !root.document) return;
  const doc = root.document;
  const { el, send } = F;
  const t = (s) => F.t(s);

  let calendars = [];
  let outlook = { available: false, on: false };
  let group = null;
  const field = {};

  function labeled(id, label, note, input) {
    const row = el('label', 'row stack');
    row.setAttribute('for', id);
    const words = el('span');
    words.append(el('strong', '', t(label)));
    if (note) words.append(el('small', '', t(note)));
    input.id = id;
    row.append(words, input);
    return row;
  }

  const say = (text, bad = false) => {
    if (!field.result) return;
    field.result.textContent = text;
    field.result.classList.toggle('cal-bad', bad);
  };

  function drawList() {
    if (!field.list) return;
    field.summary.textContent = t(lib.summary(calendars));
    field.list.replaceChildren(...calendars.map((c) => {
      const li = el('li', 'cal-item');
      li.append(el('span', 'cal-name', lib.line(c)));
      if (c.kind === 'feed' || c.kind === 'outlook') {
        const refresh = el('button', 'btn', t('Read again'));
        refresh.type = 'button';
        refresh.setAttribute('aria-label', `${t('Read again')} ${c.title}`);
        refresh.addEventListener('click', () => { say(t('Reading it…')); send({ type: 'calendar_refresh', id: c.id }); });
        li.append(refresh);
        if (c.kind === 'feed') {  // (Outlook is switched off with its own switch, below)
          const remove = el('button', 'btn', t('Remove'));
          remove.type = 'button';
          remove.setAttribute('aria-label', `${t('Remove')} ${c.title}`);
          remove.addEventListener('click', () => {
            if (root.confirm(`${t('Remove')} ${c.title}? ${t('Nothing is deleted from the calendar itself.')}`)) send({ type: 'calendar_remove', id: c.id });
          });
          li.append(remove);
        }
      }
      return li;
    }));
  }

  function add() {
    const url = field.url.value.trim();
    if (!url) { say(t('Paste the calendar link first.'), true); field.url.focus(); return; }
    if (!lib.looksLikeLink(url)) { say(t('A calendar link is a web address that starts with https:// (or webcal://).'), true); field.url.focus(); return; }
    say(t('Reading the calendar…'));
    send({ type: 'calendar_add_feed', url, name: field.name.value.trim() });
    field.url.value = ''; // the link is a key to the calendar: it is not left on the page
  }

  function build() {
    const sheet = doc.getElementById('settings');
    if (!sheet || group) return;
    group = el('section', 'group');
    group.id = 'calendars-group';
    group.hidden = true; // until the backend answers (a Mac has the Calendar app instead)
    group.dataset.settingsPane = 'general';
    group.dataset.keywords = 'calendar calendars events schedule brightspace d2l outlook google ics subscribe link feed meetings appointments';
    group.append(el('h3', '', t('Calendars')));
    group.append(el('p', 'group-note', t('Jarvis keeps a calendar of its own on this computer, and can read the calendars you already use from their subscribe links. Those stay read only. The link is kept in the system’s password store and is never shown again.')));
    field.summary = el('p', 'small-status');
    field.summary.id = 'calendars-summary';
    field.list = el('ul', 'cal-list');
    field.list.id = 'calendars-list';
    field.list.setAttribute('aria-label', t('Your calendars'));
    group.append(field.summary, field.list);

    // Outlook for Windows (shown only on a PC that has it): its calendar, read while it is open.
    field.outlookRow = el('label', 'row cal-outlook');
    field.outlookRow.setAttribute('for', 'calendars-outlook');
    field.outlookRow.hidden = true;
    const outlookWords = el('span');
    outlookWords.append(el('strong', '', t('Read my Outlook calendar')), el('small', '', t('The Outlook program on this PC, while it is open. Jarvis only reads it; new events go on Jarvis’s own calendar.')));
    field.outlook = el('input');
    field.outlook.type = 'checkbox';
    field.outlook.id = 'calendars-outlook';
    field.outlook.addEventListener('change', () => { say(field.outlook.checked ? t('Reading Outlook…') : t('Stopping…')); send({ type: 'calendar_outlook', on: field.outlook.checked }); });
    field.outlookRow.append(outlookWords, field.outlook);
    group.append(field.outlookRow);

    const form = el('form', 'cal-form');
    form.id = 'calendars-form';
    form.autocomplete = 'off';
    form.setAttribute('aria-label', t('Add a calendar link'));
    form.append(el('h4', '', t('Add a calendar link')));
    field.url = el('input');
    field.url.type = 'text';
    field.url.autocomplete = 'off';
    field.url.spellcheck = false;
    field.url.setAttribute('inputmode', 'url');
    form.append(labeled('calendars-url', 'Calendar link', 'In Brightspace: Calendar, Subscribe, copy the link. In Outlook on the web: Settings, Calendar, Shared calendars, Publish a calendar, copy the ICS link. In Google Calendar: Settings, your calendar, Integrate calendar, Secret address in iCal format.', field.url));
    field.name = el('input');
    field.name.type = 'text';
    field.name.autocomplete = 'off';
    form.append(labeled('calendars-name', 'Name', 'Optional. What Jarvis calls it, such as Brightspace.', field.name));
    const actions = el('div', 'cal-actions');
    const submit = el('button', 'btn primary', t('Add calendar'));
    submit.type = 'submit';
    const all = el('button', 'btn', t('Read all again'));
    all.type = 'button';
    all.addEventListener('click', () => { say(t('Reading the calendars…')); send({ type: 'calendar_refresh' }); });
    actions.append(submit, all);
    form.append(actions);
    field.result = el('p', 'small-status');
    field.result.id = 'calendars-result';
    field.result.setAttribute('role', 'status');
    field.result.setAttribute('aria-live', 'polite');
    form.append(field.result);
    form.addEventListener('submit', (e) => { e.preventDefault(); add(); });
    group.append(form);

    const before = doc.getElementById('mail-group') || doc.getElementById('a11y-group');
    if (before) before.after(group);
    else (sheet.querySelector('.group') || sheet.lastElementChild).before(group);
  }

  F.on('calendars', (ev) => {
    calendars = Array.isArray(ev.calendars) ? ev.calendars : [];
    outlook = ev.outlook && typeof ev.outlook === 'object' ? ev.outlook : { available: false, on: false };
    build();
    group.hidden = false;
    field.outlookRow.hidden = !outlook.available;
    field.outlook.checked = Boolean(outlook.on);
    drawList();
  }, { replay: true });

  F.on('calendar_result', (ev) => {
    if (!field.result) return;
    say(ev.text || '', !ev.ok);
    if (ev.ok && ev.added && field.name) { field.name.value = ''; field.url.focus(); }
  });

  const hello = () => send({ type: 'calendars_status' });
  F.on('hello', hello);
  hello();
  const mount = () => build();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount); else mount();
  lib.state = () => ({ calendars });
})(typeof window !== 'undefined' ? window : globalThis);
