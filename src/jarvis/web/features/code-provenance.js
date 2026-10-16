// Eden Code's provenance overlay (features/code_provenance.py): which session and prompt
// wrote a line. When Eden commits a session's work it leaves a git note (refs/notes/eden,
// never the commit message) naming the session, model and turn of each hunk; this file
// shows them:
// - in the Files pane's editor (code-editor.js, through JarvisEditor.extendDoc), a "Who
//   wrote this" button on an open file: a bar in the margin beside every line a session
//   wrote (git blame finds the commit, its note the turn), and the caret's line named under
//   the text, with a button to its turn's proof (the receipt in the conversation);
// - in the Changes pane (code_changes.js, through JarvisChanges.extend), the same button:
//   each hunk not committed yet is labelled with the turn that wrote it, from the
//   session's own marks;
// - Settings › General › Provenance: the notes on or off (code_provenance), and adding them
//   to pull requests (code_provenance_pr, off).
// Pure logic exported for node's tests (tests/web/code-provenance.test.mjs).
(function codeProvenance(root) {
  'use strict';

  // The span a line is in: its index in spans ([first, last, who]), or -1.
  function spanAt(spans, line) {
    let lo = 0, hi = (Array.isArray(spans) ? spans.length : 0) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = spans[mid];
      if (line < a) hi = mid - 1;
      else if (line > b) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  // Who wrote a line, or null.
  function whoAt(event, line) {
    if (!event || !Array.isArray(event.who)) return null;
    const i = spanAt(event.spans, line);
    return i < 0 ? null : event.who[event.spans[i][2]] || null;
  }

  // The short label: "Turn 2: “fix the login”", or the session's title when no turn wrote it.
  function label(who) {
    if (!who) return '';
    if (who.turn) return who.summary ? `Turn ${who.turn}: “${who.summary}”` : `Turn ${who.turn}`;
    return who.title ? `Session “${who.title}”` : `Session ${who.task || ''}`.trim();
  }

  // Everything about it, in one line (a tooltip, a screen reader).
  function detail(who) {
    if (!who) return '';
    const parts = [`Written by Eden Code session ${who.title ? `“${who.title}”` : who.task}`];
    if (who.model) parts.push(who.model);
    if (who.turn) parts.push(label(who));
    if (who.digest) parts.push(`prompt ${who.digest}`);
    if (who.commit) parts.push(`commit ${who.commit}`);
    if (who.at) parts.push(String(who.at).replace('T', ' '));
    return parts.join(' · ');
  }

  // Where each span's bar goes, in the text's own pixels (the layer scrolls with it).
  function bars(spans, lineHeight, pad) {
    return (Array.isArray(spans) ? spans : []).map(([a, b, w]) => ({ top: pad + (a - 1) * lineHeight, height: (b - a + 1) * lineHeight, who: w }));
  }

  const api = { spanAt, whoAt, label, detail, bars };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;
  const el = F.el;
  const t = (text) => F.t(text);
  let on = true; // code_provenance (Settings)
  const blames = new Map(); // an editor doc's key -> its code_provenance_blame event
  const showing = new Set(); // editor doc keys with the overlay on

  function button(words, cls, run, title) {
    const b = el('button', cls, t(words));
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
    return b;
  }

  // The turn's proof card in the conversation: its session is opened first when another
  // is on show (a session that has ended since may not be in the list: nothing happens).
  function toProof(who, again = true) {
    if (!who || !who.receipt) return false;
    const task = F.currentTask();
    if (!task || task.id !== who.task) {
      if (!again || typeof F.selectTask !== 'function') return false;
      F.selectTask(who.task);
      setTimeout(() => toProof(who, false), 300);
      return true;
    }
    const entry = document.querySelector(`li[data-n="${Number(who.receipt)}"]`);
    if (!entry) return false;
    entry.scrollIntoView({ block: 'center', behavior: 'smooth' });
    entry.classList.add('cpv-flash');
    setTimeout(() => entry.classList.remove('cpv-flash'), 1600);
    return true;
  }

  // ── the editor ──

  function ask(doc) {
    F.send({ type: 'code_provenance_blame', ...(doc.where || {}), path: doc.rel || doc.path, ref: doc.key });
  }

  function layerOf(doc) {
    if (!doc.ui || !doc.ui.ta) return null;
    if (!doc.ui.cpv) {
      const host = doc.ui.ta.parentElement;
      const layer = el('div', 'cpv-layer');
      layer.setAttribute('aria-hidden', 'true');
      const inner = el('div', 'cpv-inner');
      layer.append(inner);
      host.append(layer);
      const line = el('span', 'cpv-caret');
      if (doc.ui.status) doc.ui.status.insertBefore(line, doc.ui.facts || null);
      doc.ui.ta.addEventListener('scroll', () => { inner.style.transform = `translateY(${-doc.ui.ta.scrollTop}px)`; });
      doc.ui.cpv = { layer, inner, line };
    }
    return doc.ui.cpv;
  }

  function paint(doc) {
    const parts = layerOf(doc);
    if (!parts) return;
    const event = showing.has(doc.key) ? blames.get(doc.key) : null;
    parts.layer.hidden = !event;
    parts.line.hidden = !event;
    if (!event) { parts.inner.replaceChildren(); parts.line.replaceChildren(); return; }
    const style = getComputedStyle(doc.ui.ta);
    const lh = parseFloat(style.lineHeight) || 18;
    const pad = parseFloat(style.paddingTop) || 0;
    parts.inner.replaceChildren(...bars(event.spans, lh, pad).map((b) => {
      const bar = el('div', `cpv-bar cpv-c${b.who % 6}`);
      bar.style.top = `${b.top}px`;
      bar.style.height = `${b.height}px`;
      bar.title = detail(event.who[b.who]);
      return bar;
    }));
    parts.inner.style.transform = `translateY(${-doc.ui.ta.scrollTop}px)`;
    caret(doc);
  }

  function caret(doc, line) {
    const parts = doc.ui && doc.ui.cpv;
    const event = showing.has(doc.key) ? blames.get(doc.key) : null;
    if (!parts || !event) return;
    if (line === undefined) {
      const ta = doc.ui.ta;
      line = ta.value.slice(0, ta.selectionStart).split('\n').length;
    }
    const who = whoAt(event, line);
    if (!who) {
      parts.line.replaceChildren(el('span', 'cpv-none', event.note || (event.spans.length ? t('Not written by an Eden Code session (or not committed yet)') : t('No provenance notes for this file'))));
      return;
    }
    const words = el('span', 'cpv-who', label(who));
    words.title = detail(who);
    words.dataset.noI18n = '';
    const out = [words];
    if (who.receipt) out.push(button('Proof', 'jc-mini cpv-proof', () => toProof(who), 'Show that turn’s receipt in the conversation'));
    parts.line.replaceChildren(...out);
  }

  function attachEditor() {
    const E = root.JarvisEditor;
    if (!E || !E.extendDoc) return false;
    E.extendDoc({
      bar(doc) {
        docsByKey.set(doc.key, doc);
        if (!on) return [];
        const pressed = showing.has(doc.key);
        const b = button('Who wrote this', `jc-mini cpv-toggle${pressed ? ' on' : ''}`, () => {
          if (showing.has(doc.key)) showing.delete(doc.key); else { showing.add(doc.key); ask(doc); }
          E.redrawBar(doc);
          paint(doc);
        }, 'Which Eden Code session and prompt wrote each line (from git notes)');
        b.setAttribute('aria-pressed', String(pressed));
        return [b];
      },
      caret(doc, line) { caret(doc, line); return []; },
      filled(doc) { if (showing.has(doc.key)) ask(doc); return []; },
    });
    return true;
  }

  F.on('code_provenance_blame', (ev) => {
    if (!ev || !ev.ref) return;
    blames.set(ev.ref, ev);
    const doc = findDoc(ev.ref);
    if (doc) paint(doc);
  });

  // The editor's docs aren't exported: each is remembered when its bar is drawn.
  const docsByKey = new Map();
  function findDoc(key) { return docsByKey.get(key) || null; }

  // ── the Changes pane ──

  let changesOn = false;
  const hunkWho = new Map(); // `${id}:${view}` -> { hunk id: who }
  let askedFor = null; // the code_changes event the hunks were last asked for

  function decorate(task, data) {
    const who = hunkWho.get(`${task.id}:${data && data.view}`) || {};
    for (const box of document.querySelectorAll('.jcx-hunk[data-hunk]')) {
      const head = box.querySelector('.jcx-hunk-head');
      if (!head) continue;
      const old = head.querySelector('.cpv-chip');
      if (old) old.remove();
      const w = changesOn && who[box.dataset.hunk];
      if (!w) continue;
      const chip = el('span', 'cpv-chip', label(w));
      chip.title = detail(w);
      chip.dataset.noI18n = '';
      const spacer = head.querySelector('.jc-spacer');
      head.insertBefore(chip, spacer || null);
    }
  }

  function attachChanges() {
    const C = root.JarvisChanges;
    if (!C || !C.extend) return false;
    C.extend({
      top(task, data) {
        if (!on || !task || !data || !data.git) return null;
        const b = button('Who wrote this', `jc-mini cpv-toggle${changesOn ? ' on' : ''}`, () => {
          changesOn = !changesOn;
          askedFor = null;
          C.render();
        }, 'Label each change with the turn and prompt that wrote it');
        b.setAttribute('aria-pressed', String(changesOn));
        if (changesOn && askedFor !== data) {
          askedFor = data;
          F.send({ type: 'code_provenance_hunks', id: task.id, view: data.view || 'session' });
        }
        setTimeout(() => decorate(task, data), 0);  // (the hunks are drawn after this part)
        const row = el('div', 'cpv-row');
        row.append(b);
        return row;
      },
    });
    return true;
  }

  F.on('code_provenance_hunks', (ev) => {
    if (!ev) return;
    hunkWho.set(`${ev.id}:${ev.view}`, ev.hunks || {});
    const task = F.currentTask();
    if (task && task.id === ev.id) decorate(task, { view: ev.view });
  });

  // Both panes load after this file (name order): attached once they're there.
  let tries = 0;
  let editorDone = false, changesDone = false;
  (function attach() {
    editorDone = editorDone || attachEditor();
    changesDone = changesDone || attachChanges();
    if ((!editorDone || !changesDone) && tries++ < 100) setTimeout(attach, 50);
  })();

  // ── Eden Code settings › General › Provenance ──
  const switches = {};
  let pr = false;
  function sw(id, key, words, small, get, set) {
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(words)), el('small', '', t(small)));
    const b = el('button', 'jcs-switch');
    b.type = 'button';
    b.id = id;
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', t(words));
    b.setAttribute('aria-checked', String(get()));
    b.addEventListener('click', () => {
      set(!get());
      b.setAttribute('aria-checked', String(get()));
      F.send({ type: 'feature_prefs', changes: { [key]: get() } });
    });
    row.append(text, b);
    switches[key] = b;
    return row;
  }
  function build() {
    const general = typeof document !== 'undefined' && document.getElementById('jcs-general');
    if (!general || document.getElementById('cpv-on')) return;
    const heading = el('p', 'jcs-label', t('Provenance'));
    const group = el('div', 'jcs-group');
    group.append(
      sw('cpv-on', 'code_provenance', 'Provenance notes',
        'When Eden commits a session’s work, a git note (refs/notes/eden) says which session, model and prompt wrote each change. Never in the commit message, and kept on this Mac: Eden never pushes notes.',
        () => on, (v) => { on = v; }),
      sw('cpv-pr', 'code_provenance_pr', 'Add provenance to pull requests',
        'A “Provenance” section in the descriptions Eden drafts: each session and prompt summary behind the branch. Off: prompts stay private.',
        () => pr, (v) => { pr = v; }),
    );
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(heading, foot); else general.append(heading);
    general.insertBefore(group, heading.nextSibling);
  }
  const take = (features) => {
    const f = features || {};
    on = f.code_provenance !== false;
    pr = f.code_provenance_pr === true;
    if (switches.code_provenance) switches.code_provenance.setAttribute('aria-checked', String(on));
    if (switches.code_provenance_pr) switches.code_provenance_pr.setAttribute('aria-checked', String(pr));
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
