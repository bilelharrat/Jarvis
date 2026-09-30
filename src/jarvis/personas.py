"""The owner's own personas, beside the built-in three (JARVIS, TARS, FRIDAY): made and edited
in Settings, kept in personas.json beside prefs.json, and chosen like the others.

Each has a name, a description in English and in Chinese (each optional in Chinese: the
English stands in), the humor it starts with, and the fields other features add to it
(register_field: a voice, wake words), kept for them. Registered into prefs.PERSONAS and
lang.ZH_PERSONAS, so Settings, the system prompt, set_personality and the rest treat one as
they treat the built-in three; its id (a short word from its first name) never changes.

Seams for the voice feature (wake words and voices are its own): register_field keeps a
value of its own on each persona, and add_listener hears the owner's personas each time
they change (a persona's name as a wake word, as FRIDAY answers to "Friday").

The file is read before the settings are (the feature's prepare step at startup), so a custom
persona chosen before a restart is still chosen after it. Read defensively: a damaged or
hand-edited file never stops the app starting.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import jsonstore
from .textclean import clean_text

log = logging.getLogger("jarvis")

BUILT_IN = ("jarvis", "tars", "friday")
MAX_PERSONAS = 8
NAME_CHARS = 24
DESCRIPTION_CHARS = 600
_ID = re.compile(r"[a-z][a-z0-9-]{0,23}")

# Fields other features keep on a persona (the voice feature: its voice and wake words):
# name -> clean(value), giving the value to keep or None. The feature shows and sets its own.
FIELDS: dict[str, Any] = {}
# The owner's personas as last registered (by id), and who hears when they change.
KNOWN: dict[str, Persona] = {}
LISTENERS: list[Any] = []


def add_listener(listener: Any) -> None:
    """listener(personas) hears the owner's personas each time they're registered."""
    LISTENERS.append(listener)


def register_field(name: str, clean: Any) -> None:
    """A field a feature keeps on each custom persona (a voice, wake words)."""
    FIELDS[name] = clean


def _line(value: Any, limit: int) -> str:
    return " ".join(clean_text(value).split())[:limit] if isinstance(value, str) else ""


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    lines = [" ".join(line.split()) for line in clean_text(value).splitlines()]
    return "\n".join(line for line in lines if line)[:limit]


def _humor(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return max(0, min(100, int(value)))


@dataclass
class Persona:
    id: str
    name: str
    description: str
    zh_name: str = ""
    zh_description: str = ""
    humor: int = 60
    extra: dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        return asdict(self)


def clean_extra(raw: Any) -> dict[str, Any]:
    kept: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return kept
    for name, clean in FIELDS.items():
        if name in raw:
            try:
                value = clean(raw[name])
            except Exception:
                value = None
            if value is not None:
                kept[name] = value
    # A field no feature registers now (its feature isn't here) is kept as it was.
    for name, value in raw.items():
        if name not in FIELDS and isinstance(name, str) and jsonstore.shallow(value, 4):
            kept.setdefault(name[:40], value)
    return kept


def persona_from(raw: Any) -> Persona | None:
    """A persona from the file or the window, tidied; None when it can't be one."""
    if not isinstance(raw, dict):
        return None
    ident = str(raw.get("id") or "")
    name = _line(raw.get("name"), NAME_CHARS)
    description = _text(raw.get("description"), DESCRIPTION_CHARS)
    if not _ID.fullmatch(ident) or ident in BUILT_IN or not name or not description:
        return None
    humor = _humor(raw.get("humor"))
    return Persona(
        id=ident,
        name=name,
        description=description,
        zh_name=_line(raw.get("zh_name"), NAME_CHARS),
        zh_description=_text(raw.get("zh_description"), DESCRIPTION_CHARS),
        humor=60 if humor is None else humor,
        extra=clean_extra(raw.get("extra")),
    )


def make_id(name: str, taken: set[str]) -> str:
    """A new persona's id: its first name in lowercase letters ("alfred"), numbered when
    that's taken, or persona-N when the name has no letters to use (a Chinese name)."""
    base = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")[:16].strip("-")
    if not base or not base[0].isalpha():
        base = "persona"
    taken = taken | set(BUILT_IN)
    if base not in taken and base != "persona":
        return base
    n = 2 if base != "persona" else 1
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


class PersonaStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.items: list[Persona] = []
        self.unreadable = ""
        try:
            data = jsonstore.load_json(path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("personas: %s can't be read (%s)", path.name, exc)
            data = None
        seen: set[str] = set()
        for raw in data or []:
            persona = persona_from(raw)
            if persona is not None and persona.id not in seen and len(self.items) < MAX_PERSONAS:
                seen.add(persona.id)
                self.items.append(persona)

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [p.public() for p in self.items])

    def get(self, persona_id: str) -> Persona | None:
        return next((p for p in self.items if p.id == persona_id), None)

    def put(self, raw: dict[str, Any]) -> Persona:
        """Add a persona, or change one (by its id). Raises ValueError with why not."""
        ident = str(raw.get("id") or "")
        old = self.get(ident) if ident else None
        if ident and old is None:
            raise ValueError("That persona isn't there any more.")
        if old is None and len(self.items) >= MAX_PERSONAS:
            raise ValueError(f"There's room for {MAX_PERSONAS} personas of your own.")
        name = _line(raw.get("name"), NAME_CHARS)
        if not name:
            raise ValueError("Give the persona a name.")
        if not _text(raw.get("description"), DESCRIPTION_CHARS):
            raise ValueError("Describe the persona: how it talks and what it's like.")
        if old is None:
            ident = make_id(name, {p.id for p in self.items})
        extra = {**(old.extra if old else {}), **clean_extra(raw.get("extra"))}
        persona = persona_from({**raw, "id": ident, "extra": extra})
        if persona is None:
            raise ValueError("That persona can't be kept.")
        before = list(self.items)
        if old is None:
            self.items.append(persona)
        else:
            self.items[self.items.index(old)] = persona
        try:
            self.save()
        except OSError:
            self.items = before
            raise
        return persona

    def remove(self, persona_id: str) -> Persona | None:
        persona = self.get(persona_id)
        if persona is None:
            return None
        before = list(self.items)
        self.items.remove(persona)
        try:
            self.save()
        except OSError:
            self.items = before
            raise
        return persona

    def public(self) -> list[dict[str, Any]]:
        return [p.public() for p in self.items]


def register(items: list[Persona], dropped: list[str] = ()) -> None:
    """Make these personas choosable like the built-in three (prefs.PERSONAS and its
    Chinese in lang.ZH_PERSONAS), and take dropped ones out. The built-in three are never
    replaced or removed."""
    from . import lang, prefs

    for ident in dropped:
        if ident not in BUILT_IN:
            prefs.PERSONAS.pop(ident, None)
            lang.ZH_PERSONAS.pop(ident, None)
    for ident in dropped:
        KNOWN.pop(ident, None)
    for persona in items:
        if persona.id in BUILT_IN:
            continue
        prefs.PERSONAS[persona.id] = (persona.name, persona.description)
        lang.ZH_PERSONAS[persona.id] = (
            persona.zh_name or persona.name,
            persona.zh_description or persona.description,
        )
        KNOWN[persona.id] = persona
    for listener in list(LISTENERS):
        try:
            listener(list(KNOWN.values()))
        except Exception:  # another feature's trouble never costs the owner their personas
            log.exception("personas: a listener failed")


def custom_ids() -> list[str]:
    from . import prefs

    return [k for k in prefs.PERSONAS if k not in BUILT_IN]
