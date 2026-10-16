"""The eden-code command (jarvis/eden_code_cli.py): where it finds Eden Code and the token,
what each command sends to the local API (features/code_api.py, code_automate.py) and what it
prints, and its exit codes. The API is a stand-in here; tests/test_code_api.py runs the real
one with this command's client."""

import io
import json

import pytest

from jarvis import eden_code_cli as cli


class FakeClient:
    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        found = self.answers.get((method, path.split("?")[0]))
        if isinstance(found, Exception):
            raise found
        return found if found is not None else {}

    def lines(self, path):
        self.calls.append(("STREAM", path, None))
        yield from self.answers.get(("STREAM", path), [])


def run(argv, answers=None, stdin=""):
    client, out = FakeClient(answers), io.StringIO()
    code = cli.run(argv, client, out, io.StringIO(stdin))
    return code, out.getvalue(), client.calls


def test_the_address_from_the_environment_then_the_apps_file_then_the_default(tmp_path):
    assert (
        cli.find_url({"EDEN_CODE_URL": "http://127.0.0.1:9100/"}, tmp_path)
        == "http://127.0.0.1:9100"
    )
    assert cli.find_url({}, tmp_path) == cli.DEFAULT_URL
    (tmp_path / "code_api.json").write_text(json.dumps({"url": "http://127.0.0.1:9200"}))
    assert cli.find_url({}, tmp_path) == "http://127.0.0.1:9200"
    (tmp_path / "code_api.json").write_text(json.dumps({"url": "http://evil.example:80"}))
    assert cli.find_url({}, tmp_path) == cli.DEFAULT_URL  # (only ever this Mac's own address)


def test_the_token_from_the_environment_else_the_keychain():
    class Keychain:
        asked = []

        def get_password(self, service, name):
            self.asked.append((service, name))
            return " edc_from_keychain "

    chain = Keychain()
    assert cli.find_token({"EDEN_CODE_TOKEN": "edc_env"}, chain) == "edc_env"
    assert chain.asked == []
    assert cli.find_token({}, chain) == "edc_from_keychain"
    assert chain.asked == [("Jarvis connectors", "code-api:token")]


def test_start_sends_what_was_asked_and_says_which_session():
    answers = {("POST", "/v1/sessions"): {"started": True, "session": {"id": 7, "folder": "app"}}}
    code, out, calls = run(
        [
            "start",
            "--project",
            "app",
            "--prompt",
            "Add a retry",
            "--mode",
            "edits",
            "--isolated",
            "--untrusted",
        ],
        answers,
    )
    assert code == 0 and out.strip() == "Started session 7 in app."
    assert calls == [
        (
            "POST",
            "/v1/sessions",
            {
                "project": "app",
                "prompt": "Add a retry",
                "mode": "edits",
                "isolated": True,
                "untrusted": True,
            },
        )
    ]


def test_a_mode_past_accept_edits_isnt_even_offered():
    with pytest.raises(SystemExit):
        run(["start", "--project", "app", "--prompt", "x", "--mode", "auto"])


def test_the_prompt_from_stdin():
    _code, _out, calls = run(["send", "3", "-"], stdin="Now add a test\n")
    assert calls == [("POST", "/v1/sessions/3/messages", {"text": "Now add a test\n"})]


def test_sessions_and_tail_print_lines():
    answers = {
        ("GET", "/v1/sessions"): {
            "sessions": [
                {
                    "id": 3,
                    "status": "waiting",
                    "folder": "app",
                    "title": "Add a retry",
                    "cost_usd": 0.42,
                }
            ]
        },
        ("GET", "/v1/sessions/3/transcript"): {"entries": [{"role": "assistant", "text": "Done."}]},
    }
    _c, out, _calls = run(["sessions"], answers)
    assert "Add a retry" in out and "$0.42" in out and "waiting" in out
    _c, out, calls = run(["tail", "3", "-n", "5"], answers)
    assert out.strip() == "[assistant] Done." and calls[0][1] == "/v1/sessions/3/transcript?tail=5"


def test_land_and_friends_and_json_out():
    answers = {
        ("POST", "/v1/sessions/3/land"): {"id": 3, "asked": "on its card in the Eden Code window"}
    }
    _c, out, calls = run(["land", "3"], answers)
    assert calls == [("POST", "/v1/sessions/3/land", {})] and "card" in out
    _c, out, _calls = run(["--json", "land", "3"], answers)
    assert json.loads(out)["asked"].startswith("on its card")


def test_attention_says_the_summary():
    answers = {
        ("GET", "/v1/attention"): {
            "count": 1,
            "summary": "One thing is waiting for you: x.",
            "items": [{"said": "x"}],
        }
    }
    _c, out, _calls = run(["attention", "--say"], answers)
    assert out.strip() == "One thing is waiting for you: x."


def test_events_print_json_lines():
    answers = {("STREAM", "/v1/events"): [{"type": "hello"}, {"type": "ping"}]}
    _c, out, _calls = run(["events"], answers)
    assert [json.loads(line)["type"] for line in out.splitlines()] == ["hello", "ping"]


def test_watch_schedule_and_webhook_bodies():
    _c, _o, calls = run(
        [
            "watch",
            "app",
            "src/**/*.py",
            "Run the tests",
            "--command",
            "npm test",
            "--spend-cap",
            "3",
        ]
    )
    assert calls[0] == (
        "POST",
        "/v1/watches",
        {
            "project": "app",
            "prompt": "Run the tests",
            "commands": ["npm test"],
            "spend_cap": 3.0,
            "glob": "src/**/*.py",
        },
    )
    _c, _o, calls = run(
        ["schedule", "app", "Nightly", "--kind", "weekly", "--time", "01:00", "--days", "1,5"]
    )
    assert calls[0][2]["schedule"] == {"kind": "weekly", "time": "01:00", "days": [1, 5]}
    _c, _o, calls = run(["webhook", "deploy", "app", "Fix the deploy"])
    assert calls[0][2]["sandbox"] is True and calls[0][2]["name"] == "deploy"


def test_exit_codes(monkeypatch, capsys):
    monkeypatch.setattr(cli, "find_token", lambda: "")
    assert cli.main(["status"]) == 3
    assert "no API token" in capsys.readouterr().err
    monkeypatch.setattr(cli, "find_token", lambda: "edc_x")

    class Refusing(FakeClient):
        def call(self, method, path, body=None):
            raise cli.Said(400, "mode is ask, plan or edits")

    monkeypatch.setattr(cli, "Client", lambda *a, **k: Refusing())
    assert cli.main(["status"]) == 1
    assert "mode is ask" in capsys.readouterr().err

    class Gone(FakeClient):
        def call(self, method, path, body=None):
            raise cli.Unreachable("connection refused")

    monkeypatch.setattr(cli, "Client", lambda *a, **k: Gone())
    assert cli.main(["status"]) == 3
    assert "can't reach Eden Code" in capsys.readouterr().err
    assert cli.main(["nonsense"]) == 2
