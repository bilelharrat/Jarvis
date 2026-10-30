const SCENARIOS = {
  code: {
    title: "Vertex AI KV Cache & Provenance",
    priorUser: "We enabled rolling history checkpoints on Gemini 4 Argon, but follow-up turns still report 0 cached tokens on some requests.",
    priorAttach: ["askeden/src/chat/provenance.ts", "askeden/src/chat/stream.ts"],
    priorAssistant: "I inspected the request payload sent to Vertex AI. Ready to trace why token 0 of the prefix changes between Turn 1 and Turn 2.",
    prompt: "Why is our follow-up turn busting the Vertex AI prompt cache even when the system prompt looks identical?",
    attach: ["provenance.ts:34", "turn.ts:334"],
    model: "Gemini 4 Argon · High",
    estCost: "~$0.0018",
    finalCost: "$0.0016",
    savedLabel: "KV Cache Hit · 90% saved ($0.0142)",
    groundingChip: "Read 2 files · provenance.ts, stream.ts",
    thoughtHeadings: [
      "Selecting optimal model via Eden Router…",
      "Locking deterministic boundary & matching KV cache…",
      "Reading provenance.ts & stream.ts…",
      "Found root cause: randomHex(12) mutates token 0 every turn",
      "Designed per-conversation salted boundary + dynamic tail split"
    ],
    thoughts: [
      "1. Checking what goes into systemInstruction on Turn 1 vs Turn 2: in turn.ts, systemPrompt starts with the provenance notice from createLedger().",
      "2. Found it — createLedger() calls newBoundary(), which runs randomHex(12) on every HTTP request! Because the boundary sits at token 0 of systemPrompt, mutating those 24 hex chars invalidates 100% of the provider's prefix KV cache.",
      "3. Also checking rolling history checkpoints in stream.ts: exactContext and premiseNote get appended to systemInstruction per turn, changing the cached key.",
      "4. Fix: derive a deterministic per-conversation boundary seeded by a CSPRNG process salt + messages[0], and move per-turn dynamic notes to contents[cutoff]."
    ],
    answerPreview: "Two things were busting your prefix KV cache on follow-up turns:\n\n1. **Per-request random provenance boundaries (`newBoundary()`)** — `createLedger()` injected a fresh 24-hex random string into token 0 of `systemPrompt` on every turn.\n2. **Per-turn dynamic notes inside `systemInstruction`** — `exactContext` and `premiseNote` were appended to the system prompt instead of the live uncached tail turn.",
    codeFile: "askeden/src/chat/provenance.ts",
    codeSnippet: "export function stableBoundary(seed: string): string {\n  processBoundarySalt ??= randomHex(16);\n  return hashSalted(processBoundarySalt, seed); // byte-identical across turns\n}",
    evesLabel: "Checked against provenance.ts & stream.ts"
  },
  search: {
    title: "Anthropic vs Vertex Cache Breakpoints",
    priorUser: "How should we structure multi-turn caching across both Claude Sonnet 5.5 and Gemini 4 Argon?",
    priorAttach: ["askeden/src/chat/stream.ts"],
    priorAssistant: "Let's compare how Anthropic's ephemeral breakpoints and Vertex AI's cachedContents handles pin conversation prefixes.",
    prompt: "Compare Anthropic's multi-breakpoint ephemeral caching with Gemini 4 Argon's explicit cachedContents TTL.",
    attach: ["stream.ts:144", "providers.ts:42"],
    model: "Gemini 4 Argon · High",
    estCost: "~$0.0021",
    finalCost: "$0.0019",
    savedLabel: "KV Cache Hit · 90% saved ($0.0168)",
    groundingChip: "Searched 4 web sources · Google & Anthropic docs",
    thoughtHeadings: [
      "Selecting optimal model via Eden Router…",
      "Matching conversation memory & KV checkpoint…",
      "Searching Vertex AI & Anthropic caching specs…",
      "Comparing 3-breakpoint sliding window vs explicit 1h TTL…",
      "Verified 90% cached input discount across both providers"
    ],
    thoughts: [
      "1. Checking Anthropic's ephemeral cache_control: allows up to 4 breakpoints per request (1 on system, up to 3 on messages). Placing breakpoints on lastIdx and lastIdx - 2 guarantees Turn N hits Turn N-1.",
      "2. Checking Gemini 4 Argon on Vertex AI: supports both implicit prefix caching and explicit cachedContents handles with a 1-hour sliding TTL.",
      "3. Both discount cached input reads by 90% (0.10x input rate) with zero quantization or attention pruning.",
      "4. Structuring side-by-side summary of breakpoint stride and cost accounting."
    ],
    answerPreview: "Both **Anthropic `cache_control`** and **Gemini `cachedContents`** deliver **90% off cached input tokens** with **0.0% quality loss** (exact KV state reuse), pinned via:",
    codeFile: "askeden/src/chat/stream.ts",
    codeSnippet: "// Anthropic: 3 sliding message breakpoints (lastIdx, lastIdx - 2, stride-4)\n// Gemini: rolling cachedContents checkpoint every 4 turns + implicit prefix",
    evesLabel: "4/4 claims grounded in provider docs"
  },
  math: {
    title: "12-Turn Monthly GCP Credit Forecast",
    priorUser: "We want to verify the exact monthly GCP savings before locking Cost-Saver as default.",
    priorAttach: ["exact.ts"],
    priorAssistant: "Send over your daily token volume and average turn depth and I'll compute it through the exact math ledger.",
    prompt: "If our team sends 4.2M input tokens/day across 12-turn coding chats on Gemini 4 Argon, what is our exact monthly spend before and after Cost-Saver?",
    attach: ["exact-ledger.ts"],
    model: "Gemini 4 Argon · High",
    estCost: "~$0.0014",
    finalCost: "$0.0012",
    savedLabel: "Exact Math Ledger · 0 drift",
    groundingChip: "Exact Math Computed · 4 expressions verified",
    thoughtHeadings: [
      "Selecting optimal model via Eden Router…",
      "Computing exact arithmetic ledger in turn.ts…",
      "Applying 84% cached input ratio at 0.10x rate…",
      "Verifying 126M monthly tokens × $2.00/M vs $0.20/M cached…",
      "Verified $190.51/mo net savings (75.6% reduction)"
    ],
    thoughts: [
      "1. Daily input volume: 4,200,000 tokens/day × 30 days = 126,000,000 input tokens/month.",
      "2. At Gemini 4 Argon's standard input rate ($2.00 / 1M tokens), uncached input spend is 126 × $2.00 = $252.00/month.",
      "3. In a 12-turn conversation with stable boundaries and 4-turn rolling checkpoints, 84% of input tokens are served from KV cache at $0.20 / 1M tokens (90% off).",
      "4. Cached spend: (105.84M × $0.20) + (20.16M × $2.00) = $21.17 + $40.32 = $61.49/month — saving $190.51/month (75.6% net input reduction)."
    ],
    answerPreview: "For **4.2M input tokens/day** (126M tokens/month) on **Gemini 4 Argon**:\n\n1. **Legacy Uncached Input Cost:** `$252.00 / month` (`126M × $2.00/M`)\n2. **Cost-Saver Cached Input Cost:** `$61.49 / month` (`105.84M cached × $0.20/M` + `20.16M live × $2.00/M`)\n3. **Exact Monthly Savings:** **`$190.51 / month` (75.6% saved)** with 0.0% quality change.",
    codeFile: "exact-math-ledger.txt",
    codeSnippet: "Uncached:   126.00M tok × $2.00/M = $252.00/mo\nCost-Saver: 105.84M × $0.20/M + 20.16M × $2.00/M = $61.49/mo (-75.6%)",
    evesLabel: "Exact arithmetic ledger matched 4/4 numbers"
  }
};

let currentScenario = "code";
let currentStage = 3; // Default Stage 4 (04 · Thinking LIVE Auto-Open)
let forceOpenAfterTuck = false;
let playTimer = null;

function formatInlineMd(str) {
  return str
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code style="font-family:var(--font-mono);background:var(--glass-code);padding:1.5px 5px;border-radius:5px;font-size:11.5px;border:1px solid var(--border-subtle);">$1</code>')
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n(\d+)\. /g, "<br>$1. ");
}

function renderChat() {
  const sc = SCENARIOS[currentScenario];
  const isThinkingStage = currentStage === 3;
  const isAnswerOrDone = currentStage >= 4;
  const isDone = currentStage === 5;
  const isTucked = isAnswerOrDone && !forceOpenAfterTuck;

  document.getElementById("headerChatTitle").textContent = sc.title;
  document.getElementById("headerModelBadge").textContent = `✦ ${sc.model}`;
  document.getElementById("headerSavedBadge").textContent = `⚡ ${sc.savedLabel}`;

  // Update stage pills in top bar
  document.querySelectorAll("[data-stage]").forEach((btn) => {
    const st = Number(btn.getAttribute("data-stage"));
    btn.classList.toggle("active", st === currentStage);
    btn.classList.toggle("done", st < currentStage);
  });

  // Show/hide Steer pill in Eden Code composer while streaming
  const steerBtn = document.getElementById("jc-steer");
  if (steerBtn) {
    steerBtn.style.display = currentStage < 5 ? "inline-flex" : "none";
  }

  const thoughts = currentStage === 3 ? sc.thoughts.slice(0, 3) : sc.thoughts;
  const activeHeadline = sc.thoughtHeadings[Math.min(currentStage, sc.thoughtHeadings.length - 1)];

  const html = `
    <!-- Prior Turn User Bubble (Eden Code Glass Input Bubble style) -->
    <div class="msg-user" style="opacity:0.82;">
      <div class="attach-row">
        ${sc.priorAttach.map((a) => `<span class="attach-chip">📄 ${a}</span>`).join("")}
      </div>
      <div>${sc.priorUser}</div>
    </div>

    <!-- Prior Turn Assistant Brief Bubble -->
    <div class="msg-assistant" style="opacity:0.82;">
      <div class="assistant-glass-bubble" style="padding:10px 13px;">
        <div class="reply-md"><p>${sc.priorAssistant}</p></div>
      </div>
    </div>

    <!-- Active Turn User Bubble (Exact Eden Code Input Bubble with file chips) -->
    <div class="msg-user">
      <div class="attach-row">
        ${sc.attach.map((a) => `<span class="attach-chip">⌘ ${a}</span>`).join("")}
      </div>
      <div>${sc.prompt}</div>
    </div>

    <!-- Active Turn Assistant Message (Option A Live Progress in Liquid Glass) -->
    <div class="msg-assistant">
      <div class="route-row">
        <span class="glass-route-chip">
          <span class="pdot"></span>
          <span>${sc.model}</span>
          <span class="chip-cost">${isDone ? sc.finalCost : sc.estCost}</span>
        </span>
        ${currentStage >= 1 ? `<span class="saved-pill">⚡ ${sc.savedLabel}</span>` : ""}
        <span class="branch-pill" style="color:var(--ink-2);">0 clicks needed · Option A</span>
      </div>

      <div class="assistant-glass-bubble">
        <!-- Option A: Above-the-fold Glass Stage Rail -->
        <div class="stage-rail">
          <span class="rail-pill done">
            <span class="rp-ic">✓</span> Routed · 18ms
          </span>
          <span class="rail-pill ${currentStage >= 1 ? 'done' : 'live'}">
            <span class="rp-ic">${currentStage >= 1 ? '✓' : '●'}</span> KV Cache ${currentStage >= 1 ? '(-90%)' : 'matching…'}
          </span>
          ${currentStage >= 2 ? `
            <span class="rail-pill ${currentStage >= 3 ? 'done' : 'live'}">
              <span class="rp-ic">${currentStage >= 3 ? '✓' : '●'}</span> ${sc.groundingChip}
            </span>
          ` : ""}
          ${currentStage >= 3 ? `
            <span class="rail-pill ${currentStage >= 4 ? 'done' : 'live'}">
              <span class="rp-ic">${currentStage >= 4 ? '✓' : '●'}</span> ${currentStage === 3 ? 'Reasoning live · 3.8s' : 'Reasoned · 4.2s'}
            </span>
          ` : ""}
        </div>

        <!-- Option A: Auto-Open Liquid Glass Reasoning Window (tucks on Stage 5/6) -->
        ${currentStage >= 3 ? `
          <div class="auto-think-glass ${isTucked ? 'tucked' : ''} ${forceOpenAfterTuck ? 'force-open' : ''}">
            <div class="ath-head" id="optionAThinkHead" title="Automatically open while thinking; tucks when answer streams (click to toggle)">
              <div class="ath-left">
                <span class="ath-spark">✦</span>
                <span class="ath-status">${isThinkingStage ? 'Thinking live · 3.8s' : 'Thought for 4.2s'}</span>
                <span style="color:var(--ink-3);flex-shrink:0;">—</span>
                <span class="ath-summary">${activeHeadline}</span>
              </div>
              <div class="ath-right">
                <span>${isThinkingStage ? '312 tok · auto-open' : '4 steps'}</span>
                <span>${isTucked ? 'Show trace ›' : '▾'}</span>
              </div>
            </div>
            <div class="ath-viewport">
              ${thoughts.map((t, idx) => `
                <div style="margin-bottom:6px; ${idx === thoughts.length - 1 ? 'color:var(--ink-1);font-weight:500;' : ''}">
                  ${t}${isThinkingStage && idx === thoughts.length - 1 ? '<span class="stream-cursor"></span>' : ''}
                </div>
              `).join("")}
            </div>
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-2);padding:4px 2px;">
            <span class="status-dot cyan"></span>
            <span>${activeHeadline}</span>
          </div>
        `}

        <!-- Streaming / Completed Answer (Stages 5 & 6) -->
        ${isAnswerOrDone ? `
          <div class="reply-md">
            <p>${formatInlineMd(sc.answerPreview)}</p>
            <div class="glass-code-card">
              <div class="code-head">
                <span>${sc.codeFile}</span>
                <span style="color:var(--accent);">✓ KV Prefix Safe</span>
              </div>
              <pre class="code-body">${sc.codeSnippet}</pre>
            </div>
            ${currentStage === 4 ? '<span class="stream-cursor"></span>' : ''}
          </div>
        ` : ""}

        <!-- EVES Glass Pill (Stage 6) -->
        ${isDone ? `
          <div class="eves-glass-pill">
            <span class="eves-orb">✓</span>
            <span style="font-weight:700;letter-spacing:0.06em;">EVES</span>
            <span style="opacity:0.35;">|</span>
            <span style="color:var(--ink-2);">${sc.evesLabel}</span>
          </div>
        ` : ""}
      </div>
    </div>
  `;

  const container = document.getElementById("chatTranscript");
  container.innerHTML = html;

  const head = document.getElementById("optionAThinkHead");
  if (head) {
    head.addEventListener("click", () => {
      if (currentStage >= 4) {
        forceOpenAfterTuck = !forceOpenAfterTuck;
        renderChat();
      }
    });
  }
}

// Sidebar chat selector clicks
document.querySelectorAll(".session-card").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".session-card").forEach((c) => c.classList.remove("active"));
    card.classList.add("active");
    currentScenario = card.getAttribute("data-scenario") || "code";
    forceOpenAfterTuck = false;
    renderChat();
  });
});

// Stage scrubber clicks
document.querySelectorAll("[data-stage]").forEach((btn) => {
  btn.addEventListener("click", () => {
    stopPlayback();
    currentStage = Number(btn.getAttribute("data-stage"));
    forceOpenAfterTuck = false;
    renderChat();
  });
});

// Theme toggle
document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-theme-btn]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.documentElement.setAttribute("data-theme", btn.getAttribute("data-theme-btn"));
  });
});

// Composer orb drawer toggle
const orbBtn = document.getElementById("jc-orb");
const composerForm = document.getElementById("deck-composer");
if (orbBtn && composerForm) {
  orbBtn.addEventListener("click", () => {
    composerForm.classList.toggle("expanded");
  });
}

function stopPlayback() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
  document.getElementById("playIcon").textContent = "▶";
  document.getElementById("playLabel").textContent = "Simulate Live Turn";
}

document.getElementById("playBtn").addEventListener("click", () => {
  if (playTimer) {
    stopPlayback();
    return;
  }
  currentStage = 0;
  forceOpenAfterTuck = false;
  renderChat();
  document.getElementById("playIcon").textContent = "⏸";
  document.getElementById("playLabel").textContent = "Playing Turn…";
  playTimer = setInterval(() => {
    if (currentStage < 5) {
      currentStage++;
      renderChat();
    } else {
      stopPlayback();
    }
  }, 1400);
});

renderChat();
