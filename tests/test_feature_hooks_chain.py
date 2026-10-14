"""Every feature's wrapper of a hub or TaskManager hook still runs once all features are
installed (REL-3).

Features plug in by wrapping a hook (hub.tasks.prepare, turn_note, options_for,
on_rate_limit, hub.set_prefs…): each takes what was there and calls it from its own. One
that sets the hook instead (code_sessions did, `tm.turn_note = self.turn_note`) silently
throws away every wrapper installed before it, and nothing fails: Exterminator Mode's rules
simply stopped going with its messages. So this installs every feature (labs ones too), one
at a time, and for each hook a feature changes checks that the new value still holds the
one it replaced (in its closure, its defaults, or the object its bound method is of), and
that a hook list (turn_notes, option_hooks…) set anew still holds what was in it; then that
the final value of each hook still reaches every value any feature put there.

A hook whose value before was only the core's placeholder may be set outright (PLACEHOLDERS,
each with why); anything else must chain, so a future replace-instead-of-chain fails here.
"""

import gc
import types

from jarvis import features
from jarvis.features import code_bugfix
from jarvis.features.code_bugfix import BugRun
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask

# (owner, attribute): why setting it outright is fine (the core's value is a stand-in).
PLACEHOLDERS = {
    ("tasks", "citation_style"): "the core's is a fixed 'apa' until scholar says the owner's",
    ("hub", "mac_voice_for"): "the core's answers '' (no voice picked) until voice is there",
    ("hub", "talk_over"): "the core's answers False until voice's duplex is there",
    ("hub", "listener_factory"): "None, or a test's own listener (voice leaves that one)",
}


def _callables(owner):
    return {k: v for k, v in vars(owner).items() if callable(v) and not isinstance(v, type)}


def _lists(owner):
    """The hook lists features append to: the list itself and what's in it now."""
    return {k: (v, list(v)) for k, v in vars(owner).items() if isinstance(v, list)}


def _same(found, old) -> bool:
    if found is old:
        return True
    return (
        isinstance(found, types.MethodType)
        and isinstance(old, types.MethodType)
        and found.__func__ is old.__func__
        and found.__self__ is old.__self__
    )


def reaches(new, old, stop, limit=40000) -> bool:
    """Whether new holds old: through closures, defaults, partials and the objects bound
    methods are of, never through the hub or the TaskManager themselves (everything is
    reachable from those)."""
    seen = {id(x) for x in stop}
    todo = [new]
    while todo and len(seen) < limit:
        obj = todo.pop()
        if _same(obj, old):
            return True
        if id(obj) in seen or isinstance(obj, types.ModuleType | type | str | bytes | int | float):
            continue
        seen.add(id(obj))
        todo.extend(gc.get_referents(obj))
    return False


def install_traced(hub):
    """Every feature installed, as install_all does but labs ones too; per hook, the values
    features put there in order, and the replacements that don't chain."""
    owners = {"hub": hub, "tasks": hub.tasks}
    stop = [hub, hub.tasks, vars(hub), vars(hub.tasks)]
    put: dict[tuple[str, str], list] = {}
    broken = []
    for module in features.modules():
        install = getattr(module, "install", None)
        if not callable(install):
            continue
        name = module.__name__.rsplit(".", 1)[-1]
        before = {o: _callables(v) for o, v in owners.items()}
        lists = {o: _lists(v) for o, v in owners.items()}
        try:
            install(hub)
        except Exception as exc:  # (as install_all: a broken one is left out)
            broken.append((name, "didn't install", repr(exc)))
            continue
        for owner, obj in owners.items():
            for attr, value in _callables(obj).items():
                old = before[owner].get(attr)
                if old is value:
                    continue
                put.setdefault((owner, attr), []).append((name, value))
                if old is None or (owner, attr) in PLACEHOLDERS:
                    continue
                if not reaches(value, old, stop):
                    broken.append((name, f"{owner}.{attr}", "replaced without calling it"))
            for attr, (was, items) in lists[owner].items():  # (turn_notes, option_hooks…)
                now = vars(obj).get(attr)
                if now is not was and not all(any(i is n for n in now or []) for i in items):
                    broken.append((name, f"{owner}.{attr}", "replaced the list, losing some"))
    return put, broken, stop


def test_every_feature_s_wrapper_still_reaches_the_hook(
    settings, quiet_speaker, isolated, monkeypatch
):
    traced: dict = {}

    def install_all(hub):
        traced["put"], traced["broken"], traced["stop"] = install_traced(hub)
        return []

    monkeypatch.setattr(features, "install_all", install_all)
    hub = Hub(settings, speaker=quiet_speaker, poll=False, **isolated)
    assert traced["broken"] == []
    owners = {"hub": hub, "tasks": hub.tasks}
    lost = []
    for (owner, attr), values in traced["put"].items():
        final = getattr(owners[owner], attr)
        for name, value in values[:-1]:
            if (owner, attr) in PLACEHOLDERS and value is values[0][1]:
                continue
            if not reaches(final, value, traced["stop"]):
                lost.append((name, f"{owner}.{attr}"))
    assert lost == []


def test_the_tracer_catches_a_hook_set_over_another(settings, quiet_speaker, isolated, monkeypatch):
    """The check itself: a feature that sets turn_note over code_bugfix's wrapper (as
    code_sessions did) is caught."""
    real = features.modules

    def install(hub):
        hub.tasks.turn_note = lambda task: "mine"

    over = types.SimpleNamespace(__name__="jarvis.features.zz_sets_over", install=install)
    monkeypatch.setattr(features, "modules", lambda: [*real(), over])
    traced: dict = {}

    def install_all(hub):
        traced["put"], traced["broken"], _ = install_traced(hub)
        return []

    monkeypatch.setattr(features, "install_all", install_all)
    Hub(settings, speaker=quiet_speaker, poll=False, **isolated)
    assert ("zz_sets_over", "tasks.turn_note", "replaced without calling it") in traced["broken"]


async def test_exterminator_rules_go_with_its_messages(settings, quiet_speaker, isolated, tmp_path):
    """REL-3: with every feature installed, an Exterminator run's session gets its rules
    with each message (code_sessions had set turn_note over code_bugfix's wrapper)."""
    hub = Hub(settings, speaker=quiet_speaker, poll=False, **isolated)
    task = ClaudeTask(id=77, prompt="", cwd=tmp_path)
    task.kind = "code"
    hub.code_bugfix.active[77] = BugRun("r1", "calc", spend_cap=10.0)
    assert code_bugfix.NOTE in hub.tasks.notes_for(task)
    del hub.code_bugfix.active[77]
    assert code_bugfix.NOTE not in hub.tasks.notes_for(task)
