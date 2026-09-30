"""Fakes shared by the chat channel tests: a hub whose Claude answers from a script, a chat
app that records what it was asked to send, and a way to wait for the channels' work."""

import asyncio

from claude_agent_sdk import AssistantMessage, TextBlock
from conftest import FakeClient, result

from jarvis.channels.base import Channel, Inbound, Media
from jarvis.channels.store import Owner
from jarvis.hub import Hub

REPLY_TURN = [
    AssistantMessage(content=[TextBlock(text="Two meetings tomorrow.")], model="m"),
    result(),
]


class Transcriber:
    def __init__(self, text="what's on tomorrow"):
        self.text, self.heard = text, []

    def transcribe(self, audio, *_hints):
        self.heard.append(len(audio))
        return self.text


def make_hub(settings, speaker, isolated, script=REPLY_TURN, transcriber=None):
    class Client(FakeClient):
        pass

    Client.script = script
    return Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        # Never the real Whisper: hub.start() would load (or download) a model otherwise.
        transcriber=transcriber or Transcriber(),
        poll=False,
        **isolated,
    )


class FakeChat(Channel):
    """A chat app that records everything it's asked to send."""

    limit = 4000

    def __init__(self, router, name="telegram", title="Telegram", buttons=True):
        super().__init__(router)
        self.name, self.title, self.buttons = name, title, buttons
        self.typing_every = 0.01 if buttons else 0.0
        self.sent, self.cards, self.closed, self.files, self.asked = [], [], [], [], []
        self.typed = 0
        self.fail = False

    def ready(self):
        return True

    def home_chat(self):
        owner = self.router.state.owners.get(self.name)
        return owner.chat if owner else None

    async def send_text(self, chat, text, *, title="", markup=True):
        if self.fail:
            raise OSError("down")
        self.sent.append((chat, f"{title}\n{text}" if title else text))

    async def send_card(self, chat, card, lang):
        self.cards.append((chat, card))
        return {"id": f"m{len(self.cards)}", "text": card["question"]}

    async def close_card(self, chat, ref, outcome):
        self.closed.append((chat, ref["id"], outcome))

    async def typing(self, chat):
        self.typed += 1

    async def ask_reason(self, chat, text):
        self.asked.append((chat, text))

    async def send_file(self, chat, path, caption=""):
        self.files.append((chat, path.name, caption))

    def texts(self):
        return [t for _chat, t in self.sent]


def attach(hub, name="telegram", title="Telegram", buttons=True, owner=("42", "42")):
    """The hub's channels with a fake chat app in place of one, switched on and paired."""
    router = hub.chat_channels
    chat = FakeChat(router, name, title, buttons)
    router.adapters[name] = chat
    hub.set_feature_prefs({f"channels_{name}_on": True})
    if owner is not None:
        router.state.owners[name] = Owner(owner[0], owner[1], "Ann (@ann)")
    return router, chat


def said(text, chat="42", sender="42", channel="telegram", **kw):
    return Inbound(channel=channel, chat=chat, sender=sender, text=text, **kw)


def voice(data=b"RIFF", seconds=3.0, size=100):
    async def fetch():
        return data

    return Media("voice", "voice note", "audio/ogg", fetch, size=size, seconds=seconds)


def picture(data, name="photo.jpg", media_type="image/jpeg"):
    async def fetch():
        return data

    return Media("image", name, media_type, fetch, size=len(data))


async def settle(router, rounds=200):
    """Wait until the channels have nothing left running (a request, a card, a send)."""
    for _ in range(rounds):
        pending = [t for t in list(router.tasks) if not t.done()]
        if not pending:
            await asyncio.sleep(0)
            if not [t for t in list(router.tasks) if not t.done()]:
                return
        await asyncio.sleep(0.01)
    raise AssertionError(f"still running: {[t.get_coro() for t in router.tasks]}")
