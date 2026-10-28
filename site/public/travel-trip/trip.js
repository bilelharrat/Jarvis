// A trip shared with the people on it (src/travel/triplink.js): the plan as it is now, each day's stops with what was
// checked and where it came from, the day's map, a calendar file. Read-only; looks again every 5 minutes. Text from the
// trip is shown as text, never as markup.
const code = location.pathname.split('/')[2];
const root = document.getElementById('trip');
const S = { data: null, day: 0, err: '' };

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
};
const dayLong = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`);
const KIND = { stay: 'Stay', transport: 'Getting there', rental: 'Rental', activity: 'Activity', meal: 'Meal', visit: '' };

async function load() {
  try {
    const res = await fetch(`/t/${code}/data`);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'This trip link has ended.');
    S.data = out.trip; S.err = '';
    const today = new Date().toISOString().slice(0, 10);
    if (S.day === 0) { const i = S.data.days.findIndex((d) => d.date === today); if (i > 0) S.day = i; }
  } catch (e) { S.err = String(e.message || e); }
  paint();
}

function check(name, c) {
  if (!c || !c.text) return null;
  const when = c.checked_at ? ` · ${String(c.checked_at).slice(0, 16).replace('T', ' ')} UTC` : '';
  return el('div', { class: `tp-check${c.status === 'warn' ? ' warn' : ''}` }, `${name}: ${c.text}`, c.source ? el('small', {}, `${c.source}${when}`) : c.status === 'sample' ? el('small', {}, 'Sample data: not checked') : null);
}

function paint() {
  if (S.err && !S.data) { root.replaceChildren(el('p', { class: 'tp-note' }, S.err)); return; }
  const t = S.data;
  const d = t.days[S.day] || t.days[0];
  const pts = d.stops.filter((s) => Number.isFinite(s.place.lat) && Number.isFinite(s.place.lng)).map((s) => `${s.place.lat},${s.place.lng}`);
  const alerts = t.alerts.filter((a) => a.day === S.day);
  document.title = `${t.title} · Ask Eden Travel`;
  root.replaceChildren(
    el('header', { class: 'tp-head' }, el('span', { class: 'tp-kicker' }, 'A shared trip'), el('h1', {}, t.title),
      el('div', { class: 'tp-meta' }, `${dayLong(t.days[0].date)} – ${dayLong(t.days[t.days.length - 1].date)} · ${t.days.length} days · ${t.travelers} ${t.travelers === 1 ? 'traveller' : 'travellers'}`)),
    el('nav', { class: 'tp-days', 'aria-label': 'Days' }, ...t.days.map((x, i) => el('button', { type: 'button', 'aria-pressed': String(i === S.day), onclick: () => { S.day = i; paint(); } }, `Day ${i + 1} · ${dayLong(x.date)}`))),
    ...alerts.map((a) => el('div', { class: 'tp-alert', role: 'note' }, a.text)),
    el('section', { class: 'tp-card tp-day' },
      el('h2', {}, d.title || `Day ${S.day + 1}`),
      el('ol', { class: 'tp-stops' }, ...d.stops.map((s) => el('li', { class: 'tp-stop' },
        el('span', { class: 'tp-time' }, s.at),
        el('div', {}, el('b', {}, s.place.name),
          el('div', { class: 'tp-meta' }, [KIND[s.kind], hm(s.minutes), s.nights ? `${s.nights} nights` : null, s.booked ? 'Booked' : null].filter(Boolean).join(' · ')),
          check('Getting there', s.travel), check('Hours', s.hours)))))),
    pts.length ? el('img', { class: 'tp-map', alt: `Map of Day ${S.day + 1}`, src: `/t/${code}/map?day=${S.day}` }) : null,
    el('div', { class: 'tp-acts' }, el('a', { class: 'tp-btn', href: `/t/${code}/calendar.ics`, download: 'trip.ics' }, 'Add to my calendar')),
    el('p', { class: 'tp-note' }, `Shared by the trip’s organiser. This page always shows the trip as it is now${t.checked_at ? `, last checked ${String(t.checked_at).slice(0, 16).replace('T', ' ')} UTC` : ''}.`));
}

load();
setInterval(load, 5 * 60_000);
