// Eden's pop-up, its page (eden-pop.html; app/features/eden-pop.js opens it, eden-pop-preload.js
// is its bridge). The answer is shown with light Markdown (paragraphs, lists, **bold**, *italic*,
// `code`, fenced code) built node by node: the model’s words are never parsed as HTML.
// Screen-reader mode: the answer is announced once, whole, when it ends, and the focus moves to
// what to do with it; streaming pieces are never read out.
(function (root) {
  'use strict';

  // ── light Markdown, as data (tested in tests/web/eden-pop.test.mjs) ──

  /** Inline marks: [{ t: 'text'|'b'|'i'|'code', s }]. */
  function inline(text) {
    const out = [];
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(_[^_\s][^_\n]*_)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: 'text', s: text.slice(last, m.index) });
      const s = m[0];
      if (m[1]) out.push({ t: 'code', s: s.slice(1, -1) });
      else if (m[2] || m[3]) out.push({ t: 'b', s: s.slice(2, -2) });
      else out.push({ t: 'i', s: s.slice(1, -1) });
      last = m.index + s.length;
    }
    if (last < text.length) out.push({ t: 'text', s: text.slice(last) });
    return out;
  }

  /** Blocks: [{ type: 'p'|'ul'|'ol'|'pre', lines|items|code }]. */
  function blocks(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push({ type: 'p', text: para.join('\n') }); para = []; } };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
        out.push({ type: 'pre', code: code.join('\n') });
        continue;
      }
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || number) {
        flush();
        const type = bullet ? 'ul' : 'ol';
        const prev = out[out.length - 1];
        const item = (bullet || number)[1];
        if (prev && prev.type === type && prev.open) prev.items.push(item);
        else out.push({ type, items: [item], open: true });
        continue;
      }
      if (!line.trim()) { flush(); const prev = out[out.length - 1]; if (prev) prev.open = false; continue; }
      const prev = out[out.length - 1];
      if (prev && prev.open && !para.length) prev.open = false;
      para.push(line.replace(/^#{1,6}\s+/, ''));
    }
    flush();
    return out.map(({ open, ...b }) => b);
  }

  /** The answer as it's read or pasted plainly: no Markdown marks. */
  function plain(text) {
    return String(text || '').replace(/```[^\n]*\n?/g, '').replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s+/gm, '').trim();
  }

  const api = { inline, blocks, plain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document || !root.edenPop) return;

  // ── the page ──

  const doc = root.document;
  const bridge = root.edenPop;
  const $ = (id) => doc.getElementById(id);
  const EDIT = new Set(['rewrite', 'fix', 'shorter', 'reply', 'tone', 'translate', 'write']);
  let state = { text: '', app: '', title: '', canPut: false, reader: false, zh: null };
  let thread = []; // [{ role: 'user'|'eden', text }]
  let last = null; // the last request, for Try again
  let answer = '';
  let asking = '';
  let seq = 0;

  const t = (en) => (state.zh && typeof state.zh[en] === 'string' ? state.zh[en] : en);
  function words() {
    doc.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    doc.querySelectorAll('[data-t-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.tLabel)); });
    doc.querySelectorAll('[data-t-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.tPh)); });
    doc.documentElement.lang = state.zh ? 'zh-Hans' : 'en';
  }

  function render(el, text) {
    el.textContent = '';
    for (const b of blocks(text)) {
      if (b.type === 'pre') {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = b.code;
        pre.append(code);
        el.append(pre);
      } else if (b.type === 'p') {
        const p = doc.createElement('p');
        marks(p, b.text);
        el.append(p);
      } else {
        const list = doc.createElement(b.type);
        for (const item of b.items) { const li = doc.createElement('li'); marks(li, item); list.append(li); }
        el.append(list);
      }
    }
  }
  function marks(el, text) {
    for (const part of inline(text)) {
      if (part.t === 'text') { el.append(doc.createTextNode(part.s)); continue; }
      const tag = doc.createElement(part.t === 'b' ? 'strong' : part.t === 'i' ? 'em' : 'code');
      tag.textContent = part.s;
      el.append(tag);
    }
  }

  function note(text, warn) {
    const n = $('note');
    n.hidden = !text;
    n.textContent = text || '';
    n.classList.toggle('warn', Boolean(warn));
    fit();
  }
  function announce(text) {
    const a = $('announce');
    a.textContent = '';
    setTimeout(() => { a.textContent = text; }, 60);
  }

  let fitting = 0;
  function fit() {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(() => bridge.size(Math.ceil($('pop').getBoundingClientRect().height)));
  }

  const writeMode = () => !state.text;

  function open(s) {
    state = { ...state, ...s };
    thread = [];
    last = null;
    answer = '';
    asking = '';
    words();
    const where = state.app ? `${t('From')} ${state.app}` : 'Eden';
    $('where').textContent = writeMode() ? `${where} · ${t('Write here')}` : where;
    const sel = $('selection');
    sel.hidden = writeMode();
    sel.textContent = state.text;
    sel.classList.remove('open');
    $('actions').hidden = writeMode() || state.secure;
    $('askform').hidden = state.secure;
    $('ask').value = '';
    $('ask').setAttribute('placeholder', t(writeMode() ? 'What should Eden write here?' : 'Ask about this…'));
    $('put').textContent = t(writeMode() ? 'Insert' : 'Replace');
    $('answer').hidden = true;
    $('answer').textContent = '';
    $('tools').hidden = true;
    $('stop').hidden = true;
    if (state.secure) note(t('That’s a password field: Eden doesn’t read it.'), true);
    else if (!state.ax && !state.service && writeMode()) note(t('To read what you select and put text back, allow Eden in System Settings › Privacy & Security › Accessibility.'), true);
    else note('');
    if (state.reader) announce(writeMode() ? t('Eden: write here. Type what to write.') : `${t('Eden, with your selection')}${state.app ? ` ${t('from')} ${state.app}` : ''}. ${t('Pick an action or ask a question.')}`);
    setTimeout(() => (writeMode() || state.secure ? $(state.secure ? 'close' : 'ask') : doc.querySelector('.chip')).focus(), 30);
    fit();
  }

  function ask(req) {
    seq += 1;
    const id = `a${seq}`;
    asking = id;
    answer = '';
    last = req;
    const box = $('answer');
    box.hidden = false;
    box.textContent = '';
    box.classList.add('busy');
    box.setAttribute('aria-busy', 'true');
    $('tools').hidden = true;
    $('stop').hidden = false;
    note('');
    doc.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.action === req.action && !req.instruction)));
    if (state.reader) announce(t('Eden is answering…'));
    bridge.ask({ ...req, id, text: state.text, app: state.app, title: state.title, history: thread.slice() });
    fit();
  }

  function act(action) {
    const req = { action };
    if (action === 'translate') req.language = $('language').value;
    if (action === 'tone') req.tone = $('tone').value;
    thread = [];
    ask(req);
  }

  function send() {
    const words = $('ask').value.trim();
    if (!words) return;
    $('ask').value = '';
    // A follow-up carries the thread so far: the first request, then each answer and question.
    if (answer && last) {
      if (!thread.length) thread.push({ role: 'user', text: last.instruction || last.action });
      thread.push({ role: 'eden', text: answer });
    } else thread = [];
    ask({ action: writeMode() ? 'write' : 'ask', instruction: words });
  }

  bridge.onChunk((part) => {
    if (!part || part.id !== asking) return;
    answer += part.t;
    render($('answer'), answer);
    $('answer').scrollTop = $('answer').scrollHeight;
    fit();
  });

  bridge.onEnd((end) => {
    if (!end || end.id !== asking) return;
    asking = '';
    const box = $('answer');
    box.classList.remove('busy');
    box.removeAttribute('aria-busy');
    $('stop').hidden = true;
    if (end.error && !answer) {
      box.hidden = true;
      note(end.error, true);
      if (state.reader) announce(end.error);
      return;
    }
    if (thread.length) thread.push({ role: 'user', text: last.instruction || last.action });
    const edit = last && EDIT.has(last.action);
    $('tools').hidden = false;
    $('put').hidden = !edit && !writeMode();
    $('put').title = state.canPut ? '' : t('Copies it: Eden can’t paste into that app.');
    if (!state.canPut) $('put').textContent = t('Copy to paste');
    if (state.reader) announce(`${plain(answer)} ${t('Answer ready.')}`);
    ($('put').hidden ? $('copy') : $('put')).focus();
    fit();
  });

  async function put() {
    if (!answer) return;
    const done = await bridge.put(answer.trim()); // edit answers are the finished text, as pasted
    if (done && done.pasted) return; // the pop-up is gone
    const why = done && done.reason === 'accessibility'
      ? t('Copied. To paste it for you, allow Eden in System Settings › Privacy & Security › Accessibility; for now press ⌘V.')
      : t('Copied: press ⌘V where you want it.');
    note(why, done && done.reason === 'accessibility');
    if (state.reader) announce(why);
  }

  doc.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => act(chip.dataset.action)));
  $('askform').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('ask').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('ask').addEventListener('input', () => {
    const box = $('ask');
    box.style.height = 'auto';
    box.style.height = `${Math.min(96, box.scrollHeight)}px`;
    fit();
  });
  $('selection').addEventListener('click', () => { $('selection').classList.toggle('open'); fit(); });
  $('close').addEventListener('click', () => bridge.close());
  $('stop').addEventListener('click', () => { bridge.stop(); asking = ''; $('stop').hidden = true; $('answer').classList.remove('busy'); if (answer) $('tools').hidden = false; fit(); });
  $('put').addEventListener('click', put);
  $('copy').addEventListener('click', async () => {
    if (answer && (await bridge.copy(answer.trim()))) { note(t('Copied.')); if (state.reader) announce(t('Copied.')); }
  });
  $('speak').addEventListener('click', () => { if (answer) bridge.speak(answer); });
  $('again').addEventListener('click', () => { if (last) { if (thread.length) thread.pop(); ask({ ...last }); } });
  $('continue').addEventListener('click', async () => {
    if (!last) return;
    const ok = await bridge.continueInEden({ ...last, text: state.text, app: state.app, title: state.title, answer });
    if (!ok) note(t('Eden’s window isn’t answering just now.'), true);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); bridge.close(); return; }
    if (e.key === 'Enter' && e.metaKey && answer && !$('put').hidden) { e.preventDefault(); put(); }
  });
  bridge.onOpen(open);
  if (root.ResizeObserver) new root.ResizeObserver(fit).observe($('pop'));
}(typeof window !== 'undefined' ? window : null));
