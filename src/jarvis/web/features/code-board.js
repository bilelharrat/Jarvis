// Eden Code's agent board: every session as a card, by where it stands (needs you,
// working, done, failed, resting), with its project, branch, lines changed, cost, last
// activity and what it's doing, and a click to open it, stop it or answer what it asks.
// Pure logic exported for node's tests.
(function codeBoard(root) {
  'use strict';

  const COLUMNS = [
    ['needs', 'Needs you'],
    ['working', 'Working'],
    ['done', 'Done'],
    ['failed', 'Failed'],
    ['resting', 'Resting'],
  ];

  function column(task, asks) {
    if (asks > 0) return 'needs';
    if (task.busy || task.status === 'running') return 'working';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'waiting') return 'done';
    return 'resting';
  }

  function doing(task, ask) {
    const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    if (ask) return ask.question || 'Waiting for your answer';
    if (task.busy) return task.last_action && task.last_action !== 'Working' ? task.last_action : 'Working';
    const said = firstLine(task.result);
    if (said) return said.length > 160 ? `${said.slice(0, 160)}…` : said;
    return task.status === 'resting' ? 'Resting: it picks up where it left off' : task.last_action || '';
  }

  function ago(iso, now = Date.now()) {
    const at = new Date(iso).getTime();
    if (!iso || Number.isNaN(at)) return '';
    const secs = Math.max(0, Math.round((now - at) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
    return '';
  }

  function arrange(tasks, metaOf, asksOf, showArchived) {
    const out = Object.fromEntries(COLUMNS.map(([id]) => [id, []]));
    for (const task of tasks) {
      if (!showArchived && metaOf(task.id).archived) continue;
      out[column(task, asksOf(task.id))].push(task);
    }
    for (const list of Object.values(out)) list.sort((a, b) => b.id - a.id);
    return out;
  }

  const LANE_SAID = { needs: 'needs you', working: 'working', done: 'done', failed: 'failed', resting: 'resting' };

  function cardSpeech(task, col, ask, figures = {}, tr = (x) => x) {
    const named = task.title || task.prompt || tr('New session');
    const what = tr(doing(task, ask)).replace(/[.。…]+\s*$/, '');
    const parts = [`Session ${task.id}, ${String(named).split('\n')[0].slice(0, 120)}, ${LANE_SAID[col] || col}${what ? `: ${what}` : ''}`];
    const where = [task.folder, figures.branch ? `${tr('branch')} ${figures.branch}` : ''].filter(Boolean).join(', ');
    if (where) parts.push(where);
    const files = (task.files_changed || []).length;
    const stats = [];
    if (files) stats.push(tr(`${files} file${files === 1 ? '' : 's'}`));
    if (figures.added || figures.removed) stats.push(tr(`${figures.added || 0} lines added, ${figures.removed || 0} removed`));
    if (stats.length) parts.push(stats.join(', '));
    return `${parts.join('. ')}.`;
  }

  function moveIn(lanes, at, key) {
    const full = lanes.map((ids, lane) => (ids.length ? lane : -1)).filter((lane) => lane >= 0);
    if (!full.length) return null;
    const lane = full.includes(at.lane) ? at.lane : full[0];
    const ids = lanes[lane];
    const index = Math.min(Math.max(0, at.index), ids.length - 1);
    if (key === 'ArrowDown') return { lane, index: Math.min(ids.length - 1, index + 1) };
    if (key === 'ArrowUp') return { lane, index: Math.max(0, index - 1) };
    if (key === 'Home') return { lane, index: 0 };
    if (key === 'End') return { lane, index: ids.length - 1 };
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const step = key === 'ArrowRight' ? 1 : -1;
      const next = full[full.indexOf(lane) + step];
      if (next === undefined) return { lane, index };
      return { lane: next, index: Math.min(index, lanes[next].length - 1) };
    }
    return null;
  }

  function nextSession(order, current, dir) {
    if (!order.length) return null;
    const at = order.indexOf(current);
    if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
    return order[(at + dir + order.length) % order.length];
  }

  const api = { COLUMNS, column, doing, ago, arrange, cardSpeech, moveIn, nextSession };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.edenCodeFeatures || root.jarvisFeatures;
  if (!F) return;

  const t = (text) => F.t(text);
  const board = el('section', 'cs-board glass-panel');
  board.setAttribute('aria-label', 'Agent board');
  board.hidden = true;
  $('cc').querySelector('.jc-main').append(board);

  // Inject full Eden Code Agent Dashboard markup
  board.innerHTML = `<a class="skip-link" href="#dashboard-main">Skip to dashboard content</a>

  <div class="stage">
    <!-- Top Mockup Bar -->
    <nav class="mockup-switcher" aria-label="Mockup view and surface controls">
      <div class="switcher-brand">
        <span class="eden-tile" aria-hidden="true">
          <svg viewBox="43 81 410 422" fill="none" stroke="#fff" stroke-width="22" stroke-linejoin="round">
            <polygon points="211,93 314,90 444,236 343,353 249,352 333,251"/>
            <polygon points="252,235 160,346 282,491 186,494 52,350 151,234"/>
          </svg>
        </span>
        <span>Eden Code · Agent Dashboard</span>
        <span class="coral-dash" aria-hidden="true"></span>
      </div>

      <div class="switcher-tabs" role="tablist" aria-label="Dashboard Mockup Screens">
        <button type="button" class="mockup-tab active" role="tab" aria-selected="true" data-view-target="fleet">
          <span class="tab-num">01</span> Fleet &amp; Telemetry
        </button>
        <button type="button" class="mockup-tab" role="tab" aria-selected="false" data-view-target="grid">
          <span class="tab-num">02</span> Parallel Agent Grid (6-Split)
        </button>
        <button type="button" class="mockup-tab" role="tab" aria-selected="false" data-view-target="receipts">
          <span class="tab-num">03</span> Receipts, Assumptions &amp; EVES
        </button>
        <button type="button" class="mockup-tab" role="tab" aria-selected="false" data-view-target="lanes">
          <span class="tab-num">04</span> Classic Lanes
        </button>
      </div>

      <div class="switcher-actions">
        <button type="button" class="pill-toggle" id="texture-toggle" aria-pressed="false" title="Toggle 45°/135° directional CVD textures on chart fills">
          CVD Texture: Off
        </button>
        <button type="button" class="pill-toggle" id="theme-toggle" aria-pressed="false">
          Surface: Dark Glass
        </button>
        <button type="button" class="pill-toggle cs-board-close-btn" id="cs-board-close" title="Close Agent Board (Esc)">✕ Close</button>
      </div>
    </nav>

    <!-- Eden Code Window -->
    <div class="eden-window">
      <aside class="sidebar" aria-label="Active Agents Sidebar">
        <div class="window-bar">
          <div class="traffic-lights" aria-hidden="true">
            <span class="tl close"></span>
            <span class="tl min"></span>
            <span class="tl max"></span>
          </div>
          <div class="sidebar-brand">
            <span>Eden Code</span>
          </div>
        </div>

        <button type="button" class="search-trigger" id="cmd-trigger">
          <span>⌕ Search agents, files, receipts…</span>
          <kbd>⌘K</kbd>
        </button>

        <div class="side-label">
          <span>Agent Fleet</span>
          <span id="sidebar-active-count">4 running · 1 wait</span>
        </div>

        <div class="agent-roster" id="agent-roster">
          <button type="button" class="agent-item active" data-agent-id="coord" data-workspace="eden-code">
            <div class="agent-item-top">
              <span class="agent-name">Coordinator · Engine Split</span>
              <span class="state-pill run"><span class="state-dot"></span>Run</span>
            </div>
            <div class="agent-meta">
              <span>Argon 4 · High</span>
              <span>$1.42 · 38s</span>
            </div>
          </button>

          <button type="button" class="agent-item" data-agent-id="sec" data-workspace="eden-code">
            <div class="agent-item-top">
              <span class="agent-name">IPC &amp; Preload Audit</span>
              <span class="state-pill wait" id="roster-pill-sec"><span class="state-dot"></span>Wait OK</span>
            </div>
            <div class="agent-meta">
              <span>Opus 5.5 · High</span>
              <span>$1.18 · 2m</span>
            </div>
          </button>

          <button type="button" class="agent-item" data-agent-id="ios" data-workspace="askeden">
            <div class="agent-item-top">
              <span class="agent-name">iOS App Store 1.2 Prep</span>
              <span class="state-pill run"><span class="state-dot"></span>Run</span>
            </div>
            <div class="agent-meta">
              <span>Sonnet 5.5 · Med</span>
              <span>$0.84 · 1m</span>
            </div>
          </button>

          <button type="button" class="agent-item" data-agent-id="router" data-workspace="model-router">
            <div class="agent-item-top">
              <span class="agent-name">Router Benchmark Probe</span>
              <span class="state-pill run"><span class="state-dot"></span>Run</span>
            </div>
            <div class="agent-meta">
              <span>Flash 3.8 · Low</span>
              <span>$0.19 · 24s</span>
            </div>
          </button>

          <button type="button" class="agent-item" data-agent-id="eves" data-workspace="askeden">
            <div class="agent-item-top">
              <span class="agent-name">EVES UI Self-Check</span>
              <span class="state-pill eves"><span class="state-dot"></span>Verified</span>
            </div>
            <div class="agent-meta">
              <span>Flash 3.8 · Pass</span>
              <span>$0.55 · 19s</span>
            </div>
          </button>
        </div>

        <div class="sidebar-foot">
          <span class="router-badge" id="sidebar-router-badge">
            <span class="model-dot"></span>
            <span id="sidebar-router-label">Eden Router · Auto</span>
          </span>
          <button type="button" class="cap-trigger cap-trigger-compact" id="sidebar-cap-btn" title="Edit session spend cap">$4.18 / $20</button>
        </div>
      </aside>

      <main class="workspace" id="dashboard-main">
        <header class="workspace-header">
          <div class="workspace-title-group">
            <h1>Eden Code Agent Dashboard</h1>
            <span class="branch-chip" id="workspace-branch-chip">⎇ ios-app-store-prep · 3 worktrees</span>
            <span class="state-pill eves" id="workspace-eves-pill" title="Eden's verification and evaluation system">EVES (Eden's verification and evaluation system) · 98.4% pass</span>
          </div>
          <div class="header-right">
            <button type="button" class="cap-trigger" id="header-cap-btn" title="Click to adjust session spend cap">Session cap: $20.00</button>
          </div>
        </header>

        <!-- Single Global Filter Bar above all charts & stats (Dataviz interaction.md) -->
        <section class="filter-bar" aria-label="Global dashboard filters">
          <div class="filter-group">
            <span class="filter-label">Window</span>
            <div class="range-pills" role="group" aria-label="Time range">
              <button type="button" class="range-btn active" data-range="session">Active Session</button>
              <button type="button" class="range-btn" data-range="today">Today</button>
              <button type="button" class="range-btn" data-range="7d">7 Days</button>
              <button type="button" class="range-btn" data-range="30d">30 Days</button>
            </div>
          </div>

          <div class="filter-group">
            <label class="filter-label" for="repo-filter">Workspace</label>
            <select id="repo-filter" class="glass-select">
              <option value="all">All workspaces (3)</option>
              <option value="askeden">askeden</option>
              <option value="eden-code">Eden Code</option>
              <option value="model-router">Model Router</option>
            </select>
          </div>
        </section>

        <div class="dashboard-scroll" id="dashboard-scroll">
          <!-- ========================================================= -->
          <!-- VIEW 01: FLEET & TELEMETRY OVERVIEW                       -->
          <!-- ========================================================= -->
          <div class="view-panel active" id="view-fleet">
            <!-- Principle 4: Ask before acting -->
            <section class="approval-strip" aria-label="Actions awaiting your confirmation">
              <div class="approval-card" id="approval-card-1">
                <div class="approval-info">
                  <div class="approval-head">
                    <span class="state-pill wait"><span class="state-dot"></span>Needs Your OK</span>
                    <span>IPC &amp; Preload Audit wants to run migration check</span>
                  </div>
                  <div class="approval-desc">$ npx wrangler d1 migrations apply eden-auth --remote · Est. $0.00 · touches production D1</div>
                </div>
                <div class="approval-actions">
                  <button type="button" class="btn-approve" data-approve="1">Approve</button>
                  <button type="button" class="btn-deny" data-deny="1">Decline</button>
                </div>
              </div>

              <div class="approval-card" id="approval-card-2">
                <div class="approval-info">
                  <div class="approval-head">
                    <span class="state-pill warn"><span class="state-dot"></span>High-Risk Assumption</span>
                    <span>Auth token storage on split engine</span>
                  </div>
                  <div class="approval-desc">Chose macOS Keychain (\`com.askeden.code\`) over local file · Undo on receipt or decide now</div>
                </div>
                <div class="approval-actions">
                  <button type="button" class="btn-approve" data-approve="2">Keep Choice</button>
                  <button type="button" class="btn-deny" data-deny="2">Ask Me</button>
                </div>
              </div>
            </section>

            <!-- Hero Figure + 3 Stat Tiles -->
            <section class="kpi-grid" aria-label="Key metrics">
              <!-- Hero figure (marks-and-anatomy.md: >=48px, proportional-nums, exactly one per view) -->
              <div class="glass-card">
                <div class="stat-label">
                  <span>Active fleet spend</span>
                  <span class="state-pill run">62% below all-Opus baseline</span>
                </div>
                <div class="hero-figure" id="kpi-hero-spend">$4.18</div>
                <div class="meter-wrap">
                  <div class="meter-track" aria-hidden="true">
                    <div class="meter-fill meter-fill-hero" id="kpi-spend-meter"></div>
                  </div>
                  <div class="meter-caption">
                    <span id="kpi-spend-limit">$4.18 of $20.00 session cap</span>
                    <span id="kpi-tokens-total">1.42M tokens</span>
                  </div>
                </div>
              </div>

              <div class="glass-card">
                <div class="stat-label">
                  <span>Verified turns (EVES)</span>
                </div>
                <div class="stat-value" id="kpi-verified">42 / 43</div>
                <div class="stat-foot">
                  <span class="delta-badge good" id="kpi-verified-delta">+4.1% vs last 7d</span>
                  <span>1 retry fixed</span>
                </div>
                <svg width="100%" height="26" viewBox="0 0 140 26" aria-hidden="true">
                  <polyline fill="none" stroke="var(--text3)" stroke-width="1.5" opacity="0.45" points="2,20 18,18 34,19 50,15 66,16 82,12 98,13 114,9"/>
                  <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" points="98,13 114,9 136,5"/>
                  <circle cx="136" cy="5" r="3.5" fill="var(--accent)" stroke="var(--surface-chart)" stroke-width="1.5"/>
                </svg>
              </div>

              <div class="glass-card">
                <div class="stat-label">
                  <span>Median tool latency</span>
                </div>
                <div class="stat-value" id="kpi-latency">1.18s</div>
                <div class="stat-foot">
                  <span class="delta-badge good" id="kpi-latency-delta">-210ms vs rules-only</span>
                  <span>p95 2.8s (cap 4.0s)</span>
                </div>
                <svg width="100%" height="26" viewBox="0 0 140 26" aria-hidden="true">
                  <polyline fill="none" stroke="var(--text3)" stroke-width="1.5" opacity="0.45" points="2,8 22,11 42,10 62,14 82,15 102,17"/>
                  <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" points="102,17 120,19 136,21"/>
                  <circle cx="136" cy="21" r="3.5" fill="var(--accent)" stroke="var(--surface-chart)" stroke-width="1.5"/>
                </svg>
              </div>

              <div class="glass-card">
                <div class="stat-label">
                  <span>Assumptions logged</span>
                </div>
                <div class="stat-value" id="kpi-assumptions">6</div>
                <div class="stat-foot">
                  <span class="delta-badge warn">1 high risk · 5 low</span>
                  <span>0 undone</span>
                </div>
                <div class="meter-wrap">
                  <div class="meter-track" aria-hidden="true">
                    <div class="meter-fill meter-fill-assumptions" id="kpi-assumptions-meter"></div>
                  </div>
                  <div class="meter-caption">
                    <span>5 auto-accepted</span>
                    <span>1 awaiting OK</span>
                  </div>
                </div>
              </div>
            </section>

            <!-- Two Validated Interactive Charts -->
            <section class="charts-grid" aria-label="Agent telemetry charts">
              <!-- Chart 1: Multi-Series Line Chart (Token Velocity by Model Tier) -->
              <figure class="chart-figure" id="line-chart-figure">
                <div class="chart-header">
                  <div class="chart-title-wrap">
                    <h2>Token throughput by routed model (k tokens / 5 min)</h2>
                    <p class="chart-subtitle">Illustrative picks · Single Y-axis · Click a legend item to isolate series</p>
                  </div>
                  <div class="chart-controls">
                    <button type="button" class="table-toggle-btn" data-table-toggle="line" aria-pressed="false">Table view</button>
                  </div>
                </div>

                <div class="chart-legend" id="line-legend" role="group" aria-label="Series filter">
                  <button type="button" class="legend-item" data-series="argon">
                    <span class="legend-line-key series-bg-1"></span>
                    <span>Argon 4</span>
                  </button>
                  <button type="button" class="legend-item" data-series="opus">
                    <span class="legend-line-key series-bg-2"></span>
                    <span>Opus 5.5</span>
                  </button>
                  <button type="button" class="legend-item" data-series="sonnet">
                    <span class="legend-line-key series-bg-3"></span>
                    <span>Sonnet 5.5</span>
                  </button>
                  <button type="button" class="legend-item" data-series="flash">
                    <span class="legend-line-key series-bg-4"></span>
                    <span>Gemini 3.8 Flash</span>
                  </button>
                </div>

                <div class="svg-plot-wrap" id="line-plot-wrap">
                  <svg id="line-svg" viewBox="0 0 540 210" role="img" aria-label="Line chart of token throughput across Argon 4, Opus 5.5, Sonnet 5.5, and Gemini 3.8 Flash"></svg>
                  <div class="viz-tooltip" id="line-tooltip" role="status" aria-live="polite"></div>
                </div>

                <div class="viz-table-wrap" id="line-table-wrap">
                  <table class="viz-table" id="line-table">
                    <thead>
                      <tr>
                        <th>Interval</th>
                        <th>Argon 4 (k)</th>
                        <th>Opus 5.5 (k)</th>
                        <th>Sonnet 5.5 (k)</th>
                        <th>Flash 3.8 (k)</th>
                      </tr>
                    </thead>
                    <tbody></tbody>
                  </table>
                </div>
              </figure>

              <!-- Chart 2: Horizontal Stacked Bar Chart (Task & Cost Share by Agent Role) -->
              <figure class="chart-figure" id="bar-chart-figure">
                <div class="chart-header">
                  <div class="chart-title-wrap">
                    <h2>Turns completed by agent &amp; routed model</h2>
                    <p class="chart-subtitle">Illustrative picks · 18px thin bars · 2px surface gap between segments</p>
                  </div>
                  <div class="chart-controls">
                    <button type="button" class="table-toggle-btn" data-table-toggle="bar" aria-pressed="false">Table view</button>
                  </div>
                </div>

                <div class="chart-legend" role="group" aria-label="Model series key">
                  <span class="legend-item legend-static">
                    <span class="legend-swatch series-bg-1"></span>
                    <span>Argon 4</span>
                  </span>
                  <span class="legend-item legend-static">
                    <span class="legend-swatch series-bg-2"></span>
                    <span>Opus 5.5</span>
                  </span>
                  <span class="legend-item legend-static">
                    <span class="legend-swatch series-bg-3"></span>
                    <span>Sonnet 5.5</span>
                  </span>
                  <span class="legend-item legend-static">
                    <span class="legend-swatch series-bg-4"></span>
                    <span>Flash 3.8</span>
                  </span>
                </div>

                <div class="svg-plot-wrap" id="bar-plot-wrap">
                  <svg id="bar-svg" viewBox="0 0 440 210" role="img" aria-label="Horizontal stacked bar chart of turns by agent role"></svg>
                  <div class="viz-tooltip" id="bar-tooltip" role="status" aria-live="polite"></div>
                </div>

                <div class="viz-table-wrap" id="bar-table-wrap">
                  <table class="viz-table" id="bar-table">
                    <thead>
                      <tr>
                        <th>Agent Role</th>
                        <th>Argon 4</th>
                        <th>Opus 5.5</th>
                        <th>Sonnet 5.5</th>
                        <th>Flash 3.8</th>
                        <th>Total Cost</th>
                      </tr>
                    </thead>
                    <tbody></tbody>
                  </table>
                </div>
              </figure>
            </section>
          </div>

          <!-- ========================================================= -->
          <!-- VIEW 02: PARALLEL AGENT GRID & WORKTREE TOPOLOGY          -->
          <!-- ========================================================= -->
          <div class="view-panel" id="view-grid">
            <div class="dag-banner">
              <div class="dag-flow" aria-label="Multi-agent dependency pipeline">
                <span class="filter-label">Pipeline</span>
                <button type="button" class="dag-node" data-dag-stage="1"><span class="state-dot dot-run"></span>1. Plan &amp; Spec (Argon 4)</button>
                <span class="dag-arrow">→</span>
                <button type="button" class="dag-node" data-dag-stage="2"><span class="state-dot dot-run"></span>2. Parallel Worktrees (3 agents)</button>
                <span class="dag-arrow">→</span>
                <button type="button" class="dag-node" data-dag-stage="3" id="dag-node-security"><span class="state-dot dot-wait" id="dag-dot-security"></span><span id="dag-label-security">3. Security Gate (1 wait OK)</span></button>
                <span class="dag-arrow">→</span>
                <button type="button" class="dag-node" data-dag-stage="4"><span class="state-dot dot-eves"></span>4. EVES Check &amp; Receipt</button>
              </div>
              <span class="branch-chip" id="grid-isolation-chip">Isolation: .claude/worktrees/*</span>
            </div>

            <div class="agent-panes-grid" id="agent-panes-grid">
              <article class="agent-pane-card focused" data-agent-id="coord" data-workspace="eden-code" data-stage="1,2">
                <div class="pane-card-head">
                  <div class="pane-card-title">
                    <span>01 · Coordinator · Engine Split</span>
                    <span class="branch-chip">⎇ feat/argon-engine</span>
                  </div>
                  <span class="state-pill run"><span class="state-dot"></span>Running</span>
                </div>
                <div class="pane-step-list" id="steps-coord">
                  <div class="step-row" data-step-key="coord-1" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Read</span> docs/eden-code-independence.md:1-120</span>
                    <span>140ms</span>
                  </div>
                  <div class="step-row" data-step-key="coord-2" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Edit</span> src/engine/router-bridge.ts (+48 -12)</span>
                    <span>620ms</span>
                  </div>
                  <div class="step-row" data-step-key="coord-3" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Bash</span> npm test -- src/__tests__/router.test.ts (24/24 pass)</span>
                    <span>1.4s</span>
                  </div>
                </div>
                <div class="pane-card-foot" id="foot-coord">
                  <span>Pick: Gemini 4 Argon (High) · Score 94.2</span>
                  <span>382k tok · $1.42 of $5.00 cap</span>
                </div>
              </article>

              <article class="agent-pane-card" data-agent-id="sec" data-workspace="eden-code" data-stage="2,3">
                <div class="pane-card-head">
                  <div class="pane-card-title">
                    <span>02 · IPC &amp; Preload Audit</span>
                    <span class="branch-chip">⎇ pr-security</span>
                  </div>
                  <span class="state-pill wait" id="pane-pill-sec"><span class="state-dot"></span>Needs OK</span>
                </div>
                <div class="pane-step-list" id="steps-sec">
                  <div class="step-row" data-step-key="sec-1" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Search</span> codebase_search "validateSender Electron IPC"</span>
                    <span>210ms</span>
                  </div>
                  <div class="step-row" data-step-key="sec-2" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Edit</span> app/preload-gate.ts (+19 -4)</span>
                    <span>510ms</span>
                  </div>
                  <div class="step-row step-row-warn" id="step-sec-confirm" data-step-key="sec-3" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb verb-wait" id="step-sec-verb">Confirm</span> wrangler d1 migrations apply eden-auth</span>
                    <span id="step-sec-time">Paused</span>
                  </div>
                </div>
                <div class="pane-card-foot" id="foot-sec">
                  <span>Pick: Claude Opus 5.5 (High) · Security tier</span>
                  <span>294k tok · $1.18 of $5.00 cap</span>
                </div>
              </article>

              <article class="agent-pane-card" data-agent-id="ios" data-workspace="askeden" data-stage="2">
                <div class="pane-card-head">
                  <div class="pane-card-title">
                    <span>03 · iOS App Store 1.2 Prep</span>
                    <span class="branch-chip">⎇ ios-app-store-prep</span>
                  </div>
                  <span class="state-pill run"><span class="state-dot"></span>Running</span>
                </div>
                <div class="pane-step-list" id="steps-ios">
                  <div class="step-row" data-step-key="ios-1" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Read</span> ios/Eden/InfoPlist.xcstrings</span>
                    <span>95ms</span>
                  </div>
                  <div class="step-row" data-step-key="ios-2" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Check</span> sim_look · iPhone 17 Pro Simulator</span>
                    <span>880ms</span>
                  </div>
                  <div class="step-row" data-step-key="ios-3" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Verify</span> Report &amp; Hide shared chat sheet</span>
                    <span>1.1s</span>
                  </div>
                </div>
                <div class="pane-card-foot" id="foot-ios">
                  <span>Pick: Claude Sonnet 5.5 (Med) · UI + Swift</span>
                  <span>412k tok · $0.84 of $5.00 cap</span>
                </div>
              </article>

              <article class="agent-pane-card" data-agent-id="eves" data-workspace="askeden" data-stage="4">
                <div class="pane-card-head">
                  <div class="pane-card-title">
                    <span>04 · EVES UI Self-Check</span>
                    <span class="branch-chip">⎇ ios-app-store-prep</span>
                  </div>
                  <span class="state-pill eves"><span class="state-dot"></span>Verified Pass</span>
                </div>
                <div class="pane-step-list" id="steps-eves">
                  <div class="step-row" data-step-key="eves-1" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Open</span> check_open http://localhost:5174/</span>
                    <span>320ms</span>
                  </div>
                  <div class="step-row" data-step-key="eves-2" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Act</span> check_act click [e14] &amp; check_console (0 errors)</span>
                    <span>640ms</span>
                  </div>
                  <div class="step-row" data-step-key="eves-3" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb verb-eves">Done</span> check_done verdict="pass" (3 screenshots saved)</span>
                    <span>110ms</span>
                  </div>
                </div>
                <div class="pane-card-foot" id="foot-eves">
                  <span>Pick: Gemini 3.8 Flash · Reasoning ≥ 85</span>
                  <span>330k tok · $0.55 of $2.00 cap</span>
                </div>
              </article>

              <article class="agent-pane-card" data-agent-id="router" data-workspace="model-router" data-stage="1,2">
                <div class="pane-card-head">
                  <div class="pane-card-title">
                    <span>05 · Router Benchmark Probe</span>
                    <span class="branch-chip">⎇ feat/bench-refresh</span>
                  </div>
                  <span class="state-pill run"><span class="state-dot"></span>Running</span>
                </div>
                <div class="pane-step-list" id="steps-router">
                  <div class="step-row" data-step-key="router-1" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Read</span> src/router/weights.json</span>
                    <span>60ms</span>
                  </div>
                  <div class="step-row" data-step-key="router-2" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Bash</span> npm run test:outcomes -- --slice=code</span>
                    <span>1.9s</span>
                  </div>
                  <div class="step-row" data-step-key="router-3" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Write</span> docs/benchmarks/2026-10-18.json</span>
                    <span>120ms</span>
                  </div>
                </div>
                <div class="pane-card-foot" id="foot-router">
                  <span>Pick: Gemini 3.8 Flash (Low) · Score 88.4</span>
                  <span>142k tok · $0.19 of $2.00 cap</span>
                </div>
              </article>

              <article class="agent-pane-card" data-agent-id="review" data-workspace="askeden" data-stage="4">
                <div class="pane-card-head">
                  <div class="pane-card-title">
                    <span>06 · Shared Chat 1.2 Review</span>
                    <span class="branch-chip">⎇ ios-app-store-prep</span>
                  </div>
                  <span class="state-pill done"><span class="state-dot"></span>Done</span>
                </div>
                <div class="pane-step-list" id="steps-review">
                  <div class="step-row" data-step-key="review-1" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Read</span> web/chat/render.js:410-485</span>
                    <span>85ms</span>
                  </div>
                  <div class="step-row" data-step-key="review-2" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb">Edit</span> web/chat/app.js (+22 -3)</span>
                    <span>390ms</span>
                  </div>
                  <div class="step-row" data-step-key="review-3" role="button" tabindex="0">
                    <span class="step-left"><span class="step-verb verb-eves">Done</span> Report &amp; Hide controls verified</span>
                    <span>150ms</span>
                  </div>
                </div>
                <div class="pane-card-foot" id="foot-review">
                  <span>Pick: Claude Sonnet 5.5 (Med) · Score 91.0</span>
                  <span>210k tok · $0.44 of $3.00 cap</span>
                </div>
              </article>
            </div>
          </div>

          <!-- ========================================================= -->
          <!-- VIEW 03: TURN RECEIPTS, ASSUMPTIONS & EVES VERIFICATION   -->
          <!-- ========================================================= -->
          <div class="view-panel" id="view-receipts">
            <div class="receipt-columns">
              <section class="glass-card" aria-label="Logged Assumptions Receipt">
                <div class="chart-header">
                  <div class="chart-title-wrap">
                    <h2>Turn Receipt · Assumptions (\`note_assumption\`)</h2>
                    <p class="chart-subtitle">Every choice made without interrupting you · Undo any item to branch and re-run</p>
                  </div>
                  <span class="state-pill run">6 recorded</span>
                </div>

                <div class="assumption-list" id="assumption-list">
                  <div class="assumption-item" id="assumption-item-keychain" data-workspace="eden-code">
                    <div class="assumption-top">
                      <span class="state-pill warn" id="assumption-pill-keychain"><span class="state-dot"></span>High Risk · Needs OK</span>
                      <button type="button" class="undo-btn" data-undo="keychain">Undo &amp; Ask</button>
                    </div>
                    <div class="assumption-q">Q: Where should the split Eden Code engine store Anthropic &amp; Eden Plus tokens?</div>
                    <div class="assumption-a">A: macOS Keychain under service \`com.askeden.code\` (never plaintext JSON).</div>
                    <div class="assumption-ev">Evidence: TODO.md §Eden Code independence + pr-security review scope</div>
                  </div>

                  <div class="assumption-item" id="assumption-item-look" data-workspace="askeden">
                    <div class="assumption-top">
                      <span class="state-pill run"><span class="state-dot"></span>Low Risk</span>
                      <button type="button" class="undo-btn" data-undo="look">Undo &amp; Ask</button>
                    </div>
                    <div class="assumption-q">Q: Which of the three Eden looks should the Agent Dashboard use?</div>
                    <div class="assumption-a">A: Eden Glass (Liquid Glass light &amp; dark, \`#0a84ff\` accent, 20/14/9px radii).</div>
                    <div class="assumption-ev">Evidence: DESIGN.md §4 specifies Eden Glass for Eden Code inside Eden</div>
                  </div>

                  <div class="assumption-item" id="assumption-item-fallback" data-workspace="model-router">
                    <div class="assumption-top">
                      <span class="state-pill run"><span class="state-dot"></span>Low Risk</span>
                      <button type="button" class="undo-btn" data-undo="fallback">Undo &amp; Ask</button>
                    </div>
                    <div class="assumption-q">Q: Which model runs background summaries and UI self-checks?</div>
                    <div class="assumption-a">A: Gemini 3.8 Flash (cheapest model with reasoning ≥ 85; never Flash-Lite or Haiku 4.5).</div>
                    <div class="assumption-ev">Evidence: TODO.md 2026-10-13 routing rule</div>
                  </div>
                </div>
              </section>

              <section class="glass-card" aria-label="EVES Self-Check & Cost Receipt">
                <div class="chart-header">
                  <div class="chart-title-wrap">
                    <h2>EVES Verification &amp; Cost Ledger</h2>
                    <p class="chart-subtitle">Say what it did, and what it cost · Exact model pick, time, price &amp; source</p>
                  </div>
                  <span class="state-pill eves" id="eves-verdict-pill">Verdict: Pass</span>
                </div>

                <table class="viz-table ledger-table-spaced" id="eves-ledger-table">
                  <thead>
                    <tr>
                      <th>Step / Check</th>
                      <th>Model Pick</th>
                      <th>Time</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody id="eves-ledger-tbody">
                    <tr data-step-key="eves-1" data-workspace="askeden">
                      <td>Palette CVD &amp; contrast gate (\`validate_palette.js\`)</td>
                      <td>Local Node</td>
                      <td>0.12s</td>
                      <td>$0.00</td>
                    </tr>
                    <tr data-step-key="coord-2" data-workspace="eden-code">
                      <td>Coordinator · Engine split diff (+48 -12)</td>
                      <td>Argon 4 (High)</td>
                      <td>38.4s</td>
                      <td>$1.42</td>
                    </tr>
                    <tr data-step-key="sec-2" data-workspace="eden-code">
                      <td>IPC sender validation (\`preload-gate.ts\`)</td>
                      <td>Opus 5.5 (High)</td>
                      <td>54.1s</td>
                      <td>$1.18</td>
                    </tr>
                    <tr data-step-key="ios-3" data-workspace="askeden">
                      <td>iOS 1.2 Report sheet + strings check</td>
                      <td>Sonnet 5.5 (Med)</td>
                      <td>29.0s</td>
                      <td>$0.84</td>
                    </tr>
                    <tr data-step-key="eves-3" data-workspace="askeden">
                      <td>Browser preview \`check_look\` + \`check_console\` (0 err)</td>
                      <td>Flash 3.8 (Low)</td>
                      <td>18.7s</td>
                      <td>$0.55</td>
                    </tr>
                    <tr id="eves-total-row">
                      <td><strong id="eves-total-label">Session Total (cap $20.00)</strong></td>
                      <td><strong id="eves-total-models">4 models routed</strong></td>
                      <td><strong id="eves-total-time">2m 20s</strong></td>
                      <td><strong id="eves-total-cost">$4.18</strong></td>
                    </tr>
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        </div>

        <!-- Exact Eden Code Input Dock (.jc-dock / .jc-composer) -->
        <div class="jc-dock">
          <div class="jc-column">
            <form class="jc-composer" id="dashboard-composer">
              <div class="jc-composer-top">
                <button type="button" class="jc-orb" id="orb-options-btn" title="Eden Code options" aria-label="Eden Code options" aria-haspopup="dialog" aria-expanded="false"></button>
                <input type="text" id="composer-input" placeholder="Message the agent fleet, or @agent to direct one subagent…" aria-label="Message the agent fleet" />
                <div class="jc-composer-pills">
                  <button type="button" class="jc-pill mode" id="mode-cycle-btn" title="Permission mode">Auto</button>
                  <button type="button" class="jc-pill" id="model-cycle-btn" title="Routed model">
                    <span class="model-dot"></span>
                    <span id="model-cycle-label">Eden Router · Argon 4</span>
                  </button>
                  <button type="button" class="jc-pill" id="effort-cycle-btn" title="Reasoning effort">High</button>
                </div>
                <button type="button" class="jc-send" id="composer-send-btn" aria-label="Send instruction">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"/></svg>
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  </div>

  <!-- ⌘K Command Palette Modal -->
  <div class="glass-modal-backdrop" id="cmd-palette-backdrop" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="glass-modal">
      <div class="cmd-input-bar">
        <span class="cmd-search-glyph" aria-hidden="true">⌕</span>
        <input type="text" id="cmd-input" placeholder="Jump to view, agent, worktree, diff, or action…" aria-label="Search commands and agents" autocomplete="off" />
        <kbd class="cmd-esc-kbd">ESC</kbd>
      </div>
      <div class="cmd-list" id="cmd-list" role="listbox"></div>
    </div>
  </div>

  <!-- Step Diff & Proof Inspector Modal -->
  <div class="glass-modal-backdrop" id="step-inspector-backdrop" role="dialog" aria-modal="true" aria-label="Step inspector">
    <div class="glass-modal inspector-modal">
      <div class="inspector-head">
        <div class="inspector-title-group">
          <span class="state-pill run" id="insp-verb-badge">Edit</span>
          <strong id="insp-title" class="inspector-title-text">src/engine/router-bridge.ts</strong>
        </div>
        <button type="button" class="pill-toggle" id="insp-close-btn">Close · ESC</button>
      </div>
      <div class="inspector-body">
        <div class="inspector-meta-row" id="insp-meta"></div>
        <pre class="diff-block" id="insp-diff"></pre>
        <div id="insp-actions" class="inspector-actions-row"></div>
      </div>
    </div>
  </div>

  <!-- Session Cap Popover -->
  <div class="glass-popover" id="cap-popover" role="dialog" aria-label="Adjust session spend cap">
    <div class="popover-title">Session Spend Cap</div>
    <div class="cap-presets">
      <button type="button" class="cap-preset-btn" data-cap-val="10">$10</button>
      <button type="button" class="cap-preset-btn active" data-cap-val="20">$20</button>
      <button type="button" class="cap-preset-btn" data-cap-val="50">$50</button>
      <button type="button" class="cap-preset-btn" data-cap-val="100">$100</button>
    </div>
  </div>

  <!-- Orb Options Popover -->
  <div class="glass-popover" id="orb-popover" role="dialog" aria-label="Eden Code composer options">
    <div class="popover-title">Eden Code Fleet Options</div>
    <button type="button" class="cmd-option" data-orb-action="target-all">
      <span>Target: Entire Fleet (6 agents)</span>
      <span class="cmd-option-meta">@fleet</span>
    </button>
    <button type="button" class="cmd-option" data-orb-action="export-receipt">
      <span>Export EVES Turn Receipt</span>
      <span class="cmd-option-meta">JSON</span>
    </button>
    <button type="button" class="cmd-option" data-orb-action="open-chat">
      <span>Back to Ask Eden Chat</span>
      <span class="cmd-option-meta">/</span>
    </button>
  </div>

  <!-- Glass Toast -->
  <div class="dash-toast" id="dash-toast" role="status" aria-live="polite"></div>`;

  const B = { figures: {}, showArchived: false, timer: 0, badge: -1, lanes: [], focusId: null };
  const extraLanes = [];
  F.codeBoard = {
    board,
    isOpen: () => isOpen(),
    open: () => open(),
    addLane(lane) { extraLanes.push(lane); extraLanes.sort((a, b) => (a.order || 0) - (b.order || 0)); schedule(); },
    refresh() { schedule(); },
  };

  const shared = () => F.codeSessions || { meta: new Map(), unread: new Set() };
  const metaOf = (id) => shared().meta.get(id) || {};
  const asksOf = (id) => [...pendingApprovals.values()].filter((a) => a.task_id === id);

  function isOpen() { return !board.hidden; }
  function open() {
    if ($('cc').hidden) toggleCC(true);
    board.hidden = false;
    $('cc').classList.add('cs-board-on');
    toggle.setAttribute('aria-pressed', 'true');
    F.send({ type: 'code_board' });
    clearInterval(B.timer);
    B.timer = setInterval(() => { if (isOpen() && !$('cc').hidden) F.send({ type: 'code_board' }); }, 15000);
    render();
  }

  function close() {
    const hadFocus = board.contains(document.activeElement);
    board.hidden = true;
    if (hadFocus) toggle.focus();
    $('cc').classList.remove('cs-board-on');
    toggle.setAttribute('aria-pressed', 'false');
    clearInterval(B.timer);
    if (typeof moveGlider === 'function') moveGlider();
  }

  const toggle = el('button', 'jc-icon cs-foot-btn cs-board-btn');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Agent board');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.title = 'Agent board: every session at a glance (⌘⇧B)';
  toggle.insertAdjacentHTML('beforeend', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2.5" width="3.4" height="11" rx="1.2"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1.2"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1.2"/></svg>');
  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  const foot = $('jc-side').querySelector('.jc-side-foot');
  if (foot) foot.append(toggle);
  F.registerMoreItem({ label: 'Agent board', note: 'Every session at a glance', run: open });

  document.addEventListener('keydown', (e) => {
    if ($('cc').hidden) return;
    if (e.key.toLowerCase() === 'b' && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      if (isOpen()) close(); else open();
    }
  });

  const covered = () => !$('jc-menu').hidden || [...document.querySelectorAll('[role="dialog"]')].some((d) => !d.closest('[hidden]'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !$('cc').hidden && !covered()) {
      e.stopPropagation(); e.preventDefault(); close();
    }
  }, true);

  const closeBtn = board.querySelector('#cs-board-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  F.on('jc_select', () => { if (isOpen()) close(); });
  F.on('code_board', (ev) => { B.figures = ev.items || {}; schedule(); });
  for (const type of ['tasks', 'approval', 'approval_resolved', 'code_meta', 'task_finished']) {
    F.on(type, () => { schedule(); badge(); });
  }

  let frame = 0;
  function schedule() {
    if (frame || !isOpen()) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function badge() {
    if (F.codeAttention && F.codeAttention.badges) return;
    const count = ccTasks.filter((x) => asksOf(x.id).length).length;
    if (count === B.badge) return;
    B.badge = count;
    if (app && app.feature) app.feature.send('feature:code-sessions:badge', count);
  }

  // Classic lanes mounting for View 04
  const columnLanes = {};
  let lanesMounted = false;
  function setupClassicLanes() {
    if (lanesMounted) return;
    const mount = board.querySelector('#cs-classic-lanes-mount');
    if (!mount) return;
    lanesMounted = true;
    const lBox = el('div', 'cs-lanes');
    for (const [id, label] of COLUMNS) {
      const lane = el('section', `cs-lane ${id}`);
      lane.setAttribute('aria-label', label);
      const lh = el('h2', 'cs-lane-head');
      const count = el('span', 'cs-lane-count', '');
      lh.append(el('span', `cs-lane-dot ${id}`), el('span', '', label), count);
      const cards = el('div', 'cs-cards');
      const empty = el('p', 'cs-lane-empty', id === 'needs' ? 'Nothing waiting on you.' : 'None');
      lane.append(lh, cards);
      columnLanes[id] = { lane, count, empty, cards };
      lBox.append(lane);
    }
    mount.append(lBox);
  }

  function render() {
    const tasks = ccTasks;
    setupClassicLanes();

    // Update active fleet count on top KPI
    const workingCount = tasks.filter((t) => t.busy || t.status === 'running').length;
    const totalCost = tasks.reduce((sum, t) => sum + (Number(t.cost_usd) || 0), 0);
    const kpiFleet = board.querySelector('#kpi-active-fleet');
    if (kpiFleet) kpiFleet.textContent = workingCount > 0 ? String(workingCount) : String(tasks.length || 4);
    const kpiSpend = board.querySelector('#kpi-spend-total');
    if (kpiSpend && totalCost > 0) kpiSpend.textContent = `$${totalCost.toFixed(2)}`;

    // Render live tasks in Grid View 02
    renderLiveGrid(tasks);

    // Render confirmation banner for any live pending approvals
    renderApprovals();

    // Render classic lanes
    renderClassicLanes(tasks);
  }

  function renderApprovals() {
    const strip = board.querySelector('.approval-strip');
    if (!strip) return;
    const pending = [...pendingApprovals.values()];
    if (!pending.length) return;
    strip.innerHTML = '';
    for (const a of pending.slice(0, 4)) {
      const card = el('div', 'approval-card');
      const info = el('div', 'approval-info');
      info.append(
        el('div', 'approval-head', a.question || 'Action requires approval'),
        el('div', 'approval-desc', a.detail || '')
      );
      const acts = el('div', 'approval-actions');
      const btnApprove = el('button', 'btn-approve', 'Approve');
      btnApprove.type = 'button';
      btnApprove.addEventListener('click', () => {
        const allowChoice = (a.choices || []).find((c) => c.id !== 'deny');
        answerApproval(a, allowChoice ? allowChoice.id : 'allow');
      });
      const btnDeny = el('button', 'btn-deny', 'Deny');
      btnDeny.type = 'button';
      btnDeny.addEventListener('click', () => answerApproval(a, 'deny'));
      acts.append(btnApprove, btnDeny);
      card.append(info, acts);
      strip.append(card);
    }
  }

  function renderLiveGrid(tasks) {
    const grid = board.querySelector('#agent-panes-grid');
    if (!grid || !tasks.length) return;
    const activeTasks = tasks.slice(0, 6);
    grid.innerHTML = '';
    for (const t of activeTasks) {
      const meta = metaOf(t.id);
      const asks = asksOf(t.id);
      const card = el('div', 'agent-pane-card' + (t.busy ? ' focused' : ''));
      card.dataset.agentId = String(t.id);
      card.dataset.workspace = 'all';
      card.dataset.stage = t.busy ? 'split' : 'commit';

      const head = el('div', 'pane-head');
      const titleWrap = el('div', 'pane-title-wrap');
      const dotClass = asks.length ? 'wait' : t.busy ? 'run' : 'done';
      const dotText = asks.length ? 'Wait OK' : t.busy ? 'Run' : 'Done';
      titleWrap.append(
        el('span', `state-pill ${dotClass}`, `<span class="state-dot"></span>${dotText}`),
        el('span', 'pane-title-text', t.title || t.prompt || 'Agent Session')
      );
      const costBadge = el('span', 'state-pill run', `$${(t.cost_usd || 0).toFixed(2)}`);
      head.append(titleWrap, costBadge);

      const log = el('div', 'pane-log');
      log.textContent = doing(t, asks[0]) || (t.result ? t.result.slice(0, 200) : 'Waiting for next prompt...');

      const foot = el('div', 'pane-footer');
      const folderSpan = el('span', '', t.folder ? `📁 ${t.folder.split('/').pop()}` : 'askeden');
      const btnWrap = el('div', '');
      btnWrap.style.display = 'flex';
      btnWrap.style.gap = '6px';

      const openBtn = el('button', 'jc-btn small tinted', 'Open');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => {
        close();
        F.selectTask(t.id);
      });
      btnWrap.append(openBtn);

      if (t.busy) {
        const stopBtn = el('button', 'jc-btn small danger', 'Stop');
        stopBtn.type = 'button';
        stopBtn.addEventListener('click', () => F.send({ type: 'task_interrupt', id: t.id }));
        btnWrap.append(stopBtn);
      }

      foot.append(folderSpan, btnWrap);
      card.append(head, log, foot);
      grid.append(card);
    }
  }

  function renderClassicLanes(tasks) {
    const columns = arrange(tasks, metaOf, (id) => asksOf(id).length, B.showArchived);
    B.lanes = COLUMNS.map(([id]) => columns[id].map((task) => task.id));
    for (const [id] of COLUMNS) {
      const list = columns[id];
      const parts = columnLanes[id];
      if (!parts) continue;
      parts.count.textContent = String(list.length);
      if (list.length && parts.empty.isConnected) parts.empty.remove();
      else if (!list.length && !parts.empty.isConnected) parts.lane.insertBefore(parts.empty, parts.cards);
      parts.cards.innerHTML = '';
      for (const t of list) {
        const card = el('article', `cs-card ${id}`);
        card.append(
          el('h3', 'cs-card-title', t.title || t.prompt || 'New session'),
          el('p', 'cs-card-project', t.folder || ''),
          el('p', 'cs-card-doing', doing(t, asksOf(t.id)[0]))
        );
        card.addEventListener('click', () => {
          close();
          F.selectTask(t.id);
        });
        parts.cards.append(card);
      }
    }
  }

  // Embed the interactive dashboard behavior (tabs, charts, popovers, inspector, command palette)
  try {
    (() => {
  const SLICES = {
    session: {
      spend: "$4.18",
      capText: "$4.18 of $20.00 session cap",
      meterPct: 20.9,
      tokens: "1.42M tokens",
      verified: "42 / 43",
      verifiedDelta: "+4.1% vs last 7d",
      latency: "1.18s",
      latencyDelta: "-210ms vs rules-only",
      assumptions: "6",
      intervals: ["14:00", "14:05", "14:10", "14:15", "14:20", "14:25"],
      series: {
        argon:  [42, 58, 74, 68, 86, 94],
        opus:   [28, 34, 48, 52, 44, 38],
        sonnet: [35, 40, 52, 61, 58, 64],
        flash:  [18, 24, 29, 31, 36, 41]
      },
      bars: [
        { role: "Coordinator", argon: 12, opus: 2, sonnet: 3, flash: 1, cost: "$1.42" },
        { role: "Security Audit", argon: 3, opus: 8, sonnet: 2, flash: 1, cost: "$1.18" },
        { role: "iOS 1.2 Prep", argon: 2, opus: 1, sonnet: 9, flash: 2, cost: "$0.84" },
        { role: "EVES Check", argon: 1, opus: 0, sonnet: 2, flash: 11, cost: "$0.74" }
      ]
    },
    today: {
      spend: "$14.80",
      capText: "$14.80 of $50.00 daily cap",
      meterPct: 29.6,
      tokens: "5.18M tokens",
      verified: "148 / 151",
      verifiedDelta: "+3.8% vs yesterday",
      latency: "1.22s",
      latencyDelta: "-185ms vs rules-only",
      assumptions: "19",
      intervals: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"],
      series: {
        argon:  [110, 145, 162, 138, 175, 192],
        opus:   [64,  82,  95,  70,  88,  76],
        sonnet: [92,  108, 124, 115, 134, 148],
        flash:  [48,  62,  74,  68,  82,  96]
      },
      bars: [
        { role: "Coordinator", argon: 34, opus: 6, sonnet: 11, flash: 4, cost: "$5.10" },
        { role: "Security Audit", argon: 9, opus: 22, sonnet: 7, flash: 3, cost: "$4.25" },
        { role: "iOS 1.2 Prep", argon: 8, opus: 3, sonnet: 28, flash: 6, cost: "$3.15" },
        { role: "EVES Check", argon: 2, opus: 0, sonnet: 6, flash: 38, cost: "$2.30" }
      ]
    },
    "7d": {
      spend: "$68.40",
      capText: "$68.40 of $150.00 weekly cap",
      meterPct: 45.6,
      tokens: "24.6M tokens",
      verified: "712 / 724",
      verifiedDelta: "+5.2% vs prior week",
      latency: "1.15s",
      latencyDelta: "-240ms vs rules-only",
      assumptions: "84",
      intervals: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      series: {
        argon:  [420, 510, 490, 580, 610, 645],
        opus:   [210, 240, 195, 260, 230, 215],
        sonnet: [340, 390, 410, 445, 470, 495],
        flash:  [190, 220, 245, 260, 290, 310]
      },
      bars: [
        { role: "Coordinator", argon: 142, opus: 28, sonnet: 46, flash: 18, cost: "$24.10" },
        { role: "Security Audit", argon: 38, opus: 94, sonnet: 31, flash: 12, cost: "$19.80" },
        { role: "iOS 1.2 Prep", argon: 34, opus: 14, sonnet: 118, flash: 24, cost: "$14.90" },
        { role: "EVES Check", argon: 10, opus: 2, sonnet: 22, flash: 164, cost: "$9.60" }
      ]
    },
    "30d": {
      spend: "$241.90",
      capText: "$241.90 of $500.00 monthly cap",
      meterPct: 48.4,
      tokens: "91.8M tokens",
      verified: "2,890 / 2,940",
      verifiedDelta: "+6.4% vs prior 30d",
      latency: "1.19s",
      latencyDelta: "-225ms vs rules-only",
      assumptions: "312",
      intervals: ["W1", "W2", "W3", "W4", "W5", "Now"],
      series: {
        argon:  [1450, 1680, 1820, 1950, 2120, 2280],
        opus:   [820,  790,  860,  740,  710,  690],
        sonnet: [1180, 1320, 1490, 1580, 1690, 1780],
        flash:  [640,  720,  810,  890,  960,  1040]
      },
      bars: [
        { role: "Coordinator", argon: 520, opus: 95, sonnet: 180, flash: 65, cost: "$86.40" },
        { role: "Security Audit", argon: 140, opus: 310, sonnet: 110, flash: 45, cost: "$72.10" },
        { role: "iOS 1.2 Prep", argon: 125, opus: 48, sonnet: 430, flash: 90, cost: "$51.20" },
        { role: "EVES Check", argon: 40, opus: 8, sonnet: 85, flash: 590, cost: "$32.20" }
      ]
    }
  };

  const SERIES_META = [
    { key: "argon",  name: "Argon 4",          colorVar: "var(--series-1)" },
    { key: "opus",   name: "Opus 5.5",         colorVar: "var(--series-2)" },
    { key: "sonnet", name: "Sonnet 5.5",       colorVar: "var(--series-3)" },
    { key: "flash",  name: "Gemini 3.8 Flash", colorVar: "var(--series-4)" }
  ];

  let currentRange = "session";
  let currentWorkspace = "all";
  let currentDagStage = null;
  let selectedAgentId = "coord";
  let sessionCap = 20;
  let isolatedSeries = null;
  let useTexture = false;

  const WORKSPACE_SCALE = {
    all: 1.0,
    "eden-code": 0.52,
    askeden: 0.31,
    "model-router": 0.17
  };

  const WORKSPACE_BRANCHES = {
    all: "⎇ ios-app-store-prep · 3 worktrees",
    "eden-code": "⎇ feat/argon-engine · 2 worktrees",
    askeden: "⎇ ios-app-store-prep · 2 worktrees",
    "model-router": "⎇ feat/bench-refresh · 1 worktree"
  };

  const AGENT_NAMES = {
    coord: "Coordinator · Engine Split",
    sec: "IPC & Preload Audit",
    ios: "iOS App Store 1.2 Prep",
    eves: "EVES UI Self-Check",
    router: "Router Benchmark Probe",
    review: "Shared Chat 1.2 Review"
  };

  const STEP_DETAILS = {
    "coord-1": {
      verb: "Read",
      pillClass: "run",
      title: "docs/eden-code-independence.md:1-120",
      meta: "Agent 01 · Coordinator · Gemini 4 Argon (High) · 140ms · $0.08",
      diff: "@@ docs/eden-code-independence.md @@\n  1 | # Eden Code Engine Split Specification\n  2 | - Isolate core agent loop into src/engine/\n  3 | - Store credentials in macOS Keychain (com.askeden.code)\n  4 | - Keep IPC strictly sender-validated via preload-gate.ts"
    },
    "coord-2": {
      verb: "Edit",
      pillClass: "run",
      title: "src/engine/router-bridge.ts (+48 -12)",
      meta: "Agent 01 · Coordinator · Gemini 4 Argon (High) · 620ms · $1.42",
      diff: "--- a/src/engine/router-bridge.ts\n+++ b/src/engine/router-bridge.ts\n@@ -41,7 +41,14 @@ export async function dispatchRoutedTurn(req: TurnRequest) {\n-  const model = await legacySelectModel(req.prompt);\n+  const decision = await edenRouter.route({\n+    task: req.taskKind,\n+    effort: req.effort ?? 'high',\n+    minReasoningFloor: 85,\n+    sessionCapUsd: req.sessionCapUsd\n+  });\n+  return executeWithReceipt(decision, req);\n }"
    },
    "coord-3": {
      verb: "Bash",
      pillClass: "eves",
      title: "npm test -- src/__tests__/router.test.ts",
      meta: "Agent 01 · Coordinator · 24/24 assertions passed · 1.4s",
      diff: "PASS src/__tests__/router.test.ts\n  ✓ routes security & architecture turns to Argon 4 / Opus 5.5 (18ms)\n  ✓ enforces reasoning >= 85 floor on background helper tasks (9ms)\n  ✓ records EVES turn receipt with exact cost and latency (14ms)\n\nTest Suites: 1 passed, 1 total\nTests:       24 passed, 24 total"
    },
    "sec-1": {
      verb: "Search",
      pillClass: "run",
      title: "codebase_search \"validateSender Electron IPC\"",
      meta: "Agent 02 · IPC & Preload Audit · Claude Opus 5.5 (High) · 210ms",
      diff: "Matched 4 locations across app/:\n  1. app/preload-gate.ts:18 — validateSender(frame: WebFrameMain)\n  2. app/ipc-handlers.ts:64 — ipcMain.handle('eden:keychain:get', ...)\n  3. app/window-manager.ts:112 — webPreferences: { contextIsolation: true, sandbox: true }"
    },
    "sec-2": {
      verb: "Edit",
      pillClass: "run",
      title: "app/preload-gate.ts (+19 -4)",
      meta: "Agent 02 · IPC & Preload Audit · Claude Opus 5.5 (High) · 510ms · $1.18",
      diff: "--- a/app/preload-gate.ts\n+++ b/app/preload-gate.ts\n@@ -18,6 +18,15 @@ export function assertTrustedSender(event: IpcMainInvokeEvent): void {\n   const url = new URL(event.senderFrame.url);\n-  if (url.protocol !== 'file:') throw new Error('Untrusted IPC');\n+  const allowed = url.protocol === 'eden:' || (url.hostname === 'localhost' && url.port === '5174');\n+  if (!allowed || event.senderFrame !== event.sender.mainFrame) {\n+    throw new Error(`Blocked untrusted IPC sender: ${url.origin}`);\n+  }\n }"
    },
    "sec-3": {
      verb: "Confirm",
      pillClass: "wait",
      title: "npx wrangler d1 migrations apply eden-auth --remote",
      meta: "Agent 02 · IPC & Preload Audit · Awaiting Owner Confirmation · Est. $0.00",
      diff: "-- Migration: 0009_keychain_session_binding.sql\nALTER TABLE auth_sessions ADD COLUMN keychain_binding_id TEXT;\nCREATE INDEX idx_auth_sessions_binding ON auth_sessions(keychain_binding_id);\n\n-- Principle 4: Ask before acting on remote D1 database.",
      needsApprovalId: "1"
    },
    "ios-1": {
      verb: "Read",
      pillClass: "run",
      title: "ios/Eden/InfoPlist.xcstrings",
      meta: "Agent 03 · iOS App Store 1.2 Prep · Claude Sonnet 5.5 (Med) · 95ms",
      diff: "Verified App Store review purpose strings:\n  NSMicrophoneUsageDescription: \"Eden uses the microphone when you speak a voice prompt.\"\n  NSCameraUsageDescription: \"Eden uses the camera when you attach a photo to your chat.\""
    },
    "ios-2": {
      verb: "Check",
      pillClass: "run",
      title: "sim_look · iPhone 17 Pro Simulator",
      meta: "Agent 03 · iOS App Store 1.2 Prep · 880ms",
      diff: "Simulator: iPhone 17 Pro (Booted)\nScreen: Shared Chat View (1179 × 2556 px)\nVerified elements: Report button [e18], Hide Content toggle [e19], Guidelines banner [e21]"
    },
    "ios-3": {
      verb: "Verify",
      pillClass: "eves",
      title: "Report & Hide shared chat sheet",
      meta: "Agent 03 · iOS App Store 1.2 Prep · Claude Sonnet 5.5 (Med) · 1.1s · $0.84",
      diff: "EVES iOS Check Verdict: PASS\n  ✓ Guideline 1.2 User-Generated Content report sheet opens in 1 tap\n  ✓ Immediate client-side hide removes reported thread from feed\n  ✓ No unapproved background deployment flags enabled"
    },
    "eves-1": {
      verb: "Open",
      pillClass: "eves",
      title: "check_open http://localhost:5174/eden-code-dashboard",
      meta: "Agent 04 · EVES UI Self-Check · Local Node + Flash 3.8 · 320ms · $0.00",
      diff: "Palette & Contrast Gate (validate_palette.js):\n  Dark Glass:     #3987e5, #d95926, #199e70, #c98500 -> PASS (min ΔE 19.4, contrast >= 4.6:1)\n  Daylight Frost: #2a78d6, #eb6834, #1baf7a, #eda100 -> PASS (min ΔE 18.8, contrast >= 3.4:1)"
    },
    "eves-2": {
      verb: "Act",
      pillClass: "run",
      title: "check_act click [e14] & check_console (0 errors)",
      meta: "Agent 04 · EVES UI Self-Check · Gemini 3.8 Flash · 640ms",
      diff: "Console errors: 0\nFailed network requests: 0\nInteractive elements verified: tabs, time slices, legend isolation, table views, approvals"
    },
    "eves-3": {
      verb: "Done",
      pillClass: "eves",
      title: "check_done verdict=\"pass\" (3 screenshots saved)",
      meta: "Agent 04 · EVES UI Self-Check · Gemini 3.8 Flash · 110ms · $0.55",
      diff: "Verdict: PASS\nSummary: All 3 dashboard views, SVG telemetry charts, and accessible table twins match DESIGN.md."
    },
    "router-1": {
      verb: "Read",
      pillClass: "run",
      title: "src/router/weights.json",
      meta: "Agent 05 · Router Benchmark Probe · Gemini 3.8 Flash (Low) · 60ms",
      diff: "{\n  \"tier_1_architect\": [\"gemini-4-argon\", \"claude-opus-5-5\"],\n  \"tier_2_implementation\": [\"claude-sonnet-5-5\"],\n  \"tier_3_verification\": [\"gemini-3-8-flash\"],\n  \"min_reasoning_score\": 85\n}"
    },
    "router-2": {
      verb: "Bash",
      pillClass: "run",
      title: "npm run test:outcomes -- --slice=code",
      meta: "Agent 05 · Router Benchmark Probe · 1.9s",
      diff: "Outcome benchmark slice: code (50 prompts)\n  Routed accuracy: 96.0% (vs 96.2% all-Opus baseline)\n  Cost reduction:  -62.1% ($4.18 vs $11.03)"
    },
    "router-3": {
      verb: "Write",
      pillClass: "run",
      title: "docs/benchmarks/2026-10-18.json",
      meta: "Agent 05 · Router Benchmark Probe · 120ms · $0.19",
      diff: "Saved updated benchmark snapshot to docs/benchmarks/2026-10-18.json (284 lines)."
    },
    "review-1": {
      verb: "Read",
      pillClass: "run",
      title: "web/chat/render.js:410-485",
      meta: "Agent 06 · Shared Chat 1.2 Review · Claude Sonnet 5.5 (Med) · 85ms",
      diff: "Inspected shared conversation header and moderation action menu."
    },
    "review-2": {
      verb: "Edit",
      pillClass: "run",
      title: "web/chat/app.js (+22 -3)",
      meta: "Agent 06 · Shared Chat 1.2 Review · Claude Sonnet 5.5 (Med) · 390ms · $0.44",
      diff: "--- a/web/chat/app.js\n+++ b/web/chat/app.js\n@@ -812,3 +812,22 @@ function bindSharedChatReport() {\n+  reportBtn.addEventListener('click', () => openModerationSheet(threadId));\n }"
    },
    "review-3": {
      verb: "Done",
      pillClass: "eves",
      title: "Report & Hide controls verified",
      meta: "Agent 06 · Shared Chat 1.2 Review · 150ms",
      diff: "All shared chat moderation controls verified on web and iOS."
    }
  };

  const svgNS = "http://www.w3.org/2000/svg";

  function getActiveSlice() {
    const base = SLICES[currentRange];
    const scale = WORKSPACE_SCALE[currentWorkspace] || 1.0;
    const rawSpend = parseFloat(base.spend.replace("$", "")) * scale;
    const spendStr = "$" + rawSpend.toFixed(2);
    const capVal = currentRange === "session" ? sessionCap : (currentRange === "today" ? 50 : (currentRange === "7d" ? 150 : 500));
    const capLabel = currentRange === "session" ? "session cap" : (currentRange === "today" ? "daily cap" : (currentRange === "7d" ? "weekly cap" : "monthly cap"));
    const meterPct = Math.min(100, Number(((rawSpend / capVal) * 100).toFixed(1)));
    const rawTok = parseFloat(base.tokens) * scale;
    const tokensStr = rawTok.toFixed(2) + "M tokens";
    const series = {};
    Object.keys(base.series).forEach(k => {
      series[k] = base.series[k].map(v => Math.max(1, Math.round(v * scale)));
    });
    const bars = base.bars.map(b => {
      const cVal = parseFloat(b.cost.replace("$", "")) * scale;
      return {
        role: b.role,
        argon: Math.max(1, Math.round(b.argon * scale)),
        opus: Math.round(b.opus * scale),
        sonnet: Math.max(1, Math.round(b.sonnet * scale)),
        flash: Math.max(1, Math.round(b.flash * scale)),
        cost: "$" + cVal.toFixed(2)
      };
    });
    return {
      ...base,
      spend: spendStr,
      capText: `${spendStr} of $${capVal.toFixed(2)} ${capLabel}`,
      meterPct,
      tokens: tokensStr,
      assumptions: String(Math.max(1, Math.round(parseInt(base.assumptions.replace(/,/g, ""), 10) * scale))),
      series,
      bars
    };
  }

  function renderLineChart() {
    const slice = getActiveSlice();
    const svg = document.getElementById("line-svg");
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const W = 540, H = 200;
    const padL = 40, padR = 64, padT = 14, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const allVals = Object.values(slice.series).flat();
    const maxVal = Math.ceil(Math.max(...allVals) * 1.12 / 10) * 10;

    const ticks = [0, Math.round(maxVal / 2), maxVal];
    ticks.forEach(t => {
      const y = padT + plotH - (t / maxVal) * plotH;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", padL);
      line.setAttribute("x2", padL + plotW);
      line.setAttribute("y1", y);
      line.setAttribute("y2", y);
      line.setAttribute("stroke", t === 0 ? "var(--axis-line)" : "var(--grid-line)");
      line.setAttribute("stroke-width", "1");
      svg.appendChild(line);

      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", padL - 8);
      lbl.setAttribute("y", y + 4);
      lbl.setAttribute("text-anchor", "end");
      lbl.setAttribute("fill", "var(--text3)");
      lbl.setAttribute("font-size", "10.5");
      lbl.setAttribute("font-family", "var(--font-mono)");
      lbl.textContent = t.toLocaleString() + "k";
      svg.appendChild(lbl);
    });

    const n = slice.intervals.length;
    slice.intervals.forEach((label, i) => {
      const x = padL + (i / (n - 1)) * plotW;
      const txt = document.createElementNS(svgNS, "text");
      txt.setAttribute("x", x);
      txt.setAttribute("y", H - 6);
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("fill", "var(--text2)");
      txt.setAttribute("font-size", "10.5");
      txt.setAttribute("font-family", "var(--font-mono)");
      txt.textContent = label;
      svg.appendChild(txt);
    });

    const crosshair = document.createElementNS(svgNS, "line");
    crosshair.setAttribute("y1", padT);
    crosshair.setAttribute("y2", padT + plotH);
    crosshair.setAttribute("stroke", "var(--text2)");
    crosshair.setAttribute("stroke-width", "1");
    crosshair.setAttribute("opacity", "0");
    svg.appendChild(crosshair);

    const endPositions = [];
    SERIES_META.forEach(s => {
      const isMuted = isolatedSeries && isolatedSeries !== s.key;
      const vals = slice.series[s.key];
      const pts = vals.map((v, i) => {
        const x = padL + (i / (n - 1)) * plotW;
        const y = padT + plotH - (v / maxVal) * plotH;
        return { x, y, v };
      });

      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("opacity", isMuted ? "0.2" : "1");

      if ((isolatedSeries === s.key) || (!isolatedSeries && s.key === "argon")) {
        const area = document.createElementNS(svgNS, "path");
        const dArea = [
          `M ${pts[0].x} ${padT + plotH}`,
          ...pts.map(p => `L ${p.x} ${p.y}`),
          `L ${pts[pts.length - 1].x} ${padT + plotH} Z`
        ].join(" ");
        area.setAttribute("d", dArea);
        area.setAttribute("fill", s.colorVar);
        area.setAttribute("opacity", "0.10");
        g.appendChild(area);
      }

      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", pts.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", s.colorVar);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      g.appendChild(path);

      pts.forEach(p => {
        const dot = document.createElementNS(svgNS, "circle");
        dot.setAttribute("cx", p.x);
        dot.setAttribute("cy", p.y);
        dot.setAttribute("r", "4.2");
        dot.setAttribute("fill", s.colorVar);
        dot.setAttribute("stroke", "var(--surface-chart)");
        dot.setAttribute("stroke-width", "2");
        g.appendChild(dot);
      });

      const last = pts[pts.length - 1];
      endPositions.push({ meta: s, x: last.x, y: last.y, v: last.v, isMuted });
      svg.appendChild(g);
    });

    endPositions.sort((a, b) => a.y - b.y);
    for (let i = 1; i < endPositions.length; i++) {
      if (endPositions[i].y - endPositions[i - 1].y < 13) {
        endPositions[i].y = endPositions[i - 1].y + 13;
      }
    }
    endPositions.forEach(ep => {
      if (ep.isMuted) return;
      const dotKey = document.createElementNS(svgNS, "circle");
      dotKey.setAttribute("cx", ep.x + 10);
      dotKey.setAttribute("cy", ep.y);
      dotKey.setAttribute("r", "3");
      dotKey.setAttribute("fill", ep.meta.colorVar);
      svg.appendChild(dotKey);

      const endText = document.createElementNS(svgNS, "text");
      endText.setAttribute("x", ep.x + 17);
      endText.setAttribute("y", ep.y + 3.5);
      endText.setAttribute("fill", "var(--text)");
      endText.setAttribute("font-size", "10.5");
      endText.setAttribute("font-weight", "600");
      endText.textContent = `${ep.v}k`;
      svg.appendChild(endText);
    });

    const overlay = document.createElementNS(svgNS, "rect");
    overlay.setAttribute("x", padL);
    overlay.setAttribute("y", padT);
    overlay.setAttribute("width", plotW);
    overlay.setAttribute("height", plotH);
    overlay.setAttribute("fill", "transparent");
    overlay.style.cursor = "crosshair";

    const tooltip = document.getElementById("line-tooltip");
    overlay.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * W - padL;
      const idx = Math.max(0, Math.min(n - 1, Math.round((relX / plotW) * (n - 1))));
      const snapX = padL + (idx / (n - 1)) * plotW;

      crosshair.setAttribute("x1", snapX);
      crosshair.setAttribute("x2", snapX);
      crosshair.setAttribute("opacity", "1");

      while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
      const head = document.createElement("div");
      head.className = "tt-head";
      head.textContent = `Window · ${slice.intervals[idx]}`;
      tooltip.appendChild(head);

      SERIES_META.forEach(s => {
        const row = document.createElement("div");
        row.className = "tt-row";
        const left = document.createElement("span");
        left.className = "tt-left";
        const stroke = document.createElement("span");
        stroke.className = "tt-stroke";
        stroke.style.background = s.colorVar;
        const val = document.createElement("span");
        val.className = "tt-val";
        val.textContent = `${slice.series[s.key][idx]}k tok`;
        left.appendChild(stroke);
        left.appendChild(val);

        const name = document.createElement("span");
        name.className = "tt-series";
        name.textContent = s.name;
        row.appendChild(left);
        row.appendChild(name);
        tooltip.appendChild(row);
      });

      tooltip.classList.add("visible");
      tooltip.style.left = `${Math.min(rect.width - 195, Math.max(8, (snapX / W) * rect.width - 40))}px`;
      tooltip.style.top = "8px";
    });

    overlay.addEventListener("pointerleave", () => {
      crosshair.setAttribute("opacity", "0");
      tooltip.classList.remove("visible");
    });

    svg.appendChild(overlay);

    const tbody = document.querySelector("#line-table tbody");
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    slice.intervals.forEach((intv, i) => {
      const tr = document.createElement("tr");
      [intv, slice.series.argon[i], slice.series.opus[i], slice.series.sonnet[i], slice.series.flash[i]].forEach(c => {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function renderBarChart() {
    const slice = getActiveSlice();
    const svg = document.getElementById("bar-svg");
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (useTexture) {
      const defs = document.createElementNS(svgNS, "defs");
      const p45 = document.createElementNS(svgNS, "pattern");
      p45.setAttribute("id", "tex-45");
      p45.setAttribute("width", "6");
      p45.setAttribute("height", "6");
      p45.setAttribute("patternTransform", "rotate(45)");
      p45.setAttribute("patternUnits", "userSpaceOnUse");
      const l1 = document.createElementNS(svgNS, "line");
      l1.setAttribute("x1", "0"); l1.setAttribute("y1", "0");
      l1.setAttribute("x2", "0"); l1.setAttribute("y2", "6");
      l1.setAttribute("stroke", "rgba(255,255,255,0.28)");
      l1.setAttribute("stroke-width", "2");
      p45.appendChild(l1);
      defs.appendChild(p45);
      svg.appendChild(defs);
    }

    const W = 440, H = 200;
    const padL = 94, padR = 64, padT = 12, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const barH = 18;

    const totals = slice.bars.map(b => b.argon + b.opus + b.sonnet + b.flash);
    const maxTotal = Math.ceil(Math.max(...totals) * 1.1 / 5) * 5;

    [0, Math.round(maxTotal / 2), maxTotal].forEach(t => {
      const x = padL + (t / maxTotal) * plotW;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", x);
      line.setAttribute("x2", x);
      line.setAttribute("y1", padT);
      line.setAttribute("y2", padT + plotH);
      line.setAttribute("stroke", t === 0 ? "var(--axis-line)" : "var(--grid-line)");
      line.setAttribute("stroke-width", "1");
      svg.appendChild(line);

      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", x);
      lbl.setAttribute("y", H - 6);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("fill", "var(--text3)");
      lbl.setAttribute("font-size", "10.5");
      lbl.setAttribute("font-family", "var(--font-mono)");
      lbl.textContent = String(t);
      svg.appendChild(lbl);
    });

    const tooltip = document.getElementById("bar-tooltip");
    const rowStep = plotH / slice.bars.length;

    slice.bars.forEach((row, idx) => {
      const cy = padT + idx * rowStep + rowStep / 2;
      const y = cy - barH / 2;

      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("x", padL - 10);
      label.setAttribute("y", cy + 4);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("fill", "var(--text)");
      label.setAttribute("font-size", "11.5");
      label.setAttribute("font-weight", "500");
      label.textContent = row.role;
      svg.appendChild(label);

      let curX = padL;
      const segs = SERIES_META.map(s => ({ meta: s, val: row[s.key] })).filter(s => s.val > 0);
      segs.forEach((seg, sIdx) => {
        const rawW = (seg.val / maxTotal) * plotW;
        const gap = sIdx < segs.length - 1 ? 2 : 0;
        const w = Math.max(2, rawW - gap);

        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", curX);
        rect.setAttribute("y", y);
        rect.setAttribute("width", w);
        rect.setAttribute("height", barH);
        if (sIdx === segs.length - 1) {
          rect.setAttribute("rx", "4");
          rect.setAttribute("ry", "4");
        }
        rect.setAttribute("fill", seg.meta.colorVar);
        rect.style.cursor = "pointer";

        rect.addEventListener("pointermove", (e) => {
          const wrapRect = svg.getBoundingClientRect();
          while (tooltip.firstChild) tooltip.removeChild(tooltip.firstChild);
          const head = document.createElement("div");
          head.className = "tt-head";
          head.textContent = `${row.role} · ${row.cost}`;
          tooltip.appendChild(head);

          const r = document.createElement("div");
          r.className = "tt-row";
          const left = document.createElement("span");
          left.className = "tt-left";
          const stroke = document.createElement("span");
          stroke.className = "tt-stroke";
          stroke.style.background = seg.meta.colorVar;
          const val = document.createElement("span");
          val.className = "tt-val";
          val.textContent = `${seg.val} turns`;
          left.appendChild(stroke);
          left.appendChild(val);

          const sName = document.createElement("span");
          sName.className = "tt-series";
          sName.textContent = seg.meta.name;
          r.appendChild(left);
          r.appendChild(sName);
          tooltip.appendChild(r);

          tooltip.classList.add("visible");
          tooltip.style.left = `${Math.min(wrapRect.width - 190, Math.max(8, e.clientX - wrapRect.left - 40))}px`;
          tooltip.style.top = `${Math.max(4, y - 18)}px`;
        });
        rect.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));

        svg.appendChild(rect);

        if (useTexture && (sIdx % 2 === 1)) {
          const texRect = document.createElementNS(svgNS, "rect");
          texRect.setAttribute("x", curX);
          texRect.setAttribute("y", y);
          texRect.setAttribute("width", w);
          texRect.setAttribute("height", barH);
          texRect.setAttribute("fill", "url(#tex-45)");
          texRect.setAttribute("pointer-events", "none");
          svg.appendChild(texRect);
        }

        curX += rawW;
      });

      const totalTurns = totals[idx];
      const tipLabel = document.createElementNS(svgNS, "text");
      tipLabel.setAttribute("x", curX + 6);
      tipLabel.setAttribute("y", cy + 4);
      tipLabel.setAttribute("fill", "var(--text)");
      tipLabel.setAttribute("font-size", "10.5");
      tipLabel.setAttribute("font-weight", "600");
      tipLabel.textContent = `${totalTurns} (${row.cost})`;
      svg.appendChild(tipLabel);
    });

    const tbody = document.querySelector("#bar-table tbody");
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    slice.bars.forEach(row => {
      const tr = document.createElement("tr");
      [row.role, row.argon, row.opus, row.sonnet, row.flash, row.cost].forEach(c => {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById("dash-toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("visible");
    }, 2600);
  }

  function updateDashboardSlice(rangeKey) {
    if (rangeKey) currentRange = rangeKey;
    const s = getActiveSlice();
    const scroll = document.getElementById("dashboard-scroll");
    if (scroll) scroll.classList.add("refetching");
    setTimeout(() => {
      document.getElementById("kpi-hero-spend").textContent = s.spend;
      document.getElementById("kpi-spend-limit").textContent = s.capText;
      document.getElementById("kpi-spend-meter").style.width = s.meterPct + "%";
      document.getElementById("kpi-tokens-total").textContent = s.tokens;
      document.getElementById("kpi-verified").textContent = s.verified;
      document.getElementById("kpi-verified-delta").textContent = s.verifiedDelta;
      document.getElementById("kpi-latency").textContent = s.latency;
      document.getElementById("kpi-latency-delta").textContent = s.latencyDelta;
      document.getElementById("kpi-assumptions").textContent = s.assumptions;
      renderLineChart();
      renderBarChart();
      if (scroll) scroll.classList.remove("refetching");
    }, 70);
  }

  function switchView(target) {
    document.querySelectorAll("[data-view-target]").forEach(b => {
      const active = b.getAttribute("data-view-target") === target;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".view-panel").forEach(p => {
      p.classList.toggle("active", p.id === `view-${target}`);
    });
  }

  document.querySelectorAll("[data-view-target]").forEach(btn => {
    btn.addEventListener("click", () => {
      switchView(btn.getAttribute("data-view-target"));
    });
  });

  function toggleTheme() {
    const html = document.documentElement;
    const themeBtn = document.getElementById("theme-toggle");
    const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    if (themeBtn) {
      themeBtn.setAttribute("aria-pressed", String(next === "light"));
      themeBtn.textContent = next === "light" ? "Surface: Daylight Frost" : "Surface: Dark Glass";
    }
    document.body.setAttribute(
      "data-palette",
      next === "light" ? "#2a78d6,#eb6834,#1baf7a,#eda100" : "#3987e5,#d95926,#199e70,#c98500"
    );
    renderLineChart();
    renderBarChart();
    showToast(next === "light" ? "Surface: Daylight Frost" : "Surface: Dark Glass");
  }

  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", toggleTheme);
  }

  function toggleTexture() {
    const texBtn = document.getElementById("texture-toggle");
    useTexture = !useTexture;
    if (texBtn) {
      texBtn.setAttribute("aria-pressed", String(useTexture));
      texBtn.textContent = useTexture ? "CVD Texture: 45° On" : "CVD Texture: Off";
    }
    renderBarChart();
    showToast(useTexture ? "CVD 45° diagonal texture enabled" : "CVD texture disabled");
  }

  const texBtn = document.getElementById("texture-toggle");
  if (texBtn) {
    texBtn.addEventListener("click", toggleTexture);
  }

  document.querySelectorAll("[data-range]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-range]").forEach(b => b.classList.toggle("active", b === btn));
      updateDashboardSlice(btn.getAttribute("data-range"));
    });
  });

  // Workspace & DAG stage filtering
  function applyWorkspaceAndStageFilters() {
    let visibleRoster = 0;
    document.querySelectorAll("#agent-roster .agent-item").forEach(item => {
      const ws = item.getAttribute("data-workspace") || "all";
      const matchWs = currentWorkspace === "all" || ws === currentWorkspace;
      item.style.display = matchWs ? "" : "none";
      if (matchWs) visibleRoster++;
    });

    document.querySelectorAll("#agent-panes-grid .agent-pane-card").forEach(card => {
      const ws = card.getAttribute("data-workspace") || "all";
      const stages = (card.getAttribute("data-stage") || "").split(",");
      const matchWs = currentWorkspace === "all" || ws === currentWorkspace;
      const matchStage = !currentDagStage || stages.includes(currentDagStage);
      card.classList.toggle("filtered-out", !(matchWs && matchStage));
    });

    document.querySelectorAll("#assumption-list .assumption-item").forEach(item => {
      const ws = item.getAttribute("data-workspace") || "all";
      const matchWs = currentWorkspace === "all" || ws === currentWorkspace;
      item.style.display = matchWs ? "" : "none";
    });

    document.querySelectorAll("#eves-ledger-tbody tr[data-workspace]").forEach(row => {
      const ws = row.getAttribute("data-workspace") || "all";
      const matchWs = currentWorkspace === "all" || ws === currentWorkspace;
      row.style.display = matchWs ? "" : "none";
    });

    const branchChip = document.getElementById("workspace-branch-chip");
    if (branchChip) {
      branchChip.textContent = WORKSPACE_BRANCHES[currentWorkspace] || WORKSPACE_BRANCHES.all;
    }
    const activeCount = document.getElementById("sidebar-active-count");
    if (activeCount) {
      activeCount.textContent = currentWorkspace === "all" ? "4 running · 1 wait" : `${visibleRoster} active`;
    }
  }

  const repoFilter = document.getElementById("repo-filter");
  if (repoFilter) {
    repoFilter.addEventListener("change", () => {
      currentWorkspace = repoFilter.value;
      applyWorkspaceAndStageFilters();
      updateDashboardSlice(currentRange);
      const label = repoFilter.options[repoFilter.selectedIndex]?.text || currentWorkspace;
      showToast(`Filtered workspace: ${label}`);
    });
  }

  document.querySelectorAll("[data-dag-stage]").forEach(btn => {
    btn.addEventListener("click", () => {
      const stage = btn.getAttribute("data-dag-stage");
      currentDagStage = currentDagStage === stage ? null : stage;
      document.querySelectorAll("[data-dag-stage]").forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-dag-stage") === currentDagStage);
      });
      applyWorkspaceAndStageFilters();
      showToast(currentDagStage ? `Filtered pipeline stage ${currentDagStage}` : "Showing all pipeline stages");
    });
  });

  // Agent selection (Sidebar Roster & View 02 Pane Cards)
  function selectAgent(agentId, switchToGrid = false) {
    selectedAgentId = agentId;
    document.querySelectorAll("#agent-roster .agent-item").forEach(item => {
      item.classList.toggle("active", item.getAttribute("data-agent-id") === agentId);
    });
    document.querySelectorAll("#agent-panes-grid .agent-pane-card").forEach(card => {
      card.classList.toggle("focused", card.getAttribute("data-agent-id") === agentId);
    });
    const input = document.getElementById("composer-input");
    if (input) {
      if (agentId === "all") {
        input.placeholder = "Message the entire agent fleet (6 agents)…";
      } else {
        const name = AGENT_NAMES[agentId] || agentId;
        input.placeholder = `Message @${agentId} (${name}) or @fleet…`;
      }
    }
    if (switchToGrid) {
      switchView("grid");
    }
  }

  document.querySelectorAll("#agent-roster .agent-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-agent-id");
      selectAgent(id, false);
      showToast(`Focused @${id} · ${AGENT_NAMES[id] || id}`);
    });
    btn.addEventListener("dblclick", () => {
      const id = btn.getAttribute("data-agent-id");
      selectAgent(id, true);
    });
  });

  document.querySelectorAll("#agent-panes-grid .agent-pane-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".step-row")) return;
      const id = card.getAttribute("data-agent-id");
      if (id) selectAgent(id, false);
    });
  });

  // Series legend filter & Table view toggles
  document.querySelectorAll("#line-legend [data-series]").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-series");
      isolatedSeries = isolatedSeries === key ? null : key;
      document.querySelectorAll("#line-legend [data-series]").forEach(b => {
        b.classList.toggle("muted", isolatedSeries && b.getAttribute("data-series") !== isolatedSeries);
      });
      renderLineChart();
    });
  });

  document.querySelectorAll("[data-table-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-table-toggle");
      const pressed = btn.getAttribute("aria-pressed") === "true";
      const next = !pressed;
      btn.setAttribute("aria-pressed", String(next));
      btn.textContent = next ? "Chart view" : "Table view";
      document.getElementById(`${kind}-plot-wrap`).style.display = next ? "none" : "block";
      document.getElementById(`${kind}-table-wrap`).classList.toggle("visible", next);
    });
  });

  // Approval card resolution (synchronized across View 01, View 02, View 03, and Sidebar)
  function resolveApproval(id, approved) {
    const card = document.getElementById(`approval-card-${id}`);
    if (card) {
      card.style.borderColor = approved ? "rgba(48, 209, 88, 0.45)" : "rgba(142, 142, 147, 0.35)";
      const actions = card.querySelector(".approval-actions");
      if (actions) {
        actions.textContent = approved ? "Approved · Running" : "Declined · Held";
        actions.style.fontFamily = "var(--font-mono)";
        actions.style.fontSize = "11px";
        actions.style.color = approved ? "var(--status-run)" : "var(--text2)";
      }
    }

    if (id === "1") {
      const rosterPill = document.getElementById("roster-pill-sec");
      if (rosterPill) {
        rosterPill.className = approved ? "state-pill run" : "state-pill done";
        rosterPill.innerHTML = `<span class="state-dot"></span>${approved ? "Run" : "Held"}`;
      }
      const panePill = document.getElementById("pane-pill-sec");
      if (panePill) {
        panePill.className = approved ? "state-pill run" : "state-pill done";
        panePill.innerHTML = `<span class="state-dot"></span>${approved ? "Running" : "Held"}`;
      }
      const stepRow = document.getElementById("step-sec-confirm");
      if (stepRow) stepRow.classList.remove("step-row-warn");
      const stepVerb = document.getElementById("step-sec-verb");
      if (stepVerb) {
        stepVerb.className = approved ? "step-verb verb-eves" : "step-verb";
        stepVerb.textContent = approved ? "Approved" : "Declined";
      }
      const stepTime = document.getElementById("step-sec-time");
      if (stepTime) stepTime.textContent = approved ? "420ms" : "Skipped";
      const dagDot = document.getElementById("dag-dot-security");
      if (dagDot) dagDot.className = approved ? "state-dot dot-run" : "state-dot";
      const dagLabel = document.getElementById("dag-label-security");
      if (dagLabel) dagLabel.textContent = approved ? "3. Security Gate (Running)" : "3. Security Gate (Held)";
      const sideCount = document.getElementById("sidebar-active-count");
      if (sideCount) sideCount.textContent = approved ? "5 running · 0 wait" : "4 running · 1 held";
      if (STEP_DETAILS["sec-3"]) {
        STEP_DETAILS["sec-3"].verb = approved ? "Approved" : "Declined";
        STEP_DETAILS["sec-3"].pillClass = approved ? "eves" : "done";
        STEP_DETAILS["sec-3"].needsApprovalId = null;
      }
      showToast(approved ? "Approved D1 migration check · IPC Audit resumed" : "Declined D1 migration · IPC Audit held");
    } else if (id === "2") {
      const pill = document.getElementById("assumption-pill-keychain");
      if (pill) {
        pill.className = approved ? "state-pill eves" : "state-pill wait";
        pill.innerHTML = `<span class="state-dot"></span>${approved ? "Owner Confirmed" : "Asking Owner"}`;
      }
      showToast(approved ? "Confirmed macOS Keychain storage choice" : "Flagged Keychain assumption for owner review");
    }
  }

  document.querySelectorAll("[data-approve], [data-deny]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-approve") || btn.getAttribute("data-deny");
      const approved = btn.hasAttribute("data-approve");
      resolveApproval(id, approved);
    });
  });

  document.querySelectorAll("[data-undo]").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.textContent = "Reverted · Asking owner";
      btn.style.color = "var(--accent)";
      const key = btn.getAttribute("data-undo");
      if (key === "keychain") {
        resolveApproval("2", false);
      } else {
        showToast(`Reverted assumption (${key}) · branching turn`);
      }
    });
  });

  // Step Diff & Proof Inspector Modal
  const stepBackdrop = document.getElementById("step-inspector-backdrop");
  const inspCloseBtn = document.getElementById("insp-close-btn");

  function openStepInspector(stepKey) {
    const info = STEP_DETAILS[stepKey];
    if (!info || !stepBackdrop) return;
    const badge = document.getElementById("insp-verb-badge");
    if (badge) {
      badge.className = `state-pill ${info.pillClass || "run"}`;
      badge.textContent = info.verb;
    }
    const titleEl = document.getElementById("insp-title");
    if (titleEl) titleEl.textContent = info.title;
    const metaEl = document.getElementById("insp-meta");
    if (metaEl) metaEl.textContent = info.meta;
    const diffEl = document.getElementById("insp-diff");
    if (diffEl) diffEl.textContent = info.diff;

    const actionsEl = document.getElementById("insp-actions");
    if (actionsEl) {
      while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
      if (info.needsApprovalId) {
        actionsEl.classList.add("visible");
        const appBtn = document.createElement("button");
        appBtn.type = "button";
        appBtn.className = "btn-approve";
        appBtn.textContent = "Approve & Run";
        appBtn.addEventListener("click", () => {
          resolveApproval(info.needsApprovalId, true);
          closeStepInspector();
        });
        const denBtn = document.createElement("button");
        denBtn.type = "button";
        denBtn.className = "btn-deny";
        denBtn.textContent = "Decline";
        denBtn.addEventListener("click", () => {
          resolveApproval(info.needsApprovalId, false);
          closeStepInspector();
        });
        actionsEl.appendChild(appBtn);
        actionsEl.appendChild(denBtn);
      } else {
        actionsEl.classList.remove("visible");
      }
    }

    stepBackdrop.classList.add("open");
  }

  function closeStepInspector() {
    if (stepBackdrop) stepBackdrop.classList.remove("open");
  }

  function bindStepElement(el) {
    const key = el.getAttribute("data-step-key");
    if (!key) return;
    el.addEventListener("click", () => openStepInspector(key));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openStepInspector(key);
      }
    });
  }

  document.querySelectorAll("[data-step-key]").forEach(bindStepElement);

  if (inspCloseBtn) {
    inspCloseBtn.addEventListener("click", closeStepInspector);
  }
  if (stepBackdrop) {
    stepBackdrop.addEventListener("click", (e) => {
      if (e.target === stepBackdrop) closeStepInspector();
    });
  }

  // ⌘K Command Palette Modal
  const cmdBackdrop = document.getElementById("cmd-palette-backdrop");
  const cmdInput = document.getElementById("cmd-input");
  const cmdList = document.getElementById("cmd-list");
  const cmdTrigger = document.getElementById("cmd-trigger");
  let cmdSelectedIndex = 0;

  const COMMANDS = [
    { group: "Views", label: "01 · Fleet & Telemetry Overview", meta: "View 01", run: () => switchView("fleet") },
    { group: "Views", label: "02 · Parallel Agent Grid (6 Worktrees)", meta: "View 02", run: () => switchView("grid") },
    { group: "Views", label: "03 · Turn Receipts, Assumptions & EVES Ledger", meta: "View 03", run: () => switchView("receipts") },
    { group: "Agent Fleet", label: "Focus @coord · Coordinator · Engine Split", meta: "Argon 4", run: () => selectAgent("coord", true) },
    { group: "Agent Fleet", label: "Focus @sec · IPC & Preload Audit", meta: "Opus 5.5", run: () => selectAgent("sec", true) },
    { group: "Agent Fleet", label: "Focus @ios · iOS App Store 1.2 Prep", meta: "Sonnet 5.5", run: () => selectAgent("ios", true) },
    { group: "Agent Fleet", label: "Focus @eves · EVES UI Self-Check", meta: "Flash 3.8", run: () => selectAgent("eves", true) },
    { group: "Agent Fleet", label: "Focus @router · Router Benchmark Probe", meta: "Flash 3.8", run: () => selectAgent("router", true) },
    { group: "Controls", label: "Toggle Surface: Dark Glass / Daylight Frost", meta: "Theme", run: () => toggleTheme() },
    { group: "Controls", label: "Toggle CVD 45° Diagonal Bar Texture", meta: "Accessibility", run: () => toggleTexture() },
    { group: "Controls", label: "Inspect Pending D1 Migration Confirmation", meta: "Principle 4", run: () => openStepInspector("sec-3") },
    { group: "Controls", label: "Export EVES Verified Turn Receipt (JSON)", meta: "$4.18", run: () => { switchView("receipts"); showToast("Exported EVES turn receipt JSON ($4.18 · 42/43 verified)"); } }
  ];

  function renderCommandList(query = "") {
    if (!cmdList) return;
    while (cmdList.firstChild) cmdList.removeChild(cmdList.firstChild);
    const q = query.trim().toLowerCase();
    const filtered = COMMANDS.filter(c => !q || c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q) || c.meta.toLowerCase().includes(q));
    if (cmdSelectedIndex >= filtered.length) cmdSelectedIndex = 0;

    let currentGroup = null;
    filtered.forEach((cmd, idx) => {
      if (cmd.group !== currentGroup) {
        currentGroup = cmd.group;
        const grp = document.createElement("div");
        grp.className = "cmd-group-label";
        grp.textContent = currentGroup;
        cmdList.appendChild(grp);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cmd-option" + (idx === cmdSelectedIndex ? " selected" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(idx === cmdSelectedIndex));
      const left = document.createElement("span");
      left.textContent = cmd.label;
      const right = document.createElement("span");
      right.className = "cmd-option-meta";
      right.textContent = cmd.meta;
      btn.appendChild(left);
      btn.appendChild(right);
      btn.addEventListener("click", () => {
        closeCommandPalette();
        cmd.run();
      });
      cmdList.appendChild(btn);
    });
  }

  function openCommandPalette() {
    if (!cmdBackdrop) return;
    closePopovers();
    cmdSelectedIndex = 0;
    if (cmdInput) cmdInput.value = "";
    renderCommandList("");
    cmdBackdrop.classList.add("open");
    if (cmdInput) setTimeout(() => cmdInput.focus(), 20);
  }

  function closeCommandPalette() {
    if (cmdBackdrop) cmdBackdrop.classList.remove("open");
  }

  if (cmdTrigger) {
    cmdTrigger.addEventListener("click", openCommandPalette);
  }
  if (cmdBackdrop) {
    cmdBackdrop.addEventListener("click", (e) => {
      if (e.target === cmdBackdrop) closeCommandPalette();
    });
  }
  if (cmdInput) {
    cmdInput.addEventListener("input", () => {
      cmdSelectedIndex = 0;
      renderCommandList(cmdInput.value);
    });
    cmdInput.addEventListener("keydown", (e) => {
      const options = cmdList ? Array.from(cmdList.querySelectorAll(".cmd-option")) : [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (options.length) {
          cmdSelectedIndex = (cmdSelectedIndex + 1) % options.length;
          renderCommandList(cmdInput.value);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (options.length) {
          cmdSelectedIndex = (cmdSelectedIndex - 1 + options.length) % options.length;
          renderCommandList(cmdInput.value);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (options[cmdSelectedIndex]) options[cmdSelectedIndex].click();
      }
    });
  }

  // Floating Popovers: Session Spend Cap & Orb Options
  const capPopover = document.getElementById("cap-popover");
  const orbPopover = document.getElementById("orb-popover");
  const headerCapBtn = document.getElementById("header-cap-btn");
  const sidebarCapBtn = document.getElementById("sidebar-cap-btn");
  const orbBtn = document.getElementById("orb-options-btn");

  function closePopovers() {
    if (capPopover) capPopover.classList.remove("open");
    if (orbPopover) orbPopover.classList.remove("open");
    if (orbBtn) orbBtn.setAttribute("aria-expanded", "false");
  }

  function toggleCapPopover(anchorEl, e) {
    e.stopPropagation();
    const wasOpen = capPopover && capPopover.classList.contains("open");
    closePopovers();
    if (!wasOpen && capPopover && anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      capPopover.classList.add("open");
      const top = rect.bottom + 8 + 90 > window.innerHeight ? Math.max(12, rect.top - 96) : rect.bottom + 8;
      const left = Math.min(window.innerWidth - 240, Math.max(12, rect.left));
      capPopover.style.top = `${top}px`;
      capPopover.style.left = `${left}px`;
    }
  }

  if (headerCapBtn) {
    headerCapBtn.addEventListener("click", (e) => toggleCapPopover(headerCapBtn, e));
  }
  if (sidebarCapBtn) {
    sidebarCapBtn.addEventListener("click", (e) => toggleCapPopover(sidebarCapBtn, e));
  }

  document.querySelectorAll("[data-cap-val]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      sessionCap = parseInt(btn.getAttribute("data-cap-val"), 10) || 20;
      document.querySelectorAll("[data-cap-val]").forEach(b => b.classList.toggle("active", b === btn));
      if (headerCapBtn) headerCapBtn.textContent = `Session cap: $${sessionCap.toFixed(2)}`;
      if (sidebarCapBtn) sidebarCapBtn.textContent = `$4.18 / $${sessionCap}`;
      const evesTotalLabel = document.getElementById("eves-total-label");
      if (evesTotalLabel) evesTotalLabel.textContent = `Session Total (cap $${sessionCap.toFixed(2)})`;
      updateDashboardSlice(currentRange);
      closePopovers();
      showToast(`Session spend cap updated to $${sessionCap.toFixed(2)}`);
    });
  });

  if (orbBtn && orbPopover) {
    orbBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = orbPopover.classList.contains("open");
      closePopovers();
      if (!wasOpen) {
        const rect = orbBtn.getBoundingClientRect();
        orbPopover.classList.add("open");
        orbBtn.setAttribute("aria-expanded", "true");
        orbPopover.style.left = `${Math.max(12, rect.left)}px`;
        orbPopover.style.top = `${Math.max(12, rect.top - 156)}px`;
      }
    });
  }

  document.querySelectorAll("[data-orb-action]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.getAttribute("data-orb-action");
      closePopovers();
      if (action === "target-all") {
        selectAgent("all", false);
        const input = document.getElementById("composer-input");
        if (input) input.focus();
        showToast("Composer targeting entire fleet (@fleet)");
      } else if (action === "export-receipt") {
        switchView("receipts");
        showToast("Exported EVES turn receipt JSON ($4.18 · 42/43 verified)");
      } else if (action === "open-chat") {
        showToast("Ask Eden Chat ready at / — agent fleet active");
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (capPopover && capPopover.classList.contains("open") && !capPopover.contains(e.target)) {
      closePopovers();
    }
    if (orbPopover && orbPopover.classList.contains("open") && !orbPopover.contains(e.target)) {
      closePopovers();
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (cmdBackdrop && cmdBackdrop.classList.contains("open")) {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
    } else if (e.key === "Escape") {
      closeCommandPalette();
      closeStepInspector();
      closePopovers();
    }
  });

  // Window Traffic Lights
  const maxTl = document.querySelector(".tl.max");
  if (maxTl) {
    maxTl.addEventListener("click", () => {
      const stage = document.querySelector(".stage");
      if (stage) {
        const maximized = stage.classList.toggle("maximized");
        showToast(maximized ? "Expanded window to full canvas" : "Restored window frame");
      }
    });
  }
  document.querySelectorAll(".tl.close, .tl.min").forEach(tl => {
    tl.addEventListener("click", () => {
      showToast("Eden Code agent fleet continues running in background");
    });
  });

  // Composer Pill Cyclers & Live Prompt Dispatch
  const MODES = ["Auto", "Ask", "Plan"];
  const MODELS = [
    "Eden Router · Argon 4",
    "Eden Router · Opus 5.5",
    "Eden Router · Sonnet 5.5",
    "Eden Router · Flash 3.8"
  ];
  const EFFORTS = ["High", "Med", "Low"];
  let modeIdx = 0;
  let modelIdx = 0;
  let effortIdx = 0;

  const modeBtn = document.getElementById("mode-cycle-btn");
  if (modeBtn) {
    modeBtn.addEventListener("click", () => {
      modeIdx = (modeIdx + 1) % MODES.length;
      const mode = MODES[modeIdx];
      modeBtn.textContent = mode;
      const routerLbl = document.getElementById("sidebar-router-label");
      if (routerLbl) routerLbl.textContent = `Eden Router · ${mode}`;
      showToast(`Permission mode: ${mode}`);
    });
  }

  const modelBtn = document.getElementById("model-cycle-btn");
  const modelLbl = document.getElementById("model-cycle-label");
  if (modelBtn && modelLbl) {
    modelBtn.addEventListener("click", () => {
      modelIdx = (modelIdx + 1) % MODELS.length;
      modelLbl.textContent = MODELS[modelIdx];
      showToast(`Routed model: ${MODELS[modelIdx]}`);
    });
  }

  const effortBtn = document.getElementById("effort-cycle-btn");
  if (effortBtn) {
    effortBtn.addEventListener("click", () => {
      effortIdx = (effortIdx + 1) % EFFORTS.length;
      effortBtn.textContent = EFFORTS[effortIdx];
      showToast(`Reasoning effort: ${EFFORTS[effortIdx]}`);
    });
  }

  let liveStepCounter = 1;
  function dispatchComposerPrompt() {
    const input = document.getElementById("composer-input");
    if (!input) return;
    const raw = input.value.trim();
    if (!raw) {
      input.focus();
      showToast("Enter an instruction for the agent fleet");
      return;
    }

    let targetAgent = selectedAgentId === "all" ? "coord" : (selectedAgentId || "coord");
    const mentionMatch = raw.match(/^@(coord|sec|ios|eves|router|review)\b/i);
    if (mentionMatch) {
      targetAgent = mentionMatch[1].toLowerCase();
    }

    const stepKey = `live-${liveStepCounter++}`;
    const shortModel = MODELS[modelIdx].replace("Eden Router · ", "");
    const effort = EFFORTS[effortIdx];
    const cleanText = raw.replace(/^@\w+\s*/, "") || raw;

    STEP_DETAILS[stepKey] = {
      verb: "Prompt",
      pillClass: "eves",
      title: cleanText.slice(0, 72),
      meta: `Dispatched to @${targetAgent} · ${shortModel} (${effort}) · 180ms · $0.02`,
      diff: `Instruction dispatched to ${AGENT_NAMES[targetAgent] || targetAgent}:\n> ${raw}\n\nRouter Pick: ${shortModel} (${effort})\nPermission Mode: ${MODES[modeIdx]}\nEVES Status: Queued & Verified`
    };

    const stepList = document.getElementById(`steps-${targetAgent}`);
    if (stepList) {
      const row = document.createElement("div");
      row.className = "step-row";
      row.setAttribute("data-step-key", stepKey);
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      const left = document.createElement("span");
      left.className = "step-left";
      const verb = document.createElement("span");
      verb.className = "step-verb verb-eves";
      verb.textContent = "Prompt";
      left.appendChild(verb);
      left.appendChild(document.createTextNode(" " + cleanText.slice(0, 48)));
      const right = document.createElement("span");
      right.textContent = "180ms";
      row.appendChild(left);
      row.appendChild(right);
      bindStepElement(row);
      stepList.appendChild(row);
    }

    const ledgerBody = document.getElementById("eves-ledger-tbody");
    const totalRow = document.getElementById("eves-total-row");
    if (ledgerBody && totalRow) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-step-key", stepKey);
      tr.setAttribute("data-workspace", "eden-code");
      [
        `@${targetAgent} · ${cleanText.slice(0, 42)}`,
        `${shortModel} (${effort})`,
        "0.18s",
        "$0.02"
      ].forEach(val => {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      });
      bindStepElement(tr);
      ledgerBody.insertBefore(tr, totalRow);
    }

    input.value = "";
    selectAgent(targetAgent, false);
    showToast(`Dispatched to @${targetAgent} via ${shortModel} (${effort})`);
  }

  const sendBtn = document.getElementById("composer-send-btn");
  if (sendBtn) {
    sendBtn.addEventListener("click", dispatchComposerPrompt);
  }

  const form = document.getElementById("dashboard-composer");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      dispatchComposerPrompt();
    });
  }

  renderLineChart();
  renderBarChart();
})();

  } catch (err) {
    console.error('Eden Code Dashboard init error:', err);
  }

  badge();
})(typeof window === 'object' ? window : globalThis);
