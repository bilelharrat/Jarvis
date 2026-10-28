// askeden.com/travel/accuracy: how often Eden Travel's checks turned out wrong, for everyone, from the global index's
// anonymous monthly counts (accuracy.js, the account namespace's object `tacc:global`). Counts only reach this page: no
// place, no trip, no account.
//
//   GET /travel/accuracy        the page (Paper look, DESIGN.md §5): per check kind and source, the last 12 months,
//                               checks shown, reported wrong, changed after checking, rates with their sample sizes,
//                               and the method in plain words. No script.
//   GET /travel/accuracy.json   the same numbers as data (rates null under ACCURACY.minShown checks)
//   GET /travel/accuracy.css    its stylesheet (here, so the page needs nothing in public/)
//
// Only with EDEN_TRAVEL=1 (as every travel route); otherwise null (not ours). Public, cached at the edge for an hour
// (caches.default, so the global object is read at most hourly per place); a failed read is never cached.
// noindex until the owner says go: TRAVEL_ACCURACY_INDEX = "1" lets search engines in.

import { ACCURACY, CHECK_KINDS, GLOBAL, SOURCE_NAMES, monthOf } from './accuracy.js';
import { travelOn } from './api.js';
import { ask } from './track.js';
import { page, withHeaders } from '../eden/web.js';

export const ACC_PAGE = { cacheS: 3600, months: ACCURACY.months, min: ACCURACY.minShown };
export const ACC_PATHS = ['/travel/accuracy', '/travel/accuracy.json', '/travel/accuracy.css'];
// Google Fonts for the serif and sans (as the Paper sites have); no script at all
export const ACC_CSP = "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NOINDEX = 'noindex, nofollow, noarchive';
export const KIND_LABELS = { hours: 'Opening hours', travel: 'Travel time', price: 'Price', access: 'Step-free access', window: 'Booking windows' };
const KIND_ABOUT = {
  hours: 'Whether the place is open when the plan has you there, and closed or temporarily closed places.',
  travel: 'How long getting from the stop before takes, by the plan’s way of travel, and whether you arrive late.',
  price: 'The price or price level Eden shows for a place.',
  access: 'Whether a place has a step-free entrance.',
  window: 'When bookings open for a place, read from the venue’s own booking page.',
};
const SOURCE_LABELS = { google_places: 'Google Maps (Places API)', google_routes: 'Google Maps (Routes API)', venue_site: 'Venue websites' };
const SOURCE_KEYS = Object.keys(SOURCE_NAMES);
// a booking window is found once on the venue's page and never re-checked, so "changed after checking" isn't counted for it
const NO_CHANGED = new Set(['window']);

/* ---------- pure: the numbers ---------- */

const zero = () => ({ shown: 0, wrong: 0, changed: 0 });
const add = (t, c) => { t.shown += c.shown || 0; t.wrong += c.wrong || 0; t.changed += c.changed || 0; return t; };
/** A share as the page writes it: "<0.1%", "2.4%", "12%". Null without a sample of at least ACC_PAGE.min. */
export function pctText(part, shown) {
  if (!(shown >= ACC_PAGE.min)) return null;
  const p = (100 * part) / shown;
  return `${p === 0 ? '0' : p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}
const rate = (part, shown) => (shown >= ACC_PAGE.min ? Math.round((1e6 * part) / shown) / 1e6 : null);
const cell = (c, kind) => ({ shown: c.shown, wrong: c.wrong, changed: NO_CHANGED.has(kind) ? null : c.changed,
  wrong_rate: rate(c.wrong, c.shown), changed_rate: NO_CHANGED.has(kind) ? null : rate(c.changed, c.shown) });

/** The 12 months up to `current` (YYYY-MM), newest first. */
export function lastMonths(current, n = ACC_PAGE.months) {
  const [y, m] = current.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
}

/**
 * The index's months (tacc-read: [{ month, kinds: { kind: { source: { shown, wrong, changed } } } }]) → the page's
 * numbers for the last 12 months up to `current`: per kind (its sources and its months), per source, and all together.
 * Rates are null under ACC_PAGE.min checks shown.
 */
export function accuracySummary(months, current) {
  const window = lastMonths(current);
  const inWindow = new Map((months || []).filter((x) => x && window.includes(x.month)).map((x) => [x.month, x.kinds || {}]));
  const kinds = CHECK_KINDS.map((kind) => {
    const total = zero();
    const bySource = Object.fromEntries(SOURCE_KEYS.map((s) => [s, zero()]));
    const byMonth = window.map((month) => {
      const t = zero();
      for (const [s, c] of Object.entries((inWindow.get(month) || {})[kind] || {})) {
        if (!bySource[s]) continue; // only the sources the index takes
        add(t, c); add(bySource[s], c);
      }
      add(total, t);
      return { month, ...cell(t, kind) };
    });
    return {
      kind, label: KIND_LABELS[kind], ...cell(total, kind),
      sources: SOURCE_KEYS.filter((s) => bySource[s].shown > 0 || bySource[s].wrong > 0).map((s) => ({ source: s, label: SOURCE_LABELS[s], ...cell(bySource[s], kind) })),
      months: byMonth.filter((x) => x.shown > 0 || x.wrong > 0 || x.changed > 0),
    };
  });
  const sources = SOURCE_KEYS.map((s) => {
    const t = zero(), withChanged = zero();
    for (const k of kinds) {
      const c = k.sources.find((x) => x.source === s);
      if (!c) continue;
      add(t, { shown: c.shown, wrong: c.wrong });
      if (!NO_CHANGED.has(k.kind)) add(withChanged, { shown: c.shown, changed: c.changed });
    }
    return { source: s, label: SOURCE_LABELS[s], shown: t.shown, wrong: t.wrong, wrong_rate: rate(t.wrong, t.shown), changed: withChanged.shown ? withChanged.changed : null, changed_rate: withChanged.shown ? rate(withChanged.changed, withChanged.shown) : null, changed_of: withChanged.shown };
  }).filter((x) => x.shown > 0 || x.wrong > 0);
  const all = kinds.reduce((t, k) => add(t, { shown: k.shown, wrong: k.wrong }), zero());
  const allChanged = kinds.filter((k) => !NO_CHANGED.has(k.kind)).reduce((t, k) => add(t, { shown: k.shown, changed: k.changed }), zero());
  const counted = window.filter((m) => inWindow.has(m));
  return {
    from: window[window.length - 1], to: current, current_month_partial: true, min_sample: ACC_PAGE.min,
    months_with_counts: counted.length,
    all: { shown: all.shown, wrong: all.wrong, wrong_rate: rate(all.wrong, all.shown), changed: allChanged.changed, changed_rate: rate(allChanged.changed, allChanged.shown), changed_of: allChanged.shown },
    kinds, sources,
  };
}

/* ---------- the page ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (x) => Number(x || 0).toLocaleString('en-US');
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const stamp = (t) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const tooFew = `<span class="few">too few to rate</span>`;
const rateCell = (part, shown) => { const p = pctText(part, shown); return p ? `<b>${p}</b>` : tooFew; };

/** One table row: label, checks shown, reported wrong (and its rate), changed after checking (and its rate). */
function row(label, c, { kind, sub = false } = {}) {
  const changed = NO_CHANGED.has(kind) || c.changed === null ? '<td>not counted</td><td>–</td>' : `<td>${nf(c.changed)}</td><td>${rateCell(c.changed, c.changed_of ?? c.shown)}</td>`;
  return `<tr${sub ? ' class="sub"' : ''}><th scope="row">${label}</th><td>${nf(c.shown)}</td><td>${nf(c.wrong)}</td><td>${rateCell(c.wrong, c.shown)}</td>${changed}</tr>`;
}
const HEAD = `<thead><tr><th scope="col">Check</th><th scope="col">Checks shown</th><th scope="col">Reported wrong</th><th scope="col">Wrong rate</th><th scope="col">Changed after checking</th><th scope="col">Changed rate</th></tr></thead>`;

/** The plain sentence for one kind: "2 of 1,240 opening-hours checks (0.2%) were reported wrong." */
function kindLine(k) {
  if (!k.shown) return `No ${k.label.toLowerCase()} checks counted yet.`;
  const p = pctText(k.wrong, k.shown);
  return p ? `${nf(k.wrong)} of ${nf(k.shown)} reported wrong (${p}).` : `${nf(k.wrong)} of ${nf(k.shown)} reported wrong: under ${ACC_PAGE.min} checks, too few to give a rate.`;
}

/** The page's HTML for a summary (accuracySummary), read at `at`; `index`: whether search engines may index it. */
export function accuracyHtml(sum, { at, index = false } = {}) {
  const from = monthName(sum.from), to = monthName(sum.to);
  const any = sum.all.shown > 0 || sum.all.wrong > 0;
  const headline = !any ? 'No checks counted yet. The first numbers appear here once people use Eden Travel’s live checks.'
    : pctText(sum.all.wrong, sum.all.shown)
      ? `Of ${nf(sum.all.shown)} checks Eden Travel showed from ${from} to ${to}, people reported ${nf(sum.all.wrong)} as wrong (${pctText(sum.all.wrong, sum.all.shown)}).`
      : `Eden Travel has shown ${nf(sum.all.shown)} checks since ${from}: fewer than ${ACC_PAGE.min}, too few to give a rate yet.`;
  const table = `<div class="tw"><table><caption>The last 12 months, ${esc(from)} to ${esc(to)} (${esc(to)} so far). Rates only with at least ${ACC_PAGE.min} checks shown.</caption>${HEAD}<tbody>${
    sum.kinds.map((k) => row(esc(k.label), k, { kind: k.kind }) + (k.sources.length > 1 ? k.sources.map((s) => row(`<span class="src">${esc(s.label)}</span>`, s, { kind: k.kind, sub: true })).join('') : '')).join('')
  }</tbody></table></div>`;
  const kindCards = sum.kinds.map((k) => `<li class="kind"><h3>${esc(k.label)}</h3><p class="about">${esc(KIND_ABOUT[k.kind])}</p><p class="line">${esc(kindLine(k))}</p><p class="from">Source${k.sources.length === 1 ? '' : 's'}: ${k.sources.length ? k.sources.map((s) => esc(s.label)).join(', ') : esc(k.kind === 'window' ? SOURCE_LABELS.venue_site : k.kind === 'travel' ? SOURCE_LABELS.google_routes : SOURCE_LABELS.google_places)}</p></li>`).join('');
  const sourcesTable = sum.sources.length ? `<div class="tw"><table><caption>All check kinds together, by where the answer came from.</caption><thead><tr><th scope="col">Source</th><th scope="col">Checks shown</th><th scope="col">Reported wrong</th><th scope="col">Wrong rate</th><th scope="col">Changed after checking</th><th scope="col">Changed rate</th></tr></thead><tbody>${
    sum.sources.map((s) => row(esc(s.label), s)).join('')}</tbody></table></div>` : '<p class="empty">No checks counted yet.</p>';
  const monthly = sum.kinds.filter((k) => k.months.length).map((k) => `<details><summary>${esc(k.label)}, month by month</summary><div class="tw"><table><caption>${esc(k.label)}: each month on its own (the current month so far).</caption>${HEAD.replace('>Check<', '>Month<')}<tbody>${
    k.months.map((m) => row(esc(shortMonth(m.month)), m, { kind: k.kind })).join('')}</tbody></table></div></details>`).join('') || '<p class="empty">No months counted yet.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#fbf7ee">
<title>How often Eden Travel’s checks are wrong · Eden</title>
<meta name="description" content="Every opening-hours, travel-time, price, step-free and booking-window check Eden Travel shows, and how many people reported wrong, by month and by source.">
${index ? '<link rel="canonical" href="https://askeden.com/travel/accuracy">' : `<meta name="robots" content="${NOINDEX}">`}
<link rel="icon" type="image/svg+xml" href="/jarvis/eden-logo.svg">
<link rel="apple-touch-icon" href="/jarvis/eden-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&amp;family=Instrument+Sans:wght@400;500;600&amp;display=swap">
<link rel="stylesheet" href="/travel/accuracy.css">
</head>
<body>
<a class="skip" href="#main">Skip to the main content</a>
<header class="top">
  <a class="brand" href="/" aria-label="Eden, askeden.com"><img src="/jarvis/eden-logo.svg" alt="" width="36" height="36"><span>Eden</span></a>
  <nav aria-label="Site"><a href="/accuracy">AI accuracy</a><a href="/help">Help</a><a class="pill" href="/signin">Sign in</a></nav>
</header>

<main id="main">
<section class="hero" aria-labelledby="h1">
  <p class="kicker">Eden Travel · Check accuracy</p>
  <h1 id="h1">How often Eden Travel’s checks are wrong<u aria-hidden="true"></u></h1>
  <p class="lede">${esc(headline)}</p>
  <p class="fine">Counts from ${esc(from)} to ${esc(to)}, ${esc(to)} so far · read ${esc(stamp(at))}, updated hourly · <a href="/travel/accuracy.json">the numbers as data</a></p>
  <p class="strip">Reports undercount: not everyone who finds a mistake reports it, so the real rate can be higher than the one shown.</p>
</section>

<section aria-labelledby="kindsH">
  <h2 id="kindsH">What Eden checks</h2>
  <p class="sub">Five kinds of check, each from a live source, each shown with its source and when it was checked.</p>
  <ul class="kinds">${kindCards}</ul>
</section>

<section aria-labelledby="tableH">
  <h2 id="tableH">The last 12 months</h2>
  <p class="sub">Each kind, all sources together, then each source on its own when there is more than one.</p>
  ${any ? table : '<p class="empty">No checks counted yet.</p>'}
</section>

<section aria-labelledby="srcH">
  <h2 id="srcH">By source</h2>
  <p class="sub">Where Eden got each answer.</p>
  ${sourcesTable}
</section>

<section aria-labelledby="monthH">
  <h2 id="monthH">Month by month</h2>
  <p class="sub">A month counts the checks shown and the reports made in it.</p>
  ${monthly}
</section>

<section class="method" id="method" aria-labelledby="methodH">
  <h2 id="methodH">How we count</h2>
  <h3>What counts</h3>
  <ul>
    <li><b>Checks shown.</b> A check Eden showed someone on their trip, made against a live source: Google Maps (Places API) for opening hours, prices and step-free access; Google Maps (Routes API) for travel times; the venue’s own website for when bookings open. Each check of a stop counts once a month, however often the trip is opened. A different time, a different stop before it or a different way of travel is a new check.</li>
    <li><b>Reported wrong.</b> Someone tapped “This was wrong” on a check and told Eden what was actually true. Reporting the same check again doesn’t count twice, and a report taken back is taken off the count.</li>
    <li><b>Changed after checking.</b> A later look at the same place, day and plan found a check that had been fine now showing a problem (new opening hours, say). It wasn’t necessarily wrong when Eden checked, so it is counted apart from “reported wrong”. Booking windows are found once and not looked at again, so this isn’t counted for them.</li>
  </ul>
  <h3>What doesn’t count</h3>
  <ul>
    <li>Sample or stand-in data (shown when a live source isn’t connected).</li>
    <li>Your own figures: your booking, your own estimate.</li>
    <li>A check whose source didn’t answer, so Eden couldn’t check it.</li>
    <li>Background re-checks that nobody was shown count only toward “changed after checking”, never as checks shown.</li>
  </ul>
  <h3>How to read the rates</h3>
  <ul>
    <li><b>Reports undercount.</b> Most people who meet a wrong check never report it. The wrong rate is what people told us, a floor rather than the true rate.</li>
    <li><b>No rate under ${ACC_PAGE.min}.</b> With fewer than ${ACC_PAGE.min} checks shown, one report swings the share too far to mean anything, so the page shows the counts and says “too few to rate”.</li>
    <li><b>Months are by when it happened.</b> A check shown in one month and reported in the next counts as shown in the first and wrong in the second. Months are in UTC, and the current month is still filling.</li>
    <li><b>Sample sizes.</b> “Checks shown” is the sample behind each rate.</li>
  </ul>
  <h3>What’s kept</h3>
  <p>Only counts reach these numbers: for each month, check kind and source, how many were shown, reported wrong and changed. No place, no trip, no name and no account. Each account sends its counts in one batch at most hourly. Your own reports, with the check as Eden showed it, stay in your account, where you can take them back.</p>
</section>
</main>

<footer>
  <span>© 2026 Harrat Global Holdings, Inc.</span>
  <nav aria-label="Legal and help"><a href="/accuracy">Accuracy</a><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
</footer>
</body>
</html>
`;
}

/** The page when the numbers didn't load: says so, never cached. */
function unavailableHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="${NOINDEX}">
<title>How often Eden Travel’s checks are wrong · Eden</title><link rel="stylesheet" href="/travel/accuracy.css"></head>
<body><main id="main"><section class="hero"><p class="kicker">Eden Travel · Check accuracy</p><h1>The numbers didn’t load just now</h1><p class="lede">Try again in a minute.</p></section></main></body></html>
`;
}

// Paper (DESIGN.md §4–5): the front page's tokens, header and footer (public/home/home.css), a card table and the method.
export const ACC_CSS = `/* askeden.com/travel/accuracy (src/travel/accuracy-page.js): Paper, as the front page (public/home/home.css). No inline style. */
:root{--paper:#fbf7ee;--paper2:#f3ecdc;--card:#fffdf8;--ink:#0E2747;--ink2:#46556b;--line:#ddd3bd;--coral:#d9604f;--coral2:#ef7b6c;--serif:'Fraunces',Georgia,serif;--sans:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;--mono:ui-monospace,'SF Mono',Menlo,monospace;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:400 17px/1.55 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line)}
a:hover{text-decoration-color:var(--ink)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:8px}
.skip{position:absolute;left:12px;top:-64px;z-index:10;padding:10px 16px;border-radius:10px;background:var(--ink);color:var(--paper);font-weight:600;text-decoration:none}
.skip:focus{top:12px}
.top,main,footer{max-width:1120px;margin-left:auto;margin-right:auto;padding-left:24px;padding-right:24px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:max(24px,env(safe-area-inset-top));padding-bottom:24px;border-bottom:1px solid var(--line)}
.top a{text-decoration:none}
.brand{display:flex;align-items:center;gap:10px;font:500 22px var(--serif)}
.brand img{width:36px;height:36px;border-radius:10px;box-shadow:0 2px 8px rgba(14,39,71,.15)}
.top nav{display:flex;align-items:center;gap:26px;font-size:15px;color:var(--ink2)}
.top nav a{min-height:40px;display:inline-flex;align-items:center}
.top nav a:hover{color:var(--ink)}
.pill{padding:9px 18px;border-radius:999px;border:1.5px solid var(--ink);color:var(--ink)!important;font-weight:600;font-size:14px}
.pill:hover{background:var(--ink);color:var(--paper)!important}
main{padding-bottom:72px}
section{padding-top:56px}
.hero{padding-top:72px;max-width:860px}
.kicker{margin:0 0 16px;font:500 13px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--coral)}
h1{margin:0;font:300 clamp(42px,6.2vw,76px)/1.02 var(--serif);letter-spacing:-.01em;font-variation-settings:"opsz" 72}
h1 u{text-decoration:none;display:inline-block;width:.5em;height:.09em;margin-left:.08em;background:var(--coral2);border-radius:3px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.lede{margin:22px 0 0;color:var(--ink2);font-size:20px;max-width:640px}
.fine{margin:14px 0 0;font:13px/1.6 var(--mono);color:var(--ink2)}
.strip{margin:28px 0 0;padding:14px 18px;border-radius:14px;background:var(--paper2);font:14px/1.55 var(--mono);color:var(--ink)}
h2{margin:0;font:400 clamp(30px,4vw,44px)/1.1 var(--serif);letter-spacing:-.01em}
.sub{margin:8px 0 22px;color:var(--ink2)}
h3{margin:0;font:500 20px/1.25 var(--serif)}
.kinds{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.kind{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px 20px 18px}
.kind .about{margin:8px 0 12px;color:var(--ink2);font-size:15px}
.kind .line{margin:0;font-weight:600;font-size:16px}
.kind .from{margin:10px 0 0;font:12px/1.5 var(--mono);letter-spacing:.04em;color:var(--ink2)}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:6px 6px 2px}
table{border-collapse:collapse;width:100%;font-size:15px;font-variant-numeric:tabular-nums}
caption{text-align:left;color:var(--ink2);font-size:13px;padding:12px 12px 8px}
th,td{padding:10px 12px;text-align:left;border-top:1px solid var(--line);white-space:nowrap}
thead th{font:500 11.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);border-top:0}
tbody th{font-weight:600}
tr.sub th{font-weight:400;padding-left:28px;color:var(--ink2)}
tr.sub td{color:var(--ink2)}
.few{font:12px var(--mono);color:var(--ink2)}
.empty{margin:0;padding:18px 20px;border-radius:14px;background:var(--paper2);color:var(--ink2)}
details{margin:0 0 12px}
details .tw{margin-top:10px}
summary{cursor:pointer;font-weight:600;min-height:40px;display:flex;align-items:center;gap:10px;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"+";font:500 18px var(--mono);color:var(--coral);width:14px}
details[open]>summary::before{content:"\\2212"}
.method{max-width:760px}
.method h3{margin:30px 0 8px}
.method p,.method li{font-size:16.5px;line-height:1.6}
.method ul{margin:0;padding-left:22px}
.method li{margin:8px 0}
.method li::marker{color:var(--coral)}
.method b{font-weight:600}
footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px 20px;padding-top:22px;padding-bottom:max(28px,env(safe-area-inset-bottom));border-top:1px solid var(--line);font-size:14px;color:var(--ink2)}
footer nav{display:flex;gap:20px}
footer a{text-decoration:none}
footer a:hover{color:var(--ink)}
@media (max-width:860px){
  .top,main,footer{padding-left:16px;padding-right:16px}
  .top nav a:not(.pill){display:none}
  .hero{padding-top:44px}
  section{padding-top:44px}
  .lede{font-size:18px}
  th,td{padding:9px 10px}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}h1 u{animation:none}}
`;

/* ---------- the route ---------- */

const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

/**
 * GET/HEAD /travel/accuracy(.json|.css): the response, or null when it isn't one of these (or Eden Travel is off).
 * deps (tests): read(env) → { months } (the global index), cache (caches.default), now().
 */
export async function travelAccuracyPage(request, env, path, { read = (e) => ask(e, GLOBAL, 'tacc-read', {}), cache = globalThis.caches?.default, now = () => Date.now() } = {}) {
  if (!ACC_PATHS.includes(path) || !travelOn(env)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const head = (r) => (request.method === 'HEAD' ? new Response(null, r) : r);
  const index = String(env.TRAVEL_ACCURACY_INDEX || '') === '1';
  const robots = index ? {} : { 'x-robots-tag': NOINDEX };
  const cacheControl = `public, max-age=${ACC_PAGE.cacheS}`;
  if (path === '/travel/accuracy.css') return head(new Response(ACC_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': cacheControl, 'x-content-type-options': 'nosniff' } }));

  // one copy per address and flag, whatever the query
  const url = new URL(request.url);
  const key = new Request(`${url.origin}${path}${index ? '' : '?noindex'}`, { method: 'GET' });
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) return head(hit);

  let months;
  try { ({ months } = await read(env)); } catch { months = null; }
  if (!Array.isArray(months)) {
    if (path === '/travel/accuracy.json') return head(json({ error: 'The numbers didn’t load just now.' }, 503, { 'cache-control': 'no-store', 'retry-after': '60', ...robots }));
    return head(page(new Response(unavailableHtml(), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' } }), ACC_CSP, { cache: 'no-store' }));
  }
  const at = now();
  const sum = accuracySummary(months, monthOf(at));
  const res = path === '/travel/accuracy.json'
    ? json({ ...sum, read_at: new Date(at).toISOString(), method: `${url.origin}/travel/accuracy#method` }, 200, { 'cache-control': cacheControl, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', ...robots })
    : withHeaders(page(new Response(accuracyHtml(sum, { at, index }), { headers: { 'content-type': 'text/html; charset=utf-8' } }), ACC_CSP, { cache: cacheControl }), robots);
  if (cache) await cache.put(key, res.clone()).catch(() => {});
  return head(res);
}
