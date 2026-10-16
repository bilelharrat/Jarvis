"""Eden Code's honest productivity ledger: a week-by-week account of what the owner's own
sessions did, from Eden's own records, weeks where AI cost more than it saved included.
The pane is web/features/code-ledger.js (from the More menu, the Usage pane and /ledger);
it can be exported as a spreadsheet (CSV) or a Markdown page into ~/Documents/Jarvis/Eden
Code.

Each week (Monday to Sunday, local time), from the engine radar's log (features.code_radar,
read with features._radar_stats):
- turns, and the changes among them (turns that changed files): landed (nothing took them
  back), reverted (Undo, a file's Revert, a hunk's Undo), rewound with their files, and
  discarded with an isolated copy;
- review minutes: time with a review pane open (the Changes pane, a pull request, the
  reviews, Best of N), as the window measured it;
- cost: what Claude Code says the week's turns cost (its own estimate: on a Claude plan
  that's the API price of what ran, not a bill), per landed change, and the part spent on
  changes that were taken back;
- the Model Router (its own log, features.code_router_events, when it routed anything that
  week): what the routed messages cost, and what its alternative would have cost by its own
  estimates: the router's pick for a message sent in Shadow mode (the router moved
  nothing), the best-quality option for one it routed.

Whether a week paid off can only be weighed with the owner's own numbers: their hourly rate
(code_ledger_rate) and the minutes a landed change saves them (code_ledger_minutes), both
unset (0) by default, set in Eden Code settings or the pane. With both: value = landed
changes x minutes x rate; net = value - cost - review time x rate; a week with net below
zero cost more than it saved, and says so. Without them the ledger never guesses: it says
when more was taken back than kept, and otherwise asks for the numbers.

Window commands: cw_ledger {weeks?} -> cw_ledger {weeks, totals, rate, minutes, router,
on}; cw_ledger_export {format: "csv" | "md"} -> cw_ledger_export {ok, path, name} or
{error} (shown in Finder with code_export's cw_export_reveal).

Cost policy (Claude): nothing here calls a model. It adds up the owner's own records.
"""

from __future__ import annotations

import asyncio
import csv
import io
import itertools
import logging
import math
from collections.abc import Iterable
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from .. import lang, tasks
from ..prefs import register_feature_pref
from . import _radar_stats as stats
from ._router_log import epoch_of

log = logging.getLogger("jarvis")

PREF_RATE = "code_ledger_rate"
PREF_MINUTES = "code_ledger_minutes"
WEEKS_DEFAULT = 12
WEEKS_MAX = 53
RATE_MAX = 10_000.0
MINUTES_MAX = 600.0

VERDICTS = {
    "paid_off": "Paid off",
    "cost_more": "Cost more than it saved",
    "mostly_undone": "More taken back than kept",
    "no_changes": "No changes",
    "unweighed": "Set your rate to weigh it",
}

ZH = {
    "Paid off": "划算",
    "Cost more than it saved": "花的比省的多",
    "More taken back than kept": "撤回的比留下的多",
    "No changes": "没有改动",
    "Set your rate to weigh it": "设好你的时薪才能衡量",
    "There's nothing to export yet.": "还没有可以导出的内容。",
    "Couldn't save the ledger: {error}": "没能保存账本：{error}",
    "Eden Code productivity ledger": "Eden Code 生产力账本",
}
lang.add_texts(ZH)


def _clean_number(top: float) -> Any:
    def clean(value: Any) -> float | None:
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
        ):
            return None
        return round(max(0.0, min(top, float(value))), 2)

    return clean


register_feature_pref(PREF_RATE, 0.0, _clean_number(RATE_MAX))
register_feature_pref(PREF_MINUTES, 0.0, _clean_number(MINUTES_MAX))


def week_of(at: float) -> date:
    """The Monday (local time) of the week an epoch second falls in."""
    day = datetime.fromtimestamp(at).date()
    return day - timedelta(days=day.weekday())


def _usd(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _router_weeks(records: Iterable[dict[str, Any]], since: float) -> dict[date, dict[str, Any]]:
    """The Model Router's routed messages by week: how many, what they cost (the API price,
    else the dollars), and what its alternative would have cost by its estimates."""
    routes: dict[str, dict[str, Any]] = {}
    actual: dict[str, dict[str, Any]] = {}
    for record in records:
        msg = str(record.get("msg") or "")
        if not msg:
            continue
        if record.get("kind") is None:
            routes[msg] = record
        elif record.get("kind") == "update" and isinstance(record.get("actual"), dict):
            actual[msg] = record["actual"]  # (cumulative: the latest is the whole)
    out: dict[date, dict[str, Any]] = {}
    for msg, route in routes.items():
        at = epoch_of(route.get("ts"))
        used = actual.get(msg)
        if at is None or at < since or used is None:
            continue
        cost = _usd(used.get("notionalUSD"))
        cost = cost if cost is not None else _usd(used.get("costUSD"))
        if cost is None:
            continue
        settings = route.get("settings") or {}
        shadow = settings.get("shadow") is True
        option = (route.get("pick") if shadow else route.get("best")) or {}
        alt = _usd(option.get("costUSD"))
        row = out.setdefault(
            week_of(at), {"routed": 0, "routed_usd": 0.0, "alternative_usd": 0.0, "priced": 0}
        )
        row["routed"] += 1
        row["routed_usd"] += cost
        if alt is not None:
            row["alternative_usd"] += alt
            row["priced"] += 1
    return out


def weekly(
    radar: Iterable[dict[str, Any]],
    router: Iterable[dict[str, Any]],
    now: float,
    weeks: int = WEEKS_DEFAULT,
    rate: float = 0.0,
    minutes: float = 0.0,
) -> dict[str, Any]:
    """The ledger: one row per week with anything in it (newest first), and the totals."""
    weeks = max(1, min(WEEKS_MAX, int(weeks)))
    first = week_of(now) - timedelta(weeks=weeks - 1)
    since = datetime.combine(first, datetime.min.time()).timestamp()
    radar = list(radar)
    turns = [t for t in stats.fold(radar, epoch_of) if t["ts"] >= since]
    reviews: dict[date, float] = {}
    for record in radar:
        if record.get("kind") != "review":
            continue
        at = epoch_of(record.get("ts"))
        seconds = record.get("seconds")
        if (
            at is None
            or at < since
            or not isinstance(seconds, int | float)
            or isinstance(seconds, bool)
        ):
            continue
        reviews[week_of(at)] = reviews.get(week_of(at), 0.0) + max(0.0, float(seconds))
    by_week: dict[date, list[dict[str, Any]]] = {}
    for t in turns:
        by_week.setdefault(week_of(t["ts"]), []).append(t)
    routed = _router_weeks(router, since)
    rows = []
    for week in sorted(set(by_week) | set(reviews) | set(routed), reverse=True):
        rows.append(
            _row(
                week, by_week.get(week, []), reviews.get(week, 0.0), routed.get(week), rate, minutes
            )
        )
    totals = _row(None, turns, sum(reviews.values()), _sum_router(routed.values()), rate, minutes)
    return {
        "weeks": rows,
        "totals": totals,
        "rate": rate,
        "minutes": minutes,
        "since": first.isoformat(),
    }


def _sum_router(rows: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    rows = list(rows)
    if not rows:
        return None
    return {
        k: sum(r[k] for r in rows) for k in ("routed", "routed_usd", "alternative_usd", "priced")
    }


def _row(
    week: date | None,
    turns: list[dict[str, Any]],
    review_seconds: float,
    router: dict[str, Any] | None,
    rate: float,
    minutes: float,
) -> dict[str, Any]:
    changes = [t for t in turns if stats.is_change(t)]
    landed = [t for t in changes if stats.is_landed(t)]
    undone = [t for t in changes if not stats.is_landed(t)]
    cost = sum(t["cost"] or 0.0 for t in turns)
    priced = any(t["cost"] is not None for t in turns)
    wasted = sum(t["cost"] or 0.0 for t in undone)
    review_minutes = review_seconds / 60
    row: dict[str, Any] = {
        "week": week.isoformat() if week else "",
        "turns": len(turns),
        "changes": len(changes),
        "landed": len(landed),
        "reverted": sum(1 for t in changes if t["reverted"]),
        "rewound": sum(1 for t in changes if t["rewound_files"] and not t["reverted"]),
        "discarded": sum(
            1
            for t in changes
            if t["copy"] == "discarded" and not t["reverted"] and not t["rewound_files"]
        ),
        "undone": len(undone),
        "review_minutes": round(review_minutes, 1),
        "cost_usd": round(cost, 4) if priced else None,
        "cost_per_landed": round(cost / len(landed), 4) if priced and landed else None,
        "wasted_usd": round(wasted, 4) if priced else None,
        "routed": router["routed"] if router else 0,
        "routed_usd": round(router["routed_usd"], 4) if router else None,
        "alternative_usd": round(router["alternative_usd"], 4)
        if router and router["priced"]
        else None,
        "value_usd": None,
        "net_usd": None,
    }
    if rate > 0 and minutes > 0:
        value = len(landed) * minutes / 60 * rate
        net = value - cost - review_minutes / 60 * rate
        row["value_usd"], row["net_usd"] = round(value, 2), round(net, 2)
        verdict = (
            "no_changes"
            if not turns and not review_seconds
            else ("cost_more" if net < 0 else "paid_off")
        )
    elif not changes:
        verdict = "no_changes"
    elif len(undone) >= len(landed):
        verdict = "mostly_undone"
    else:
        verdict = "unweighed"
    row["verdict"] = verdict
    return row


# ── exports ──

COLUMNS = (
    ("week", "Week of"),
    ("turns", "Turns"),
    ("changes", "Changes"),
    ("landed", "Landed"),
    ("reverted", "Reverted"),
    ("rewound", "Rewound"),
    ("discarded", "Discarded"),
    ("review_minutes", "Review minutes"),
    ("cost_usd", "Cost (USD, Claude Code's estimate)"),
    ("cost_per_landed", "Cost per landed change (USD)"),
    ("wasted_usd", "Spent on changes taken back (USD)"),
    ("routed", "Routed messages"),
    ("routed_usd", "Routed messages cost (USD)"),
    ("alternative_usd", "Router's alternative (USD, estimate)"),
    ("value_usd", "Time saved (USD)"),
    ("net_usd", "Net (USD)"),
    ("verdict", "Verdict"),
)

NOTES = (
    "Changes are turns that changed files. Landed means nothing took them back in Eden Code (no undo, revert, rewind with files or discarded copy); edits made later by hand aren't seen.",
    "Cost is Claude Code's own estimate per turn: on a Claude plan it is the API price of what ran, not a bill.",
    "The router's alternative is its own estimate: its pick for messages sent in Shadow mode, the best-quality option for messages it routed.",
    "Time saved and Net use your hourly rate and the minutes you say a landed change saves; without them no week is called a win.",
)


def to_csv(ledger: dict[str, Any]) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([label for _, label in COLUMNS])
    for row in [*ledger["weeks"], {**ledger["totals"], "week": "Total"}]:
        writer.writerow(
            [
                ""
                if row.get(k) is None
                else (VERDICTS.get(row[k], row[k]) if k == "verdict" else row[k])
                for k, _ in COLUMNS
            ]
        )
    return out.getvalue()


def to_markdown(ledger: dict[str, Any], made: date) -> str:
    lines = [
        "# Eden Code productivity ledger",
        "",
        f"Made {made.isoformat()}, weeks since {ledger['since']}.",
        "",
    ]
    if ledger["rate"] and ledger["minutes"]:
        lines += [
            f"Weighed at ${ledger['rate']:.2f} an hour, {ledger['minutes']:g} minutes saved per landed change.",
            "",
        ]
    lines.append("| " + " | ".join(label for _, label in COLUMNS) + " |")
    lines.append("|" + "---|" * len(COLUMNS))
    for row in [*ledger["weeks"], {**ledger["totals"], "week": "**Total**"}]:
        cells = []
        for key, _ in COLUMNS:
            v = row.get(key)
            if v is None:
                cells.append("")
            elif key == "verdict":
                cells.append(VERDICTS.get(v, str(v)))
            elif isinstance(v, float):
                cells.append(f"{v:.2f}")
            else:
                cells.append(str(v))
        lines.append("| " + " | ".join(cells) + " |")
    lines += ["", *[f"- {note}" for note in NOTES], ""]
    return "\n".join(lines)


def _write(stem: str, suffix: str, text: str) -> Path:
    folder = tasks.EXPORT_DIR
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{stem}{suffix}"
    for n in itertools.count(2):
        if not path.exists():
            break
        path = folder / f"{stem} {n}{suffix}"
    path.write_text(text, "utf-8")
    return path


class Ledger:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def tr(self, text: str, **kw: Any) -> str:
        return (
            lang.tr(text, self.hub.language, **kw)
            if kw
            else lang.translate(text, self.hub.language)
        )

    def numbers(self) -> tuple[float, float]:
        rate = self.hub.prefs.feature(PREF_RATE) or 0.0
        minutes = self.hub.prefs.feature(PREF_MINUTES) or 0.0
        return float(rate), float(minutes)

    async def build(self, weeks: int = WEEKS_DEFAULT) -> dict[str, Any]:
        radar = getattr(self.hub, "code_radar", None)
        router = getattr(self.hub, "code_router_events", None)
        for source in (radar, router):
            if source is not None:
                await source.log.flush()
        rate, minutes = self.numbers()
        now = datetime.now().timestamp()

        def read() -> dict[str, Any]:
            return weekly(
                radar.log.read() if radar is not None else [],
                router.log.read() if router is not None else [],
                now,
                weeks,
                rate,
                minutes,
            )

        return await asyncio.to_thread(read)

    async def cmd_ledger(self, msg: dict[str, Any]) -> None:
        weeks = msg.get("weeks")
        weeks = weeks if isinstance(weeks, int) and not isinstance(weeks, bool) else WEEKS_DEFAULT
        try:
            ledger = await self.build(weeks)
        except Exception:
            log.exception("Productivity ledger: couldn't read the logs")
            ledger = {"weeks": [], "totals": None, "rate": 0.0, "minutes": 0.0, "since": ""}
        radar = getattr(self.hub, "code_radar", None)
        self.hub.emit(
            "cw_ledger",
            **ledger,
            verdicts={k: self.tr(v) for k, v in VERDICTS.items()},
            on=radar.on() if radar is not None else False,
        )

    async def cmd_export(self, msg: dict[str, Any]) -> None:
        kind = "md" if msg.get("format") == "md" else "csv"
        ledger = await self.build(WEEKS_MAX)
        if not ledger["weeks"]:
            self.hub.emit("cw_ledger_export", error=self.tr("There's nothing to export yet."))
            return
        today = date.today()
        text = to_markdown(ledger, today) if kind == "md" else to_csv(ledger)
        try:
            path = await asyncio.to_thread(
                _write, f"Eden Code ledger {today.isoformat()}", f".{kind}", text
            )
        except OSError as exc:
            self.hub.emit(
                "cw_ledger_export",
                error=self.tr("Couldn't save the ledger: {error}", error=exc.strerror or str(exc)),
            )
            return
        self.hub.emit("cw_ledger_export", ok=True, path=str(path), name=path.name)


def install(hub: Any) -> None:
    ledger = Ledger(hub)
    hub.code_ledger = ledger
    hub.register_command("cw_ledger", lambda msg: hub._spawn(ledger.cmd_ledger(msg)))
    hub.register_command("cw_ledger_export", lambda msg: hub._spawn(ledger.cmd_export(msg)))
