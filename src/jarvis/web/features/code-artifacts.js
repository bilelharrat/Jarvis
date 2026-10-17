// Eden Code's artifacts, as in Claude (features/code_artifacts.py): a mockup, a page, a
// diagram or a document the session made with create_artifact shows in the Artifact pane
// beside the chat, live, and opens by itself when the session makes or changes one. A card in
// the transcript for each version; in the pane, Preview and Code, the version arrows, Copy,
// Download and Open in browser.
//
// The preview is the window's own server's /f/code-artifacts/<id>/<version>, in an iframe
// sandboxed without allow-same-origin (and the server's CSP sandboxes it too), so a mockup's
// scripts run but can't reach Eden Code. Everything else from the backend is text only
// (textContent), the owner's words marked data-no-i18n. Pure helpers are exported for
// node --test (tests/web/code-artifacts.test.mjs).
(function (root) {
  'use strict';

  const KINDS = { html: 'HTML', svg: 'SVG', markdown: 'Markdown' };
  const EXT = { html: 'html', svg: 'svg', markdown: 'md' };
  const MIME = { html: 'text/html', svg: 'image/svg+xml', markdown: 'text/markdown' };

  function validId(aid) {
    return typeof aid === 'string' && /^[0-9a-f]{24}$/.test(aid);
  }

  // Where a version is shown from: the window's own server, by id and version only.
  function frameSrc(aid, version) {
    const v = Math.floor(Number(version));
    return validId(aid) && v >= 1 ? `/f/code-artifacts/${aid}/${v}` : '';
  }

  // A file name for Download: the title, made safe, with the kind's extension.
  function fileName(title, kind) {
    const base = String(title || '').replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'artifact';
    return `${base}.${EXT[kind] || 'txt'}`;
  }

  function kindLabel(kind) {
    return KINDS[kind] || 'Artifact';
  }

  const api = { validId, frameSrc, fileName, kindLabel };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  // What the pane shows: an artifact, its version, the view; the content once it's come.
  const shown = { aid: '', version: 0, versions: 0, title: '', kind: '', content: null, error: '', code: false };

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function show(aid, version) {
    if (!validId(aid)) return;
    if (shown.aid !== aid) Object.assign(shown, { title: '', kind: '', versions: 0, code: false });
    Object.assign(shown, { aid, version: Number(version) || 0, content: null, error: '' });
    F.send({ type: 'art_get', aid, version: shown.version || undefined });
    F.openPane('artifact');
  }

  function card(e) {
    if (!validId(e.aid)) return null;
    const li = el('li', 'ca-card');
    const open = button('', 'ca-open', () => show(e.aid, e.version));
    open.setAttribute('aria-label', `${t('Open')} ${e.title || ''}`);
    const icon = el('span', `ca-icon ${e.kind || ''}`, e.kind === 'svg' ? '◇' : e.kind === 'markdown' ? '¶' : '</>');
    icon.setAttribute('aria-hidden', 'true');
    const txt = el('span', 'ca-txt');
    txt.append(mine(el('strong', '', e.title || 'Untitled')),
      el('small', '', `${t(kindLabel(e.kind))} · ${t('version')} ${Number(e.version) || 1}`));
    open.append(icon, txt, el('span', 'ca-cta', 'Open'));
    li.append(open);
    return li;
  }

  function download() {
    if (shown.content == null) return;
    const url = URL.createObjectURL(new Blob([shown.content], { type: `${MIME[shown.kind] || 'text/plain'};charset=utf-8` }));
    const a = el('a');
    a.href = url;
    a.download = fileName(shown.title, shown.kind);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function copy(b) {
    if (shown.content == null || !navigator.clipboard) return;
    navigator.clipboard.writeText(shown.content).then(() => {
      b.textContent = t('Copied');
      setTimeout(() => { b.textContent = t('Copy'); }, 1500);
    }, () => {});
  }

  function render(body) {
    body.classList.add('ca-body');
    if (!shown.aid) { body.replaceChildren(el('p', 'jc-empty', 'Nothing to show yet. Ask Eden Code to mock something up, design a page or draw a diagram.')); return; }
    if (shown.error) { body.replaceChildren(el('p', 'jc-empty', shown.error)); return; }
    if (shown.content == null) { body.replaceChildren(el('p', 'jc-dim', 'Opening…')); return; }

    const bar = el('div', 'ca-bar');
    const head = el('div', 'ca-head');
    head.append(mine(el('strong', '', shown.title || 'Untitled')), el('small', '', t(kindLabel(shown.kind))));
    const views = el('div', 'ca-seg');
    views.setAttribute('role', 'group');
    for (const [label, code] of [['Preview', false], ['Code', true]]) {
      const b = button(label, `ca-seg-btn${shown.code === code ? ' on' : ''}`, () => { shown.code = code; render(body); });
      b.setAttribute('aria-pressed', String(shown.code === code));
      views.append(b);
    }
    const nav = el('div', 'ca-nav');
    const prev = button('‹', 'jc-mini', () => show(shown.aid, shown.version - 1));
    prev.disabled = shown.version <= 1;
    prev.setAttribute('aria-label', t('Earlier version'));
    const next = button('›', 'jc-mini', () => show(shown.aid, shown.version + 1));
    next.disabled = shown.version >= shown.versions;
    next.setAttribute('aria-label', t('Later version'));
    nav.append(prev, el('small', '', `${shown.version} / ${shown.versions}`), next);
    bar.append(head, views, nav);

    const tools = el('div', 'ca-tools');
    const copyBtn = button('Copy', 'jc-mini', () => copy(copyBtn));
    tools.append(copyBtn, button('Download', 'jc-mini', download),
      button('Open in browser', 'jc-mini', () => F.send({ type: 'art_open', aid: shown.aid, version: shown.version, origin: location.origin })));

    let view;
    if (shown.code) {
      view = mine(el('pre', 'ca-code'));
      view.textContent = shown.content;
    } else if (shown.kind === 'markdown' && F.richText) {
      view = mine(el('div', 'ca-doc jc-md'));
      view.append(F.richText(shown.content));
    } else {
      view = document.createElement('iframe');
      view.className = 'ca-frame';
      view.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
      view.setAttribute('referrerpolicy', 'no-referrer');
      view.title = shown.title || t('Artifact');
      view.src = frameSrc(shown.aid, shown.version);
    }
    body.replaceChildren(bar, tools, view);
  }

  F.registerPane('artifact', { title: 'Artifact', render: (body) => render(body) });
  F.registerEntry('artifact', card);

  F.on('artifact_content', (ev) => {
    if (ev.aid !== shown.aid) return;
    if (ev.error) shown.error = String(ev.error);
    else Object.assign(shown, { version: ev.version, versions: ev.versions, title: ev.title, kind: ev.format, content: String(ev.content ?? '') });
    const body = F.$('jc-pane-body');
    if (body && F.$('jc-pane').dataset.kind === 'artifact') render(body);
  });

  // Made or changed in the session on show: open it, as Claude does.
  F.on('artifact', (ev) => {
    const task = F.currentTask();
    if (task && task.id === ev.id) show(ev.aid, ev.version);
  });

  F.registerMoreItem({
    label: 'Artifact',
    note: 'The mockup, page or diagram this session showed last',
    when: () => !!shown.aid,
    run: () => show(shown.aid, shown.version),
  });
})(typeof window === 'object' ? window : globalThis);
