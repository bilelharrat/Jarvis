"""The Windows side of the engine, as far as it can be checked on any computer: key names,
which files are private on a Windows path, the guard's idea of which programs send messages,
file search, and the sounds made without system files. (What needs a Windows desktop is run by
the Windows workflow in CI.)"""

from __future__ import annotations

import asyncio
import wave
from pathlib import PureWindowsPath

import pytest

from jarvis import computer, hands_guard, osplat, sounds, winhands, winsay

# ── keys ──


@pytest.mark.parametrize(
    "combo, modifiers, key",
    [
        ("ctrl+shift+t", [0x11, 0x10], ord("T")),
        ("cmd+l", [0x11], ord("L")),  # a Mac habit: cmd is the key Windows calls ctrl
        ("option+f4", [0x12], 0x73),
        ("return", [], 0x0D),
        ("win", [], 0x5B),
        ("ctrl+plus", [0x11, 0x10], 0xBB),
        ("alt+left", [0x12], 0x25),
        ("ctrl+,", [0x11], 0xBC),
    ],
)
def test_key_names_become_windows_keys(combo, modifiers, key):
    assert winhands.parse_keys(combo) == (modifiers, key)


def test_a_key_it_doesnt_know_is_said_in_words():
    with pytest.raises(ValueError, match="modifier"):
        winhands.parse_keys("hyper+x")
    with pytest.raises(ValueError, match="key"):
        winhands.parse_keys("ctrl+blorp")
    with pytest.raises(ValueError, match="Say which key"):
        winhands.parse_keys("")


# ── private files on a Windows path ──


@pytest.mark.parametrize(
    "path",
    [
        r"C:\Users\Ann\.ssh\id_rsa",
        r"C:\Users\Ann\.aws\credentials",
        r"C:\Users\Ann\AppData\Local\Google\Chrome\User Data\Default\Login Data",
        r"C:\Users\Ann\AppData\Roaming\Microsoft\Credentials\ABC",
        r"C:\Users\Ann\AppData\Roaming\Mozilla\Firefox\Profiles\x.default\logins.json",
        r"C:\Users\Ann\AppData\Roaming\Jarvis\prefs.json",
        r"C:\Users\Ann\Documents\Outlook Files\archive.pst",
        r"C:\Users\Ann\code\app\.env",
        r"C:\Users\ANN\APPDATA\LOCAL\MICROSOFT\EDGE\USER DATA\Default\Cookies",
    ],
)
def test_credentials_and_browser_profiles_are_private_on_windows_too(path):
    assert computer.is_sensitive(PureWindowsPath(path))


def test_ordinary_windows_files_are_not():
    for path in (
        r"C:\Users\Ann\Documents\budget.xlsx",
        r"C:\Users\Ann\Desktop\notes.txt",
        r"C:\Users\Ann\code\app\.env.example",
    ):
        assert not computer.is_sensitive(PureWindowsPath(path))


# ── which programs send messages ──


@pytest.mark.parametrize(
    "exe, name, kind",
    [
        ("outlook.exe", "Outlook", "mail"),
        ("ms-teams.exe", "Microsoft Teams", "chat"),
        ("whatsapp.root.exe", "WhatsApp", "chat"),
        ("discord.exe", "Discord", "chat"),
    ],
)
def test_the_guard_knows_windows_messaging_programs(exe, name, kind):
    assert hands_guard.messaging_app("", exe) == (name, kind)


def test_the_guard_reads_a_browser_tab_on_windows():
    assert hands_guard.messaging_app(
        "Chrome", "chrome.exe", "Inbox (3) - ann@gmail.com - Gmail"
    ) == ("Gmail", "mail")
    assert hands_guard.messaging_app("Notepad", "notepad.exe", "notes.txt - Notepad") is None


def test_a_send_shortcut_in_outlook_is_a_send():
    assert "alt+s" in hands_guard._MAIL_SEND and "ctrl+enter" in hands_guard._MAIL_SEND


def test_the_windows_probe_answers_in_the_guards_words(monkeypatch):
    from jarvis import winuia

    monkeypatch.setattr(
        winuia,
        "probe_focus",
        lambda: {
            "app": "Outlook",
            "bundle": "outlook.exe",
            "window": "New message",
            "focused": {"role": "AXTextField", "editable": True},
            "trusted": True,
        },
    )
    monkeypatch.setattr(
        winuia,
        "probe_point",
        lambda x, y: {
            "press": {"role": "ButtonControl", "title": "Send"},
            "at_app": "Outlook",
            "at_bundle": "outlook.exe",
            "at_window": "New message",
            "trusted": True,
        },
    )
    probe = hands_guard.WinProbe()
    assert asyncio.run(probe("focus"))["bundle"] == "outlook.exe"
    assert asyncio.run(probe("point", "10", "20"))["press"]["title"] == "Send"

    def broken():
        raise OSError("no desktop")

    monkeypatch.setattr(winuia, "probe_focus", broken)
    assert asyncio.run(probe("focus")) == {"fallback": True}


def test_pressing_send_in_outlook_asks_first_on_windows(monkeypatch):
    asked = []

    async def card(question, detail, spoken, choices):
        asked.append(question)
        return False

    class Probe:
        async def __call__(self, *argv):
            return {
                "app": "Outlook",
                "bundle": "outlook.exe",
                "window": "New message",
                "focused": {"role": "AXTextField", "editable": True, "value": "Hi Bea"},
                "trusted": True,
            }

    guard = hands_guard.HandsGuard(
        reads=lambda: {}, words=lambda: "", asked=lambda _k: False, send=card, probe=Probe()
    )
    said = asyncio.run(guard.press(["Send"], app="Outlook"))
    assert asked == ["Send this in Outlook?"] and "didn't" not in (said or "").lower().replace(
        "the user said no", ""
    )
    assert said and "wasn't done" in said


# ── finding files ──


def test_files_are_found_by_name_and_by_text_without_spotlight(tmp_path, monkeypatch):
    monkeypatch.setattr(computer.Path, "home", classmethod(lambda cls: tmp_path))
    docs = tmp_path / "Documents"
    (docs / "taxes").mkdir(parents=True)
    (docs / "taxes" / "budget 2026.txt").write_text("rent and food")
    (docs / "notes.txt").write_text("the quarterly budget is due")
    (docs / ".hidden.txt").write_text("budget")
    (tmp_path / ".ssh").mkdir()
    (tmp_path / ".ssh" / "budget_key").write_text("x")
    (docs / "secrets.pem").write_text("budget")
    by_name = computer._walk_find("budget 2026", content=False)
    assert [p.rsplit("taxes", 1)[-1].lstrip("\\/") for p in by_name] == ["budget 2026.txt"]
    inside = computer._walk_find("quarterly budget", content=True)
    assert [p.rsplit("Documents", 1)[-1].lstrip("\\/") for p in inside] == ["notes.txt"]
    assert computer._walk_find("budget", content=True) and not any(
        "hidden" in p or ".ssh" in p or ".pem" in p
        for p in computer._walk_find("budget", content=True)
    )


# ── sounds ──


def test_the_windows_sounds_are_made_from_tones(tmp_path, monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    monkeypatch.setattr(osplat, "app_support", lambda home=None: tmp_path)
    for name in ("chime", "timer", "alarm"):
        path = sounds.path_of(name)
        with wave.open(path) as w:
            seconds = w.getnframes() / w.getframerate()
            assert w.getnchannels() == 1 and w.getsampwidth() == 2 and 0.1 < seconds < 1.5, name
    assert sounds.path_of("nonsense") == ""


def test_a_sound_that_cant_play_is_just_not_heard():
    sounds.play("/no/such/sound.aiff")  # (the test run starts no real player)
    sounds.play("")


def test_helpers_for_the_other_os_are_named_right():
    assert osplat.kill_tree_argv(42) == ["taskkill", "/PID", "42", "/T", "/F"]
    assert winsay.sapi_rate(175) == 0 and winsay.sapi_rate(500) == 10 and winsay.sapi_rate(50) == -7
    assert (
        osplat.afplay_argv("x.wav")[0] in ("afplay",) or osplat.afplay_argv("x.wav")[-1] == "x.wav"
    )


# ── the prompt and the servers for a PC ──


def test_the_prompt_for_a_pc_talks_about_a_pc():
    from jarvis import brain
    from jarvis.config import Settings

    mac = brain._system_prompt(
        Settings(),
        False,
        extra="\n- Smart home: lights run through the user's Shortcuts. Shortcuts the user made instant run without asking.",
    )
    pc = brain.windows_prompt(mac)
    assert (
        "Windows PC" in pc
        and "Mac with Spotlight" not in pc
        and "Apple Notes" not in pc
        and "Smart home" not in pc
    )
    assert (
        "- PC: open apps" in pc
        and "- Email:" in pc
        and "read_window" in pc
        and "ctrl, not cmd" in pc
    )
    assert "- Mac:" in mac and "Mail and Calendar" in mac  # a Mac's own is as it was
    assert "offer to keep going" in pc and "offer to keep going" not in mac  # (long documents)


def test_the_tools_of_the_pc_have_the_names_the_rules_are_written_for():
    from jarvis import mac_tools, win_tools

    assert win_tools.SERVER_NAME == mac_tools.SERVER_NAME == "mac"
    assert set(win_tools.AUTO_ALLOWED) <= set(mac_tools.AUTO_ALLOWED)
    server = win_tools.build_server()
    assert server["name"] == "mac"


def test_start_menu_names_are_matched_the_way_people_say_them():
    from jarvis.win_tools import StartApp, match_app

    apps = [
        StartApp("Microsoft Edge", "edge!App"),
        StartApp("Microsoft Word", "word"),
        StartApp("Notepad", "np"),
        StartApp("Calculator", "calc"),
        StartApp("Word Pad", "wp"),
    ]
    assert match_app("notepad", apps).name == "Notepad"
    assert match_app("edge", apps).name == "Microsoft Edge"
    assert match_app("microsoft", apps) and isinstance(match_app("microsoft", apps), list)
    assert match_app("calc", apps).name == "Calculator"
    assert match_app("photoshop", apps) is None
    assert match_app("", apps) is None


def test_the_windows_server_and_core_servers_leave_out_messages(monkeypatch):
    """On Windows the hub offers no iMessage server: email is the mail server's."""
    from jarvis import hub as hubmod
    from jarvis import messaging

    class Stub:
        _core_feature_servers = hubmod.Hub._core_feature_servers
        _feature_servers = hubmod.Hub._feature_servers

    stub = Stub()
    monkeypatch.setattr(
        stub,
        "_core_feature_servers",
        lambda *a: {messaging.SERVER_NAME: 1, "other": 2},
        raising=False,
    )
    monkeypatch.setattr(osplat, "IS_WIN", True)
    assert hubmod.Hub._feature_servers(stub) == {"other": 2}
    monkeypatch.setattr(osplat, "IS_WIN", False)
    assert hubmod.Hub._feature_servers(stub) == {messaging.SERVER_NAME: 1, "other": 2}


# ── "open my email settings", by voice ──


def test_settings_can_be_opened_at_a_part_by_voice():
    from jarvis import ui

    for words in (
        "open my email settings",
        "open email accounts",
        "show me the email setup",
        "take me to email settings",
    ):
        cmd = ui.parse(words)
        assert (cmd.action, cmd.name, cmd.on, cmd.section) == (
            "panel",
            "settings",
            True,
            "mail-group",
        ), words
    cmd = ui.parse("open accessibility settings")
    assert cmd.section == "a11y-group" and cmd.reply == "Opening accessibility settings."
    assert ui.parse("open settings").section == ""
    assert ui.parse("close settings").on is False


def test_a_running_screen_reader_is_noticed_by_windows_flag_or_by_name(monkeypatch):
    import ctypes
    from types import SimpleNamespace

    import psutil

    monkeypatch.setattr(osplat, "IS_WIN", False)
    assert osplat.screen_reader_running() is None  # only a PC can say

    answers = {"flag": 1, "worked": 1}

    def spi(action, _param, ref, _update):
        assert action == 0x0046  # SPI_GETSCREENREADER
        ref._obj.value = answers["flag"]
        return answers["worked"]

    running = []

    def processes(_attrs=None):
        return iter([SimpleNamespace(info={"name": n}) for n in running])

    monkeypatch.setattr(osplat, "IS_WIN", True)
    windll = SimpleNamespace(user32=SimpleNamespace(SystemParametersInfoW=spi))
    monkeypatch.setattr(ctypes, "windll", windll, raising=False)
    monkeypatch.setattr(psutil, "process_iter", processes)
    assert osplat.screen_reader_running() is True  # the flag
    answers["flag"] = 0
    assert osplat.screen_reader_running() is False  # no flag, none of them running
    running.extend(["explorer.exe", "NVDA.exe"])
    assert osplat.screen_reader_running() is True  # no flag, but NVDA is among the programs
    running[:] = ["explorer.exe", "Narrator.exe"]
    assert osplat.screen_reader_running() is True
    running[:] = ["explorer.exe", "dictation.exe", None]
    answers["worked"] = 0  # the flag can't be read: the programs say
    assert osplat.screen_reader_running() is False


# ── what a PC's C library and file system do differently ──


def test_a_mac_style_unpadded_time_format_is_said_windows_way(monkeypatch):
    """ "%-d" and "%-I" are a Mac's way; Windows' strftime says "%#d" and "%#I". Every strftime
    and every f-string format of a date goes through time.strftime, so that one is changed."""
    import time
    from datetime import datetime

    seen = []
    monkeypatch.setattr(time, "strftime", lambda fmt, *a: seen.append(fmt) or "x")
    osplat._portable_strftime()
    osplat._portable_strftime()  # (twice: still one layer)
    time.strftime("%A %-d %B %Y, %-I:%M %p", ())
    time.strftime("%H:%M", ())
    now = datetime(2026, 10, 8, 15, 5)
    assert now.strftime("%-d %b, %-I:%M %p") == "x" and f"{now:%-I:%M}" == "x"
    assert seen == [
        "%A %#d %B %Y, %#I:%M %p",
        "%H:%M",
        "%#d %b, %#I:%M %p",
        "%#I:%M",
    ]


def test_a_file_mode_is_set_where_there_is_one_and_skipped_where_there_is_not(
    monkeypatch, tmp_path
):
    import os

    path = tmp_path / "secret.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    osplat.fchmod(fd, 0o600)
    os.close(fd)
    if hasattr(os, "fchmod"):  # (a PC has no mode bits to check)
        assert path.stat().st_mode & 0o777 == 0o600
    monkeypatch.delattr(os, "fchmod", raising=False)  # a PC has none
    fd = os.open(path, os.O_WRONLY)
    osplat.fchmod(fd, 0o600)  # no error
    os.close(fd)


def test_a_json_file_is_saved_on_a_pc_that_has_no_fchmod(monkeypatch, tmp_path):
    import os

    from jarvis import jsonstore

    monkeypatch.delattr(os, "fchmod", raising=False)
    path = tmp_path / "prefs.json"
    jsonstore.save_json(path, {"language": "en", "facts": ["日本語"]})
    jsonstore.save_json(path, {"language": "zh"})
    assert jsonstore.read_json(path, dict)[0] == {"language": "zh"}
    assert (tmp_path / "prefs.json.bak").exists()


def test_replacing_a_file_waits_out_a_virus_scanner_on_a_pc(monkeypatch, tmp_path):
    import os
    import time

    monkeypatch.setattr(osplat, "IS_WIN", True)
    monkeypatch.setattr(time, "sleep", lambda s: None)
    real = os.replace
    refused = {"left": 3}

    def replace(src, dst):
        if refused["left"]:
            refused["left"] -= 1
            raise PermissionError(5, "Access is denied")
        real(src, dst)

    monkeypatch.setattr(os, "replace", replace)
    (tmp_path / "a").write_text("new")
    (tmp_path / "b").write_text("old")
    osplat.replace_file(tmp_path / "a", tmp_path / "b")
    assert (tmp_path / "b").read_text() == "new" and refused["left"] == 0
    refused["left"] = 99  # never let go: the error is the caller's
    (tmp_path / "c").write_text("x")
    with pytest.raises(PermissionError):
        osplat.replace_file(tmp_path / "c", tmp_path / "b")


def test_open_flags_a_mac_has_and_windows_lacks_are_zero_there():
    import os

    assert osplat.O_NOFOLLOW == getattr(os, "O_NOFOLLOW", 0)
    assert osplat.O_BINARY == getattr(os, "O_BINARY", 0)
    assert osplat.O_NONBLOCK == getattr(os, "O_NONBLOCK", 0)


def test_a_pc_locks_a_byte_far_past_the_text_so_the_turned_away_can_read_who_holds_it(
    monkeypatch, tmp_path
):
    """msvcrt.locking locks bytes at the file's position, and nobody else may read a locked byte: a
    lock at the start kept the one turned away from reading the holder's process id."""
    import os
    import sys
    from types import ModuleType

    seen = []
    stub = ModuleType("msvcrt")
    stub.LK_NBLCK, stub.LK_UNLCK = 2, 0
    stub.locking = lambda fd, mode, nbytes: seen.append(
        (mode, os.lseek(fd, 0, os.SEEK_CUR), nbytes)
    )
    monkeypatch.setitem(sys.modules, "msvcrt", stub)
    monkeypatch.setattr(osplat, "IS_WIN", True)
    path = tmp_path / "backend.lock"
    with open(path, "w+") as handle:
        osplat.lock_file(handle)
        assert os.lseek(handle.fileno(), 0, os.SEEK_CUR) == 0  # the position is back at the start
        osplat.unlock_file(handle)
    assert seen == [(2, osplat.LOCK_AT, 1), (0, osplat.LOCK_AT, 1)]
    assert osplat.LOCK_AT > 1_000_000  # past any process id written at the start
