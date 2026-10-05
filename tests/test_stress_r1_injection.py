"""Stress, round 1: injection through the tools' arguments. Hostile paths for the file
actions (a NUL, ../, ~, links out of the home folder), an amount no float holds for
confirm_transaction, and quote-breaking AppleScript payloads for the Mac tools, recorded,
never run. Everything happens in a temp folder; nothing on this Mac is moved or opened."""

from __future__ import annotations

import os

import pytest

from jarvis import file_actions as fa
from jarvis import mac_tools
from jarvis import transactions as tx


@pytest.fixture
def home(tmp_path):
    home = tmp_path / "home"
    for folder in ("Desktop", "Documents", ".Trash"):
        (home / folder).mkdir(parents=True)
    (home / "Desktop" / "a.txt").write_text("a")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    os.symlink(outside, home / "Desktop" / "out")
    return home


@pytest.fixture
def actions(home, tmp_path):
    def trash(path):
        dest = home / ".Trash" / path.name
        os.rename(path, dest)
        return dest

    return fa.FileActions(
        tmp_path / "file_actions.json",
        home=home,
        trash=trash,
        clipboard=(lambda: "", lambda _text: None),
    )


@pytest.mark.parametrize(
    "plan",
    [
        lambda a, d: a.plan_trash([f"{d}/a.txt\x00.png"]),
        lambda a, d: a.plan_move([f"{d}/a.txt"], f"{d}/../Documents\x00"),
        lambda a, d: a.plan_move([f"\x00{d}/a.txt"], f"{d}/../Documents"),
        lambda a, d: a.plan_rename(f"{d}/a.txt\x00", "b"),
    ],
)
def test_a_nul_in_a_path_is_refused_in_words(actions, home, plan):
    """A NUL made the system calls raise ValueError("embedded null character"), which
    escaped the tools as a bare error instead of their words."""
    with pytest.raises(fa.Refused, match="no file's path can have"):
        plan(actions, str(home / "Desktop"))
    assert (home / "Desktop" / "a.txt").exists()


@pytest.mark.parametrize(
    "raw",
    [
        "{d}/../../outside/secret.txt",
        "{d}/out/secret.txt",
        "~/../outside/secret.txt",
        "{d}/./../../outside/secret.txt",
        "{h}",
        "{h}/",
        "{h}/.",
        "{d}/",
        "{h}/DESKTOP",
    ],
)
def test_paths_out_of_the_home_or_its_own_folders_stay_refused(actions, home, raw):
    path = raw.format(d=home / "Desktop", h=home)
    with pytest.raises(fa.Refused):
        actions.plan_trash([path])


def test_moving_into_a_link_out_of_the_home_is_refused(actions, home):
    with pytest.raises(fa.Refused):
        actions.plan_move([str(home / "Desktop" / "a.txt")], str(home / "Desktop" / "out"))


@pytest.mark.parametrize(
    "name", ["a\x00b", "../x", "x/y", ".hidden", "inv\u202efdp.exe", "a" * 300, "id_rsa"]
)
def test_hostile_new_names_are_refused(actions, home, name):
    with pytest.raises(fa.Refused):
        actions.plan_rename(str(home / "Desktop" / "a.txt"), name)


def test_an_amount_past_any_float_is_refused_in_words():
    """JSON carries an integer like 10**400 and the tool's schema ("number") lets it in;
    float() raised OverflowError, which clean_ask didn't turn into its words."""
    with pytest.raises(ValueError, match="out of range"):
        tx.parse_amount(10**400)
    args = {"merchant": "Shop", "summary": "a thing", "button": "Place order", "amount": 10**400}
    with pytest.raises(tx.Refused, match="couldn't read the amount"):
        tx.clean_ask(args, "USD")


@pytest.mark.parametrize("amount", [float("nan"), float("inf"), -1, True, None, "1e309", "-$5"])
def test_odd_amounts_are_refused(amount):
    with pytest.raises(ValueError):
        tx.parse_amount(amount)


# ── AppleScript: values travel as argv, never as script text ──

PAYLOADS = [
    '" & (do shell script "id") & "',
    '"\nend tell\ndo shell script "id"\ntell application "Finder',
    "a\x00b",
    "\u202eexe.txt",
    "x" * 100_000,
]


@pytest.fixture
def calls(monkeypatch):
    seen = []

    async def record(*args, stdin=None, timeout=30):
        seen.append((args, stdin))
        return ""

    monkeypatch.setattr(mac_tools, "run_command", record)
    return seen


@pytest.mark.parametrize("payload", PAYLOADS)
async def test_mac_tools_keep_payloads_out_of_scripts(calls, payload):
    await mac_tools.create_note.handler({"title": payload, "body": payload})
    await mac_tools.quit_app.handler({"name": payload})
    await mac_tools.set_volume.handler({"level": 50})
    for args, script in calls:
        assert args[0] == "osascript"
        if script is not None:
            assert payload not in script
            assert "do shell script" not in script
    assert calls[1][0][2] == payload  # quit_app: the name alone, as argv


@pytest.mark.parametrize("url", ["javascript:alert(1)", "file:///etc/passwd", " -a Terminal"])
async def test_open_url_opens_only_web_addresses(calls, url):
    result = await mac_tools.open_url.handler({"url": url})
    assert result.get("is_error")
    assert calls == []
