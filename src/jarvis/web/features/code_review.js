// Jarvis Code's Review, in the Changes pane (features/code_review.py): Review and Deep review
// run on the session's changes; the findings are listed at the top and pinned under the
// lines they're about, each with "Fix this" (and "Fix all") to hand back to the session.
(() => {
  const F = window.jarvisFeatures;
  const C = window.JarvisChanges;
  if (!F || !C) return;
  const { el, send } = F;
  const results = new Map(); // session id -> its latest code_review event
  const asked = new Set(); // sessions whose review state was asked for once

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
    return b;
  }

  function actions(task, finding) {
    const box = el('span', 'jcx-factions');
    box.append(
      button('Fix this', 'jc-mini', () => send({ type: 'code_review_fix', id: task.id, finding: finding.id }), 'Hand it to the session to fix'),
      button('Dismiss', 'jc-mini', () => send({ type: 'code_review_dismiss', id: task.id, finding: finding.id })),
    );
    return box;
  }

  // A finding in full, as it's pinned under its line.
  function card(task, finding) {
    const box = el('div', `jcx-finding sev-${finding.severity}`);
    box.dataset.finding = finding.id;
    const head = el('div', 'jcx-fhead');
    const title = el('strong', '', finding.title);
    title.dataset.noI18n = '';
    head.append(el('span', `jcx-sev ${finding.severity}`, finding.severity), title, actions(task, finding));
    box.append(head);
    if (finding.detail) { const d = el('p', 'jcx-fdetail', finding.detail); d.dataset.noI18n = ''; box.append(d); }
    if (finding.fix) {
      const fix = el('p', 'jcx-ffix');
      const text = el('span', '', finding.fix);
      text.dataset.noI18n = '';
      fix.append(el('span', 'jcx-flabel', 'Suggested fix'), text);
      box.append(fix);
    }
    return box;
  }

  function top(task) {
    if (!asked.has(task.id)) { asked.add(task.id); send({ type: 'code_review_state', id: task.id }); }
    const result = results.get(task.id) || { status: 'none', findings: [] };
    const running = result.status === 'running';
    const wrap = el('div', 'jcx-review');
    const bar = el('div', 'jcx-rbar');
    const quick = button('Review', 'jc-btn small', () => send({ type: 'code_review', id: task.id, deep: false }),
      'Claude (Sonnet) reads these changes for real problems');
    const deep = button('Deep review', 'jc-btn small', () => send({ type: 'code_review', id: task.id, deep: true }),
      'Three reviewers read the project at once, then every finding is checked before it shows');
    quick.disabled = deep.disabled = running;
    bar.append(quick, deep);
    if (result.note) bar.append(el('span', `jc-dim jcx-rnote${running ? ' jc-sheen' : ''}`, result.note));
    const findings = result.findings || [];
    if (findings.length && !running) {
      bar.append(el('span', 'jc-spacer'), button('Fix all', 'jc-btn small filled', () => send({ type: 'code_review_fix', id: task.id, all: true }), 'Hand every finding to the session at once'));
    }
    wrap.append(bar);
    if (findings.length && !running) {
      const list = el('ul', 'jcx-flist');
      list.append(...findings.map((f) => {
        const li = el('li');
        const title = el('span', 'jcx-ftitle', f.title);
        title.dataset.noI18n = '';
        const where = el('code', '', f.line ? `${f.file}:${f.line}` : f.file);
        where.dataset.noI18n = '';
        li.append(el('span', `jcx-sev ${f.severity}`, f.severity), title, where, actions(task, f));
        li.addEventListener('click', () => {
          const pinned = document.querySelector(`.jcx-finding[data-finding="${CSS.escape(f.id)}"]`);
          if (pinned) { pinned.scrollIntoView({ block: 'center', behavior: 'smooth' }); pinned.classList.add('flash'); setTimeout(() => pinned.classList.remove('flash'), 1200); }
        });
        return li;
      }));
      wrap.append(list);
    }
    return wrap;
  }

  function after(task, path, side, line) {
    if (side !== 'n') return [];
    const result = results.get(task.id);
    if (!result || result.status === 'running') return [];
    return (result.findings || []).filter((f) => f.file === path && f.line === line).map((f) => card(task, f));
  }

  C.extend({ top, after });

  F.on('code_review', (ev) => {
    results.set(ev.id, ev);
    const task = F.currentTask();
    if (task && task.id === ev.id) C.render();
  });
})();
