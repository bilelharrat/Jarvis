"""The hub's hooks for JARVIS's own conversation (the feature kit): options at each connect,
each request just before Claude gets it, every message of the stream, and a feature's own
first connect at startup. A hook that fails never costs the owner a connect or a request."""

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import CALENDAR_TURN, FakeClient

from jarvis.hub import Hub


class Transcriber:
    def warm_up(self):
        pass


def make_hub(settings, speaker, isolated, script=CALENDAR_TURN):
    class Client(FakeClient):
        pass

    Client.script = script
    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    hub.first_connect = None  # these tests look at the hub's own first connect
    return hub


async def test_connect_hooks_see_each_connect_and_a_broken_one_is_skipped(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = []

    def broken(_options, _resume):
        raise RuntimeError("broken")

    def hook(options, resume):
        seen.append(resume)
        options.effort = "high"

    hub.add_connect_hook(broken)
    hub.add_connect_hook(hook)
    await hub.start()
    assert seen == [""] and hub.client.options.effort == "high"
    hub._session_id = "s-1"
    await hub._reconnect()
    assert seen == ["", "s-1"] and hub.client.options.resume == "s-1"


async def test_query_hooks_hear_the_owners_words_just_before_claude(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    heard = []

    async def hook(text, rid):
        heard.append((text, rid == hub._rid, len(hub.client.queries)))

    def broken(_text, _rid):
        raise RuntimeError("broken")

    hub.add_query_hook(broken)
    hub.add_query_hook(hook)
    await hub.start()
    await hub.ask("What's on tomorrow?")
    await hub.ask("Brief me", display="Routine: brief me")
    assert heard == [("What's on tomorrow?", True, 0), ("", True, 1)]
    assert hub.turn["reply"] == "Two meetings tomorrow."  # the broken hook cost nothing


async def test_message_sinks_hear_every_message_but_the_stream(settings, quiet_speaker, isolated):
    script = [AssistantMessage(content=[TextBlock(text="Hi.")], model="m"), CALENDAR_TURN[-1]]
    hub = make_hub(settings, quiet_speaker, isolated, script=script)
    got = []
    hub.add_message_sink(got.append)
    await hub.start()
    await hub.ask("Hello")
    assert [type(m) for m in got] == [AssistantMessage, ResultMessage]


async def test_a_first_connect_of_a_features_own_replaces_the_hubs(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    calls = []

    async def carry_on():
        calls.append("carry on")
        await hub._connect(resume="s-9")
        return True

    hub.first_connect = carry_on
    await hub.start()
    assert calls == ["carry on"] and hub.client.options.resume == "s-9"

    other = make_hub(settings, quiet_speaker, isolated)

    async def nothing_to_carry_on():
        return False

    other.first_connect = nothing_to_carry_on
    await other.start()
    assert other.client is not None and other.client.options.resume is None
