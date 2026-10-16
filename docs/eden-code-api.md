# Eden Code from code: the local API and `eden-code`

Scripts, CI running on this Mac and other agents can drive Eden Code the way the window
does: list sessions, start one, send it a message, read its transcript, stop it, ask to land
or discard its isolated copy, run Exterminator Mode, add to-do cards, read the Needs
attention inbox and follow events as JSON lines. Watches, schedules and signed webhooks start
runs without you.

Everything here is **off until you turn it on**, each part on a card of its own with Touch ID.

## Turning it on

Eden Code settings › General › **Control from code**:

- **Programs on this Mac**: the API. Turning it on shows its scope on a card (Touch ID);
  the first time, it makes your API token and keeps it in the Keychain (item
  `Jarvis connectors`, account `code-api:token`). **Show** shows it, **Regenerate** makes a
  new one (the old one stops working at once).
- **Port**: 8767 unless you choose another; it stays the same across launches.
- **The eden-code command › Install**: writes `~/.local/bin/eden-code`, which runs Eden Code's
  own Python. In the repo, `uv run eden-code …` works without installing.
- **Watches and webhooks**: their own switch and card (see below).

## Who can call it

- It listens on `127.0.0.1` only. Nothing on the network can reach it.
- Every request needs `Authorization: Bearer <token>`.
- A request whose `Host` isn't `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, or
  that carries an `Origin` header (any web page), is refused before its token is looked at.
  A `POST` must be `Content-Type: application/json`.
- 20 wrong tokens in 10 minutes lock wrong tokens out for 10 minutes (the right one still
  gets in). All callers together get 240 requests a minute.

## What it can and can't do

Each request becomes the window's own command, so every gate and cap the window has applies:
your spending caps, the projects folder, the limit on open sessions, the isolation and
lock-down rules, the cards.

- **Never Auto or Bypass permissions.** A session or card is Ask, Plan or Accept edits. With
  no mode given it's the project's default when that is one of those three, else Ask.
- **Never a slash command.** `/bypass`, `/clear` and the like are typed by you in the window.
- **Never answers a card.** Landing, discarding and Exterminator Mode put their usual card up
  in the window (with Touch ID where the window asks for it); the API only asks.
- A session started from the API makes a quiet heads-up ("A program on this Mac started a
  session in app.").
- `untrusted: true` starts a session locked down, as a GitHub issue's is: use it when the
  prompt is someone else's words (an issue, a ticket, a log).

## Endpoints

All under `http://127.0.0.1:8767/v1`. Errors are `{"error": "…"}` with a 4xx status.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /status` | | `{ok, app, sessions, working, attention}` |
| `GET /sessions` | | `{sessions: [{id, title, folder, status, busy, mode, model, cost_usd, last_action, result, files_changed, workspace…}]}` |
| `GET /sessions/<id>` | | one session |
| `GET /sessions/<id>/transcript?tail=N` | | `{id, entries: [{n, role, text, at…}]}` (N ≤ 200) |
| `POST /sessions` | `{project, prompt, mode?, model?, title?, isolated?, cloud?, untrusted?}` | 201 `{started: true, session}`, or 202 `{started: false, launch_token}` while a card or the cloud holds it |
| `POST /sessions/<id>/messages` | `{text}` | 202 |
| `POST /sessions/<id>/stop` | `{}` | 202: stops the step under way |
| `POST /sessions/<id>/end` | `{}` | 202: ends the session |
| `POST /sessions/<id>/land` | `{}` | 202: its card is up in the window |
| `POST /sessions/<id>/discard` | `{}` | 202: its card is up in the window |
| `POST /exterminate` | `{project, spend_cap?, focus?}` | 202: Exterminator Mode's card is up |
| `POST /todos` | `{project, prompt, title?, model?, mode?}` | 202 `{added: <card id>}` |
| `GET /attention` | | `{items, count, summary}` (the Needs attention inbox) |
| `GET /events` | | JSON lines (below) |
| `GET /schedules`, `POST /schedules` | `{project, prompt, schedule: {kind: daily\|weekdays\|weekly\|once, time: "HH:MM", days?, date?}, commands?, spend_cap?, hours?, title?}` | waits for its card; `{said, scheduled}` |
| `GET /watches`, `POST /watches`, `DELETE /watches/<id>` | `{project, glob, prompt, commands?, spend_cap?, hours?, title?}` | waits for its card; 201 `{said, watch}` |
| `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/<id>` | `{name, project, prompt, commands?, spend_cap?, hours?, sandbox?}` | waits for its card; 201 `{said, hook, secret, path, port}` |

`project` is a project's name in your projects folder (or one you added), as the window shows
it, or its folder's path.

### Events

`GET /v1/events` streams one JSON object a line, starting with `{"type": "hello", …status}`:

- `{"type": "sessions", "sessions": [...]}`: the list changed
- `{"type": "entry", "id": 3, "entry": {n, role, text, at…}}`: a transcript entry
- `{"type": "finished", "id": 3, "status": "done", "result": "…", "files": [...]}`
- `{"type": "approval", "id": "…", "task": 3, "question": "…"}` and `{"type": "approval_resolved", "id": "…"}`
- `{"type": "attention", "count": 2, "summary": "…", "items": [...]}`
- `{"type": "code_bugfix"}`, `{"type": "code_runs"}`, `{"type": "todo_state"}`: something changed there
- `{"type": "ping"}` every 15 seconds while it's quiet

Only Eden Code's own events: nothing of your mail, calendar, messages or chats. At most 8
streams at once; one that falls 1,000 events behind is closed (reconnect).

## The `eden-code` command

```sh
eden-code status
eden-code sessions
eden-code start --project app --prompt "Add a retry to the uploader" --mode edits --isolated
eden-code send 3 "Now add a test for it"
echo "a long prompt" | eden-code start --project app --prompt -
eden-code tail 3 -n 40 --follow
eden-code stop 3        # the step under way
eden-code end 3         # the session
eden-code land 3        # its card comes up in the window
eden-code exterminate app --spend-cap 10
eden-code todo app "Write the migration" --title "Migration"
eden-code attention --say
eden-code events | jq .
eden-code schedule app "Run the tests and fix what fails" --kind daily --time 01:00 --command "npm test"
eden-code watch app "src/**/*.py" "Run the tests and fix what fails" --command "uv run pytest"
eden-code webhook deploy-failed app "Find why the deploy failed and fix it"
```

`--json` prints the API's answer as JSON. Where it finds Eden Code: `EDEN_CODE_URL`, else the
address the app wrote to `code_api.json` in its data folder, else `http://127.0.0.1:8767`. The
token: `EDEN_CODE_TOKEN`, else the Keychain. Exit codes: 0 done, 1 the API said no (its reason
on stderr), 2 a wrong command line, 3 Eden Code can't be reached (or no token).

## Watches, schedules and webhooks

All three start **runs without you** (the same as "Run this without me"): in an isolated copy
of the project, in Accept edits, with only the commands you list beyond the read-only ones,
capped in dollars (default $5) and hours (default 2), never pushing or sending anything off
the Mac. Each is set up on that card, with its whole scope, once. Turn on **Watches and
webhooks** first (its own card, Touch ID); turning it off stops them all.

- **Schedules**: a routine that starts the run when it's due (`daily`, `weekdays`, `weekly`,
  `once`), as "Run this without me" schedules one.
- **Watches**: a project and a pattern of its files (`src/**/*.py`; `*` crosses folders; `.git`,
  `node_modules`, `.venv`, `dist`, `build` and the like are never looked in; up to 5,000
  files). Every 5 seconds the matching files' sizes and times are compared; a change that's
  still the same at the next look starts the run, with the changed files named in its prompt.
  One run of a watch at a time, at least 10 minutes apart, at most 6 a day.
- **Webhooks**: `POST http://127.0.0.1:8768/hooks/eden-code-hook?hook=<id>` (the port is
  `code_hooks_port`; it listens only while there's a webhook and the switch is on). The body
  (JSON or text, up to 64 KB) is added to your prompt **as data** (someone else's words), and
  the run is locked down as a Linear ticket's is: none of your settings, hooks, MCP servers or
  web tools, its commands in a sandbox without network unless you said otherwise. One run of a
  hook at a time, at most 10 a day.

### Signing a webhook delivery

Each hook has its own secret (`whsec_…`, made with it, kept in the Keychain; Settings shows
it when asked). Sign as GitHub does:

```
X-Eden-Timestamp: <Unix seconds, within 5 minutes of now>
X-Eden-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>." + body, keyed by the secret>
```

```sh
BODY='{"text":"the deploy failed"}'
TS=$(date +%s)
SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$EDEN_HOOK_SECRET" | sed "s/^.* //")
curl -X POST "http://127.0.0.1:8768/hooks/eden-code-hook?hook=<id>" \
  -H "X-Eden-Timestamp: $TS" -H "X-Eden-Signature: sha256=$SIG" -d "$BODY"
```

Answers: 202 started; 200 `{started: false}` for a delivery already had (each counts once,
remembered across a restart); 401 a bad or stale signature; 403 a web page (an `Origin`
header); 404 an unknown hook or the switch off; 409 a run of this hook still going; 413 too
big; 429 too many bad signatures, or today's runs used up.

To reach it from outside this Mac, run a tunnel to that port only
(`cloudflared tunnel --url http://127.0.0.1:8768`); it carries nothing but the hooks.

## Cost

The API itself calls no model. A session it starts is an ordinary Eden Code session on its
model, under your spending caps. Watch, schedule and webhook runs are capped by the scope you
approved, and a day.
