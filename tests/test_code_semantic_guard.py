# ruff: noqa: F811  (the merge queue test module's fixtures, imported)
"""The semantic conflict guard (features/code_semantic_guard.py) in the merge queue: an item
whose symbols collide with another session's work (a signature changed while the other
adds calls written the old way, both changing one function, something removed that the
other still uses) is held, both sessions are told once, its card lists what collides; it
goes back in line once the collision is gone, or when the owner lands it anyway.

Real git in temp repositories, the merge queue's own test hub (test_code_merge_queue); the
project's tests are a stand-in and sessions are recorded, never run. No model is called."""

from pathlib import Path

import pytest
from test_code_changes import make_repo
from test_code_merge_queue import copy_with, events_of, hub, items, projects, queue  # noqa: F401

from jarvis.features import code_merge_queue as mq
from jarvis.features import code_semantic_guard as guard
from jarvis.tasks import ClaudeTask

CALC = "def total(items):\n    return sum(items)\n"
SHOP = "import calc\n"


@pytest.fixture
def started(hub, monkeypatch):  # noqa: F811
    """The sessions the guard (or the queue) opens again: recorded, not run."""
    out = []

    def start(prompt, directory, **kw):
        out.append((prompt, directory, kw))
        return ClaudeTask(id=60 + len(out), prompt=prompt, cwd=Path(directory))

    monkeypatch.setattr(hub.tasks, "start", start)
    return out


def two_sessions(hub, projects):  # noqa: F811
    repo = make_repo(projects / "app", {"calc.py": CALC, "shop.py": SHOP})
    sig = copy_with(
        hub, repo, "tax in totals", {"calc.py": CALC.replace("(items)", "(items, tax)")}
    )
    caller = copy_with(hub, repo, "shop prices", {"shop.py": SHOP + "\nprice = calc.total(cart)\n"})
    sig.sessions, caller.sessions = ["s-sig"], ["s-caller"]
    return repo, sig, caller


async def test_a_new_signature_against_the_other_sessions_new_calls_holds_and_tells_both(
    hub,
    projects,
    started,  # noqa: F811
):
    repo, sig, caller = two_sessions(hub, projects)
    await queue(hub, "copy", sig.slug)
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "held"
    assert (
        "the isolated copy “shop prices”" in item["note"]
        and "both sessions were told" in item["note"]
    )
    [finding] = item["guard"]
    assert finding["kind"] == "contract" and finding["symbol"] == "total"
    assert finding["text"].startswith("this one changed the signature of total in calc.py")
    assert "shop.py:3" in finding["text"]
    assert (repo / "calc.py").read_text() == CALC  # nothing landed
    # Both sessions were opened again with it, each from its own side.
    assert sorted(kw["resume"] for _p, _d, kw in started) == ["s-caller", "s-sig"]
    to_sig = next(p for p, _d, kw in started if kw["resume"] == "s-sig")
    to_caller = next(p for p, _d, kw in started if kw["resume"] == "s-caller")
    assert (
        "holding your work (“tax in totals”) before it lands: it and the isolated copy “shop prices”"
        in to_sig
    )
    assert "your work changed the signature of total" in to_sig
    assert (
        "holding the isolated copy “tax in totals” before it lands: it and your work" in to_caller
    )
    assert "and your work adds calls to it that don't fit (first at shop.py:3)" in to_caller
    assert any("merge queue" in a.text for a in hub.alerts)
    assert events_of(hub, "code_mq")[-1]["queues"][0]["items"][0]["state"] == "held"
    # Looked at again: still held, nobody told twice.
    await hub.code_mq.tick()
    assert item["state"] == "held" and len(started) == 2
    # The other session makes its call fit the new signature: it goes back in line, lands.
    (Path(caller.checkout) / "shop.py").write_text(SHOP + "\nprice = calc.total(cart, 0.2)\n")
    await hub.code_mq.tick()
    await hub.code_mq.tick()
    assert items(hub) == [] and "tax" in (repo / "calc.py").read_text()


async def test_land_anyway_and_a_new_finding_holds_it_again(hub, projects, started):  # noqa: F811
    repo, sig, caller = two_sessions(hub, projects)
    await queue(hub, "copy", sig.slug)
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "held"
    hub.code_mq.cmd_item({"id": item["id"], "action": "override"})
    assert item["state"] == "queued" and item["overridden"]
    await hub.code_mq.tick()
    await hub.code_mq.tick()
    assert items(hub) == [] and "tax" in (repo / "calc.py").read_text()


async def test_what_landed_meanwhile_counts_and_has_nobody_to_tell(hub, projects, started):  # noqa: F811
    repo, sig, caller = two_sessions(hub, projects)
    # The signature change lands from the Copies pane, outside the queue.
    assert (await hub.code_desk.land_now(sig)).startswith("Landed")
    await queue(hub, "copy", caller.slug)
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "held" and "what landed in main since it began" in item["note"]
    [finding] = item["guard"]
    assert finding["text"].startswith("what landed in main since it began changed the signature")
    assert [kw["resume"] for _p, _d, kw in started] == ["s-caller"]


async def test_both_changing_one_function_and_the_owner_setting(hub, projects, started):  # noqa: F811
    repo = make_repo(projects / "app", {"calc.py": CALC})
    a = copy_with(hub, repo, "double", {"calc.py": CALC.replace("sum(items)", "2 * sum(items)")})
    copy_with(hub, repo, "round", {"calc.py": CALC.replace("sum(items)", "round(sum(items))")})
    a.sessions = ["s-a"]
    hub.set_feature_prefs({mq.PREF_CONFLICTS: "owner"})
    await queue(hub, "copy", a.slug)
    await hub.code_mq.tick()
    [item] = items(hub)
    assert item["state"] == "held" and item["note"].endswith("over to you.")
    assert [f["kind"] for f in item["guard"]] == ["body"]
    assert started == []  # (the owner's, by the setting: nobody is messaged)


async def test_warn_tells_but_doesnt_hold_and_off_doesnt_look(hub, projects, started):  # noqa: F811
    repo, sig, caller = two_sessions(hub, projects)
    hub.set_feature_prefs({guard.PREF: "warn"})
    await queue(hub, "copy", sig.slug)
    await hub.code_mq.tick()
    await hub.code_mq.tick()
    assert items(hub) == [] and "tax" in (repo / "calc.py").read_text()
    assert len(started) == 2
    assert any("git doesn't see" in a.text for a in hub.alerts)
    hub.set_feature_prefs({guard.PREF: "off"})
    (Path(caller.checkout) / "calc.py").write_text(CALC.replace("sum(items)", "0"))
    other = copy_with(hub, repo, "zero", {"calc.py": "def total(items, tax):\n    return 1\n"})
    await queue(hub, "copy", other.slug)
    await hub.code_mq.tick()
    assert all(i["state"] != "held" for i in items(hub))


async def test_separate_work_lands_untouched_by_the_guard(hub, projects, started):  # noqa: F811
    repo = make_repo(projects / "app", {"calc.py": CALC, "shop.py": SHOP})
    a = copy_with(hub, repo, "calc", {"calc.py": CALC.replace("sum(items)", "2 * sum(items)")})
    copy_with(hub, repo, "shop", {"shop.py": SHOP + "\nname = 'shop'\n"})
    await queue(hub, "copy", a.slug)
    await hub.code_mq.tick()
    assert items(hub) == [] and "2 * sum" in (repo / "calc.py").read_text()
    assert started == []


def test_the_pref_and_its_values():
    assert guard._mode_pref("warn") == "warn" and guard._mode_pref("nope") is None
