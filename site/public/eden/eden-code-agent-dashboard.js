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
  let costSaverMode = true;

  const SAVINGS_BASE = {
    session: {
      wouldHaveCost: 11.03,
      actualCost: 4.18,
      cacheSaved: 4.12,
      routingSaved: 2.09,
      thinkingSaved: 0.42,
      mediaEmbedSaved: 0.22,
      wouldCurve: [1.85, 3.60, 5.45, 7.20, 9.15, 11.03],
      actualCurve: [0.95, 1.55, 2.20, 2.85, 3.52, 4.18]
    },
    today: {
      wouldHaveCost: 39.20,
      actualCost: 14.80,
      cacheSaved: 14.60,
      routingSaved: 7.40,
      thinkingSaved: 1.55,
      mediaEmbedSaved: 0.85,
      wouldCurve: [6.20, 12.80, 19.40, 25.90, 32.50, 39.20],
      actualCurve: [2.80, 5.10, 7.60, 10.05, 12.40, 14.80]
    },
    "7d": {
      wouldHaveCost: 181.50,
      actualCost: 68.40,
      cacheSaved: 67.80,
      routingSaved: 34.20,
      thinkingSaved: 7.10,
      mediaEmbedSaved: 4.00,
      wouldCurve: [28.0, 58.5, 89.0, 119.5, 150.0, 181.5],
      actualCurve: [11.2, 22.8, 34.1, 45.6, 57.0, 68.4]
    },
    "30d": {
      wouldHaveCost: 642.80,
      actualCost: 241.90,
      cacheSaved: 240.10,
      routingSaved: 121.40,
      thinkingSaved: 25.20,
      mediaEmbedSaved: 14.20,
      wouldCurve: [98.0, 204.0, 312.0, 422.0, 531.0, 642.8],
      actualCurve: [39.0, 79.5, 120.2, 161.0, 201.4, 241.9]
    }
  };

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
    const sbsBase = SAVINGS_BASE[currentRange] || SAVINGS_BASE.session;
    const rawSaverSpend = parseFloat(base.spend.replace("$", "")) * scale;
    const rawLegacySpend = sbsBase.wouldHaveCost * scale;
    const rawSpend = costSaverMode ? rawSaverSpend : rawLegacySpend;
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
    const legacyFactor = costSaverMode ? 1.0 : (rawLegacySpend / Math.max(0.01, rawSaverSpend));
    const bars = base.bars.map(b => {
      const cVal = parseFloat(b.cost.replace("$", "")) * scale * legacyFactor;
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
      bars,
      sbs: {
        wouldHaveCost: rawLegacySpend,
        actualSaverCost: rawSaverSpend,
        activeCost: rawSpend,
        savedTotal: Math.max(0, rawLegacySpend - rawSaverSpend),
        cacheSaved: sbsBase.cacheSaved * scale,
        routingSaved: sbsBase.routingSaved * scale,
        thinkingSaved: sbsBase.thinkingSaved * scale,
        mediaEmbedSaved: sbsBase.mediaEmbedSaved * scale,
        wouldCurve: sbsBase.wouldCurve.map(v => Number((v * scale).toFixed(2))),
        actualCurve: sbsBase.actualCurve.map(v => Number((v * scale).toFixed(2)))
      }
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

  function renderSavingsView() {
    const slice = getActiveSlice();
    const sbs = slice.sbs;
    if (!sbs) return;

    const pct = sbs.wouldHaveCost > 0 ? ((sbs.savedTotal / sbs.wouldHaveCost) * 100).toFixed(1) : "0.0";
    const setTxt = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };

    setTxt("sbs-hero-saved", costSaverMode ? `$${sbs.savedTotal.toFixed(2)}` : `$0.00 (Legacy On)`);
    setTxt("sbs-hero-pct-pill", costSaverMode ? `${pct}% saved` : `0% saved · Legacy Mode`);
    setTxt("sbs-saved-caption", `Cost-Saver $${sbs.actualSaverCost.toFixed(2)} vs $${sbs.wouldHaveCost.toFixed(2)} would-have-cost`);
    setTxt("sbs-would-have-cost", `$${sbs.wouldHaveCost.toFixed(2)}`);
    setTxt("sbs-actual-cost", `$${sbs.actualSaverCost.toFixed(2)}`);
    setTxt("sbs-cache-saved-tag", `$${sbs.cacheSaved.toFixed(2)} from cache`);
    setTxt("sbs-card-saver-price", `$${sbs.actualSaverCost.toFixed(2)}`);
    setTxt("sbs-card-legacy-price", `$${sbs.wouldHaveCost.toFixed(2)}`);

    const meter = document.getElementById("sbs-saved-meter");
    if (meter) meter.style.width = (costSaverMode ? Math.min(100, parseFloat(pct)) : 0) + "%";

    const cardSaver = document.getElementById("sbs-card-saver");
    const cardLegacy = document.getElementById("sbs-card-legacy");
    const badgeSaver = document.getElementById("sbs-badge-saver");
    const badgeLegacy = document.getElementById("sbs-badge-legacy");
    const modePill = document.getElementById("savings-mode-pill");
    const modeHeading = document.getElementById("savings-mode-heading");

    if (cardSaver) cardSaver.classList.toggle("active-mode", costSaverMode);
    if (cardLegacy) cardLegacy.classList.toggle("active-mode", !costSaverMode);
    if (badgeSaver) {
      badgeSaver.className = costSaverMode ? "state-pill eves" : "state-pill done";
      badgeSaver.textContent = costSaverMode ? "Default · Active" : "Standby (Click to Restore)";
    }
    if (badgeLegacy) {
      badgeLegacy.className = !costSaverMode ? "state-pill warn" : "state-pill done";
      badgeLegacy.textContent = !costSaverMode ? "Active · Legacy Uncached" : "Available via 1-Click Revert";
    }
    if (modePill) {
      modePill.className = costSaverMode ? "state-pill eves" : "state-pill warn";
      modePill.innerHTML = `<span class="state-dot"></span>${costSaverMode ? "Active: Cost-Saver Engine (Default)" : "Active: Legacy Uncached Engine"}`;
    }
    if (modeHeading) {
      modeHeading.textContent = costSaverMode
        ? "Gemini 4 Argon Explicit + Rolling History Caching · 0.0% Quality Loss"
        : "Legacy Uncached Mode · Re-billing full prompt & history every turn ($2.00/M)";
    }

    const tbody = document.getElementById("sbs-breakdown-tbody");
    if (tbody) {
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      const rows = [
        {
          layer: "1. Explicit + Rolling History & Image Cache (Gemini / Claude / OpenAI / Kimi)",
          would: sbs.actualSaverCost + sbs.cacheSaved,
          actual: sbs.actualSaverCost,
          saved: sbs.cacheSaved
        },
        {
          layer: "2. Stable Provenance & Memory Boundaries + Dynamic Tail Split",
          would: sbs.cacheSaved * 0.42,
          actual: sbs.cacheSaved * 0.04,
          saved: sbs.cacheSaved * 0.38
        },
        {
          layer: "3. Model Router vs. All-Opus Baseline",
          would: sbs.actualSaverCost + sbs.routingSaved,
          actual: sbs.actualSaverCost,
          saved: sbs.routingSaved
        },
        {
          layer: "4. Flash 3.8 JSON thinkingLevel: low + Memory Pre-Filter",
          would: sbs.thinkingSaved * 1.45,
          actual: sbs.thinkingSaved * 0.45,
          saved: sbs.thinkingSaved
        },
        {
          layer: "5. Video (>10m low-res) + Session Embed Dedup",
          would: sbs.mediaEmbedSaved * 1.5,
          actual: sbs.mediaEmbedSaved * 0.5,
          saved: sbs.mediaEmbedSaved
        },
        {
          layer: "Total (Cost-Saver vs. Would-Have-Cost)",
          would: sbs.wouldHaveCost,
          actual: sbs.actualSaverCost,
          saved: sbs.savedTotal,
          bold: true
        }
      ];
      rows.forEach(r => {
        const tr = document.createElement("tr");
        [
          r.layer,
          `$${r.would.toFixed(2)}`,
          `$${r.actual.toFixed(2)}`,
          `−$${r.saved.toFixed(2)}`
        ].forEach((val, idx) => {
          const td = document.createElement("td");
          if (r.bold) {
            const st = document.createElement("strong");
            st.textContent = val;
            if (idx === 3) st.style.color = "var(--status-run)";
            td.appendChild(st);
          } else {
            td.textContent = val;
            if (idx === 3) td.style.color = "var(--status-run)";
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    const svg = document.getElementById("sbs-svg");
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const W = 540, H = 200;
    const padL = 46, padR = 68, padT = 14, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.ceil(Math.max(...sbs.wouldCurve) * 1.15);

    [0, Math.round(maxVal / 2), maxVal].forEach(t => {
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
      lbl.textContent = `$${t}`;
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

    const wouldPts = sbs.wouldCurve.map((v, i) => ({
      x: padL + (i / (n - 1)) * plotW,
      y: padT + plotH - (v / maxVal) * plotH,
      v
    }));
    const actualPts = sbs.actualCurve.map((v, i) => ({
      x: padL + (i / (n - 1)) * plotW,
      y: padT + plotH - (v / maxVal) * plotH,
      v
    }));

    const area = document.createElementNS(svgNS, "path");
    const dArea = [
      `M ${wouldPts[0].x} ${wouldPts[0].y}`,
      ...wouldPts.slice(1).map(p => `L ${p.x} ${p.y}`),
      ...[...actualPts].reverse().map(p => `L ${p.x} ${p.y}`),
      "Z"
    ].join(" ");
    area.setAttribute("d", dArea);
    area.setAttribute("fill", "var(--series-3)");
    area.setAttribute("opacity", "0.16");
    svg.appendChild(area);

    const drawSeries = (pts, colorVar, dashed = false) => {
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", pts.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", colorVar);
      path.setAttribute("stroke-width", "2.2");
      if (dashed) path.setAttribute("stroke-dasharray", "5,4");
      svg.appendChild(path);

      pts.forEach(p => {
        const dot = document.createElementNS(svgNS, "circle");
        dot.setAttribute("cx", p.x);
        dot.setAttribute("cy", p.y);
        dot.setAttribute("r", "4");
        dot.setAttribute("fill", colorVar);
        dot.setAttribute("stroke", "var(--surface-chart)");
        dot.setAttribute("stroke-width", "1.8");
        svg.appendChild(dot);
      });

      const last = pts[pts.length - 1];
      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", last.x + 8);
      lbl.setAttribute("y", last.y + 4);
      lbl.setAttribute("fill", "var(--text)");
      lbl.setAttribute("font-size", "10.5");
      lbl.setAttribute("font-weight", "600");
      lbl.textContent = `$${last.v.toFixed(2)}`;
      svg.appendChild(lbl);
    };

    drawSeries(wouldPts, "var(--series-2)", true);
    drawSeries(actualPts, "var(--series-1)", false);
  }

  function setCostSaverEngine(enabled) {
    costSaverMode = Boolean(enabled);
    document.querySelectorAll("[data-engine-mode]").forEach(btn => {
      const isSaver = btn.getAttribute("data-engine-mode") === "cost-saver";
      btn.classList.toggle("active", isSaver === costSaverMode);
    });
    fetch("/api/chat/spend", {
      method: "POST",
      headers: { "content-type": "application/json", "x-jarvis-chat": "1" },
      body: JSON.stringify({ costSaver: costSaverMode })
    }).catch(() => {});
    updateDashboardSlice(currentRange);
    showToast(
      costSaverMode
        ? "Cost-Saver Engine active (default) · 90% off cached Argon 4 input, 0% quality loss"
        : "Reverted to Legacy Uncached Engine · full prompt & history billed every turn"
    );
  }

  document.querySelectorAll("[data-engine-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      setCostSaverEngine(btn.getAttribute("data-engine-mode") === "cost-saver");
    });
  });

  const btnUseCostSaver = document.getElementById("btn-use-cost-saver");
  if (btnUseCostSaver) {
    btnUseCostSaver.addEventListener("click", () => setCostSaverEngine(true));
  }
  const btnRevertLegacy = document.getElementById("btn-revert-legacy");
  if (btnRevertLegacy) {
    btnRevertLegacy.addEventListener("click", () => setCostSaverEngine(false));
  }
  const sbsCardSaver = document.getElementById("sbs-card-saver");
  if (sbsCardSaver) {
    sbsCardSaver.addEventListener("click", () => setCostSaverEngine(true));
  }
  const sbsCardLegacy = document.getElementById("sbs-card-legacy");
  if (sbsCardLegacy) {
    sbsCardLegacy.addEventListener("click", () => setCostSaverEngine(false));
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
      renderSavingsView();
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
    { group: "Views", label: "04 · Cost-Saver vs. Would-Have-Cost Side-by-Side", meta: "View 04", run: () => switchView("savings") },
    { group: "Engine", label: "Use Cost-Saver Engine (Default · 0% Quality Loss)", meta: "Default", run: () => setCostSaverEngine(true) },
    { group: "Engine", label: "Revert to Previous Legacy Uncached Engine", meta: "Legacy", run: () => setCostSaverEngine(false) },
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
  renderSavingsView();
})();
