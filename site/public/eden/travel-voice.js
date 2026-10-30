// "Hey Eden" in Eden Travel: a mic on the trip that answers out loud from the trip's own checks. The traveller asks
// ("when do I need to leave?", "what's open near me?", "how long to the hotel?", "is the museum open tomorrow?") and
// hears the answer in Eden's voice (POST /api/chat/voice, as Read aloud does; the browser's own voice if that fails),
// shown as text with each fact's source and when it was checked. Leave-by and travel times come from the trip's
// checked legs (the same numbers as Today), hours from the stop's hours check, Near me from the trip's `nearby` action
// (travel-more.js). Nothing else is answered here: a question it can't answer from a check says so, and anything that
// isn't a trip question goes to Ask Eden with the trip named (travel.js ask). Listening is the browser's speech
// recognition, else the mic and POST /api/chat/transcribe (edu-a11y.js listenOnce); the microphone is asked for only
// on a press. No wake phrase: Eden's voice on the web has none. Not in the Eden iPhone app (no microphone or sound
// there, voice.js) nor, for now, the Eden Travel app.
//
// No static imports and nothing done at load, so the tests load this file as it is served (the intent matching and
// the answers are pure); init() loads the page modules it needs.

/* ---------- what was asked (pure) ---------- */

// lower case, no accents or punctuation, "hey eden" dropped
export function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:hey|hi|ok|okay|dis|bonjour|salut)\s+)?eden\b[\s,]*/, '').trim();
}

const NEAR_STRONG = /\b(near me|nearby|near here|around here|around me|close by|close to me|in the area|walking distance|pres de moi|pres d ici|a proximite|autour de moi|dans le coin|dans le quartier)\b/;
const NEAR_WEAK = /\b(what'?s open|what is open|anything open|where can (?:i|we) (?:eat|get|grab|drink|have)|somewhere to (?:eat|drink)|i'?m hungry|we'?re hungry|qu'?est ce qui est ouvert|quoi d'?ouvert|ou (?:manger|boire|prendre)|j'?ai faim|on a faim)\b/;
const LEAVE = /\b(?:(?:when|what time)\b.*\b(?:leave|go|head out|set off|get going|be off)|leave by|need to leave|have to leave|should (?:i|we) leave|quand\b.*\b(?:partir|y aller|sortir|quitter)|a quelle heure\b.*\b(?:partir|y aller|sortir|quitter)|(?:dois|devons|doit|faut)[\w' ]{0,12}partir)\b/;
const HOURS = /\b(open|opens|opening|close|closes|closing|closed|hours|ouvert|ouverte|ouverts|ouvre|ouvrent|ferme|fermee|fermes|horaires|heures d'?ouverture)\b/;
const TO_PLACE = /\b(how long|how far|how do (?:i|we) get|how to get|get (?:back )?to|distance|travel time|journey to|combien de temps|a quelle distance|comment (?:aller|rentrer|aller a|se rendre)|jusqu'?a|pour aller|pour rentrer|trajet)\b/;
const NEXT = /\b(what'?s next|what is next|next stop|what'?s on|what is on|what'?s the plan|plan for today|today'?s plan|where (?:am i|are we) going|what now|et ensuite|prochaine (?:etape|activite)|programme|qu'?est ce qu'?on fait|on fait quoi)\b/;

const KIND_WORDS = [
  ['eat', /\b(eat|food|restaurants?|lunch|dinner|breakfast|brunch|hungry|bite|manger|faim|dejeuner|diner|resto|restaurant)\b/],
  ['drink', /\b(drinks?|bars?|pubs?|coffee|cafes?|beer|wine|boire|biere|vin|verre|apero)\b/],
  ['see', /\b(see|sights?|museums?|visit|voir|musees?|visiter)\b/],
  ['do', /\b(things to do|activit\w*|a faire)\b/],
];
const WALKS = [10, 15, 20, 30];

const WD_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
// which day the question is about: { offset } from today, { weekday }, { tripDay } (0-based), or null
export function whenOf(t) {
  if (/\b(today|tonight|now|this (?:morning|afternoon|evening)|aujourd'?hui|ce soir|maintenant|ce matin|cet apres midi)\b/.test(t)) return { offset: 0 };
  if (/\b(day after tomorrow|apres demain)\b/.test(t)) return { offset: 2 };
  if (/\b(tomorrow|demain)\b/.test(t)) return { offset: 1 };
  const d = /\b(?:day|jour)\s+(\d{1,2})\b/.exec(t);
  if (d) return { tripDay: Number(d[1]) - 1 };
  for (let i = 0; i < 7; i++) if (new RegExp(`\\b(${WD_EN[i]}|${WD_FR[i]})\\b`).test(t)) return { weekday: i };
  return null;
}

// the words that aren't about the question itself: what's left names the place
const FILLER = new Set(("a an and are as at be by can could do does for from get go going how i i'm is it it's its me my need of on or our please "
  + "should tell that the there this to us was we what what's when where which will with would you your long far time open opens opening close closes closing "
  + "closed hours today tomorrow tonight now leave leaving head set off get back still yet till until usually going there here right "
  + "le la les l' un une des du de d' au aux a est il elle est-ce ce que qu' qui quand quelle quel combien temps pour aller rentrer jusqu' "
  + "jusqu'a ouvert ouverte ouvre ferme fermee horaires heures demain aujourd'hui maintenant partir je j' on nous mon ma mes notre nos y "
  + "sont faut dois-je dois devons-nous il-y-a se rendre comment est-il est-elle encore trajet distance heure").split(' '));
FILLER.add('');
export function placeWords(t) {
  const stripped = t.replace(/\b(?:hey|ok|okay|dis)\s+eden\b/g, ' ').replace(/\b(?:day|jour)\s+\d{1,2}\b/g, ' ')
    .replace(new RegExp(`\\b(${[...WD_EN, ...WD_FR].join('|')})\\b`, 'g'), ' ').replace(/\bday after tomorrow\b|\bapres demain\b/g, ' ');
  return stripped.split(' ').map((w) => w.replace(/^(?:l|d|qu|j|jusqu)'/, '').replace(/'s$/, '')).filter((w) => !FILLER.has(w) && w.length > 1);
}

/**
 * What a spoken question asks: { kind, place, when, nearKind, walk, said }. kind is 'leave', 'near', 'hours',
 * 'to_place', 'next' or 'ask' (anything else, for Ask Eden). `place` is the words that name a stop ('' when none).
 */
export function matchIntent(said) {
  const t = norm(said);
  const out = { kind: 'ask', place: '', when: whenOf(t), nearKind: null, walk: null, said: String(said || '').trim() };
  if (!t) return out;
  const words = placeWords(t).join(' ');
  const strong = NEAR_STRONG.test(t);
  if (LEAVE.test(t) && !strong) out.kind = 'leave';
  else if (strong) out.kind = 'near';
  else if (HOURS.test(t) && words) out.kind = 'hours';
  else if (TO_PLACE.test(t) && words) out.kind = 'to_place';
  else if (NEXT.test(t)) out.kind = 'next';
  else if (NEAR_WEAK.test(t) || (HOURS.test(t) && !words)) out.kind = 'near';
  if (out.kind === 'near') {
    const k = KIND_WORDS.find(([, re]) => re.test(t));
    out.nearKind = k ? k[0] : null;
    const m = /\b(\d{1,2})\s*(?:min|mins|minutes?)\b/.exec(t);
    if (m) out.walk = WALKS.reduce((a, b) => (Math.abs(b - Number(m[1])) < Math.abs(a - Number(m[1])) ? b : a));
  } else if (out.kind !== 'ask' && out.kind !== 'next') {
    // "leave for the airport", "how long to the hotel", "is the museum open": the stop's words
    const aim = /\b(?:for|to|pour)\b/.exec(t); // "leave for the airport": only what comes after "for"
    out.place = out.kind === 'leave' ? (aim ? placeWords(t.slice(aim.index + aim[0].length)).join(' ') : '') : words;
  }
  return out;
}

/* ---------- the trip's own data (pure) ---------- */

const HOW = { walk: 'walk', transit: 'by public transport', drive: 'drive', taxi: 'by taxi' };
const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (m) => `${pad(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad(((m % 60) + 60) % 60)}`;
const span = (n) => (n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${pad(n % 60)} min` : ''}` : `${n} min`);
const dayLong = (date) => (date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const dayName = (date) => (!date ? 'that day' : new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }));

// each stop's time in the day's minutes; one earlier than the stop before is after midnight (as travel.js companion)
export function stopMinutes(stops) {
  let prev = -1;
  return stops.map((s) => { const [h, m] = String(s.at || '').split(':').map(Number); let v = h * 60 + m; if (!Number.isFinite(v)) return NaN; if (v < prev) v += 1440; prev = v; return v; });
}

/** The checked leg into stop k of a day: its own travel check, or for the first stop the leg from where you sleep. */
export function legInto(c, k, stop) {
  const b = c && c.stops && c.stops[k] && c.stops[k].badges;
  if (b && b.travel) return { ...b.travel, from: null };
  const a = c && c.anchor;
  if (a && a.out && a.to === stop.id) return { ...a.out, from: a.stay, text: a.out.text || '' };
  return null;
}
const usable = (leg) => leg && Number.isFinite(leg.minutes) && leg.status !== 'unknown';
const fromOf = (leg) => leg.from || ((/ from (.+?)(?::|$)/.exec(leg.text || '') || [])[1] || '').replace(/\.$/, '');
const srcOf = (what, x) => ({ what, source: x.source || null, checked_at: x.checked_at || null, sample: x.status === 'sample' });
const SAMPLE = 'This is sample data, not a real check. ';

// a stop's words, for matching what was said ("the hotel" finds the stay; "the museum" the stop with Museum in its name)
const KIND_SAID = { stay: /\b(hotel|hotels|stay|accommodation|apartment|airbnb|hostel|room|hotel's|hebergement|appartement|chambre|logement)\b/, transport: /\b(airport|flight|train|station|ferry|bus|aeroport|vol|gare)\b/, meal: /\b(dinner|lunch|breakfast|restaurant|meal|diner|dejeuner|repas)\b/ };
const stem = (w) => w.replace(/(?:es|s)$/, '').replace(/^muse(?:um|e|u|o)$/, 'muse');
/** The trip's stops that what was said names, best first: [{ di, k, stop, check, date, score }]. */
export function findStops(data, words) {
  const said = norm(words);
  if (!said || !data || !data.trip) return [];
  const want = said.split(' ').map(stem).filter(Boolean);
  const out = [];
  data.trip.days.forEach((d, di) => d.stops.forEach((s, k) => {
    const name = norm(s.place && s.place.name).split(' ').map(stem);
    let score = want.filter((w) => w.length > 2 && name.includes(w)).length * 2;
    if (KIND_SAID[s.kind] && KIND_SAID[s.kind].test(said)) score += 3;
    if (score > 0) out.push({ di, k, stop: s, check: (data.checks && data.checks.days[di]) || { stops: [] }, date: data.checks && data.checks.days[di] && data.checks.days[di].date, score });
  }));
  return out.sort((a, b) => b.score - a.score);
}

/** The date a `when` means, from `now` and the trip's days (null: not said). */
export function dateOf(when, data, now) {
  if (!when) return null;
  if (when.tripDay !== undefined) return (data.checks.days[when.tripDay] || {}).date || null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (when.offset !== undefined) d.setDate(d.getDate() + when.offset);
  else if (when.weekday !== undefined) d.setDate(d.getDate() + ((when.weekday - d.getDay() + 7) % 7));
  return isoDay(d);
}

// of several stops that match, the one on the day asked about, else the next one from today, else the first
function pick(found, date, today) {
  if (!found.length) return null;
  const top = found.filter((f) => f.score === found[0].score);
  return (date && top.find((f) => f.date === date)) || top.find((f) => f.date && f.date >= today) || top[0];
}

function todayOf(data, now) {
  const today = isoDay(now);
  const days = data.checks.days;
  const di = days.findIndex((x) => x.date === today);
  return { today, di, before: di < 0 && days[0] && today < days[0].date, nowMin: now.getHours() * 60 + now.getMinutes() };
}

const notToday = (data, T) => (T.before
  ? `Your trip starts ${dayLong(data.checks.days[0].date)}. Leave-by times start that day.`
  : 'Today isn’t a day of this trip.');
const UNCHECKED = 'I don’t have that checked.';

function leaveFor(f, nowMin, isToday) {
  const s = f.stop;
  const mins = stopMinutes(f.dayStops || [s])[f.dayStops ? f.k : 0];
  if (!Number.isFinite(mins)) return { text: `${s.place.name} has no time in the plan, so I can’t give a leave-by time.`, sources: [], unchecked: true };
  const leg = legInto(f.check, f.k, s);
  if (!usable(leg)) return { text: `${s.place.name} is at ${s.at}. I don’t have the travel time to it checked, so I can’t give a leave-by time.`, sources: [], unchecked: true };
  const leave = mins - leg.minutes;
  const from = fromOf(leg);
  let text = `Leave by ${clock(leave)} for ${s.place.name} at ${s.at}: ${leg.minutes} min ${HOW[leg.mode] || ''}${from ? ` from ${from}` : ''}.`.replace(/ +:/, ':').replace(/ +\./, '.');
  if (isToday) { const left = leave - nowMin; text += left > 0 ? ` That’s in ${span(left)}.` : left === 0 ? ' That’s now.' : ` That was ${span(-left)} ago.`; }
  return { text: (leg.status === 'sample' ? SAMPLE : '') + text, sources: [srcOf('Travel time', leg)] };
}

/**
 * The answer to a matched question from the trip's own checks (S.data: { trip, checks }), at `now`:
 * { text, sources: [{ what, source, checked_at, sample }], need?: 'nearby' | 'ask', unchecked?: true }.
 * Nothing is said that isn't in a check; when it isn't, the answer says so (unchecked) and offers Ask Eden.
 */
export function answerFromTrip(intent, data, now = new Date()) {
  if (!data || !data.trip || !data.checks) return { text: UNCHECKED, sources: [], unchecked: true };
  if (intent.kind === 'ask') return { text: '', sources: [], need: 'ask' };
  if (intent.kind === 'near') return { text: '', sources: [], need: 'nearby' };
  const T = todayOf(data, now);
  const date = dateOf(intent.when, data, now);
  const withDay = (f) => (f ? { ...f, dayStops: data.trip.days[f.di].stops } : f);

  if (intent.kind === 'leave' || intent.kind === 'next') {
    if (intent.place) {
      const f = withDay(pick(findStops(data, intent.place), date, T.today));
      if (!f) return noStop(intent.place);
      return leaveFor(f, T.nowMin, f.date === T.today);
    }
    if (T.di < 0) return { text: notToday(data, T), sources: [] };
    const d = data.trip.days[T.di], c = data.checks.days[T.di] || { stops: [] };
    if (!d.stops.length) return { text: 'Nothing is planned for today.', sources: [] };
    const mins = stopMinutes(d.stops);
    const k = mins.findIndex((v) => v >= T.nowMin);
    if (k < 0) return { text: 'Today’s last stop is behind you.', sources: [] };
    const f = { di: T.di, k, stop: d.stops[k], check: c, date: c.date, dayStops: d.stops };
    if (intent.kind === 'next') {
      const l = leaveFor(f, T.nowMin, true);
      return { text: `Next: ${d.stops[k].place.name} at ${d.stops[k].at}.${l.unchecked ? '' : ` ${l.text}`}`, sources: l.sources };
    }
    return leaveFor(f, T.nowMin, true);
  }

  if (intent.kind === 'hours') {
    const f = pick(findStops(data, intent.place), date, T.today);
    if (!f) return noStop(intent.place);
    const s = f.stop, h = f.check.stops && f.check.stops[f.k] && f.check.stops[f.k].badges && f.check.stops[f.k].badges.hours;
    if (!h || !h.source || h.status === 'unknown') return { text: `I don’t have ${s.place.name}’s hours checked.${h && h.text ? ` ${h.text}` : ''}`, sources: [], unchecked: true };
    const said = /^(open|closed)\b/.test(h.text) ? `${s.place.name} is ${h.text}` : `${s.place.name}: ${h.text}`;
    const plan = ` It’s in your plan on Day ${f.di + 1}, ${dayLong(f.date)}, at ${s.at}.`;
    // hours are checked for the day the stop is planned: another day asked about isn't checked
    const other = date && f.date && f.date !== date ? `I only have its hours checked for ${dayName(f.date)}, when it’s in your plan, not for ${date === T.today ? 'today' : dayName(date)}. ` : '';
    return { text: (h.status === 'sample' ? SAMPLE : '') + other + said + plan, sources: [srcOf('Hours', h)], ...(other ? { unchecked: true } : {}) };
  }

  if (intent.kind === 'to_place') {
    const found = findStops(data, intent.place);
    const f = withDay(pick(found, date, T.today));
    if (!f) return noStop(intent.place);
    const s = f.stop;
    // where you sleep, asked on a day of the trip: the day's checked way back from its last stop
    const dayI = s.kind === 'stay' && T.di >= 0 ? T.di : f.di;
    const a = data.checks.days[dayI] && data.checks.days[dayI].anchor;
    if (s.kind === 'stay' && a && a.back && usable(a.back)) {
      const last = data.trip.days[dayI].stops.find((x) => x.id === a.from);
      return { text: `${(a.back.status === 'sample' ? SAMPLE : '')}${a.stay} is ${a.back.minutes} min ${HOW[a.back.mode] || ''} from ${last ? last.place.name : 'the day’s last stop'}, your last stop ${dayI === T.di ? 'today' : `on Day ${dayI + 1}`}. That’s from the plan, not from where you are now.`.replace(/ +from/, ' from'), sources: [srcOf('Travel time', a.back)] };
    }
    const leg = legInto(f.check, f.k, s);
    if (!usable(leg)) return { text: `I don’t have the travel time to ${s.place.name} checked.`, sources: [], unchecked: true };
    const from = fromOf(leg);
    return { text: `${leg.status === 'sample' ? SAMPLE : ''}${s.place.name} is ${leg.minutes} min ${HOW[leg.mode] || ''}${from ? ` from ${from}` : ''}, the stop before it on Day ${f.di + 1}. That’s from the plan, not from where you are now.`.replace(/ +,/, ',').replace(/ +from/, ' from'), sources: [srcOf('Travel time', leg)] };
  }
  return { text: UNCHECKED, sources: [], unchecked: true };
}

const noStop = (words) => ({ text: `“${words}” isn’t a stop on this trip, so I haven’t checked it.`, sources: [], unchecked: true });

const KIND_NAME = { eat: 'to eat', drink: 'for a drink', see: 'to see', do: 'to do' };
/** Near me's answer from the `nearby` action's result (site discover.js): the three closest, how far, when they close. */
export function nearbyAnswer(r, { kind = 'eat', minutes = 15, where = 'you' } = {}) {
  if (!r || r.error) return { text: r && r.error ? String(r.error) : UNCHECKED, sources: [], unchecked: true };
  const what = KIND_NAME[kind] || '';
  const places = r.places || [];
  const src = [{ what: 'Open now and walking time', source: r.source || null, checked_at: r.checked_at || null, sample: Boolean(r.standin) }];
  if (!places.length) return { text: `Nothing open ${what} within a ${minutes}-minute walk of ${where}, as Google has it.`, sources: src };
  const closes = (p) => { if (!p.closes_at) return ''; const d = new Date(p.closes_at); return Number.isFinite(d.getTime()) ? `, closes ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };
  const list = places.slice(0, 3).map((p) => `${p.name}, ${p.walk_minutes >= 1 ? `${p.walk_minutes} min walk` : 'under a minute’s walk'}${p.open_now ? closes(p) : ''}`).join('; ');
  return { text: `${r.standin ? 'Sample places, not checked: ' : `Open now ${what} within a ${minutes}-minute walk of ${where}: `}${list}.`, sources: src };
}

/* ---------- on the page ---------- */

let C = null; // { S, paint, ask, tripRef, call } from travel.js (call: the trip's or the shared trip's action, as travel-more.js)
let U = null; // the page modules, loaded by init: util, api, edu-a11y, trip-ui, voice-text
const V = { listening: null, busy: false, answer: null, typed: '', speaking: null };
const ON_PHONE_APP = () => typeof navigator !== 'undefined' && /\bEden(?:Travel)?App\//.test(navigator.userAgent || '');
const PREF = 'travel:voice';
const T = (x) => (globalThis.edenI18n ? globalThis.edenI18n.t(x) : x);

export function init(ctx) {
  C = ctx;
  if (U || ON_PHONE_APP()) return;
  Promise.all([import('./util.js'), import('./api.js'), import('./edu-a11y.js'), import('./trip-ui.js'), import('./voice-text.js')])
    .then(([util, api, a11y, tripUi, vt]) => {
      U = { ...util, ...api, ...a11y, tripPost: tripUi.tripPost, chunkText: vt.chunkText };
      if (!document.querySelector('link[href$="travel-voice.css"]')) document.head.append(util.el('link', { rel: 'stylesheet', href: 'travel-voice.css' }));
      addEventListener('keydown', (e) => { if (e.key === 'Escape' && (V.speaking || V.listening)) { stopAll(); C.paint(); } });
      C.paint();
    }, () => {});
}

const can = () => Boolean(U && C && C.S && C.S.data && !ON_PHONE_APP());
const speakOn = () => !(U && U.store.get(PREF, {}).quiet);

/** The mic: press, ask out loud, hear the answer. Null in the phone apps and until the page modules have loaded. */
export function voiceButton() {
  if (!can()) return null;
  const { el } = U;
  const on = Boolean(V.listening);
  return el('button', { type: 'button', class: `tv-pill tv-voice-mic${on ? ' on' : ''}`, 'data-k': 'voice:mic', 'aria-pressed': String(on),
    title: on ? 'Listening. Press to stop' : 'Ask about your trip out loud: when to leave, what’s open near you, how long to the hotel',
    disabled: V.busy ? '' : null, onclick: () => (on ? V.listening.stop() : canListen() ? listen() : typeInstead()) },
  micIcon(), on ? 'Listening…' : V.busy ? 'Checking…' : 'Ask out loud');
}

/** The answer card (null when there's none): what was heard, the answer, its sources, and a typed question for anyone
 *  who can't or won't speak. The lead puts it right after the section holding voiceButton(). */
export function voiceAnswer() {
  if (!can()) return null;
  const { el, ico } = U;
  const a = V.answer;
  const field = el('input', { type: 'text', class: 'tv-input small', 'data-k': 'f:voice-typed', 'aria-label': 'Or type your question', placeholder: 'Or type it: when do I need to leave?', enterkeyhint: 'send' });
  field.value = V.typed;
  field.oninput = () => { V.typed = field.value; };
  field.onkeydown = (e) => { if (e.key === 'Enter' && field.value.trim()) { e.preventDefault(); const q = field.value; V.typed = ''; askTrip(q); } };
  if (!a && !V.open) return null;
  return el('section', { class: 'glass-card tv-voice', 'aria-label': 'Asked out loud' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', 'Asked out loud'),
      el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close', 'data-k': 'voice:close', onclick: () => { stopAll(); V.answer = null; V.open = false; C.paint(); } }, ico('x', 14))),
    a ? el('p', 'tv-voice-q', el('span', 'sr-only', 'You asked: '), `“${a.said}”`) : null,
    a && a.text ? el('p', 'tv-voice-a', ...sentences(a.text).map((x) => el('span', '', `${x} `))) : null,
    a && a.sources && a.sources.length ? el('ul', 'tv-voice-src', ...a.sources.map((s) => el('li', 'tv-fine', sourceLine(s)))) : null,
    el('div', 'tv-acts',
      a && (a.unchecked || a.need === 'ask') && !a.asked ? el('button', { type: 'button', class: 'tv-btn', 'data-k': 'voice:ask', onclick: () => toAskEden(a.said) }, 'Ask Eden instead') : null,
      V.speaking ? el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': 'voice:stop', onclick: () => { stopAll(); C.paint(); } }, 'Stop speaking') : null,
      el('button', { type: 'button', class: 'tv-pill', 'data-k': 'voice:quiet', 'aria-pressed': String(speakOn()), title: 'Read answers aloud in Eden’s voice', onclick: () => { U.store.set(PREF, { quiet: speakOn() }); if (!speakOn()) stopAll(); C.paint(); } }, 'Read answers aloud')),
    el('div', 'tv-acts', field));
}

/** An answer's sentences: each one is drawn (and translated, i18n-fr-travel.js) on its own. */
export const sentences = (text) => String(text || '').split(/(?<=[.!?])\s+(?=[A-Z“])/).filter(Boolean);
const spokenOf = (text) => sentences(text).map(T).join(' ');

export function sourceLine(s) {
  const at = s.checked_at ? new Date(s.checked_at) : null;
  const when = at && Number.isFinite(at.getTime()) ? at.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  return `${s.what}: ${s.sample ? 'sample data, not checked' : s.source ? `${s.source}${when ? ` · checked ${when}` : ''}` : when ? `checked ${when}` : 'checked'}`;
}

const canListen = () => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition || (navigator.mediaDevices && window.MediaRecorder));
// no way to listen here (or no connection for the transcription): the typed question, focused
function typeInstead(msg = 'This browser can’t listen. Type your question instead.') {
  V.open = true;
  U.announce(T(msg));
  C.paint();
  const f = C.S.pane && C.S.pane.querySelector('[data-k="f:voice-typed"]');
  if (f) f.focus();
}

function micIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round');
  svg.innerHTML = '<rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4"/><path d="M3.3 7.6a4.7 4.7 0 0 0 9.4 0M8 12.4v2"/>'; // index.html's Dictate mic
  return svg;
}

async function listen() {
  if (!can() || V.listening) return;
  stopSpeaking();
  if (!navigator.onLine && !(window.SpeechRecognition || window.webkitSpeechRecognition)) return typeInstead('Listening needs a connection here. Type your question instead.');
  const session = U.listenOnce({ transcribeUrl: U.apiUrl('/api/chat/transcribe'), maxMs: 8000 });
  V.listening = session;
  U.announce(T('Listening. Ask about your trip.'));
  C.paint();
  let heard = '';
  try { heard = await session.done; } catch (e) { V.listening = null; V.open = true; U.announce(T(String(e.message || e))); U.toast(T(String(e.message || e))); C.paint(); return; }
  V.listening = null;
  if (!heard) { V.open = true; U.announce(T('I didn’t hear a question. Try again, or type it.')); C.paint(); return; }
  await askTrip(heard);
}

/**
 * The text path (what the mic does once it has heard words; also for typing and for page JS):
 * answers from the trip's checks, Near me through the `nearby` action, anything else through Ask Eden.
 * Resolves to the answer shown ({ said, text, sources, ... }).
 */
export async function askTrip(said, { now = new Date(), position = null } = {}) {
  if (!can()) return null;
  const S = C.S;
  const intent = matchIntent(said);
  V.open = true;
  let a = answerFromTrip(intent, S.data, now);
  if (a.need === 'nearby') { V.busy = true; C.paint(); a = await nearMe(intent, position); V.busy = false; }
  if (a.need === 'ask') { toAskEden(intent.said); return V.answer; }
  V.answer = { said: intent.said, intent: intent.kind, ...a };
  C.paint();
  const spoken = spokenOf(a.text);
  U.announce(spoken);
  if (speakOn()) speak(spoken);
  return V.answer;
}

function toAskEden(said) {
  const trip = C.S.data.trip;
  V.answer = { said, text: T('I’ve asked Eden in the chat.'), sources: [], need: 'ask', asked: true };
  C.paint();
  U.announce(V.answer.text);
  C.ask(`About ${C.tripRef(trip)}: ${said}`);
}

function where(position) {
  if (position) return Promise.resolve(position);
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'you' }), () => res(null), { timeout: 10_000, maximumAge: 60_000 });
  });
}

async function nearMe(intent, position) {
  const S = C.S;
  const D = S.disc || {};
  const kind = intent.nearKind || D.nearKind || 'eat';
  const minutes = intent.walk || D.minutes || 15;
  let at = await where(position);
  let note = '';
  if (!at) {
    // no location shared: near today's next stop that's on the map, said as such
    const T0 = todayOf(S.data, new Date());
    const d = S.data.trip.days[T0.di >= 0 ? T0.di : S.day] || { stops: [] };
    const mins = stopMinutes(d.stops);
    const next = d.stops.find((s, k) => Number.isFinite(s.place && s.place.lat) && (T0.di < 0 || mins[k] >= T0.nowMin)) || d.stops.find((s) => Number.isFinite(s.place && s.place.lat));
    if (!next) return { text: 'Location wasn’t shared, so I can’t look near you.', sources: [], unchecked: true };
    at = { lat: next.place.lat, lng: next.place.lng, label: next.place.name };
    note = 'Location wasn’t shared, so I looked near your next stop. ';
  }
  try {
    const args = { lat: at.lat, lng: at.lng, kind, minutes };
    const r = S.member ? await U.tripPost('shared-nearby', { owner: S.member.owner, trip: S.member.trip, ...args }) : await U.tripPost('nearby', { id: S.id, ...args });
    const a = nearbyAnswer(r, { kind, minutes, where: at.label });
    return { ...a, text: note + a.text };
  } catch (e) { return { text: String(e.message || e), sources: [], unchecked: true }; }
}

/* ---------- speaking ---------- */

// Eden's voice (POST /api/chat/voice, a sentence-sized WAV each, as voice.js reads replies), else the browser's
let actx = null;
function stopSpeaking() { if (V.speaking) { const s = V.speaking; V.speaking = null; s(); } }
function stopAll() { stopSpeaking(); if (V.listening) V.listening.stop(); }

function speak(text) {
  stopSpeaking();
  if (!text) return;
  const ctrl = new AbortController();
  let src = null, browserStop = null, over = false;
  const end = () => { if (over) return; over = true; if (V.speaking === stop) { V.speaking = null; C.paint(); } };
  const stop = () => { over = true; ctrl.abort(); if (src) { try { src.stop(); } catch { /* not started */ } } if (browserStop) browserStop(); };
  V.speaking = stop;
  C.paint();
  const fallback = () => { if (!over) browserStop = U.readAloud(text, { onend: end }); };
  (async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return fallback();
    actx = actx || new AC();
    if (actx.state === 'suspended') await actx.resume().catch(() => {});
    const pieces = U.chunkText(text);
    const fetchOne = (t) => U.rawFetch('/api/chat/voice', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify({ text: t }), signal: ctrl.signal })
      .then((r) => { if (!r.ok) throw new Error(`voice ${r.status}`); return r.arrayBuffer(); }).then((b) => actx.decodeAudioData(b));
    let next = fetchOne(pieces[0]);
    for (let i = 0; i < pieces.length; i++) {
      let buf;
      try { buf = await next; } catch { return i === 0 ? fallback() : end(); }
      if (over) return;
      if (i + 1 < pieces.length) { next = fetchOne(pieces[i + 1]); next.catch(() => {}); }
      await new Promise((res) => { src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination); src.onended = res; src.start(); });
      if (over) return;
    }
    end();
  })();
}
