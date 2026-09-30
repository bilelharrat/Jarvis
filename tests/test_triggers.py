"""Routines on events (jarvis.triggers): the calendar, email and texts (the interrupter's
own reading), the battery, places (the phone's arrive and leave, else the Mac's location),
waking and unlocking, Jarvis Code finishing; each within its debounce and daily cap, and
waiting for meeting notes to end. Fake clocks and fakes only."""

import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from jarvis import triggers
from jarvis.jobs import Cause
from jarvis.routines import Routine, RoutineStore, build_tools

NOW = datetime(2026, 9, 29, 9, 0)


def routine(trigger, rid="r", **spec):
    return Routine(
        rid, f"On {trigger['type']}", "Do it", "event", "00:00",
        spec=triggers.clean_spec({"trigger": trigger, **spec}),
    )  # fmt: skip


class Rig:
    """An engine with fakes: what fired, a clock, the calendar, the battery, the lock."""

    def __init__(self, tmp_path, *items, **kw):
        self.items = list(items)
        self.fired: list[tuple[str, Cause]] = []
        self.at = NOW
        self.calendar: list[dict] = []
        self.power = {"percent": 80, "plugged": True}
        self.lock = False
        self.meeting = False
        self.wall, self.mono = 1000.0, 500.0
        self.hooks: list[tuple[str, dict]] = []

        async def events():
            return self.calendar

        self.engine = triggers.TriggerEngine(
            lambda: self.items,
            lambda r, cause: self.fired.append((r.id, cause)),
            tmp_path / "triggers.json",
            now=lambda: self.at,
            events=events,
            battery=lambda: self.power,
            locked=lambda: self.lock,
            busy=lambda: self.meeting,
            wall=lambda: self.wall,
            mono=lambda: self.mono,
            on_event=lambda name, data: self.hooks.append((name, data)),
            **kw,
        )

    async def tick(self, **delta):
        self.at += timedelta(**delta)
        self.mono += timedelta(**delta).total_seconds()
        self.wall += timedelta(**delta).total_seconds()
        await self.engine.tick(self.at)

    def labels(self):
        return [c.label for _id, c in self.fired]


# ── what a trigger is, in words ──


@pytest.mark.parametrize(
    ("trigger", "en", "zh"),
    [
        ({"type": "calendar", "edge": "start", "minutes": -10, "title": "Standup"},
         "10 minutes before “Standup” starts", "“Standup”开始前10分钟"),
        ({"type": "calendar", "edge": "end", "minutes": 5}, "5 minutes after an event ends", "日程结束后5分钟"),
        ({"type": "calendar"}, "when an event starts", "日程开始时"),
        ({"type": "mail", "from": "Ann"}, "when an email from Ann arrives", "收到Ann的邮件时"),
        ({"type": "mail", "subject": "invoice"}, "when an email about “invoice” arrives", "收到主题含“invoice”的邮件时"),
        ({"type": "text", "from": "Mom"}, "when a text from Mom arrives", "收到Mom的短信时"),
        ({"type": "battery", "state": "low", "below": 15}, "when the battery drops below 15%", "电量低于百分之15时"),
        ({"type": "battery", "state": "charging"}, "when the Mac is plugged in", "Mac 接上电源时"),
        ({"type": "place", "event": "arrive", "place": "home"}, "when you get home", "到家时"),
        ({"type": "place", "event": "leave", "place": "work"}, "when you leave work", "离开公司时"),
        ({"type": "place", "event": "arrive", "place": "Gym", "lat": 37.8, "lon": -122.3},
         "when you arrive at Gym", "到Gym时"),
        ({"type": "wake", "what": "unlock"}, "when the Mac is unlocked", "Mac 解锁时"),
        ({"type": "session", "folder": "jarvis", "status": "failed"},
         "when a Jarvis Code session in jarvis fails", "jarvis里的Jarvis Code 会话失败时"),
    ],
)  # fmt: skip
def test_triggers_in_words(trigger, en, zh):
    spec = triggers.clean_spec({"trigger": trigger})
    assert triggers.describe(spec) == en
    assert triggers.describe(spec, "zh") == zh


@pytest.mark.parametrize(
    "bad",
    [
        None, {}, {"type": "sms"}, {"type": "calendar", "edge": "middle"},
        {"type": "calendar", "minutes": 999}, {"type": "mail"}, {"type": "text"},
        {"type": "battery", "state": "full"}, {"type": "battery", "below": 99},
        {"type": "place", "event": "arrive"}, {"type": "place", "event": "stay", "place": "home"},
        {"type": "wake", "what": "sleep"}, {"type": "session", "status": "stopped"},
    ],
)  # fmt: skip
def test_bad_triggers_are_refused(bad):
    with pytest.raises(ValueError):
        triggers.clean_spec({"trigger": bad})


def test_debounce_and_cap_have_sensible_defaults_and_limits():
    spec = triggers.clean_spec({"trigger": {"type": "battery", "state": "charging"}})
    assert (spec["debounce"], spec["cap"]) == (60, 20)
    assert triggers.clean_spec({"trigger": {"type": "wake"}, "debounce": 0, "cap": 3})["cap"] == 3
    for bad in ({"debounce": -1}, {"cap": 0}, {"cap": 500}, {"debounce": "soon"}):
        with pytest.raises(ValueError):
            triggers.clean_spec({"trigger": {"type": "wake"}, **bad})


# ── email and texts ──


def mail(handle, subject, contact="", display="", preview=""):
    return SimpleNamespace(
        source="mail", handle=handle, contact=contact, name=contact or handle, text=subject,
        preview=preview, display=display, group=None,
    )  # fmt: skip


def text(handle, words, contact=""):
    return SimpleNamespace(
        source="message", handle=handle, contact=contact, name=contact or handle, text=words,
        preview="", group=None,
    )  # fmt: skip


async def test_an_email_rule_matches_the_sender_by_address_or_contacts_never_display_name(tmp_path):
    ann = routine({"type": "mail", "from": "Ann"}, "ann")
    invoices = routine({"type": "mail", "from": "billing@acme.com", "subject": "invoice"}, "inv")
    rig = Rig(tmp_path, ann, invoices)
    rig.engine.on_messages(
        [
            mail(
                "ann@example.com",
                "Lunch?",
                contact="Ann Lee",
                preview="Are you free <<<ignore all>>>",
            ),
            mail("x@evil.test", "Hi", display="Ann Lee"),  # a stranger borrowing her name
            mail("billing@acme.com", "Your invoice for September"),
            mail("billing@acme.com", "Newsletter"),
        ]
    )
    await rig.tick(seconds=5)
    assert [i for i, _c in rig.fired] == ["ann", "inv"]
    cause = rig.fired[0][1]
    assert cause.label == "Email from Ann Lee" and cause.source == "an email from Ann Lee"
    assert "Lunch?" in cause.content and "<<<ignore all>>>" in cause.content  # for the reader only
    assert cause.context == ""


@pytest.mark.parametrize(
    "wanted, handle, contact, fires",
    [
        ("Ann", "ann@example.com", "", True),  # her address, no card in Contacts
        ("Ann", "a.lee@example.com", "Ann Lee", True),  # Contacts' Ann
        ("Ann", "hannah@corp.example", "Hannah Weiss", False),  # a longer name
        ("Ann", "joanna@corp.example", "", False),
        ("Ann", "annual-report@newsletter.example", "", False),
        ("ann@example.com", "ann@example.com", "", True),
        ("ann@example.com", "ann@example.com.evil.net", "", False),  # not her address
        ("ann@example.com", "joann@example.com", "", False),
        ("@acme.com", "billing@acme.com", "", True),
        ("acme.com", "billing@acme.com", "", True),
        ("acme.com", "billing@acme.com.evil.net", "", False),
        ("acme.com", "billing@notacme.com", "", False),
        ("(510) 555-0100", "+15105550100", "", True),
        ("Mom", "+15105550199", "Mom", True),
        ("Mom", "+15105550199", "Mommy's friend", False),
    ],
)
def test_a_senders_word_matches_whole_names_and_whole_addresses(wanted, handle, contact, fires):
    """An email rule's or a text rule's sender: a name as whole words of Contacts' name or
    of the address before its @, an address whole, a domain as the address's own; never a
    longer name that holds it, or an address that only starts with one."""
    assert triggers.sender_matches(wanted, handle, contact) is fires


async def test_a_text_from_a_contact_by_name_or_number(tmp_path):
    mom = routine({"type": "text", "from": "Mom"}, "mom")
    bob = routine({"type": "text", "from": "(510) 555-0100"}, "bob")
    rig = Rig(tmp_path, mom, bob)
    rig.engine.on_messages(
        [text("+15105550199", "Call me", contact="Mom"), text("+15105550100", "yo")]
    )
    await rig.tick(seconds=5)
    assert rig.labels() == ["Text from Mom", "Text from +15105550100"]
    assert rig.fired[0][1].content == "Call me"


async def test_debounce_and_the_daily_cap(tmp_path):
    ann = routine({"type": "mail", "from": "ann"}, "ann", debounce=5, cap=2)
    rig = Rig(tmp_path, ann)
    for minutes in (0, 1, 6, 12):
        rig.at = NOW + timedelta(minutes=minutes)
        rig.engine.on_messages([mail("ann@example.com", f"#{minutes}")])
        await rig.engine.tick(rig.at)
    # 9:00 fired, 9:01 within the debounce, 9:06 fired, 9:12 over the day's cap of two.
    assert [c.content.split("Subject: ")[1][:2] for _i, c in rig.fired] == ["#0", "#6"]
    rig.at = datetime(2026, 9, 30, 9, 0)
    rig.engine.on_messages([mail("ann@example.com", "tomorrow")])
    await rig.tick()
    assert len(rig.fired) == 3  # a new day, a new cap
    saved = json.loads((tmp_path / "triggers.json").read_text())
    assert saved["counts"]["ann"] == ["2026-09-30", 1]


async def test_a_paused_routine_never_fires_and_meeting_notes_hold_it(tmp_path):
    ann = routine({"type": "mail", "from": "ann"}, "ann", debounce=0)
    rig = Rig(tmp_path, ann)
    ann.enabled = False
    rig.engine.on_messages([mail("ann@example.com", "a")])
    await rig.tick(seconds=5)
    assert rig.fired == []
    ann.enabled = True
    rig.meeting = True
    rig.engine.on_messages([mail("ann@example.com", "b")])
    await rig.tick(seconds=5)
    assert rig.fired == [] and len(rig.engine.deferred) == 1
    rig.meeting = False
    await rig.tick(seconds=5)
    assert rig.labels() == ["Email from ann@example.com"]


# ── the calendar ──


async def test_minutes_before_an_event_starts_once(tmp_path):
    prep = routine(
        {"type": "calendar", "edge": "start", "minutes": -10, "title": "standup"}, "prep"
    )
    after = routine({"type": "calendar", "edge": "end", "minutes": 5}, "after")
    rig = Rig(tmp_path, prep, after)
    rig.calendar = [
        {"id": "e1", "title": "Daily Standup", "begin": NOW + timedelta(minutes=15),
         "end": NOW + timedelta(minutes=30), "all_day": False},
        {"id": "e2", "title": "Holiday", "begin": NOW, "end": NOW + timedelta(days=1), "all_day": True},
    ]  # fmt: skip
    await rig.tick()
    assert rig.fired == []
    await rig.tick(minutes=5)  # 9:05: ten minutes before 9:15
    assert rig.labels() == ["“Daily Standup” starts"]
    assert rig.fired[0][1].context == "“Daily Standup” starts at 9:15 AM"
    await rig.tick(minutes=1)
    assert len(rig.fired) == 1  # once per event
    await rig.tick(minutes=29)  # 9:35: five minutes after it ends
    assert rig.labels()[-1] == "“Daily Standup” ends"


async def test_a_calendar_trigger_missed_by_long_is_skipped_and_restarts_dont_repeat(tmp_path):
    prep = routine({"type": "calendar", "edge": "start", "minutes": -10}, "prep")
    rig = Rig(tmp_path, prep)
    rig.calendar = [
        {
            "id": "e1",
            "title": "Board",
            "begin": NOW - timedelta(minutes=5),
            "end": NOW + timedelta(hours=1),
        }
    ]
    await rig.tick()
    assert rig.fired == []  # fifteen minutes late: skipped
    rig.calendar = [
        {
            "id": "e2",
            "title": "Call",
            "begin": NOW + timedelta(minutes=10),
            "end": NOW + timedelta(hours=1),
        }
    ]
    rig.engine._events_at = None
    await rig.tick()
    assert rig.labels() == ["“Call” starts"]
    again = Rig(tmp_path, prep)  # a restart: the file remembers it fired
    again.calendar = rig.calendar
    await again.tick()
    assert again.fired == []


# ── the Mac: battery, waking, unlocking ──


async def test_battery_low_charging_and_unplugged_fire_on_the_change(tmp_path):
    low = routine({"type": "battery", "state": "low", "below": 20}, "low", debounce=0)
    plug = routine({"type": "battery", "state": "charging"}, "plug", debounce=0)
    unplug = routine({"type": "battery", "state": "unplugged"}, "unplug", debounce=0)
    rig = Rig(tmp_path, low, plug, unplug)
    await rig.tick()  # the first reading only says where things stand
    rig.power = {"percent": 80, "plugged": False}
    await rig.tick(seconds=31)
    rig.power = {"percent": 19, "plugged": False}
    await rig.tick(seconds=31)
    rig.power = {"percent": 18, "plugged": False}
    await rig.tick(seconds=31)  # still low: no second heads-up
    rig.power = {"percent": 18, "plugged": True}
    await rig.tick(seconds=31)
    assert rig.labels() == [
        "The Mac was unplugged",
        "The battery is at 19%",
        "The Mac was plugged in",
    ]


async def test_waking_is_the_wall_clock_running_ahead_and_unlocking_the_lock_state(tmp_path):
    woke = routine({"type": "wake", "what": "wake"}, "woke")
    unlocked = routine({"type": "wake", "what": "unlock"}, "unlocked")
    rig = Rig(tmp_path, woke, unlocked)
    await rig.tick(seconds=5)
    rig.lock = True
    await rig.tick(seconds=5)
    rig.wall += 3600  # asleep for an hour: the wall clock moved, the monotonic one didn't
    rig.lock = False
    await rig.tick(seconds=5)
    assert sorted(rig.labels()) == ["The Mac was unlocked", "The Mac woke up"]
    assert [name for name, _d in rig.hooks] == ["wake", "unlock"]


# ── places ──

HOME = {
    "type": "place",
    "event": "arrive",
    "place": "home",
    "lat": 37.8716,
    "lon": -122.2727,
    "radius": 300,
}


async def test_the_phone_says_it_arrived_home(tmp_path):
    home = routine(HOME, "home")
    left = routine({"type": "place", "event": "leave", "place": "work"}, "left")
    rig = Rig(tmp_path, home, left)
    rig.engine.on_phone_location(
        {"event": "arrive", "region": "Home", "lat": 37.8716, "lon": -122.2727}
    )
    rig.engine.on_phone_location({"event": "leave", "region": "work"})
    rig.engine.on_phone_location({"lat": 37.0, "lon": -122.0})  # a plain fix: no event
    assert rig.labels() == ["Arrived at home", "Left work"]
    assert [n for n, _d in rig.hooks] == ["arrive", "leave"]


async def test_the_macs_own_location_when_the_phone_isnt_reporting(tmp_path):
    home = routine(HOME, "home")
    rig = Rig(tmp_path, home)
    away = {"lat": 37.80, "lon": -122.27}
    near = {"lat": 37.8726, "lon": -122.2727}  # about 110 m from home
    rig.engine.on_mac_location(away)  # where it is now: no event
    rig.engine.on_mac_location(near)
    assert rig.labels() == ["Arrived at home"]
    rig.engine.on_mac_location(away)
    rig.engine.on_mac_location(near)
    assert len(rig.fired) == 1  # within the debounce
    # Once the phone reports places, the Mac's coarse location isn't used.
    rig.engine.on_phone_location({"event": "leave", "region": "home"})
    rig.at += timedelta(hours=1)
    rig.engine.on_mac_location(away)
    rig.engine.on_mac_location(near)
    assert len(rig.fired) == 1


def test_distance():
    assert round(triggers.distance_m(37.8716, -122.2727, 37.8726, -122.2727)) == 111
    assert triggers.distance_m(0, 0, 0, 0) == 0


# ── Jarvis Code ──


def test_a_session_finishing_or_failing(tmp_path):
    done = routine({"type": "session", "folder": "jarvis", "status": "done"}, "done", debounce=0)
    either = routine({"type": "session"}, "either", debounce=0)
    rig = Rig(tmp_path, done, either)
    base = {"task_kind": "code", "id": 3, "folder": "jarvis", "result": "All 40 tests pass."}
    rig.engine.on_session({**base, "status": "done"})
    rig.engine.on_session({**base, "status": "stopped"})  # the owner stopped it: nothing
    rig.engine.on_session({**base, "status": "failed", "folder": "other"})
    rig.engine.on_session({**base, "task_kind": "research", "status": "done"})
    assert [i for i, _c in rig.fired] == ["done", "either", "either"]
    assert (
        rig.fired[0][1].context
        == "Jarvis Code session 3 in jarvis finished. Its last words: “All 40 tests pass.”"
    )


# ── made by voice ──


async def test_email_rules_and_places_by_voice(tmp_path):
    store = RoutineStore(tmp_path / "routines.json")
    store.here = lambda: {"lat": 37.87, "lon": -122.27, "neighborhood": "Downtown"}
    asked = []

    async def confirm(question):
        asked.append(question)
        return True

    tools = {t.name: t.handler for t in build_tools(store, confirm)}
    out = await tools["create_routine"](
        {
            "name": "Ann's emails",
            "prompt": "Tell me what she needs",
            "schedule": "event",
            "trigger": {"type": "mail", "from": "Ann"},
        }
    )
    assert not out.get("is_error"), out
    assert asked[0] == (
        "Add a routine, when an email from Ann arrives: Tell me what she needs? It runs on its "
        "own with Haiku, with no tools."
    )
    rule = store.items[0]
    assert (rule.kind, rule.own, rule.tools) == ("event", True, "none")  # the reader alone
    out = await tools["create_routine"](
        {
            "name": "Lights",
            "prompt": "Run my Arrive Home shortcut",
            "schedule": "event",
            "trigger": {"type": "place", "event": "arrive", "here": True},
        }
    )
    trigger = store.items[1].spec["trigger"]
    assert (trigger["lat"], trigger["lon"], trigger["place"]) == (37.87, -122.27, "Downtown")
    assert store.items[1].own is False  # in the conversation, as asked
    store.here = lambda: None
    out = await tools["create_routine"](
        {
            "name": "x",
            "prompt": "y",
            "schedule": "event",
            "trigger": {"type": "place", "here": True},
        }
    )
    assert out.get("is_error") and "where the Mac is" in out["content"][0]["text"]
    assert all(r.next_run(NOW) is None and r.latest(NOW) is None for r in store.items)


# ── on a real hub: the events it hears, and email rules from Settings ──


@pytest.fixture
def wired(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub
    from test_jobs import scripted

    from jarvis.features import automation

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    feature = automation.feature_of(hub)
    feature.runner.idle_wait = 0
    hub.client_factory = scripted(*["Done."] * 10)
    heard = []
    hub.add_notify_sink(heard.append)
    return hub, feature, heard


async def settle(feature, n=1):
    import asyncio

    for _ in range(50):
        if sum(len(v) for v in feature.history.data.values()) >= n and not feature.runner.running:
            return
        await asyncio.sleep(0.01)


async def test_the_hubs_events_start_routines(wired):
    hub, feature, heard = wired
    job = {"own": True, "tools": "none"}
    home = hub.routines.add(
        "Home",
        "Say welcome home",
        "event",
        "",
        spec={"trigger": {"type": "place", "event": "arrive", "place": "home"}},
        job=job,
    )
    done = hub.routines.add(
        "Tests",
        "Tell me the tests passed",
        "event",
        "",
        spec={"trigger": {"type": "session", "folder": "jarvis"}},
        job=job,
    )
    hub.emit("phone_location", lat=37.87, lon=-122.27, event="arrive", region="home", at="now")
    hub.emit(
        "task_finished", task_kind="code", id=4, status="done", folder="jarvis", result="40 passed"
    )
    await settle(feature, 2)
    assert feature.history.runs(home.id)[0]["cause"] == "Arrived at home"
    assert feature.history.runs(done.id)[0]["cause"] == "Jarvis Code finished in jarvis"
    assert [a.text for a in heard] == ["Done.", "Done."]


async def test_new_mail_from_the_interrupter_runs_an_email_rule(wired):
    hub, feature, heard = wired
    q = hub.subscribe()
    await hub._handle(
        {
            "type": "automation_email_rule",
            "from": "Ann",
            "subject": "",
            "then": "Tell me what she needs",
            "deliver": "card",
        }
    )
    await hub._handle({"type": "automation_email_rule", "from": "", "subject": ""})  # refused
    [rule] = hub.routines.items
    assert (rule.name, rule.kind, rule.own, rule.tools, rule.deliver) == (
        "Email from Ann",
        "event",
        True,
        "none",
        "card",
    )
    assert rule.spec["trigger"] == {"type": "mail", "from": "Ann", "subject": ""}
    errors = []
    while not q.empty():
        event = q.get_nowait()
        if event["type"] == "error":
            errors.append(event["text"])
    assert len(errors) == 1 and "can't be used" in errors[0]  # neither who nor what
    item = mail(
        "ann@example.com", "Q3 numbers", contact="Ann Lee", preview="Can you send them by Friday?"
    )
    hub.interrupts._observe([item])
    await feature.engine.tick()
    await settle(feature)
    [run] = feature.history.runs(rule.id)
    assert run["cause"] == "Email from Ann Lee" and run["output"] == "Done."
    reader = hub.client_factory.made[-1]
    assert reader.options.tools == [] and "Can you send them by Friday?" in reader.queries[0]
    assert heard == []  # a card on the Mac alone


async def test_the_interrupter_hands_over_every_new_email_robots_too(tmp_path):
    from test_interrupts import Env

    env = Env(tmp_path)
    watch = await env.started()
    seen = []
    watch.add_observer(lambda items: seen.extend((i.source, i.handle, i.text) for i in items))
    watch.add_observer(lambda _items: 1 / 0)  # a broken observer never stops the look
    env.mail.receive("notifications@github.com", "GitHub", "PR merged")  # a robot: never interrupts
    env.mail.receive("ann@zainar.com", "Ann Lee", "Lunch")
    env.chat.send("+15105550100", "Running late")
    await watch.poll()
    assert ("mail", "notifications@github.com", "PR merged") in seen
    assert ("mail", "ann@zainar.com", "Lunch") in seen
    assert ("message", "+15105550100", "Running late") in seen
    count = len(seen)
    await watch.poll()
    assert len(seen) == count  # each one once


async def test_a_script_hook_on_unlocking_has_the_lock_state_polled_too(tmp_path):
    rig = Rig(tmp_path, unlock_wanted=lambda: True)  # no routine waits on it: a script does
    await rig.tick(seconds=5)
    rig.lock = True
    await rig.tick(seconds=5)
    rig.lock = False
    await rig.tick(seconds=5)
    assert rig.fired == [] and [name for name, _d in rig.hooks] == ["unlock"]
