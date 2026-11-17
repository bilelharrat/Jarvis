// Eden Enterprise's request form (/enterprise; owner's decision F, 2026-11-13). Checks the fields as the
// server does (src/leads/enterprise.js validate), draws Cloudflare Turnstile explicitly with the site key
// from /api/web/config `turnstile` (as /signin does, public/signin/signin.js), then POSTs
// /api/enterprise { name, email, company, team_size, message, turnstile, website_url }. The server stores
// the request and emails it to the owner. Words in English here; /lang/fr-enterprise.js has the French
// (site-i18n.js translates them as they appear). A plain deferred script: no inline script (DESIGN.md §9).
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('entForm');
  if (!form) return;
  const TEAM_SIZES = ['1-9', '10-49', '50-249', '250-999', '1000+'];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const FIELDS = { name: 'entName', email: 'entEmail', company: 'entCompany', team_size: 'entSize', message: 'entMessage' };
  const WORDS = {
    name: 'Add your name.',
    email: 'Add a work email address that works, like name@company.com.',
    company: 'Add your company’s name.',
    team_size: 'Choose your team’s size.',
    message: 'Keep the message under 2,000 characters.',
    verify: 'Finish the check above (it confirms you’re a person), then send.',
    turnstile: 'The check didn’t pass. Finish it again (it confirms you’re a person), then send.',
    turnstile_down: 'The person check couldn’t be reached. Try again in a moment.',
    slow_down: 'You’ve sent a few already today. We’ll be in touch; try again tomorrow if you need to.',
    not_set_up: 'The form isn’t open yet. Write to bilel@askeden.com.',
    offline: 'Can’t reach askeden.com. Check your connection and try again.',
    server: 'That didn’t go through. Try again in a moment.',
  };

  let human = null; // { token } once Turnstile passes
  let turnstileOn = false;

  function say(words, field) {
    const alert = $('entAlert');
    alert.textContent = words;
    alert.hidden = false;
    for (const id of Object.values(FIELDS)) $(id).removeAttribute('aria-invalid');
    if (field && FIELDS[field]) {
      const input = $(FIELDS[field]);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'entAlert');
      input.focus();
    }
  }
  function clear() {
    $('entAlert').hidden = true;
    for (const id of Object.values(FIELDS)) { $(id).removeAttribute('aria-invalid'); $(id).removeAttribute('aria-describedby'); }
  }

  function loadTurnstile(siteKey) {
    turnstileOn = true;
    $('human').hidden = false;
    window.onEdenTurnstile = () => {
      window.turnstile.render('#human', {
        sitekey: siteKey,
        action: 'enterprise',
        language: document.documentElement.lang === 'fr' ? 'fr' : 'auto',
        callback: (token) => { human = { token }; },
        'expired-callback': () => { human = null; },
        'error-callback': () => { human = null; },
      });
    };
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onEdenTurnstile';
    script.async = true;
    document.head.append(script);
  }
  function resetTurnstile() {
    human = null;
    if (window.turnstile) window.turnstile.reset('#human');
  }

  // The fields as the server reads them, or the first field that's wrong.
  function read() {
    const v = (k) => String($(FIELDS[k]).value || '');
    const one = (s) => s.replace(/\s+/g, ' ').trim();
    const name = one(v('name'));
    if (!name || name.length > 100) return { field: 'name' };
    const email = one(v('email')).toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) return { field: 'email' };
    const company = one(v('company'));
    if (!company || company.length > 120) return { field: 'company' };
    const team = v('team_size');
    if (!TEAM_SIZES.includes(team)) return { field: 'team_size' };
    const message = v('message').trim();
    if (message.length > 2000) return { field: 'message' };
    return { body: { name, email, company, team_size: team, message } };
  }

  async function send(e) {
    e.preventDefault();
    clear();
    const got = read();
    if (got.field) return say(WORDS[got.field], got.field);
    if (turnstileOn && !human) return say(WORDS.verify);
    const button = $('entSend');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Sending…';
    const trap = form.querySelector('[name="website_url"]');
    let res;
    let out = {};
    try {
      res = await fetch('/api/enterprise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...got.body, turnstile: human ? human.token : '', website_url: trap ? trap.value : '' }),
      });
      try { out = await res.json(); } catch { out = {}; }
    } catch {
      button.disabled = false;
      button.textContent = label;
      return say(WORDS.offline);
    }
    if (res.ok && out.ok) {
      form.hidden = true;
      const done = $('entDone');
      done.textContent = `Thanks. We’ll be in touch at ${got.body.email}.`;
      done.hidden = false;
      done.focus();
      return undefined;
    }
    button.disabled = false;
    button.textContent = label;
    if (out.code === 'turnstile' || out.code === 'turnstile_down') resetTurnstile();
    if (res.status === 400 && out.field && WORDS[out.field]) return say(WORDS[out.field], out.field);
    return say(WORDS[out.code] || WORDS.server);
  }

  form.addEventListener('submit', send);
  // a field that was named wrong: its mark and the message go once it's being fixed
  for (const id of Object.values(FIELDS)) {
    $(id).addEventListener(id === 'entSize' ? 'change' : 'input', () => {
      if ($(id).getAttribute('aria-invalid') === 'true') clear();
    });
  }

  // Turnstile only when the server has a site key (as /signin).
  fetch('/api/web/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((c) => { if (c && typeof c.turnstile === 'string' && c.turnstile) loadTurnstile(c.turnstile); })
    .catch(() => { /* the server says so if it needs the check */ });
})();
