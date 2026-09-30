"""Timers, alarms and reminders (jarvis.timers and the automation feature's tools): to the
second, said and shown in the owner's language, rung until stopped or snoozed, kept across
a restart, and set or cancelled unasked only when the owner's own words asked for it."""

import asyncio
import json
from dataclasses import asdict
from datetime import datetime, timedelta

import pytest

from jarvis import timers as tk
from jarvis.features import automation

NOW = datetime(2026, 9, 29, 15, 30, 0)


class Clock:
    def __init__(self, at=NOW):
        self.at = at

    def __call__(self):
        return self.at

    def tick(self, **delta):
        self.at += timedelta(**delta)


def make(tmp_path, clock=None, **kw):
    heard, played = [], []
    timers = tk.Timers(
        tmp_path / "timers.json",
        lambda alert, busy: heard.append((alert, busy)),
        now=clock or Clock(),
        play=played.append,
        **kw,
    )
    return timers, heard, played


# ── what's asked for ──


def test_a_timer_counts_down_to_the_second():
    timer = tk.new_timer(90, "  tea ", NOW)
    assert (timer.kind, timer.label, timer.seconds) == ("timer", "tea", 90)
    assert timer.due_at == NOW + timedelta(seconds=90)
    for bad in (0, -5, 24 * 3600 + 1, "soon", None):
        with pytest.raises(ValueError):
            tk.new_timer(bad, "", NOW)


def test_an_alarm_is_the_next_time_that_comes():
    assert tk.new_alarm("16:00", "", NOW).due_at == datetime(2026, 9, 29, 16, 0)
    assert tk.new_alarm("6:30", "wake up", NOW).due_at == datetime(2026, 9, 30, 6, 30)
    assert tk.new_alarm("15:30:15", "", NOW).due_at == datetime(2026, 9, 29, 15, 30, 15)
    assert tk.new_alarm("07:15", "", NOW, "2026-10-02").due_at == datetime(2026, 10, 2, 7, 15)
    for bad in ("25:00", "6.30", "", "7am"):
        with pytest.raises(ValueError):
            tk.new_alarm(bad, "", NOW)
    with pytest.raises(ValueError, match="passed"):
        tk.new_alarm("07:15", "", NOW, "2026-09-29")


def test_reminders_once_or_repeating_until_a_time():
    once = tk.new_reminder("check the oven", NOW, in_minutes=10)
    assert once.due_at == datetime(2026, 9, 29, 15, 40) and not once.every
    at_three = tk.new_reminder("call Ann", datetime(2026, 9, 29, 9, 0), at="15:00")
    assert at_three.due_at == datetime(2026, 9, 29, 15, 0)
    stretch = tk.new_reminder("stretch", NOW, every_minutes=20, until="18:00")
    assert stretch.due_at == datetime(2026, 9, 29, 15, 50) and stretch.every == 1200
    assert stretch.until == "2026-09-29T18:00:00"
    for bad in (
        {"text": ""},
        {"text": "x"},  # no when
        {"text": "x", "every_minutes": 0.5},
        {"text": "x", "in_minutes": 5, "until": "18:00"},  # until needs a repeat
        {"text": "x", "every_minutes": 20, "at": "17:00", "until": "16:00"},
    ):
        text = bad.pop("text")
        with pytest.raises(ValueError):
            tk.new_reminder(text, NOW, **bad)


def test_the_store_keeps_them_across_a_restart_and_rows_it_cant_use(tmp_path):
    path = tmp_path / "timers.json"
    store = tk.TimerStore(path)
    store.add(tk.new_timer(600, "pasta", NOW))
    path.write_text(json.dumps([*json.loads(path.read_text()), {"id": 5}, "junk"]))
    again = tk.TimerStore(path)
    assert [t.label for t in again.items] == ["pasta"] and len(again.broken) == 2
    again.save()
    assert len(json.loads(path.read_text())) == 3  # nothing another build wrote is lost


def test_a_countdowns_instant_that_cant_be_right_leaves_the_wall_clock_to_decide(tmp_path):
    """Its instant of the wrong type, or far from its time on the wall (due changed by hand,
    or by an older build that doesn't keep it): due decides, as it did before."""
    path = tmp_path / "timers.json"
    store = tk.TimerStore(path)
    store.add(tk.new_timer(600, "pasta", NOW))
    [row] = json.loads(path.read_text())
    assert row["at"] == (NOW + timedelta(minutes=10)).timestamp()
    rows = [
        {**row, "id": "a", "at": "soon"},
        {**row, "id": "b", "at": float("inf")},
        {**row, "id": "c", "due": "2026-09-30T09:00:00"},  # moved by hand to tomorrow
        {**row, "id": "d", "at": -5},
    ]
    path.write_text(json.dumps(rows))
    due = {t.id: t.instant() for t in tk.TimerStore(path).items}
    assert due == {
        "a": row["at"],
        "b": row["at"],
        "c": datetime(2026, 9, 30, 9, 0).timestamp(),
        "d": row["at"],
    }


def test_a_hand_edited_row_never_stops_the_clock(tmp_path):
    """A reminder repeating every 10**14 seconds, a timer that long, one due in the year
    9999 (hand edits): the clock never fails on them, and every other one still goes off."""
    path = tmp_path / "timers.json"
    alarm = tk.new_alarm("15:31", "wake", NOW)
    odd = [
        {**asdict(tk.new_reminder("x", NOW, in_minutes=1)), "id": "r1", "every": 10**14},
        {**asdict(tk.new_timer(60, "y", NOW)), "id": "t1", "seconds": 10**14},
        {**asdict(tk.new_reminder("z", NOW, every_minutes=5)), "id": "r2", "due": "9999-12-31T23:59:00", "at": 0},
    ]  # fmt: skip
    path.write_text(json.dumps([*odd, asdict(alarm)]))
    clock = Clock()
    timers, heard, _played = make(tmp_path, clock)
    clock.tick(minutes=2)
    timers.fire_due(clock())
    assert [a.kind for a, _busy in heard][-1] == "alarm"  # the alarm still went off
    timers.fire_due(clock())  # and the next look is fine too
    clock.at = datetime(9999, 12, 31, 23, 59, 30)
    timers.fire_due(clock())
    timers.stop()


def test_a_file_that_cant_be_read_is_never_saved_over(tmp_path):
    path = tmp_path / "timers.json"
    path.mkdir()  # a folder where the file should be
    store = tk.TimerStore(path)
    assert store.unreadable
    with pytest.raises(OSError):
        store.add(tk.new_timer(60, "", NOW))
    assert store.items == []


def test_find_by_id_label_or_kind(tmp_path):
    store = tk.TimerStore(tmp_path / "timers.json")
    pasta = store.add(tk.new_timer(600, "pasta", NOW))
    eggs = store.add(tk.new_timer(300, "boiled eggs", NOW))
    alarm = store.add(tk.new_alarm("06:30", "wake up", NOW))
    assert store.find(pasta.id) == [pasta]
    assert store.find("the pasta timer") == [pasta]
    assert store.find("eggs") == [eggs]
    assert store.find("the alarm") == [alarm]
    assert store.find("timers") == [pasta, eggs]
    assert store.find("") == [pasta, eggs, alarm]
    assert store.find("soup") == []


def test_the_list_reads_well_in_both_languages():
    timer = tk.new_timer(252, "pasta", NOW)
    assert timer.describe(NOW).startswith("Pasta timer: 4 minutes 12 seconds left")
    assert tk.new_timer(720, "", NOW).describe(NOW).startswith("12-minute timer: 12 minutes left")
    assert (
        tk.new_alarm("06:30", "wake up", NOW).describe(NOW).startswith("Alarm at 6:30 AM: wake up")
    )
    stretch = tk.new_reminder("stretch", NOW, every_minutes=20, until="18:00")
    assert stretch.describe(NOW).startswith(
        "Reminder: stretch, every 20 minutes until 6 PM, next at 3:50 PM"
    )
    assert timer.describe(NOW, "zh").startswith("pasta计时器：还剩4分钟12秒")
    assert tk.new_alarm("06:30", "起床", NOW).describe(NOW, "zh").startswith("闹钟 早上6:30：起床")
    assert stretch.describe(NOW, "zh").startswith(
        "提醒：stretch，每20分钟，到晚上6点为止，下一次下午3:50"
    )


# ── the clock ──


async def test_a_timer_rings_says_its_words_and_is_done(tmp_path):
    clock = Clock()
    timers, heard, played = make(tmp_path, clock)
    timers.add(tk.new_timer(600, "pasta", NOW))
    assert timers.fire_due(NOW) == []
    clock.tick(minutes=10)
    [fired] = timers.fire_due(clock())
    [(alert, busy)] = heard
    assert (alert.kind, alert.title, alert.text) == ("timer", "Timer", "Your pasta timer is done.")
    assert alert.breakthrough and busy  # through quiet hours, and said even mid-answer
    assert timers.store.items == [] and fired.id in timers.ringing
    await asyncio.sleep(0)
    assert played == [tk.SOUNDS["timer"]]
    assert timers.stop() == [fired] and timers.ringing == {}
    assert json.loads((tmp_path / "timers.json").read_text()) == []


async def test_an_alarm_rings_until_stopped_and_snooze_brings_it_back(tmp_path, monkeypatch):
    monkeypatch.setattr(tk, "RING_EVERY", {"timer": 0.01, "alarm": 0.01})
    clock = Clock()
    timers, heard, played = make(tmp_path, clock)
    alarm = timers.add(tk.new_alarm("15:31", "leave for the airport", NOW))
    clock.tick(minutes=1)
    timers.fire_due(clock())
    assert heard[0][0].text == "It's 3:31 PM: leave for the airport."
    await asyncio.sleep(0.05)
    assert len(played) >= 2 and all(p == tk.SOUNDS["alarm"] for p in played)
    [snoozed] = timers.snooze()
    assert snoozed.id == alarm.id and snoozed.snoozed == 1
    assert snoozed.due_at == clock() + timedelta(minutes=tk.SNOOZE_MINUTES)
    assert timers.ringing == {} and timers.store.items == [snoozed]
    count = len(played)
    await asyncio.sleep(0.03)
    assert len(played) == count  # silent while snoozed
    clock.tick(minutes=9)
    timers.fire_due(clock())
    assert heard[-1][0].text == "It's 3:40 PM: leave for the airport."  # snoozed at 3:31
    timers.stop("alarm")


async def test_a_stop_silences_whats_ringing(tmp_path, monkeypatch):
    monkeypatch.setattr(tk, "RING_EVERY", {"timer": 0.01, "alarm": 0.01})
    stops = [0]
    clock = Clock()
    timers, _heard, played = make(tmp_path, clock, stops=lambda: stops[0])
    timers.add(tk.new_timer(5, "", NOW))
    clock.tick(seconds=5)
    timers.fire_due(clock())
    await asyncio.sleep(0.03)
    stops[0] += 1  # "Jarvis, stop", or a tap on the orb
    await asyncio.sleep(0.03)
    count = len(played)
    await asyncio.sleep(0.03)
    assert len(played) == count and timers.ringing == {}


async def test_an_alarm_rings_the_phone_only_when_that_is_on(tmp_path):
    calls = []

    async def call(text):
        calls.append(text)

    on = [False]
    clock = Clock()
    timers, _heard, _played = make(tmp_path, clock, call=call, phone_on=lambda: on[0])
    timers.add(tk.new_alarm("15:31", "", NOW, phone=True))
    timers.add(tk.new_alarm("15:32", "", NOW, phone=False))
    clock.tick(minutes=1)
    timers.fire_due(clock())
    await asyncio.sleep(0)
    assert calls == []  # the owner hasn't turned phone alarms on
    on[0] = True
    timers.add(tk.new_alarm("15:33", "wake up", clock(), phone=True))
    clock.tick(minutes=3)
    timers.fire_due(clock())
    await asyncio.sleep(0)
    assert calls == ["It's 3:33 PM: wake up."]  # the 3:32 one asked for no call
    timers.stop()


def test_a_repeating_reminder_moves_on_and_stops_at_its_end(tmp_path):
    clock = Clock()
    timers, heard, played = make(tmp_path, clock)
    timers.add(tk.new_reminder("stretch", NOW, every_minutes=20, until="16:30"))
    clock.tick(minutes=20)
    timers.fire_due(clock())
    assert heard[-1][0].text == "Reminder: stretch." and not heard[-1][0].breakthrough
    assert not heard[-1][1] and played == []  # a gentle card: no ringing
    assert timers.store.items[0].due == "2026-09-29T16:10:00"
    clock.tick(minutes=20)
    timers.fire_due(clock())
    assert timers.store.items[0].due == "2026-09-29T16:30:00"  # its end is its last time
    clock.tick(minutes=20)
    timers.fire_due(clock())
    assert timers.store.items == [] and len(heard) == 3


@pytest.fixture
def pacific(monkeypatch):
    """This Mac's clock in a zone with daylight saving time (and back after the test)."""
    import time

    monkeypatch.setenv("TZ", "America/Los_Angeles")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


@pytest.mark.parametrize(
    "night, shows",
    [
        (datetime(2026, 11, 1, 1, 50), "2026-11-01T01:20:00"),  # 2:00 PDT is 1:00 PST again
        (datetime(2026, 3, 8, 1, 50), "2026-03-08T03:20:00"),  # 2:00 PST is 3:00 PDT
    ],
)
def test_a_countdown_counts_real_time_the_night_the_clocks_change(tmp_path, pacific, night, shows):
    """A 30-minute timer is 30 minutes of real time, and "in 45 minutes" is 45, even when
    the wall clock goes back an hour (it rang after 90) or forward one (it rang after 10)."""
    wall = [night.timestamp()]

    def now():
        return datetime.fromtimestamp(wall[0])  # the wall clock, as datetime.now() reads it

    timers, heard, _played = make(tmp_path, now)
    timers.add(tk.new_timer(30 * 60, "tea", now()))
    timers.add(tk.new_reminder("stretch", now(), in_minutes=45))
    assert timers.store.items[0].due == shows  # the time on the wall when it rings
    assert [i["left"] for i in timers.public()["items"]] == [1800, 2700]
    again = tk.TimerStore(tmp_path / "timers.json")  # as a restart reads them
    assert [t.instant() for t in again.items] == [t.instant() for t in timers.store.items]
    rang = []
    for minute in range(1, 121):
        wall[0] += 60
        timers.fire_due(now())
        rang += [minute] * (len(heard) - len(rang))
    assert rang == [30, 45]
    timers.stop()


def test_missed_while_closed_is_said_as_missed_never_rung(tmp_path):
    clock = Clock()
    timers, heard, played = make(tmp_path, clock)
    timers.add(tk.new_timer(60, "pasta", NOW))
    timers.add(tk.new_alarm("15:45", "", NOW))
    timers.add(tk.new_reminder("stretch", NOW, every_minutes=20))
    clock.tick(hours=2)  # JARVIS was closed
    timers.fire_due(clock())
    texts = [a.text for a, _busy in heard]
    assert texts == [
        "Your pasta timer went off at 3:31 PM while I was closed.",
        "Your 3:45 PM alarm went off while I was closed.",
    ]  # the reminder picks up at its next time instead
    assert timers.ringing == {} and played == []
    [reminder] = timers.store.items
    assert reminder.due_at > clock()


async def test_the_words_in_chinese(tmp_path):
    clock = Clock()
    timers, heard, _played = make(tmp_path, clock, language=lambda: "zh")
    timers.add(tk.new_timer(720, "", NOW))
    timers.add(tk.new_alarm("15:42", "起床", NOW))
    timers.add(tk.new_reminder("喝水", NOW, in_minutes=12))
    clock.tick(minutes=12)
    timers.fire_due(clock())
    assert [(a.title, a.text) for a, _ in heard] == [
        ("计时器", "你的12分钟计时器时间到了。"),
        ("闹钟", "现在是下午3:42：起床。"),
        ("提醒", "提醒：喝水。"),
    ]
    timers.close()


async def test_the_clock_fires_on_time_without_polling(tmp_path):
    timers, heard, _played = make(tmp_path, datetime.now)
    loop = asyncio.create_task(timers.run())
    await asyncio.sleep(0.05)
    started = datetime.now()
    timers.add(tk.new_timer(1, "quick", datetime.now()))
    for _ in range(40):
        if heard:
            break
        await asyncio.sleep(0.05)
    assert heard and heard[0][0].text == "Your quick timer is done."
    assert (datetime.now() - started).total_seconds() < 1.8
    timers.stop()
    loop.cancel()


# ── the tools, the gates and the window ──


@pytest.fixture
async def feature(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    feature = automation.feature_of(hub)
    feature.timers.play = lambda _sound: None
    yield hub, feature, {t.name: t.handler for t in feature.tools()}
    feature.timers.close()


async def test_the_owners_words_set_it_unasked_anything_else_asks(feature):
    hub, feat, tools = feature
    cards = []
    hub.add_approval_sink(lambda a: (cards.append(a), hub.resolve(a["id"], "deny")))
    hub._turn_text = "set a timer for 12 minutes"
    out = await tools["set_timer"]({"seconds": 720, "label": ""})
    assert not out.get("is_error") and cards == []
    hub._turn_text = "帮我设一个十分钟的意面计时器"
    out = await tools["set_timer"]({"seconds": 600, "label": "意面"})
    assert not out.get("is_error") and cards == []
    hub._turn_text = ""  # a routine, or an email's words: a card, and no means no
    out = await tools["set_alarm"]({"time": "03:00", "label": "wake up"})
    assert out.get("is_error") and cards[0]["question"].startswith("Set an alarm for 3 AM")
    assert [t.seconds for t in feat.timers.store.items] == [720, 600]


async def test_list_cancel_and_ambiguity(feature):
    hub, feat, tools = feature
    hub._turn_text = "set a timer"
    await tools["set_timer"]({"seconds": 600, "label": "pasta"})
    await tools["set_timer"]({"seconds": 300, "label": "pasta sauce"})
    await tools["set_reminder"]({"text": "stretch", "every_minutes": 20})
    listed = (await tools["list_timers"]({}))["content"][0]["text"]
    assert "Pasta timer:" in listed and "Reminder: stretch, every 20 minutes" in listed
    hub._turn_text = "cancel the pas timer"
    out = await tools["cancel_timer"]({"which": "pas"})
    assert out.get("is_error") and "Several match" in out["content"][0]["text"]
    pasta = next(t for t in feat.timers.store.items if t.label == "pasta")
    out = await tools["cancel_timer"]({"which": pasta.id})
    assert out["content"][0]["text"] == "Cancelled: pasta."
    out = await tools["cancel_timer"]({"which": "soup"})
    assert out.get("is_error") and out["content"][0]["text"] == "Nothing like that is set."
    hub._turn_text = "取消所有提醒"
    out = await tools["cancel_timer"]({"which": "reminders"})
    assert not out.get("is_error")
    assert [t.label for t in feat.timers.store.items] == ["pasta sauce"]


async def test_snooze_and_stop_by_voice(feature):
    hub, feat, tools = feature
    clock = Clock()
    feat.timers.now = clock
    feat.timers.add(tk.new_alarm("15:31", "wake up", NOW))
    clock.tick(minutes=1)
    feat.timers.fire_due(clock())
    hub._turn_text = "snooze"
    out = await tools["snooze_timer"]({})
    assert out["content"][0]["text"] == "Snoozed: wake up, until 3:40 PM."
    assert (await tools["stop_timer"]({}))["content"][0]["text"] == "Nothing is ringing."
    clock.tick(minutes=9)
    feat.timers.fire_due(clock())
    hub._turn_text = "stop the alarm"
    assert (await tools["stop_timer"]({"which": "alarm"}))["content"][0]["text"] == (
        "Stopped: wake up."
    )


async def test_settings_and_the_ringing_card_stop_snooze_and_cancel(feature):
    hub, feat, _tools = feature
    q = hub.subscribe()
    clock = Clock()
    feat.timers.now = clock
    alarm = feat.timers.add(tk.new_alarm("15:31", "", NOW))
    later = feat.timers.add(tk.new_timer(3600, "roast", NOW))
    clock.tick(minutes=1)
    feat.timers.fire_due(clock())
    await hub._handle({"type": "automation_timer", "action": "snooze", "id": alarm.id})
    assert alarm in feat.timers.store.items and feat.timers.ringing == {}
    await hub._handle({"type": "automation_timer", "action": "cancel", "id": later.id})
    await hub._handle({"type": "automation_state"})
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    state = [e for e in events if e["type"] == "automation" and "routines" in e][-1]
    assert [t["id"] for t in state["timers"]["items"]] == [alarm.id]
    assert state["timers"]["items"][0]["left"] == 9 * 60


async def test_a_timer_shows_even_with_heads_ups_off(feature):
    hub, feat, _tools = feature
    hub.prefs.proactive = False
    q = hub.subscribe()
    clock = Clock()
    feat.timers.now = clock
    feat.timers.add(tk.new_timer(60, "tea", NOW))
    clock.tick(minutes=1)
    feat.timers.fire_due(clock())
    alerts = []
    while not q.empty():
        event = q.get_nowait()
        if event["type"] == "alert":
            alerts.append(event)
    assert [(a["alert_kind"], a["text"]) for a in alerts] == [("timer", "Your tea timer is done.")]


def test_the_timer_patterns_read_the_owners_words():
    from jarvis.hub import FEATURE_ASKED, user_asked

    yes = {
        "timer_set": [
            "set a timer for 12 minutes",
            "start a pasta timer",
            "wake me up at 6:30",
            "remind me every 20 minutes to stretch",
            "can you set an alarm for 7",
            "设一个十分钟的计时器",
            "好的，帮我定个闹钟",
            "十分钟后提醒我关火",
            "明天早上叫醒我",
        ],
        "timer_change": [
            "cancel the pasta timer",
            "snooze",
            "turn off the alarm",
            "stop all the reminders",
            "取消意面计时器",
            "把闹钟关掉",
            "贪睡",
        ],
    }
    no = {
        "timer_set": ["what timers do I have", "the timer is annoying", "取消订单"],
        "timer_change": ["how long is left on the timer", "取消订单", "set a timer"],
    }
    for action, said in yes.items():
        for text in said:
            assert user_asked(FEATURE_ASKED[action], text), (action, text)
    for action, said in no.items():
        for text in said:
            assert not user_asked(FEATURE_ASKED[action], text), (action, text)
