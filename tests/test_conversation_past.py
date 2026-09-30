"""Past conversations (jarvis.features.conversation, conversation_past): listed from Claude
Code's own records of the brain's sessions with titles and dates, searched (titles, and the
second brain's passages), read back as the two sides' words, and carried on as the current
conversation after a card. Claude Code's records are fakes: never the owner's ~/.claude."""

from types import SimpleNamespace

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import FakeClient
from conversation_support import answer_card, settle

from jarvis import conversation_past as past
from jarvis.conversation_state import UNKNOWN_READS
from jarvis.hub import Hub

NOW = "0f3c2d1e-aaaa-bbbb-cccc-000000000001"
OLD = "0f3c2d1e-aaaa-bbbb-cccc-000000000002"
MEETING = "0f3c2d1e-aaaa-bbbb-cccc-000000000003"
LEASE = "0f3c2d1e-aaaa-bbbb-cccc-000000000004"
MS = 1_790_000_000_000  # a time in milliseconds, as Claude Code's listing gives it


class Transcriber:
    def warm_up(self):
        pass


def info(sid, first, at=MS, title=None):
    return SimpleNamespace(session_id=sid, first_prompt=first, last_modified=at, custom_title=title)


LISTED = [
    info(NOW, "[Note from the app: live data: It's 9:00 AM.]  What's on today?", MS),
    info(MEETING, "Below is a machine transcript of a meeting. Write it up.", MS - 1000),
    info(OLD, "Plan the trip to Lisbon", MS - 86_400_000 * 3),
    info(
        LEASE,
        "[Note from the app: live data: It's 8:00 AM, which is a very long note that got cut",
        MS - 86_400_000 * 9,
    ),
]


def said(role, text):
    return SimpleNamespace(type=role, uuid="", message={"content": text})


RECORDS = {
    OLD: [
        said("user", "[Note from the app: live data: It's noon.]\n\nPlan the trip to Lisbon"),
        said("assistant", "Three days: Alfama, Belém, and a day in Sintra."),
        said("user", "<task-notification>done</task-notification>"),
        said("assistant", [{"type": "text", "text": "Booked nothing yet."}, {"type": "tool_use"}]),
    ]
}


def reply(sid):
    return [
        AssistantMessage(content=[TextBlock(text="Sure.")], model="m"),
        ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id=sid,
            total_cost_usd=0.01,
            result="Sure.",
        ),
    ]


def make_hub(settings, speaker, isolated, client=None):
    class Client(FakeClient):
        script = reply(NOW)

    hub = Hub(
        settings,
        client_factory=client or Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.events = events
    convo = hub.conversation
    convo.list_sessions = lambda directory=None, limit=None, include_worktrees=True: list(LISTED)
    by_id = {i.session_id: i for i in LISTED}
    convo.get_info = lambda sid, directory=None: by_id.get(sid)

    def messages(sid, directory=None):
        if sid not in RECORDS:
            raise OSError("no record")
        return list(RECORDS[sid])

    convo.get_messages = messages
    return hub


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


def test_the_owners_words_come_without_the_apps_note():
    assert past.owner_words("[Note from the app: live data: 9 AM.]  What's on?") == "What's on?"
    assert past.owner_words("[Note from the app: cut short, the words never came") == ""
    assert past.owner_words("  Plan   the trip ") == "Plan the trip"
    assert past.one_off("The conversation so far, oldest first. Ann: hi")
    assert not past.one_off("What's on today?")


def test_a_search_finds_every_word_in_a_title_or_preview_or_what_the_brain_found():
    items = [
        {"session_id": "a", "title": "Plan the trip to Lisbon", "preview": ""},
        {"session_id": "b", "title": "Taxes", "preview": "When are my taxes due"},
        {"session_id": "c", "title": "Groceries", "preview": ""},
    ]
    assert [i["session_id"] for i in past.matching(items, "lisbon TRIP")] == ["a"]
    assert [i["session_id"] for i in past.matching(items, "taxes due")] == ["b"]
    assert [i["session_id"] for i in past.matching(items, "milk", {"c"})] == ["c"]
    assert past.matching(items, "  ") == items


async def test_the_list_has_titles_dates_and_the_current_one_marked(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("What's on today?")  # the current conversation, now titled
    await settle(hub)
    await hub._handle({"type": "conversation_list", "q": "", "seq": "1"})
    await settle(hub)
    (listed,) = emitted(hub, "conversation_list")
    assert listed["seq"] == "1" and listed["q"] == ""
    rows = {i["session_id"]: i for i in listed["items"]}
    assert MEETING not in rows  # a meeting's write-up isn't a conversation with the owner
    assert rows[NOW]["title"] == "What's on today?" and rows[NOW]["current"] is True
    assert rows[NOW]["cost"] == 0.01 and rows[NOW]["at"] == MS
    assert rows[OLD]["title"] == "Plan the trip to Lisbon" and rows[OLD]["current"] is False
    assert rows[LEASE]["title"] == ""  # its first words are cut off in Claude Code's listing


async def test_a_search_weighs_the_second_brains_passages_too(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    asked = []

    def search(query, k=6, *, sources=None, since="", until=""):
        asked.append((query, sources))
        return [{"id": f"conversation:{LEASE}:2"}, {"id": "notes:1"}]

    hub.kb.search = search
    await hub._handle({"type": "conversation_list", "q": "lisbon", "seq": "2"})
    await hub._handle({"type": "conversation_list", "q": "rent", "seq": "3"})
    await settle(hub)
    # The two searches run side by side: each answer carries its seq (the window keeps
    # the newest), and they may finish in either order.
    answers = {a["seq"]: a for a in emitted(hub, "conversation_list")}
    lisbon, rent = answers["2"], answers["3"]
    assert (lisbon["q"], rent["q"]) == ("lisbon", "rent")
    assert [i["session_id"] for i in lisbon["items"]] == [OLD, LEASE]
    assert [i["session_id"] for i in rent["items"]] == [LEASE]
    assert sorted(asked) == [("lisbon", ["conversations"]), ("rent", ["conversations"])]


async def test_a_past_conversation_reads_back_as_the_two_sides_words(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub._handle({"type": "conversation_open", "session_id": OLD})
    await hub._handle({"type": "conversation_open", "session_id": LEASE})  # unreadable
    await hub._handle({"type": "conversation_open", "session_id": "../../etc/passwd"})
    await settle(hub)
    # Read side by side, so in either order; the bad id is never read at all.
    read = {t["session_id"]: t for t in emitted(hub, "conversation_transcript")}
    assert set(read) == {OLD, LEASE}
    old, lease = read[OLD], read[LEASE]
    assert old["entries"] == [
        {"role": "user", "text": "Plan the trip to Lisbon"},
        {"role": "assistant", "text": "Three days: Alfama, Belém, and a day in Sintra."},
        {"role": "assistant", "text": "Booked nothing yet."},
    ]
    assert old["error"] == "" and old["current"] is False
    assert lease["entries"] == [] and lease["error"] == "unreadable"


async def test_carrying_on_a_past_conversation_asks_then_reopens_it(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("What's on today?")
    await settle(hub)
    first = hub.client
    await hub._handle({"type": "conversation_resume", "session_id": OLD})
    card = await answer_card(hub, "allow")
    await settle(hub)
    assert card["question"].startswith("Carry on the conversation “Plan the trip to Lisbon” from ")
    assert "stays in Past conversations" in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Carry on", "Not now"]
    assert hub.client is not first and hub.client.options.resume == OLD
    assert hub._session_id == OLD
    # Its reads aren't on record: it counts as having read private data and pages.
    assert hub._session_reads == UNKNOWN_READS
    assert [(h["role"], h["text"]) for h in hub.history] == [
        ("user", "Plan the trip to Lisbon"),
        ("assistant", "Three days: Alfama, Belém, and a day in Sintra."),
        ("assistant", "Booked nothing yet."),
        ("note", "Carrying on “Plan the trip to Lisbon”."),
    ]
    assert emitted(hub, "history")[-1]["items"] == list(hub.history)
    assert emitted(hub, "conversation")[-1]["resumed"]["title"] == "Plan the trip to Lisbon"
    assert hub.conversation.state.current == OLD


async def test_a_no_on_the_card_changes_nothing(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    first = hub.client
    await hub._handle({"type": "conversation_resume", "session_id": OLD})
    await answer_card(hub, "deny")
    await settle(hub)
    assert hub.client is first and hub._session_id == ""


async def test_one_that_wont_carry_on_leaves_the_owner_where_they_were(
    settings, quiet_speaker, isolated
):
    class Refuses(FakeClient):
        script = reply(NOW)

        async def connect(self):
            if self.options.resume == OLD:
                raise RuntimeError("No conversation found")
            await super().connect()

    hub = make_hub(settings, quiet_speaker, isolated, client=Refuses)
    await hub.start()
    await hub.ask("What's on today?")
    await settle(hub)
    hub._note_read("private", "Read your inbox")
    reads = dict(hub._session_reads)
    await hub._handle({"type": "conversation_resume", "session_id": OLD})
    await answer_card(hub, "allow")
    await settle(hub)
    assert hub.client.options.resume == NOW and hub._session_id == NOW
    assert hub._session_reads["private"] is True and hub._session_reads == reads
    assert "couldn't be carried on" in emitted(hub, "toast")[-1]["text"]


async def test_the_one_youre_in_or_one_thats_gone_is_said_not_asked(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("What's on today?")
    await settle(hub)
    await hub._handle({"type": "conversation_resume", "session_id": NOW})
    await hub._handle(
        {"type": "conversation_resume", "session_id": "0f3c2d1e-dead-beef-cccc-000000000009"}
    )
    await settle(hub)
    assert not hub.approvals
    toasts = [t["text"] for t in emitted(hub, "toast")]
    assert toasts == [
        "That's the conversation you're in.",
        "That conversation isn't there any more.",
    ]
