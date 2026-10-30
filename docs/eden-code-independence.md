# Eden Code on its own: its own engine, its own app, no "Jarvis" (plan, 2026-10-16)

The owner's ask (2026-10-16): Eden Code no longer needs Claude Code (it gets its own agent engine), is no
longer tied to Eden Secretary, and is called Jarvis nowhere. Production grade and thoroughly tested. Built
by Gemini 4 Argon sessions, one phase at a time; each session reads this file first and ticks it.

## Where things stand (checked 2026-10-16)

- **Engine.** Eden Code sessions run on Claude Code through the Python `claude-agent-sdk` (`pyproject.toml`:
  `>=0.2.164`), which bundles the Claude Code CLI. There is one switch point: `TaskManager.client_factory`
  (`src/jarvis/tasks.py:1058`, used at `:2406` and `:3038`), with options built in `options_for`
  (`tasks.py:2166`). `acp.py`'s `AcpClient` already plugs a non-Claude agent in there by looking like the
  SDK's client. The native engine plugs in the same way.
- **Models.** Every model already reaches Claude Code as Anthropic's Messages API at the session's
  `ANTHROPIC_BASE_URL` (`providers.session_pins`, `providers.py:1533`): Anthropic itself, Eden Plus
  (`claude_signin.plus_settings`), the Gemini relay (`gemini_proxy.py`), the OpenAI relay (`openai_relay.py`)
  and Moonshot's `/anthropic`. So the engine needs one model protocol (Messages API, streamed, with tools) to
  run all seven models in the pickers.
- **SDK use.** About 125 backend files import the SDK, mostly `tool` and `create_sdk_mcp_server` (in-process
  MCP tools, 88 and 85 imports). The engine-only parts are `ClaudeSDKClient`, `ClaudeAgentOptions`, the
  message types, `HookMatcher`, the permission results and the session functions (`list_sessions`,
  `get_session_messages`, `rename_session`, `delete_session`). `longcmd.py` patches the CLI transport.
- **Shared with Eden Secretary.** One Electron folder (`app/flavor.js`: flavors `jarvis`, `daredevil`,
  `eden-code`) and one Python backend (`src/jarvis`, about 206k lines). Eden Code runs it with
  `JARVIS_PROFILE=code`, or shares Secretary's running backend through `app/backend-share.js`.
- **The name.** "Jarvis" appears in about 1,400 files and 9,000 lines (src 545 files, tests 515, companion
  116, site 162, app 45). It is also in environment variables (`JARVIS_HOME`, `JARVIS_TOKEN`,
  `JARVIS_PROFILE`…), the data folder, Keychain service names, the `com.askeden.jarvis*` ids and
  `~/.jarvis-handoff`.

## Decisions this plan takes (the owner can change them in TODO.md)

1. **Order: split, then rename, then engine.** The split and the rename decide where code lives and what it
   is called. The engine is then written once, under its final names, in the new repo, away from the
   parallel sessions working in JARVIS V1.
2. **New repo:** `Ask Eden And Model Router For Query Gen/Eden Code/`, a git repo whose history starts from a
   copy. Not pushed anywhere until the owner says so. Once the split starts, Eden Code changes go only there.
3. **"No Jarvis anywhere" means Eden Code:** its repo, app, data, logs and UI. Eden Secretary and askeden.com
   (`site/`) keep their names for now. One exception: Eden Code's first-launch migration reads the old
   Jarvis-named data folder and Keychain items once, to carry the owner's settings over. That code is deleted
   one release later.
4. **Claude models on the Eden engine use an Anthropic API key or Eden Plus, never the Claude subscription
   sign-in.** Anthropic's terms allow that sign-in only in Claude Code and claude.ai, not in other products
   (the Agent SDK included). Until the engine is the default, the Claude Code engine stays available as a
   setting.
5. **The Claude Code engine stays behind a setting until phase 4's gate passes.** Then it is removed, along
   with the `claude-agent-sdk` dependency.

## Phase 0: baseline (in JARVIS V1, no app changes)

- [x] Run the whole test suite (`uv run pytest`). Record the pass and fail counts and the known failures here. (Done 2026-10-16: Eden Code suite 706 passed, 13 failed inside outer Seatbelt sandbox — 5 in `test_code_interpreter.py` from nested `sandbox-exec`, 7 in `test_code_terminals.py` from sandbox PTY denial, 1 timing check in `test_code_handoff.py`.)
- [x] Write the contract the engine must meet, as `tests/test_engine_contract.py`:
  - every `ClaudeAgentOptions` field that `options_for` and the option hooks set;
  - every client method TaskManager calls (`connect`, `query`, `receive_messages`, `receive_response`,
    `interrupt`, `set_permission_mode`, `set_model`, `get_mcp_status`, `get_context_usage`, `rewind_files`,
    `stop_task`, `reconnect_mcp_server`, `disconnect`);
  - every message type and field read from the stream.

  Run it against the SDK first, so it is known to describe today's behaviour. (Done 2026-10-16: 6/6 passed in `tests/test_engine_contract.py`.)

**Gate:** the baseline and the contract are written down and the contract passes against the SDK. (Passed 2026-10-16.)

## Phase 1: Eden Code in its own repo, with its own backend

- [ ] Map the imports reachable from Eden Code's entry points and list every Secretary-only module they reach.
  The entry points are the `eden-code` flavor in `app/`, `JARVIS_PROFILE=code` in the backend, `tasks.py`,
  `features/code_*`, `code_*.py`, `codemcp.py`, `acp.py`, `providers.py`, the relays and `companion_api.py`
  (the iPhone app). For each module reached, either move the shared piece into Eden Code or drop the feature
  from Eden Code, and note here which.
- [ ] Copy only what is reachable into the new repo:
  - an Electron app with the Eden Code flavor only;
  - no `backend-share.js` (Eden Code always runs its own backend);
  - its own data folder, Keychain service, update feed, bundle id and signing.
- [ ] Eden Secretary keeps an "Open Eden Code" button, which launches the app if it is installed. No code or
  backend is shared at runtime.

**Gate:**
- Eden Code's tests pass in the new repo.
- On a real Mac, Eden Code runs with Eden Secretary not installed, and Secretary runs without Eden Code.
- With both installed, neither touches the other's data or backend.

## Phase 2: no "Jarvis" in Eden Code

- [ ] Rename everything:
  - the Python package `jarvis` becomes `eden_code`;
  - the `JARVIS_*` environment variables become `EDEN_CODE_*`;
  - file, test, log, UI, comment and doc names follow.
- [ ] Write the first-launch migration (decision 3). Its test starts from a copy of the installed build's data
  folder and Keychain items, and ends with the same settings, keys, sessions and projects.

**Gate:**
- `grep -rIi jarvis` in the repo finds only the migration module.
- The full test suite is green.
- The upgrade test passes on a real Mac.

## Phase 3: the Eden engine, behind a setting

The engine lives in `eden_code/engine/`. Its client looks to TaskManager like the SDK's client (as `AcpClient`
does) and yields the same message types, so the transcript, cards, queue, interrupt and policy stay as they
are.

- [ ] **Model client.** Messages API over httpx, with server-sent events parsed as they arrive. It also handles:
  - retries with backoff on 429, 500, 502, 503 and 529 and on dropped connections, never running a tool twice;
  - timeouts;
  - cancellation that closes the stream;
  - usage and cost for each turn.
- [ ] **Loop.** Each turn goes: assistant turn, then each tool_use, then permission (mode, allowed and
  disallowed tools, `can_use_tool`), then the run (independent read-only tools in parallel), then the
  tool_result, then the next turn. It stops at end_turn, max turns, an error or an interrupt, and ends with a
  `ResultMessage` carrying the same fields as Claude Code's.
- [ ] **Tools**, each with its own tests:
  - **Read:** line ranges, images, PDFs and notebooks; binary files refused; size caps.
  - **Write.**
  - **Edit:** exact match, unique match or replace-all, read before edit; CRLF, tabs and unicode kept; atomic
    write.
  - **Glob.**
  - **Grep:** ripgrep.
  - **Bash:** its own process group, a timeout, background runs with their output and a kill, output capped;
    stdin closed so nothing waits for input.
  - **TodoWrite, WebFetch, NotebookEdit.**
- [ ] **MCP.**
  - In-process servers made with `create_sdk_mcp_server`: their handlers are called directly.
  - stdio and HTTP servers from settings.
  - Tool names are `mcp__<server>__<tool>`.
- [ ] **System prompt.** Eden Code's own, plus `EDEN_CODE_IDENTITY` and the project's instructions. Claude
  Code's preset prompt belongs to Anthropic and is not copied.
- [ ] **Tests.** A scripted fake Messages API server (server-sent events) drives the loop through:
  - malformed tool JSON and an unknown tool;
  - a stream cut in the middle of a tool call;
  - a 429, then success;
  - an interrupt during a Bash run;
  - a permission denied;
  - parallel tools with one failing.

**Gate:**
- A real session on a real Mac makes a multi-file change, with tests, on Claude Opus 5.5 (API key) and on
  Gemini 4 Argon (relay).
- The contract test passes against the engine.

## Phase 4: what Eden Code uses from Claude Code today

- [ ] **Sessions:** its own JSONL store; resume, fork and resume at a message; list, read, rename and delete
  (the history UI); old Claude Code sessions listed read-only.
- [ ] **Undo:** file checkpoints for each user message, and `rewind_files`.
- [ ] **Context:**
  - compaction before the window fills, keeping the instructions, the task, file paths and the last turns;
  - `get_context_usage`;
  - prompt caching for Claude.
- [ ] **Settings:**
  - CLAUDE.md and AGENTS.md (user, project and local);
  - skills, slash commands and plugins;
  - hooks, as `code_secrets` and `code_verify` set them;
  - Eden Code's own config folder, imported once from `~/.claude`.
- [ ] **The rest:**
  - subagents (the Task tool), plan mode, and questions as Eden cards;
  - thinking and effort for each provider;
  - `set_model` and `set_permission_mode`;
  - web search: Anthropic's server tool on Claude, the relays' search on the other models.

**Gate:**
- The whole Eden Code test suite passes with the engine as `client_factory`.
- 20 real tasks run side by side on both engines, with no regression the owner cares about.
- A real-Mac check of undo, resume, MCP tools and the iPhone app.

## Phase 5: the engine on by default, Claude Code gone

- [ ] Make the engine the default and remove the Claude Code engine.
- [ ] Drop `claude-agent-sdk`: its `tool` and `create_sdk_mcp_server` are replaced by small versions of Eden
  Code's own. Delete `longcmd.py`.
- [ ] Run the production plan's independent security review on the engine: Bash, file tools, MCP and
  permission bypasses.

**Gate:**
- No Claude Code anywhere in the build (grep, and the app bundle's contents).
- The release checks in `docs/eden-code-production-plan.md` phase 7 pass.

## How each phase is run

- One Argon session per phase, in the new repo (JARVIS V1 for phase 0). It reads this file first and ticks it.
- Nothing counts as done until its tests pass and its gate is checked. Failures are written here, not hidden.
- No deploys, pushes or installs over the owner's apps without the owner's OK.

## Time

This is weeks of agent work, not days. The engine alone has to match every Claude Code feature listed in
phase 4. The split and the rename touch about 1,400 files and the owner's saved data. The real-Mac gates need
the owner.
