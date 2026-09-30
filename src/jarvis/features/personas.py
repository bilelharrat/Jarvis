"""The owner's own personas (the personas feature): made, edited and removed in Settings ›
Personality beside JARVIS, TARS and FRIDAY, and chosen like them. personas.py keeps them
(personas.json beside prefs.json).

- prepare(folder): at startup, before the settings are read, the kept personas are
  registered (prefs.PERSONAS, lang.ZH_PERSONAS), so one chosen before a restart still is.
- Window commands: personas_list (-> personas_custom {items, max, error}), persona_save
  {persona} (a new one, or one changed by its id), persona_delete {id} (the one in use goes
  back to JARVIS first). set_prefs choosing one of them brings its humor along, unless the
  change names a humor itself.
- Claude knows them: the prompt names them at each connect, list_personas describes them,
  and set_personality switches to any of them. Changing the one in use tells Claude at once.
- A voice and wake words per persona belong to the voice feature: personas.register_field
  and personas.add_listener are its seams.

Claude cost policy: no model is called here.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import personas
from ..personas import MAX_PERSONAS, PersonaStore

log = logging.getLogger("jarvis")

FILE = "personas.json"
SERVER = "personas"


def prepare(folder: Path) -> None:
    """Before the settings are read: the owner's personas made choosable."""
    personas.register(PersonaStore(folder / FILE).items)


def prompt() -> str:
    """For the system prompt at each connect: the owner's own personas, when there are any."""
    known = sorted(personas.KNOWN.values(), key=lambda p: p.id)
    if not known:
        return ""
    names = ", ".join(f"{p.id} ({p.name})" for p in known)
    return (
        "\n- Personas: besides jarvis, tars and friday, the user made their own: "
        f"{names}. set_personality switches to any of them by id; list_personas says what "
        "each is like."
    )


class PersonaDesk:
    """The personas feature on one hub (hub.personas)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._store: PersonaStore | None = None  # read on first use, never at install
        self._changing = asyncio.Lock()

    async def store(self) -> PersonaStore:
        if self._store is None:
            store = await asyncio.to_thread(PersonaStore, self.hub.feature_path(FILE))
            if self._store is None:
                self._store = store
                personas.register(store.items)
        return self._store

    async def listing(self, _msg: Any = None, error: str = "") -> None:
        store = await self.store()
        self.hub.emit("personas_custom", items=store.public(), max=MAX_PERSONAS, error=error)

    async def save(self, msg: dict[str, Any]) -> None:
        raw = msg.get("persona")
        if not isinstance(raw, dict):
            return
        hub = self.hub
        async with self._changing:
            store = await self.store()
            try:
                persona = await asyncio.to_thread(store.put, raw)
            except ValueError as exc:
                await self.listing(error=str(exc))
                return
            except OSError as exc:
                await self.listing(error=f"Couldn't save it just now ({exc.strerror or exc}).")
                return
            personas.register(store.items)
        if hub.prefs.persona == persona.id:  # the one in use changed: Claude hears it now
            hub._add_style_note(
                f"the user changed your persona. From now on you are {persona.name}: "
                f"{persona.description}"
            )
        hub.emit("prefs", **hub.prefs_payload())
        await self.listing()

    async def delete(self, msg: dict[str, Any]) -> None:
        hub = self.hub
        ident = str(msg.get("id") or "")
        async with self._changing:
            store = await self.store()
            if store.get(ident) is None:
                return
            if hub.prefs.persona == ident:  # never in use once it's gone
                hub.set_prefs({"persona": "jarvis"})
            try:
                await asyncio.to_thread(store.remove, ident)
            except OSError as exc:
                await self.listing(error=f"Couldn't remove it just now ({exc.strerror or exc}).")
                return
            personas.register(store.items, dropped=[ident])
        hub.emit("prefs", **hub.prefs_payload())
        await self.listing()

    def choosing(self, msg: dict[str, Any]) -> Any:
        """Settings choosing one of the owner's personas: its humor comes too, unless the
        change names one. Anything else goes on to the hub's own set_prefs."""
        changes = msg.get("changes")
        if not isinstance(changes, dict) or "humor" in changes:
            return False
        persona = personas.KNOWN.get(str(changes.get("persona") or ""))
        if persona is None:
            return False
        self.hub.set_prefs({**changes, "humor": persona.humor})
        return None

    def build_server(self) -> Any:
        return create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.tools())

    def tools(self) -> list[Any]:
        @tool(
            "list_personas",
            "The personas you can be: the built-in jarvis, tars and friday, and the ones the "
            "user made, with what each is like and the humor it starts with.",
            {"type": "object", "properties": {}},
        )
        async def list_personas(_args: dict[str, Any]) -> dict[str, Any]:
            from ..prefs import PERSONAS

            lines = []
            for ident, (name, description) in PERSONAS.items():
                own = personas.KNOWN.get(ident)
                humor = f" Starts at humor {own.humor} percent." if own else ""
                mine = " (made by the user)" if own else ""
                lines.append(f"{ident}: {name}{mine}. {description}{humor}")
            current = self.hub.prefs.persona
            return {
                "content": [
                    {"type": "text", "text": f"You are {current} now.\n" + "\n".join(lines)}
                ]
            }

        return [list_personas]

    def install(self) -> None:
        hub = self.hub
        hub.personas = self
        hub.register_server(
            SERVER,
            self.build_server,
            prompt=prompt,
            labels={"list_personas": "Looked at the personas"},
            quiet=["list_personas"],
        )

        def later(work: Any) -> Any:
            return lambda msg: hub._spawn(work(msg)) and None

        hub.register_command("personas_list", later(self.listing))
        hub.register_command("persona_save", later(self.save))
        hub.register_command("persona_delete", later(self.delete))
        hub.register_command("set_prefs", self.choosing)


def install(hub: Any) -> None:
    PersonaDesk(hub).install()
