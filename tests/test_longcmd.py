"""Claude Code's command line on Windows (longcmd.py): JARVIS's system prompt is about 40,000
characters and Windows starts a program from one line of at most 32,767, so the long values go
in files the program is told to read. (Run here as on any computer; what a Windows machine does
with the real thing is checked by the Windows workflow.)"""

from __future__ import annotations

import json
from pathlib import Path

from jarvis import longcmd, osplat

PROMPT = "You are JARVIS. " + "Remember the owner's plans. " * 1500  # about 42,000 characters
CLI = r"C:\Users\ann\AppData\Local\Programs\J.A.R.V.I.S\resources\backend\python\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe"


def line(prompt=PROMPT, mcp="x" * 200):
    return [
        CLI, "--output-format", "stream-json", "--verbose",
        "--system-prompt", prompt,
        "--allowedTools", "WebSearch,mcp__mac__open_app",
        "--mcp-config", mcp,
        "--input-format", "stream-json",
    ]  # fmt: skip


def test_the_real_line_is_too_long_for_windows_and_a_shorter_one_is_left_alone(tmp_path):
    assert longcmd.line_length(line()) > 32_767  # why Claude Code did not start
    short = line(prompt="Be brief.")
    assert longcmd.shorten(short, into=tmp_path) is short
    assert list(tmp_path.iterdir()) == []


def test_a_long_system_prompt_goes_in_a_file_and_the_line_fits(tmp_path):
    out = longcmd.shorten(line(), into=tmp_path)
    assert longcmd.line_length(out) < longcmd.LIMIT
    assert "--system-prompt" not in out
    path = Path(out[out.index("--system-prompt-file") + 1])
    assert path.parent == tmp_path
    assert path.read_text(encoding="utf-8") == PROMPT  # exactly: no newline changed, nothing cut
    assert out[0] == CLI and out[-2:] == ["--input-format", "stream-json"]  # the rest as it was


def test_the_prompt_in_a_file_keeps_its_newlines_and_every_character(tmp_path):
    prompt = 'line one\nline two\r\nquote " and \\ backslash, 日本語, emoji 🙂\n' * 800
    out = longcmd.shorten(line(prompt=prompt), into=tmp_path)
    path = Path(out[out.index("--system-prompt-file") + 1])
    assert path.read_bytes() == prompt.encode("utf-8")


def test_an_appended_prompt_and_long_json_follow_when_the_line_is_still_too_long(tmp_path):
    big = json.dumps(
        {"mcpServers": {f"s{i}": {"type": "sdk", "name": f"s{i}"} for i in range(900)}}
    )
    cmd = line(prompt="short", mcp=big) + ["--append-system-prompt", "A" * 30_000]
    out = longcmd.shorten(cmd, into=tmp_path)
    assert longcmd.line_length(out) < longcmd.LIMIT
    assert "--append-system-prompt-file" in out and "--append-system-prompt" not in out
    config = Path(out[out.index("--mcp-config") + 1])
    assert json.loads(config.read_text(encoding="utf-8")) == json.loads(big)


def test_only_what_is_needed_is_moved_the_biggest_first(tmp_path):
    cmd = line(prompt="P" * 5_000, mcp="m" * 20_000) + ["--settings", "s" * 9_000]
    out = longcmd.shorten(cmd, limit=26_000, into=tmp_path)
    assert longcmd.line_length(out) <= 26_000
    assert out[out.index("--mcp-config") + 1].endswith(".json")  # the biggest went to a file
    assert out[out.index("--system-prompt") + 1] == "P" * 5_000  # …and the rest stayed
    assert len(list(tmp_path.iterdir())) == 1


def test_values_that_are_already_a_path_or_short_are_never_moved(tmp_path):
    cmd = line(prompt="Be brief.", mcp=r"C:\a\mcp.json") + ["--settings", "{}"] * 4000
    out = longcmd.shorten(cmd, into=tmp_path)
    assert out[out.index("--mcp-config") + 1] == r"C:\a\mcp.json"
    assert list(tmp_path.iterdir()) == []


def test_old_files_are_pruned_and_this_runs_are_removed(tmp_path):
    old = tmp_path / "arg-old.txt"
    old.write_text("x")
    import os
    import time

    os.utime(old, (time.time() - 3 * 24 * 3600,) * 2)
    fresh = tmp_path / "arg-new.txt"
    fresh.write_text("y")
    longcmd.prune(into=tmp_path)
    assert not old.exists() and fresh.exists()
    made = longcmd.shorten(line(), into=tmp_path)
    path = Path(made[made.index("--system-prompt-file") + 1])
    assert path.exists()
    longcmd.cleanup()
    assert not path.exists()


def test_it_does_nothing_on_a_mac():
    assert osplat.IS_WIN is False
    assert longcmd.install() is False


def test_on_a_pc_the_sdk_builds_the_short_line(monkeypatch, tmp_path):
    """The real SDK transport, with a prompt as long as JARVIS's: the line it builds fits."""
    from claude_agent_sdk import ClaudeAgentOptions
    from claude_agent_sdk._internal.transport import subprocess_cli

    cls = subprocess_cli.SubprocessCLITransport
    monkeypatch.setattr(cls, "_build_command", cls._build_command)  # (restored afterwards)
    monkeypatch.delattr(cls, "_jarvis_long_lines", raising=False)
    monkeypatch.setattr(osplat, "IS_WIN", True)
    monkeypatch.setattr(longcmd, "folder", lambda: tmp_path)
    monkeypatch.setattr(longcmd, "_made", [])
    assert longcmd.install() is True and longcmd.install() is True  # (twice: still one layer)
    transport = cls(prompt="", options=ClaudeAgentOptions(system_prompt=PROMPT))
    transport._cli_path = CLI
    cmd = transport._build_command()
    assert longcmd.line_length(cmd) < longcmd.LIMIT
    assert Path(cmd[cmd.index("--system-prompt-file") + 1]).read_text(encoding="utf-8") == PROMPT
    assert "--system-prompt" not in cmd


def test_the_real_conversations_line_fits_on_a_pc(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path
):
    """JARVIS's own options (the whole system prompt, every tool) through the real transport."""
    import asyncio

    from claude_agent_sdk._internal.transport import subprocess_cli

    from jarvis.hub import Hub

    class Client:
        options = None

        def __init__(self, options):
            Client.options = options

        async def connect(self):
            pass

    cls = subprocess_cli.SubprocessCLITransport
    monkeypatch.setattr(cls, "_build_command", cls._build_command)
    monkeypatch.delattr(cls, "_jarvis_long_lines", raising=False)
    monkeypatch.setattr(osplat, "IS_WIN", True)
    monkeypatch.setattr(longcmd, "folder", lambda: tmp_path)
    monkeypatch.setattr(longcmd, "_made", [])
    longcmd.install()
    hub = Hub(settings, client_factory=Client, speaker=quiet_speaker, poll=False, **isolated)
    asyncio.run(hub._connect())
    transport = cls(prompt="", options=Client.options)
    transport._cli_path = CLI
    raw = longcmd.line_length([CLI, "--system-prompt", Client.options.system_prompt])
    assert raw > 32_767, "JARVIS's prompt is no longer too long for one line: this test is moot"
    cmd = transport._build_command()
    assert longcmd.line_length(cmd) < longcmd.LIMIT
    prompt_file = Path(cmd[cmd.index("--system-prompt-file") + 1])
    assert prompt_file.read_text(encoding="utf-8") == Client.options.system_prompt
