"""Quiet hours that follow a Focus mode, the weekend's own hours, and a snooze said out loud
(jarvis.features.proactive.quiet). The Focus files are temp copies, never the Mac's own."""

import asyncio
import json
import os
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from conftest import FakeClient

from jarvis import proactive
from jarvis.features.proactive import feature_of
from jarvis.features.proactive import quiet as q
from jarvis.hub import Hub
from jarvis.proactive import Alert

MONDAY = datetime(2026, 9, 28)  # Monday 28 September 2026, midnight
MON_23 = MONDAY + timedelta(hours=23)


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


def assertions(mode_id="com.apple.focus.work"):
    return {
        "data": [
            {
                "storeAssertionRecords": [
                    {
                        "assertionDetails": {"assertionDetailsModeIdentifier": mode_id},
                        "assertionStartDateTimestamp": 780000000.0,
                    }
                ]
            }
        ],
        "header": {"version": 3},
    }


def configs(weekdays=62, start=(22, 0), end=(7, 0), enabled=2):
    return {
        "data": [
            {
                "modeConfigurations": {
                    "com.apple.focus.work": {
                        "mode": {"name": "Work"},
                        "triggers": {"triggers": []},
                    },
                    "com.apple.sleep.sleep-mode": {
                        "mode": {"name": "Sleep"},
                        "triggers": {
                            "triggers": [
                                {
                                    "class": "DNDModeConfigurationScheduleTrigger",
                                    "enabledSetting": enabled,
                                    "timePeriodStartTimeHour": start[0],
                                    "timePeriodStartTimeMinute": start[1],
                                    "timePeriodEndTimeHour": end[0],
                                    "timePeriodEndTimeMinute": end[1],
                                    "timePeriodWeekdays": weekdays,
                                }
                            ]
                        },
                    },
                }
            }
        ]
    }


# ── Focus, as macOS keeps it ──


def test_a_focus_turned_on_by_hand_is_on_by_its_name():
    noon = datetime(2026, 9, 29, 12, 0)
    assert q.focus_state(assertions(), configs(), noon) == {"state": "on", "name": "Work"}
    # A mode the configurations don't list still counts, by the name macOS gives it.
    dnd = assertions("com.apple.donotdisturb.mode.default")
    assert q.focus_state(dnd, None, noon) == {"state": "on", "name": "Do Not Disturb"}
    assert q.focus_state({"data": [{"storeAssertionRecords": []}]}, configs(), noon) == {
        "state": "off"
    }


def test_a_scheduled_focus_covers_its_nights_by_the_day_they_start():
    off = {"data": [{}]}
    week = configs(weekdays=62)  # Monday to Friday, 22:00 to 07:00
    at = lambda day, hour: MONDAY + timedelta(days=day, hours=hour)  # noqa: E731
    assert q.focus_state(off, week, at(0, 23)) == {"state": "on", "name": "Sleep"}  # Mon night
    assert q.focus_state(off, week, at(1, 6)) == {"state": "on", "name": "Sleep"}  # Tue morning
    assert q.focus_state(off, week, at(0, 6))["state"] == "off"  # Monday 6am: Sunday's night
    assert q.focus_state(off, week, at(5, 1))["state"] == "on"  # Saturday 1am: Friday's night
    assert q.focus_state(off, week, at(5, 23))["state"] == "off"  # Saturday night: not in it
    assert q.focus_state(off, week, at(0, 12))["state"] == "off"
    assert q.focus_state(off, configs(enabled=1), at(0, 23))["state"] == "off"  # switched off
    day = configs(weekdays=127, start=(13, 0), end=(14, 0))
    assert q.focus_state(off, day, at(3, 13))["state"] == "on"
    assert q.focus_state(off, day, at(3, 14))["state"] == "off"


def test_focus_files_that_are_odd_never_break_it():
    noon = datetime(2026, 9, 29, 12, 0)
    for junk in (None, [], "x", {"data": "x"}, {"data": [1, None, {"storeAssertionRecords": "x"}]}):
        assert q.focus_state(junk, junk, noon) == {"state": "off"}
    broken = {"data": [{"modeConfigurations": {"m": {"triggers": {"triggers": [{"class": "x"}]}}}}]}
    assert q.focus_state({}, broken, noon) == {"state": "off"}
    odd = configs()
    trigger = odd["data"][0]["modeConfigurations"]["com.apple.sleep.sleep-mode"]["triggers"]
    trigger["triggers"][0]["timePeriodStartTimeHour"] = "ten"
    assert q.focus_state({}, odd, MON_23) == {"state": "off"}


def test_reading_focus_says_why_it_cant(tmp_path):
    assert q.read_focus(tmp_path) == {"state": "unavailable"}  # no such files
    (tmp_path / "Assertions.json").write_text(json.dumps(assertions()))
    (tmp_path / "ModeConfigurations.json").write_text(json.dumps(configs()))
    assert q.read_focus(tmp_path, MON_23) == {"state": "on", "name": "Work"}
    (tmp_path / "Assertions.json").write_text("{not json")
    assert q.read_focus(tmp_path) == {"state": "unavailable"}
    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "Assertions.json").write_text("{}")
    os.chmod(locked / "Assertions.json", 0)
    try:
        assert q.read_focus(locked) == {"state": "no_access"}  # Full Disk Access is off
    finally:
        os.chmod(locked / "Assertions.json", 0o600)


# ── the weekend's own hours ──


def test_a_night_keeps_the_hours_of_the_morning_it_ends_in():
    week, weekend = "22:00-07:00", "23:30-09:00"
    at = lambda day, h, m=0: MONDAY + timedelta(days=day, hours=h, minutes=m)  # noqa: E731
    quiet = lambda when: q.weekend_quiet(when, week, weekend)  # noqa: E731
    assert quiet(at(0, 22, 30))  # Monday night
    assert quiet(at(1, 6, 30)) and not quiet(at(1, 7, 30))  # Tuesday morning
    assert not quiet(at(4, 22, 30)) and quiet(at(4, 23, 45))  # Friday night: the weekend's
    assert quiet(at(5, 8, 30)) and not quiet(at(5, 9, 0))  # Saturday morning
    assert quiet(at(6, 22, 30))  # Sunday night: a school night again
    assert quiet(at(7, 6, 0)) and not quiet(at(7, 8, 0))  # Monday morning
    # None at all at weekends, and a daytime range on one kind of day only.
    assert not q.weekend_quiet(at(5, 8, 0), week, "00:00-00:00")
    assert q.weekend_quiet(at(5, 13, 30), "00:00-00:00", "13:00-15:00")
    assert not q.weekend_quiet(at(2, 13, 30), "00:00-00:00", "13:00-15:00")


# ── the hub's quiet hours ──


async def test_focus_the_weekend_and_a_pause_decide_the_hubs_quiet_hours(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    part = feature_of(hub).quiet
    hub.prefs.quiet_hours = "22:00-07:00"
    noon, night = datetime(2026, 9, 29, 12, 0), datetime(2026, 9, 29, 23, 0)
    assert not hub.quiet_now(noon) and hub.quiet_now(night)
    part.focus = {"state": "on", "name": "Work"}
    assert hub.quiet_now(noon) and part.why(noon) == "focus"
    hub.set_feature_prefs({"quiet_focus": False})  # not followed: the range again
    assert not hub.quiet_now(noon)
    hub.set_feature_prefs({"quiet_weekend": "23:30-09:00"})
    saturday_8 = datetime(2026, 10, 3, 8, 0)
    friday_2230 = datetime(2026, 10, 2, 22, 30)
    assert hub.quiet_now(saturday_8) and part.why(saturday_8) == "weekend"
    assert not hub.quiet_now(friday_2230)  # the weekend's False beats the weekday range
    hub.set_feature_prefs({"shell_pause_until": time.time() + 600})
    assert hub.quiet_now(friday_2230) and part.why(friday_2230) == "paused"
    # What the interrupter and the suggestions read: the hub's say, else the range.
    assert hub._quiet_spec() is True
    hub.set_feature_prefs({"shell_pause_until": 0.0, "quiet_weekend": ""})
    assert hub._quiet_spec() == "22:00-07:00"
    assert part.state()["weekend"] == "" and part.state()["snooze"] is True


async def test_in_focus_a_heads_up_is_a_card_not_words(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.quiet_hours = "00:00-00:00"  # no quiet hours of its own
    said = []
    hub._announce_later = said.append
    shown = []
    hub.add_notify_sink(shown.append)
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain at 5."))
    assert said == ["Rain at 5."]
    feature_of(hub).quiet.focus = {"state": "on", "name": "Sleep"}
    hub.notify(Alert("rain:2", "rain", "Rain", "Rain at 6."))
    assert said == ["Rain at 5."] and [a.key for a in shown] == ["rain:1", "rain:2"]


async def test_the_kits_hear_the_hubs_say(settings, quiet_speaker, isolated, tmp_path):
    from jarvis.interrupts import Interrupter
    from jarvis.suggestions import Suggester

    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.quiet_hours = "00:00-00:00"
    now = datetime.now()
    # As the hub wires its own (the tests' hubs get a stand-in interrupter).
    interrupter = Interrupter(
        lambda _a: None, state_path=tmp_path / "i.json", quiet_hours=hub._quiet_spec
    )
    assert interrupter._quiet(now) is False
    feature_of(hub).quiet.focus = {"state": "on", "name": "Work"}
    assert interrupter._quiet(now) is True

    s = Suggester(lambda _s: None, tmp_path / "s.json", quiet_hours=hub._quiet_spec)
    assert await s._moment(now) is False  # quiet: no suggestion now
    feature_of(hub).quiet.focus = {"state": "off"}
    assert await s._moment(now) is True
    # Code that has the hub: its say, else its own range check (which a test may fake).
    assert proactive.quiet_hours_now(hub, now, lambda *_a: True) is True
    feature_of(hub).quiet.focus = {"state": "on", "name": "Work"}
    assert proactive.quiet_hours_now(hub, now, lambda *_a: False) is True
    plain = SimpleNamespace(prefs=SimpleNamespace(quiet_hours="00:00-23:59"))
    assert proactive.quiet_hours_now(plain, datetime(2026, 9, 29, 12, 0)) is True


async def test_a_focus_look_reads_the_files_and_tells_the_window(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    part = feature_of(hub).quiet
    part.folder = tmp_path
    seen = []
    hub.add_event_sink(("proactive",), seen.append)
    assert (await part.look()) == {"state": "unavailable"}
    (tmp_path / "Assertions.json").write_text(json.dumps(assertions()))
    (tmp_path / "ModeConfigurations.json").write_text(json.dumps(configs()))
    assert (await part.look()) == {"state": "on", "name": "Work"}
    await part.look()  # nothing changed: nothing sent
    assert [e["quiet"]["focus"]["state"] for e in seen] == ["unavailable", "on"]
    assert seen[-1]["quiet"]["quiet"] is True and seen[-1]["quiet"]["why"] == "focus"
    hub.set_feature_prefs({"quiet_focus": False})
    assert (await part.look()) == {"state": "unknown"}  # not followed: never read


# ── the snooze ──


@pytest.mark.parametrize(
    ("said", "minutes"),
    [
        ("snooze everything for an hour", 60),
        ("Jarvis, snooze everything", 60),
        ("pause heads-ups for 30 minutes", 30),
        ("Could you please silence all notifications for 45 minutes?", 45),
        ("be quiet for an hour and a half", 90),
        ("mute alerts for 2 hrs", 120),
        ("don't disturb me until 3:30pm", 80),
        ("pause notifications until 3", 50),
        ("resume heads-ups", 0),
        ("turn notifications back on", 0),
        ("暂停提醒一小时", 60),
        ("一个小时内别打扰我", 60),
        ("能暂停通知半小时吗？", 30),
        ("安静一个半小时", 90),
        ("恢复提醒吧", 0),
        ("snooze the pasta timer", None),  # a timer's, not heads-ups
        ("what's the weather", None),
        ("snooze everything for the rest of the day", None),  # Claude works that one out
        ("pause heads-ups for 20 hours", None),  # past the longest pause
        ("hold off notifications till noon", None),  # noon has gone: tomorrow is too far
    ],
)
def test_snooze_lengths_said(said, minutes):
    assert q.parse_snooze(said, datetime(2026, 9, 29, 14, 10)) == minutes


async def test_a_snooze_said_is_done_at_once_without_claude(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    before = time.time()
    reply = await hub.ask("snooze everything for an hour")
    assert reply.startswith("Heads-ups are paused until ")
    until = hub.prefs.feature("shell_pause_until")
    assert before + 3590 <= until <= time.time() + 3610
    assert hub.quiet_now()
    hub.notify(Alert("rain:1", "rain", "Rain", "Rain at 5."), speak=False)  # held back
    assert not [h for h in hub.history if h["text"] == "Rain at 5."]
    assert await hub.ask("resume heads-ups") == "Heads-ups are back on."
    assert hub.prefs.feature("shell_pause_until") == 0.0
    # With nothing paused, "resume" is left to Claude, who can say so.
    await hub.ask("resume heads-ups")
    assert hub.client.said == ["resume heads-ups"]
    hub.prefs.language = "zh"  # no language switch: it would voice fillers with the real say
    reply = await hub.ask("暂停提醒半小时")
    assert reply.startswith("提醒已暂停，到") and reply.endswith("为止。")


async def test_the_snooze_tool_asks_unless_the_owner_said_it(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    [snooze] = feature_of(hub).quiet.tools()
    cards = []
    hub.add_approval_sink(cards.append)

    async def answer(choice):
        while not cards:
            await asyncio.sleep(0)
        hub.resolve(cards[-1]["id"], choice)

    hub._turn_text = ""  # a routine's request, say: a card first
    asked = asyncio.create_task(snooze.handler({"minutes": 45}))
    await answer("deny")
    out = await asked
    assert out["is_error"] and hub.prefs.feature("shell_pause_until") == 0.0
    assert cards[-1]["question"].startswith("Pause heads-ups until ")
    hub._turn_text = "snooze everything until my meeting's over"
    out = await snooze.handler({"minutes": 45})
    assert "paused until" in out["content"][0]["text"] and len(cards) == 1
    assert hub.prefs.feature("shell_pause_until") > time.time() + 44 * 60
    out = await snooze.handler({"minutes": 0})
    assert out["content"][0]["text"] == "Heads-ups are back on."


async def test_settings_snooze_and_state(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = []
    hub.add_event_sink(("proactive",), seen.append)
    await hub._handle({"type": "proactive_snooze", "minutes": 15})
    until = hub.prefs.feature("shell_pause_until")
    assert timedelta(seconds=until - time.time()) > timedelta(minutes=14)
    assert seen[-1]["quiet"]["paused_until"] == until and seen[-1]["quiet"]["why"] == "paused"
    await hub._handle({"type": "proactive_snooze", "minutes": 0})
    assert hub.prefs.feature("shell_pause_until") == 0.0
    await hub._handle({"type": "proactive_snooze", "minutes": "soon"})  # ignored
    await hub._handle({"type": "proactive_state"})
    assert set(seen[-1]) >= {"type", "quiet"} and seen[-1]["quiet"]["follow"] is True


def test_quiet_settings_are_checked():
    assert q.clean_range("23:30-09:00") == "23:30-09:00"
    assert q.clean_range("") == ""
    for bad in ("25:00-09:00", "23:30", 7, None, "23:30-9:00"):
        assert q.clean_range(bad) is None
