"""The checkup's checks one by one (jarvis.features.ops.doctor), the permissions helper's
answers (tcc, permissions) and the masking of what's shown (redact): every command faked,
every folder a temp one."""

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from jarvis.features.ops import doctor, permissions, redact, tcc

NOW = datetime(2026, 9, 29, 20, 15, 12)


def probe(tmp_path, run=None, **extra):
    async def no_commands(*args, timeout=20.0, env=None):
        raise AssertionError(f"unexpected command {args}")

    return doctor.Probe(
        data=tmp_path / "data",
        logs=tmp_path / "logs",
        home=tmp_path / "home",
        run=run or no_commands,
        now=lambda: NOW,
        own_pid=100,
        **extra,
    )


def answers(table):
    calls = []

    async def run(*args, timeout=20.0, env=None):
        calls.append(args)
        for key, value in table.items():
            if args[: len(key)] == key:
                if isinstance(value, Exception):
                    raise value
                return value
        raise AssertionError(f"unexpected command {args}")

    run.calls = calls
    return run


# ── permissions ──


async def test_the_helper_answer_becomes_rows_with_hints_and_panes():
    found = {
        "microphone": "granted",
        "calendars": "limited",
        "contacts": "denied",
        "location": "off",
        "screen": "off",
        "accessibility": "restricted",
        "full_disk": "sure!",  # anything unexpected is unknown
        "automation": {"com.apple.mail": "denied", "com.apple.iCal": "granted"},
    }
    run = answers({("python",): (0, json.dumps(found), "")})

    async def as_python(*args, timeout=20.0, env=None):
        return await run("python", *args[1:], timeout=timeout)

    got = await permissions.statuses(as_python)
    rows = {r["id"]: r for r in permissions.rows(got)}
    assert rows["microphone"]["hint"] == ""
    assert rows["calendars"]["hint"].startswith("Jarvis can add events but not read them")
    assert rows["contacts"]["hint"].endswith("Privacy & Security › Contacts.")
    assert rows["location"]["hint"].startswith("Location Services are off for the whole Mac")
    assert rows["accessibility"]["label"] == "Restricted on this Mac"
    assert rows["full_disk"]["state"] == "unknown"
    assert rows["automation"]["state"] == "denied"  # the worst of its apps
    assert {a["app"]: a["state"] for a in rows["automation"]["apps"]} == {
        "Mail": "denied",
        "Calendar": "granted",
        "Notes": "unknown",
        "Music": "unknown",
    }
    assert permissions.settings_url("full_disk") == (
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    )
    assert permissions.settings_url("../../etc") is None


@pytest.mark.parametrize(
    "failure", [OSError("gone"), TimeoutError(), (1, "", "crashed"), (0, "not json", "")]
)
async def test_a_helper_that_fails_says_unknown_never_granted(failure):
    async def run(*args, timeout=20.0, env=None):
        if isinstance(failure, Exception):
            raise failure
        return failure

    got = await permissions.statuses(run)
    assert got["microphone"] == "unknown" and got["error"]
    assert set(got["automation"].values()) == {"unknown"}


def test_automation_is_as_good_as_its_worst_app():
    state = permissions.automation_state
    assert state({"a": "granted", "b": "not_running"}) == "granted"
    assert state({"a": "not_running", "b": "not_running"}) == "not_running"
    assert state({"a": "granted", "b": "not_asked"}) == "not_asked"
    assert state({"a": "denied", "b": "not_asked"}) == "denied"
    assert state({}) == "not_running"


def test_the_helper_process_prints_one_json_line(monkeypatch, capsys):
    for name in list(tcc.CHECKS):
        monkeypatch.setitem(tcc.CHECKS, name, lambda: "granted")

    def automation(app):
        if app == "com.apple.Music":
            raise OSError("framework missing")
        return "not_running"

    monkeypatch.setattr(tcc, "automation", automation)
    tcc.main(["com.apple.mail", "com.apple.Music"])
    out = json.loads(capsys.readouterr().out)
    assert out["microphone"] == "granted"
    assert out["automation"] == {"com.apple.mail": "not_running", "com.apple.Music": "unknown"}


def test_full_disk_access_is_told_by_what_opens(tmp_path):
    assert tcc.full_disk(tmp_path) == "unknown"  # neither folder there: can't tell
    (tmp_path / "Library" / "Mail").mkdir(parents=True)
    assert tcc.full_disk(tmp_path) == "granted"
    messages = tmp_path / "Library" / "Messages"
    messages.mkdir()
    os.chmod(messages, 0)
    try:
        assert tcc.full_disk(tmp_path) == "off"
    finally:
        os.chmod(messages, 0o700)


# ── Claude ──


async def test_claude_signed_in_names_the_plan_never_the_account(tmp_path):
    run = answers(
        {
            ("/c", "--version"): (0, "2.1.284 (Claude Code)\n", ""),
            ("/c", "auth", "status"): (
                0,
                'noise\n{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "pro", '
                '"email": "ann@example.com", "orgName": "Ann Co"}\n',
                "",
            ),
        }
    )
    got = await doctor.claude_check(probe(tmp_path, run, claude_cli=lambda: "/c"))
    assert got["state"] == "ok" and got["summary"] == "Signed in" and got["meta"] == "Pro · 2.1.284"
    assert "ann" not in json.dumps(got).lower()


async def test_claude_signed_out_gives_the_command_to_sign_in(tmp_path):
    run = answers(
        {
            ("/c", "--version"): (0, "2.1.284 (Claude Code)", ""),
            ("/c", "auth", "status"): (1, '{"loggedIn": false}', ""),
        }
    )
    got = await doctor.claude_check(
        probe(tmp_path, run, claude_cli=lambda: "/c", login_command=lambda cli: f"{cli} auth login")
    )
    assert got["state"] == "problem" and got["command"] == "/c auth login"
    assert "Claude Code" not in json.dumps(got)  # the product is Jarvis Code, never Claude Code


async def test_claude_missing_or_silent(tmp_path):
    got = await doctor.claude_check(probe(tmp_path, claude_cli=lambda: None))
    assert got["state"] == "problem"
    run = answers({("/c",): TimeoutError()})
    got = await doctor.claude_check(probe(tmp_path, run, claude_cli=lambda: "/c"))
    assert got["state"] == "unknown"


def test_the_login_command_quotes_a_path_with_spaces(monkeypatch):
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    assert doctor.login_command("/Users/a b/claude") == "'/Users/a b/claude' auth login"
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/usr/local/bin/claude")
    assert doctor.login_command("/x/claude") == "claude auth login"


# ── the speech model, swiftc, disk, the port ──


def test_the_speech_model(tmp_path):
    assert doctor.whisper_check(probe(tmp_path), "base.en", True)["summary"] == "Loaded"
    cached = probe(tmp_path, whisper_cached=lambda name: True)
    assert doctor.whisper_check(cached, "base.en", False)["summary"] == "Downloaded"
    missing = probe(tmp_path, whisper_cached=lambda name: False)
    got = doctor.whisper_check(missing, "small", False)
    assert got["state"] == "warn" and got["meta"] == "small"


async def test_swiftc_asks_xcode_select_first_never_the_stub(tmp_path):
    run = answers(
        {("xcode-select", "-p"): (2, "", "error: unable to get active developer directory")}
    )
    got = await doctor.swift_check(probe(tmp_path, run))
    assert got["state"] == "warn" and run.calls == [("xcode-select", "-p")]
    run = answers(
        {
            ("xcode-select",): (0, "/Library/Developer/CommandLineTools\n", ""),
            ("xcrun",): (0, "/usr/bin/swiftc\n", ""),
        }
    )
    assert (await doctor.swift_check(probe(tmp_path, run)))["state"] == "ok"


def test_disk_space_levels(tmp_path):
    for free, state in ((80 * 1024**3, "ok"), (5 * 1024**3, "warn"), (1024**3, "problem")):
        got = doctor.disk_check(probe(tmp_path, disk_free=lambda path, free=free: free))
        assert got["state"] == state
    assert (
        doctor.disk_check(probe(tmp_path, disk_free=lambda p: 5 * 1024**3))["summary"]
        == "5.0 GB free"
    )


async def test_the_port_is_looked_at_with_lsof_never_bound(tmp_path):
    ours = answers({("lsof",): (0, "p100\ncpython3.12\n", "")})
    assert (await doctor.port_check(probe(tmp_path, ours), True))["summary"] == (
        "In use by the phone companion"
    )
    free = answers({("lsof",): (1, "", "")})
    assert (await doctor.port_check(probe(tmp_path, free), False))["summary"] == "Not in use"
    got = await doctor.port_check(probe(tmp_path, free), True)
    assert got["state"] == "problem" and got["summary"] == "The phone companion isn't listening"
    other = answers({("lsof",): (0, "p7\ncnode\n", "")})
    got = await doctor.port_check(probe(tmp_path, other), False)
    assert got["state"] == "warn" and got["meta"] == "node (7)"
    broken = answers({("lsof",): OSError("no lsof")})
    assert (await doctor.port_check(probe(tmp_path, broken), False))["state"] == "unknown"


def test_leftover_claude_processes_are_only_jarvis_own_engine(tmp_path):
    cli = tmp_path / "claude"
    cli.write_text("")
    other = tmp_path / "other-claude"
    other.write_text("")
    procs = [
        {"pid": 5, "ppid": 100, "exe": str(cli), "rss": 300 * 1024**2},  # this run's
        {"pid": 6, "ppid": 1, "exe": str(cli), "rss": 400 * 1024**2},  # an earlier run's
        {"pid": 7, "ppid": 1, "exe": str(other), "rss": 1},  # the owner's own Claude app
        {"pid": 8, "ppid": 1, "exe": "", "rss": 1},
    ]
    p = probe(
        tmp_path, claude_cli=lambda: str(cli), processes=lambda: procs, children=lambda pid: {5}
    )
    got = doctor.process_check(p, 2)
    assert got["state"] == "warn" and got["summary"] == "1 left from an earlier run"
    assert got["meta"] == "400 MB" and got["details"] == ["pid 6"]
    clean = probe(
        tmp_path, claude_cli=lambda: str(cli), processes=lambda: procs[:1], children=lambda pid: {5}
    )
    assert doctor.process_check(clean, 1)["summary"] == "1 running for open sessions"
    many = [{"pid": 10 + i, "ppid": 100, "exe": str(cli), "rss": 1} for i in range(6)]
    busy = probe(
        tmp_path,
        claude_cli=lambda: str(cli),
        processes=lambda: many,
        children=lambda pid: {10, 11, 12, 13, 14, 15},
    )
    got = doctor.process_check(busy, 2)
    assert got["state"] == "warn" and got["summary"] == "6 running for 2 open sessions"
    assert doctor.process_check(busy, 4)["state"] == "ok"


# ── logs, damaged files, the indexes ──


def test_errors_in_the_last_hour_counted_and_the_last_ones_masked(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    old = "".join(f"2026-09-29 18:0{i}:00,000 ERROR old {i}\n" for i in range(3))
    (logs / "jarvis.log.1").write_text(old + "2026-09-29 19:20:00,000 ERROR rotated but recent\n")
    lines = [
        f"2026-09-29 19:{30 + i}:00,000 ERROR boom {i} Bearer abcdef1234567890\n" for i in range(7)
    ]
    (logs / "jarvis.log").write_text(
        "".join(lines)
        + "2026-09-29 19:45:00,000 WARNING just a warning\nTraceback (most recent call last):\n"
    )
    got = doctor.log_check(probe(tmp_path))
    assert got["state"] == "warn" and got["summary"] == "8 in the last hour"
    assert len(got["details"]) == doctor.LAST_LINES
    assert all("abcdef" not in line and "Bearer [hidden]" in line for line in got["details"])
    assert doctor.log_check(probe(tmp_path / "nothing"))["summary"] == "No log yet"


def test_damaged_copies_and_files_damaged_now(tmp_path):
    data = tmp_path / "data"
    (data / "brain").mkdir(parents=True)
    (data / "memory.json").write_text('{"ok": true}')
    (data / "memory.json.bad-20260901-101010").write_text("{")
    (data / "memory.json.bad-20260901-101010-2").write_text("{")
    (data / "brain" / "index.json.bad-20260902-111111").write_text("{")
    got = doctor.damaged_check(probe(tmp_path))
    assert got["state"] == "warn" and got["summary"] == "3 damaged copies kept aside"
    assert got["details"][0] == "brain/index.json · 2026-09-02 11:11"
    assert got["fix"]["id"] == "tidy_damaged"
    (data / "routines.json").write_text('{"torn": ')
    got = doctor.damaged_check(probe(tmp_path))
    assert got["state"] == "problem" and got["details"] == ["routines.json"] and got["fix"] is None


def test_the_file_index_check_reads_sqlite_read_only(tmp_path):
    db = tmp_path / "files.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t (x)")
    conn.commit()
    conn.close()
    assert doctor.quick_check(db) == "ok"
    status = {"state": "idle", "files": 1200, "refreshed_at": "2026-09-29T20:00:00", "last": {}}
    got = doctor.file_index_check(probe(tmp_path), True, status, db)
    assert got["state"] == "ok" and got["summary"] == "1,200 files"
    stale = dict(status, refreshed_at="2026-09-29T10:00:00")
    assert (
        doctor.file_index_check(probe(tmp_path), True, stale, db)["fix"]["id"]
        == "rebuild_file_index"
    )
    assert doctor.file_index_check(probe(tmp_path), False, status, db)["summary"] == "Off"
    (tmp_path / "bad.db").write_bytes(b"this is not sqlite at all" * 100)
    assert doctor.quick_check(tmp_path / "bad.db") == "damaged"
    got = doctor.file_index_check(probe(tmp_path), True, status, tmp_path / "bad.db")
    assert got["state"] == "problem"
    assert doctor.quick_check(tmp_path / "missing.db") == "missing"


def test_the_knowledge_index(tmp_path):
    check = doctor.knowledge_check
    assert check({"notes": 40}, {"state": "ready"}, 3.0, True)["summary"] == "40 notes"
    assert check({"notes": 40}, {"state": "building"}, 3.0, True)["summary"] == "Updating now"
    got = check({"notes": 40}, {"state": "error", "detail": "token=abcdef123456 failed"}, 3.0, True)
    assert got["state"] == "problem" and got["details"] == ["token=[hidden] failed"]
    assert check({"notes": 40}, {}, 100.0, True)["summary"] == "Not updated for 4 days"
    assert check({"notes": 0}, {}, float("inf"), True)["summary"] == "Empty"
    assert check({"notes": 9}, {}, float("inf"), True)["state"] == "ok"  # never dated: no guess
    assert check({"notes": 0}, {}, 1.0, False)["summary"] == "No sources are on"


def test_accounts_and_backups():
    conns = [
        {
            "id": "a",
            "name": "Notion",
            "status": "error",
            "error": "401: token sk-abcdefghijklmnop1234",
        },
        {"id": "b", "name": "GitHub", "status": "connected"},
        {"id": "c", "name": "Old", "status": "off"},
    ]
    got = doctor.connectors_check(conns)
    assert got["state"] == "warn" and got["summary"] == "1 couldn't connect"
    assert got["details"] == ["Notion: 401: token [hidden]"]
    assert doctor.connectors_check(conns[1:])["summary"] == "1 connected"
    assert doctor.connectors_check([])["summary"] == "None connected"

    check = doctor.backups_check
    assert check({"newest": None, "daily": True}, NOW)["summary"] == "No backup yet"
    recent = {"created": "2026-09-29T03:00:00"}
    assert check({"newest": recent, "daily": True}, NOW)["summary"] == "Last one today"
    old = {"created": "2026-09-20T03:00:00"}
    got = check({"newest": old, "daily": True}, NOW)
    assert got["state"] == "warn" and got["summary"] == "Last one 9 days ago"
    assert check({"newest": old, "daily": False}, NOW)["state"] == "info"
    assert check({"error": "gone", "folder": "/Volumes/X"}, NOW)["state"] == "problem"


def test_the_spoken_summary_names_only_what_needs_looking_at():
    checks = [
        doctor.check("a", "jarvis", "Claude sign-in", "problem", "Not signed in"),
        doctor.check("b", "jarvis", "Disk", "ok", "80 GB free"),
        doctor.check("c", "data", "Backups", "warn", "No backup yet"),
    ]
    said = doctor.spoken({"checks": checks})
    assert said.startswith("Checkup done: 1 fine, 2 to look at: Claude sign-in: Not signed in")
    assert doctor.spoken({"checks": checks[1:2]}).startswith("Checkup done: all 1 checks are fine")
    assert doctor.summarize(checks)["worst"] == "problem"


# ── masking ──


@pytest.mark.parametrize(
    ("line", "masked"),
    [
        ("JARVIS listening on http://127.0.0.1:5/?token=Zx9yabcDEF1234567890", "?token=[hidden]"),
        ("Authorization: Bearer sk-ant-api03-AAAABBBBCCCC", "Authorization: [hidden]"),
        ("password=hunter2 user=ann", "password=[hidden] user=ann"),
        ("mail ann.lee+work@example.co.uk now", "mail [email] now"),
        ("call +1 (510) 555-0100 or 510-555-0199", "call [phone] or [phone]"),
        ("twilio AC" + "0123456789abcdef" * 2, "twilio [hidden]"),  # made up; split for scanners
        ("key ghp_abcdefghijklmnopqrstuv1234", "key [hidden]"),
        ("session 3f2a9c1e-4b5d-4c7a-9e8f-0123456789ab", "session [hidden]"),
    ],
)
def test_secrets_are_masked(line, masked):
    assert masked in redact.line(line, redact.home_pattern(Path("/Users/ann")))


@pytest.mark.parametrize(
    "line",
    [
        "2026-09-29 19:03:12,345 ERROR query failed (timeout); reconnecting",
        "file index: 123456 files, 12 new or changed, 0 removed in 3.2s",
        "version 2.1.284 pid 81234 port 8765 took 1500 ms",
        "connector auth failed: invalid_grant",
    ],
)
def test_ordinary_lines_stay_readable(line):
    assert redact.line(line, redact.home_pattern(Path("/Users/ann"))) == line


def test_the_home_folder_becomes_a_tilde():
    home = redact.home_pattern(Path("/Users/ann"))
    assert (
        redact.line('File "/Users/ann/jarvis/hub.py", line 3', home)
        == 'File "~/jarvis/hub.py", line 3'
    )
    assert redact.line("/Users/annabel/x", home) == "/Users/annabel/x"
