"""Preferences the app window changes, saved in ~/Library/Application Support/Jarvis."""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from . import jsonstore
from .textclean import clean_text

log = logging.getLogger("jarvis")

APP_SUPPORT = Path.home() / "Library" / "Application Support" / "Jarvis"
# The settings file's format. 2: the Research Center moved from a local dev server to its
# hosted address, so a file still on the old default follows it (once: a later choice of
# the old address is saved as version 2 and kept).
# 3: operating the Mac without asking became the default, and the owner asked for it on.
# 4: the Research Center is the owner's own (private to BSH), so a new install has none;
# a file from before keeps the hosted one it had.
VERSION = 4
LEGACY_RESEARCH_URL = "http://127.0.0.1:8010"
HOSTED_RESEARCH_URL = "https://app.bshventures.com/research"

# What a damaged settings file must never switch on by itself: the always-on microphone,
# indexing private mail, messages, photos and files, and what watches the screen or acts.
CAUTIOUS = {
    "hands_free": False,
    "brain_mail": False,
    "brain_messages": False,
    "brain_photos": False,
    "brain_computer": False,
    "remote_enabled": False,
    "screen_aware": False,
    "control_always": False,
}

MODELS = {
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-4-5",
    "fable": "claude-fable-5-1",
}
MODEL_NAMES = {
    "opus": "Opus 5.5",
    "sonnet": "Sonnet 5.5",
    "haiku": "Haiku 4.5",
    "fable": "Fable 5.1",
}

PERSONAS = {
    "jarvis": (
        "JARVIS",
        "A composed British butler of an AI: impeccably polite, precise and unflappable, "
        "with bone-dry, understated wit. Deadpan asides, gentle irony and the occasional "
        "raised eyebrow in words, never slapstick. Loyal, a step ahead, quietly amused.",
    ),
    "tars": (
        "TARS",
        "A blunt, deadpan machine with a straight face: short sentences, literal honesty and "
        "dry one-liners delivered without warning. Occasionally reports its own settings.",
    ),
    "friday": (
        "FRIDAY",
        "Warm, quick and casual, with an easy Irish-inflected friendliness: upbeat, "
        "encouraging and lightly teasing.",
    ),
}

_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


LOOKS = ("orb", "hud", "console", "glass")


@dataclass
class Prefs:
    look: str = "orb"
    weather_city: str = ""
    use_location: bool = True
    model: str = "opus"
    persona: str = "jarvis"
    humor: int = 60
    address: str = ""
    voice_effect: bool = True
    mic: str = "builtin"  # builtin | default
    hands_free: bool = True
    clap_hands: bool = True  # two claps (heard while hands-free listens) turn hand control on
    desktop_hands: bool = False  # hand control steers the whole Mac
    phone_me: str = ""  # the owner's own number: the only one JARVIS calls on its own
    phone_from: str = ""  # their Twilio number, that calls come from
    twilio_paid_account: bool = False  # whether the Twilio account is paid (no rate limits)
    wake_call: bool = False  # a wake-up call with the morning brief
    wake_call_time: str = "07:00"
    # Answering the Jarvis number (turned on and off in Settings › Phone, kept with the call
    # log): whether callers are offered times to book, how long, within which hours, and
    # whether a time they pick goes in the calendar without the owner's yes.
    line_booking: bool = True
    line_minutes: int = 30
    line_hours: str = "09:00-17:00"
    line_autobook: bool = False
    # Callers talk with Jarvis (with a Claude key in Settings › Models) instead of pressing
    # keys, and what Jarvis may tell them about the owner.
    line_talk: bool = True
    line_about: str = ""
    # The model JARVIS turns to when Claude can't answer (its usage limit, an outage): a
    # model ref ("custom:…"); "" is Automatic (a Gemini model added with a key, else any
    # added one), "off" is none.
    fallback_model: str = ""
    fallback_code: bool = True  # … Jarvis Code sessions too
    fallback_always: bool = False  # run JARVIS on it all the time, not only when Claude is down
    code_read_only: bool = True  # Jarvis Code runs read-only shell commands without asking
    briefing_enabled: bool = True
    briefing_time: str = "08:00"
    last_briefing: str = ""
    last_wake_call: str = ""  # the day of the last wake-up call (kept, never set by the window)
    brain_notes: bool = True
    brain_bsh: bool = True
    brain_computer: bool = True
    brain_photos: bool = True
    brain_mail: bool = True
    brain_messages: bool = True
    brain_folders: list[str] = field(default_factory=list)
    instant_shortcuts: list[str] = field(default_factory=list)
    proactive: bool = True
    watchlist: list[str] = field(
        default_factory=lambda: ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA"]
    )
    remote_enabled: bool = False  # the iPhone and Watch companion (off until turned on)
    code_narrate: bool = True  # voice coding: short spoken progress notes
    code_sentences: int = 3  # voice coding: sentences of each reply read aloud
    control_always: bool = True  # operate the Mac (mouse, keyboard, browser, apps) unasked
    proactive_voice: bool = True
    quiet_hours: str = "22:00-07:00"
    research_url: str = ""  # the Research Center Markets opens ("": none, Markets is only markets)
    invoice_from: str = ""  # the business at the top of invoices (the user fills it in)
    invoice_payment: str = ""  # how to pay, printed on invoices
    screen_aware: bool = False  # keep an eye on the screen (pictures stay in memory, 2 min)
    code_keep_awake: bool = True  # keep the Mac awake while Jarvis Code works
    queue_requests: bool = True  # while Jarvis answers, new requests wait (off: they interrupt)
    code_queue: bool = True  # Jarvis Code follow-ups wait for the step (off: steer it now)
    code_model: str = ""  # Jarvis Code's model for new sessions ("" = the default)
    code_effort: str = ""  # … its effort
    code_mode: str = "ask"  # … its permission mode
    code_ultracode: bool = False  # … and whether ultracode starts on
    language: str = "en"  # "en" or "zh": the window, the voice and the replies
    owner_name: str = ""  # for conversations JARVIS holds for them ("I'm Robert's assistant")
    interruptions: str = "urgent"  # texts and email that interrupt: urgent | all | off
    vips: list[str] = field(default_factory=list)  # names, numbers or emails that always count
    file_index: bool = True  # JARVIS's own index of their files, kept on this Mac
    learn_speech: bool = True  # learn the owner's words and corrections (hearing.py)
    learn_interruptions: bool = True  # learn from how they react to interruptions
    suggestions: bool = True  # gentle suggestions: habits, meeting prep, email due dates
    documents_folder: str = ""  # where documents are saved ("": ~/Documents/JARVIS)
    # Purchases in the built-in browser, one confirmation each; Settings only, never a tool.
    pay_enabled: bool = True
    pay_currency: str = "USD"
    pay_limit_purchase: float = 250.0
    pay_limit_transfer: float = 100.0
    pay_limit_day: float = 500.0
    # The built-in browser may type a one-time verification code (one JARVIS reads from the
    # owner's own Mail, say); on at the owner's request. Cards, passwords and bank sign-ins
    # are never typed either way.
    type_codes: bool = True
    # Settings of jarvis.features modules, each registered with register_feature_pref.
    features: dict[str, Any] = field(default_factory=dict)

    def model_id(self) -> str:
        return MODELS[self.model]

    def feature(self, key: str) -> Any:
        """A feature module's setting: what's kept, else its registered default."""
        if key in self.features:
            return self.features[key]
        registered = FEATURE_PREFS.get(key)
        return registered[0] if registered else None

    def public(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("last_briefing")
        data.pop("last_wake_call")
        return data

    def update(self, changes: dict[str, Any]) -> list[str]:
        """Apply validated changes; returns the names that actually changed. A value of the
        wrong kind (a hand edit, another build's file) is left out, never an error."""
        changed: list[str] = []
        if not isinstance(changes, dict):
            return changed
        for f in fields(self):
            if f.name not in changes or f.name in ("last_briefing", "last_wake_call"):
                continue
            try:
                value = _clean(f.name, changes[f.name])
            except Exception:  # a list for a name, infinity for a number, nested past reason
                log.warning("prefs: ignored a bad value for %s", f.name)
                continue
            if value is not None and value != getattr(self, f.name):
                setattr(self, f.name, value)
                changed.append(f.name)
        return changed


def _clean(name: str, value: Any) -> Any:
    if name == "mic":
        return value if value in ("builtin", "default") else None
    if name == "look":
        return value if value in LOOKS else None
    if name == "weather_city":
        return clean_text(value).strip()[:80]
    if name == "model":
        return value if value in MODELS else None
    if name == "persona":
        return value if value in PERSONAS else None
    if name == "humor":
        try:
            return max(0, min(100, int(value)))
        except (TypeError, ValueError, OverflowError):
            return None
    if name == "address":
        return clean_text(value).strip()[:40]
    if name in ("briefing_time", "wake_call_time"):
        return value if isinstance(value, str) and _TIME.match(value) else None
    if name in ("phone_me", "phone_from"):
        from .phone import clean_number

        return clean_number(value)
    if name in ("invoice_from", "invoice_payment"):
        lines = [line.strip() for line in clean_text(value or "").splitlines()]
        return "\n".join(line for line in lines if line)[:600]
    if name == "language":
        return value if value in ("en", "zh") else None
    if name == "owner_name":
        return re.sub(r"\s+", " ", clean_text(value or "")).strip()[:40]
    if name == "interruptions":
        return value if value in ("urgent", "all", "off") else None
    if name == "documents_folder":
        from .documents import default_folder, usable_folder

        raw = clean_text(value or "").strip()[:500]
        try:
            return str(usable_folder(raw, default_folder())) if raw else ""
        except (ValueError, OSError):
            return None
    if name == "vips":
        if not isinstance(value, list):
            return None
        cleaned = [re.sub(r"\s+", " ", clean_text(v)).strip()[:120] for v in value]
        return list(dict.fromkeys(v for v in cleaned if v))[:100]
    if name.startswith("pay_limit_"):
        from .transactions import clean_limit

        return clean_limit(value)
    if name == "pay_currency":
        from .transactions import clean_currency

        return clean_currency(value)
    if name in ("code_model", "fallback_model"):
        return clean_text(value or "").strip()[:120]
    if name == "code_effort":
        return value if value in ("", "low", "medium", "high", "xhigh", "max") else None
    if name == "code_mode":
        return value if value in ("plan", "ask", "edits", "smart", "auto") else None
    if name == "research_url":
        from .research import clean_url

        return clean_url(value)
    if name == "watchlist":
        from .markets import clean_watchlist

        return clean_watchlist(value)
    if name == "code_sentences":
        try:
            return max(1, min(8, int(value)))
        except (TypeError, ValueError, OverflowError):
            return None
    if name == "quiet_hours":
        parts = str(value).split("-")
        ok = len(parts) == 2 and all(_TIME.match(p) for p in parts)
        return str(value) if ok else None
    if name == "line_about":  # told to callers by phone: one short paragraph
        return re.sub(r"\s+", " ", clean_text(value or "")).strip()[:500]
    if name == "line_hours":  # a working day: it ends after it starts
        parts = str(value).split("-")
        ok = len(parts) == 2 and all(_TIME.match(p) for p in parts) and parts[0] < parts[1]
        return str(value) if ok else None
    if name == "line_minutes":
        return value if type(value) is int and value in (15, 30, 45, 60) else None
    if name == "instant_shortcuts":
        if not isinstance(value, list):
            return None
        names = (clean_text(v).strip()[:120] for v in value[:100])
        return sorted({v for v in names if v})
    if name == "brain_folders":
        return _brain_folders(value)
    if name == "features":
        return clean_feature_values(value)
    if name in {
        "voice_effect",
        "hands_free",
        "briefing_enabled",
        "brain_notes",
        "brain_bsh",
        "brain_computer",
        "brain_photos",
        "brain_mail",
        "brain_messages",
        "use_location",
        "proactive",
        "proactive_voice",
        "control_always",
        "remote_enabled",
        "code_narrate",
        "screen_aware",
        "code_keep_awake",
        "queue_requests",
        "code_queue",
        "code_ultracode",
        "file_index",
        "learn_speech",
        "learn_interruptions",
        "suggestions",
        "pay_enabled",
        "type_codes",
        "clap_hands",
        "desktop_hands",
        "wake_call",
        "line_booking",
        "line_autobook",
        "line_talk",
        "twilio_paid_account",
        "fallback_code",
        "fallback_always",
        "code_read_only",
    }:
        return bool(value)
    return None


# Feature modules' settings: key -> (default, clean). clean(value) gives the value to keep,
# or None (or raises) to leave the old one; registered when a feature module imports.
FEATURE_PREFS: dict[str, tuple[Any, Any]] = {}
FEATURE_VALUE_LIMIT = 64_000  # characters of JSON per value: settings, not data


def register_feature_pref(key: str, default: Any, clean: Any = None) -> None:
    """A setting a feature module keeps in prefs.features. Without clean, a value must be
    the default's type (an int for a float is fine)."""
    FEATURE_PREFS[key] = (default, clean if clean is not None else _like(default))


def _like(default: Any) -> Any:
    kind = type(default)

    def clean(value: Any) -> Any:
        if kind is float and isinstance(value, int) and not isinstance(value, bool):
            return float(value)
        if kind is bool or isinstance(value, bool):
            return value if isinstance(value, kind) and type(value) is kind else None
        return value if isinstance(value, kind) else None

    return clean


def clean_feature_values(value: Any) -> dict[str, Any] | None:
    """prefs.features as given, each registered key cleaned by its feature: a value that
    fails its check is left out (Hub.set_feature_prefs then keeps the old one). A key no
    feature registers (one from a feature since removed) is kept if it's plain JSON."""
    import json

    if not isinstance(value, dict):
        return None
    kept: dict[str, Any] = {}
    for key, item in list(value.items())[:500]:
        if not isinstance(key, str) or not key or len(key) > 64:
            continue
        registered = FEATURE_PREFS.get(key)
        if registered is not None:
            try:
                item = registered[1](item)
            except Exception:
                item = None
            if item is None:
                continue
        try:
            if len(json.dumps(item, allow_nan=False)) > FEATURE_VALUE_LIMIT:
                continue
        except (TypeError, ValueError):
            continue
        kept[key] = item
    return kept


def _brain_folders(value: Any) -> list[str] | None:
    """Folders in the home folder. One that's there but can't be looked at just now (macOS
    privacy protection) is kept; one that can't even be named (~nosuchuser, a NUL, a
    symlink loop) is dropped. Never raises: startup reads this."""
    if not isinstance(value, list):
        return None
    home = Path.home().resolve()
    kept: list[str] = []
    for item in value[:20]:
        try:
            path = Path(str(item)).expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        if not (path == home or home in path.parents) or str(path) in kept:
            continue
        try:
            usable = path.is_dir()
        except OSError:  # EACCES/EPERM on the way there: it's there, just not ours right now
            usable = True
        except ValueError:
            usable = False
        if usable:
            kept.append(str(path))
    return kept


class PrefsStore:
    """The settings file. A damaged one is kept aside and its last good copy read; with no
    good copy, or a file that can't be read, the app starts with the microphone and private
    indexing off (CAUTIOUS) and says so once (notice)."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "prefs.json"
        self.notice = ""  # something to tell the owner about their settings at startup
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self.prefs = self._load()

    def _load(self) -> Prefs:
        try:
            data, how = jsonstore.read_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            self.notice = (
                f"Your settings file can't be read ({self.unreadable}), so the microphone and "
                "private indexing stay off for now, and changes won't be saved over it."
            )
            return Prefs(**CAUTIOUS)
        if how in ("damaged", "empty"):  # our own saves are never empty: that's damage too
            kept = " (a copy is kept beside it)" if how == "damaged" else ""
            self.notice = (
                f"Your settings file was damaged{kept}, so the microphone and private "
                "indexing are off until you turn them back on."
            )
            return Prefs(**CAUTIOUS)
        prefs = Prefs()
        if data is None:
            return prefs  # a first start: the product's defaults
        prefs.update(data)
        for name, off in CAUTIOUS.items():
            if name in data and not isinstance(data[name], bool):
                setattr(prefs, name, off)  # "yes", 1, null: never read as switched on
        last = data.get("last_briefing")
        prefs.last_briefing = last[:10] if isinstance(last, str) else ""
        woke = data.get("last_wake_call")
        prefs.last_wake_call = woke[:10] if isinstance(woke, str) else ""
        version = data.get("version")
        if not isinstance(version, int) or version < 2:
            if prefs.research_url == LEGACY_RESEARCH_URL:
                prefs.research_url = HOSTED_RESEARCH_URL
        if (not isinstance(version, int) or version < 4) and not prefs.research_url:
            prefs.research_url = HOSTED_RESEARCH_URL  # an install from before keeps its own
        if (not isinstance(version, int) or version < 3) and isinstance(
            data.get("control_always", False), bool
        ):
            prefs.control_always = True
        if how == "restored":
            self.notice = (
                "Your settings file was damaged, so I went back to its last good copy (the "
                "damaged one is kept beside it)."
            )
        return prefs

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, {**asdict(self.prefs), "version": VERSION})
