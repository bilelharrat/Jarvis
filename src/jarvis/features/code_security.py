"""Eden Code: security and dependency scanning of each change, with the owner's own tools.

Semgrep, osv-scanner, npm audit and pip-audit (whichever are installed; security_scan.py
says how each is run and scoped) check what a change added, in three places:

- the turn's receipt (code_receipts): what the scanners found on the lines the turn
  added and in the dependencies it brought in, with the tools that ran; a high-severity
  finding makes the turn's risk high. A tool that would have applied and isn't installed
  is named on the card with how to install it, never installed for the owner;
- Deep review (code_review): the findings go to the three reviewers as evidence and to
  the verifier as findings of their own, and the confirmed ones are pinned on their lines
  with Fix this and Fix all like the reviewers' own;
- before each push (code_git.push, which a pull request's pushes go through too): the
  commits' changes, as they are in them, beside the secret scan on the push card. A
  high-severity finding makes the card say "Push anyway", and a push that wouldn't have
  asked (a pull request's fixes, pushed unasked) asks.

Nothing is ever blocked by a missing tool, a failing one, or a finding: the owner decides.
Settings › Eden Code › General lists the tools, which are installed and how to install
the others, and has the switch (prefs.features code_security_scan, on).

Cost policy: no model calls here (Deep review's own calls are code_review's). The tools
run on this Mac, on the changed files only, and their results are cached by content.

Window commands: code_security_tools. Events: code_security_tools {tools, on}.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from .. import code_changes, prefs, security_scan
from ..code_changes import EMPTY_TREE, git

log = logging.getLogger("jarvis")

PREF = "code_security_scan"
prefs.register_feature_pref(PREF, True)


def risk_of(part: dict[str, Any] | None) -> tuple[str, str] | None:
    """What a receipt's security part says of the turn's risk: (level, why), or None."""
    if not part or not part.get("count"):
        return None
    if part.get("high"):
        n = part["high"]
        return "high", f"the security scan found {n} high-severity problem{'s' if n != 1 else ''}"
    return "medium", "the security scan found something to look at"


def receipt_words(part: dict[str, Any] | None) -> str:
    """The receipt's text for its security part ("" when no tool ran)."""
    if not part or not part.get("ran"):
        return ""
    tools = ", ".join(part["ran"])
    n = part.get("count") or 0
    if not n:
        return f"security scan clean ({tools})"
    high = f", {part['high']} high" if part.get("high") else ""
    return f"security scan: {n} finding{'s' if n != 1 else ''}{high} ({tools})"


class Security:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.scanner = security_scan.Scanner()  # (the tests give it a fake environment)

    def enabled(self) -> bool:
        try:
            return bool(self.hub.prefs.feature(PREF))
        except Exception:
            return True

    # ── a view of a session's changes (its receipt, Deep review) ──

    def scan_view(self, view: Any) -> security_scan.Report | None:
        """A Changes view scanned (blocking: run in a thread). None when switched off or
        there's nothing; never raises."""
        if not self.enabled() or view is None or not view.files:
            return None
        try:
            return self.scanner.scan(view.repo.top, view.files, view.repo.shown)
        except Exception as exc:  # a scan is extra proof: never a turn's or a review's end
            log.warning("security scan failed: %s", exc)
            return None

    async def for_view(self, view: Any) -> security_scan.Report | None:
        return await asyncio.to_thread(self.scan_view, view)

    async def receipt_part(self, task: Any) -> dict[str, Any] | None:
        """The receipt's security part for the turn that just ended, or None."""
        if not self.enabled():
            return None

        def scan() -> security_scan.Report | None:
            try:
                view = code_changes.task_view(task, "turn")
            except Exception as exc:
                log.warning("security scan: no view of the turn: %s", exc)
                return None
            return self.scan_view(view)

        report = await asyncio.to_thread(scan)
        if report is None or report.empty:
            return None
        return report.public()

    # ── commits about to be pushed ──

    def push_report(self, top: Path, remote: str, shown: Any = None) -> security_scan.Report | None:
        """What the commits not on remote yet add, scanned as they are in HEAD (blocking:
        code_git's push plan runs in a thread). None when off or nothing applies."""
        if not self.enabled():
            return None
        try:
            listed = git(top, "rev-list", "HEAD", "--not", f"--remotes={remote}", "--max-count=500")
            oldest = listed.out.split()[-1] if listed.ok and listed.out.split() else ""
            if not oldest:
                return None
            parent = git(top, "rev-parse", "--verify", "-q", f"{oldest}^")
            base = parent.out.strip() if parent.ok and parent.out.strip() else EMPTY_TREE
            report = self.scanner.scan_commits(top, base, "HEAD", shown)
        except Exception as exc:
            log.warning("security scan before a push failed: %s", exc)
            return None
        return None if report.empty else report

    # ── Settings ──

    def tools_state(self, root: Path | None = None) -> list[dict[str, Any]]:
        found = self.scanner.tools(root or Path.home())
        return [
            {"id": tid, "label": label, "what": what, "install": how, "installed": bool(found[tid])}
            for tid, (label, what, how) in security_scan.TOOLS.items()
        ]

    def cmd_tools(self, _msg: dict[str, Any]) -> None:
        async def answer() -> None:
            tools = await asyncio.to_thread(self.tools_state)
            self.hub.emit("code_security_tools", tools=tools, on=self.enabled())

        self.hub._spawn(answer())


def install(hub: Any) -> None:
    security = Security(hub)
    hub.code_security = security  # (for receipts, Deep review, pushes and the tests)
    hub.register_command("code_security_tools", security.cmd_tools)
