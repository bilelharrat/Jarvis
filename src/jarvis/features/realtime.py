"""Realtime conversation: Settings › Listening › "Realtime conversation" (off by default).

With it on, the wake word (or a long press on the orb) starts a spoken back-and-forth with a
speech-to-speech model (realtime.py): OpenAI's Realtime API or Google's Gemini Live, on the
owner's own key from Settings › Models (an "OpenAI-compatible" provider at
https://api.openai.com, or a "Google Gemini" one with an AI Studio key). Keys are read from
the Keychain through providers.py, only when a conversation starts; never in the
environment or on disk.

- The model is the voice only. Its one tool, ask_jarvis, runs the usual JARVIS turn (the
  hub's ask: Claude, every tool and gate, cards, the turn's taint), silently, and the model
  speaks the result. A request counts as the owner's own words (for the gates that trust
  them) only when it matches what the owner was heard saying; a paraphrase, or anything the
  model came up with, is asked about on a card instead.
- Recognise my voice: each ask_jarvis runs the owner-voice check on the owner's latest
  utterance, with the scope rules of hands-free (Everything: someone else is refused;
  Only risky actions: their words aren't the owner's, so the gates ask).
- While it runs, hands-free's utterances aren't transcribed (the hub's mic_taken); while a
  card is up, the microphone goes back to hands-free (a "stop" still works) and the card
  is answered on screen.
- It ends after 20 seconds of nobody talking, on "that's all" (or 就这样), a tap on the
  orb, or the day's minutes running out. With Talk over Jarvis on, the Mac's echo
  cancellation lets the owner interrupt the voice; without it, the microphone is held while
  the voice plays.
- No key, no connection, an error, or the minutes used up: the wake word does what it always
  did (hands-free listening, the request asked the usual way), and JARVIS says why once.

Cost policy: the realtime provider bills per minute of audio on the owner's key, while a
conversation is open, never in the background. Each day's use is capped by the Settings
field (realtime_minutes, default 20 minutes a day; a conversation is also cut at 15
minutes): the wall time of every conversation counts, so the cap is an upper bound on what's
billed. Approximate list prices (check each provider's pricing page; they change):
OpenAI gpt-realtime about $0.02 a minute of your speech and $0.08 a minute of its voice
(openai.com/api/pricing); Gemini 2.5 Flash native audio about $0.005 and $0.02
(ai.google.dev/pricing). Claude: ask_jarvis runs the same JARVIS turn a spoken request
would, on the model JARVIS uses; no other Claude call is made here.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from .. import jsonstore, lang, realtime
from .. import prefs as prefs_module

log = logging.getLogger("jarvis")

PROVIDERS = ("auto", "openai", "gemini")
MINUTES_DEFAULT = 20
MINUTES_MAX = 240
SESSION_MAX = 15 * 60.0  # seconds one conversation may run
OWN_WORDS = 0.8  # share of a request's words the owner must have said, for it to be theirs
HEARD_WAIT = 1.5  # seconds to wait for the owner's transcript to catch up with a call
USAGE_FILE = "realtime_usage.json"


def _clean_minutes(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return None
    return minutes if 1 <= minutes <= MINUTES_MAX else None


prefs_module.register_feature_pref("realtime_on", False)
prefs_module.register_feature_pref(
    "realtime_provider", "auto", lambda v: v if v in PROVIDERS else None
)
prefs_module.register_feature_pref("realtime_minutes", MINUTES_DEFAULT, _clean_minutes)
# Whose voice speaks: JARVIS's own (the cloud voice the Mac speaks with, saying the model's
# words sentence by sentence; about half a second slower) or the realtime model's.
prefs_module.register_feature_pref(
    "realtime_voice", "jarvis", lambda v: v if v in ("jarvis", "model") else None
)
SETTINGS = ("realtime_on", "realtime_provider", "realtime_minutes", "realtime_voice")

# What the owner says to end it: "that's all", "that'll be all", "we're done", 就这样.
FINISHED = re.compile(
    r"^(?:(?:ok(?:ay)?|thanks?|thank\s+you|jarvis|alright|great)\b[\s,.!]*)*"
    r"(?:that(?:'s|\s+is|'ll\s+be|\s+will\s+be)\s+all|that's\s+it|we're\s+done|we\s+are\s+done"
    r"|i'm\s+done|end\s+(?:the\s+)?conversation|goodbye|bye(?:\s+jarvis)?)"
    r"(?:[\s,]+(?:thanks?|thank\s+you|jarvis|for\s+now))*[\s.!]*$",
    re.IGNORECASE,
)
FINISHED_ZH = re.compile(
    r"^(?:(?:好的|好|谢谢|贾维斯|jarvis|行)[，,\s]*)*"
    r"(?:就这样|就这些|先这样|没事了|没别的了|结束对话|再见|拜拜)(?:吧|了|啦)?"
    r"(?:[，,\s]*(?:谢谢|贾维斯))*[。！!.\s]*$",
    re.IGNORECASE,
)

NO_KEY = (
    "Realtime conversation needs an OpenAI or Google Gemini key in Settings › Models, so I'll "
    "listen the usual way."
)
NO_CONNECTION = "Realtime conversation couldn't connect, so I'll listen the usual way."
DROPPED = "The realtime conversation dropped, so I'm back to listening the usual way."
USED_UP = "Today's realtime conversation minutes are used up, so I'll listen the usual way."
NO_HANDS_FREE = "Realtime conversation needs hands-free listening on."
NO_PLAYER = "My voice player isn't ready yet, so I'll listen the usual way."
CARD = "It's on your screen for your OK."
NOT_OWNER = "That wasn't the owner's voice, so JARVIS didn't take it."
lang.add_texts(
    {
        NO_KEY: "实时对话需要在“设置 › 模型”中添加 OpenAI 或 Google Gemini 密钥，所以我先用平常的方式听。",
        NO_CONNECTION: "实时对话连接不上，所以我先用平常的方式听。",
        DROPPED: "实时对话断开了，我回到平常的聆听方式。",
        USED_UP: "今天的实时对话分钟数已用完，所以我先用平常的方式听。",
        NO_HANDS_FREE: "实时对话需要先开启免提聆听。",
        NO_PLAYER: "我的语音播放器还没准备好，所以我先用平常的方式听。",
        CARD: "请在屏幕上确认。",
    }
)
# Why it isn't available, as the pane shows it (Chinese in web/i18n/realtime.json).
WHY_NO_KEY = "Add an OpenAI or Google Gemini key in Settings › Models."
WHY_VERTEX = "Gemini Live needs a Google AI Studio key (AIza…), not a Vertex AI one."


def finished(text: str) -> bool:
    text = text.strip()
    return bool(FINISHED.match(text) or FINISHED_ZH.match(text))


def said_by_owner(request: str, heard: list[str]) -> bool:
    """Whether a request is (nearly) the owner's own words: most of its words were in what
    the owner was just heard saying."""
    words = lang.words_zh(request)
    if not words:
        return False
    said = set(lang.words_zh(" ".join(heard)))
    return sum(1 for w in words if w in said) / len(words) >= OWN_WORDS


def openai_key(store: Any) -> str:
    """The key of an OpenAI-compatible provider whose sealed address is OpenAI's own ("" when
    there's none): the realtime socket goes to api.openai.com, and so may only its key."""
    for provider in list(getattr(store, "providers", {}).values()):
        if provider.kind != "openai":
            continue
        if (urlsplit(provider.base_url).hostname or "").lower() != "api.openai.com":
            continue
        try:
            return store._key(provider)  # checked against the address it was sealed with
        except ValueError:
            continue
    return ""


def gemini_key(store: Any) -> str:
    key = store.key_of("gemini") if store is not None else ""
    return key if key.startswith("AIza") else ""


def _keys(store: Any) -> dict[str, Any]:
    """Which providers have a usable key (the Keychain: call in a thread)."""
    found: dict[str, Any] = {"openai": False, "gemini": False, "vertex": False}
    if store is None:
        return found
    try:
        found["openai"] = bool(openai_key(store))
        raw = store.key_of("gemini")
    except Exception:  # a locked Keychain
        return found
    found["gemini"] = raw.startswith("AIza")
    found["vertex"] = bool(raw) and not found["gemini"]
    return found


class Realtime:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.conv: realtime.Conversation | None = None
        self.provider = ""  # the one in use
        self.keys: dict[str, Any] | None = None  # None until looked up
        self.why = ""  # the last reason it fell back, for the pane
        self._said: set[str] = set()  # reasons already said out loud
        self._heard: list[str] = []  # what the owner was heard saying, latest last
        self._heard_new: asyncio.Event | None = None
        self._task: asyncio.Task | None = None
        self.connect: Any = None  # tests: the socket's connect
        self.urls: dict[str, str] = {}  # tests: the fake server's address, per provider
        self.muted = lambda: bool(getattr(hub.speaker, "muted", False))

    # ── settings ──

    def on(self) -> bool:
        return bool(self.hub.prefs.feature("realtime_on"))

    def minutes(self) -> int:
        return int(self.hub.prefs.feature("realtime_minutes") or MINUTES_DEFAULT)

    def _usage(self) -> dict[str, Any]:
        try:
            data = jsonstore.load_json(self.hub.feature_path(USAGE_FILE), dict)
        except OSError:
            data = None
        today = date.today().isoformat()
        if not isinstance(data, dict) or data.get("day") != today:
            return {"day": today, "seconds": 0.0}
        seconds = data.get("seconds")
        ok = isinstance(seconds, (int, float)) and not isinstance(seconds, bool)
        return {"day": today, "seconds": max(0.0, float(seconds)) if ok else 0.0}

    def used_seconds(self) -> float:
        return self._usage()["seconds"]

    def _add_usage(self, seconds: float) -> None:
        usage = self._usage()
        usage["seconds"] = round(usage["seconds"] + max(0.0, seconds), 1)
        try:
            jsonstore.save_json(self.hub.feature_path(USAGE_FILE), usage)
        except OSError:
            log.warning("realtime: couldn't save today's minutes")

    def left_seconds(self) -> float:
        return max(0.0, self.minutes() * 60.0 - self.used_seconds())

    def pick(self, keys: dict[str, Any]) -> str:
        wanted = self.hub.prefs.feature("realtime_provider")
        if wanted in ("openai", "gemini"):
            return wanted if keys.get(wanted) else ""
        return next((p for p in ("openai", "gemini") if keys.get(p)), "")

    def public(self) -> dict[str, Any]:
        keys = self.keys or {}
        why = self.why
        if self.on() and self.keys is not None and not self.pick(keys):
            vertex = keys.get("vertex") and self.hub.prefs.feature("realtime_provider") != "openai"
            why = WHY_VERTEX if vertex else WHY_NO_KEY
        return {
            "on": self.on(),
            "provider": self.hub.prefs.feature("realtime_provider"),
            "minutes": self.minutes(),
            "used": round(self.used_seconds() / 60.0, 1),
            "keys": {"openai": bool(keys.get("openai")), "gemini": bool(keys.get("gemini"))},
            "active": self.conv is not None,
            "using": self.provider if self.conv is not None else "",
            "state": self.conv.state if self.conv is not None else "",
            "talk_over": bool(self.hub.talk_over()),
            "voice": self.hub.prefs.feature("realtime_voice"),
            "jarvis_voice": self.jarvis_voice() is not None,
            "why": why,
        }

    def _voice(self) -> dict[str, Any]:
        """JARVIS's own voice for the conversation, when it's chosen and there is one."""
        cloud = self.jarvis_voice()
        if cloud is None or self.hub.prefs.feature("realtime_voice") == "model":
            return {}
        clean = getattr(self.hub.speaker, "clean", None) or (lambda t: t)
        return {"speak": lambda text: cloud.stream(clean(text)), "speak_rate": cloud.stream_rate}

    def jarvis_voice(self) -> Any:
        """The cloud voice the Mac speaks with, when there is one."""
        return getattr(getattr(self.hub, "speaker", None), "cloud", None)

    def emit(self) -> None:
        self.hub.emit("realtime", **self.public())

    async def refresh_keys(self) -> dict[str, Any]:
        self.keys = await asyncio.to_thread(_keys, getattr(self.hub, "providers", None))
        return self.keys

    async def status(self, _msg: dict[str, Any] | None = None) -> None:
        await self.refresh_keys()
        self.emit()

    async def settings(self, msg: dict[str, Any]) -> None:
        changes = msg.get("changes")
        if isinstance(changes, dict):
            wanted = {k: v for k, v in changes.items() if k in SETTINGS}
            if wanted:
                self.hub.set_feature_prefs(wanted)
            if not self.on() and self.conv is not None:
                self.conv.stop("stopped")
        self.why = ""
        self._said.clear()  # a changed setting: a reason is worth saying again
        await self.status()

    # ── starting ──

    def mic_taken(self) -> bool:
        return self.conv is not None and not self.hub.approvals

    def wake(self, command: str, check: Any) -> bool:
        """The hub's wake word hook: True when a conversation takes it. A reason known now
        (off, the minutes used up) leaves the wake word to hands-free, said once; one found
        as it starts (no key, no connection) hands it back the same way."""
        if not self.on():
            return False
        if self.conv is not None or (self._task is not None and not self._task.done()):
            return True  # one is starting or running: this wake word is part of it
        if self.left_seconds() <= 0:
            self._tell(USED_UP)
            return False
        self._task = self.hub._spawn(self.converse(command, check))
        return True

    async def start_command(self, _msg: dict[str, Any] | None = None) -> None:
        """A long press on the orb (never voice-checked, as a tap isn't)."""
        if self.conv is not None or (self._task is not None and not self._task.done()):
            return
        if not self.on():
            return
        self._task = self.hub._spawn(self.converse("", None, fallback=False))

    async def stop_command(self, _msg: dict[str, Any] | None = None) -> None:
        if self.conv is not None:
            self.conv.stop("stopped")

    def _tell(self, reason: str) -> None:
        """Say why once (until something changes); the pane shows it."""
        self.why = reason
        if reason not in self._said:
            self._said.add(reason)
            self.hub.say(reason, follow_up=False)
        self.emit()

    def _usual_way(self, command: str, check: Any, fallback: bool) -> None:
        """What the wake word does without a realtime conversation."""
        if not fallback:
            return
        if len(lang.words(command, self.hub.language)) >= 2:
            self.hub.emit("heard", text=command)
            self.hub._spawn(self.hub.ask(command, voice=check))
        elif self.hub._listener is not None:
            self.hub._arm()

    async def converse(self, command: str, check: Any, fallback: bool = True) -> None:
        hub = self.hub
        if check is not None and not await hub._voice_allows(check):
            return  # someone else's voice, with "Everything": ignored as hands-free does
        listener = hub._listener
        if listener is None or not getattr(listener, "running", False):
            self._tell(NO_HANDS_FREE)
            return
        keys = await self.refresh_keys()
        provider = self.pick(keys)
        if not provider:
            self._tell(WHY_VERTEX if keys.get("vertex") else NO_KEY)
            self._usual_way(command, check, fallback)
            return
        left = self.left_seconds()
        if left <= 0:
            self._tell(USED_UP)
            self._usual_way(command, check, fallback)
            return
        if getattr(hub.speaker, "player_path", None) is None:
            self._tell(NO_PLAYER)
            self._usual_way(command, check, fallback)
            return
        try:
            key = await asyncio.to_thread(
                openai_key if provider == "openai" else gemini_key, hub.providers
            )
        except Exception:
            key = ""
        if not key:
            self._tell(NO_KEY)
            self._usual_way(command, check, fallback)
            return
        cls = realtime.BACKENDS[provider]
        backend = cls(key, url=self.urls[provider]) if provider in self.urls else cls(key)
        del key
        self._heard = [command] if command else []
        self._heard_new = asyncio.Event()
        conv = realtime.Conversation(
            backend,
            prompt=realtime.instructions(hub.language, getattr(hub.prefs, "address", "") or ""),
            ask=self.ask_jarvis,
            player=hub.speaker.live,
            on_state=self._on_state,
            finished=finished,
            on_heard=self._on_heard,
            full_duplex=lambda: bool(hub.talk_over()),
            paused=lambda: bool(hub.approvals),
            muted=self.muted,
            max_seconds=min(SESSION_MAX, left),
            connect=self.connect,
            **self._voice(),
        )
        self.conv, self.provider = conv, provider
        before = getattr(listener, "on_block", None)

        def tap(block: Any, speaking: bool) -> None:
            if before is not None:
                before(block, speaking)
            conv.feed(block, speaking)

        listener.on_block = tap
        hub.speech.clear()  # a reply still being read out gives way
        self.emit()
        log.info("realtime conversation (%s) starting", provider)
        why = ""
        try:
            why = await conv.run(command if len(lang.words(command, hub.language)) >= 2 else "")
            self.why = ""
            self._said.clear()  # it worked: a later failure is worth saying
            log.info("realtime conversation ended: %s", why)
        except realtime.Failed as failed:
            log.warning("realtime conversation (%s) failed: %s", provider, failed)
            started = bool(conv.started)
            self.conv = None  # the microphone is hands-free's again before anything's said
            self._tell(DROPPED if started else NO_CONNECTION)
            if not started:
                self._usual_way(command, check, fallback)
        finally:
            if listener.on_block is tap:
                listener.on_block = before
            if conv.started:
                self._add_usage(time.monotonic() - conv.started)
            self.conv = None
            self.provider = ""
            if hub.state in ("listening", "speaking") and not hub._lock.locked():
                hub.set_state("idle")
            self.emit()
        if why == "cap" and self.left_seconds() <= 0:
            self._tell(USED_UP)

    # ── during a conversation ──

    def _on_state(self, state: str) -> None:
        hub = self.hub
        # JARVIS's own turn (ask_jarvis) shows its state itself until it ends.
        if state and (state == "thinking" or not hub._lock.locked()):
            hub.set_state(state)
        self.emit()

    def _on_heard(self, text: str) -> None:
        self._heard = [*self._heard[-3:], text]
        self.hub.emit("heard", text=text)
        if self._heard_new is not None:
            self._heard_new.set()

    async def ask_jarvis(self, request: str, audio: Any) -> str:
        """The realtime model's one tool: the usual JARVIS turn, answered silently."""
        hub = self.hub
        guard = hub.voice_guard
        check = guard.start(audio) if guard is not None and audio is not None else None
        if check is not None and not await hub._voice_allows(check):
            log.info("realtime: not the owner's voice; not asked")
            return NOT_OWNER
        own = said_by_owner(request, self._heard)
        if not own and self._heard_new is not None:
            # The transcript of what they said may come a moment after the call.
            self._heard_new.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._heard_new.wait(), HEARD_WAIT)
            own = said_by_owner(request, self._heard)
        if not own:
            log.info("realtime: a request not in the owner's words; the gates will ask")
        # Not the owner's words: shown as the request, but nothing trusts it as theirs, so
        # every gate asks on a card first.
        return await hub.ask(request, silent=True, voice=check, display=None if own else request)

    def card_up(self, _approval: dict[str, Any]) -> None:
        """A card went up during a conversation: said once, answered on screen (a silent
        turn's card isn't taken by voice)."""
        if self.conv is not None:
            with contextlib.suppress(Exception):
                self.hub.speech.push(lang.translate(CARD, self.hub.language))


def feature_for(hub: Any) -> Realtime | None:
    return getattr(hub, "realtime_feature", None)


def install(hub: Any) -> None:
    feature = Realtime(hub)
    hub.realtime_feature = feature
    hub.mic_taken = feature.mic_taken
    hub.realtime_start = feature.wake
    hub.add_approval_sink(feature.card_up)
    hub.register_command("realtime_status", feature.status)
    hub.register_command("realtime_settings", feature.settings)
    hub.register_command("realtime_start", feature.start_command)
    hub.register_command("realtime_stop", feature.stop_command)
