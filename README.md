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

## New in this release

A short map of what was added; each feature's own Settings group or pane explains it.

- **Jarvis Code:** a session per isolated copy (land or discard), Changes by hunk with
  line comments and reviews, a Git panel, best-of-N, dev servers with a check of each
  turn's work (per project too), Tests and Problems panes, pull requests with CI watching
  and capped auto-fixes, runs without you inside a scope you approve, GitHub issues that
  start sessions, waiting out Claude's usage limit, usage meters and spending caps,
  permission rules (deny beats ask beats allow, in every mode), a sandbox, Touch ID before
  Bypass and risky steps, MCP servers and plugins, other agents over ACP, subagent lanes,
  an editor, project search, terminal tabs, richer @-mentions, full Markdown, a Health
  pane, export, and voice: a supervisor, "catch me up", point
  and speak, reviews by voice.
- **Conversation:** it carries on after a restart; past conversations; a context meter
  and Compact now; thinking harder when asked; incognito; a searchable action log;
  "undo that"; click-to-fix what Jarvis heard; your own personas with their own voice
  and wake word.
- **Voice:** echo cancellation so you can talk over it (off until you try it), a neural
  voice detector, Apple's on-device recognition, your own wake words, Voice and Speaking
  settings, and **Recognise my voice** (Settings › Listening: teach it your voice; it then
  ignores others, for everything or only risky actions, with no added delay).
- **Memory and knowledge:** facts with categories and sources, suggestions, About me, a
  daily journal and dreams, imports, standing intents, person cards and promises; search
  by meaning, OCR, more sources, Research v2.
- **Automation and heads-ups:** heartbeat, schedules and triggers, jobs, standing orders,
  webhooks, email rules, script hooks, timers and alarms; quiet hours that follow Focus,
  a briefing laid out your way and an evening wrap-up, weather and leave-time heads-ups,
  meeting notes and follow-ups, invitation clashes, Reminders by voice.
- **Actions:** email and texts in full, calendar invitations, orders and subscriptions,
  invoicing with Stripe links, places and weather anywhere, markets and price alerts,
  music by name, the Mac's switches, files and the clipboard with undo, reading the Mac,
  defense status, more connectors, background tasks, pictures, widgets, skills, local
  models, and JARVIS as an MCP server for other apps.
- **Built-in browser:** per-site permissions, real sign-in and payment popups, certificate
  warnings, tabs that come back, import from other browsers, PDFs, private tabs, a
  signed-out profile for JARVIS, split view and pop-out tabs; and page-aware requests, Ask
  Jarvis and Translate in the page's menu, questions across tabs, reader mode, page
  watchers, record and replay, a hand back at passwords and captchas (JARVIS never solves
  them), watch mode on bank, email and health sites, and hidden page text filtered out.
- **Reach:** Telegram, iMessage, Slack, Discord and WhatsApp (owner only, approvals in
  chat); the Jarvis number's texts and voicemail summaries; the menu bar, notifications
  with actions and `jarvis://` links; the iPhone and Watch app (TLS pinned, QR pairing,
  push approvals, widgets, Live Activities, Siri, share sheet; see `companion/README.md`,
  which also covers TestFlight).
- **Ops and distribution:** first-run setup, a checkup, a security review, verified
  backups, diagnostics; `cd app && npm run dist` builds a self-contained, signed and
  notarized disk image for other Apple-silicon Macs on macOS 14 or later, with signed
  updates (see `docs/distribution.md`). Testers use their own Anthropic API key.

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
  mouse and keyboard control. With Settings › Control my Mac without asking on (the
  default) JARVIS clicks, types, browses and runs Shortcuts unasked; with it off, one OK
  per request covers the mouse and keyboard. Either way a few presses are checked in code
  first (see [Safety](#safety)).
- **Research:** "Jarvis, research…" runs in the background and files a Markdown report
  in ~/Documents/Jarvis/Research, which also joins the second brain.
- **Model switching:** "use Sonnet" or the model chip. Opus, Sonnet, Haiku and Fable.
- **Morning briefing:** at a set time or with "Brief me": calendar, unread mail, BSH alerts
  and finished tasks.
- **Heads-ups:** JARVIS speaks up on its own: time to leave (live Apple Maps traffic to
  the next event's location), a meeting starting, low battery, rain within two hours,
  Jarvis Code done or waiting. Texts and email that matter interrupt at once (urgent
  words, a burst of messages, a VIP's); someone in Contacts, or someone you told it about
  ("remember Ann Lee is my co-founder"), counts for more, and the rest wait for "what did
  I miss?". Cards only during quiet hours or meeting notes (Settings › Speaking up).
- **Suggestions:** gentle cards, never acted on without your tap: what you usually ask
  around now, a prep doc for tomorrow's meetings with other people in them, an email due
  soon.
- **Memory:** "Jarvis, remember Ann is my co-founder." Facts ride along in every
  conversation; review and delete them in Settings › Memory. Passwords, keys and card
  numbers are refused.
- **Routines:** "every weekday at 7, brief me", "tonight at 1, research…". Listed in
  Settings › Routines with pause, run now and delete.
- **Meeting notes:** "Jarvis, take notes" transcribes the room on the Mac until "stop
  taking notes", then files a summary, decisions and action items in
  ~/Documents/Jarvis/Meetings and the second brain.
- **In your calls:** "Jarvis, join my next meeting" opens its Zoom, Meet or Teams link
  (after a card) and starts notes. A side panel shows who said what, with decisions,
  action items and open questions every minute or so; "what did they just say about
  pricing?" is answered privately there. "Tell them…" or "answer that" speaks a short
  reply into the call through a virtual audio route you set up (BlackHole or Loopback,
  Settings › Meetings); what JARVIS wrote itself shows first with 3 seconds to cancel.
  Afterwards: action items to Reminders or Calendar, and a follow-up draft. Tell the
  others notes are being taken.
- **Home & Shortcuts:** your Shortcuts reach HomeKit. Mark one instant and saying its
  name ("Jarvis, movie mode") runs it straight away.
- **What's this? (⌥⇧ Space):** JARVIS looks at the screen you're on and explains it.
- **Hands:** the Hands pill turns on camera hand control for the whole app: point and
  pinch to press, pinch and drag to scroll, swipe to change the look, hold an open palm
  to talk, hold a fist to stop. In the galaxy the same hands spin, zoom and open stars.

- **Tools & Accounts** (the link icon, top right): connect Notion, Linear, Jira &
  Confluence, monday, Todoist, Sentry, Vercel, Supabase, Hugging Face, Stripe, Zapier and
  Canva by signing in with your browser; GitHub with a personal access token; Gmail,
  Google Calendar, Google Drive, Asana and HubSpot with an OAuth app you create at that
  service (Google's connectors are a developer preview). "Add any tool" takes any MCP
  server URL or command. Read-only tools run freely; anything that changes data asks
  first, with "Always allow this" per tool, or set a service to Allow everything or
  Read-only. Tokens and sign-ins live in the macOS Keychain.

macOS will ask once each for Microphone, Calendars, Location, Automation (Mail,
Calendar, Notes, Music), Screen Recording (screenshots) and Accessibility (mouse and
keyboard); texts and email in the second brain need Full Disk Access. Grant them to
J.A.R.V.I.S. The app is signed with the BSH Ventures team certificate
(`app/scripts/finish-app.sh`), so the grants survive rebuilds.

## Terminal mode

```sh
uv run jarvis            # press Enter, speak, and it replies aloud
uv run jarvis --text     # type instead of speaking
uv run jarvis --mute     # no spoken replies
```

In voice mode you can also type a line instead of pressing Enter. Say or type `quit` to
leave.

## What it can do

"Control" below is Settings › Control my Mac without asking (on by default).

| Area | Tools | Asks first? |
| --- | --- | --- |
| Mac | open apps and web pages, Spotify / Apple Music, volume, Apple Notes, time and battery, list Shortcuts | no |
| Shortcuts | run a Shortcut by name | no with Control on; otherwise **yes** unless you made it instant ("Always") |
| Apps | quit an app | no with Control on; otherwise **yes** |
| Mouse and keyboard | see the screen, click, press buttons by name, type, press keys, scroll | no with Control on; otherwise one **yes** per request. The checks under [Safety](#safety) apply either way |
| Built-in browser | open pages, read, click, type, scroll | no with Control on (otherwise the mouse-and-keyboard OK), until a request has read your private data: see [Safety](#safety) |
| Purchases | buy, book or pay in the built-in browser | **yes**: one card with the merchant, amount and button, within your limits in Settings (another currency counts at today's exchange rate) |
| Mail | read the inbox, open a draft | no |
| Mail | send an email | **yes**: a card with the recipient and exact text, read aloud |
| Messages | send an iMessage or text | **yes**: a card with the recipient and exact text, read aloud |
| Calendar | read the schedule | no |
| Calendar | add, change or remove an event | **yes**: a card showing the event |
| Web | search, read pages | no, until a request has read something: see [Safety](#safety) |
| BSH | firm search, companies, profiles, decisions, portfolio, signal scores, transcripts, reference calls | no (read-only) |
| Windows | snap an app left / right / full screen | no |
| Jarvis Code | start a coding session (Claude Code) in a project folder | **yes** (voice coding goes ahead when you asked for it and named the project yourself), then each session asks as its mode says: Manual asks before every edit, command and browser action; Accept edits allows edits inside the project and pages on this Mac (localhost); Auto lets Claude Code's own classifier decide; Bypass never asks |

JARVIS's own conversation has Claude Code's coding tools (shell, file edits and so on)
switched off; coding happens only in the separate Jarvis Code sessions above. JARVIS
only loads its own MCP servers and ignores `~/.claude` settings. Email and web content
are treated as data, never as instructions.

## Safety

Some things are checked in code whatever the prompt says and however free the hands are:

- **What a request has read.** Once a request, or the conversation it's part of, has read
  your private data (mail, notes, files, texts, the calendar), anything that could carry
  it off the Mac asks first: fetching or opening a web address, starting research, and in
  the built-in browser typing into or pressing things on a site you didn't name in your
  own words this request. Typing shows its words on the card every time; a press that
  carries nothing asks once per site per request. A script run in a page, an address a
  tab is opened at, and an upload always ask then, named site or not; an upload asks
  even when nothing was read. After a web page (not private data), only sites you named
  go unasked, except that with Control on the browser follows links freely.
- **Purchases** happen only in the built-in browser, through one confirmation within your
  limits. With the mouse and keyboard anywhere else on the Mac, a button that buys, books
  or pays ("Buy", "Pay", "Place order", "Subscribe", "Transfer", a price like "$4.99",
  立即支付…) is refused, and JARVIS points to the built-in browser. A button is found
  first and pressed only once its name is checked.
- **Sending.** In a messaging or mail app (Messages, Mail, Slack, WhatsApp, Telegram,
  Discord, Outlook, WeChat and others, and their web versions, in the built-in browser
  too), pressing Send, Post, Publish, Delete or Submit, or Return in a chat's message box,
  shows the same kind of card as a message JARVIS sends for you: where it goes, the text,
  and a yes. Unless you asked for exactly that in your own words this request; and even
  then, once the conversation has read your data or a page, unless you named the
  conversation in full.
- **The built-in browser's pages** may go full screen; the camera, microphone, location,
  notifications and clipboard reading ask per site (Settings › Browser › Site permissions),
  and every other device permission stays refused. Its address bar opens
  `localhost:3000`, IP addresses and `[::1]` over http, opens `file:` only when you typed
  it yourself, and never opens `javascript:` or `data:`.
- **Passwords, card numbers and one-time codes:** the built-in browser never types a card
  number, or anything into a card, code, password or bank-login box (the purchase guard
  checks each field), and memory refuses them.

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

The calendar is read through EventKit (every account, repeating events included); the
AppleScript fallback, used until J.A.R.V.I.S. has calendar access, only reports a
repeating event on the day of its first occurrence.
