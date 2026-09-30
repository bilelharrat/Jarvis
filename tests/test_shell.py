"""The Mac app's shell, backend side (jarvis.features.shell): pausing heads-ups from the menu
bar, and the app's settings kept with the others."""

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
