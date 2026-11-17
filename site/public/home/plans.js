// askeden.com's front page: the six plans (PLANS_V2) and the Eden Enterprise card (ENTERPRISE_CONTACT),
// owner 2026-11-13. The plan numbers are the Worker's own: GET /api/web/config `plans` (site
// src/accounts/plans.js; DESIGN.md §8: quote the Worker's numbers, never by hand). With JavaScript off,
// the flags off or the request failing, the page stays as it is in index.html (Free, Plus, Pay as you go).
// With two or more plans on sale on the web (`web: true`), their cards replace the static Plus card and
// "#plansV2Fine" replaces the fine print. With `enterprise_contact`, the hidden Eden Enterprise card shows.
// A plain deferred script (the page's CSP: script-src 'self'; no inline script or style). The French is in
// /lang/fr-home.js: whole lines as `exact` or `patterns`, translated as they appear (site-i18n.js).
(() => {
  const grid = document.getElementById('plansV2');
  const ent = document.getElementById('enterpriseCard');
  if (!grid && !ent) return;
  const TIERS = ['plus2', 'pro', 'max', 'ultra', 'platinum', 'black']; // plus2: the new Plus (site accounts/plans.js)
  const ROLLOVER = 'Unused AI carries over one month, then expires.';
  const fr = () => Boolean(window.SiteI18n && window.SiteI18n.isFr);
  const count = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const num = (n) => Number(n).toLocaleString(fr() ? 'fr-FR' : 'en-US', { maximumFractionDigits: 0 });
  const money = (n) => (fr() ? `${num(n)} $` : `$${num(n)}`);

  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // The server's list, checked: known tiers once each, with a name and a monthly price; cheapest first.
  function plansOf(config) {
    const seen = new Set();
    const out = [];
    for (const p of Array.isArray(config && config.plans) ? config.plans : []) {
      if (!p || !TIERS.includes(p.tier) || seen.has(p.tier) || p.web !== true) continue;
      if (typeof p.name !== 'string' || !p.name.trim() || !count(p.price_usd)) continue;
      seen.add(p.tier);
      out.push(p);
    }
    return out.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  }

  function yearlyLine(p) {
    if (!count(p.yearly_usd)) return null;
    const free = Math.round((12 * p.price_usd - p.yearly_usd) / p.price_usd);
    return free >= 1 ? `Or ${money(p.yearly_usd)} a year (${free} month${free === 1 ? '' : 's'} free)` : `Or ${money(p.yearly_usd)} a year`;
  }

  function card(p, rollover) {
    const lines = [
      yearlyLine(p),
      count(p.answers) ? (count(p.eves_strong) ? `~${num(p.answers)} answers or ${num(p.eves_strong)} EVES Strong a month` : `~${num(p.answers)} answers a month`) : null,
      count(p.flash_day) ? `Then up to ${num(p.flash_day)} Flash answers a day` : null,
      count(p.browser_min) ? `${num(p.browser_min)} minutes of Eden’s cloud browser a month` : null,
      count(p.voice_day) ? `${num(p.voice_day)} characters of Eden Secretary voice a day` : null,
      count(p.bonus_max_pct) ? `${p.name} Bonus: up to +${Math.round(p.bonus_max_pct * 10) / 10}% AI` : null,
      rollover ? ROLLOVER : null,
    ].filter(Boolean);
    const art = make('article', p.tier === 'plus2' ? 'plan plus' : 'plan');
    art.dataset.tier = p.tier;
    const h = make('h3', '', p.name);
    h.setAttribute('data-no-i18n', ''); // a product name
    const price = make('p', 'price');
    price.append(make('b', '', money(p.price_usd)), make('span', '', '/month'));
    const ul = make('ul');
    for (const l of lines) ul.append(make('li', '', l));
    const go = make('a', p.tier === 'plus2' ? 'btn primary' : 'btn', `Get ${p.name}`);
    go.href = `/signin?return=${encodeURIComponent(`/#plus=${p.tier}`)}`; // after sign-in, the account opens on that plan
    art.append(h, price, ul, go);
    return art;
  }

  function draw(config) {
    const plans = plansOf(config);
    if (grid && plans.length > 1) {
      grid.replaceChildren(...plans.map((p) => card(p, config.rollover === true)));
      grid.hidden = false;
      for (const old of document.querySelectorAll('.plans > .plan.plus:not([data-tier])')) old.hidden = true; // the static Plus card
      const fine = document.getElementById('plansV2Fine');
      const oldFine = document.getElementById('plansFine');
      if (fine && oldFine) { fine.hidden = false; oldFine.hidden = true; }
    }
    if (ent && config.enterprise_contact === true) ent.hidden = false;
  }

  fetch('/api/web/config', { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((config) => { if (config && typeof config === 'object') draw(config); })
    .catch(() => { /* offline or an older Worker: the page as it is */ });
})();
