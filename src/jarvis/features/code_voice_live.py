"""Eden's own voice in Eden Code: the title bar's Voice switch (and Settings › Voice) turns
Eden's ears and voice on in Eden Code on demand, the way Eden Secretary has them.

Eden Code's backend (hub.profile "code") starts with no microphone, no speech model and no
voice player, so that someone who only installed Eden Code is never listened to. Until now
its Voice switch only put a session in voice focus, and nothing heard the owner unless an
Eden Secretary window had joined. Now:

- On: the speech model loads (hub.start_ears), the voice player and the fillers get ready,
  and the hands-free microphone opens (hub.listen_wanted: one listener on the backend, shared
  with Eden Secretary's own hands-free when both apps are on it, never two). The session the
  owner is looking at goes into voice focus (voicecode.py), so what they say goes to it.
- Off: the microphone closes (unless Eden Secretary's own hands-free still wants it), Eden
  stops speaking, and voice focus ends. "Exit code mode" said aloud turns it off too.
- Kept: code_voice_on remembers it was left on. It comes back on only when an Eden Code
  window opens on the backend, and goes quiet when the last one closes; never at launch
  otherwise, and never for an Eden Secretary window alone.
- Talking: with code_voice_wake off (the default, so Eden Code and Eden Secretary don't both
  answer one "Eden"), every utterance goes to the session in focus: a conversation
  (hub.code_no_wake). On, it needs "Eden" / "Hey Eden" first, as Eden Secretary does. With
  code_voice_hands_free off, the microphone opens only while the owner holds the push-to-
  talk key (the window sends code_voice_ptt down/up: hub.listen(hold=True)).
- Spoken review, while voice coding: "read me the changes" walks the session's changes one
  at a time ("Change 2 of 5, in hub.py, in start: 3 lines added, 1 removed": never the code
  itself); "next change", "previous change", "keep it", "undo it" act on the one just said
  (the Changes pane's Keep and Undo, features/code_hunks.py). "Stop", "approve" / "allow",
  "what changed" and the rest are voicecode's own and code_review_voice's.
- Eden's voice is the owner's (Settings › Speaking, features/voice.py): the same picker,
  shown in Eden Code's Settings › Voice too.

Window commands: code_voice_live {on, id?}, code_voice_ptt {down, id?},
code_voice_live_status. Event: code_voice_live {on, active, listening, wake, hands_free,
profile, focus}; code_voice_change {id, number, count} while walking the changes.
Settings (prefs.features): code_voice_on (off), code_voice_wake (off),
code_voice_hands_free (on).

Cost policy: no model calls. Speech is heard by the on-device speech model and said by the
owner's chosen voice (a cloud voice costs what Eden Secretary's replies already cost);
what's said to a session is a message to it, as typing it would be.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from .. import code_changes, lang, prefs
from ..hub import _msg_int

log = logging.getLogger("jarvis")

PREF_ON = "code_voice_on"
PREF_WAKE = "code_voice_wake"
PREF_HANDS_FREE = "code_voice_hands_free"
prefs.register_feature_pref(PREF_ON, False)
prefs.register_feature_pref(PREF_WAKE, False)
prefs.register_feature_pref(PREF_HANDS_FREE, True)

APP = "eden-code"  # Eden Code's windows, as server.APPS names them
WALK_SECONDS = 300.0  # "keep it" means the change last said, for this long after

TEXTS = {
    "Change {n} of {count}, in {file}, in {where}: {what}.": "第 {n} 处改动（共 {count} 处），在 {file} 的 {where} 里：{what}。",
    "Change {n} of {count}, in {file}: {what}.": "第 {n} 处改动（共 {count} 处），在 {file} 里：{what}。",
    "{added} lines added": "加了 {added} 行",
    "{removed} lines removed": "删了 {removed} 行",
    "{added} added, {removed} removed": "加了 {added} 行，删了 {removed} 行",
    "a new file": "一个新文件",
    "There are no changes to go through yet.": "还没有可以逐个过的改动。",
    "That was the last change.": "这是最后一处改动了。",
    "That's the first change.": "这已经是第一处改动了。",
    "Kept.": "保留了。",
    "Pick a session first, then hold the key and talk.": "先选一个会话，再按住按键说话。",
    "Voice is on in Eden Code.": "Eden Code 的语音已打开。",
}
lang.add_texts(TEXTS)

# The review walk's words, each only as the whole utterance (anything else still goes to
# the session as a request). A leading "Eden" was already taken off by the hub.
_LEAD = r"^\W*(?:(?:please|okay|ok|so|now|and|eden|hey eden)\W+)*"
_END = r"\W*(?:please)?\W*$"
START = re.compile(
    _LEAD + r"(?:read|go through|walk me through|take me through|go over|tell me)(?: me)?"
    r"(?: all)? (?:the |your |these )?(?:changes|edits|diffs?)(?: one by one| with me)?" + _END,
    re.IGNORECASE,
)
NEXT = re.compile(
    _LEAD + r"(?:next(?: change| one| edit)?|(?:go )?on to the next(?: one| change)?)" + _END,
    re.IGNORECASE,
)
PREVIOUS = re.compile(
    _LEAD + r"(?:previous(?: change| one)?|go back(?: one)?|back one)" + _END, re.IGNORECASE
)
KEEP = re.compile(_LEAD + r"keep (?:it|that|this)(?: one| change)?" + _END, re.IGNORECASE)
UNDO = re.compile(
    _LEAD + r"(?:undo|revert|drop|reject) (?:it|that|this)(?: one| change)?" + _END,
    re.IGNORECASE,
)
ZH = {
    "start": re.compile(r"^(?:伊甸[，,\s]*)?(?:读|念|过)一?(?:下|遍)?(?:这些|所有)?改动[。！!]*$"),
    "next": re.compile(r"^(?:伊甸[，,\s]*)?下一(?:处|个)(?:改动)?[。！!]*$"),
    "previous": re.compile(r"^(?:伊甸[，,\s]*)?上一(?:处|个)(?:改动)?[。！!]*$"),
    "keep": re.compile(r"^(?:伊甸[，,\s]*)?保留(?:它|这个|这处)[。！!]*$"),
    "undo": re.compile(r"^(?:伊甸[，,\s]*)?撤销(?:它|这个|这处)[。！!]*$"),
}


def walk_word(text: str, walking: bool) -> str | None:
    """Which review-walk word an utterance is ("start", "next", "previous", "keep",
    "undo"), or None. "next change" starts a walk too; "keep it", "undo it", "next" and
    "go back" mean something only during one (otherwise "undo it" is voicecode's own undo
    of the last step, and the rest go to the session)."""
    said = " ".join(str(text or "").replace("’", "'").split())
    if not said:
        return None
    for word, pattern in ZH.items():
        if pattern.match(said):
            return word if walking or word in ("start", "next") else None
    if START.match(said):
        return "start"
    if NEXT.match(said):
        if walking or re.search(r"\b(change|edit)\b", said, re.IGNORECASE):
            return "next"
        return None
    if not walking:
        return None
    if PREVIOUS.match(said):
        return "previous"
    if KEEP.match(said):
        return "keep"
    if UNDO.match(said):
        return "undo"
    return None


def change_words(n: int, count: int, path: str, hunk: Any, language: str) -> str:
    """One change, said for the ear: where (the file's name, the function git named) and
    how big. Never its lines: code isn't read aloud."""
    added, removed = len(hunk.added), len(hunk.removed)
    if added and removed:
        what = lang.tr("{added} added, {removed} removed", language, added=added, removed=removed)
    elif removed:
        what = lang.tr("{removed} lines removed", language, removed=removed)
    elif hunk.old_count == 0 and hunk.old_start == 0:
        what = lang.tr("a new file", language)
    else:
        what = lang.tr("{added} lines added", language, added=added)
    file = path.rsplit("/", 1)[-1]
    where = hunk.where
    if where:
        template = "Change {n} of {count}, in {file}, in {where}: {what}."
        return lang.tr(template, language, n=n, count=count, file=file, where=where, what=what)
    template = "Change {n} of {count}, in {file}: {what}."
    return lang.tr(template, language, n=n, count=count, file=file, what=what)


@dataclass
class Walk:
    """Where the owner is in a session's changes: the hunk last said, the ones already
    passed (in order, for "go back"), and when it was said."""

    task_id: int
    which: str = "session"
    current: str = ""
    passed: list[str] = field(default_factory=list)
    at: float = 0.0


class LiveVoice:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.active = False  # Eden's ears are on for Eden Code
        self.walk: Walk | None = None
        self._clock = time.monotonic

    def install(self) -> None:
        hub = self.hub
        hub.listen_wanted.append(self.wants_listener)
        hub.code_no_wake = self.no_wake
        hub.register_command("code_voice_live", self.on_live)
        hub.register_command("code_voice_ptt", self.on_ptt)
        hub.register_command("code_voice_live_status", self.on_status)
        hub.add_event_sink(("app_windows",), self.on_windows)
        hub.add_event_sink(("voicecode",), self.on_focus)
        hub.voicecode.hooks.append(self.review_hook)

    # ── what the hub asks ──

    def _pref(self, key: str) -> bool:
        return self.hub.prefs.feature(key) is True

    def wants_listener(self) -> bool:
        """The hands-free microphone: open while Voice is on in Eden Code, in conversation
        mode (push-to-talk alone opens it only while the key is held)."""
        return self.active and self.hub.prefs.feature(PREF_HANDS_FREE) is not False

    def no_wake(self) -> bool:
        return self.active and not self._pref(PREF_WAKE)

    # ── on and off ──

    def start(self) -> None:
        """Eden's ears and voice, now: the speech model, the voice player, the listener."""
        self.active = True
        self.hub.start_ears()
        self._apply()
        self.publish()

    def stop(self) -> None:
        """The microphone closes (unless Eden Secretary's hands-free still has it), a held
        push-to-talk ends, and Eden stops speaking."""
        if not self.active:
            return
        self.active = False
        self.walk = None
        self.hub.finish_push_to_talk()
        self.hub.speech.clear()
        self._apply()
        self.publish()

    def _apply(self) -> None:
        try:
            self.hub._apply_hands_free()
        except RuntimeError:  # no running loop (a test calling it outside one)
            log.warning("Eden Code voice: no event loop to open the microphone on")

    def _code_windows(self) -> int:
        return int(self.hub.app_windows.get(APP, 0))

    async def on_live(self, msg: dict[str, Any]) -> None:
        """The Voice switch: on puts the session shown (id) in voice focus and opens the
        ears; off ends both."""
        on = msg.get("on") is True
        if self.hub.prefs.feature(PREF_ON) is not on:
            self.hub.set_feature_prefs({PREF_ON: on})
        if on:
            task_id = _msg_int(msg, "id")
            if task_id and self.hub.voicecode.focus != task_id:
                await self.hub.voice_code(task_id=task_id)
            self.start()
        else:
            self.stop()
            if self.hub.voicecode.focus is not None:
                self.hub.voicecode.exit()

    async def on_ptt(self, msg: dict[str, Any]) -> None:
        """Hold to talk: down opens the microphone until up (the window's held key)."""
        hub = self.hub
        if msg.get("down") is not True:
            hub.finish_push_to_talk()
            return
        task_id = _msg_int(msg, "id")
        if hub.voicecode.focus is None:
            if not task_id:
                hub.emit(
                    "caption",
                    text=lang.tr("Pick a session first, then hold the key and talk.", hub.language),
                )
                return
            await hub.voice_code(task_id=task_id)
        hub.start_ears()
        hub._spawn(hub.listen(hold=True))

    async def on_status(self, _msg: dict[str, Any] | None = None) -> None:
        self.publish()

    def on_windows(self, event: dict[str, Any]) -> None:
        """Voice left on comes back with Eden Code's first window, and goes quiet with its
        last (the setting stays on for next time)."""
        windows = event.get("windows") or {}
        open_ = int(windows.get(APP, 0) or 0)
        if open_ and not self.active and self._pref(PREF_ON):
            self.start()
        elif not open_ and self.active:
            self.stop()

    def on_focus(self, event: dict[str, Any]) -> None:
        """Voice focus ended ("exit code mode", the session closed): in Eden Code alone
        that's Voice off too, so the microphone never stays open for nobody."""
        if event.get("focus") is None and self.active:
            if self.hub.prefs.feature(PREF_ON) is True:
                self.hub.set_feature_prefs({PREF_ON: False})
            self.stop()
        else:
            self.publish()

    def public(self) -> dict[str, Any]:
        hub = self.hub
        listener = getattr(hub, "_listener", None)
        return {
            "on": self._pref(PREF_ON),
            "active": self.active,
            "listening": bool(listener is not None and listener.running),
            "wake": self._pref(PREF_WAKE),
            "hands_free": hub.prefs.feature(PREF_HANDS_FREE) is not False,
            "profile": hub.profile,
            "focus": hub.voicecode.focus,
        }

    def publish(self) -> None:
        self.hub.emit("code_voice_live", **self.public())

    # ── spoken review: one change at a time ──

    def _walking(self, task: Any) -> bool:
        walk = self.walk
        return (
            walk is not None and walk.task_id == task.id and self._clock() - walk.at <= WALK_SECONDS
        )

    async def review_hook(self, text: str, task: Any) -> bool:
        word = walk_word(text, self._walking(task))
        if word is None:
            return False
        try:
            await self._walk(word, task)
        except Exception:
            log.exception("Eden Code voice: the review walk failed")
            return False
        return True

    async def _view(self, task: Any) -> tuple[str, Any]:
        view = await asyncio.to_thread(code_changes.task_view, task, "session")
        if view is None or view.files:
            return "session", view
        return "branch", await asyncio.to_thread(code_changes.task_view, task, "branch")

    async def _walk(self, word: str, task: Any) -> None:
        hub = self.hub
        language = hub.language
        which, view = await self._view(task)
        numbered = view.numbered() if view is not None else []
        if not numbered:
            self.walk = None
            hub.say(lang.tr("There are no changes to go through yet.", language))
            return
        ids = [h.id for _n, _f, h in numbered]
        walk = self.walk if self._walking(task) and word != "start" else None
        if walk is None:
            walk = self.walk = Walk(task.id, which)
        walk.which = which
        if word in ("keep", "undo") and walk.current:
            hunks = hub.code_hunks
            if word == "keep":
                hunks.keep(task, [walk.current])
                said = lang.tr("Kept.", language)
            else:
                said = lang.translate(await hunks.undo(task, which, [walk.current]), language)
                which, view = await self._view(task)
                numbered = view.numbered() if view is not None else []
                ids = [h.id for _n, _f, h in numbered]
            await hunks.changes({"id": task.id, "view": which})
            walk.passed.append(walk.current)
            walk.current = ""
            nxt = self._next(walk, ids)
            if nxt is None:
                self.walk = None
                hub.say(f"{said} {lang.tr('That was the last change.', language)}")
                return
            walk.current = nxt
            hub.say(f"{said} {self._say_change(walk, numbered, language)}")
            return
        if word == "previous":
            if not walk.passed:
                hub.say(lang.tr("That's the first change.", language))
                return
            walk.current = walk.passed.pop()
        elif word == "next" and walk.current:
            walk.passed.append(walk.current)
            nxt = self._next(walk, ids)
            if nxt is None:
                walk.passed.pop()
                hub.say(lang.tr("That was the last change.", language))
                return
            walk.current = nxt
        else:  # "start", or "next change" with nothing said yet: the first one
            walk.passed, walk.current = [], ids[0]
        hub.say(self._say_change(walk, numbered, language))

    def _next(self, walk: Walk, ids: list[str]) -> str | None:
        done = set(walk.passed)
        return next((i for i in ids if i not in done), None)

    def _say_change(self, walk: Walk, numbered: list[Any], language: str) -> str:
        walk.at = self._clock()
        for n, f, h in numbered:
            if h.id == walk.current:
                self.hub.emit("code_voice_change", id=walk.task_id, number=n, count=len(numbered))
                return change_words(n, len(numbered), f.path, h, language)
        return ""


def install(hub: Any) -> None:
    live = LiveVoice(hub)
    live.install()
    hub.code_voice_live = live
