"""Eden Code: "Bring over from…", moving what the owner has in another coding tool (Claude Code
first, then Codex, Cursor, Windsurf, Copilot, Gemini CLI, Cline, Roo Code, Aider, Zed,
OpenCode, Continue, Amp, Kiro, Warp and Junie) into Eden Code in one guided flow: a picker of
the tools found on this computer, a preview of everything found with what Import would do
(ticked boxes, counts, what already works, what can't move and why), Import, a summary, and
Undo. The finding and reading is code_import.py and its adapters (jarvis/import_sources);
this is where it lands in Eden Code, and the window's commands.

What it adds, and where:
- Window commands: cimp_sources {}; cimp_preview {source}; cimp_import {source, items: [ids]};
  cimp_undo {source}; cimp_history {}; cimp_chat {source, id}.
- Events: cimp_sources {sources: [{id, name, blurb, found, paths, imported}]},
  cimp_preview {source, name, items, counts, error?}, cimp_done {source, added, skipped,
  manual}, cimp_undone {source, removed, kept}, cimp_history {chats}, cimp_chat {source, id,
  title, messages, error?}.
- TaskManager.option_hooks: the imported MCP servers in each Eden Code session (a project's
  only in that project), never over a server of the same name the session has already.
- TaskManager.turn_notes: the imported rules files with a session's first message, read
  fresh each time (an edit where the file is counts), at most RULES_CHARS of each.

Importing the same tool twice adds nothing twice (the ledger, code_import.Ledger, says what
came before); Undo takes away what that tool's import added, and nothing else: a saved prompt
the owner changed since stays, a default the owner changed since stays. The other tool's own
files are never written, moved or deleted, and no key from them is logged, kept in a file or
sent to the window: an MCP server's keys go into the Keychain only when the owner ticks it.

Settings (prefs.features): code_import_on (bool, on): sessions use what was brought over (the
rules and the MCP servers); code_import_offered (bool, off): the welcome's card was answered.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path
from typing import Any

from .. import code_import as ci
from .. import code_projects, prefs
from ..codeplatform import background, project_of

log = logging.getLogger("jarvis")

PREF_ON = "code_import_on"
PREF_OFFERED = "code_import_offered"
prefs.register_feature_pref(PREF_ON, True)
prefs.register_feature_pref(PREF_OFFERED, False)
SIGNIN_WAIT = 10.0  # seconds claude auth status may take


class Importer:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.ledger = ci.Ledger(hub.feature_path("code-import.json"))
        self.home: Path | None = None  # (a test's own home folder)
        self.platform: str | None = None
        self.scanned: dict[
            str, list[ci.Item]
        ] = {}  # source -> its last preview (keys in memory only)
        self.told: set[int] = set()  # sessions that had the imported rules
        self.signed_in = self._signed_in  # (the tests' own)

    # ── what Eden Code has ──

    def env(self) -> ci.Env:
        import sys

        return ci.Env(self.home or Path.home(), self.platform or sys.platform)

    def _sessions(self) -> Any:
        return getattr(self.hub, "code_sessions", None)

    def context(self, signed_in: bool | None = None) -> ci.Context:
        tm = self.hub.tasks
        eden: dict[str, str] = {}
        for name in tm.projects():
            with contextlib.suppress(Exception):
                eden[str(tm.project_path(name))] = name
        desk = self._sessions()
        folders = desk.projects.folders() if desk is not None else []
        roots = desk.projects.roots() if desk is not None else []
        for folder in folders:
            eden.setdefault(str(folder), folder.name)
        snippets = {
            s["name"]: s["text"]
            for s in self.hub.prefs.feature("code_snippets") or []
            if isinstance(s, dict)
            and isinstance(s.get("name"), str)
            and isinstance(s.get("text"), str)
        }
        env = self.env()
        claude_mcp: set[str] = set()
        with contextlib.suppress(ci.ReadError, AttributeError):
            state = ci.read_json(env.claude_json()) if ci.is_file(env.claude_json()) else {}
            claude_mcp = {str(n) for n in (state.get("mcpServers") or {})}
        providers = getattr(self.hub, "providers", None)

        def known(ref: str) -> bool:
            try:
                return bool(providers.known(ref)) if providers is not None else False
            except Exception:
                return False

        home = env.home
        return ci.Context(
            eden_projects=eden,
            folders=[Path(p) for p in eden if ci.is_dir(Path(p))],
            snippets=snippets,
            ledger=self.ledger.data,
            claude_mcp=claude_mcp,
            code_model=self.hub.prefs.code_model or "",
            code_mode=self.hub.prefs.code_mode or "ask",
            known_model=known,
            signed_in=signed_in,
            using_key=bool(self.hub.prefs.feature("claude_signin")),
            folder_ok=lambda p: code_projects.folder_problem(p, home)[1],
            projects_dir=self.hub.settings.projects_dir,
            roots=list(roots),
            folders_room=max(0, code_projects.FOLDERS_MAX - len(folders)),
        )

    async def _signed_in(self) -> bool | None:
        """Claude Code's own login, by its auth status (local and free; no token is read)."""
        from .ops.doctor import _last_json, claude_cli

        cli = claude_cli()
        if not cli:
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                cli, "auth", "status", "--json",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )  # fmt: skip
        except OSError:
            return None
        try:
            out, _err = await asyncio.wait_for(proc.communicate(), SIGNIN_WAIT)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            return None
        status = _last_json(out.decode(errors="replace"))
        found = status.get("loggedIn") if isinstance(status, dict) else None
        return found if isinstance(found, bool) else None

    # ── the window's commands ──

    async def cmd_sources(self, _msg: dict[str, Any]) -> None:
        env = self.env()

        def look() -> list[dict[str, Any]]:
            out = []
            for source in ci.sources():
                found = ci.detect(source, env)
                out.append({
                    "id": source.id, "name": source.name, "blurb": source.blurb,
                    "found": bool(found), "paths": [ci._shown_path(p) for p in found[:4]],
                    "imported": self.ledger.summary(source.id),
                })  # fmt: skip
            return out

        self.hub.emit("cimp_sources", sources=await asyncio.to_thread(look))

    async def preview(self, source_id: str) -> list[ci.Item] | None:
        source = ci.source_by_id(source_id)
        if source is None:
            return None
        signed = await self.signed_in() if source_id == "claude_code" else None
        ctx = self.context(signed)
        items = await asyncio.to_thread(ci.scan, source, self.env(), ctx)
        self.scanned[source_id] = items
        return items

    async def cmd_preview(self, msg: dict[str, Any]) -> None:
        source_id = str(msg.get("source") or "")
        items = await self.preview(source_id)
        if items is None:
            self.hub.emit(
                "cimp_preview", source=source_id, items=[], counts={}, error="No tool by that name."
            )
            return
        self._emit_preview(source_id, items)

    def _emit_preview(self, source_id: str, items: list[ci.Item]) -> None:
        source = ci.source_by_id(source_id)
        counts: dict[str, int] = {}
        for item in items:
            counts[item.status] = counts.get(item.status, 0) + 1
        self.hub.emit("cimp_preview", source=source_id, name=source.name if source else source_id,
                      items=[i.public() for i in items], counts=counts)  # fmt: skip

    async def cmd_import(self, msg: dict[str, Any]) -> None:
        source_id = str(msg.get("source") or "")
        wanted = msg.get("items")
        wanted = {str(i) for i in wanted[:5000]} if isinstance(wanted, list) else set()
        items = self.scanned.get(source_id) or await self.preview(source_id) or []
        result = self.apply(source_id, [i for i in items if i.id in wanted and i.status == "new"])
        self.scanned.pop(source_id, None)  # (its keys, in memory, go with it)
        result["manual"] = [{"title": i.title, "why": i.why} for i in items if i.status == "manual"]
        self.hub.emit("cimp_done", source=source_id, **result)
        await self._changed()
        fresh = await self.preview(source_id)
        if fresh is not None:
            self._emit_preview(source_id, fresh)

    async def cmd_undo(self, msg: dict[str, Any]) -> None:
        source_id = str(msg.get("source") or "")
        result = self.undo(source_id)
        self.hub.emit("cimp_undone", source=source_id, **result)
        await self._changed()
        fresh = await self.preview(source_id)
        if fresh is not None:
            self._emit_preview(source_id, fresh)

    async def cmd_history(self, _msg: dict[str, Any]) -> None:
        names = {s.id: s.name for s in ci.sources()}
        chats = [
            {"source": c["source"], "tool": names.get(c["source"], c["source"]), "id": c["id"],
             "title": c.get("title", ""), "when": c.get("when", 0), "project_name": c.get("project_name", "")}
            for c in self.ledger.chats()[:3000]
        ]  # fmt: skip
        self.hub.emit("cimp_history", chats=chats)

    async def cmd_chat(self, msg: dict[str, Any]) -> None:
        source_id, chat_id = str(msg.get("source") or ""), str(msg.get("id") or "")
        entry = next(
            (c for c in self.ledger.chats() if c["source"] == source_id and c["id"] == chat_id),
            None,
        )
        source = ci.source_by_id(source_id)
        base = {"source": source_id, "id": chat_id}
        if entry is None or source is None or source.read_chat is None:
            self.hub.emit(
                "cimp_chat", **base, title="", messages=[], error="That chat isn't in the history."
            )
            return
        try:
            messages = await asyncio.to_thread(source.read_chat, entry)
        except Exception:  # a file gone or changed shape: said, never a crash
            log.warning("Couldn't read a past chat from %s", source.name, exc_info=True)
            self.hub.emit("cimp_chat", **base, title=entry.get("title", ""), messages=[],
                          error=f"Couldn't read it: {source.name} may have moved or changed it.")  # fmt: skip
            return
        self.hub.emit(
            "cimp_chat", **base, title=entry.get("title", ""), messages=messages[: ci.CHAT_MESSAGES]
        )

    async def _changed(self) -> None:
        desk = self._sessions()
        if desk is not None:
            with contextlib.suppress(Exception):
                await desk._projects_changed()

    # ── import and undo ──

    def apply(self, source_id: str, items: list[ci.Item]) -> dict[str, Any]:
        """Bring the ticked Items into Eden Code: {added: [...], skipped: [{title, why}]}."""
        entry = self.ledger.entry(source_id)
        added: list[dict[str, str]] = []
        skipped: list[dict[str, str]] = []
        folders = [str(p) for p in (self.hub.prefs.feature("code_project_folders") or [])]
        snippets = list(self.hub.prefs.feature("code_snippets") or [])
        pref_changes: dict[str, Any] = {}
        for item in items:
            p = item.payload
            if item.kind == "project":
                if len(folders) >= code_projects.FOLDERS_MAX:
                    skipped.append(
                        {
                            "title": item.title,
                            "why": f"Eden Code keeps up to {code_projects.FOLDERS_MAX} folders: remove one in Settings › Projects.",
                        }
                    )
                    continue
                if p["path"] not in folders:
                    folders.append(p["path"])
                if p["path"] not in entry["projects"]:
                    entry["projects"].append(p["path"])
                added.append({"kind": "project", "title": item.title})
            elif item.kind == "mcp":
                name = p["name"]
                keys = sorted(p.get("secret_env") or {})
                try:
                    for var in keys:
                        self.hub.connectors.vault.set(
                            f"{ci.VAULT_PREFIX}{name}", var, p["secret_env"][var]
                        )
                except Exception:
                    skipped.append(
                        {
                            "title": name,
                            "why": "Couldn't keep its key in the Keychain, so it didn't come.",
                        }
                    )
                    continue
                entry["mcp"][name] = {
                    "spec": p["spec"],
                    "keys": keys,
                    "project": p.get("project", ""),
                }
                added.append({"kind": "mcp", "title": name})
            elif item.kind == "rules":
                if not any(r.get("path") == p["path"] for r in entry["rules"]):
                    entry["rules"].append({k: p[k] for k in ("path", "scope", "project", "label")})
                added.append({"kind": "rules", "title": item.title})
            elif item.kind == "command":
                if len(snippets) >= code_projects.SNIPPETS_MAX:
                    skipped.append(
                        {
                            "title": item.title,
                            "why": f"Eden Code keeps up to {code_projects.SNIPPETS_MAX} saved prompts.",
                        }
                    )
                    continue
                if any(s.get("name") == p["name"] for s in snippets):
                    skipped.append(
                        {"title": item.title, "why": "A saved prompt has that name now."}
                    )
                    continue
                snippets.append({"name": p["name"], "text": p["text"]})
                entry["commands"].append({"name": p["name"], "hash": ci.fingerprint(p["text"])})
                added.append({"kind": "command", "title": item.title})
            elif (
                item.kind == "model"
                and p.get("pref") in ("code_model", "code_mode")
                and p.get("value")
            ):
                pref = p["pref"]
                if pref in pref_changes:
                    skipped.append(
                        {"title": item.title, "why": "Another default was picked in this import."}
                    )
                    continue
                before = getattr(self.hub.prefs, pref)
                pref_changes[pref] = p["value"]
                old = entry["prefs"].get(pref)
                entry["prefs"][pref] = {
                    "before": old["before"] if isinstance(old, dict) else before,
                    "after": p["value"],
                }
                added.append({"kind": "model", "title": item.title})
            elif item.kind == "chats":
                have = {c.get("id") for c in entry["chats"]}
                new = [
                    {k: c[k] for k in c if k != "project_name" or c[k]}
                    for c in p.get("chats") or []
                    if c["id"] not in have
                ]
                entry["chats"] = (entry["chats"] + new)[-ci.CHATS_PER_SOURCE :]
                added.append({"kind": "chats", "title": item.title})
        entry["at"] = ci.now()
        try:
            self.ledger.save()
        except Exception:
            log.warning("Couldn't save the import ledger", exc_info=True)
        changes: dict[str, Any] = {}
        if any(a["kind"] == "project" for a in added):
            changes["code_project_folders"] = folders
        if any(a["kind"] == "command" for a in added):
            changes["code_snippets"] = snippets
        if changes:
            self.hub.set_feature_prefs(changes)
        if pref_changes:
            self.hub.set_prefs(pref_changes)
        return {"added": added, "skipped": skipped}

    def undo(self, source_id: str) -> dict[str, Any]:
        """Take away what source_id's imports added; what the owner changed since stays."""
        entry = self.ledger.data.get(source_id)
        removed: list[dict[str, str]] = []
        kept: list[dict[str, str]] = []
        if not isinstance(entry, dict):
            return {"removed": removed, "kept": kept}
        entry = self.ledger.entry(source_id)
        changes: dict[str, Any] = {}
        ours = set(entry["projects"])
        folders = [str(p) for p in (self.hub.prefs.feature("code_project_folders") or [])]
        if ours & set(folders):
            changes["code_project_folders"] = [f for f in folders if f not in ours]
            removed += [{"kind": "project", "title": Path(f).name} for f in folders if f in ours]
        snippets = list(self.hub.prefs.feature("code_snippets") or [])
        hashes = {c.get("name"): c.get("hash") for c in entry["commands"] if isinstance(c, dict)}
        left = []
        for s in snippets:
            if s.get("name") in hashes:
                if ci.fingerprint(str(s.get("text", ""))) == hashes[s["name"]]:
                    removed.append({"kind": "command", "title": f"/{s['name']}"})
                    continue
                kept.append({"title": f"/{s['name']}", "why": "You changed it since, so it stays."})
            left.append(s)
        if len(left) != len(snippets):
            changes["code_snippets"] = left
        for name, kept_server in entry["mcp"].items():
            for var in kept_server.get("keys") or []:
                with contextlib.suppress(Exception):
                    self.hub.connectors.vault.delete(f"{ci.VAULT_PREFIX}{name}", var)
            removed.append({"kind": "mcp", "title": name})
        removed += [
            {"kind": "rules", "title": r.get("label") or Path(r["path"]).name}
            for r in entry["rules"]
        ]
        if entry["chats"]:
            removed.append({"kind": "chats", "title": f"{len(entry['chats'])} past chats"})
        pref_changes: dict[str, Any] = {}
        for pref, change in entry["prefs"].items():
            if pref not in ("code_model", "code_mode") or not isinstance(change, dict):
                continue
            if getattr(self.hub.prefs, pref) == change.get("after"):
                pref_changes[pref] = change.get("before", "" if pref == "code_model" else "ask")
                removed.append(
                    {
                        "kind": "model",
                        "title": f"{pref}: back to {pref_changes[pref] or 'the default'}",
                    }
                )
            else:
                kept.append({"title": pref, "why": "You changed it since, so it stays."})
        self.ledger.data.pop(source_id, None)
        try:
            self.ledger.save()
        except Exception:
            log.warning("Couldn't save the import ledger", exc_info=True)
        if changes:
            self.hub.set_feature_prefs(changes)
        if pref_changes:
            self.hub.set_prefs(pref_changes)
        return {"removed": removed, "kept": kept}

    # ── sessions ──

    def on(self) -> bool:
        return self.hub.prefs.feature(PREF_ON) is not False

    def _project(self, task: Any) -> str:
        try:
            return str(Path(project_of(self.hub, task)).resolve())
        except Exception:
            return str(getattr(task, "cwd", ""))

    def servers_for(self, task: Any) -> dict[str, dict[str, Any]]:
        if not self.on() or getattr(task, "kind", "") != "code":
            return {}
        here = self._project(task)
        out: dict[str, dict[str, Any]] = {}
        for name, kept in sorted(self.ledger.servers().items()):
            project = kept.get("project") or ""
            if project and str(Path(project).resolve()) != here:
                continue
            with contextlib.suppress(Exception):
                out[name] = ci.launch_spec(name, kept, self.ledger.path)
        return out

    def apply_options(self, task: Any, options: Any) -> None:
        extra = self.servers_for(task)
        if not extra:
            return
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        options.mcp_servers = {**extra, **base}  # (a server the session has already wins)

    def key(self, task: Any) -> Any:
        if getattr(task, "kind", "") != "code":
            return None
        return tuple(sorted(self.servers_for(task)))

    def turn_note(self, task: Any) -> str:
        if getattr(task, "kind", "") != "code" or task.id in self.told:
            return ""
        self.told.add(task.id)
        if not self.on():
            return ""
        here = self._project(task)
        names = {s.id: s.name for s in ci.sources()}
        parts: list[str] = []
        total = 0
        for rule in self.ledger.rules():
            project = rule.get("project") or ""
            if rule.get("scope") == "project" and str(Path(project).resolve()) != here:
                continue
            try:
                text = ci.read_text(Path(rule["path"]), 4_000_000)[: ci.RULES_CHARS].strip()
            except ci.ReadError:
                continue
            if not text or total + len(text) > ci.RULES_TOTAL:
                continue
            total += len(text)
            tool = names.get(rule["source"], rule["source"])
            parts.append(f"From {tool} ({rule.get('label') or Path(rule['path']).name}):\n{text}")
        if not parts:
            return ""
        return (
            "The owner's rules and instructions, brought over from the coding tools they used before "
            "(follow them as you would the owner's own instructions, unless this request says otherwise):\n\n"
            + "\n\n".join(parts)
            + "\n"
        )

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        if kind == "tasks":
            self.told &= set(self.hub.tasks.tasks)


class _Options:
    """What a session's connection gets from the import (TaskManager.option_hooks)."""

    def __init__(self, importer: Importer) -> None:
        self.importer = importer

    def apply(self, task: Any, options: Any) -> None:
        self.importer.apply_options(task, options)

    def key(self, task: Any) -> Any:
        return self.importer.key(task)


def install(hub: Any) -> None:
    importer = Importer(hub)
    hub.code_import = importer  # (for the tests)
    hub.tasks.option_hooks.append(_Options(importer))
    hub.tasks.turn_notes.append(importer.turn_note)
    hub.add_task_sink(importer.on_task_event)
    for kind, handler in (
        ("cimp_sources", importer.cmd_sources),
        ("cimp_preview", importer.cmd_preview),
        ("cimp_import", importer.cmd_import),
        ("cimp_undo", importer.cmd_undo),
        ("cimp_history", importer.cmd_history),
        ("cimp_chat", importer.cmd_chat),
    ):  # (each reads files, or waits on claude auth status: never holding up the window)
        hub.register_command(kind, background(hub, handler))
