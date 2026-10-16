// Eden Code on the phone (features/code_phone.py): the owner's paired phone carries on with
// a session started at the desk. Pairing trades the Mac's six-digit code for this browser's
// own device token (kept here, sent as a Bearer token, never in an address). Then: the
// sessions and what waits on the owner, a session's live transcript (a long poll that also
// brings back an entry whose step's outcome came in after it was sent), messages, cards,
// Stop, its model and mode (Manual or Accept edits: Bypass only at the Mac), a new session,
// Land or Discard of its isolated copy, and Exterminator Mode's runs.
//
// Everything that comes from a session (its words, a card's, a project's name) is outside
// text: it goes in with textContent only, never as markup. Pure helpers are exported for
// node --test (tests/web/code-phone.test.mjs).
(function (root) {
  'use strict';

  const ZH = {
    pair_lede: '在 Mac 上打开 设置 › iPhone 与手表，按“配对手机”，在这里输入六位数字代码。',
    pair_code: '配对代码', pair_name: '这台设备', pair: '配对', retry: '再试一次',
    new_session: '新会话', needs_you: '等你处理', sessions: '会话', exterminator: '灭虫模式',
    no_sessions: '还没有会话。在这里或在 Mac 上开始一个。', unpair: '取消配对这个浏览器',
    back: '‹ 会话', model: '模型', mode: '模式', stop: '停止', land: '合并', discard: '丢弃',
    todos: '待办清单', message: '消息', send: '发送', project: '项目', what: '要它做什么？',
    isolated: '在独立副本里', bypass_note: '绕过权限只能在 Mac 上开启。', start: '开始',
    working: '工作中', needs_you_status: '等你处理', done: '完成', failed: '失败', idle: '空闲',
    resting: '已休息', connected: '已连接到你的 Mac', offline: '连不上你的 Mac，正在重试…',
    you: '你', eden: 'Eden Code', step: '步骤', note: '备注', from_mac: '来自你的 Mac',
    open: '打开', mac_only: '请在 Mac 上回答：那里需要触控 ID。', say_no: '不',
    land_confirm: '要合并这个独立副本吗？Mac 上会出现确认卡片。',
    discard_confirm: '要丢弃这个独立副本吗？它的工作会保留 30 天。',
    needs_key: '（需要在 Mac 上添加密钥）', set_on_mac: '（在 Mac 上设置）', copy: '独立副本',
    round: '第 {r}/{n} 轮', found: '发现 {n} 个，修复 {m} 个', spent: '已花 ${a} / ${b}',
    unpaired: '这个浏览器已取消配对。', default_model: '默认模型', placeholder: '给 Eden Code 发消息…',
  };
  const EN = {
    working: 'Working', needs_you_status: 'Needs you', done: 'Done', failed: 'Failed', idle: 'Idle',
    resting: 'Resting', connected: 'Connected to your Mac', offline: 'Can’t reach your Mac. Trying again…',
    you: 'You', eden: 'Eden Code', step: 'Step', note: 'Note', from_mac: 'From your Mac', open: 'Open',
    mac_only: 'Answer this on your Mac: it needs Touch ID there.', say_no: 'No',
    land_confirm: 'Land this isolated copy? A card to confirm comes up.',
    discard_confirm: 'Discard this isolated copy? Its work is kept for 30 days.',
    needs_key: ' (needs a key on the Mac)', set_on_mac: ' (set on the Mac)', copy: 'Isolated copy',
    round: 'Round {r} of {n}', found: '{n} found, {m} fixed', spent: '${a} of ${b}',
    unpaired: 'This browser is unpaired.', default_model: 'Default model', placeholder: 'Message Eden Code…',
  };

  function words(lang) {
    const zh = /^zh/i.test(String(lang || ''));
    return (key, values) => {
      let text = (zh && ZH[key]) || EN[key] || key;
      for (const [k, v] of Object.entries(values || {})) text = text.split(`{${k}}`).join(String(v));
      return text;
    };
  }

  // A session's status (companion_api.session_status) in words.
  function statusKey(status) {
    return status === 'needs_you' ? 'needs_you_status' : (['working', 'done', 'failed', 'idle', 'resting'].includes(status) ? status : 'idle');
  }

  // The transcript as the phone has it, after an answer: its new entries added and the ones
  // that changed since (a step's outcome) put in their place, all in order.
  function mergeEntries(have, fresh, changed) {
    const byN = new Map(have.map((e) => [e.i, e]));
    for (const e of [...(changed || []), ...(fresh || [])]) {
      if (e && e.i != null) byN.set(e.i, e);
    }
    return [...byN.values()].sort((a, b) => a.i - b.i).slice(-400);
  }

  // The mode menu: Manual and Accept edits; a mode set on the Mac (Plan, Auto, Bypass) is
  // shown as it is, not to be picked here.
  function modeChoices(current, modes, t) {
    const list = (modes || []).map((m) => ({ id: m.id, name: m.name, disabled: false }));
    if (current && !list.some((m) => m.id === current.id)) {
      list.push({ id: current.id, name: `${current.name || current.id}${t('set_on_mac')}`, disabled: true });
    }
    return list;
  }

  // Whether this phone may say yes on a card (a "no" it may always say).
  function canSayYes(card) { return !(card && card.mac_only); }

  // The no on a card: its "deny" choice, if it has one.
  function noChoice(card) { return ((card && card.choices) || []).find((c) => c.id === 'deny') || null; }

  // The session the Mac handed off that this phone hasn't opened yet (0: none).
  function handoffToOpen(pinned, openedAt) {
    if (!pinned || !pinned.id) return 0;
    return Number(pinned.at || 0) > Number(openedAt || 0) ? pinned.id : 0;
  }

  // The view an address asks for: #s=<id>, #new, or the sessions.
  function parseHash(hash) {
    const h = String(hash || '').replace(/^#/, '');
    const m = /^s=(\d{1,9})$/.exec(h);
    if (m) return { view: 'session', id: Number(m[1]) };
    if (h === 'new') return { view: 'new', id: 0 };
    return { view: 'home', id: 0 };
  }

  // Seconds to wait before trying again, after n failures in a row.
  function backoff(n) { return Math.min(30, 2 ** Math.max(0, n - 1)); }

  // An Exterminator Mode run in one line (r: code_phone.exterminator()'s item).
  function runLine(r, t) {
    const parts = [r.project, t('round', { r: r.round, n: r.rounds })];
    if (r.step) parts.push(r.step);
    parts.push(r.state);
    parts.push(t('found', { n: r.found, m: r.fixed }));
    parts.push(t('spent', { a: Number(r.spent || 0).toFixed(2), b: Number(r.spend_cap || 0).toFixed(2) }));
    return parts.filter(Boolean).join(' · ');
  }

  // Text split at ``` fences: [{code: bool, text}] (code shown as is, never as markup).
  function blocks(text) {
    const out = [];
    const parts = String(text || '').split(/```[^\n]*\n?/);
    parts.forEach((part, i) => { if (part) out.push({ code: i % 2 === 1, text: part.replace(/\n$/, '') }); });
    return out;
  }

  const api = { words, statusKey, mergeEntries, modeChoices, canSayYes, noChoice, handoffToOpen, parseHash, backoff, runLine, blocks };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  // ── the page ──

  const $ = (id) => document.getElementById(id);
  const t = words(navigator.language);
  const TOKEN_KEY = 'eden-code-phone-token';
  const OPENED_KEY = 'eden-code-phone-opened';
  const store = {
    get(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } },
    set(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch (_) { /* private mode: for this visit */ } },
  };
  let token = store.get(TOKEN_KEY);
  const state = { view: '', open: 0, gen: 0, s: null, options: null, homeTimer: 0, abort: null, fails: 0 };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function button(label, cls, run) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const node of document.querySelectorAll('[data-t]')) {
    const key = node.getAttribute('data-t');
    if (/^zh/i.test(navigator.language) && ZH[key]) node.textContent = ZH[key];
  }
  $('s-text').placeholder = t('placeholder');

  function conn(ok) {
    const line = $('conn');
    const text = ok ? '' : t('offline');
    if (line.textContent !== text) line.textContent = text;
    line.classList.toggle('bad', !ok);
  }

  class Off extends Error {}
  class Unpaired extends Error {}

  async function call(path, body, signal) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
    if (res.status === 401) { token = ''; store.set(TOKEN_KEY, ''); show('pair'); throw new Unpaired('unpaired'); }
    let data = {};
    try { data = await res.json(); } catch (_) { data = {}; }
    if (res.status === 403 && data.off) { $('off-text').textContent = data.error || ''; show('off'); throw new Off(data.error || 'off'); }
    conn(true);
    return { status: res.status, ok: res.ok, data };
  }

  function show(view) {
    state.view = view;
    for (const id of ['pair', 'off', 'home', 'session', 'new']) $(id).hidden = id !== view;
    clearTimeout(state.homeTimer);
    if (view !== 'session') { state.open = 0; state.gen += 1; if (state.abort) state.abort.abort(); }
    const heading = $(view).querySelector('h1');
    if (heading && view !== 'pair') heading.focus({ preventScroll: true });
  }

  function route() {
    if (!token) { show('pair'); return; }
    const where = parseHash(location.hash);
    if (where.view === 'session') openSession(where.id);
    else if (where.view === 'new') openNew();
    else openHome();
  }

  // ── pairing ──

  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pair-error').textContent = '';
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: $('pair-code').value.trim(), device_name: $('pair-name').value.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) throw new Error(data.error || 'Pairing failed.');
      token = data.token;
      store.set(TOKEN_KEY, token);
      $('pair-code').value = '';
      route();
    } catch (err) {
      $('pair-error').textContent = err.message;
    }
  });
  $('unpair').addEventListener('click', () => { token = ''; store.set(TOKEN_KEY, ''); show('pair'); $('pair-error').textContent = t('unpaired'); });
  $('off-retry').addEventListener('click', () => route());

  // ── cards ──

  function cardNode(card) {
    const box = el('article', 'card');
    box.setAttribute('aria-label', card.question || 'Card');
    box.append(el('p', 'q', card.question));
    if (card.detail) box.append(el('pre', 'detail', card.detail));
    const row = el('div', 'row');
    const said = el('p', 'said');
    said.setAttribute('role', 'status');
    const go = async (choice, b) => {
      b.disabled = true;
      try {
        const { ok, data } = await call('/api/code/phone/answer', { approval: card.id, choice });
        if (!ok || !data.ok) said.textContent = data.error || '';
        else box.remove();
      } catch (err) { if (!(err instanceof Off || err instanceof Unpaired)) said.textContent = t('offline'); }
      b.disabled = false;
    };
    if (canSayYes(card)) {
      for (const c of card.choices || []) row.append(button(c.label, c.id === 'deny' ? 'small' : 'small primary', (b) => go(c.id, b)));
    } else {
      box.append(el('p', 'dim', t('mac_only')));
      const no = noChoice(card);
      if (no) row.append(button(no.label || t('say_no'), 'small', (b) => go(no.id, b)));
    }
    box.append(row, said);
    return box;
  }

  // ── the sessions ──

  async function openHome() {
    if (state.view !== 'home') show('home');
    try {
      const { ok, data } = await call('/api/code/phone/home');
      if (ok) drawHome(data);
    } catch (err) {
      if (err instanceof Off || err instanceof Unpaired) return;
      conn(false);
    }
    if (state.view === 'home') state.homeTimer = setTimeout(() => { if (!document.hidden) openHome(); else state.homeTimer = setTimeout(openHome, 1000); }, 5000);
  }

  function drawHome(data) {
    const open = handoffToOpen(data.pinned, store.get(OPENED_KEY));
    if (open) { store.set(OPENED_KEY, String(data.pinned.at)); location.hash = `s=${open}`; return; }
    const pinned = $('pinned');
    pinned.hidden = !data.pinned;
    if (data.pinned) {
      pinned.replaceChildren(el('span', 'dim', t('from_mac')), el('strong', '', data.pinned.title),
        button(t('open'), 'small primary', () => { location.hash = `s=${data.pinned.id}`; }));
    }
    const cards = data.attention || [];
    $('attention').hidden = !cards.length;
    $('attention-list').replaceChildren(...cards.map((c) => {
      const node = cardNode(c);
      if (c.task_id) node.prepend(button(`#${c.task_id}`, 'link small', () => { location.hash = `s=${c.task_id}`; }));
      return node;
    }));
    const list = $('session-list');
    const sessions = data.sessions || [];
    $('sessions-empty').hidden = sessions.length > 0;
    list.replaceChildren(...sessions.map((s) => {
      const li = el('li');
      const b = button('', 'session', () => { location.hash = `s=${s.id}`; });
      b.append(el('span', 'name', s.title || `#${s.id}`), el('span', `chip ${s.status}`, t(statusKey(s.status))),
        el('span', 'dim', [s.project, s.model, s.mode_label].filter(Boolean).join(' · ')));
      li.append(b);
      return li;
    }));
    const runs = data.exterminator || [];
    $('exterminator').hidden = !runs.length;
    $('ext-list').replaceChildren(...runs.map((r) => {
      const li = el('li', '', runLine(r, t));
      if (r.task_id) li.append(button(t('open'), 'link small', () => { location.hash = `s=${r.task_id}`; }));
      return li;
    }));
  }

  // ── one session, live ──

  async function options() {
    if (!state.options) {
      const { ok, data } = await call('/api/code/phone/options');
      if (ok) state.options = data;
    }
    return state.options || { models: [], modes: [], projects: [], defaults: {} };
  }

  function openSession(id) {
    show('session');
    if (state.abort) state.abort.abort();  // (another session's wait ends now)
    state.open = id;
    const gen = ++state.gen;
    state.s = { id, next: 0, seen: 0, v: '', entries: [], data: null };
    $('s-log').replaceChildren();
    $('s-said').textContent = '';
    $('s-title').textContent = `#${id}`;
    follow(id, gen);
  }

  async function follow(id, gen) {
    let fails = 0;
    while (state.open === id && state.gen === gen) {
      if (document.hidden) { await sleep(1000); continue; }
      const s = state.s;
      const controller = new AbortController();
      state.abort = controller;
      const q = new URLSearchParams({ id: String(id), after: String(s.next), seen: String(s.seen), v: s.v, wait: s.v ? '25' : '0' });
      try {
        const { status, ok, data } = await call(`/api/code/phone/session?${q}`, undefined, controller.signal);
        if (state.gen !== gen) return;
        if (status === 404) { location.hash = ''; return; }
        if (!ok) throw new Error(data.error || 'failed');
        fails = 0;
        await apply(data);
      } catch (err) {
        if (err instanceof Off || err instanceof Unpaired || state.gen !== gen) return;
        fails += 1;
        conn(false);
        await sleep(backoff(fails) * 1000);
      }
    }
  }

  async function apply(data) {
    const s = state.s;
    const first = !s.data;
    s.next = data.next; s.seen = data.seen; s.v = data.v;
    if (data.more) s.v = '';  // (more to come at once)
    s.entries = mergeEntries(s.entries, data.entries, data.changed);
    s.data = data;
    $('s-title').textContent = data.title || `#${data.id}`;
    const chip = $('s-status');
    chip.className = `chip ${data.status}`;
    chip.textContent = t(statusKey(data.status));
    $('s-meta').textContent = [data.project, data.model_label].filter(Boolean).join(' · ');
    $('s-stop').disabled = data.status !== 'working';
    $('s-doing').textContent = data.doing || '';
    drawLog(s.entries, data.live);
    // Drawn again only when they changed: streamed words come several times a second, and a
    // card redrawn under a finger (or a screen reader's focus) loses the button it was on.
    const cardsKey = JSON.stringify(data.cards || []);
    if (cardsKey !== s.cardsKey) { s.cardsKey = cardsKey; $('s-cards').replaceChildren(...(data.cards || []).map(cardNode)); }
    const copy = data.copy;
    $('s-copy').hidden = !copy;
    if (copy) $('s-copy-text').textContent = `${t('copy')}: ${copy.branch} → ${copy.into}`;
    const todos = data.todos || [];
    $('s-todos').hidden = !todos.length;
    const todosKey = JSON.stringify(todos);
    if (todosKey !== s.todosKey) { s.todosKey = todosKey; $('s-todo-list').replaceChildren(...todos.map((x) => el('li', x.done ? 'done' : '', x.text))); }
    await drawControls(data);
    if (first) window.scrollTo(0, document.body.scrollHeight);
  }

  function entryNode(e) {
    const li = el('li', `entry ${e.role}`);
    li.dataset.i = String(e.i);
    const who = { user: t('you'), assistant: t('eden'), tool: t('step'), note: t('note') }[e.role] || '';
    li.append(el('span', 'who', who));
    const body = el('div', 'text');
    for (const part of blocks(e.text)) body.append(el(part.code ? 'pre' : 'p', '', part.text));
    li.append(body);
    return li;
  }

  function drawLog(entries, live) {
    const log = $('s-log');
    const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
    const shown = new Map([...log.querySelectorAll('li.entry')].map((li) => [li.dataset.i, li]));
    for (const e of entries) {
      const key = String(e.i);
      const node = shown.get(key);
      if (node && node.dataset.text === e.text) { shown.delete(key); continue; }
      const fresh = entryNode(e);
      fresh.dataset.text = e.text;
      if (node) { node.replaceWith(fresh); shown.delete(key); } else log.append(fresh);
    }
    for (const gone of shown.values()) gone.remove();
    let liveNode = log.querySelector('li.live');
    if (live) {
      if (!liveNode) { liveNode = el('li', 'entry assistant live'); liveNode.append(el('span', 'who', t('eden')), el('div', 'text')); }
      log.append(liveNode);  // (always last)
      liveNode.lastChild.replaceChildren(...blocks(live).map((p) => el(p.code ? 'pre' : 'p', '', p.text)));
    } else if (liveNode) liveNode.remove();
    if (near) window.scrollTo(0, document.body.scrollHeight);
  }

  async function drawControls(data) {
    const opts = await options();
    const model = $('s-model');
    if (document.activeElement !== model) {
      const items = (opts.models || []).map((m) => {
        const o = el('option', '', m.needs_key ? `${m.name}${t('needs_key')}` : m.name);
        o.value = m.ref; o.disabled = m.needs_key; return o;
      });
      if (!items.some((o) => o.value === data.model)) {
        const o = el('option', '', data.model_label || t('default_model')); o.value = data.model || ''; items.unshift(o);
      }
      model.replaceChildren(...items);
      model.value = data.model || '';
    }
    const mode = $('s-mode');
    if (document.activeElement !== mode) {
      const choices = modeChoices({ id: data.mode, name: data.mode_label }, opts.modes, t);
      mode.replaceChildren(...choices.map((m) => { const o = el('option', '', m.name); o.value = m.id; o.disabled = m.disabled; return o; }));
      mode.value = data.mode;
    }
  }

  async function act(path, body) {
    const said = $('s-said');
    said.textContent = '';
    try {
      const { ok, data } = await call(path, body);
      said.textContent = (!ok || data.ok === false) ? (data.error || data.said || '') : (data.said || '');
      return ok && data.ok !== false;
    } catch (err) {
      if (!(err instanceof Off || err instanceof Unpaired)) said.textContent = t('offline');
      return false;
    }
  }

  $('s-model').addEventListener('change', () => act('/api/code/phone/model', { id: state.open, ref: $('s-model').value }));
  $('s-mode').addEventListener('change', () => act('/api/code/phone/mode', { id: state.open, mode: $('s-mode').value }));
  $('s-stop').addEventListener('click', () => act('/api/code/phone/stop', { id: state.open }));
  $('s-land').addEventListener('click', () => { if (confirm(t('land_confirm'))) act('/api/code/phone/land', { id: state.open }); });
  $('s-discard').addEventListener('click', () => { if (confirm(t('discard_confirm'))) act('/api/code/phone/discard', { id: state.open }); });
  $('back').addEventListener('click', () => { location.hash = ''; });
  $('s-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('s-text');
    const text = box.value.trim();
    if (!text) return;
    box.disabled = true;
    if (await act('/api/code/phone/send', { id: state.open, text })) box.value = '';
    box.disabled = false;
    box.focus();
  });
  $('s-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('s-form').requestSubmit(); }
  });

  // ── a new session ──

  async function openNew() {
    show('new');
    $('new-error').textContent = '';
    let opts;
    try { state.options = null; opts = await options(); } catch (err) { return; }
    const project = $('new-project');
    project.replaceChildren(...(opts.projects || []).map((p) => { const o = el('option', '', p.branch ? `${p.name} (${p.branch})` : p.name); o.value = p.name; return o; }));
    $('new-mode').replaceChildren(...(opts.modes || []).map((m) => { const o = el('option', '', m.name); o.value = m.id; return o; }));
    $('new-mode').value = (opts.defaults || {}).mode || 'ask';
    const def = el('option', '', t('default_model')); def.value = '';
    $('new-model').replaceChildren(def, ...(opts.models || []).map((m) => { const o = el('option', '', m.needs_key ? `${m.name}${t('needs_key')}` : m.name); o.value = m.ref; o.disabled = m.needs_key; return o; }));
  }
  $('new-btn').addEventListener('click', () => { location.hash = 'new'; });
  $('new-back').addEventListener('click', () => { location.hash = ''; });
  $('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('new-error').textContent = '';
    const body = { directory: $('new-project').value, prompt: $('new-prompt').value.trim(), mode: $('new-mode').value };
    if ($('new-model').value) body.model = $('new-model').value;
    if ($('new-isolated').checked) body.isolated = true;
    try {
      const { ok, data } = await call('/api/code/phone/new', body);
      if (!ok || !data.id) { $('new-error').textContent = data.error || ''; return; }
      $('new-prompt').value = '';
      location.hash = `s=${data.id}`;
    } catch (err) {
      if (!(err instanceof Off || err instanceof Unpaired)) $('new-error').textContent = t('offline');
    }
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'home') openHome(); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/code/sw.js', { scope: '/code/' }).catch(() => { /* (an untrusted certificate: no worker, the page works) */ });
  }
  root.edenCodePhone = { state };
  route();
})(typeof window === 'object' ? window : globalThis);
