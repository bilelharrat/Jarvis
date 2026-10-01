"""Rewind and branches of JARVIS's own conversation (jarvis.features.conversation_branch): a
rewind carries the conversation on from before an earlier message as a new Claude Code
session (resume + fork_session + resume_session_at), after a card that says nothing in the
world is undone and offers undo for the dropped turns' undoable actions; a fork branches this
or a past conversation, the original kept, with the relation shown in Past conversations;
edit and resend; by voice; never from or into incognito. The SDK and Claude Code's records
are fakes: never the owner's ~/.claude."""

import asyncio
from types import SimpleNamespace

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import FakeClient
from conversation_support import answer_card, settle, until

from jarvis import conversation_past as past
from jarvis.conversation_state import UNKNOWN_READS, ConversationState
from jarvis.features import conversation_branch as branch
from jarvis.hub import Hub

SID = "0f3c2d1e-aaaa-bbbb-cccc-000000000011"
NEW = "0f3c2d1e-aaaa-bbbb-cccc-000000000012"
OLD = "0f3c2d1e-aaaa-bbbb-cccc-000000000013"
MS = 1_790_000_000_000


class Transcriber:
    def warm_up(self):
        pass


def said(role, text, uid):
    return SimpleNamespace(type=role, uuid=uid, message={"content": text})


RECORDS = {
    SID: [
        said("user", "[Note from the app: live data: It's 9:00 AM.]\n\nWhat's on today?", "u1"),
        said("assistant", "Two meetings: design at ten and lunch with Ann.", "a1"),
        said("user", "Move lunch to one.", "u2"),
        said("assistant", "Done, lunch is at one.", "a2"),
    ],
    OLD: [
        said("user", "Plan the trip to Lisbon", "o1"),
        said("assistant", "Three days: Alfama, Belém, and a day in Sintra.", "o2"),
        said("user", "Add a day in Porto", "o3"),
        said("assistant", "Four days, then.", "o4"),
    ],
}


def reply(sid, total=0.01, text="Sure."):
    return [
        AssistantMessage(content=[TextBlock(text=text)], model="m"),
        ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id=sid,
            total_cost_usd=total,
            result=text,
        ),
    ]


def make_hub(settings, speaker, isolated):
    class Client(FakeClient):
        script = reply(SID)

    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    convo = hub.conversation
    convo.get_messages = lambda sid, directory=None: list(RECORDS.get(sid, []))
    convo.get_info = lambda sid, directory=None: SimpleNamespace(
        session_id=sid, first_prompt="What's on today?", last_modified=MS
    )
    convo.list_sessions = lambda directory=None, limit=None, include_worktrees=False: [
        SimpleNamespace(session_id=s, first_prompt=t, last_modified=MS - i, custom_title=None)
        for i, (s, t) in enumerate(
            [(NEW, "What's on today?"), (SID, "What's on today?"), (OLD, "Plan the trip")]
        )
    ]
    hub.emit = lambda kind, **data: hub.__dict__.setdefault("seen", []).append((kind, data))
    return hub


def emitted(hub, kind):
    return [data for k, data in getattr(hub, "seen", []) if k == kind]


async def talked(hub):
    """Two requests in SID: 'What's on today?' then 'Move lunch to one.'."""
    await hub.start()
    await hub.ask("What's on today?")
    type(hub.client).script = reply(SID, total=0.04)
    await hub.ask("Move lunch to one.")
    await settle(hub)


def lines(hub):
    return [(h["role"], h["text"]) for h in hub.history]


def test_a_conversations_entries_carry_the_points_to_go_back_to():
    got = past.entries(SID, get_messages=lambda sid, directory=None: RECORDS[SID])
    assert got[0] == {"role": "user", "text": "What's on today?", "uuid": "u1", "before": ""}
    assert got[2] == {"role": "user", "text": "Move lunch to one.", "uuid": "u2", "before": "a1"}
    cut = past.entries(SID, get_messages=lambda sid, directory=None: RECORDS[SID], until="a1")
    assert [e["text"] for e in cut] == [
        "What's on today?",
        "Two meetings: design at ten and lunch with Ann.",
    ]
    gone = past.entries(SID, get_messages=lambda sid, directory=None: RECORDS[SID], until="zz")
    assert gone == []


async def test_a_rewind_asks_then_carries_on_from_before_that_message_as_a_new_session(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    first = hub.client
    await hub._handle({"type": "conversation_rewind", "session_id": SID, "uuid": "u2"})
    card = await answer_card(hub, "allow")
    await settle(hub)
    assert card["question"] == "Rewind to before “Move lunch to one.”?"
    assert "doesn't undo anything I did" in card["detail"]
    assert "what I remembered stays remembered" in card["detail"]
    assert "action log keeps everything" in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Rewind", "Not now"]
    options = hub.client.options
    assert hub.client is not first
    assert (options.resume, options.fork_session, options.resume_session_at) == (SID, True, "a1")
    assert lines(hub) == [
        ("user", "What's on today?"),
        ("assistant", "Two meetings: design at ten and lunch with Ann."),
        (
            "note",
            "Rewound to before “Move lunch to one.”. Nothing I did was undone and what I "
            "remembered stays; the earlier version is in Past conversations.",
        ),
    ]
    assert emitted(hub, "conversation")[-1]["branch"] == "rewind"
    # The branch speaks: it gets its own session, kept with where it came from.
    type(hub.client).script = reply(NEW, total=0.05)
    await hub.ask("Move lunch to two.")
    await settle(hub)
    state = hub.conversation.state
    assert state.branch is None and state.current == NEW
    assert state.relation_of(NEW) == (SID, "rewind")
    assert state.cost_of(NEW) == 0.01  # its own turn, not its source's total
    assert emitted(hub, "conversation")[-1]["branch"] == ""
    await hub._handle({"type": "conversation_list", "q": "", "seq": "1"})
    await settle(hub)
    items = {i["session_id"]: i for i in emitted(hub, "conversation_list")[-1]["items"]}
    assert items[NEW]["relation"] == "rewind" and items[NEW]["current"] is True
    assert items[NEW]["parent_title"] == "What's on today?"
    assert items[SID]["rewound"] is True and items[SID]["current"] is False


async def test_no_on_the_card_changes_nothing(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    first, before = hub.client, list(hub.history)
    await hub._handle({"type": "conversation_rewind", "session_id": SID, "uuid": "u2"})
    await answer_card(hub, "deny")
    await settle(hub)
    assert hub.client is first and list(hub.history) == before
    assert hub.conversation.state.branch is None


async def test_rewinding_before_the_first_message_starts_afresh(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    await hub._handle({"type": "conversation_rewind", "session_id": SID, "uuid": "u1"})
    await answer_card(hub, "allow")
    await settle(hub)
    assert hub.client.options.resume is None and hub._session_id == ""
    assert hub._session_reads == {"private": False, "web": False, "what": []}
    type(hub.client).script = reply(NEW)
    await hub.ask("What's on tomorrow?")
    await settle(hub)
    assert hub.conversation.state.relation_of(NEW) == (SID, "rewind")


async def test_the_card_offers_undo_for_what_the_dropped_turns_did(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("What's on today?")
    undo = hub.actions.undo
    undone = []

    async def inverse():
        undone.append("lunch")
        return "Undone."

    type(hub.client).script = reply(SID, total=0.04)
    await hub.ask("Move lunch to one.")
    await settle(hub)
    action = undo._new("edit_event", "Moved “Lunch” to 1 PM", "undo", inverse)
    action.turn = hub.commands  # done in the second request
    undo._keep(action)
    earlier = undo._new("create_event", "Added “Design” to your calendar", "undo", inverse)
    earlier.turn = hub.commands - 1  # done in the first, which the rewind keeps
    undo._keep(earlier)
    await hub._handle({"type": "conversation_rewind", "session_id": SID, "uuid": "u2"})
    card = await answer_card(hub, "undo")
    await settle(hub)
    assert "Moved “Lunch” to 1 PM" in card["detail"] and "Design" not in card["detail"]
    assert [c["id"] for c in card["choices"]] == ["allow", "undo", "deny"]
    assert undone == ["lunch"] and action.undone and not earlier.undone
    toast = emitted(hub, "toast")[-1]["text"]
    assert toast.endswith("Undid: Moved “Lunch” to 1 PM.")


async def test_edit_and_resend_rewinds_then_sends_the_edited_words(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    msg = {"type": "conversation_edit", "session_id": SID, "uuid": "u2", "text": "Move it to two."}
    await hub._handle(msg)
    card = await answer_card(hub, "allow")
    await until(lambda: hub.client.queries)
    await settle(hub)
    assert card["question"] == "Rewind to before “Move lunch to one.” and send your edited request?"
    assert [c["label"] for c in card["choices"]] == ["Rewind and send", "Not now"]
    assert hub.client.options.resume_session_at == "a1"
    assert hub.client.said == ["Move it to two."]


async def test_a_past_conversation_branches_with_the_original_kept(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    await hub._handle({"type": "conversation_fork", "session_id": OLD, "uuid": "o3"})
    await settle(hub)
    assert not hub.approvals  # nothing is lost: no card
    options = hub.client.options
    assert (options.resume, options.fork_session, options.resume_session_at) == (OLD, True, "o2")
    assert hub._session_id == OLD and hub._session_reads == UNKNOWN_READS
    assert lines(hub)[-1] == (
        "note",
        "Branched from “Plan the trip to Lisbon”; the original stays as it was in Past "
        "conversations.",
    )
    type(hub.client).script = reply(NEW)
    await hub.ask("Make it a week")
    await settle(hub)
    assert hub.conversation.state.relation_of(NEW) == (OLD, "fork")
    # All of the conversation under way: up to its last message.
    monkeypatch.setitem(
        RECORDS,
        NEW,
        [
            *RECORDS[OLD][:2],
            said("user", "Make it a week", "n1"),
            said("assistant", "Sure.", "n2"),
        ],
    )
    await hub._handle({"type": "conversation_fork", "session_id": NEW, "uuid": "", "live": True})
    await settle(hub)
    options = hub.client.options
    assert (options.resume, options.fork_session, options.resume_session_at) == (NEW, True, "n2")


async def test_a_branch_not_yet_spoken_in_carries_on_after_a_restart(
    settings, quiet_speaker, isolated
):
    first = make_hub(settings, quiet_speaker, isolated)
    await talked(first)
    await first._handle({"type": "conversation_rewind", "session_id": SID, "uuid": "u2"})
    await answer_card(first, "allow")
    await settle(first)
    saved = ConversationState(first.conversation.state.path)
    assert saved.branch == {"source": SID, "at": "a1", "relation": "rewind", "fresh": False}
    again = make_hub(settings, quiet_speaker, isolated)
    await again.start()
    await settle(again)
    options = again.client.options
    assert (options.resume, options.fork_session, options.resume_session_at) == (SID, True, "a1")
    assert ("user", "Move lunch to one.") not in lines(again)
    # The window's "This conversation" reads only as far as the branch goes.
    await again._handle({"type": "conversation_open", "session_id": SID, "live": True})
    await settle(again)
    shown = emitted(again, "conversation_transcript")[-1]
    assert shown["live"] is True and len(shown["entries"]) == 2


async def test_incognito_is_never_rewound_or_branched(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    await hub.conversation.set_incognito({"on": True})
    connected = hub.client
    await hub._handle({"type": "conversation_rewind", "session_id": SID, "uuid": "u2"})
    await hub._handle({"type": "conversation_fork", "session_id": OLD, "uuid": ""})
    await settle(hub)
    assert hub.client is connected and not hub.approvals
    toasts = [t["text"] for t in emitted(hub, "toast")]
    assert (
        "An incognito conversation keeps no record, so it can't be rewound or branched." in toasts
    )
    assert "Leave incognito to branch a past conversation." in toasts
    await hub.ask("Branch from here")
    assert hub.client is connected
    assert hub.turn["reply"] == (
        "An incognito conversation keeps no record, so it can't be rewound or branched."
    )


async def test_by_voice_go_back_to_before_a_request(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    asking = asyncio.create_task(hub.ask("Go back to before I asked about lunch"))
    card = await answer_card(hub, "allow")
    await asking
    await settle(hub)
    assert card["question"] == "Rewind to before “Move lunch to one.”?"
    assert hub.client.options.resume_session_at == "a1"
    assert hub.turn["reply"].startswith("Rewound to before “Move lunch to one.”.")
    assert emitted(hub, "history")[-1]["items"][-1]["role"] == "assistant"
    await hub.ask("Go back to before I asked about the weather in Oslo")
    assert hub.turn["reply"] == "I couldn't find where you asked about that in this conversation."


async def test_by_voice_branch_from_here_and_try_that_differently(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await talked(hub)
    await hub.ask("Branch from here")
    await settle(hub)
    assert not hub.approvals
    assert hub.client.options.resume_session_at == "a2"
    assert hub.turn["reply"].startswith("Branched from “What's on today?”")
    await hub.ask("Try that differently")
    await until(lambda: hub.client.queries)
    await settle(hub)
    assert hub.client.options.resume_session_at == "a1"  # before the last request
    assert hub.client.said == ["Move lunch to one."]
    assert branch.TRY_AGAIN_NOTE in hub.client.queries[0]


def test_the_spoken_forms_and_their_chinese():
    about = branch.REWIND.match("go back to before I asked you about the flights to Lisbon")
    assert about and about.group("about") == "the flights to Lisbon"
    assert branch.REWIND.match("Rewind the conversation to before the Porto question, please")
    assert not branch.REWIND.match("go back to the main page")
    assert branch.REWIND_ZH.match("回到我问午饭之前").group("about") == "午饭"
    assert branch.BRANCH.match("Branch from here") and branch.BRANCH.match("fork the conversation")
    assert not branch.BRANCH.match("branch out into new markets")
    assert branch.BRANCH_ZH.match("从这里分支") and branch.BRANCH_ZH.match("开个分支吧")
    assert branch.TRY_AGAIN.match("try that differently") and branch.TRY_AGAIN.match(
        "Try again a different way"
    )
    assert branch.TRY_AGAIN_ZH.match("换个思路再试一次")
    entries = [
        {"role": "user", "text": "Book the flights to Lisbon", "uuid": "x1", "before": ""},
        {"role": "user", "text": "改一下午饭的时间", "uuid": "x2", "before": "x1"},
    ]
    assert branch.find_request(entries, "the flight")["uuid"] == "x1"
    assert branch.find_request(entries, "午饭")["uuid"] == "x2"
    assert branch.find_request(entries, "the") is None
