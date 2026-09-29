# JARVIS

A voice assistant for your Mac. Claude is the brain, MCP tools are the hands, and
macOS speech is the voice. It's built on the Claude Agent SDK, so it uses your existing
Claude Code sign-in and needs no API key.

## The app

```sh
cd app && npm install && npm start     # the Jarvis window
npm run package                        # builds app/dist/Jarvis-darwin-arm64/Jarvis.app
```

The window is the "Ambient Orb" design: tap the JARVIS-blue orb (or press ⌥ Space from
anywhere) and talk. The orb breathes when idle, its rings follow your voice while it
listens, it swirls while thinking and pulses while speaking. Approval cards appear top
right, and the Activity drawer bottom left lists every tool call and any Claude Code
tasks, with a Stop button. Closing the window hides it; ⌘Q quits. Backend logs go to
`~/Library/Logs/Jarvis/backend.log`.

Under the hood, Electron starts `uv run jarvis serve` on a random local port with a
fresh token. The window's WebSocket must present that token from the server's own
origin, so other pages in your browser can't drive your Mac through it.

## Terminal mode

```sh
uv run jarvis            # press Enter, speak, and it replies aloud
uv run jarvis --text     # type instead of speaking
uv run jarvis --mute     # no spoken replies
```

In voice mode you can also type a line instead of pressing Enter. Say or type `quit` to
leave.

## What it can do

| Area | Tools | Asks first? |
| --- | --- | --- |
| Mac | open apps and web pages, Spotify / Apple Music, volume, Apple Notes, time and battery, list Shortcuts | no |
| Shortcuts | run a Shortcut by name | **yes** |
| Mail | read the inbox, open a draft | no (it never sends; you press Send) |
| Calendar | read the schedule | no |
| Calendar | add an event | **yes** |
| Web | search, read pages | no |
| BSH | firm search, companies, profiles, decisions, portfolio, signal scores, transcripts, reference calls | no (read-only) |
| Windows | snap an app left / right / full screen | no |
| Apps | quit an app | **yes** |
| Claude Code | start a coding agent in a project folder | **yes**, then every edit and shell command asks too ("Allow all edits" covers the rest of that task's edits) |

JARVIS's own conversation has Claude Code's coding tools (shell, file edits and so on)
switched off; coding happens only in the separate Claude Code tasks above. JARVIS
only loads its own MCP servers and ignores `~/.claude` settings. Email and web content
are treated as data, never as instructions.

## First run

- **Microphone:** macOS asks for microphone access for the app running JARVIS
  (Terminal, iTerm, and so on).
- **Automation:** the first Mail, Calendar, Notes or Music request asks you to let that
  app control it. If you declined earlier, change it in System Settings › Privacy &
  Security › Automation.
- **Speech model:** Whisper `base.en` (~150 MB) downloads once from Hugging Face and
  loads in the background at startup.

## Configure

Copy `.env.example` to `.env`. You can change the model, effort, voice, Whisper size,
default calendar, and where the BSH research center lives.

## Layout

- `app/`: the Electron shell (window, ⌥ Space, starts the backend)
- `src/jarvis/web/`: the window's UI
- `src/jarvis/server.py`: local HTTP + WebSocket server for the window
- `src/jarvis/hub.py`: the app's core (session, voice, approvals, activity, status)
- `src/jarvis/tasks.py`: Claude Code tasks and their approval policy
- `src/jarvis/cli.py`: terminal mode and `jarvis serve`
- `src/jarvis/brain.py`: Agent SDK options, system prompt, permission policy
- `src/jarvis/mac_tools.py`: the in-process Mac MCP server. AppleScript gets its values
  through argv, so they're never spliced into script text.
- `src/jarvis/listen.py`: microphone capture with automatic end-of-speech detection,
  and Whisper
- `src/jarvis/speech.py`: markdown → speakable text, and `say`

```sh
uv run pytest && uv run ruff check .
```

Known limit: Calendar's AppleScript only reports a repeating event on the day of its
first occurrence.
