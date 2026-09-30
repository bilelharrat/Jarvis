"""Feature modules: every module in this package that defines install(hub) is installed when
the hub is made, in name order.

A feature registers what it adds through the hub instead of editing its core tables:

- hub.register_server(name, build, prompt=..., labels=..., quiet=..., web=...): an in-process
  tool server for JARVIS's brain (allowed like the other feature servers; each tool that
  changes something asks the user itself). quiet and web name tools whose results are
  JARVIS's own words or public facts ("none") or pages anyone can write ("web"); every other
  tool's result counts as the user's private data, which the turn gate weighs.
- hub.register_command(kind, handler): a window command ({"type": kind, ...}). A handler
  that returns False passes the message on (to the next feature's, then the built-in
  command of that kind), so a feature can take only some of a core command's messages.
- hub.register_instant(handler): words the user says or types to JARVIS, answered at once
  without Claude (the reply, or None when they aren't the feature's).
- hub.register_loop(name, factory): a background loop, started with the others (never in
  tests, where poll is off).
- hub.add_notify_sink(sink) / hub.add_approval_sink(sink, resolved=...): hear every heads-up
  shown, and every approval card put up and taken down (a phone or chat can then answer
  it through hub.resolve).
- hub.add_task_sink(sink): hear every Jarvis Code and research event (kind, data).
- hub.add_turn_sink(sink): hear each request JARVIS finished ({rid, request, own, steps:
  the tools it ran, reply}).
- hub.add_briefing_note(note): a line of facts for the morning briefing's request.
- hub.voicecode.hooks: words said while voice coding, heard before its own commands.
- hub.tasks.session_extras: add to a Jarvis Code session's options (tool servers, allowed
  tools) as they're made.
- hub.add_notify_gate(gate): hold heads-ups back; one the gate returns False for doesn't
  show at all (the menu bar's "Pause heads-ups for an hour").
- hub.add_quiet_check(check): a say on quiet hours: check(now) gives True (quiet: a Focus
  mode is on), False (not, whatever the range in Settings says) or None. hub.quiet_now()
  is the answer everywhere quiet hours count; code that has only the hub uses
  proactive.quiet_hours_now(hub, now, in_quiet_hours).
- hub.feature_path(name): where the feature keeps its files, beside prefs.json (a temp folder
  in tests, never the user's real data there).
- hub.register_route(path, endpoint, methods): an address of the feature's own on the window's
  server, under /f/<feature>/ by convention (no token check: the route decides what it serves).
- prefs.register_feature_pref(key, default, clean): a setting kept in prefs.features; read
  it with hub.prefs.feature(key), change it from the window with {"type": "feature_prefs",
  "changes": {key: value}}.

Its window side lives in web/features/<name>.js and .css (loaded by web/features.js after
app.js) and its Chinese strings in web/i18n/<name>.json (merged into i18n-zh.json); the
sentences its backend says or shows are registered with lang.add_texts. A feature that
fails to import or install is logged and left out; the rest still load.

install(hub) runs for every Hub, the tests' ones included: it only registers. No threads,
network or files until a loop runs or a command arrives.

A module may also define prepare(folder): run once in the backend itself, before the hub is
made (server.serve, holding the data folder), for work that must come before any store has
read its file, such as putting a restored backup in place.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from pathlib import Path
from types import ModuleType
from typing import Any

log = logging.getLogger(__name__)


def modules() -> list[ModuleType]:
    """This package's feature modules, imported, in name order (a broken one is skipped)."""
    found: list[ModuleType] = []
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda i: i.name):
        if info.name.startswith("_"):
            continue
        try:
            found.append(importlib.import_module(f"{__name__}.{info.name}"))
        except Exception:
            log.exception("feature %s didn't load", info.name)
    return found


def install_all(hub: Any) -> list[str]:
    """Install every feature on this hub; the names of those that installed."""
    installed: list[str] = []
    for module in modules():
        install = getattr(module, "install", None)
        if not callable(install):
            continue
        name = module.__name__.rsplit(".", 1)[-1]
        try:
            install(hub)
        except Exception:
            log.exception("feature %s didn't install", name)
            continue
        installed.append(name)
    return installed


def prepare_all(folder: Path) -> list[str]:
    """Each feature module's prepare(folder), before the hub is made; the names of those
    that ran. One that fails is logged and the rest carry on: the app starts either way."""
    ran: list[str] = []
    for module in modules():
        prepare = getattr(module, "prepare", None)
        if not callable(prepare):
            continue
        name = module.__name__.rsplit(".", 1)[-1]
        try:
            prepare(folder)
        except Exception:
            log.exception("feature %s didn't prepare", name)
            continue
        ran.append(name)
    return ran
