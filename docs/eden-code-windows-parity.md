# Eden Code on Windows: what works, what was fixed, what stays on the Mac

Roadmap item 49. An audit of every Eden Code feature (`src/jarvis/features/code_*.py`, the
`src/jarvis/code*.py` modules they use, their window side in `src/jarvis/web/features/code-*.js`,
and the Electron main process in `app/`) for things that only hold on a Mac: paths, `open`,
osascript, the Keychain, Touch ID, sandbox-exec, zsh, `/tmp`, path separators, line endings,
signals, symlinks, worktrees, and PowerShell against bash in the terminal pane.

**Nothing here has run on a real PC yet.** Every Windows path was checked on a Mac by making the
backend look like a PC (`osplat.IS_WIN` patched: `tests/test_code_windows_parity.py`) and with
fake PowerShell and fake Win32 calls (`tests/web/code-windows.test.mjs`). It counts as verified
only after the owner's check on real Windows (the end of this page).

How a PC is told apart: `osplat.IS_WIN` (the one place the engine asks), and for Eden Code
`codeparity.py` (what that means for each feature). On a PC, Eden Code settings › General shows
an **On this PC** list (`features/code_windows.py`, `web/features/code-windows.js`) of what works
another way there and what is the Mac's alone, each with why, so nothing just seems broken.

States: **works** (the same on both, nothing needed), **fixed** (was Mac-only, now has a Windows
way, in this change), **another way** (works on Windows, differently, said in the list),
**Mac-only** (not on Windows, why given; hidden or explained, never failing).

## The table

| Feature | Windows | How, or why not |
|---|---|---|
| Sessions, transcript, modes, queue, to-do, receipts, usage, limits, model router | works | Pure Python and the Claude Agent SDK; data under `osplat.app_support()` (`%APPDATA%\Jarvis`). |
| Claude Code's own commands (Bash tool) | works | Claude Code runs them in Git for Windows' bash; Eden Code never wraps them in zsh. |
| Terminal pane | works | `winterm.py` (ConPTY via pywinpty), shell = PowerShell 7, else Windows PowerShell, else cmd (`osplat.default_shell`); tabs are named after it ("pwsh 1"). |
| "!" commands in the composer | works | `code_terminals.WinBangRun`: the shell's `-Command` (or cmd's `/c`), output piped, Cancel ends the tree (`taskkill /T`). |
| Stopping a session's processes | works | `osplat.kill_group` (taskkill /T on Windows, killpg on a Mac); `runproc`'s Windows supervisor. |
| Isolated copies (git worktrees): make, land, discard, sweep | works | Plain git; paths compared with `as_posix` where git's own are. |
| Shared `node_modules` / `.venv` in a copy | **another way** (fixed) | A folder symlink, which Windows allows only with Developer Mode on. Without it, the copy's note says so and how to turn it on, instead of failing silently (`worktrees.link_dependencies`, `codeparity.link_folder`). Never a directory junction: a tool that deletes the copy and follows a junction would empty the main folder's `node_modules`. |
| Copy's `.env` files, secret scan, changes pane, hunks, Land | works | Byte-for-byte file copies; git diff. |
| Editor: open, save, conflicts | works | Saves keep CRLF files CRLF (`code_editor.save`), atomic replace (`os.replace`). |
| Open in an editor | **fixed** | VS Code, Cursor and Zed are found where their Windows installers put them (`%LOCALAPPDATA%\Programs`, `%ProgramFiles%`, or beside `code`/`cursor`/`zed` on the PATH) and opened by their own program (`--goto file:line`), started and left running (`code_editor.find_windows_editors`, `open_command`, `launch`). Before: `open -b <bundle id>`, which has no Windows meaning, so every editor failed. Xcode stays Mac-only. |
| Show in Explorer / open in its own app | works | `open -R` / `open` become Explorer and the file's registered app (`osplat.mac_open`); now launched without waiting (`code_editor.launch`). |
| Touch ID for Bypass and risky steps | **fixed: Windows Hello** | `app/features/touchid.js`: on Windows, Windows Hello's own sheet (face, fingerprint or PIN) through Windows' `UserConsentVerifier`, run by System32's Windows PowerShell 5.1 (PowerShell 7 can't load WinRT types). The reason is the app's fixed words, passed in an environment variable. A yes is signed into the same proof the backend checks. Without Windows Hello set up (or turned off by policy), the app's own dialog asks, signed the same, as on a Mac without Touch ID. The setting reads "Windows Hello for Bypass and risky steps" on a PC. |
| Risky-step detection (what needs Touch ID / Windows Hello) | **fixed** | The shared table (`code_touchid.RISKY`, `web/features/code-touchid.js`, `tests/fixtures/risky_commands.json`) now also knows PowerShell's and cmd's own: `Remove-Item -Recurse`, `rd /s`, `del /f`, `format D:`, the registry, scheduled tasks, services, `netsh`, Defender exclusions, `Stop-Process`/`taskkill`, `iwr … \| iex`, `powershell -EncodedCommand`, certutil/bitsadmin downloads, mshta/regsvr32/rundll32. An allow rule for `powershell`, `pwsh`, `cmd`, `wsl`, `Start-Process`… is broad (Bypass for anything), in any case and with a `C:\…` path. |
| Exterminator Mode | works (fixed details) | Its "before the fix" copy links `node_modules`/`.venv` as folder links (it made file links before, which point nowhere on Windows); its allowed test commands include a Windows venv (`.venv/Scripts/python -m pytest`) and `py -m pytest`. |
| Test runs and verification (pytest, vitest, jest, go, cargo) | **fixed** | vitest and jest run through npm's `.cmd` shim on Windows (the shell-script shim isn't runnable there); a venv made on Windows is found (`.venv\Scripts\python.exe`); plain `python`, not `python3`; result files are named with git's slashes (`codetests`). |
| Sandbox for Bypass and unattended sessions | **Mac-only** (explained, safe fallback) | Claude Code's sandbox is built on macOS's Seatbelt and Linux's bubblewrap; native Windows has neither, and a session told to use it there would run unsandboxed without a word. On a PC nothing is put on the connection; with the switch on, each command of a Bypass or unattended session asks first instead; the Rules pane says so and hides the domain allowlist (`code_sandbox`, `codeparity.NO_SANDBOX`). Recheck if Claude Code ships a native Windows sandbox. |
| Issue, Linear and Slack runs (untrusted text) that must be sandboxed | **Mac-only** (refused, said) | They don't start on a PC (`code_unattended.start` returns `codeparity.NO_SANDBOX_RUN`, which the issue's or ticket's notice repeats): an issue's words would otherwise run with the network open. Turning the sandbox off for that repository is the owner's existing opt-out. |
| Secrets for commands (`ask_secret`, `$SECRET_…`) | **Mac-only** (explained) | A command gets the value over a Unix socket made for that one run, whose peer process is checked (`key_proxy.Handoffs`); Python on Windows has no `AF_UNIX`. On a PC `ask_secret` tells the session to have the owner run such a command in the Terminal pane (no card for a value nothing could use), and a command naming a placeholder is refused before any card. Values would be in Credential Manager (keyring's Windows backend). Its shell line is Git Bash's on Windows (`code_secrets.shell_argv`), ready for when a named-pipe hand-off with a peer check is built. |
| Code interpreter (`run_python`, main chat) | **Mac-only** (off) | Its Python runs under macOS's `sandbox-exec` (no network, none of the owner's files). Windows has no comparable per-process sandbox Eden can start, so it isn't installed there rather than running model-written code unsandboxed. (Its environment also lacked `SYSTEMROOT`, without which Windows Python won't start.) A Windows Sandbox / AppContainer worker is the way to bring it back. |
| iOS Simulator tools, Xcode's MCP bridge, iOS self-check | **Mac-only** (left out) | The Simulator and Xcode exist only on macOS. On a PC their tool servers aren't given to sessions (`code_tools.build_servers`, `code_verify.session_servers`), so Claude never tries them; the browser-preview checks still run. |
| Look at this (the look-at-this key) | **another way** (fixed) | On a PC the app and window title come from Windows itself (`codelook.windows_front`: the foreground window and its program) and the picture is the whole screen; there's no Swift helper to build. The selected text isn't read on Windows yet (UI Automation's text selection is the next step). |
| Project setup script (`.jarvis/setup.sh`) on the host | **fixed** | Runs in Git for Windows' bash (no `/bin/bash` on a PC); without Git Bash the transcript says to install Git for Windows (`code_setup`). In a container it's unchanged (Linux). |
| Containers per copy (devcontainer) | works | `docker` CLI; the container side is Linux. Needs Docker Desktop. |
| The `eden-code` command | **fixed** | Installed as `%USERPROFILE%\.local\bin\eden-code.cmd` (beside Claude Code's `claude.exe`), not a `#!/bin/sh` script Windows can't run (`code_api.cli_shim`). |
| Local API, automations, triggers (GitHub/Linear/Slack), MCP, plugins, rules, AGENTS.md, memory, lessons, assumptions, attention, alerts | works | HTTP on 127.0.0.1 and JSON files; plugin command names keep `/` (`codeplugins`, fixed from `\`). |
| Machines and cloud hand-offs (SSH) | works | Windows' own OpenSSH (`ssh` on the PATH); no ControlMaster is used. |
| PRs, review, merge queue, PR-green | works | `git` and `gh`. |
| Voice coding, spoken summaries, review by voice | works | Through `speech.py` / `winsay.py` (Windows' own voices). |
| Phone companion | works | Its HTTPS server is Python's; pairing by QR. |
| Video proof, design match, preview checks | works | The built-in browser's DevTools screencast; no Mac tool. |
| Electron app: Eden Code window, sessions, updates, crash reports | works | Already branched on `process.platform` (`app/features/eden-code.js`, `updates.js`); Safe Storage's key lives in the profile on Windows (`app/keychain-name.js`). |

Also checked and left as they are: `/tmp/.eden-setup.pid` is inside the Linux container only;
`chmod 0o700/0o755` calls are harmless on Windows (only the read-only bit exists); case-insensitive
file names are the default on a Mac too, so nothing differs.

## Known limits to recheck

- Windows Credential Manager holds at most 2,560 bytes per entry (about 1,280 characters through
  keyring), less than the Keychain. Eden Code's secrets aren't stored on Windows (above), but any
  other long token kept through keyring on a PC would fail to save.
- Windows Hello's sheet, asked from a background PowerShell, can open behind the Eden window on
  some Windows builds. If it does, focus handling is the fix (the dialog fallback is unaffected).

## Owner steps (real Windows)

Installers are cross-built on the Mac and nothing above counts as verified until it has run on a
real PC (the free `windows-launch-check` runner, or a Windows machine). On the next Windows build:

1. Eden Code settings › General shows **On this PC** with the rows above, in English and Chinese.
2. Switch a session to Bypass: Windows Hello's sheet appears with "Eden Code: turn on Bypass
   permissions in Eden Code", a yes switches it, a cancel doesn't. On a PC without Windows Hello,
   the app's own dialog asks instead.
3. Turn on the sandbox switch, start a Bypass session: each command asks first; the Rules pane
   says there's no sandbox on Windows.
4. Open a file in VS Code (and Cursor/Zed if installed) at a line from the Files viewer; Show in
   Explorer.
5. Terminal pane: a PowerShell tab, a `!npm test`, Cancel.
6. Isolated copy of a Node project with Developer Mode off: the note about linking; with it on,
   `node_modules` is linked.
7. Run a project's vitest/jest and pytest from the Tests pane (a venv made on Windows).
8. Install the `eden-code` command and run `eden-code --help` in a new terminal.
9. The look-at-this key: the session gets the app's name, the window's title and the screen.
