// Eden Code's artifacts, as in Claude (features/code_artifacts.py): a mockup, an interactive
// React component, a page, a diagram or a document the session made with create_artifact shows
// in the Artifact pane beside the chat, live, and opens by itself when the session makes or
// changes one. A card in the transcript for each version; in the pane, Preview and Code, a
// session artifact switcher, the version arrows, Reload, Expand, Copy, Download and Open in
// browser, plus an "Open in Artifact" button on runnable code blocks in the chat.
//
// The preview is the window's own server's /f/code-artifacts/<id>/<version>, in an iframe
// sandboxed without allow-same-origin (and the server's CSP sandboxes it too), so a mockup's
// scripts run but can't reach Eden Code. Everything else from the backend is text only
// (textContent), the owner's words marked data-no-i18n. Pure helpers are exported for
// node --test (tests/web/code-artifacts.test.mjs).
(function (root) {
  'use strict';

  const KINDS = {
    html: 'HTML',
    react: 'React',
    svg: 'SVG',
    mermaid: 'Diagram',
    markdown: 'Markdown',
    code: 'Code',
  };
  const EXT = {
    html: 'html',
    react: 'jsx',
    svg: 'svg',
    mermaid: 'mmd',
    markdown: 'md',
    code: 'txt',
  };
  const MIME = {
    html: 'text/html',
    react: 'text/jsx',
    svg: 'image/svg+xml',
    mermaid: 'text/plain',
    markdown: 'text/markdown',
    code: 'text/plain',
  };
  const ICONS = {
    html: '</>',
    react: '⚛',
    svg: '◇',
    mermaid: '◈',
    markdown: '¶',
    code: '{ }',
  };

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

  function detectBlockKind(lang, code) {
    const l = String(lang || '').trim().toLowerCase();
    const src = String(code || '').trim();
    if (!src || src.length < 24) return '';
    if (l === 'html' || l === 'htm') {
      if (/<!doctype\s+html|<html[\s>]|<body[\s>]|<svg[\s>]|<(div|main|section|canvas|style|script)[\s>]/i.test(src)) return 'html';
    }
    if (l === 'svg' || (l === 'xml' && /^<svg[\s>]/i.test(src))) return 'svg';
    if (l === 'jsx' || l === 'tsx' || l === 'react') {
      if (/export\s+default\s+|function\s+[A-Z][A-Za-z0-9_]*\s*\(|return\s*\(\s*</.test(src)) return 'react';
    }
    if (l === 'mermaid' || l === 'mmd') return 'mermaid';
    return '';
  }

  const api = { validId, frameSrc, fileName, kindLabel, detectBlockKind };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  // What the pane shows: an artifact, its version, the view; the content once it's come.
  const shown = {
    aid: '',
    version: 0,
    versions: 0,
    title: '',
    kind: '',
    content: null,
    error: '',
    code: false,
    wide: false,
  };

  function button(label, cls, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function isPaneOpen() {
    const pane = F.$('jc-pane');
    return !!(pane && !pane.hidden && pane.dataset.kind === 'artifact');
  }

  // Distinct artifacts in the current session (newest version of each aid, in order).
  function sessionArtifacts() {
    const task = F.currentTask && F.currentTask();
    const entries = (task && Array.isArray(task.entries)) ? task.entries : [];
    const byId = new Map();
    for (const e of entries) {
      if (e && e.role === 'artifact' && validId(e.aid)) {
        byId.set(e.aid, {
          aid: e.aid,
          version: Number(e.version) || 1,
          title: e.title || 'Untitled',
          kind: e.kind || 'html',
        });
      }
    }
    return [...byId.values()];
  }

  function syncUi() {
    const open = isPaneOpen();
    const timeline = F.$('deck-timeline');
    if (timeline) {
      for (const li of timeline.querySelectorAll('.ca-card')) {
        const match = open && li.dataset.aid === shown.aid;
        li.classList.toggle('active', match);
        const cta = li.querySelector('.ca-cta');
        if (cta) {
          const exactVer = match && Number(li.dataset.version) === shown.version;
          cta.textContent = exactVer ? t('Viewing') : t('Open');
        }
      }
      // Hide redundant raw MCP tool rows when the clean artifact card is in the timeline.
      for (const row of timeline.querySelectorAll('.jc-tool-row')) {
        const name = row.querySelector('.jc-tool-name');
        if (name && /^mcp__eden_artifacts__(create|update)_artifact$/.test(name.textContent.trim())) {
          const item = row.closest('li');
          if (item) item.classList.add('ca-mcp-row-hidden');
        }
      }
    }
    const capBtn = F.$('jc-artifact-btn');
    if (capBtn) {
      const list = sessionArtifacts();
      const count = list.length;
      capBtn.hidden = count === 0 && !open;
      capBtn.setAttribute('aria-pressed', String(open));
      const badge = capBtn.querySelector('.ca-cap-count');
      if (badge) {
        badge.textContent = count > 0 ? String(count) : '';
        badge.hidden = count === 0;
      }
    }
  }

  function show(aid, version) {
    if (!validId(aid)) return;
    if (shown.aid !== aid) Object.assign(shown, { title: '', kind: '', versions: 0, code: false });
    Object.assign(shown, { aid, version: Number(version) || 0, content: null, error: '' });
    F.send({ type: 'art_get', aid, version: shown.version || undefined });
    F.openPane('artifact');
    syncUi();
  }

  function card(e) {
    if (!validId(e.aid)) return null;
    const ver = Number(e.version) || 1;
    const li = el('li', 'ca-card');
    li.dataset.aid = e.aid;
    li.dataset.version = String(ver);
    const open = button('', 'ca-open', () => show(e.aid, ver));
    open.setAttribute('aria-label', `${t('Open')} ${e.title || ''}`);
    const icon = el('span', `ca-icon ${e.kind || ''}`, ICONS[e.kind] || '</>');
    icon.setAttribute('aria-hidden', 'true');
    const txt = el('span', 'ca-txt');
    txt.append(
      mine(el('strong', '', e.title || 'Untitled')),
      el('small', '', `${t(kindLabel(e.kind))} · ${t('version')} ${ver}`),
    );
    open.append(icon, txt, el('span', 'ca-cta', 'Open'));
    li.append(open);
    queueMicrotask(syncUi);
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

  function ensureResizeHandle() {
    const pane = F.$('jc-pane');
    if (!pane || pane.querySelector('.ca-resize')) return;
    const handle = el('div', 'ca-resize');
    handle.title = t('Drag to resize · Double-click to reset');
    handle.addEventListener('pointerdown', (ev) => {
      if (pane.dataset.kind !== 'artifact') return;
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      pane.classList.add('ca-resizing');
      const onMove = (m) => {
        const w = Math.max(340, Math.min(window.innerWidth * 0.78, window.innerWidth - m.clientX - 8));
        document.documentElement.style.setProperty('--ca-pane-w', `${Math.round(w)}px`);
      };
      const onUp = () => {
        pane.classList.remove('ca-resizing');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
    handle.addEventListener('dblclick', () => {
      shown.wide = false;
      pane.classList.remove('ca-wide');
      document.documentElement.style.removeProperty('--ca-pane-w');
    });
    pane.prepend(handle);
  }

  function render(body) {
    body.classList.add('ca-body');
    ensureResizeHandle();
    const pane = F.$('jc-pane');
    if (pane) pane.classList.toggle('ca-wide', !!shown.wide);

    // If opened before an artifact was selected, pick the session's latest artifact automatically.
    if (!shown.aid) {
      const list = sessionArtifacts();
      if (list.length) {
        const last = list[list.length - 1];
        show(last.aid, last.version);
        return;
      }
      const empty = el('div', 'ca-empty-wrap');
      const badge = el('div', 'ca-empty-icon', '</>');
      badge.setAttribute('aria-hidden', 'true');
      const msg = el('p', 'jc-empty', 'Nothing to show yet. Ask Eden Code to mock something up, design a page or draw a diagram.');
      const sub = el('p', 'ca-empty-sub', t('Interactive HTML, React components, SVG graphics, Mermaid diagrams and Markdown documents open right here beside the chat.'));
      empty.append(badge, msg, sub);
      body.replaceChildren(empty);
      syncUi();
      return;
    }
    if (shown.error) { body.replaceChildren(el('p', 'jc-empty', shown.error)); syncUi(); return; }
    if (shown.content == null) { body.replaceChildren(el('p', 'jc-dim', 'Opening…')); syncUi(); return; }

    const bar = el('div', 'ca-bar');
    const views = el('div', 'ca-seg');
    views.setAttribute('role', 'group');
    for (const [label, code] of [['Preview', false], ['Code', true]]) {
      const b = button(label, `ca-seg-btn${shown.code === code ? ' on' : ''}`, () => { shown.code = code; render(body); });
      b.setAttribute('aria-pressed', String(shown.code === code));
      views.append(b);
    }

    const head = el('div', 'ca-head');
    const list = sessionArtifacts();
    if (list.length > 1) {
      const pick = el('select', 'ca-pick');
      pick.setAttribute('aria-label', t('Switch artifact'));
      for (const item of list) {
        const opt = el('option', '', `${item.title} (${kindLabel(item.kind)})`);
        opt.value = item.aid;
        opt.selected = item.aid === shown.aid;
        pick.append(mine(opt));
      }
      pick.addEventListener('change', () => {
        const found = list.find((x) => x.aid === pick.value);
        if (found) show(found.aid, found.version);
      });
      head.append(mine(el('strong', '', shown.title || 'Untitled')), pick);
    } else {
      head.append(mine(el('strong', '', shown.title || 'Untitled')), el('small', '', t(kindLabel(shown.kind))));
    }

    const nav = el('div', 'ca-nav');
    const prev = button('‹', 'jc-mini', () => show(shown.aid, shown.version - 1));
    prev.disabled = shown.version <= 1;
    prev.setAttribute('aria-label', t('Earlier version'));
    const next = button('›', 'jc-mini', () => show(shown.aid, shown.version + 1));
    next.disabled = shown.version >= shown.versions;
    next.setAttribute('aria-label', t('Later version'));
    nav.append(prev, el('small', '', `${shown.version} / ${shown.versions}`), next);

    const actions = el('div', 'ca-actions');
    if (!shown.code && shown.kind !== 'markdown') {
      const reloadBtn = button('↻', 'jc-mini ca-icon-btn', () => {
        const frame = body.querySelector('iframe.ca-frame');
        if (frame) frame.src = frameSrc(shown.aid, shown.version);
      });
      reloadBtn.title = t('Reload preview');
      reloadBtn.setAttribute('aria-label', t('Reload preview'));
      actions.append(reloadBtn);
    }
    const wideBtn = button(shown.wide ? '⤡' : '⤢', 'jc-mini ca-icon-btn', () => {
      shown.wide = !shown.wide;
      if (pane) pane.classList.toggle('ca-wide', shown.wide);
      wideBtn.textContent = shown.wide ? '⤡' : '⤢';
      wideBtn.setAttribute('aria-pressed', String(shown.wide));
    });
    wideBtn.title = shown.wide ? t('Restore width') : t('Expand width');
    wideBtn.setAttribute('aria-label', wideBtn.title);
    wideBtn.setAttribute('aria-pressed', String(!!shown.wide));
    actions.append(wideBtn);

    bar.append(head, views, nav, actions);

    const tools = el('div', 'ca-tools');
    const lines = String(shown.content || '').split('\n').length;
    const meta = el('span', 'ca-meta', `${t(kindLabel(shown.kind))} · v${shown.version} · ${lines} ${lines === 1 ? t('line') : t('lines')}`);
    const toolsRight = el('div', 'ca-tools-right');
    const copyBtn = button('Copy', 'jc-mini', () => copy(copyBtn));
    toolsRight.append(
      copyBtn,
      button('Download', 'jc-mini', download),
      button('Open in browser', 'jc-mini', () => F.send({ type: 'art_open', aid: shown.aid, version: shown.version, origin: location.origin })),
    );
    tools.append(meta, toolsRight);

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
    syncUi();
  }

  // Add an "Open in Artifact" button on runnable fenced code blocks in chat replies.
  function decorateChatBlocks() {
    const timeline = F.$('deck-timeline');
    if (!timeline) return;
    for (const pre of timeline.querySelectorAll('.jc-say .jc-md pre')) {
      if (pre.dataset.caReady) continue;
      pre.dataset.caReady = '1';
      const head = pre.querySelector('.jc-code-head');
      const codeEl = pre.querySelector('code');
      if (!head || !codeEl) continue;
      const langSpan = head.querySelector('span');
      const lang = langSpan ? langSpan.textContent.trim() : '';
      const raw = codeEl.textContent || '';
      const kind = detectBlockKind(lang, raw);
      if (!kind) continue;
      const btn = button(t('Open in Artifact'), 'jc-copy ca-run-btn', () => {
        const task = F.currentTask && F.currentTask();
        if (!task) return;
        const m = raw.match(/<title>([^<]+)<\/title>/i) || raw.match(/function\s+([A-Z][A-Za-z0-9_]*)/);
        const title = (m && m[1] ? m[1].trim() : `${kindLabel(kind)} preview`).slice(0, 80);
        F.send({ type: 'art_create', id: task.id, title, kind, content: raw });
      });
      head.insertBefore(btn, head.querySelector('.jc-copy'));
    }
  }

  function ensureCapsuleButton() {
    const cap = document.querySelector('.jc-capsule');
    if (!cap || F.$('jc-artifact-btn')) return;
    const btn = button('', 'jc-cap-btn ca-cap-btn', () => {
      if (isPaneOpen()) {
        F.closePane();
        syncUi();
      } else {
        const list = sessionArtifacts();
        if (!shown.aid && list.length) {
          const last = list[list.length - 1];
          show(last.aid, last.version);
        } else {
          F.openPane('artifact');
          syncUi();
        }
      }
    });
    btn.id = 'jc-artifact-btn';
    btn.title = t('Artifact pane');
    btn.setAttribute('aria-label', t('Artifact'));
    const icon = el('span', 'ca-cap-icon', '</>');
    icon.setAttribute('aria-hidden', 'true');
    const label = el('span', 'ca-cap-label', t('Artifact'));
    const count = el('span', 'ca-cap-count', '');
    count.hidden = true;
    btn.append(icon, label, count);
    btn.hidden = true;
    const more = F.$('jc-more-btn');
    if (more && more.parentNode === cap) cap.insertBefore(btn, more);
    else cap.append(btn);
  }

  F.registerPane('artifact', { title: 'Artifact', render: (body) => render(body) });
  F.registerEntry('artifact', card);

  F.on('artifact_content', (ev) => {
    if (ev.aid !== shown.aid) return;
    if (ev.error) shown.error = String(ev.error);
    else Object.assign(shown, { version: ev.version, versions: ev.versions, title: ev.title, kind: ev.format, content: String(ev.content ?? '') });
    const body = F.$('jc-pane-body');
    if (body && F.$('jc-pane').dataset.kind === 'artifact') render(body);
    syncUi();
  });

  // Made or changed in the session on show: open it, as Claude does.
  F.on('artifact', (ev) => {
    const task = F.currentTask();
    if (task && task.id === ev.id) show(ev.aid, ev.version);
    else syncUi();
  });

  F.on('active', () => {
    const list = sessionArtifacts();
    if (list.length) {
      const last = list[list.length - 1];
      if (!list.some((x) => x.aid === shown.aid)) {
        if (isPaneOpen()) show(last.aid, last.version);
        else Object.assign(shown, { aid: last.aid, version: last.version, title: last.title, kind: last.kind, content: null, error: '' });
      }
    } else {
      Object.assign(shown, { aid: '', version: 0, versions: 0, title: '', kind: '', content: null, error: '' });
      if (isPaneOpen() && F.closePane) F.closePane();
    }
    decorateChatBlocks();
    syncUi();
  });

  F.on('task_log', () => {
    queueMicrotask(() => {
      decorateChatBlocks();
      syncUi();
    });
  });

  F.on('init', () => {
    ensureCapsuleButton();
    decorateChatBlocks();
    syncUi();
  });
  ensureCapsuleButton();

  F.registerMoreItem({
    label: 'Artifact',
    note: 'Interactive preview beside the chat (HTML, React, SVG, Mermaid, Markdown)',
    when: () => sessionArtifacts().length > 0,
    run: () => {
      const list = sessionArtifacts();
      if (!shown.aid && list.length) {
        const last = list[list.length - 1];
        show(last.aid, last.version);
      } else if (shown.aid && shown.content == null) {
        show(shown.aid, shown.version);
      } else {
        F.openPane('artifact');
        syncUi();
      }
    },
  });
})(typeof window === 'object' ? window : globalThis);
