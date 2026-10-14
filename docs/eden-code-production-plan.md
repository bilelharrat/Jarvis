# Eden Code: production plan (2026-10-13)

Goal: fix every problem the 2026-10-13 audit found, then add what the agentic-coding startups (Orca, Conductor,
Factory, Amp, Augment, Kiro, Tembo, Sculptor, Vibe Kanban, CodeRabbit, Graphite…) have that Eden Code lacks, and
ship it as a signed build that passes the owner's 3-round sweep → break → fix.

Source: 8 read-only audit agents + 1 startup research agent, 2026-10-13. Every item was found by reading the code;
file paths are under `src/jarvis/` unless they start with `app/`, `tests/` or a repo name. Sizes: S = under 30 min,
M = 1-3 h, L = most of a day (one agent, with tests).

## Ground rules

- **Branch:** all work on `eden-code-hardening` in its own git worktree, never the shared working tree (other
  sessions edit `JARVIS V1` uncommitted). Merge per phase, after its tests pass.
- **App Review freeze:** the iPhone app 1.0 (2) is in App Review and loads askeden.com live. Items marked **[site]**
  touch askeden.com; they wait on the branch until Apple approves, unless tiny and fully tested.
- **Every fix gets a test** that fails before and passes after. Phase gate: full `uv run pytest`, the
  `tests/web/*.test.mjs` suite (Node 22), and a run of the real Eden Code app.
- **Never** run tests against the real HOME, the 5174 server, or the owner's Keychain (fixed first, in phase 0).
- Builds are signed only as bilel.harrat@icloud.com (team 8CV4X23Y2T).

---

## Phase 0: safe ground (S, do first)

| ID | Problem | Where | Fix |
|---|---|---|---|
| P0-1 | Terminal tests write into the owner's real `~/.zsh_history` (325 junk lines so far) | `tests/test_code_terminals.py:66, 206` | autouse fixture in `tests/conftest.py`: `HISTFILE`, `ZDOTDIR`, `HOME` → `tmp_path`; then remove the junk lines from `~/.zsh_history` (they all start `echo SHELL_ONE_`/`REPLAY_ME`…; owner confirms first) |
| P0-2 | A test runs the real `claude` CLI, which rewrites `~/.claude.json` and reads the Keychain sign-in | `tests/test_code_hostile_commands.py` (`cw_health` → `features/code_health.py`) | stub the health probe in conftest |
| P0-3 | Flaky test | `tests/test_code_verify.py::test_the_problems_pane_runs_the_projects_checkers_and_sends_them` (line 309) | find the timing / HOME dependency, make it deterministic |
| P0-4 | No timeouts on the test suite | dev deps | add `pytest-timeout`, default 120 s |
| P0-5 | `app/package.json` has no JS test script; system Node 20 crashes on the suite | `app/package.json` | `npm test` → Node 22 `node --test tests/web/*.test.mjs` |

---

## Phase 1: critical security (do before any public release)

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| S1 | **Critical** | Any session can read every secret Eden keeps in the Keychain. The `apiKeyHelper` command (Jarvis's Python + service/account) is visible in `ps`; the Keychain trusts that interpreter, so re-running it prints the Anthropic key, the Eden Plus token, and every saved code secret | `providers.py:287-300, 644-650`; `claude_signin.py:46-56, 149`; `features/code_secrets.py:125-146`; `secret_run.py:12` | Sessions never get a Keychain reader. Model keys: `ANTHROPIC_BASE_URL` → a loopback proxy in the backend that adds the key, with a one-time token per run. `secret_run`: values handed over an inherited pipe with a one-time nonce | M |
| S2 | High | `start_session_in_cloud` (assistant tool) starts a cloud session with no card; an email or web page can copy any local repo to the cloud and run attacker instructions | `features/code_cloud.py:246-271, 135`; `features/code_handoff.py:379`; `brain.py:114-128, 731-735` | Tool goes through a card (or `TURN_GATED`); `preapproved` only for the composer's own Cloud switch; project must be one the owner already uses | S |
| S3 | High | Git hooks run attacker code outside the sandbox: an issue run edits `.pre-commit-config.yaml`/lint-staged/lefthook (allowed in edits mode), then Eden's own `git commit` runs the hook as the owner | `worktrees.py:485, 588`; `features/code_pr.py:638, 987-1018`; `features/code_handoff.py:487`; protected list `tasks.py:74-75` | Every Eden-made commit/merge with `-c core.hooksPath=/dev/null`; add `.pre-commit-config.yaml`, `lefthook.yml`, `.lintstagedrc*`, `.husky*`, `simple-git-hooks` and `package.json` hook keys to the protected list | S |
| S4 | High | Any session can push instructions into another session; a Manual session that read a hostile page can drive a Bypass session | `codepeers.py:72, 191` | Remove `message_session` from `allowed_tools` (follows the sender's mode); always card when the target is in Bypass/Auto or the sender read untrusted content | S |
| S5 | High | Work brought back from the cloud can run code on the Mac: a hijacked remote commits `.claude/settings.json` hooks / `.mcp.json` / `CLAUDE.md`, which run at the next local message; the remote's last reply is injected into the next turn | `features/code_handoff.py:1185-1231`; `tasks.py:2206` | Diff `base..ref` for `.claude/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.envrc`, `.gitattributes`, `.githooks`, hook configs; show them on the bring-back card or leave unmerged; mark the carried reply as untrusted data | M |
| S6 | High | Eden window + main window have no permission handler, so Electron grants mic, camera, location silently to askeden.com, any `*.askeden.com`, sign-in pages, or whatever answers on :5174; iframes can open custom URL schemes; the first client certificate is sent to anyone | `app/features/eden-window.js:144`; default session; compare `app/browser-parity.js:206, 342` | Deny-by-default request + check handlers on both sessions (mic only for exact `https://askeden.com`, behind a prompt); deny external schemes from frames; handle `select-client-certificate` | S |
| S7 | Med-High | Electron fuses never flipped: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, inspector all on; no asar integrity. Malware runs as the signed Eden with all its TCC permissions, or edits `app.asar` | `app/package.json` `package`; `app/scripts/release/dist.js:~180-200` | `@electron/fuses` `flipFuses` before signing (RunAsNode, NodeOptions, NodeCliInspect off; asar integrity + only-load-from-asar on; GrantFileProtocolExtraPrivileges off), Mac and Windows | S |
| S8 | Med-High | Windows updater runs the installer silently after checking only its size (from the same `latest.json`) | `app/win-update.js:37-50, 107-140, 168` | Ed25519-signed `latest.json` with SHA-256 (public key built into the app); check Authenticode publisher; download into the app's data folder, not Downloads | M |
| S9 | Medium | Voice can switch a session to Bypass without the owner's voice ("Eden, full auto and delete…" from a video) | `hub.py:4332, 4347`; `voicecode.py:331, 826-830`; `features/voice_id.py:7` | Mode intents use `_voice_allows(risky=True)`; Bypass by voice needs a tap or Touch ID | S |
| S10 | Medium **[site]** | "Never Bypass from the web" is bypassed with `allowTools: ["Bash"]` / `acceptEdits` | `eden_link.py:616-626`; `askeden/src/chat/code.ts:286-292, 318`; `guard.ts` | `_check` strips non-read-only `allowTools` and refuses `acceptEdits` from the web unless approved on the Mac (Mac-side fix ships without a site deploy) | S |
| S11 | Medium | Phone link: Face ID is checked only by the iPhone app; the device token alone runs `bash`, `mode auto`, `push`, `pr_merge` | `companion_code.py:14-16, 53-66`; `remote.py:381-387` | Secure Enclave key registered at pairing; Mac sends a challenge, phone signs after Face ID, Mac verifies, for risky actions | M (+ iOS app change) |
| S12 | Medium | Secret masking is exact-match only: base64, `rev`, slices, `xxd`, `curl -v -u` print the value | `secret_run.py:43-70`; `features/code_secrets.py:557, 572-592` | Any command that uses a secret asks on a card in every mode; scrub base64/hex/URL-encoded/reversed forms and ≥8-char fragments | M |
| S13 | Medium | Any `*.askeden.com` page in the Eden window controls the signed-in built-in browser and gets every tab's URL and title | `app/features/eden-window.js:128-133, 167, 189-205`; `app/main.js:572-573` | Exact origin `https://askeden.com` (or the local origin) only; strip other tabs' URLs/titles from the state sent | S |
| S14 | Medium | Issue runs start without checking who added the label (issue templates / auto-labelers let anyone start one) | `features/code_issues.py:332-373` | Check the actor's repo permission (triage+) via the collaborator-permission API; refuse bots unless allow-listed | S |
| S15 | Medium | "Trusted" review comments include org members and read-only collaborators; they reach sessions in Bypass and auto-commit | `features/code_pr.py:92, 1060, 1077, 1102` | Check real write permission; never auto-send to Bypass/Auto sessions | S |
| S16 | Medium | ACP (Codex/Gemini/OpenCode) permission checks fail open: no path → project root → auto-allowed; only `locations[0]` checked; picks `allow_always` | `acp.py:285-301, 665` | No path → ask; check every location; never pick `allow_always` | S |
| S17 | Medium | `/away` moves untrusted issue runs to the cloud, where they lose lock-down, sandbox, spending and time caps | `features/code_cloud.py:142-164` | Skip runs marked untrusted, or name them on the card | S |
| S18 | Medium | The router can turn Auto back on after the owner chose Manual | `features/code_router.py:424-435`; `tasks.py:1525` | Owner's `task_mode` clears `auto_held`; restore Auto only if the mode is exactly what the router set | S |
| S19 | Medium | Automatic fallback sends the whole session (code + transcript) to a different provider without asking | `features/code_router.py:461-498` | Auto-fallback only within the same provider; crossing providers asks on a card or needs a separate opt-in | S |
| S20 | Med-Low | Commands in an issue run's scope run code the agent just changed; prefix matching accepts flags (`git diff --output=…`) | `features/code_unattended.py:828-849` | Sandbox-off is its own strong confirmation; exact flag matching for git entries | S |
| S21 | Low | `.jarvis/launch.json` unprotected; dev-server card hides `env` (`NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`); window's start button runs a cloned repo's launch.json with no card | `tasks.py:74`; `features/code_verify.py:260, 936-941` | Protect `.jarvis/`; show `env` on the card; card on first start of a repo's config | S |
| S22 | Low | GitHub text not escaped inside its data tags (`</issue>` + fake app note) | `code_prs.py` `issue_prompt`, `review_message`, `fix_message` | Escape `<`/`>` in bodies or use a random per-message tag | S |
| S23 | Low | Importing rules trusts a cloned repo's allow rules (e.g. `Bash(curl:*)`) | `features/code_rules.py:177-205` | List the allow rules on a card before importing | S |
| S24 | Low | Sandbox "github" preset allows github.com + githubusercontent: an exfiltration route | `codesandbox.py:31` | Say so in the pane; suggest repo-scoped tokens | S |
| S25 | Low | Model Router page server accepts any localhost origin (spends the Gemini ratings) | `Model Router/src/ui/server.ts:54, 89-101` | Pin origin to :5174 or require a per-launch token | S |
| S26 | Low | Model Router Node server gets the backend's whole environment (every Keychain key if started via `with-keys.sh`) | `features/code_router.py:589` | Minimal env: PATH, HOME, Gemini vars | S |
| S27 | Low | Remote git args can be read as options (`--upload-pack=…`); hand-off summary not secret-scanned | `features/code_handoff.py:577-579`; `handoff.py:376, 383, 487-525`; scan at `code_handoff.py:417` | `--` before URLs, reject leading `-`; secret-scan the summary | S |
| S28 | Low | Anything on localhost:5174 is treated as Eden (gets #S6/#S13 powers) | `app/features/eden-window.js:26, 42-49, 224-229` | Secret handshake (token file / backend port + token) | S |
| S29 | Low | Agent `read` works on `file://` tabs; the window's nav channel always counts as "typed" | `app/main.js:1416-1422, 1541`; `app/browser-parity.js:962` | Only the real address bar is "typed"; refuse agent read/snapshot on `file:` pages the user didn't open | S |
| S30 | Low | Touch ID checked only in the window, never by the backend | `app/features/touchid.js:52-53`; `features/code_touchid.py` | Main process gives the backend a one-time signed proof after `promptTouchID` | S |
| S31 | Low | "Needs your OK" before a risky click trusts the page's own labels | `app/main.js:1424-1428` | Also check form action, payment-form signs and URL in the main process | S |
| S32 | Low | Three IPC channels don't check the sender | `app/main.js:484, 489, 1657` | Add `fromWindow` | S |
| S33 | Low | Phone plain-HTTP option sends tokens and pairing codes in cleartext | `remote.py:84` | Allow only on loopback and Tailscale addresses | S |
| S34 | Low | Launch token written to `backend.log` (173 times; file is 0644) | `server.py:521`; `app/backend-launch.js:112` | Print the port only; open the log 0600 | S |
| S35 | Low | Share-safe export misses `Authorization: Bearer`, cookies, short passwords | `code_export.py:160-199`; `secret_scan.py:69-75` | Add header/cookie patterns; lower the minimum length for secret-named keys | S |

**Gate:** an independent security review (owner's launch gate) after this phase, before any public launch.

---

## Phase 2: lost work and lost money

### Spending caps

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| W1 | High | Parallel sessions each get the whole remaining day/project budget; a $10 cap can be spent ~3× | `features/code_usage.py:136-148, 189-204, 238-246`; `tasks.py:2795-2803` | Hand out shares of the room (remaining ÷ busy sessions, plus a reserve); on every turn end, reopen or interrupt sessions whose open budget exceeds what's left | M |
| W2 | High | A fork's (or bare resume's) first turn counts the parent's whole past cost again: can trip the day cap and stop every session | `tasks.py:1613-1633, 2862-2864`; `hub.py:6878, 4463`; `features/code_pr.py:944` | Fork starts with `cost_usd = parent.cost_usd` (inherited kept apart for display); bare resume treats the first report as the baseline | S |
| W3 | Medium | After a reconnect, a restored total below Eden's figure is counted again in full | `tasks.py:2863` | `max(0, total - before)` or first report = baseline | S |
| W4 | Medium | Midnight reset fires hours late after Mac sleep (and off by an hour at DST): sessions stay held, open connections keep yesterday's $0.01 budget | `features/code_usage.py:416-423` | Wake every ≤60 s; call `caps_changed()` when `usage.day()` changes | S |
| W5 | Low | Usage-limit wait uses one app-wide reset time (a weekly Opus limit can hold a Sonnet session for days); unlimited 30-min retries | `features/code_limit.py:122-124`; `hub.py:6181-6194` | Take the reset from this session's own rate-limit event; cap total retries | S |
| W6 | Low | ACP agent sessions are interrupted at Claude's caps | `features/code_usage.py:208-214, 248-253` | Skip `other_agent(t)` in both | S |
| W7 | Low | A fork uses the parent's session cap until its first turn | `tasks.py:1618`; `features/code_usage.py:122-124` | Key a fork as `task:{id}` while `task.fork` | S |

### Pull requests

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| W8 | Medium | With two PRs in one folder, a PR's `followup` flag sticks forever: no more auto-fix, review or conflict handling | `features/code_pr.py:759, 855, 972, 1110-1129` | Store the follow-up's task id + time on the record, match on it, expire after a few hours | S |
| W9 | Medium | Any unexpected exception during a PR poll re-polls every 10 s forever (~2,000 GitHub calls/hour, starves every other PR) | `features/code_pr.py:751-753, 769-784` | `except Exception` / `finally` sets `next_poll = now + POLL_ERROR` | S |

### Cloud hand-off

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| W10 | High | Handing a session off again silently replaces the earlier remote record; the same-machine setup throws away remote commits (`checkout -B … FETCH_HEAD`) | `features/code_handoff.py:351-353, 531`; `handoff.py:399-401` | Refuse while any un-brought-back record exists; setup refuses when the remote branch has commits the fetched one lacks (`merge-base --is-ancestor`) | S |
| W11 | High | A permission answer that fails to send leaves the remote Claude waiting forever (UI says "Working") | `features/code_handoff.py:956-964, 680, 1289` | Keep retrying with back-off, or retry pending answers on follow heartbeats | S |
| W12 | High | "I'm heading out" interrupts every session before checking the cloud machine; machine down = all work stops | `features/code_cloud.py:210-222`; `features/code_handoff.py:368, 379-389` | Check reachability and build plans (and run the secret scan) before the card; on any later failure send the session a local "carry on" | M |
| W13 | Med-High | A second hand-off to the same machine replays the old run (old messages, cards, "Waiting for you", double cost) | `handoff.py:415, 434`; `features/code_handoff.py:495-509` | Rotate/truncate `out.jsonl` on a new hand-off, or start `seen` at the current line count | S |
| W14 | Medium | A message sent to a dead remote run is lost (and wiped by the next start) | `features/code_handoff.py:1019-1026`; `handoff.py:415` | Check the run is alive in the same SSH call; if dead, start a new run with that message | S |
| W15 | Medium | One unreadable state file wipes every hand-off record | `features/code_handoff.py:211-214, 225-227`; `jsonstore.py:42-44` | Remember the failed load and refuse to save; log `OSError` | S |
| W16 | Medium | Work parked under a side ref is overwritten by the next bring-back (`+` fetch into the same ref) | `features/code_handoff.py:1214-1229` | Timestamped ref per bring-back, or refuse a new hand-off while the ref exists | S |
| W17 | Medium | Sessions started with the Cloud switch likely vanish after a restart (no session id to look up by) | `features/code_handoff.py:258-268, 502, 771`; `tasks.py:2802` | Store a stable key (copy slug) on the record and look tasks up by it. Confirm at runtime first | S |
| W18 | Medium | A start that times out leaves an unknown run going on the remote (editing and billing) | `features/code_handoff.py:626-640` | On failure run the stop script, or save the record before starting so status can reconcile | S |
| W19 | Low-Med | The first message of a Cloud-started session is lost if the hand-off fails | `features/code_cloud.py:114, 133-138` | Fall back to `tm.send(task.id, prompt)` locally | S |
| W20 | Low | The follower dies on a >32 MB line or any exception; session shows "Working" forever | `features/code_handoff.py:701-708`; `hub.py:2652` | Catch inside `_follow_loop`, skip/truncate the line, advance `seen`, keep looping | S |

### Updates and restarts

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| W21 | High | A quiet update or restart kills running terminal jobs, `!` runs, test runs, preview checks | `hub.py:2267-2275` | `busy()` also counts live shells, `code_terminal.runs`, running SuiteRunner runs, preview checks | S |
| W22 | High | follow-repo quits ~10 min after its only "is it quiet?" check (the build runs in between) | `app/features/follow-repo.js:46-53, 67-95` | Re-check `isQuiet()` after the build; if busy, wait for the next quiet moment | S |
| W23 | High | follow-repo restarts onto the dirty working tree (other sessions' half-written files), no health check, no rollback | `app/features/follow-repo.js:42-57`; `app/main.js:244-249, 298-302` | Skip during rebase/merge or a dirty tree; if `/health` doesn't return, restart on the old code and mark that commit bad | M |
| W24 | Medium | A follow-repo restart makes the other app start a competing backend (lock race, windows reload, wrong "Eden Secretary quit") | `app/backend-share.js:77-89`; `app/main.js:385-392` | "restarting" marker in `backend.json`; watchers wait ~30 s when they see it | S |
| W25 | Medium | A stalled Windows download freezes the updater until restart | `app/win-update.js:151, 158, 169, 179` | AbortController with a stall timer reset on each chunk; clean the `.part` | S |
| W26 | Medium | A Mac update that keeps failing (e.g. wrong signing team) re-downloads every hour, forever (~200 MB/h) | `app/features/updates.js:78-81, 127-129` | Remember the failed version; exponential backoff | S |
| W27 | Low | The sharing app never installs an update quietly; Windows "Install now" kills a running turn without warning | `app/main.js:255`; `app/win-update.js:142` | Query the shared port's `/health`; warn when busy | S |
| W28 | Low | No SIGKILL fallback when stopping the backend on Mac (hang → window never reopens, next launch hits exit 75); closed shells keep 512 KB scrollback each | `app/platform-paths.js:41`; `code_terminals.py:54, 173` | SIGKILL after ~8 s; drop exited shells from `items` | S |

### Test runner

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| W29 | Medium | Test reports parsed on the event loop with no size cap (a big jest JSON freezes chats and voice); `lines` can reach ~200 MB | `codetests.py:597, 741, 748-752` | Parse in `asyncio.to_thread`; cap report ~20 MB and `lines` by bytes | S |
| W30 | Medium | Watch mode walks the whole repo every 2.5 s; tests that write watched files loop forever | `codetests.py:890-903` | Cap entries walked; ignore files the run itself wrote | S |
| W31 | Med-Low | No git installed → uncaught `FileNotFoundError` ("what branch am I on", projects overview) | `hub.py:4805-4813, 4827, 7025`; `voicecode.py:924` | Catch `OSError`, return "" | S |

---

## Phase 3: Model Router and relays (the main selling point has to be solid)

| ID | Sev | Problem | Where | Fix | Size |
|---|---|---|---|---|---|
| R1 | High | Fallback ping-pong: while Claude is down, every routed message re-routes to Claude, fails, reopens twice, falls back again | `features/code_router.py:408-440, 470-478`; `tasks.py:1509, 1758` | `_switch` skips a Claude ref while `hub._claude_back()` is false (keep `fell_back_from`); tell the window's router Claude is down | S |
| R2 | High | The router's fallback overrides "wait for Claude's limit to reset" | install order `features/code_limit.py:240` vs `features/code_router.py:610`; `RETRY_KINDS` `:118` | On `rate_limit` with `code_limit.wanted()` on and a non-custom model, don't fall back; or install the router inside `code_limit` | S |
| R3 | High | Both relays report `input_tokens: 0`, so auto-compact never runs on Gemini/OpenAI/local sessions; they grow until a 400 that nothing falls back from | `openai_relay.py:364-375, 598-610, 822`; `gemini_proxy.py:289-300, 403-414, 523` | `message_start` with `count_tokens(body)`; send `input_tokens` in `message_delta` once upstream gives it. Confirm Claude Code reads it, with a long Gemini session | S |
| R4 | High | Gemini failures (`MALFORMED_FUNCTION_CALL`, safety blocks, blocked prompts, streams with no finish) become an empty "done" | `gemini_proxy.py:260-265, 390-395, 568-573` | Any finish other than STOP/MAX_TOKENS, an empty reply or a block reason → `Stream.failed(reason)` | S |
| R5 | Medium | Gemini's retired-model rescue never runs for AI Studio keys and shows a misleading auth error | `gemini_proxy.py:466-488, 509` | When the second endpoint also 4xxs, return the first (404) response so `successor()` runs | S |
| R6 | Medium | OpenAI relay runs truncated tool calls with `{}` (retry loops) and accepts cut-off streams as done | `openai_relay.py:333-340, 433, 595-596, 880-885` | Drop broken calls and end `max_tokens`; no finish + no `[DONE]` → `Stream.failed` | S |
| R7 | Medium | Tool-call IDs passed through unchanged: Kimi-style `functions.Bash:0` IDs break the session for good once it returns to Claude; Claude IDs break strict providers | `openai_relay.py:136, 166, 432` | Deterministic per-provider ID mapping in both directions | S |
| R8 | Medium | A session moved off Claude still waits out Claude's 5-hour reset, then tells Gemini "Claude's limit reset" | `features/code_router.py:291-294, 408-440`; `tasks.py:1386, 2666`; `features/code_limit.py:183-216` | Moving to a `custom:` ref releases the hold (`code_limit.release`) | S |
| R9 | Medium | Startup race resets restored sessions to the default model ("relay isn't running yet") | `hub.py:1543-1544`; `features/code_sessions.py:364-370`; `providers.py:1514, 1523` | Await `_relay_if_needed()` before feature loops, or restore awaits the relay | S |
| R10 | Med-Low | Relay read timeout 600 s mapped to "overloaded" (long retries on a hung local model); local server down → `invalid_request`, no fallback | `openai_relay.py:717-719, 808-810` | Short first-byte timeout for local hosts; map connection-refused to a fallback kind | S |
| R11 | Low | A queued routed message can run on the next message's model (0.75 s reopen window) | `features/code_router.py:291-294, 330-347`; `tasks.py:541` | Not movable while inbox items or a reopen are pending | S |
| R12 | Low | Gemini output tokens double-counted (`thoughtsTokenCount`); `routes` / `auto_held` never pruned | `gemini_proxy.py:315-317`; `features/code_router.py:202, 210` | Fix the sum; prune on session close | S |

---

## Phase 4: UI, accessibility, test coverage

### UI bugs

| ID | Problem | Where | Fix |
|---|---|---|---|
| U1 | Empty `#cards` stack covers the sidebar and swallows clicks | `web/app.css:166, 190`; `web/eden-code.css:169` | `top:76px; right:24px; left:auto; bottom:auto`; `.cards:empty{display:none}`; `pointer-events:none` on the stack, `auto` on children |
| U2 | Rewind "Edit" box: white text on light buttons | `web/app.css:852, 938`; `web/eden-code.css:139` | In `web/features/code-sessions.css` after line 41: editing bubble uses `--eden-text` on `--eden-content`; non-filled `.jc-btn` uses ink colour |
| U3 | Pull-request "Into mai…" select truncated | `web/app.css:1685`; `web/features/code_pr.css:53-54` | `.jcx-pr-base .jcs-select { max-width: min(260px, 50vw) }` |
| U4 | "Tests passed (0)" after a failed run | `tasks.py:2027` (keeps only the first 2000 chars); `codesupervisor.py:633, 667, 730`; `web/features/code-receipts.js:28`; `features/code_receipts.py:99` | Keep head + tail; count `N errors` as failures; 0 passed + 0 failed = unknown, not passed; never show "(0)" |
| U5 | Preview's More menu text overlaps (web mode); not confirmed from code | `web/index.html:691`; `web/app.js:4931`; `web/app.css:1981, 1989` (50%/42% fill relies on blur) | Reproduce in the real app first; likely an opaque fill `rgb(250 250 252 / .94)` + dark twin |
| U6 | Preview pane "Looking at the project…" forever on failure | `features/code_verify.py:216-221`; `web/features/code-verify.js:349, 406` | Send `cv_state {error}`; draw it |
| U7 | Git pane "Loading…" forever for a missing/invalid folder | `features/code_git.py:236-238`; `web/features/code_git.js:213` | Send `{repo:null, error}`; draw it |
| U8 | Rewind editor: failed send shows nothing; buttons stay disabled if `code_rewound` never comes | `web/features/code-sessions.js:463-467` | Show the error; ~15 s timeout |
| U9 | Model Router fails silently: label says "Model Router" but messages go unrouted | `web/features/code-router.js:280, 340, 631-634` | Fall back to showing the session's real model, or a disabled chip with the error |
| U10 | Cloud switch forgets "on" when the start fails; its explanation is only a tooltip on a disabled button | `web/features/code-cloud.js:47-51` | Keep the state until the session starts; `aria-describedby` / visible note |
| U11 | Dead code: `renderDiffPane` builds every file's diff even collapsed, likely shadowed by the feature pane | `web/app.js:5157`; `web/features/code_changes.js:414` | Confirm and remove |

### Accessibility (Daredevil depends on this)

| ID | Problem | Where | Fix |
|---|---|---|---|
| A1 | The transcript is `aria-live="polite"` with streamed words and 400 entries: screen readers get flooded | `web/index.html:646` | `role="log"` without live streaming + a separate short live status line ("Eden Code finished: 3 files changed") |
| A2 | Composer textarea has only a placeholder | `web/index.html:667` | `aria-label` |
| A3 | Effort sliders: `outline:none`, no focus style | `web/app.css:1652` | Visible focus ring |
| A4 | Full keyboard + VoiceOver pass over every Eden Code pane (Changes, Git, Tests, Problems, Preview, PR, board, Route popover) | all panes | Fix what the pass finds; add tests in `tests/web` |

### Test coverage (each gets real tests)

| ID | Area | Where | Coverage now |
|---|---|---|---|
| T1 | Test pass/fail parser (cut-off output, "N errors", failing run exiting 0) | `codesupervisor.test_counts`, line 730 | clean outputs only |
| T2 | Rewind reopen and failure branches | `tasks.py:1560-1610` | 0% |
| T3 | Server core | `server.py` (`create_app`, `socket`, `serve`, `end_children`); `hub.py` | 52% / 50% |
| T4 | PR actions | `features/code_pr.py` `cmd_fix`, `cmd_merge`, `cmd_resolve`, `watch`, `open` | 77% |
| T5 | Cloud | `features/code_handoff.py`, `features/code_cloud.py` (`build_server`, `start_session_in_cloud`, `bring_back_now`, `continue_on_machine`, follow loop) | 80% / 85% |
| T6 | Dev servers | `devservers.py` `_clean_config`, `read_launch`, `save_config`, `is_local_url` | 74% |
| T7 | Terminals, verify | `code_terminals.py`; `features/code_verify.py` (`cmd_state` error, `_turn_tests`, `_tests_watch`) | 80% / 84% |
| T8 | Router learner | `features/code_router.py` `cmd_classify`, `_start_page`; `features/code_router_events.py` `_run_learner`, `nightly`, `maybe_learn` | 87% / 89% |
| T9 | Sandbox store | `codesandbox.py:64-67, 95-97` | 86% |
| T10 | End-to-end: real Eden Code app driving a sample repo (start, edit, test, land, PR on a test double, cloud hand-off to a local SSH container, router fallback), run in CI | new | none |

---

## Phase 5: production basics the audit found missing

| ID | What | Why |
|---|---|---|
| O1 | Crash reporting (opt-in, scrubbed): backend exceptions, renderer errors, Electron crashes | today failures only reach a local log |
| O2 | A Health/diagnostics bundle the user can send (exists: `features/ops/diagnostics.py`), linked from every error card | support |
| O3 | Store migrations: versioned JSON stores with a migration step and a backup before each | stores change shape between releases |
| O4 | Release pipeline: signed + notarized (team 8CV4X23Y2T), fuses (S7), signed Windows feed (S8), staged rollout, rollback | today a bad build can brick the app (W23) |
| O5 | README and askedencode.com list the real features (cloud, Model Router, best-of-N, board, issues, unattended runs) | the README is stale; even the audit was misled |
| O6 | Windows: signed installer (no SmartScreen warning); tested by `windows-launch-check` on real Windows before any site link moves | unsigned beta today |

---

## Phase 6: features from the competitor startups

Eden already has (checked in code, 2026-10-13): best-of-N with a judge (`features/code_bestof.py`), a session board
(`web/features/code-board.js`), other agents over ACP (`features/code_acp.py`), cloud + SSH machines
(`features/code_cloud.py`, `code_handoff.py`), worktrees (`features/code_isolation.py`), PRs with CI auto-fix
(`features/code_pr.py`), GitHub issues → sessions (`features/code_issues.py`), unattended runs
(`features/code_unattended.py`), self-verification + video proof (`code_verify.py`, `code_qa.py`, `code_video.py`,
`code_receipts.py`), lessons memory (`features/code_lessons.py`), line comments (`web/features/code_changes.js`),
subagent lanes (`features/code_lanes.py`), usage-limit waiting (`features/code_limit.py`), the phone companion
(`companion_code.py`), the Model Router (`features/code_router.py`).

Ordered quick wins first, then the big differentiators.

| ID | Feature | Who has it | Eden today | Plan | Size |
|---|---|---|---|---|---|
| F1 | **AGENTS.md** written and read alongside CLAUDE.md, so Codex/Gemini/OpenCode sessions get the project notes and lessons | Codex, Kilo, Orca agents | Missing (CLAUDE.md only: `code_memory.py`, `features/code_lessons.py`) | Write lessons to both; ACP sessions get AGENTS.md; keep them in sync | S |
| F2 | **To-do column on the board**: write cards ahead, drag one to start an agent (with model, mode, isolation, cloud) | Vibe Kanban, Orca, Emdash | Partial: status columns only | Backlog cards stored per project; drag → `task_new`; cards can come from GitHub/Linear | S |
| F3 | **Click an element to send it** (Design Mode): pick an element in Preview, its HTML, CSS, selector and screenshot go to the session; spoken version for Daredevil ("the button under the price") | Orca | Missing (`code_design.py` compares to a screenshot only) | Element picker in the preview session's preload; attach as a structured mention | S-M |
| F4 | **AI review on anyone's PR**, posted as review comments, with "fix it" buttons | CodeRabbit, Greptile, Factory | Partial: `code_review.py` reviews the session's own diff | Reuse `code_review` on any PR in a watched repo; routed to a cheap model; opt-in per repo | S-M |
| F5 | **One prompt to several agents, merge the best parts** (not just pick a winner) | Orca, Conductor | Partial: best-of-N picks one | Judge proposes a merged patch from the candidates; owner reviews by hunk | M |
| F6 | **Linear and Slack triggers**: assign a Linear ticket or @Eden in Slack → session → PR, status posted back | Tembo, OpenHands, Charlie, Kilo, Orca | Partial: GitHub labels only | Linear webhooks + API and a Slack app (not MCP: `code_issues.py` notes MCP was unreliable); same untrusted lock-down and actor check (S14) as issue runs. Owner creates the Linear and Slack apps | M |
| F7 | **Codebase index that understands meaning** (embeddings + symbol map), also exposed as an MCP server so every agent (Claude, Codex, Gemini) uses it | Augment, Greptile, Amp | Missing (`code_search.py` is `git grep`; `embeddings.py` serves the brain) | tree-sitter symbols + local embeddings per project, incremental on file change; `codebase_search` MCP tool | M |
| F8 | **Spec mode**: requirements → design → tasks files in the repo; tasks become board cards / sessions; each task's checks run against the spec; the receipt says which requirements are met | Kiro, Augment Intent | Missing | Plan step writes `specs/<name>/{requirements,design,tasks}.md`; tasks → F2 cards; `code_verify` checks acceptance criteria | M |
| F9 | **Per-project setup script + container per agent** (devcontainer / Docker), so new copies start ready and unattended runs are reproducible and contained | Sculptor, Tembo, OpenHands, Conductor | Partial: worktrees + .env copy + sandbox + SSH machines | `.jarvis/setup.sh` run on new copies; optional devcontainer runner for isolated and unattended sessions | M |
| F10 | **Stacked PRs**: split a big session's change into a stack of small reviewable PRs, restacked on updates | Graphite (Cursor) | Missing | Split by hunk groups (the judge proposes, owner adjusts); push as dependent branches; `code_pr` watches the stack | M |
| F11 | **Pairing mode**: mirror an agent's copy into the owner's own editor live, and owner edits flow back | Sculptor | Partial (editor + isolated copies) | Sync the worktree to a "pair" branch/folder both sides watch | M |
| F12 | **Multi-repo tasks**: one task, coordinated PRs across several repos | Tembo | Missing | A session group across worktrees in several repos; linked PRs | M |
| F13 | **Shared live sessions** for teammates (watch / co-control via link) | Amp, Conductor Teams, Superset | Missing (static export only) | Read-only live view first (relay through the Worker), then co-control with roles | L **[site]** |
| F14 | **Background routing queue**: queued cards/tickets go to the cheapest model that passes `code_verify`, learning per project which model wins (`code_router_events` learner) | nobody | builds on F2 + router | Eden's own differentiator: "never hit a usage wall, set the dollar ceiling" | M |
| F15 | **Proof against the spec**: receipt + video proof + spec checks attached to the PR | nobody does all three | builds on F8 + receipts + video | Eden's own differentiator: proves the ticket is done | S (after F8) |
| F16 | **Fleet by voice and for screen readers**: "what's everyone doing?", spoken diffs, the board read as a list | nobody | Partial (`code_voice.py`, `code_spoken.py`) | Builds on A1-A4; Daredevil ships as the accessible coding agent | M |
| F17 | **Bug Fix Mode** (owner's own protocol, 2026-10-13): one switch in the composer / session header. On, Eden runs the owner's bug protocol on any project: 3 rounds of **sweep** (read-only audit agents in parallel: security, reliability, UI/accessibility, tests; each finding with file:line and a concrete failure) → **break** (run the suite, hostile inputs, stress, start the dev server/app and try to break it) → **fix** (every finding fixed in an isolated copy with a test that fails first), with an **efficiency pass between rounds that loses zero features** (suite stays green, no feature removed). Ends with a report per round (`docs/bug-sweep/<date>-rN-{sweep,break,fix}.md`), a receipt, and the ship step for the project type (build / install / what's only in source vs installed) | nobody | builds on lanes, isolation, best-of, verify, receipts, caps, router | Stack detection; cheap models for sweeps via the router, strong model for fixes; spending cap and Touch ID before landing; stops and asks on owner-only steps | M |

Skipped on purpose: fast-apply models (Morph, Relace): Claude Code does its own edits, so they add little here.

---

## Phase 7: release

1. Owner's process: 3 rounds of sweep → break → fix with an efficiency pass between, over the whole of Eden Code.
2. Independent security review (launch gate) on the result of phases 1-3.
3. README + askedencode.com updated (O5); films re-cut if UI changed.
4. Signed + notarized Mac build as Bilel; Windows build checked on real Windows via `windows-launch-check`; then the
   site's download links move (after App Review is done; coordinate with the other sessions before deploying).

## Order and time (Claude agents, parallel worktrees)

Sizes in the tables: S = under 30 min, M = 1-3 h, L = most of a day, for one agent including its tests.

| Phase | Items | Time |
|---|---|---|
| 0 Safe ground | 5 | ~30 min |
| 1 Security | 35 | ~half a day (4-5 agents in parallel) |
| 2 Work and money | 31 | ~half a day (parallel with phase 1) |
| 3 Router and relays | 12 | ~2 h (parallel) |
| 4 UI, a11y, tests | 25 | ~half a day |
| 5 Production basics | 6 | ~half a day |
| 6 Features | 16 | ~1-2 days (agents in parallel; F13 the longest) |
| 7 Release | | ~half a day + Apple notarization |

What actually sets the pace: merging the parallel branches without conflicts, running the real app to check each
phase, and the owner steps below (Linear/Slack apps, certificates). Not the coding.

## Needs the owner

- Confirm cleaning the test junk out of `~/.zsh_history` (P0-1).
- An Ed25519 signing key for the Windows update feed, kept in the Keychain (S8). Claude can make it; owner approves.
- A Windows code-signing certificate (O6), if you want no SmartScreen warning.
- Linear and Slack apps for F6 (OAuth apps in your Linear and Slack workspaces).
- The notary profile for team 8CV4X23Y2T (already in `TODO.md`).
- An independent security reviewer before public launch.

---

## Status

### Wave 1 (2026-10-13): phases 0-3 done, merged into `eden-code-hardening`
All S/W/R items fixed with tests, except:
- **S11** (phone Face ID checked on the Mac): waits for the iPhone app to leave App Review.
- **S25** (Model Router page origin): in the separate Model Router repo, next pass.
- **S1 gap:** the Keychain entries still trust Eden's Python (sessions can't reach them any more; other local malware
  could). Closing it needs a signed helper / Keychain access groups (packaging).
- **S8:** signature checking is built; needs the owner's Ed25519 key, its public half in `app/win-update.js`
  (`FEED_PUBLIC_KEY`), and askeden.com serving a signed `/windows/latest.json` ([site], after App Review).
- **S28:** local Eden on :5174 needs a `/api/eden/handshake` answer from the askeden local server.
- **W23:** follow-repo now skips a dirty tree, so the owner's install rarely follows the shared tree; no rollback.

Defaults taken while the owner was away (change any of them):
- S10: web Code mode is read-only on the Mac; a Settings switch "Let askeden.com edit on this Mac" (off) is wave 2.
- S19: automatic fallback stays with the same company; crossing companies is a Settings switch (off), wave 2.
- S30: Bypass from the window requires the Touch ID proof; voice (owner's voice + tap) and phone keep their own gates.
- S3: the owner's own Commit button and pushes still run git hooks (git-lfs needs them).
- S33: phones on the old app over plain HTTP on Wi-Fi are refused; update the app.
