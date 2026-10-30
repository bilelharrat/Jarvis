# Eden Code: the trust layer (plan, 2026-10-28)

**Why:** the loudest developer complaint of 2026 is not "AI can't code", it is **"I'm shipping AI code I don't understand, and the
AI wrote the tests too, with the same blind spots"** (Hacker News, October 2026: 626 points, 766 comments). Invented APIs and
look-alike packages are the coding version of hallucinations, the company's founding fight. Eden Code becomes **the coding agent
you can trust**: every change gets a second opinion from another company's model, tests prove they can catch bugs, nothing invented
runs, and you understand every change before you merge it.

**Ships in the Eden Code Mac/Windows app**, not askeden.com, so the askeden.com deploy freeze does not block it. Runs alongside the
production plan (`eden-code-production-plan.md`): its spending caps (Phase 2) and security gate (Phase 1) apply; this plan does not
duplicate them, it builds on them.

Tagline: **Eden Code. Code you can trust.**

---

## 1. What already exists (src/jarvis/features, web/features)
| Piece | File | Use |
|---|---|---|
| Review and Deep review on a session's changes, findings pinned to lines, "Fix this" / "Fix all" | `code_review.py`, `code_review.js` | the reviewer's surface |
| Checks after each turn: dev server, Tests pane, Problems pane | `code_verify.py`, `code-verify.js` | where test-integrity results show |
| Best of N: two or three models in isolated copies, side by side, "Keep this one" | `code_bestof.py`, `code_bestof.js` | isolated copies for mutation runs |
| Model Router in the composer | `code_router.py`, `code-router.js` | picking the independent reviewer |
| Usage meter and spending caps per session, project, day | `code_usage.py`, `code-usage.js` | the hard stop (production plan P2) |
| EVES verification library | `askeden/src/verify/` (claims, checks, evidence, inspector) | the "no invented APIs" checker |

New: automatic cross-provider review, test-integrity (mutation) checks, the API/package reality check, "Understand this change",
the trust summary on every change, and the hard stop.

## 2. The five features

### 2.1 Second opinion from another company's model
- After every turn that changes code (on by default, switch in Settings › Trust), the changes go to a reviewer **from a different
  provider than the writer** (Claude wrote it → GPT or Gemini reviews; picked by the Router for review quality at the chosen cost).
- The reviewer sees the diff, the request, the plan and the test results, and returns findings with severity, line and evidence.
  Findings land in the existing Review UI with "Fix this".
- Disagreement is the signal: when writer and reviewer disagree on a high-severity point, it is shown first and blocks "Ready to
  merge" until you answer.
- Cost is shown and counted against the session cap; a cheap first pass, a deep pass only on risky diffs (auth, money, data
  deletion, migrations, concurrency, security-sensitive files).

### 2.2 Tests that prove themselves (mutation checks)
- In an isolated copy (best-of-N's machinery), Eden Code makes small deliberate breaks in the changed code (flip a condition, drop a
  line, change a boundary, return early) and runs the relevant tests. A test that still passes when the code is broken is **flagged**.
- Each change gets a **test strength** score: share of breaks caught, with the surviving breaks listed ("nothing tests the empty-list
  case on line 42").
- Tests written in the same turn as the code are marked "written by the same model" and get a stricter check; the second-opinion
  reviewer is asked to write one independent test for the riskiest path.
- Uses the project's own test runner; fast mode (the changed functions only), capped in time and cost.

### 2.3 No invented APIs or packages
- Before a command runs or a change is accepted, every new import, package, function call, CLI flag and config key that the agent
  introduced is checked against reality: the package registry (npm, PyPI, crates, Go, Maven), the installed version's real exports
  (by introspection or type definitions), and the official docs (EVES evidence path) for the version in the lockfile.
- Unknown package names, typo-squats and look-alikes of popular packages are **blocked** before install, with the likely intended
  package suggested. A function or flag that doesn't exist in the installed version is flagged with the real signature.
- Works offline for installed packages; registry and docs checks are cached.

### 2.4 Understand this change
- A plain-language walkthrough before merge: what changed and why, in order of importance; what could break; what was not tested;
  decisions the agent made on your behalf; and three questions to check you understood (optional, for learners and reviewers).
- Linked to the diff hunk by hunk; exportable into the pull-request description.

### 2.5 Hard stop
- The production plan's spending caps become a **hard stop**: at the cap the agent stops cold (no new tool calls, no new model
  calls), saves its state and asks. No silent overage, no "one more turn". Runaway loops (same command failing N times, the same
  file rewritten N times) also stop and ask.

### The trust summary
Every change shows one line: **"Reviewed by GPT-6.1 Sol · tests caught 9/10 breaks · 0 invented APIs · 2 decisions to confirm"**,
expanding into the details. That line is the product.

## 3. Measuring it (the bar, before anything ships)
A **trust test set** in `tests/trust/`: 60 real tasks on sample projects with known planted problems (subtle logic bugs, missing edge
cases, weak tests that pass anyway, invented functions, typo-squat packages, insecure patterns).
| Measure | Target |
|---|---|
| Planted bugs found by the second opinion (and not by the writer alone) | 70% or more |
| Weak tests caught by mutation checks | 80% or more |
| Invented APIs / bad packages blocked | 100% of planted cases, 0 false blocks on real packages in a 500-package check |
| False alarms per 100 changes (findings a human reviewer rejects) | under 10 |
| Extra time per change (p50) | under 60 s in fast mode |
| Extra cost per change (p50) | under $0.05 |
Results published honestly with their limits on askedencode.com, like the EVES page.

## 4. Timetable (aggressive: in the app in 2 weeks)
| Days | Dates | Build | Gate / owner |
|---|---|---|---|
| 1-2 | Wed 28 to Thu 29 Oct | Trust test set (tasks + planted problems); registry/API checker (2.3) with its 500-package false-block check | Approve plan |
| 1-3 | to Fri 30 Oct | Cross-provider second opinion (2.1) wired into the existing Review UI; disagreement-first; cost counted | Provider keys for the reviewer models in the app's settings |
| 3-5 | Fri 30 Oct to Sun 1 Nov | Mutation checks in isolated copies (2.2), test strength score, same-model tests flag | |
| 4-6 | Sat 31 Oct to Mon 2 Nov | Understand this change (2.4); hard stop (2.5, with the production session) | |
| 7 | Tue 3 Nov | **First full run of the trust test set**; fix the misses | Read the numbers |
| 8-10 | Wed 4 to Fri 6 Nov | Trust summary line; Settings › Trust; tuning against false alarms; accessibility (screen reader reads the summary) | |
| 11 | Sat 7 Nov | Signed build installed on the owner's Mac (production plan's build path), real projects for two days | Owner tries it on real work |
| 13-14 | Mon 9 to Tue 10 Nov | **In the app** (beta switch on by default for new sessions) if the trust set meets the bar and the owner signs off; results page on askedencode.com | Release yes / no |

## 5. Rules
- A finding never edits code by itself: "Fix this" hands it back to the session as usual.
- Mutation runs only in isolated copies; never in the user's working tree; temporary copies deleted.
- Registry and docs lookups send package names and versions only, never source code.
- Reviewer models get only the diff and context the user's settings allow; local-only projects use local or user-key models only.
- If a check can't run (no tests, offline, no keys), the summary says so plainly instead of implying a pass.
- The EVES ship rule (beat the best single model + search) applies to EVES answer changes; this plan's checks have their own bar
  (section 3) and don't change EVES.

## 6. Owner checklist
| By | What |
|---|---|
| Wed 28 Oct | Approve this plan |
| Thu 29 Oct | Reviewer model keys available in Eden Code (GPT and Gemini through the user's keys or Eden's included AI) |
| Tue 3 Nov | Read the first trust-set numbers |
| Sat 7 Nov | Use the signed build on real projects for two days |
| Tue 10 Nov | Ship yes / no |
