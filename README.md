# JARVIS

A voice assistant for your Mac. Claude is the brain, MCP tools are the hands, and
macOS speech is the voice. It's built on the Claude Agent SDK, so it uses your existing
Claude Code sign-in and needs no API key.

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

Claude Code's own coding tools (shell, file edits, and so on) are switched off. JARVIS
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

- `src/jarvis/cli.py`: the listen → think → speak loop
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
