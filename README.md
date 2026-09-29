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

## What's new in the app

- **Hands-free (on by default):** say "Jarvis" anywhere in a sentence ("Jarvis, what's
  next?", "What's the weather, Jarvis?"). Talk over it, or say "stop", to interrupt. The
  mic stays on locally; nothing leaves the Mac until you've said the wake word.
- **Voice:** Daniel through a subtle "AI in the house" effect, or any ElevenLabs / Fish
  Audio voice (set `JARVIS_TTS` and the key and voice ID in `.env`). Test it with
  `uv run jarvis say "Good evening."`
- **Personality:** JARVIS, TARS or FRIDAY, a humor dial, and an optional form of address.
- **Second brain:** Apple Notes, folders you add, the BSH desk and research reports, indexed
  locally. Answers cite them (chips under the reply), and a 3D knowledge galaxy flies to
  the note being used. Open it any time from "Second brain".
- **Files and screen:** Spotlight search, reading documents and PDFs, screenshots, and
  mouse and keyboard control. One OK per request covers the mouse and keyboard.
- **Research:** "Jarvis, research…" runs in the background and files a Markdown report
  in ~/Documents/Jarvis/Research, which also joins the second brain.
- **Model switching:** "use Sonnet" or the model chip. Opus, Sonnet, Haiku and Fable.
- **Morning briefing:** at a set time or with "Brief me": calendar, unread mail, BSH alerts
  and finished tasks.

- **Tools & Accounts** (the link icon, top right): connect Notion, Linear, Jira &
  Confluence, monday, Todoist, Sentry, Vercel, Supabase, Hugging Face, Stripe, Zapier and
  Canva by signing in with your browser; GitHub with a personal access token; Gmail,
  Google Calendar, Google Drive, Asana and HubSpot with an OAuth app you create at that
  service (Google's connectors are a developer preview). "Add any tool" takes any MCP
  server URL or command. Read-only tools run freely; anything that changes data asks
  first, with "Always allow this" per tool, or set a service to Allow everything or
  Read-only. Tokens and sign-ins live in the macOS Keychain.

macOS will ask once each for Microphone, Automation (Mail, Calendar, Notes, Music),
Screen Recording (screenshots) and Accessibility (mouse and keyboard). Grant them to
Jarvis, or to Electron when running from `npm start`.

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
uv run pytest && uv run ruff check . && node --test tests/web/
```

Known limit: Calendar's AppleScript only reports a repeating event on the day of its
first occurrence.
