"""eden-code: Eden Code from the command line, for scripts, CI on this Mac and other agents.

It speaks Eden Code's local API (features/code_api.py, docs/eden-code-api.md): the app must
be running, with Settings › Eden Code › Control from code turned on. Where it is: EDEN_CODE_URL,
else the address the app wrote to code_api.json in its data folder, else
http://127.0.0.1:8767. The token: EDEN_CODE_TOKEN, else the Keychain (the item the app keeps
it in: "Jarvis connectors", code-api:token). It's never printed.

    eden-code status
    eden-code sessions
    eden-code start --project app --prompt "Add a retry to the uploader" [--mode edits]
    eden-code send 3 "Now add a test for it"
    eden-code tail 3 [-n 40] [--follow]
    eden-code stop 3 | end 3 | land 3 | discard 3
    eden-code exterminate app [--spend-cap 10]
    eden-code todo app "Write the migration" [--title …]
    eden-code attention [--say]
    eden-code events
    eden-code schedule app "Run the tests and fix what fails" --kind daily --time 01:00
    eden-code watch app "src/**/*.py" "Run the tests and fix what fails"
    eden-code webhook deploy-failed app "Find why the deploy failed and fix it"

--json prints what the API answered, as it answered it. Exit codes: 0 done, 1 the API said
no (its reason on stderr), 2 a wrong command line, 3 Eden Code couldn't be reached.

Standard library only (and keyring, when it's there, for the Keychain).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_URL = "http://127.0.0.1:8767"
KEYCHAIN = ("Jarvis connectors", "code-api:token")


class Unreachable(Exception):
    pass


class Said(Exception):
    """The API answered with an error: (status, its words)."""

    def __init__(self, status: int, why: str) -> None:
        super().__init__(why)
        self.status, self.why = status, why


def data_folder() -> Path:
    from .osplat import app_support

    return app_support()


def find_url(env: dict[str, str] | None = None, folder: Path | None = None) -> str:
    env = os.environ if env is None else env
    if env.get("EDEN_CODE_URL"):
        return env["EDEN_CODE_URL"].rstrip("/")
    try:
        found = json.loads(((folder or data_folder()) / "code_api.json").read_text())
        url = str(found.get("url") or "")
        if url.startswith("http://127.0.0.1:"):
            return url.rstrip("/")
    except (OSError, ValueError, AttributeError):
        pass
    return DEFAULT_URL


def find_token(env: dict[str, str] | None = None, keychain: Any = None) -> str:
    env = os.environ if env is None else env
    if env.get("EDEN_CODE_TOKEN"):
        return env["EDEN_CODE_TOKEN"].strip()
    try:
        if keychain is None:
            import keyring as keychain  # type: ignore[no-redef]
        return (keychain.get_password(*KEYCHAIN) or "").strip()
    except Exception:
        return ""


class Client:
    def __init__(self, url: str, token: str, timeout: float = 330.0, opener: Any = None) -> None:
        self.url, self.token, self.timeout = url.rstrip("/"), token, timeout
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.url}{path}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            return self.opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            try:
                why = json.loads(exc.read() or b"{}").get("error") or exc.reason
            except (ValueError, AttributeError):
                why = exc.reason
            raise Said(exc.code, str(why)) from None
        except (urllib.error.URLError, OSError) as exc:
            raise Unreachable(str(getattr(exc, "reason", exc))) from None

    def call(self, method: str, path: str, body: Any = None) -> Any:
        with self._request(method, path, body) as answer:
            return json.loads(answer.read() or b"{}")

    def lines(self, path: str) -> Any:
        """A stream's JSON lines, as they come."""
        answer = self._request("GET", path)
        with answer:
            for raw in answer:
                raw = raw.strip()
                if raw:
                    yield json.loads(raw)


def _say(out: Any, text: str) -> None:
    out.write(text + "\n")
    out.flush()


def _session_line(s: dict[str, Any]) -> str:
    state = "working" if s.get("busy") else s.get("status", "")
    title = str(s.get("title") or s.get("prompt") or "New session").split("\n")[0][:70]
    cost = f" ${s['cost_usd']:.2f}" if isinstance(s.get("cost_usd"), int | float) else ""
    return f"{s.get('id'):>4}  {state:<9} {s.get('folder', ''):<20} {title}{cost}"


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="eden-code", description="Control Eden Code from scripts.")
    p.add_argument(
        "--url", help=f"the API's address (default: what Eden Code wrote, or {DEFAULT_URL})"
    )
    p.add_argument("--json", action="store_true", help="print the API's answers as JSON")
    p.add_argument("--timeout", type=float, default=330.0, help="seconds to wait for an answer")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="whether Eden Code is there, and how many sessions")
    sub.add_parser("sessions", help="every session and how it stands")
    s = sub.add_parser("show", help="one session")
    s.add_argument("id", type=int)
    s = sub.add_parser("start", help="start a session")
    s.add_argument("--project", required=True)
    s.add_argument("--prompt", required=True, help="what it should do ('-' reads it from stdin)")
    s.add_argument("--model")
    s.add_argument("--mode", choices=("ask", "plan", "edits"))
    s.add_argument("--title")
    iso = s.add_mutually_exclusive_group()
    iso.add_argument("--isolated", dest="isolated", action="store_true", default=None)
    iso.add_argument("--shared", dest="isolated", action="store_false")
    s.add_argument("--cloud", action="store_true")
    s.add_argument(
        "--untrusted", action="store_true", help="the prompt is someone else's words: lock it down"
    )
    s = sub.add_parser("send", help="send a session a message")
    s.add_argument("id", type=int)
    s.add_argument("text", help="the message ('-' reads it from stdin)")
    s = sub.add_parser("tail", help="a session's last transcript entries")
    s.add_argument("id", type=int)
    s.add_argument("-n", type=int, default=20)
    s.add_argument("--follow", "-f", action="store_true")
    for name, what in (("stop", "stop the step under way"), ("end", "end the session"),
                       ("land", "land its isolated copy (asks in the window)"),
                       ("discard", "discard its isolated copy (asks in the window)")):  # fmt: skip
        s = sub.add_parser(name, help=what)
        s.add_argument("id", type=int)
    s = sub.add_parser("exterminate", help="Exterminator Mode on a project (asks in the window)")
    s.add_argument("project")
    s.add_argument("--spend-cap", type=float)
    s.add_argument("--focus")
    s = sub.add_parser("todo", help="add a to-do card")
    s.add_argument("project")
    s.add_argument("prompt")
    s.add_argument("--title")
    s.add_argument("--model")
    s.add_argument("--mode", choices=("ask", "plan", "edits"))
    s = sub.add_parser("attention", help="what's waiting for you")
    s.add_argument("--say", action="store_true", help="just the one-sentence summary")
    sub.add_parser("events", help="events as JSON lines, as they happen")
    s = sub.add_parser("schedule", help="a run without you on a schedule (asks in the window)")
    s.add_argument("project")
    s.add_argument("prompt")
    s.add_argument("--kind", required=True, choices=("daily", "weekdays", "weekly", "once"))
    s.add_argument("--time", required=True, help="HH:MM")
    s.add_argument("--days", help="weekly: 1-7 (Monday is 1), comma separated")
    s.add_argument("--date", help="once: YYYY-MM-DD")
    _run_options(s)
    sub.add_parser("schedules", help="the scheduled runs")
    s = sub.add_parser("watch", help="a run whenever files change (asks in the window)")
    s.add_argument("project")
    s.add_argument("glob", help='files in the project, like "src/**/*.py"')
    s.add_argument("prompt")
    _run_options(s)
    sub.add_parser("watches", help="the watches")
    s = sub.add_parser("unwatch", help="remove a watch")
    s.add_argument("id")
    s = sub.add_parser("webhook", help="a webhook that starts a run (asks in the window)")
    s.add_argument("name")
    s.add_argument("project")
    s.add_argument("prompt")
    s.add_argument("--network", action="store_true", help="its commands may use the network")
    _run_options(s)
    sub.add_parser("webhooks", help="the webhooks")
    s = sub.add_parser("rm-webhook", help="remove a webhook")
    s.add_argument("id")
    return p


def _run_options(s: argparse.ArgumentParser) -> None:
    s.add_argument("--title")
    s.add_argument(
        "--command",
        dest="commands",
        action="append",
        default=[],
        help="a command it may run (again for more)",
    )
    s.add_argument("--spend-cap", type=float)
    s.add_argument("--hours", type=float)


def _scope(args: argparse.Namespace) -> dict[str, Any]:
    out: dict[str, Any] = {
        "project": args.project,
        "prompt": args.prompt,
        "commands": args.commands,
    }
    for key in ("title", "spend_cap", "hours"):
        if getattr(args, key, None) is not None:
            out[key] = getattr(args, key)
    return out


def _stdin(value: str, stdin: Any) -> str:
    return stdin.read() if value == "-" else value


def run(argv: list[str], client: Client, out: Any, stdin: Any = None) -> int:
    args = parser().parse_args(argv)
    stdin = stdin or sys.stdin
    show_json = args.json

    def done(answer: Any, text: str = "") -> int:
        _say(out, json.dumps(answer, indent=2) if show_json or not text else text)
        return 0

    c = args.command
    if c == "status":
        a = client.call("GET", "/v1/status")
        return done(a, f"Eden Code: {a.get('sessions', 0)} sessions, {a.get('working', 0)} working, "
                       f"{a.get('attention', 0)} waiting for you.")  # fmt: skip
    if c == "sessions":
        a = client.call("GET", "/v1/sessions")
        return done(a, "\n".join(_session_line(s) for s in a.get("sessions", [])) or "No sessions.")
    if c == "show":
        return done(client.call("GET", f"/v1/sessions/{args.id}"))
    if c == "start":
        body: dict[str, Any] = {"project": args.project, "prompt": _stdin(args.prompt, stdin)}
        for key in ("model", "mode", "title", "isolated"):
            if getattr(args, key) is not None:
                body[key] = getattr(args, key)
        if args.cloud:
            body["cloud"] = True
        if args.untrusted:
            body["untrusted"] = True
        a = client.call("POST", "/v1/sessions", body)
        started = a.get("session") or {}
        return done(a, f"Started session {started.get('id')} in {started.get('folder', args.project)}." if a.get("started")
                    else a.get("note", "Asked."))  # fmt: skip
    if c == "send":
        a = client.call(
            "POST", f"/v1/sessions/{args.id}/messages", {"text": _stdin(args.text, stdin)}
        )
        return done(a, f"Sent to session {args.id}.")
    if c == "tail":
        a = client.call("GET", f"/v1/sessions/{args.id}/transcript?tail={max(1, args.n)}")
        if show_json:
            done(a)
        else:
            for e in a.get("entries", []):
                _say(out, f"[{e.get('role')}] {e.get('text', '')}")
        if args.follow:
            for ev in client.lines("/v1/events"):
                if ev.get("type") == "entry" and ev.get("id") == args.id:
                    e = ev.get("entry") or {}
                    _say(
                        out,
                        json.dumps(e) if show_json else f"[{e.get('role')}] {e.get('text', '')}",
                    )
        return 0
    if c in ("stop", "end", "land", "discard"):
        a = client.call("POST", f"/v1/sessions/{args.id}/{c}", {})
        return done(
            a, a.get("asked") and f"Asked: {a['asked']}." or f"Session {args.id}: {c} sent."
        )
    if c == "exterminate":
        body = {"project": args.project}
        if args.spend_cap is not None:
            body["spend_cap"] = args.spend_cap
        if args.focus:
            body["focus"] = args.focus
        a = client.call("POST", "/v1/exterminate", body)
        return done(a, f"Asked: {a.get('asked')}.")
    if c == "todo":
        body = {"project": args.project, "prompt": _stdin(args.prompt, stdin)}
        for key in ("title", "model", "mode"):
            if getattr(args, key):
                body[key] = getattr(args, key)
        a = client.call("POST", "/v1/todos", body)
        return done(a, f"Added card {a.get('added')}.")
    if c == "attention":
        a = client.call("GET", "/v1/attention")
        if args.say and not show_json:
            return done(a, a.get("summary", ""))
        lines = [f"- {i.get('said')}" for i in a.get("items", [])]
        return done(a, "\n".join([a.get("summary", ""), *lines]) if lines else a.get("summary", ""))
    if c == "events":
        for ev in client.lines("/v1/events"):
            _say(out, json.dumps(ev))
        return 0
    if c == "schedule":
        schedule: dict[str, Any] = {"kind": args.kind, "time": args.time}
        if args.days:
            schedule["days"] = [int(d) for d in args.days.split(",") if d.strip()]
        if args.date:
            schedule["date"] = args.date
        a = client.call("POST", "/v1/schedules", {**_scope(args), "schedule": schedule})
        return done(a, a.get("said", ""))
    if c == "schedules":
        a = client.call("GET", "/v1/schedules")
        return done(a, "\n".join(f"{j['id']}  {j['project']:<20} {j['title']}" for j in a.get("schedules", []))
                    or "No scheduled runs.")  # fmt: skip
    if c == "watch":
        a = client.call("POST", "/v1/watches", {**_scope(args), "glob": args.glob})
        return done(a, a.get("said", ""))
    if c == "watches":
        a = client.call("GET", "/v1/watches")
        return done(a, "\n".join(f"{w['id']}  {w['project']:<20} {w['glob']}" for w in a.get("watches", []))
                    or "No watches.")  # fmt: skip
    if c == "unwatch":
        a = client.call("DELETE", f"/v1/watches/{args.id}")
        return done(a, "Removed." if a.get("removed") else "No such watch.")
    if c == "webhook":
        a = client.call(
            "POST", "/v1/webhooks", {**_scope(args), "name": args.name, "sandbox": not args.network}
        )
        if show_json:
            return done(a)
        port = a.get("port")
        return done(a, f"{a.get('said')}\nPOST http://127.0.0.1:{port}{a.get('path')}\nSecret (shown once here; "
                       f"Settings shows it again): {a.get('secret')}")  # fmt: skip
    if c == "webhooks":
        a = client.call("GET", "/v1/webhooks")
        return done(a, "\n".join(f"{h['id']}  {h['name']:<20} {h['project']:<20} {h['path']}"
                                 for h in a.get("hooks", [])) or "No webhooks.")  # fmt: skip
    if c == "rm-webhook":
        a = client.call("DELETE", f"/v1/webhooks/{args.id}")
        return done(a, "Removed." if a.get("removed") else "No such webhook.")
    return 2


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        args, _rest = parser().parse_known_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0) if exc.code in (0, None) else 2
    url = args.url or find_url()
    token = find_token()
    if not token:
        sys.stderr.write(
            "eden-code: no API token. Turn on Settings › Eden Code › Control from code, or set "
            "EDEN_CODE_TOKEN.\n"
        )
        return 3
    client = Client(url, token, timeout=args.timeout)
    try:
        return run(argv, client, sys.stdout)
    except SystemExit as exc:
        return 2 if exc.code not in (0, None) else 0
    except Said as exc:
        sys.stderr.write(f"eden-code: {exc.why} ({exc.status})\n")
        return 1
    except Unreachable as exc:
        sys.stderr.write(
            f"eden-code: can't reach Eden Code at {url} ({exc}). Is it open, with Control from "
            "code turned on?\n"
        )
        return 3
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
