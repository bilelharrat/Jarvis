"""A past session's history (tasks._history) works out each step's words (describe_tool,
approval_detail) and its result's text for the TRANSCRIPT_KEEP entries it keeps alone, not
for the thousands of steps of a long session it lets go. What it gives is checked against
the reading as it was, kept here, entry by entry and key by key."""

import json
from pathlib import Path

from claude_agent_sdk.types import SessionMessage

from jarvis import tasks
from jarvis.tasks import (
    AGENT_TOOLS,
    EDIT_TOOLS,
    TRANSCRIPT_KEEP,
    _history_blocks,
    _history_said,
    approval_detail,
    describe_tool,
    image_count,
)

CWD = Path("/Users/someone/Projects/app")


# ── the reading as it was ──


def old_step(block, cwd):
    kind = block.get("type")
    if kind == "text":
        text = str(block.get("text") or "").strip()
        return {"role": "assistant", "text": text} if text else None
    if kind == "thinking":
        text = str(block.get("thinking") or "").strip()
        return {"role": "thinking", "text": text} if text else None
    if kind != "tool_use":
        return None
    name = str(block.get("name") or "")
    args = block.get("input") if isinstance(block.get("input"), dict) else {}
    tool_id = str(block.get("id") or "")
    if name == "TodoWrite":
        todos = [
            {"content": str(t.get("content", "")), "status": str(t.get("status", "pending")),
             "active": str(t.get("activeForm", ""))}
            for t in (args.get("todos") or [])[:30] if isinstance(t, dict)
        ]  # fmt: skip
        return {"role": "todos", "text": "", "todos": todos}
    if name == "ExitPlanMode" and str(args.get("plan") or "").strip():
        return {"role": "plan", "text": str(args["plan"]).strip()}
    if name in AGENT_TOOLS:
        return {
            "role": "tool",
            "text": f"Agent: {args.get('description', 'working')}",
            "tool": "Agent",
            "tool_id": tool_id,
            "detail": str(args.get("prompt", ""))[:4000],
            "agent": str(args.get("subagent_type", "general-purpose")),
            "status": "done",
        }
    return {
        "role": "tool",
        "text": describe_tool(name, args),
        "tool": name,
        "tool_id": tool_id,
        "detail": approval_detail(name, args, cwd)[:4000],
        "status": "done",
    }


def old_history(messages, cwd, before=""):
    entries, steps, fork_points, checkpoints, changed, edits = [], {}, {}, [], {}, {}
    last = before
    for message in messages:
        blocks = _history_blocks(message)
        if message.type == "assistant":
            for block in blocks:
                if (entry := old_step(block, cwd)) is not None:
                    entries.append(entry)
                    if entry.get("tool_id"):
                        steps[entry["tool_id"]] = entry
                args = block.get("input") if isinstance(block.get("input"), dict) else {}
                path = args.get("file_path") or args.get("notebook_path")
                if block.get("name") in EDIT_TOOLS and path and checkpoints:
                    edits[str(block.get("id") or "")] = (checkpoints[-1], str(path))
        else:
            said, images, files = [], 0, []
            for block in blocks:
                kind = block.get("type")
                if kind == "tool_result":
                    edit = edits.pop(str(block.get("tool_use_id") or ""), None)
                    if edit is not None and not block.get("is_error"):
                        changed.setdefault(edit[0], set()).add(edit[1])
                    step = steps.get(str(block.get("tool_use_id") or ""))
                    if step is not None:
                        out = block.get("content")
                        if image_count(out):
                            step["images"] = image_count(out)
                        if isinstance(out, list):
                            out = "\n".join(
                                str(c.get("text", "")) for c in out if isinstance(c, dict)
                            )
                        step["status"] = "failed" if block.get("is_error") else "done"
                        step["output"] = str(out or "")[:2000]
                elif kind == "text":
                    said.append(str(block.get("text") or ""))
                elif kind == "image":
                    images += 1
                elif kind == "document":
                    files.append(str(block.get("title") or "file")[:120])
            role, text = _history_said("\n\n".join(said)) if said else ("user", "")
            if role == "user" and (text or images or files):
                entry = {"role": "user", "text": text, "images": images}
                if files:
                    entry["files"] = files
                if message.uuid:
                    entry["uuid"] = message.uuid
                    fork_points[message.uuid] = last
                    checkpoints.append(message.uuid)
                entries.append(entry)
            elif role != "user" and text:
                entries.append({"role": role, "text": text})
        last = message.uuid or last
    kept = entries[-TRANSCRIPT_KEEP:]
    for entry in kept:
        entry["text"] = entry["text"][:8000]
        entry["past"] = True
    shown = {e["uuid"] for e in kept if e.get("uuid")}
    return {
        "entries": kept,
        "fork_points": {u: p for u, p in fork_points.items() if u in shown},
        "last_uuid": last,
        "checkpoints": checkpoints[-50:],
        "checkpoint_files": changed,
    }


# ── a long session of every kind of step ──


def _user(uuid, content):
    return SessionMessage(type="user", uuid=uuid, session_id="s",
                          message={"role": "user", "content": content})  # fmt: skip


def _assistant(uuid, *blocks):
    return SessionMessage(type="assistant", uuid=uuid, session_id="s",
                          message={"role": "assistant", "content": list(blocks)})  # fmt: skip


# Each kind of step (its tool and input), by its number.
STEPS = [
    lambda n: ("Bash", {"command": f"pytest -q tests/test_{n}.py " + "x" * (n % 90)}),
    lambda n: ("Read", {"file_path": f"{CWD}/src/mod{n}.py"}),
    lambda n: ("Edit", {"file_path": f"{CWD}/src/mod{n}.py", "old_string": "a\nb\n" * 5,
                        "new_string": "c\nd\n" * 5}),
    lambda n: ("MultiEdit", {"file_path": f"/elsewhere/m{n}.py",
                             "edits": [{"old_string": "x", "new_string": "y"}] * 4}),
    lambda n: ("Write", {"file_path": f"{CWD}/new{n}.py", "content": "line\n" * 30}),
    lambda n: ("Grep", {"pattern": f"def f{n}", "path": f"{CWD}/src"}),
    lambda n: ("WebFetch", {"url": f"https://example.com/{n}", "prompt": "sum it up" * 50}),
    lambda n: ("Agent", {"description": f"look {n}", "prompt": "p" * 5000,
                         "subagent_type": "Explore"}),
    lambda n: ("TodoWrite", {"todos": [{"content": "a", "status": "completed"},
                                       {"content": "b", "activeForm": "doing b"}]}),
    lambda n: ("mcp__browser__click", {"ref": f"r{n}", "why": "\u00fcn\u00efcode \u2713"}),
    lambda n: ("ExitPlanMode", {"plan": f"1. do {n}\n2. test"}),
    lambda n: ("Bash", {"command": "echo " + "long " * (200 + n % 1000)}),  # (cut at 4000)
    lambda n: ("Glob", {"pattern": "**/*.py"}),
]  # fmt: skip


def conversation(turns: int) -> list[SessionMessage]:
    picture = {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                           "data": "iVBORw0KGgo="}}  # fmt: skip
    out: list[SessionMessage] = []
    n = 0
    for turn in range(turns):
        if turn % 7 == 3:
            content = [picture, {"type": "document", "title": "notes.txt"},
                       {"type": "text", "text": f"look at this {turn}"}]  # fmt: skip
        elif turn % 7 == 5:
            content = "<command-name>/review</command-name><command-args>hub.py</command-args>"
        else:
            content = f"[Note from the app: a goal]\n\nplease do thing {turn}" + "!" * (turn % 3)
        out.append(_user(f"u{turn}", content))
        for step in range(12):
            n += 1
            tid = f"t{n}"
            name, args = STEPS[(turn + step) % len(STEPS)](n)
            block = {"type": "tool_use", "id": tid, "name": name, "input": args}
            said = [{"type": "thinking", "thinking": f"hmm {n}"}] if step % 5 == 0 else []
            out.append(_assistant(f"a{n}", *said, {"type": "text", "text": f"step {n}"}, block))
            if name == "Glob":
                continue  # (a step whose result never came)
            if step % 4 == 0:
                result = [{"type": "text", "text": "ok " * 900}, picture,
                          {"type": "text", "text": "tail"}]  # fmt: skip
            elif step % 4 == 1:
                result = "plain " * 600
            elif step % 4 == 2:
                result = None
            else:
                result = {"odd": "shape"}
            error = step % 9 == 4
            out.append(_user(f"r{n}", [{"type": "tool_result", "tool_use_id": tid,
                                        "content": result, "is_error": error}]))  # fmt: skip
            if step == 6:  # the same result twice: the later one stands
                out.append(_user(f"r{n}b", [{"type": "tool_result", "tool_use_id": tid,
                                             "content": "again"}]))  # fmt: skip
        out.append(_assistant(f"z{turn}", {"type": "text", "text": f"Done {turn}. " * 400}))
    return out


def as_json(found):
    return json.dumps(found, default=sorted, ensure_ascii=False)  # (its sets, in order)


def test_a_long_history_reads_as_before_key_for_key():
    messages = conversation(120)
    assert sum(len(_history_blocks(m)) for m in messages) > 10 * TRANSCRIPT_KEEP
    new, old = tasks._history(messages, CWD), old_history(messages, CWD)
    assert new == old
    assert as_json(new) == as_json(old)  # (the same keys in the same order, too)
    assert len(new["entries"]) == TRANSCRIPT_KEEP


def test_short_histories_and_a_tail_read_as_before():
    messages = conversation(120)
    for upto in (0, 1, 2, 5, 13, 40, 90):
        part = messages[: upto * 26]
        assert as_json(tasks._history(part, CWD)) == as_json(old_history(part, CWD)), upto
    tail = messages[-900:]
    before = tail[0].uuid
    new, old = tasks._history(tail[1:], CWD, before), old_history(tail[1:], CWD, before)
    assert as_json(new) == as_json(old)


def test_only_the_kept_steps_are_described(monkeypatch):
    messages = conversation(120)
    described: list[str] = []
    real = tasks.describe_tool

    def counting(name, tool_input):
        described.append(name)
        return real(name, tool_input)

    monkeypatch.setattr(tasks, "describe_tool", counting)
    found = tasks._history(messages, CWD)
    steps = sum(1 for m in messages for b in _history_blocks(m) if b.get("type") == "tool_use")
    assert steps > 1000
    kept_steps = [e for e in found["entries"] if e.get("tool") not in (None, "Agent")]
    assert len(described) == len(kept_steps) < TRANSCRIPT_KEEP


def test_an_odd_step_long_gone_no_longer_stops_the_history():
    """A step whose input no tool takes (a number for a command), among the steps let go,
    was described all the same and stopped the whole history; it's let go unread now. The
    entries kept are the same as for a history without it."""
    messages = conversation(60)
    odd = _assistant("odd", {"type": "tool_use", "id": "odd", "name": "Bash",
                             "input": {"command": 5}})  # fmt: skip
    found = tasks._history([messages[0], odd, *messages[1:]], CWD)
    assert as_json(found["entries"]) == as_json(tasks._history(messages, CWD)["entries"])
