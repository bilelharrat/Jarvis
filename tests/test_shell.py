"""The Mac app's shell, backend side (jarvis.features.shell): pausing heads-ups from the menu
bar, and the app's settings kept with the others."""

import asyncio
import types

import pytest
from conftest import FakeClient

from jarvis.features import shell
from jarvis.hub import Hub
from jarvis.proactive import Alert


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


def shown(hub):
    seen = []
    hub.add_notify_sink(lambda alert: seen.append(alert.kind))
    return seen


@pytest.fixture
def clock(monkeypatch):
    now = {"t": 1_800_000_000.0}
    monkeypatch.setattr(shell.time, "time", lambda: now["t"])
    return now


def test_the_feature_is_installed(hub):
    assert "shell" in hub.features


async def test_a_pause_holds_heads_ups_back_for_its_hour(hub, clock):
    seen = shown(hub)
    await hub._handle({"type": "shell_pause", "minutes": 60})
    assert hub.prefs.feature(shell.PAUSE_KEY) == clock["t"] + 3600
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain in an hour."), speak=False)
    hub.notify(Alert("leave:1", "leave", "Time to go", "Leave in 10 minutes."), speak=False)
    # What shows even with heads-ups off still shows.
    hub.notify(Alert("call:1", "call", "Call", "Ann called."), speak=False)
    assert seen == ["call"]
    assert not any(h["text"] == "Rain in an hour." for h in hub.history)
    clock["t"] += 3601
    hub.notify(Alert("rain:2", "rain", "Rain", "Rain soon."), speak=False)
    assert seen == ["call", "rain"]


async def test_resume_and_odd_minutes(hub, clock):
    await hub._handle({"type": "shell_pause", "minutes": 5000})
    assert hub.prefs.feature(shell.PAUSE_KEY) == clock["t"] + 12 * 3600  # at most 12 hours
    await hub._handle({"type": "shell_pause", "minutes": "lots"})  # ignored
    assert hub.prefs.feature(shell.PAUSE_KEY) == clock["t"] + 12 * 3600
    await hub._handle({"type": "shell_pause", "minutes": 0})
    assert hub.prefs.feature(shell.PAUSE_KEY) == 0.0
    seen = shown(hub)
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain in an hour."), speak=False)
    assert seen == ["rain"]


async def test_a_pause_reaches_the_window_in_the_settings(hub, clock):
    queue = hub.subscribe()
    await hub._handle({"type": "shell_pause", "minutes": 60})
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    prefs = [e for e in events if e["type"] == "prefs"]
    assert prefs and prefs[-1]["features"][shell.PAUSE_KEY] == clock["t"] + 3600


def test_a_hand_edited_pause_never_silences_for_good(hub, clock):
    assert shell._clean_until(clock["t"] + 30 * 24 * 3600) is None
    assert shell._clean_until(float("nan")) is None
    assert shell._clean_until(True) is None
    assert shell._clean_until(-5) is None
    assert shell._clean_until(clock["t"] + 600) == clock["t"] + 600
    # The settings file is read before features register their checks: a raw value that
    # slipped in is still read safely.
    for raw in ("tomorrow", clock["t"] + 30 * 24 * 3600, None, [1]):
        hub.prefs.features[shell.PAUSE_KEY] = raw
        assert shell.paused(hub) is False
    seen = shown(hub)
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain in an hour."), speak=False)
    assert seen == ["rain"]


async def test_the_menu_bar_setting(hub):
    assert hub.prefs.feature(shell.MENU_BAR_KEY) is True
    await hub._handle({"type": "feature_prefs", "changes": {shell.MENU_BAR_KEY: False}})
    assert hub.prefs.feature(shell.MENU_BAR_KEY) is False
    await hub._handle({"type": "feature_prefs", "changes": {shell.MENU_BAR_KEY: "no"}})
    assert hub.prefs.feature(shell.MENU_BAR_KEY) is False


def test_a_failing_gate_holds_nothing_back(hub):
    def broken(_alert):
        raise RuntimeError("a broken gate")

    hub.add_notify_gate(broken)
    seen = shown(hub)
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain in an hour."), speak=False)
    assert seen == ["rain"]


def test_shortcuts_are_kept_spelled_one_way_and_checked():
    ok = shell.clean_accelerator
    assert ok("Alt+Space") == "Alt+Space"
    assert ok("Shift+Alt+Space") == "Alt+Shift+Space"
    assert ok("Shift+Command+J") == "Command+Shift+J"
    assert ok("F13") == "F13"
    for bad in (
        "Command+J",
        "Shift+K",
        "K",
        "Control+Space",
        "Command+Shift+4",
        "Alt+",
        "Alt+Alt+J",
    ):
        assert ok(bad) is None, bad
    for bad in ("Hyper+J", "Alt+Escape", "", 5, None, ["Alt+J"], "Alt+" + "J" * 70):
        assert ok(bad) is None, bad


async def test_the_shortcut_settings(hub):
    assert hub.prefs.feature(shell.ASK_SHORTCUT_KEY) == "Alt+Space"
    assert hub.prefs.feature(shell.WHATS_THIS_SHORTCUT_KEY) == "Alt+Shift+Space"
    await hub._handle(
        {"type": "feature_prefs", "changes": {shell.ASK_SHORTCUT_KEY: "Shift+Control+Alt+J"}}
    )
    assert hub.prefs.feature(shell.ASK_SHORTCUT_KEY) == "Control+Alt+Shift+J"
    # One that would take ⌘J from every app is refused: the old one stays.
    await hub._handle({"type": "feature_prefs", "changes": {shell.ASK_SHORTCUT_KEY: "Command+J"}})
    assert hub.prefs.feature(shell.ASK_SHORTCUT_KEY) == "Control+Alt+Shift+J"


# ── waking the Mac for the morning briefing ──

SCHEDULED = (
    "Repeating power events:\n"
    "  wakepoweron at 7:55AM every day\n"
    "  shutdown at 11:00PM weekdays only\n"
    "Scheduled power events:\n"
    " [0]  wake at 09/28/2026 16:26:45 by 'com.apple.alarm'\n"
)


@pytest.fixture
def mac(monkeypatch):
    """pmset and osascript as the tests play them: every call recorded, none ever run."""
    state = {"calls": [], "sched": (0, "", ""), "admin": (0, "", ""), "here": True}

    async def fake_run(*argv, timeout):
        state["calls"].append(argv)
        if argv[:3] == (shell.PMSET, "-g", "sched"):
            return state["sched"]
        if argv[:2] == (shell.OSASCRIPT, "-e"):
            assert timeout == shell.PASSWORD_WAIT
            return state["admin"]
        raise AssertionError(f"ran {argv}")

    monkeypatch.setattr(shell, "_run", fake_run)
    monkeypatch.setattr(shell, "_pmset_here", lambda: state["here"])
    return state


async def wake(hub, action):
    """One of Settings' wake commands, carried out; the shell_wake events it sent."""
    queue = hub.subscribe()
    await hub._handle({"type": "shell_wake", "action": action})
    desk = hub._commands["shell_wake"][0].__self__
    await asyncio.gather(*desk._tasks)
    events = []
    while not queue.empty():
        event = queue.get_nowait()
        if event["type"] == "shell_wake":
            events.append(event)
    hub.unsubscribe(queue)
    return events


async def test_the_wake_status_says_what_is_scheduled_and_when_it_would_wake(hub, mac):
    [event] = await wake(hub, "status")
    assert mac["calls"] == [(shell.PMSET, "-g", "sched")]  # read-only
    assert event["time"] == "07:55" and event["reason"] == "briefing"  # 8:00 briefing
    assert event["scheduled"] is None and event["matches"] is False and event["busy"] is False
    mac["sched"] = (0, SCHEDULED, "")
    [event] = await wake(hub, "status")
    assert event["scheduled"] == {
        "entry": "wakepoweron at 7:55AM every day",
        "minutes": 7 * 60 + 55,
        "days": "every day",
    }
    assert event["matches"] is True
    assert event["others"] == ["shutdown at 11:00PM weekdays only"]
    # The briefing moved: the wake scheduled no longer fits it.
    hub.set_prefs({"briefing_time": "09:30"})
    [event] = await wake(hub, "status")
    assert event["time"] == "09:25" and event["matches"] is False


async def test_setting_the_wake_asks_for_the_password_in_macos_own_prompt(hub, mac):
    hub.set_prefs({"wake_call": True, "wake_call_time": "06:30"})
    mac["sched"] = (0, SCHEDULED.replace("7:55AM", "6:25AM"), "")
    events = await wake(hub, "set")
    [admin] = [c for c in mac["calls"] if c[0] == shell.OSASCRIPT]
    script = admin[2]
    assert script.startswith(
        'do shell script "/usr/bin/pmset repeat wakeorpoweron MTWRFSU 06:25:00" with prompt "'
    )
    assert script.endswith('" with administrator privileges')
    assert "every day at 06:25, 5 minutes before your wake-up call" in script
    assert [e["busy"] for e in events] == [True, False]
    assert events[-1]["matches"] is True and events[-1]["note"] == ""


async def test_the_password_prompt_speaks_the_owner_s_language(hub, mac):
    # Only the setting (set_prefs would switch the voice and the speech model too).
    hub.prefs.language = "zh"
    await wake(hub, "clear")
    [admin] = [c for c in mac["calls"] if c[0] == shell.OSASCRIPT]
    assert admin[2] == (
        'do shell script "/usr/bin/pmset repeat cancel" with prompt '
        '"J.A.R.V.I.S. 想停止每天唤醒这台 Mac。" with administrator privileges'
    )


async def test_cancel_failure_and_a_mac_without_pmset(hub, mac):
    mac["admin"] = (1, "", "execution error: User canceled. (-128)")
    assert (await wake(hub, "set"))[-1]["note"] == "cancelled"
    mac["admin"] = (1, "", "execution error: something else (-60005)")
    assert (await wake(hub, "clear"))[-1]["note"] == "failed"
    mac["here"] = False
    mac["calls"].clear()
    events = await wake(hub, "set")
    assert events[-1]["note"] == "unavailable" and mac["calls"] == []


async def test_one_change_at_a_time_and_only_the_known_actions(hub, mac):
    desk = hub._commands["shell_wake"][0].__self__
    await hub._handle({"type": "shell_wake", "action": "set"})
    await hub._handle({"type": "shell_wake", "action": "set"})  # a second click meanwhile
    await hub._handle({"type": "shell_wake", "action": "clear"})
    await hub._handle({"type": "shell_wake", "action": "shutdown"})
    await hub._handle({"type": "shell_wake"})
    await asyncio.gather(*desk._tasks)
    assert len([c for c in mac["calls"] if c[0] == shell.OSASCRIPT]) == 1
    assert desk.busy is False


def test_when_to_wake():
    def prefs(briefing=True, briefing_time="08:00", call=False, call_time="07:00"):
        return types.SimpleNamespace(
            briefing_enabled=briefing,
            briefing_time=briefing_time,
            wake_call=call,
            wake_call_time=call_time,
        )

    assert shell.wake_time(prefs()) == ("07:55", "briefing")
    assert shell.wake_time(prefs(call=True)) == ("06:55", "wake_call")
    assert shell.wake_time(prefs(call=True, call_time="09:00")) == ("07:55", "briefing")
    assert shell.wake_time(prefs(briefing=False, call=True)) == ("06:55", "wake_call")
    # Neither on: the briefing's time. Just after midnight: just before it, the day before.
    assert shell.wake_time(prefs(briefing=False, briefing_time="00:03")) == ("23:58", "briefing")
    assert shell.wake_time(prefs(briefing_time="8am")) == ("07:55", "briefing")


def test_reading_the_schedule():
    assert shell.parse_schedule("") == {"wake": None, "others": []}
    one_time = "Scheduled power events:\n [0]  wake at 09/28/2026 16:26:45 by 'x'\n"
    assert shell.parse_schedule(one_time) == {"wake": None, "others": []}
    noon = shell.parse_schedule("Repeating power events:\n  poweron at 12:30PM weekends only\n")
    assert noon["wake"] == {
        "entry": "poweron at 12:30PM weekends only",
        "minutes": 12 * 60 + 30,
        "days": "weekends only",
    }
    night = shell.parse_schedule("Repeating power events:\n  wakepoweron at 12:05AM every day\n")
    assert night["wake"]["minutes"] == 5
    sleep_only = shell.parse_schedule("Repeating power events:\n  sleep at 11:00PM every day\n")
    assert sleep_only == {"wake": None, "others": ["sleep at 11:00PM every day"]}


def test_the_admin_script_carries_only_its_own_command():
    script = shell.admin_script("set", "06:55", 'Say "yes" \\ please')
    assert script == (
        'do shell script "/usr/bin/pmset repeat wakeorpoweron MTWRFSU 06:55:00" '
        'with prompt "Say \\"yes\\" \\\\ please" with administrator privileges'
    )
    for action, when in (
        ("set", "6:55"),
        ("set", '06:55" & do shell script "rm'),
        ("nuke", "06:55"),
    ):
        with pytest.raises(ValueError):
            shell.admin_script(action, when, "x")


async def test_a_request_a_link_wrote_is_never_the_owners_own_words(hub, monkeypatch):
    """A jarvis:// link (any web page, or a selection sent from the Services menu) fills the
    request box, and the window marks what's sent from there (from_link). The hub then never
    takes those words for the owner's: no instant Mac command runs from them, nothing in them
    counts as the owner asking (the gates ask), and the turn counts as having read outside
    content. The same words typed by the owner are theirs."""
    from jarvis import system_voice

    await hub.start()
    ran, during = [], []

    async def carry_out(command, **_kw):
        ran.append(command.kind)
        return "Done."

    monkeypatch.setattr(system_voice, "carry_out", carry_out)
    query = hub.client.query

    async def watch(text):
        reads = hub._gate_reads()
        during.append((hub._turn_text, reads["private"], list(reads["what"])))
        await query(text)

    monkeypatch.setattr(hub.client, "query", watch)

    async def settled():
        for _ in range(200):
            if not [t for t in hub._background if not t.done()] and hub.state == "idle":
                return
            await asyncio.sleep(0.01)

    await hub._handle({"type": "ask", "text": "press command Q", "from_link": True})
    await settled()
    assert ran == []  # never an instant command: Claude has it, with the gates
    assert during == [("", True, ["a request a link wrote"])]
    assert [h["text"] for h in hub.history if h["role"] == "user"] == ["press command Q"]
    await hub._handle({"type": "ask", "text": "press command Q"})  # typed by the owner
    await settled()
    assert ran == ["keys"] and len(during) == 1


def test_cards_name_a_links_words_in_chinese_too():
    from jarvis import hub as hubmod
    from jarvis import lang

    assert lang.translate(hubmod.LINK_WORDS, "zh") == "链接写下的请求"
