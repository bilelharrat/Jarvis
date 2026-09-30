"""The second brain, grown: search by meaning, the galaxy's search and filters, more sources
(JARVIS's own conversations, text in images, Safari and other browsers' bookmarks,
Reminders, Voice Memos) and Research v2 (the owner's own material in reports, follow-ups,
PDFs). Each lives in its own module (embeddings, ocr, brain_sources, reminders_kit, reports);
this registers them on the hub:

- settings (prefs.features): brain_semantic, brain_conversations, brain_images, brain_safari,
  brain_bookmarks, brain_reminders, brain_voicememos, research_local;
- hub.brain_extension: the rebuild's arguments for them, the ones refreshed with mail and
  texts every four hours, and opening their notes;
- hub.kb.semantic: search by meaning, for every search of the second brain (JARVIS's
  search_notes, the galaxy's search box, the research pass);
- hub.tasks.research_local: the research desk's second pass over the owner's material;
- window commands: brain_search (-> brain_results), brain_source and brain_semantic (a
  switch, then the rebuild it needs), brain_semantic_status (-> brain_semantic),
  research_reports (-> research_reports), report_pdf (-> report_exported), report_open;
- the "reports" tool server: list_reports, read_report, export_report_pdf;
- a loop that readies search by meaning a little after startup (its helper and vectors).

Cost policy (Claude): nothing here calls a model on its own. Vectors, text in images and
Voice Memos' transcripts are all made on this Mac. The only model calls are the research
desk's second pass (reports.py: once per research request the owner makes, medium effort,
at most reports.LOCAL_TURNS turns) and follow-ups on reports, which are ordinary turns.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any

from .. import brain_sources, embeddings, prefs, reports, swift_helper
from ..brain_sources import SEMANTIC, SWITCHES, VECTORS

log = logging.getLogger("jarvis")

for _key, _default in [*SWITCHES.values(), SEMANTIC, reports.LOCAL_PREF]:
    prefs.register_feature_pref(_key, _default)

RECENT = ("conversations", "images", "reminders", "voicememos")  # refreshed every 4 hours
PROMPT = (
    "\n- The second brain also holds your past conversations with the user (source "
    "conversations), and, as they turn them on, text in their screenshots and images, their "
    "Safari and other browsers' bookmarks, Reminders and Voice Memos transcripts; "
    "search_notes matches by meaning as well as by words. When the user asks what you talked "
    "about before ('what did we say about the lease last week?'), search_notes for it."
)
MAX_RESULTS = 40
RESULT_KEYS = ("id", "title", "source", "group", "excerpt", "match", "modified")
WARM_AFTER = 45.0  # seconds after startup: search by meaning's helper and vectors, ready
APPS = {"reminders": "Reminders", "voicememos": "Voice Memos"}


class BrainExtension:
    """What the hub asks of this feature about the second brain (hub.brain_extension)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def on(self, source: str) -> bool:
        return bool(self.hub.prefs.feature(SWITCHES[source][0]))

    def build_args(self) -> dict[str, Any]:
        """For the rebuild (brain_build): which newer sources to read, whether to make
        vectors, and the speech model Voice Memos are transcribed with."""
        more: dict[str, Any] = {source: self.on(source) for source in SWITCHES}
        more["semantic"] = bool(self.hub.prefs.feature(SEMANTIC[0]))
        if more["voicememos"]:
            from .. import lang

            language = self.hub.language
            more["whisper"] = {
                "model": lang.whisper_model(language, self.hub.settings.whisper_model),
                "language": language,
            }
        return {"more": more}

    def recent_sources(self) -> set[str]:
        return {source for source in RECENT if self.on(source)}

    def open_note(self, note: Any) -> bool:
        """Open one of these sources' notes where it lives; False for the core ones."""
        if note.source not in SWITCHES:
            return False
        from .. import computer, mac_tools

        hub = self.hub
        if note.source in ("safari", "bookmarks"):
            if brain_sources._web_url(note.ref):
                hub._spawn(hub._quiet(mac_tools.run_command("open", note.ref)))
        elif note.source in APPS:
            hub._spawn(hub._quiet(mac_tools.run_command("open", "-a", APPS[note.source])))
        elif note.source == "images" or note.id.startswith("file:"):
            try:
                path = computer.safe_path(note.ref)
            except ValueError:
                return True
            hub._spawn(hub._quiet(mac_tools.run_command("open", str(path))))
        else:  # a conversation from Jarvis's own records: its words are what the window shows
            hub.emit(
                "toast",
                title="Jarvis conversation",
                text="This conversation is in Jarvis's own records; its words are shown here.",
            )
        return True


class SemanticControl:
    """Search by meaning's switch: its helper built, Apple's model files fetched when
    they're missing (only now, after the owner turned it on), then the vectors made by a
    rebuild; and its state for the window."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.task: asyncio.Task | None = None
        self.state = ""  # "", preparing, downloading, unavailable, error
        self.detail = ""
        self._building = threading.Lock()

    def query_embedder(self) -> embeddings.Embedder | None:
        """The query's helper, once built; never built inside a search (that's done when the
        setting goes on, or at startup): until then searches are by words alone."""
        binary = swift_helper.binary_for(embeddings.HELPER)
        if binary is None or not binary.exists():
            if self._building.acquire(blocking=False):
                threading.Thread(target=self._build_quietly, daemon=True).start()
            return None
        return embeddings.HelperEmbedder(binary, timeout=embeddings.QUERY_SECONDS)

    def _build_quietly(self) -> None:
        try:
            swift_helper.ensure(embeddings.HELPER)
        finally:
            self._building.release()

    def payload(self) -> dict[str, Any]:
        hub = self.hub
        on = bool(hub.prefs.feature(SEMANTIC[0]))
        meta = _vector_meta(embeddings.vectors_path(hub.kb.store))
        out: dict[str, Any] = {
            "on": on,
            "vectors": int(meta.get("vectors") or 0),
            "wanted": int(meta.get("wanted") or 0),
        }
        if not on:
            return {**out, "state": "off", "detail": ""}
        if self.state:
            return {**out, "state": self.state, "detail": self.detail}
        if hub.brain_state.get("state") == "building":
            return {**out, "state": "building", "detail": ""}
        error = str(meta.get("error") or "")
        if error == "no-assets":
            return {**out, "state": "unavailable", "detail": "no-assets"}
        if error:
            return {**out, "state": "error", "detail": error}
        if not meta or meta.get("built_at") != hub.kb.built_at:
            return {**out, "state": "waiting", "detail": ""}
        return {**out, "state": "ready", "detail": ""}

    def emit(self) -> None:
        self.hub.emit("brain_semantic", **self.payload())

    def switch(self, on: bool) -> None:
        hub = self.hub
        hub.set_feature_prefs({SEMANTIC[0]: on})
        if not on:
            if self.task is not None and not self.task.done():
                self.task.cancel()
            self.state = self.detail = ""
            if hub.kb.semantic is not None:
                hub.kb.semantic.forget()
            self.emit()
            return
        if self.task is None or self.task.done():
            self.task = hub._spawn(self.prepare())
        self.emit()

    async def prepare(self) -> None:
        """Helper, model files, vectors: each step said in the window as it happens."""
        try:
            self._set("preparing", "")
            binary = await asyncio.to_thread(swift_helper.ensure, embeddings.HELPER)
            if binary is None:
                self._set("error", "helper")
                return
            status = await asyncio.to_thread(embeddings.helper_status, binary)
            models = status.get("models") or []
            if not models:
                self._set("error", status.get("error") or "helper")
                return
            if not all(m.get("available") for m in models):
                # The one moment anything is downloaded: macOS fetches Apple's model files.
                self._set("downloading", "")
                await asyncio.to_thread(embeddings.request_assets, binary)
                status = await asyncio.to_thread(embeddings.helper_status, binary)
                models = status.get("models") or []
            if not any(m.get("available") for m in models):
                self._set("unavailable", "no-assets")
                return
            self._set("", "")
            await self.hub.rebuild_brain(only={VECTORS})
            await asyncio.to_thread(self.hub.kb.warm_semantic)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # said in Settings, never a crash
            log.warning("search by meaning couldn't be readied: %s", exc)
            self._set("error", str(exc)[:200])
        finally:
            self.emit()

    def _set(self, state: str, detail: str) -> None:
        self.state, self.detail = state, detail
        self.emit()


def _vector_meta(path: Path) -> dict[str, Any]:
    """The vectors file's counts and state, without loading its vectors."""
    try:
        import json

        import numpy as np

        with np.load(path, allow_pickle=False) as data:
            meta = json.loads(str(data["meta"]))
    except Exception:  # none yet, or damaged: the next rebuild writes it
        return {}
    return meta if isinstance(meta, dict) else {}


def research_file(value: Any) -> Path | None:
    """A report or its PDF or web page, directly in the research folder; None otherwise."""
    try:
        folder = reports.RESEARCH_DIR.resolve()
        path = Path(str(value or "")).expanduser()
        if path.is_symlink():
            return None
        path = path.resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if path.parent != folder or path.suffix.lower() not in (".md", ".pdf", ".html"):
        return None
    return path if path.is_file() else None


def _clean_sources(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    kept = [s for s in value if isinstance(s, str) and 0 < len(s) <= 40][:40]
    return kept or None


def install(hub: Any) -> None:
    extension = BrainExtension(hub)
    control = SemanticControl(hub)
    hub.brain_extension = extension
    hub.kb.semantic = embeddings.SemanticSearch(
        lambda: bool(hub.prefs.feature(SEMANTIC[0])), control.query_embedder
    )
    hub.tasks.research_local = lambda task: reports.own_material_pass(task, hub)

    async def brain_search(msg: dict[str, Any]) -> None:
        query = str(msg.get("q") or "")[:400]
        try:
            k = max(1, min(MAX_RESULTS, int(msg.get("k") or 30)))
        except (TypeError, ValueError):
            k = 30
        hits = await asyncio.to_thread(
            hub.kb.search,
            query,
            k,
            sources=_clean_sources(msg.get("sources")),
            since=str(msg.get("since") or "")[:10],
            until=str(msg.get("until") or "")[:10],
        )
        hub.emit(
            "brain_results",
            seq=str(msg.get("seq") or "")[:40],
            q=query,
            items=[{key: h[key] for key in RESULT_KEYS} for h in hits],
        )

    def brain_source(msg: dict[str, Any]) -> None:
        source = str(msg.get("source") or "")
        if source not in SWITCHES or not isinstance(msg.get("on"), bool):
            return
        changed = hub.set_feature_prefs({SWITCHES[source][0]: msg["on"]})
        if changed:
            hub._spawn(hub.rebuild_brain(only={source}))

    def brain_semantic(msg: dict[str, Any]) -> None:
        if isinstance(msg.get("on"), bool):
            control.switch(msg["on"])

    def research_local(msg: dict[str, Any]) -> None:
        if isinstance(msg.get("on"), bool):
            hub.set_feature_prefs({reports.LOCAL_PREF[0]: msg["on"]})

    async def research_reports(_msg: dict[str, Any]) -> None:
        hub.emit("research_reports", items=await asyncio.to_thread(reports.list_reports))

    async def report_pdf(msg: dict[str, Any]) -> None:
        path = await asyncio.to_thread(reports.find_report, str(msg.get("name") or ""))
        if path is None:
            hub.emit("report_exported", name=str(msg.get("name") or "")[:200], error="missing")
            return
        try:
            out, is_pdf = await reports.export_pdf(path, hub.pdf_call)
        except OSError as exc:
            hub.emit("report_exported", name=path.name, error=str(exc.strerror or exc)[:200])
            return
        hub.emit("report_exported", name=path.name, path=str(out), pdf=is_pdf)

    def report_open(msg: dict[str, Any]) -> None:
        from .. import mac_tools

        path = research_file(msg.get("path"))
        if path is not None:
            hub._spawn(hub._quiet(mac_tools.run_command("open", str(path))))

    def later(work: Any) -> Any:
        """A command whose work takes a while runs in the background: the window's socket
        reads one command at a time, and a PDF waits on the window's own answer to it."""
        return lambda msg: hub._spawn(work(msg)) and None

    hub.register_command("brain_search", later(brain_search))
    hub.register_command("brain_source", brain_source)
    hub.register_command("brain_semantic", brain_semantic)
    hub.register_command("brain_semantic_status", lambda _msg: control.emit())
    hub.register_command("research_local", research_local)
    hub.register_command("research_reports", later(research_reports))
    hub.register_command("report_pdf", later(report_pdf))
    hub.register_command("report_open", report_open)
    hub.register_server(
        reports.SERVER_NAME,
        lambda: reports.build_server(hub.pdf_call),
        prompt=PROMPT + reports.PROMPT,
        labels=reports.LABELS,
        quiet=("export_report_pdf",),
    )

    async def warm() -> None:
        """A little after startup, with search by meaning on: the helper built and running
        and the vectors in memory, so the first search needn't wait for them."""
        await asyncio.sleep(WARM_AFTER)
        if not hub.prefs.feature(SEMANTIC[0]):
            return
        await asyncio.to_thread(swift_helper.ensure, embeddings.HELPER)
        await asyncio.to_thread(hub.kb.warm_semantic)

    hub.register_loop("brain_semantic_warm", warm)
