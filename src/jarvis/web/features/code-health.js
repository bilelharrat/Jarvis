// Jarvis Code's Health pane (features/code_health.py), from the More menu: the engine's
// version, the Claude sign-in (with the command that signs in, when it isn't), and this
// session's connection, with Reconnect for one that failed or ended.
// Pure helpers are exported for node --test (tests/web/code-health.test.mjs).
(function (root) {
  'use strict';

  const ASK_AGAIN_MS = 15000;  // a pane shown longer than this asks again when drawn

  // What a session's state reads as.
  function sessionWords(s) {
    if (!s) return '';
    if (s.status === 'failed') return 'It stopped with an error';
    if (s.status === 'closed') return 'Closed: it opens again with your next message';
    if (s.status === 'stopped') return 'Stopped';
    return s.busy ? 'Working' : 'Ready';
  }

  const api = { sessionWords };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let answer = null;
  let askedAt = 0;
  let askedFor = null;

  function shown() { return typeof currentPane !== 'undefined' && currentPane === 'cw-health' && !F.$('jc-pane').hidden; }
  function taskId() { const t = F.currentTask(); return t ? t.id : 0; }

  function ask(fresh) {
    askedAt = Date.now();
    askedFor = taskId();
    F.send({ type: 'cw_health', ...(askedFor ? { id: askedFor } : {}), ...(fresh ? { fresh: true } : {}) });
  }

  function row(label, value, extra) {
    const li = el('li', 'ch-row');
    li.append(el('span', 'ch-label', label));
    const v = el('span', 'ch-value');
    if (value instanceof Node) v.append(value); else v.textContent = value;
    li.append(v);
    if (extra) li.append(extra);
    return li;
  }

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', run);
    return b;
  }

  function draw(body) {
    if (!answer) { body.replaceChildren(el('p', 'jc-empty', 'Checking…')); return; }
    const parts = [];
    const engine = answer.engine || {};
    const eng = el('ul', 'jc-list ch-list');
    const version = engine.version ? mine(el('span', '', engine.version)) : el('span', 'jc-dim', 'Unknown');
    const where = engine.path ? (engine.bundled ? el('small', 'jc-dim', 'Built into Jarvis') : mine(el('small', 'jc-dim ch-path', engine.path))) : el('small', 'ch-bad', 'Not found');
    eng.append(row('Engine', version, where));
    const signin = answer.signin || {};
    const state = el('span', `ch-state ${signin.state || 'unknown'}`, signin.summary || 'Couldn’t tell');
    const sign = row('Claude sign-in', state, signin.plan ? mine(el('small', 'jc-dim', signin.plan)) : null);
    eng.append(sign);
    parts.push(el('h3', 'ch-head', 'Jarvis Code'), eng);
    if (signin.hint) parts.push(el('p', 'jc-dim ch-hint', signin.hint));
    if (signin.command) {
      const cmd = el('div', 'ch-command');
      const code = mine(el('code', '', signin.command));
      const copy = button('Copy', 'jc-mini', async () => {
        try { await navigator.clipboard.writeText(signin.command); copy.textContent = 'Copied'; } catch (_) { copy.textContent = 'Couldn’t copy'; }
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      });
      cmd.append(code, copy);
      parts.push(cmd);
    }
    const s = answer.session;
    if (s && s.id === taskId()) {
      const list = el('ul', 'jc-list ch-list');
      list.append(row('State', sessionWords(s)));
      list.append(row('Connection', s.connected ? 'Connected' : 'Not connected'));
      if (s.model) list.append(row('Model', mine(el('span', '', s.model))));
      if (s.fell_back) list.append(row('Note', 'On the fallback model since Claude couldn’t answer'));
      parts.push(el('h3', 'ch-head', 'This session'), list);
      if (s.error) parts.push(mine(el('pre', 'ch-error', s.error)));
      const again = button('Reconnect', 'jc-btn small ch-reconnect', () => {
        again.disabled = true;
        F.send({ type: 'cw_reconnect', id: s.id });
        for (const ms of [1500, 5000]) setTimeout(() => { if (shown()) ask(false); }, ms);  // (how it went)
      }, s.status === 'failed' || s.status === 'closed' ? 'Start it again on the same conversation' : 'A new connection, between steps');
      parts.push(again);
    } else if (!F.currentTask()) {
      parts.push(el('p', 'jc-dim', 'Open a session to see how its connection is doing.'));
    }
    const q = answer.quality;
    if (q) {
      const list = el('ul', 'jc-list ch-list');
      list.append(row('Answers in', q.answer_median == null ? el('span', 'jc-dim', 'Not measured yet') : `${q.answer_median}s median · ${q.answer_p90}s slowest 1 in 10`));
      list.append(row('Crash-free days', `${q.crash_free_days} of ${q.days}`));
      list.append(row('Lost chats', el('span', q.lost_chats ? 'ch-bad' : '', `${q.lost_chats} (${q.chats_kept} kept)`)));
      list.append(row('Heads-ups a day', String(q.headsups_per_day)));
      for (const [kind, c] of Object.entries(q.useful || {})) {
        if (!c.shown) continue;
        list.append(row(`Heads-ups: ${kind}`, `${c.opened} opened · ${c.dismissed} dismissed of ${c.shown}`));
      }
      parts.push(el('h3', 'ch-head', 'Quality'), list);
      for (const kind of q.quiet || []) {
        const back = button('Bring back', 'jc-mini', () => { F.send({ type: 'quality_unquiet', kind }); answer = null; ask(true); });
        const line = el('p', 'jc-dim ch-hint', `Quieted: ${kind} heads-ups (nearly always dismissed). `);
        line.append(back);
        parts.push(line);
      }
    }
    const foot = el('div', 'ch-foot');
    foot.append(button('Check again', 'jc-mini', () => { answer = null; draw(body); ask(true); }));
    if (answer.sdk) foot.append(mine(el('small', 'jc-dim', `SDK ${answer.sdk}`)));
    parts.push(foot);
    body.replaceChildren(...parts);
  }

  F.registerPane('cw-health', {
    title: 'Health',
    render(body) {
      if (!answer || askedFor !== taskId() || Date.now() - askedAt > ASK_AGAIN_MS) {
        if (Date.now() - askedAt > 800 || askedFor !== taskId()) ask(false);
      }
      draw(body);
    },
  });
  if (F.registerMoreItem) F.registerMoreItem({ label: 'Health', run: () => F.openPane('cw-health') });

  // An answer about another session than the one on show (asked before a switch, done after
  // the new one's) is left: the one on show's is on its way.
  F.on('cw_health', (ev) => {
    if ((ev.id || 0) !== taskId()) return;
    answer = ev;
    if (shown()) draw(F.$('jc-pane-body'));
  });
  F.on('cw_health_session', (ev) => {
    if (!answer || ev.id !== taskId()) return;
    answer = { ...answer, session: ev.session };
    if (shown()) draw(F.$('jc-pane-body'));
  });
})(typeof window === 'object' ? window : globalThis);
