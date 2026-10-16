// Eden Code's first run, and the features owners miss (2026-10-16). In the welcome (no session
// open, under the starters):
// - "Carry on from your phone": the phone page (features/code_phone.py) offered once, opt-in.
//   It stays off until the owner presses Turn on (code_phone_web), since it serves their
//   sessions to a paired device; Not now, or Turn on, keeps it from asking again
//   (code_phone_offered). Turning it on opens the Phone pane with its address and QR code.
// - "Good to know": one tip at a time about what Eden Code already does that's easy to miss
//   (receipts, Deep review, secrets, lessons, the Changes pane, the board, the inbox and
//   lanes, best of N, voice and screen-reader mode, Spec mode, plugins), Next tip and Got it.
//   Which tip is next and Got it are this window's own (localStorage): a convenience, not a
//   setting.
// And Eden Code settings › General › Your context: whether sessions may read the owner's own
// context (features/code_context.py: asked per project at first use, or never), and Forget
// the projects' answers.
//
// No model calls; text only (textContent). Pure helpers are exported for node --test
// (tests/web/code-getstarted.test.mjs).
(function (root) {
  'use strict';

  const PHONE = 'code_phone_web';
  const OFFERED = 'code_phone_offered';
  const LIFE = 'code_life_context';
  const LIFE_PROJECTS = 'code_life_context_projects';
  const TIPS_DONE = 'eden-code-tips-done';
  const TIP_AT = 'eden-code-tip-at';

  // [what it is, where it is]
  const TIPS = [
    ['Every turn that changes files ends with a proof card: what changed, the tests, its own check of the page, and a risk level.', 'In the transcript, after the turn'],
    ['Deep review: three reviewers look for bugs, security holes and what the change breaks elsewhere, and a fourth checks each finding before you see it.', 'Changes pane (/diff) › Deep review'],
    ['A session that needs an API key asks on a card of its own. It only ever sees a placeholder like $SECRET_STRIPE_KEY, never the key.', 'More › Secrets'],
    ['Undo a change and say why: Eden remembers it as a lesson for the project, or for every project when you say “always”.', 'Changes pane (/diff) › Undo'],
    ['The Changes pane shows what this session changed, hunk by hunk: keep or undo each one, or comment on any line.', '/diff'],
    ['Every session on one board, and one inbox of everything waiting for you; /subagents shows what each subagent did and cost.', '⌘⇧B board · ⌘⇧A inbox'],
    ['Best of N runs one request on two or three models at once, each in its own copy, side by side. Keep the best one, or merge the best parts.', 'More › Best of N…'],
    ['Talk instead of typing: voice coding drives a session hands-free, and screen-reader mode reads everything aloud.', 'Start voice coding · Settings › Accessibility'],
    ['Spec mode writes requirements, design and tasks into the repo, each OK’d by you, then checks every task against them. Optional.', '/spec · Write a spec first'],
    ['Claude Code plugins, agents, skills and hooks, and the hooks themselves, edited in one pane.', '/plugins'],
  ];

  // Which first-run cards show: the phone offer (until answered, while the page is off) and
  // the tips (until Got it).
  function cards(features, tipsDone) {
    const f = features || {};
    return { phone: f[PHONE] !== true && f[OFFERED] !== true, tips: !tipsDone };
  }
  const tipAt = (n) => ((Number(n) % TIPS.length) + TIPS.length) % TIPS.length || 0;
  // What a choice sends (feature_prefs changes).
  function phoneAnswer(on) { return on ? { [PHONE]: true, [OFFERED]: true } : { [OFFERED]: true }; }
  // The life-context setting as the select shows it, and the projects answered so far.
  function lifeChoice(features) { return (features || {})[LIFE] === false ? 'off' : 'ask'; }
  function lifeAnswered(features) {
    const p = (features || {})[LIFE_PROJECTS];
    return p && typeof p === 'object' ? Object.keys(p).length : 0;
  }

  const api = { TIPS, cards, tipAt, phoneAnswer, lifeChoice, lifeAnswered, PHONE, OFFERED };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const doc = root.document;
  const welcome = doc && doc.getElementById('cc-welcome');
  const store = {
    get(k) { try { return root.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, v); } catch { /* (a private window: it shows again) */ } },
  };
  let features = {};

  function button(label, cls, run) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.preventDefault(); run(); });
    return b;
  }

  // ── the welcome's cards ──

  const box = el('div', 'gs-cards');
  box.id = 'gs-cards';

  function phoneCard() {
    const c = el('div', 'jc-card gs-card gs-phone');
    c.setAttribute('role', 'group');
    c.setAttribute('aria-label', t('Carry on from your phone'));
    c.append(el('p', 'jc-label', 'Carry on from your phone'),
      el('p', 'gs-text', 'Eden Code has a page for your iPhone: your sessions, their cards and a message box, over your Wi-Fi or Tailscale. It stays off until you turn it on.'));
    const row = el('div', 'gs-actions');
    row.append(
      button('Turn on the phone page', 'jc-btn small filled', () => { send({ type: 'feature_prefs', changes: phoneAnswer(true) }); F.openPane('phone'); }),
      button('Not now', 'jc-btn small', () => { features = { ...features, [OFFERED]: true }; send({ type: 'feature_prefs', changes: phoneAnswer(false) }); draw(); }),
    );
    c.append(row);
    return c;
  }

  function tipsCard() {
    const at = tipAt(store.get(TIP_AT));
    const [what, where] = TIPS[at];
    const c = el('div', 'jc-card gs-card gs-tips');
    c.setAttribute('role', 'group');
    c.setAttribute('aria-label', t('Good to know'));
    const head = el('p', 'jc-label', 'Good to know');
    const count = el('span', 'gs-count', `${at + 1} / ${TIPS.length}`);
    count.dataset.noI18n = '';
    head.append(' ', count);
    c.append(head, el('p', 'gs-text', what), el('p', 'gs-where', where));
    const row = el('div', 'gs-actions');
    row.append(
      button('Next tip', 'jc-btn small', () => { store.set(TIP_AT, String(tipAt(at + 1))); draw(); }),
      button('Got it', 'jc-btn small', () => { store.set(TIPS_DONE, '1'); draw(); }),
    );
    c.append(row);
    return c;
  }

  function draw() {
    if (!welcome) return;
    if (!box.isConnected) {
      const past = doc.getElementById('cc-past-wrap');
      if (past && past.parentNode === welcome) welcome.insertBefore(box, past); else welcome.append(box);
    }
    const show = cards(features, store.get(TIPS_DONE) === '1');
    const parts = [];
    if (show.phone) parts.push(phoneCard());
    if (show.tips) parts.push(tipsCard());
    box.replaceChildren(...parts);
    box.hidden = !parts.length;
  }

  // ── Eden Code settings › General › Your context ──

  const life = el('select', 'jcs-select');
  life.id = 'gs-life';
  life.setAttribute('aria-label', 'Your own context in sessions');
  for (const [value, label] of [['ask', 'Ask for each project'], ['off', 'Never']]) {
    const o = el('option', '', label);
    o.value = value;
    life.append(o);
  }
  life.addEventListener('change', () => send({ type: 'feature_prefs', changes: { [LIFE]: life.value !== 'off' } }));
  const forget = button('Forget the projects’ answers', 'jc-btn small', () => send({ type: 'feature_prefs', changes: { [LIFE_PROJECTS]: {} } }));
  (function addSetting() {
    const general = doc && doc.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Your context');
    const group = el('div', 'jcs-group');
    const row = el('label', 'jcs-row');
    const text = el('span');
    text.append(doc.createTextNode(t('Your own context in sessions')),
      el('small', '', 'Your meeting notes, documents, what you told Eden, and people’s cards, when a session asks for them. Asked once per project; untrusted runs never get them.'));
    row.append(text, life);
    const row2 = el('div', 'jcs-row');
    row2.append(el('span', '', 'Projects you’ve answered for'), forget);
    group.append(row, row2);
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
  })();
  function drawSetting() {
    life.value = lifeChoice(features);
    forget.disabled = lifeAnswered(features) === 0;
  }

  function onPrefs(p) {
    if (!p || !p.features) return;
    features = p.features;
    draw();
    drawSetting();
  }
  F.on('hello', (ev) => onPrefs(ev.prefs), { replay: true });
  F.on('prefs', onPrefs);
  draw();
})(typeof window === 'object' ? window : globalThis);
