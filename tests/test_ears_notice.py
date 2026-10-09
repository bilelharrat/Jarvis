"""The first time on a computer, the speech model has to be downloaded (a minute or two). That is
said and shown, so nobody speaks into a silence, and said again when it is ready or could not come."""

from __future__ import annotations

import asyncio

import pytest

from jarvis import hub as hub_module
from jarvis import listen


def transcriber() -> listen.Transcriber:
    return listen.Transcriber("base.en")


def test_a_model_already_on_the_computer_is_known_and_one_that_is_not_is_too(monkeypatch):
    import faster_whisper.utils as utils

    seen = []

    def there(name, **kw):
        seen.append((name, kw))
        return "/models/base.en"

    monkeypatch.setattr(utils, "download_model", there)
    assert transcriber().cached() is True
    assert seen == [("base.en", {"local_files_only": True})]  # (never fetched just to be asked)

    def gone(name, **kw):
        raise OSError("not in the cache")

    monkeypatch.setattr(utils, "download_model", gone)
    assert transcriber().cached() is False


def test_a_warm_up_that_cannot_load_says_why_and_never_raises(monkeypatch, caplog):
    ears = transcriber()

    def offline():
        raise ConnectionError("no route to huggingface.co")

    monkeypatch.setattr(ears, "_load", offline)
    ears._warm()
    assert ears.error.startswith("ConnectionError: no route")
    assert not ears.loaded()
    monkeypatch.setattr(ears, "_load", lambda: object())
    ears._warm()
    assert ears.error == ""  # (a later try that works clears it)


class Ears:
    def __init__(self, cached=False):
        self.warmed, self.ready, self.error, self._cached = 0, False, "", cached

    def cached(self):
        return self._cached

    def warm_up(self):
        self.warmed += 1

    def loaded(self):
        return self.ready


@pytest.fixture
def desk(settings, quiet_speaker, isolated, monkeypatch):
    from conftest import FakeClient

    hub = hub_module.Hub(
        settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated
    )
    events, said, spawned = [], [], []
    monkeypatch.setattr(hub, "emit", lambda kind, **data: events.append((kind, data)))
    monkeypatch.setattr(hub, "_say", said.append)
    monkeypatch.setattr(hub, "_spawn", lambda coro: spawned.append(coro) or coro.close())
    real_sleep = asyncio.sleep

    async def quick(_seconds):
        await real_sleep(0)

    monkeypatch.setattr(hub_module.asyncio, "sleep", quick)
    hub.poll = True
    return hub, events, said, spawned


def test_a_model_that_has_to_be_downloaded_is_warmed_up_and_the_wait_is_announced(desk):
    hub, _events, _said, spawned = desk
    hub.transcriber = Ears(cached=False)
    hub._warm_up_ears()
    assert hub.transcriber.warmed == 1 and len(spawned) == 1


def test_a_model_already_there_is_warmed_up_quietly(desk):
    hub, _events, said, spawned = desk
    hub.transcriber = Ears(cached=True)
    hub._warm_up_ears()
    assert hub.transcriber.warmed == 1 and spawned == [] and said == []


def test_an_app_that_does_not_poll_and_stand_ins_without_the_question_are_not_troubled(desk):
    hub, _events, _said, spawned = desk
    hub.poll = False
    hub.transcriber = Ears(cached=False)
    hub._warm_up_ears()
    assert hub.transcriber.warmed == 1 and spawned == []

    class Plain:  # (a test's stand-in: it can warm up, and has no cache to ask)
        warmed = 0

        def warm_up(self):
            self.warmed += 1

    hub.poll = True
    hub.transcriber = Plain()
    hub._warm_up_ears()
    assert hub.transcriber.warmed == 1 and spawned == []

    hub.transcriber = object()  # (no warm-up at all)
    hub._warm_up_ears()
    assert spawned == []


async def test_the_wait_is_said_and_shown_and_so_is_the_model_being_ready(desk):
    hub, events, said, _spawned = desk
    ears = Ears()
    task = asyncio.ensure_future(hub._ears_notice(ears))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert said and "Getting my hearing ready" in said[0] and "a minute or two" in said[0]
    assert events[0][0] == "toast" and events[0][1]["title"] == "Speech"
    ears.ready = True
    await asyncio.wait_for(task, 2)
    assert said[-1] == "I can hear you now."
    assert events[-1] == ("toast", {"title": "Speech", "text": "I can hear you now."})


async def test_a_model_that_could_not_come_is_said_with_what_to_do(desk):
    hub, events, said, _spawned = desk
    ears = Ears()
    task = asyncio.ensure_future(hub._ears_notice(ears))
    await asyncio.sleep(0)
    ears.error = "ConnectionError: offline"
    await asyncio.wait_for(task, 2)
    assert "couldn't download my speech model" in said[-1] and "restart me" in said[-1]
    assert events[-1][0] == "error"


async def test_the_wait_is_not_kept_forever(desk, monkeypatch):
    hub, events, said, _spawned = desk
    monkeypatch.setattr(hub_module, "EARS_WAIT_SECONDS", 6)  # (three looks)
    await asyncio.wait_for(hub._ears_notice(Ears()), 2)
    assert len(said) == 1  # (only the first words: never ready, never failed, and then it stops)
