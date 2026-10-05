"""JARVIS's conversation survives a restart (jarvis.features.conversation): each turn keeps
the session id, what the conversation has read and what it cost; the next start carries it
on with a note (a setting, on by default), or starts afresh when it can't; "New conversation"
still starts afresh. Claude Code's records are fakes: never the owner's ~/.claude."""

import json
from types import SimpleNamespace

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import FakeClient
from conversation_support import settle

from jarvis.conversation_state import UNKNOWN_READS, ConversationState
from jarvis.hub import Hub

SID = "0f3c2d1e-aaaa-bbbb-cccc-123456789abc"
OTHER = "9e8d7c6b-aaaa-bbbb-cccc-123456789abc"


def turn(session_id=SID, total=0.02, text="Two meetings tomorrow."):
    return [
        AssistantMessage(content=[TextBlock(text=text)], model="m"),
        ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id=session_id,
            total_cost_usd=total,
            result=text,
        ),
    ]


class Transcriber:
    def warm_up(self):
        pass


def said(role, text):
    return SimpleNamespace(type=role, uuid="", message={"content": text})


RECORD = [
    said("user", "[Note from the app: live data: It's 9:00 AM.]\n\nWhat's on today?"),
    said("assistant", "Two meetings: design at ten and lunch with Ann."),
    said("user", "Move lunch to one."),
    said("assistant", "Done, lunch is at one."),
]


def make_hub(settings, speaker, isolated, script=None, client=None, records=None, info=True):
    class Client(FakeClient):
        pass

    Client.script = script if script is not None else turn()
    hub = Hub(
        settings,
        client_factory=client or Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    convo = hub.conversation
    convo.get_info = lambda sid, directory=None: (
        SimpleNamespace(
            session_id=sid, first_prompt="What's on today?", last_modified=1_700_000_000_000
        )
        if info
        else None
    )
    convo.get_messages = lambda sid, directory=None: list(
        records if records is not None else RECORD
    )
    return hub


async def test_the_feature_installs_and_carrying_on_is_on_by_default(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert "conversation" in hub.features
    assert hub.first_connect == hub.conversation.first_connect
    assert hub.prefs.feature("conversation_resume") is True
    hub.emit = lambda kind, **data: hub.__dict__.setdefault("seen", []).append((kind, data))
    await hub._handle({"type": "conversation_state"})
    kind, data = hub.seen[-1]
    assert kind == "conversation" and data["resume"] is True and data["resumed"] is None


async def test_each_turn_keeps_the_session_its_reads_cost_and_title(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hub._note_read("private", "Read your inbox")  # an earlier turn read the inbox
    await hub.ask("What's on today?")
    await settle(hub)
    saved = json.loads((tmp_path / "conversation.json").read_text())
    assert saved["current"] == SID
    entry = saved["sessions"][SID]
    assert entry["reads"]["private"] is True and "Read your inbox" in entry["reads"]["what"]
    assert entry["cost"] == 0.02 and entry["title"] == "What's on today?"
    # The next turn on the same connection adds only its own cost (a running total).
    type(hub.client).script = turn(total=0.05)
    await hub.ask("And tomorrow?")
    await settle(hub)
    entry = json.loads((tmp_path / "conversation.json").read_text())["sessions"][SID]
    assert entry["cost"] == 0.05 and entry["title"] == "What's on today?"


async def test_a_restart_carries_the_conversation_on_with_its_reads_and_a_note(
    settings, quiet_speaker, isolated
):
    first = make_hub(settings, quiet_speaker, isolated)
    await first.start()
    first._note_read("private", "Read your inbox")
    await first.ask("What's on today?")
    await settle(first)
    await first.close()

    again = make_hub(settings, quiet_speaker, isolated)
    await again.start()
    assert again.client.options.resume == SID
    assert again._session_id == SID
    # What it read before the restart is still in its context: the gates count it.
    assert again._session_reads["private"] is True
    assert "Read your inbox" in again._session_reads["what"]
    lines = [(h["role"], h["text"]) for h in again.history]
    assert lines[:4] == [
        ("user", "What's on today?"),  # without the app's note
        ("assistant", "Two meetings: design at ten and lunch with Ann."),
        ("user", "Move lunch to one."),
        ("assistant", "Done, lunch is at one."),
    ]
    assert lines[-1] == ("note", "Carrying on from earlier.")
    assert again.conversation.public()["resumed"]["title"] == "What's on today?"
    assert "the app restarted since this conversation" in again._style_note  # time has passed
    # The first new request puts the note away.
    await again.ask("Thanks")
    assert again.conversation.public()["resumed"] is None


async def test_in_chinese_the_note_is_chinese(settings, quiet_speaker, isolated):
    isolated["prefs_store"].prefs.language = "zh"
    store = ConversationState(isolated["prefs_store"].path.with_name("conversation.json"))
    store.turn_over(SID, {"private": False, "web": False, "what": []}, 0.0, "hi")
    store.save()
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    assert hub.history[-1]["text"] == "接着之前的对话继续。"


async def test_with_the_setting_off_a_new_conversation_starts(settings, quiet_speaker, isolated):
    store = ConversationState(isolated["prefs_store"].path.with_name("conversation.json"))
    store.turn_over(SID, {"private": False, "web": False, "what": []}, 0.0, "hi")
    store.save()
    isolated["prefs_store"].prefs.features = {"conversation_resume": False}
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    assert hub.client.options.resume is None
    assert not [h for h in hub.history if h["role"] == "note"]


async def test_a_record_that_is_gone_starts_a_new_conversation(settings, quiet_speaker, isolated):
    path = isolated["prefs_store"].path.with_name("conversation.json")
    store = ConversationState(path)
    store.turn_over(SID, {"private": False, "web": False, "what": []}, 0.0, "hi")
    store.save()
    hub = make_hub(settings, quiet_speaker, isolated, info=False)
    await hub.start()
    await settle(hub)
    assert hub.client.options.resume is None
    assert ConversationState(path).current == ""


async def test_a_resume_that_fails_starts_a_new_conversation(settings, quiet_speaker, isolated):
    store = ConversationState(isolated["prefs_store"].path.with_name("conversation.json"))
    store.turn_over(SID, {"private": False, "web": False, "what": []}, 0.0, "hi")
    store.save()
    made = []

    class Refuses(FakeClient):
        script = turn()

        async def connect(self):
            made.append(self.options.resume)
            if self.options.resume:
                raise RuntimeError("No conversation found with session ID")
            await super().connect()

    hub = make_hub(settings, quiet_speaker, isolated, client=Refuses)
    await hub.start()
    assert made == [SID, None]
    assert hub.client.connected and hub._session_id == ""
    assert hub.conversation.public()["resumed"] is None


async def test_new_conversation_starts_afresh_and_is_what_a_restart_finds(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("What's on today?")
    await settle(hub)
    await hub.reset()
    await settle(hub)
    assert hub.client.options.resume is None
    assert hub.conversation.state.current == ""
    again = make_hub(settings, quiet_speaker, isolated)
    await again.start()
    assert again.client.options.resume is None


async def test_a_conversation_with_no_record_of_its_reads_counts_as_having_read_private_data(
    tmp_path,
):
    store = ConversationState(tmp_path / "conversation.json")
    assert store.reads_of(OTHER) == UNKNOWN_READS
    store.turn_over(SID, {"private": False, "web": True, "what": ["Read a web page"]}, 0.0)
    assert store.reads_of(SID) == {"private": False, "web": True, "what": ["Read a web page"]}


def test_a_damaged_or_odd_record_never_stops_the_start(tmp_path):
    path = tmp_path / "conversation.json"
    path.write_text(
        '{"current": "../../etc", "sessions": {"ok-1": {"reads": {"private": "yes", "what": [1, "x"]}, "cost": "NaN", "title": 5}, "bad id!": {}}}'
    )
    store = ConversationState(path)
    assert store.current == ""
    assert store.sessions == {
        "ok-1": {
            "reads": {"private": False, "web": False, "what": ["x"]},
            "cost": 0.0,
            "at": "",
            "title": "",
        }
    }
    path.write_text("{torn")
    assert ConversationState(path).sessions == {}  # kept aside; the last good copy or nothing


def test_only_the_newest_conversations_are_kept(tmp_path):
    store = ConversationState(tmp_path / "conversation.json")
    for n in range(305):
        store.sessions[f"s-{n}"] = {
            "reads": None,
            "cost": 0.0,
            "at": f"2026-01-01T00:{n // 60:02d}:{n % 60:02d}",
            "title": "",
        }
    store.turn_over("s-0", {"private": False, "web": False, "what": []}, 0.0)
    assert len(store.sessions) == 300 and "s-0" in store.sessions and "s-1" not in store.sessions


async def test_a_startup_notice_stays_after_the_carried_on_lines(settings, quiet_speaker, isolated):
    store = ConversationState(isolated["prefs_store"].path.with_name("conversation.json"))
    store.turn_over(SID, {"private": False, "web": False, "what": []}, 0.0, "hi")
    store.save()
    isolated["prefs_store"].notice = "Your settings file was damaged."
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    assert [h["role"] for h in hub.history][-2:] == ["note", "assistant"]
    assert hub.history[-1]["text"] == "Your settings file was damaged."


def test_a_save_that_finishes_late_never_puts_back_an_older_record(tmp_path):
    """A turn's save and a rename's run in threads and can finish in either order: the
    file keeps the newer, never the record from before the rename. Each is the record as
    it was saved before (a dict, its keys in their order)."""
    path = tmp_path / "conversation.json"
    store = ConversationState(path)
    store.turn_over(SID, {"private": False, "web": False, "what": []}, 0.25, "hi")
    older = store.snapshot()  # the turn's save, slow to get going
    store.sessions[SID]["title"] = "Trip to Lisbon"  # a rename meanwhile
    newer = store.snapshot()
    assert older == {"current": SID, "branch": None, "sessions": older["sessions"]}
    store.save(newer)
    store.save(older)  # finishes last
    on_disk = json.loads(path.read_text())
    assert list(on_disk) == ["current", "branch", "sessions"]
    assert on_disk["sessions"][SID]["title"] == "Trip to Lisbon"
    assert ConversationState(path).titles() == {SID: "Trip to Lisbon"}
    store.sessions[SID]["title"] = "Lisbon"
    store.save()  # a fresh one is always newer
    assert ConversationState(path).titles() == {SID: "Lisbon"}
    store.save({"current": "", "branch": None, "sessions": {}})  # given as it is: written
    assert ConversationState(path).current == ""
