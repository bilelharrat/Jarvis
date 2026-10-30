(function () {
  'use strict';

  const PANE_DATA = [
    {
      num: '1',
      title: 'Liquid Glass UI & 6-Pane Split',
      branch: 'ios-app-store-prep',
      user: 'Make a mockup of Eden Code in Liquid Glass with Claude Code output and multi-split panes.',
      chips: ['🖼 4.png', '📄 DESIGN.md'],
      tools: [
        ['Read', 'DESIGN.md · lines 1–95'],
        ['Edit', 'src/eden_code/web/eden-code.css (+48 −12)'],
      ],
      reply: 'Updated the window shell, sidebar rail, split panes, and floating composer to use translucent Liquid Glass layers with top specular highlights.',
      diffFile: 'src/eden_code/web/eden-code.css',
      diffDel: '- background: #111318;',
      diffAdd: '+ background: rgba(18, 22, 32, 0.46);\n+ backdrop-filter: blur(42px) saturate(195%);\n+ box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, 0.22);'
    },
    {
      num: '2',
      title: 'Native Argon 4 Engine Loop',
      branch: 'main',
      user: 'Verify that the native engine runs standalone with all 6 split panes active.',
      chips: ['📄 code-split.js'],
      tools: [
        ['Read', 'src/eden_code/web/features/code-split/window.js'],
        ['Bash', 'pytest tests/test_code_split.py (6 passed)'],
      ],
      reply: 'All 10 panes run independent sessions simultaneously with drag-to-resize dividers and ⌘1–⌘0 focus shortcuts.',
      diffFile: 'src/eden_code/web/features/code-split/window.js',
      diffDel: '- const MAX_PANES = 2;',
      diffAdd: '+ const MAX_PANES = 10; // Up to 10 live sessions side by side'
    },
    {
      num: '3',
      title: 'Claude Browser Parity',
      branch: 'main',
      user: 'Inspect the live localhost preview and capture console logs.',
      chips: ['🌐 localhost:5174'],
      tools: [
        ['Browser', 'browser_open http://localhost:5174'],
        ['Check', '0 console errors · 60fps glass compositing'],
      ],
      reply: 'Live browser tab connected with element picker, screenshot capture, and DevBar active.',
      diffFile: 'src/eden_code/web/app.js',
      diffDel: '- // browser bar hidden',
      diffAdd: '+ initBrowserDevBar({ pick: true, console: true, screenshot: true });'
    },
    {
      num: '4',
      title: 'Full-Window Drag Regions',
      branch: 'main',
      user: 'Make sure dragging anywhere on the background moves the macOS window.',
      chips: ['📄 index.html'],
      tools: [
        ['Edit', 'src/eden_code/web/eden-code.css'],
      ],
      reply: 'Applied -webkit-app-region: drag across the window shell with no-drag on interactive controls.',
      diffFile: 'src/eden_code/web/eden-code.css',
      diffDel: '- .titlebar { -webkit-app-region: drag; }',
      diffAdd: '+ body.eden-code { -webkit-app-region: drag; }'
    },
    {
      num: '5',
      title: 'Session Persistence Store',
      branch: 'main',
      user: 'Ensure chat history never disappears across restarts.',
      chips: ['📄 jsonstore.py'],
      tools: [
        ['Read', 'src/eden_code/jsonstore.py'],
        ['Bash', 'pytest tests/test_persistence.py (passed)'],
      ],
      reply: 'Atomic write-ahead snapshots keep all session transcripts intact without TTL eviction.',
      diffFile: 'src/eden_code/tasks.py',
      diffDel: '- prune_older_than(days=7)',
      diffAdd: '+ keep_all_sessions(atomic_backup=True)'
    },
    {
      num: '6',
      title: 'iOS App Store Prep',
      branch: 'ios-app-store-prep',
      user: 'Check InfoPlist strings and share sheet entitlements.',
      chips: ['📱 Eden.xcodeproj'],
      tools: [
        ['Read', 'ios/Eden/Info.plist'],
      ],
      reply: 'All 4 targets (Eden, EdenEdu, EdenMail, EdenShare) pass validation with zero warnings.',
      diffFile: 'ios/Eden/Info.plist',
      diffDel: '- <string>1</string>',
      diffAdd: '+ <string>2</string>'
    }
  ];

  let currentLayout = '2';

  function renderPanes(count) {
    const grid = document.getElementById('pane-grid');
    if (!grid) return;
    grid.dataset.layout = String(count);
    const badge = document.getElementById('split-badge');
    if (badge) badge.textContent = String(count);
    grid.innerHTML = '';
    const items = PANE_DATA.slice(0, Number(count));
    items.forEach((p, idx) => {
      const card = document.createElement('article');
      card.className = 'glass-pane-card' + (idx === 0 ? ' focused' : '');
      card.addEventListener('click', () => {
        document.querySelectorAll('.glass-pane-card').forEach(c => c.classList.remove('focused'));
        card.classList.add('focused');
      });
      card.innerHTML = `
        <div class="pane-bar">
          <div class="pane-bar-left">
            <span class="pane-num">⌘${p.num}</span>
            <span class="pane-title-txt">${p.title}</span>
          </div>
          <span class="pane-branch">⎇ ${p.branch}</span>
        </div>
        <div class="chat-stream">
          <div class="msg-user">
            <div class="attach-row">
              ${p.chips.map(c => `<span class="attach-chip">${c}</span>`).join('')}
            </div>
            ${p.user}
          </div>
          <div class="tool-stack">
            ${p.tools.map(t => `
              <div class="tool-line">
                <span class="tool-bullet"></span>
                <span class="tool-verb">${t[0]}</span>
                <span class="tool-arg">${t[1]}</span>
              </div>
            `).join('')}
          </div>
          <div class="msg-assistant">
            <p>${p.reply}</p>
            <div class="glass-code-card">
              <div class="code-head">
                <span>${p.diffFile}</span>
                <span>Unified Diff</span>
              </div>
              <pre class="code-body"><span class="diff-del">${p.diffDel}</span><span class="diff-add">${p.diffAdd}</span></pre>
            </div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  function setLayout(n) {
    currentLayout = String(n);
    document.querySelectorAll('[data-layout-btn]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-layout-btn') === currentLayout);
    });
    renderPanes(currentLayout);
  }

  function setTheme(mode) {
    if (mode === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    document.querySelectorAll('[data-theme-btn]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-theme-btn') === mode);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-layout-btn]').forEach(btn => {
      btn.addEventListener('click', () => setLayout(btn.getAttribute('data-layout-btn')));
    });
    document.querySelectorAll('[data-theme-btn]').forEach(btn => {
      btn.addEventListener('click', () => setTheme(btn.getAttribute('data-theme-btn')));
    });
    const cycleBtn = document.getElementById('cycle-split-btn');
    if (cycleBtn) {
      cycleBtn.addEventListener('click', () => {
        const next = currentLayout === '1' ? '2' : currentLayout === '2' ? '6' : '1';
        setLayout(next);
      });
    }
    const orb = document.getElementById('jc-orb');
    const comp = document.getElementById('deck-composer');
    if (orb && comp) {
      orb.addEventListener('click', () => {
        const exp = comp.classList.toggle('expanded');
        orb.setAttribute('aria-expanded', String(exp));
      });
    }
    renderPanes(2);
    initPalette();
  });

  /* ── Universal Palette Engine (Eden Chat style + Claude search features) ── */
  const PAL_FILES = [
    { path: 'src/chat/code.ts', name: 'code.ts', dir: 'src/chat', ext: 'ts' },
    { path: 'src/chat/memory.ts', name: 'memory.ts', dir: 'src/chat', ext: 'ts' },
    { path: 'src/chat/recall-model.ts', name: 'recall-model.ts', dir: 'src/chat', ext: 'ts' },
    { path: 'web/chat/app.js', name: 'app.js', dir: 'web/chat', ext: 'js' },
    { path: 'web/chat/eden-code-glass.html', name: 'eden-code-glass.html', dir: 'web/chat', ext: 'html' },
    { path: 'web/chat/eden-code-glass.js', name: 'eden-code-glass.js', dir: 'web/chat', ext: 'js' },
    { path: 'web/chat/chat.js', name: 'chat.js', dir: 'web/chat', ext: 'js' },
    { path: 'web/chat/render.js', name: 'render.js', dir: 'web/chat', ext: 'js' },
    { path: 'ios/Eden/Info.plist', name: 'Info.plist', dir: 'ios/Eden', ext: 'plist' },
    { path: 'ios/Eden/InfoPlist.xcstrings', name: 'InfoPlist.xcstrings', dir: 'ios/Eden', ext: 'xcstrings' },
    { path: 'src/__tests__/recall-model.test.ts', name: 'recall-model.test.ts', dir: 'src/__tests__', ext: 'ts' },
    { path: 'ROADMAP.md', name: 'ROADMAP.md', dir: '.', ext: 'md' },
    { path: 'DESIGN.md', name: 'DESIGN.md', dir: '.', ext: 'md' }
  ];

  const PAL_SYMBOLS = [
    { name: 'openPalette', kind: 'function', sym: 'ƒ', file: 'web/chat/app.js', line: 767, sig: '() => void' },
    { name: 'renderPal', kind: 'function', sym: 'ƒ', file: 'web/chat/app.js', line: 779, sig: '(q: string) => void' },
    { name: 'findRecall', kind: 'function', sym: 'ƒ', file: 'web/chat/recall-model.js', line: 42, sig: '(query, chats, options) => RecallResult[]' },
    { name: 'similarity', kind: 'function', sym: 'ƒ', file: 'site/src/eden/memory.js', line: 18, sig: '(a: string, b: string) => number' },
    { name: 'applyForget', kind: 'function', sym: 'ƒ', file: 'site/src/eden/memory.js', line: 55, sig: '(items, query) => Memory[]' },
    { name: 'Argon4Engine', kind: 'class', sym: '◈', file: 'src/eden_code/engine.py', line: 120, sig: 'class Argon4Engine(BaseEngine)' },
    { name: 'Workspace', kind: 'class', sym: '◈', file: 'src/jarvis/features/code_workspace.py', line: 50, sig: 'class Workspace' },
    { name: 'cmd_search', kind: 'method', sym: '◇', file: 'src/jarvis/features/code_workspace.py', line: 184, sig: 'async def cmd_search(self, msg)' }
  ];

  const PAL_GREP = [
    { file: 'web/chat/app.js', line: 767, code: 'function openPalette() { clearPhoneOverlays(); $(\'palette\').classList.add(\'open\'); }', match: 'openPalette' },
    { file: 'web/chat/recall-model.js', line: 114, code: 'export function parseTemporalWindow(str) { return str.replace(/\\s+/g, \' \'); }', match: 'parseTemporalWindow' },
    { file: 'site/src/eden/memory.js', line: 24, code: 'if (minSize === 1 && x.size !== y.size) return shared / Math.max(x.size, y.size);', match: 'minSize === 1' },
    { file: 'src/jarvis/code_search.py', line: 34, code: 'MATCHES_MAX = 2000; PER_FILE_MAX = 100; FILES_MAX = 500;', match: 'MATCHES_MAX' }
  ];

  const PAL_ACTIONS = [
    { label: 'New code session', sub: '⌘N', icon: 'plus', run: () => renderPanes(currentLayout) },
    { label: 'Toggle 6-pane split view', sub: '⌘\\', icon: 'split', run: () => setLayout(currentLayout === '6' ? '2' : '6') },
    { label: 'Switch to Single view', sub: '⌘1', icon: 'split', run: () => setLayout('1') },
    { label: 'Switch to 2-Split view', sub: '⌘2', icon: 'split', run: () => setLayout('2') },
    { label: 'Switch to 6-Pane Grid', sub: '⌘6', icon: 'split', run: () => setLayout('6') },
    { label: 'Toggle dark / light glass', sub: '⌘⇧T', icon: 'gear', run: () => setTheme(document.documentElement.getAttribute('data-theme') ? 'dark' : 'light') },
    { label: 'Open Terminal pane', sub: '⌘T', icon: 'term', run: () => {} },
    { label: 'Open Git Changes (Diff)', sub: '⌘D', icon: 'diff', run: () => {} },
    { label: 'Open Files tree', sub: '⇧⌘F', icon: 'file', run: () => {} },
    { label: 'Switch Permission: Auto / Manual', sub: '⌘⇧M', icon: 'gear', run: () => {} }
  ];

  let palItems = [];
  let palIdx = 0;
  let activePalFilter = 'all';

  function openPalette() {
    const pal = document.getElementById('palette');
    const inp = document.getElementById('palInput');
    if (!pal || !inp) return;
    pal.hidden = false;
    pal.classList.add('open');
    inp.value = '';
    activePalFilter = 'all';
    updatePalFilterUI();
    renderPaletteItems('');
    inp.focus();
    setTimeout(() => { if (pal.classList.contains('open') && document.activeElement !== inp) inp.focus(); }, 20);
  }

  function closePalette() {
    const pal = document.getElementById('palette');
    if (!pal || pal.hidden) return;
    pal.classList.remove('open');
    pal.hidden = true;
    const txt = document.getElementById('deck-input');
    if (txt) txt.focus();
  }

  function updatePalFilterUI() {
    document.querySelectorAll('.pal-tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-pal-filter') === activePalFilter);
    });
  }

  function renderPaletteItems(rawQ) {
    const palList = document.getElementById('palList');
    if (!palList) return;
    let q = (rawQ || '').trim();
    let filter = activePalFilter;

    // Detect Claude/VSCode prefixes:
    if (q.startsWith('@')) { filter = 'files'; q = q.slice(1).trim(); }
    else if (q.startsWith('#')) { filter = 'symbols'; q = q.slice(1).trim(); }
    else if (q.startsWith('?') || q.startsWith('/')) { filter = 'code'; q = q.slice(1).trim(); }
    else if (q.startsWith('>')) { filter = 'actions'; q = q.slice(1).trim(); }

    const groups = [];
    const qLower = q.toLowerCase();

    // 1. Files (@)
    if (filter === 'all' || filter === 'files') {
      const matchedFiles = PAL_FILES.filter(f => !q || f.path.toLowerCase().includes(qLower) || f.name.toLowerCase().includes(qLower))
        .slice(0, filter === 'files' ? 14 : 5)
        .map(f => ({
          type: 'file',
          group: 'Files',
          title: f.name,
          sub: f.dir,
          meta: f.path,
          badge: f.ext,
          run: (alt) => {
            if (alt) mentionInComposer(`@${f.path}`);
          }
        }));
      if (matchedFiles.length) groups.push(['Files', matchedFiles]);
    }

    // 2. Symbols (#)
    if (filter === 'all' || filter === 'symbols') {
      const matchedSymbols = PAL_SYMBOLS.filter(s => !q || s.name.toLowerCase().includes(qLower) || s.sig.toLowerCase().includes(qLower) || s.file.toLowerCase().includes(qLower))
        .slice(0, filter === 'symbols' ? 14 : 4)
        .map(s => ({
          type: 'symbol',
          group: 'Symbols',
          sym: s.sym,
          title: s.name,
          line: `:${s.line}`,
          sub: `${s.file}:${s.line}`,
          sig: s.sig,
          run: (alt) => {
            if (alt) mentionInComposer(`@${s.file}:${s.line}`);
          }
        }));
      if (matchedSymbols.length) groups.push(['Symbols', matchedSymbols]);
    }

    // 3. Code Grep (?)
    if (filter === 'all' || filter === 'code') {
      const matchedCode = PAL_GREP.filter(g => !q || g.code.toLowerCase().includes(qLower) || g.file.toLowerCase().includes(qLower))
        .slice(0, filter === 'code' ? 12 : 3)
        .map(g => ({
          type: 'code',
          group: 'Code Matches',
          title: g.file,
          line: `:${g.line}`,
          sub: 'git grep',
          snippet: g.code,
          match: q || g.match,
          run: (alt) => {
            if (alt) mentionInComposer(`@${g.file}#L${g.line}`);
          }
        }));
      if (matchedCode.length) groups.push(['Code Matches', matchedCode]);
    }

    // 4. Chats / Sessions
    if (filter === 'all' || filter === 'chats') {
      const matchedChats = PANE_DATA.filter(p => !q || p.title.toLowerCase().includes(qLower) || p.user.toLowerCase().includes(qLower))
        .slice(0, filter === 'chats' ? 10 : 3)
        .map(p => ({
          type: 'chat',
          group: 'Conversations',
          title: p.title,
          sub: `⎇ ${p.branch}`,
          run: () => {
            document.querySelectorAll('.glass-pane-card').forEach(c => {
              if (c.querySelector('.pane-title-txt')?.textContent === p.title) {
                document.querySelectorAll('.glass-pane-card').forEach(x => x.classList.remove('focused'));
                c.classList.add('focused');
                c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }
            });
          }
        }));
      if (matchedChats.length) groups.push(['Conversations', matchedChats]);
    }

    // 5. Actions / Commands (>)
    if (filter === 'all' || filter === 'actions') {
      const matchedActions = PAL_ACTIONS.filter(a => !q || a.label.toLowerCase().includes(qLower) || a.sub.toLowerCase().includes(qLower))
        .slice(0, filter === 'actions' ? 14 : 5)
        .map(a => ({
          type: 'action',
          group: 'Actions',
          title: a.label,
          kbd: a.sub,
          run: a.run
        }));
      if (matchedActions.length) groups.push(['Actions', matchedActions]);
    }

    palItems = [];
    palList.innerHTML = '';
    palIdx = 0;

    if (!groups.length) {
      palList.innerHTML = '<div class="pal-empty">No results found for “' + escapeHtml(rawQ) + '”</div>';
      return;
    }

    groups.forEach(([grpName, items]) => {
      const grpEl = document.createElement('div');
      grpEl.className = 'pal-grp';
      grpEl.textContent = grpName;
      palList.appendChild(grpEl);

      items.forEach(it => {
        const itemIdx = palItems.length;
        palItems.push(it);

        const row = document.createElement('div');
        row.className = 'pal-it' + (itemIdx === 0 ? ' sel' : '');
        row.id = `pal-row-${itemIdx}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', itemIdx === 0 ? 'true' : 'false');

        let iconHtml = '<span class="ic">📄</span>';
        if (it.type === 'symbol') iconHtml = `<span class="ic ic-sym">${it.sym || 'ƒ'}</span>`;
        else if (it.type === 'code') iconHtml = '<span class="ic">🔍</span>';
        else if (it.type === 'chat') iconHtml = '<span class="ic">💬</span>';
        else if (it.type === 'action') iconHtml = '<span class="ic">⚡️</span>';

        let snippetHtml = '';
        if (it.snippet) {
          const highlighted = highlightMatch(it.snippet, it.match);
          snippetHtml = `<span class="pal-code-snippet">${highlighted}</span>`;
        } else if (it.sig) {
          snippetHtml = `<span class="pal-code-snippet">${escapeHtml(it.sig)}</span>`;
        }

        row.innerHTML = `
          ${iconHtml}
          <div class="t">
            <b>${escapeHtml(it.title)}</b>${it.line ? `<span class="pal-line-num">${it.line}</span>` : ''}
            ${snippetHtml}
          </div>
          ${it.sub ? `<span class="sub">${escapeHtml(it.sub)}</span>` : ''}
          ${it.kbd ? `<kbd>${escapeHtml(it.kbd)}</kbd>` : ''}
        `;

        row.addEventListener('mousemove', () => {
          if (palIdx !== itemIdx) {
            palIdx = itemIdx;
            paintPaletteHighlight();
          }
        });

        row.addEventListener('click', (e) => {
          closePalette();
          it.run(e.altKey);
        });

        palList.appendChild(row);
      });
    });
  }

  function paintPaletteHighlight() {
    document.querySelectorAll('.pal-it').forEach((row, i) => {
      const sel = i === palIdx;
      row.classList.toggle('sel', sel);
      row.setAttribute('aria-selected', String(sel));
      if (sel) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function mentionInComposer(str) {
    const txt = document.getElementById('deck-input');
    if (!txt) return;
    const cur = txt.value;
    const pos = txt.selectionStart ?? cur.length;
    const pad = pos > 0 && !/\s$/.test(cur.slice(0, pos)) ? ' ' : '';
    txt.value = cur.slice(0, pos) + pad + str + ' ' + cur.slice(pos);
    txt.selectionStart = txt.selectionEnd = pos + pad.length + str.length + 1;
    txt.dispatchEvent(new Event('input'));
    txt.focus();
  }

  function highlightMatch(code, m) {
    if (!m) return escapeHtml(code);
    const escaped = escapeHtml(code);
    const mEsc = escapeHtml(m);
    const idx = escaped.toLowerCase().indexOf(mEsc.toLowerCase());
    if (idx === -1) return escaped;
    return escaped.slice(0, idx) + '<mark>' + escaped.slice(idx, idx + mEsc.length) + '</mark>' + escaped.slice(idx + mEsc.length);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initPalette() {
    const trigger = document.getElementById('btn-search-trigger');
    if (trigger) trigger.addEventListener('click', openPalette);

    const pal = document.getElementById('palette');
    if (pal) {
      pal.addEventListener('click', (e) => {
        if (e.target === pal) closePalette();
      });
    }

    const inp = document.getElementById('palInput');
    if (inp) {
      inp.addEventListener('input', () => renderPaletteItems(inp.value));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (palItems.length) { palIdx = (palIdx + 1) % palItems.length; paintPaletteHighlight(); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (palItems.length) { palIdx = (palIdx - 1 + palItems.length) % palItems.length; paintPaletteHighlight(); }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const chosen = palItems[palIdx];
          if (chosen) {
            closePalette();
            chosen.run(e.altKey);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closePalette();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const filters = ['all', 'files', 'symbols', 'code', 'chats', 'actions'];
          const next = filters[(filters.indexOf(activePalFilter) + 1) % filters.length];
          activePalFilter = next;
          updatePalFilterUI();
          renderPaletteItems(inp.value);
        }
      });
    }

    document.querySelectorAll('.pal-tab').forEach(t => {
      t.addEventListener('click', () => {
        activePalFilter = t.getAttribute('data-pal-filter');
        updatePalFilterUI();
        if (inp) {
          renderPaletteItems(inp.value);
          inp.focus();
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        const pal = document.getElementById('palette');
        if (pal && !pal.hidden && pal.classList.contains('open')) closePalette();
        else openPalette();
        return;
      }
      if (isCmd && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openPalette();
        const inp = document.getElementById('palInput');
        if (inp) { inp.value = '@'; renderPaletteItems('@'); }
        return;
      }
      if (isCmd && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        openPalette();
        const inp = document.getElementById('palInput');
        if (inp) { inp.value = '@'; renderPaletteItems('@'); }
        return;
      }
    });
  }
})();
