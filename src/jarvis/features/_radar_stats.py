"""The engine radar's numbers (features.code_radar, and the weekly ledger in code_ledger):
the radar's log folded into turns with what happened to them later, each turn's metrics
for a group of turns, and the tests that say whether a shift after an engine or model
update is more than noise. Pure functions: no files, no clock, no hub, so a test can feed
them anything and the pane and the ledger read the same answers.

What a turn is (one line of the radar's log, kind "turn", written as Claude Code's turn
ends): its project (a hash), the engine (Claude Code's version) and the model it ran on,
how many files it read (Read), looked through (Grep, Glob, LS) and edited (Edit, Write,
MultiEdit, NotebookEdit), how many of those edits came with no read of that file first
("blind"; a Write that makes a new file is a create, not blind), the files it changed,
whether its last test run passed, whether the owner stopped it, and what Claude Code says
it cost. Later lines (kind "outcome") say what became of it: rewound, reverted (Undo, a
file's Revert, a hunk's Undo), or, for an isolated copy, landed or discarded.

A change is a turn that changed files. It landed when nothing took it back: not reverted,
not rewound with its files, not in a copy that was discarded. That is the honest reading
the log allows: a change kept in the folder counts as landed even if the owner rewrote it
by hand later (Eden can't see that), so the ledger says "kept", not "shipped".

The tests:
- shares (edits without a read, interruptions, rewinds, reverts, tests passed): the
  two-proportion z-test, two-sided;
- reads per edit and per-turn cost: the Mann-Whitney U test (normal approximation, ties
  corrected), two-sided, since both are skewed;
- the seven p-values of one comparison are corrected together (Holm), and a shift counts
  only below ALPHA, with MIN_TURNS turns on each side (MIN_EVENTS for a share's own
  denominator) and a change big enough to matter (MIN_SHARE_POINTS and MIN_RELATIVE).
  ALPHA is strict because the radar looks again after every few turns: each look is
  another chance for noise to pass.

Cost policy: nothing here calls a model. It's arithmetic on the owner's own records.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

ALPHA = 0.01  # after Holm across one comparison's metrics
MIN_TURNS = 25  # turns on each side of a change before it's compared
MIN_EVENTS = 15  # a share's denominator on each side (edits, test runs, changes)
MIN_SHARE_POINTS = 0.05  # a share must move this much (5 points) ...
MIN_RELATIVE = 0.2  # ... and a share or a mean by this much of its old value
SIDE_TURNS = 400  # the newest turns of each side compared
OUTCOMES = ("rewound", "reverted", "landed", "discarded")

_DATE = re.compile(r"-\d{8}$")
_NUMBER = re.compile(r"^v?\d+(?:\.\d+)*$")
_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    worse: int  # +1: higher is worse; -1: lower is worse
    kind: str  # share | mean | cost


METRICS = (
    Metric("read_ratio", "Reads per edit", -1, "mean"),
    Metric("blind_edits", "Edits without a read first", 1, "share"),
    Metric("interrupts", "Turns you stopped", 1, "share"),
    Metric("rewinds", "Turns rewound", 1, "share"),
    Metric("reverts", "Changes reverted", 1, "share"),
    Metric("tests", "Test runs that passed", -1, "share"),
    Metric("cost", "Cost per landed change", 1, "cost"),
)
BY_KEY = {m.key: m for m in METRICS}


# ── reading the log ──


def _int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return 0
    return max(0, int(value))


def _cost(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return max(0.0, float(value))


def family(model: str) -> str:
    """A model's family, its version numbers taken out: claude-opus-4-7 and claude-opus-5-5
    are both claude-opus, so moving from one to the other is a model update, while Opus to
    Sonnet is a different model, compared on its own."""
    name = str(model or "").strip().lower().split("[", 1)[0]
    name = _DATE.sub("", name.rsplit("/", 1)[-1])
    parts = [p for p in re.split(r"[-_]", name) if p and not _NUMBER.match(p)]
    return "-".join(parts) or name or "?"


def version_key(version: str) -> tuple[int, int, int]:
    """2.1.294 as (2, 1, 294), for ordering; (0, 0, 0) for what isn't a version."""
    found = _VERSION.match(str(version or "").strip())
    return tuple(int(x) for x in found.groups()) if found else (0, 0, 0)  # type: ignore[return-value]


def fold(records: Iterable[dict[str, Any]], epoch_of: Any) -> list[dict[str, Any]]:
    """The log's turns, oldest first, each with what happened to it later (its outcome
    lines folded in). epoch_of reads the log's timestamps (features._router_log)."""
    turns: dict[str, dict[str, Any]] = {}
    for record in records:
        kind = record.get("kind")
        key = record.get("turn")
        if not isinstance(key, str) or not key:
            continue
        if kind == "turn":
            at = epoch_of(record.get("ts"))
            if at is None:
                continue
            tests = record.get("tests")
            turns[key] = {
                "turn": key,
                "ts": at,
                "session": str(record.get("session") or ""),
                "project": str(record.get("project") or ""),
                "engine": str(record.get("engine") or "") or "?",
                "model": str(record.get("model") or "") or "?",
                "family": family(str(record.get("model") or "")),
                "pinned": record.get("pinned") is True,
                "reads": _int(record.get("reads")),
                "looks": _int(record.get("looks")),
                "edits": _int(record.get("edits")),
                "blind": _int(record.get("blind")),
                "creates": _int(record.get("creates")),
                "files": _int(record.get("files")),
                "tests": tests if isinstance(tests, bool) else None,
                "interrupted": record.get("interrupted") is True,
                "error": record.get("error") is True,
                "cost": _cost(record.get("cost")),
                "seconds": _int(record.get("seconds")),
                "rewound": False,
                "rewound_files": False,
                "reverted": False,
                "copy": None,
            }
        elif kind == "outcome" and key in turns:
            turn = turns[key]
            what = record.get("what")
            if what == "rewound":
                turn["rewound"] = True
                turn["rewound_files"] = turn["rewound_files"] or record.get("files") is True
            elif what == "reverted":
                turn["reverted"] = True
            elif what in ("landed", "discarded") and turn["copy"] is None:
                turn["copy"] = what
    return sorted(turns.values(), key=lambda t: t["ts"])


def is_change(turn: dict[str, Any]) -> bool:
    return turn["files"] > 0


def is_landed(turn: dict[str, Any]) -> bool:
    """A change nothing took back (see the module's note on what "landed" can mean)."""
    return (
        is_change(turn)
        and not turn["reverted"]
        and not turn["rewound_files"]
        and turn["copy"] != "discarded"
    )


# ── the metrics ──


def share_counts(key: str, turns: list[dict[str, Any]]) -> tuple[int, int]:
    """(hits, out of) for a share metric."""
    if key == "blind_edits":
        return sum(t["blind"] for t in turns), sum(max(0, t["edits"] - t["creates"]) for t in turns)
    if key == "interrupts":
        live = [t for t in turns if not t["error"]]
        return sum(t["interrupted"] for t in live), len(live)
    if key == "rewinds":
        return sum(t["rewound"] for t in turns), len(turns)
    if key == "reverts":
        changes = [t for t in turns if is_change(t)]
        return sum(t["reverted"] for t in changes), len(changes)
    if key == "tests":
        ran = [t for t in turns if t["tests"] is not None]
        return sum(t["tests"] is True for t in ran), len(ran)
    raise KeyError(key)


def samples(key: str, turns: list[dict[str, Any]]) -> list[float]:
    """Per-turn values for a mean or cost metric (what Mann-Whitney compares)."""
    if key == "read_ratio":
        return [t["reads"] / t["edits"] for t in turns if t["edits"] > 0]
    if key == "cost":
        return [t["cost"] for t in turns if t["cost"] is not None]
    raise KeyError(key)


def value(key: str, turns: list[dict[str, Any]]) -> tuple[float | None, int]:
    """(the metric's value for these turns, how many it rests on). Reads per edit is the
    ratio of the sums; cost per landed change is all the turns' cost over the changes that
    landed (None with none landed)."""
    metric = BY_KEY[key]
    if metric.kind == "share":
        hits, n = share_counts(key, turns)
        return (hits / n if n else None), n
    if key == "read_ratio":
        edits = sum(t["edits"] for t in turns)
        return (sum(t["reads"] for t in turns) / edits if edits else None), edits
    priced = [t for t in turns if t["cost"] is not None]
    landed = sum(1 for t in turns if is_landed(t))
    if not priced or not landed:
        return None, landed
    return sum(t["cost"] for t in priced) / landed, landed


def summary(turns: list[dict[str, Any]]) -> dict[str, Any]:
    """Every metric's value for these turns, with the counts behind them."""
    out: dict[str, Any] = {"turns": len(turns)}
    for metric in METRICS:
        v, n = value(metric.key, turns)
        out[metric.key] = None if v is None else round(v, 4)
        out[f"{metric.key}_n"] = n
    out["changes"] = sum(1 for t in turns if is_change(t))
    out["landed"] = sum(1 for t in turns if is_landed(t))
    return out


# ── the tests ──


def normal_sf(z: float) -> float:
    """P(Z > z) for a standard normal."""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


def two_proportions(x1: int, n1: int, x2: int, n2: int) -> float:
    """Two-sided p-value of the pooled two-proportion z-test (1.0 when it can't say)."""
    if n1 <= 0 or n2 <= 0:
        return 1.0
    pooled = (x1 + x2) / (n1 + n2)
    var = pooled * (1 - pooled) * (1 / n1 + 1 / n2)
    if var <= 0:
        return 1.0
    z = abs(x1 / n1 - x2 / n2) / math.sqrt(var)
    return min(1.0, 2 * normal_sf(z))


def mann_whitney(a: list[float], b: list[float]) -> float:
    """Two-sided p-value of the Mann-Whitney U test, normal approximation with the tie
    correction and a continuity correction (1.0 when it can't say)."""
    n1, n2 = len(a), len(b)
    if n1 == 0 or n2 == 0:
        return 1.0
    pooled = sorted([(x, 0) for x in a] + [(x, 1) for x in b])
    ranks = [0.0] * len(pooled)
    ties = 0.0
    i = 0
    while i < len(pooled):
        j = i
        while j + 1 < len(pooled) and pooled[j + 1][0] == pooled[i][0]:
            j += 1
        rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[k] = rank
        t = j - i + 1
        ties += t**3 - t
        i = j + 1
    r1 = sum(r for r, (_, side) in zip(ranks, pooled, strict=True) if side == 0)
    u1 = r1 - n1 * (n1 + 1) / 2
    mean = n1 * n2 / 2
    n = n1 + n2
    var = n1 * n2 / 12 * ((n + 1) - ties / (n * (n - 1))) if n > 1 else 0.0
    if var <= 0:
        return 1.0
    z = max(0.0, abs(u1 - mean) - 0.5) / math.sqrt(var)
    return min(1.0, 2 * normal_sf(z))


def holm(pvalues: dict[str, float]) -> dict[str, float]:
    """Holm-Bonferroni adjusted p-values (monotone, capped at 1)."""
    order = sorted(pvalues, key=lambda k: pvalues[k])
    m = len(order)
    out: dict[str, float] = {}
    running = 0.0
    for i, key in enumerate(order):
        running = max(running, min(1.0, (m - i) * pvalues[key]))
        out[key] = running
    return out


def compare(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each metric before and after a change: the values, the counts, the p-value (Holm
    adjusted), and whether it's a real shift and for the worse."""
    rows: list[dict[str, Any]] = []
    raw: dict[str, float] = {}
    for metric in METRICS:
        old, n_old = value(metric.key, before)
        new, n_new = value(metric.key, after)
        if metric.kind == "share":
            x1, d1 = share_counts(metric.key, before)
            x2, d2 = share_counts(metric.key, after)
            enough = d1 >= MIN_EVENTS and d2 >= MIN_EVENTS
            p = two_proportions(x1, d1, x2, d2) if enough else 1.0
        else:
            s1, s2 = samples(metric.key, before), samples(metric.key, after)
            enough = len(s1) >= MIN_EVENTS and len(s2) >= MIN_EVENTS
            p = mann_whitney(s1, s2) if enough else 1.0
        raw[metric.key] = p
        rows.append(
            {
                "metric": metric.key,
                "label": metric.label,
                "kind": metric.kind,
                "before": None if old is None else round(old, 4),
                "after": None if new is None else round(new, 4),
                "n_before": n_old,
                "n_after": n_new,
                "enough": enough,
            }
        )
    adjusted = holm(raw)
    for row in rows:
        metric = BY_KEY[row["metric"]]
        row["p"] = round(adjusted[metric.key], 6)
        old, new = row["before"], row["after"]
        moved = old is not None and new is not None and new != old
        big = False
        if moved:
            rel = abs(new - old) / abs(old) if old else math.inf
            big = rel >= MIN_RELATIVE and (
                metric.kind != "share" or abs(new - old) >= MIN_SHARE_POINTS
            )
        row["significant"] = bool(row["enough"] and moved and big and row["p"] < ALPHA)
        row["worse"] = bool(moved and (new - old) * metric.worse > 0)
    return rows


# ── changes of engine or model, per scope ──


def _side(turns: list[dict[str, Any]], engine: str, model: str) -> list[dict[str, Any]]:
    return [t for t in turns if t["engine"] == engine and t["model"] == model][-SIDE_TURNS:]


def changes(turns: list[dict[str, Any]], scope: str = "") -> list[dict[str, Any]]:
    """For each model family in a scope (a project's hash, or "" for all projects): the
    newest engine-and-model pair (by when it was first seen) against the one before it,
    with each metric compared. A pair with too few turns yet is "collecting"; a worse
    significant shift makes it "shift"; else "steady"."""
    mine = [t for t in turns if not scope or t["project"] == scope]
    out: list[dict[str, Any]] = []
    for fam in sorted({t["family"] for t in mine}):
        series = [t for t in mine if t["family"] == fam]
        first: dict[tuple[str, str], float] = {}
        for t in series:
            first.setdefault((t["engine"], t["model"]), t["ts"])
        pairs = sorted(first, key=lambda k: first[k])
        if len(pairs) < 2:
            continue
        (e1, m1), (e2, m2) = pairs[-2], pairs[-1]
        before, after = _side(series, e1, m1), _side(series, e2, m2)
        what = "both" if e1 != e2 and m1 != m2 else ("engine" if e1 != e2 else "model")
        item: dict[str, Any] = {
            "scope": scope,
            "family": fam,
            "change": what,
            "before": {"engine": e1, "model": m1, "turns": len(before), "since": first[(e1, m1)]},
            "after": {"engine": e2, "model": m2, "turns": len(after), "since": first[(e2, m2)]},
        }
        if len(before) < MIN_TURNS or len(after) < MIN_TURNS:
            item["status"] = "collecting"
            item["rows"] = []
        else:
            rows = compare(before, after)
            item["rows"] = rows
            item["status"] = (
                "shift" if any(r["significant"] and r["worse"] for r in rows) else "steady"
            )
        out.append(item)
    return out


def breakdown(
    turns: list[dict[str, Any]], scope: str = "", limit: int = 12
) -> list[dict[str, Any]]:
    """The scope's turns by engine and model, newest first: each pair's metrics."""
    mine = [t for t in turns if not scope or t["project"] == scope]
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for t in mine:
        groups.setdefault((t["engine"], t["model"]), []).append(t)
    rows = []
    for (engine, model), group in groups.items():
        row = {"engine": engine, "model": model, "since": group[0]["ts"], "last": group[-1]["ts"]}
        row.update(summary(group))
        rows.append(row)
    rows.sort(key=lambda r: r["last"], reverse=True)
    return rows[:limit]
