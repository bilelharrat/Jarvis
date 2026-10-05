"""The Mac's switches and the home's answers (jarvis.switches and the mac_switches feature),
with every command recorded instead of run: no switch on this Mac moves, no shortcut runs."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import FakeClient

from jarvis import switches as switches_module
from jarvis.features import mac_switches as feature
from jarvis.hub import Hub
from jarvis.switches import Switches, Unavailable, focus_shortcut, wifi_device

PORTS = """
Hardware Port: Ethernet Adapter (en2)
Device: en2
Ethernet Address: 12:a9:25:03:e7:c8

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 3c:a6:f6:00:00:01

Hardware Port: Thunderbolt Bridge
Device: bridge0
"""


def test_the_wifi_port_is_found():
    assert wifi_device(PORTS) == "en0"
    assert wifi_device("Hardware Port: Ethernet\nDevice: en1\n") is None


SHORTCUTS = [
    "Work Focus On",
    "Focus Off",
    "Sleep Focus On",
    "DND On",
    "Morning Routine",
    "Work Timer",
    "Movie Night",
]


@pytest.mark.parametrize(
    ("mode", "on", "expected"),
    [
        ("Work", True, "Work Focus On"),
        ("sleep", True, "Sleep Focus On"),
        ("Do Not Disturb", True, "DND On"),
        ("dnd", True, "DND On"),
        ("", False, "Focus Off"),
        ("Reading", True, None),  # none made for it
    ],
)
def test_the_focus_shortcut_is_found_by_its_name(mode, on, expected):
    assert focus_shortcut(SHORTCUTS, mode, on)[0] == expected


def test_chinese_shortcut_names_are_read_too():
    names = ["工作专注模式 开", "专注模式 关", "勿扰模式 开"]
    assert focus_shortcut(names, "工作", True)[0] == "工作专注模式 开"
    assert focus_shortcut(names, "", False)[0] == "专注模式 关"
    assert focus_shortcut(names, "勿扰", True)[0] == "勿扰模式 开"


def test_several_focus_shortcuts_are_offered_not_guessed():
    name, several = focus_shortcut(["Work Focus Off", "Sleep Focus Off"], "", False)
    assert name is None and several == ["Sleep Focus Off", "Work Focus Off"]


class Mac:
    def __init__(self):
        self.ran = []
        self.answers = {
            ("networksetup", "-listallhardwareports"): PORTS,
            ("networksetup", "-getairportpower", "en0"): "Wi-Fi Power (en0): On",
            ("/opt/homebrew/bin/blueutil", "--power"): "0",
        }
        self.dark = "false"

    async def command(self, *argv, timeout=30, stdin=None):
        self.ran.append(argv)
        return self.answers.get(argv, "")

    async def applescript(self, script, *argv, timeout=30):
        self.ran.append(("osascript", *argv))
        return self.dark if script == switches_module.DARK_GET else ""


class Names:
    def __init__(self, names):
        self.names = names

    async def refresh(self, force=False):
        return self.names


@pytest.fixture
def mac(monkeypatch):
    mac = Mac()
    monkeypatch.setattr(switches_module, "blueutil", lambda: "/opt/homebrew/bin/blueutil")
    return mac


async def test_switches_read_and_set_through_their_commands(mac):
    s = Switches(command=mac.command, applescript=mac.applescript, shortcuts=Names(SHORTCUTS))
    assert await s.status() == {"dark_mode": False, "wifi": True, "bluetooth": False}
    assert await s.set_wifi(False) == "Wi-Fi is off."
    assert mac.ran[-1] == ("networksetup", "-setairportpower", "en0", "off")
    assert await s.set_bluetooth(True) == "Bluetooth is on."
    assert mac.ran[-1] == ("/opt/homebrew/bin/blueutil", "--power", "1")
    assert await s.set_dark_mode(True) == "Dark mode is on."
    assert mac.ran[-1] == ("osascript", "on")
    assert await s.find_focus("Work", False) == "Focus Off"  # "Focus Off" ends any of them


async def test_the_switches_are_read_at_once_and_said_in_order(mac):
    """An AppleScript, networksetup twice and blueutil: none waits for another to finish
    (each here waits until all three reads have begun, which one after another never do)."""
    import asyncio

    begun: set[str] = set()
    every = asyncio.Event()

    def started(what):
        begun.add(what)
        if len(begun) == 3:
            every.set()

    async def command(*argv, timeout=30, stdin=None):
        started("bluetooth" if "blueutil" in argv[0] else "wifi")
        await asyncio.wait_for(every.wait(), 5)
        return await mac.command(*argv)

    async def applescript(script, *argv, timeout=30):
        started("dark_mode")
        await asyncio.wait_for(every.wait(), 5)
        return await mac.applescript(script, *argv)

    s = Switches(command=command, applescript=applescript)
    found = await s.status()
    assert list(found.items()) == [("dark_mode", False), ("wifi", True), ("bluetooth", False)]


async def test_without_blueutil_it_says_how_to_get_it(mac, monkeypatch):
    monkeypatch.setattr(switches_module, "blueutil", lambda: None)
    s = Switches(command=mac.command, applescript=mac.applescript)
    with pytest.raises(Unavailable, match="brew install blueutil"):
        await s.set_bluetooth(False)
    assert "blueutil" in (await s.status())["bluetooth"]


async def test_a_focus_with_no_shortcut_says_what_to_make(mac):
    s = Switches(command=mac.command, applescript=mac.applescript, shortcuts=Names([]))
    with pytest.raises(Unavailable, match="“Reading Focus On”"):
        await s.find_focus("reading", True)


# ── the feature: its gate ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated, monkeypatch, mac):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    monkeypatch.setattr(feature, "create_sdk_mcp_server", lambda **k: k["tools"])
    desk = hub.mac_switches
    desk.switches = Switches(
        command=mac.command, applescript=mac.applescript, shortcuts=Names(SHORTCUTS)
    )
    desk.command = mac.command
    desk.tools = {t.name: t.handler for t in feature.build_server(desk)}
    hub.cards = []
    hub.answer = "deny"

    def card(approval):
        hub.cards.append(approval["question"])
        hub.resolve(approval["id"], hub.answer)

    hub.add_approval_sink(card)
    return hub


def _said(result):
    return result["content"][0]["text"]


async def test_the_owners_own_words_flip_it_unasked(hub, mac):
    hub.prefs.control_always = False
    hub._turn_text = "turn off the wifi"
    out = await hub.mac_switches.tools["system_switch"]({"switch": "wifi", "state": "off"})
    assert hub.cards == [] and _said(out) == "Wi-Fi is off."
    assert ("networksetup", "-setairportpower", "en0", "off") in mac.ran


async def test_words_for_the_other_way_are_not_a_yes(hub, mac):
    hub.prefs.control_always = False
    hub._turn_text = "turn on the wifi"
    out = await hub.mac_switches.tools["system_switch"]({"switch": "wifi", "state": "off"})
    assert hub.cards == ["Turn Wi-Fi off?"] and out["is_error"]
    assert not any(c[:2] == ("networksetup", "-setairportpower") for c in mac.ran)


async def test_control_my_mac_flips_it_unless_something_read_could_have_asked(hub, mac):
    hub._turn_text = "tidy up my evening"
    assert hub.prefs.control_always
    out = await hub.mac_switches.tools["system_switch"]({"switch": "dark_mode", "state": "on"})
    assert hub.cards == [] and _said(out) == "Dark mode is on."
    hub._note_read("web", "a web page")  # a page could have put the idea in
    out = await hub.mac_switches.tools["system_switch"]({"switch": "bluetooth", "state": "off"})
    assert hub.cards == ["Turn Bluetooth off?"] and out["is_error"]
    hub.answer = "allow"
    out = await hub.mac_switches.tools["system_switch"]({"switch": "bluetooth", "state": "off"})
    assert _said(out) == "Bluetooth is off."


async def test_a_routine_with_the_setting_off_always_asks(hub):
    hub.prefs.control_always = False
    hub._turn_text = ""
    out = await hub.mac_switches.tools["system_switch"]({"switch": "dark_mode", "state": "off"})
    assert hub.cards == ["Turn dark mode off?"] and out["is_error"]


@pytest.mark.parametrize(
    ("said", "switch", "state"),
    [
        ("switch to light mode", "dark_mode", "off"),
        ("can you please turn bluetooth back on", "bluetooth", "on"),
        ("打开深色模式", "dark_mode", "on"),
        ("帮我把蓝牙关掉", "bluetooth", "off"),
        ("关闭无线网络", "wifi", "off"),
    ],
)
async def test_words_in_either_language(hub, said, switch, state):
    hub.prefs.control_always = False
    hub._turn_text = said
    out = await hub.mac_switches.tools["system_switch"]({"switch": switch, "state": state})
    assert hub.cards == [] and not out.get("is_error"), _said(out)


@pytest.mark.parametrize(
    ("said", "switch", "state"),
    [
        ("你把蓝牙关了吗？", "bluetooth", "off"),
        ("蓝牙关掉了吗", "bluetooth", "off"),
        ("wifi打开了没有", "wifi", "on"),
        ("你打开深色模式了吗", "dark_mode", "on"),
    ],
)
async def test_a_question_in_chinese_asks_for_nothing(hub, said, switch, state):
    """A question ("did you turn Bluetooth off?"), in Chinese as in English: a card."""
    hub.prefs.control_always = False
    hub._turn_text = said
    out = await hub.mac_switches.tools["system_switch"]({"switch": switch, "state": state})
    assert len(hub.cards) == 1 and out["is_error"], _said(out)


async def test_a_focus_runs_the_owners_shortcut(hub, mac):
    hub.prefs.control_always = False
    hub._turn_text = "turn on work focus"
    out = await hub.mac_switches.tools["system_switch"](
        {"switch": "focus", "state": "on", "mode": "Work"}
    )
    assert hub.cards == [] and ("shortcuts", "run", "Work Focus On") in mac.ran
    assert _said(out) == "The Work Focus is on (ran “Work Focus On”)."
    # Words that named another mode are no yes for this one.
    hub._turn_text = "turn on work focus"
    await hub.mac_switches.tools["system_switch"](
        {"switch": "focus", "state": "on", "mode": "Sleep"}
    )
    assert hub.cards == ["Turn on the Sleep Focus?"]
    out = await hub.mac_switches.tools["system_switch"](
        {"switch": "focus", "state": "on", "mode": "Reading"}
    )
    assert out["is_error"] and "Shortcuts' Set Focus action" in _said(out)


async def test_do_not_disturb_by_its_short_name(hub, mac):
    hub.prefs.control_always = False
    hub._turn_text = "turn on dnd"
    out = await hub.mac_switches.tools["system_switch"]({"switch": "dnd", "state": "on"})
    assert hub.cards == [] and ("shortcuts", "run", "DND On") in mac.ran, _said(out)


async def test_bad_switches_are_refused(hub):
    out = await hub.mac_switches.tools["system_switch"]({"switch": "firewall", "state": "off"})
    assert out["is_error"] and hub.cards == []
    out = await hub.mac_switches.tools["system_switch"]({"switch": "wifi", "state": "sideways"})
    assert out["is_error"]


async def test_the_status(hub):
    text = _said(await hub.mac_switches.tools["switch_status"]({}))
    assert text.splitlines()[:3] == ["Dark mode: off", "Wi-Fi: on", "Bluetooth: off"]


# ── home questions ──


async def test_only_marked_shortcuts_answer_questions(hub, mac):
    out = await hub.mac_switches.tools["ask_home"]({"shortcut": "Movie Night"})
    assert out["is_error"] and "No home questions are set up" in _said(out)
    hub.set_feature_prefs({feature.HOME_PREF: ["Is the garage closed"]})
    out = await hub.mac_switches.tools["ask_home"]({"shortcut": "Movie Night"})
    assert out["is_error"] and "“Is the garage closed”" in _said(out)
    assert not any(c[:2] == ("shortcuts", "run") for c in mac.ran)


async def test_a_home_question_reads_out_its_answer(hub, mac):
    hub.set_feature_prefs({feature.HOME_PREF: ["Is the garage closed"]})

    async def command(*argv, timeout=30):
        mac.ran.append(argv)
        Path(argv[argv.index("--output-path") + 1]).write_text("Yes, it's closed.\n")
        return ""

    hub.mac_switches.command = command
    out = await hub.mac_switches.tools["ask_home"]({"shortcut": "is the garage closed"})
    assert hub.cards == []
    assert mac.ran[-1][:3] == ("shortcuts", "run", "Is the garage closed")
    assert _said(out).endswith("Yes, it's closed.")
    listed = _said(await hub.mac_switches.tools["home_questions"]({}))
    assert listed == "- Is the garage closed"
    assert "“Is the garage closed”" in hub._feature_prompt()


def test_the_home_questions_setting_is_checked():
    clean = feature.prefs.FEATURE_PREFS[feature.HOME_PREF][1]
    assert clean(["A", "A", " B ", "", 3]) == ["A", "B"]
    assert clean("A") is None
