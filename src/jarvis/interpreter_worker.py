"""The code interpreter's worker (features/code_interpreter.py starts it, sandboxed): a Python
that keeps its variables between runs. Each line on stdin is {"code": ...}; each answer, one
line on stdout: {"output", "error", "charts": [file names], "files": [file names changed]}.

Runs in the analysis folder (its working directory). matplotlib draws off screen; any figure
left open after a run is saved there as chart-N.png and closed.

No jarvis imports: it runs on the interpreter's own Python, which may not have them.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback

OUTPUT_MAX = 20_000


def snapshot(folder: str) -> dict[str, float]:
    seen = {}
    for root, _dirs, files in os.walk(folder):
        if "/." in root:
            continue
        for name in files:
            if name.startswith("."):
                continue
            path = os.path.join(root, name)
            with contextlib.suppress(OSError):
                seen[os.path.relpath(path, folder)] = os.path.getmtime(path)
    return seen


def save_charts(folder: str, count: list[int]) -> list[str]:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    names = []
    for number in plt.get_fignums():
        count[0] += 1
        name = f"chart-{count[0]}.png"
        with contextlib.suppress(Exception):
            plt.figure(number).savefig(os.path.join(folder, name), dpi=144, bbox_inches="tight")
            names.append(name)
    plt.close("all")
    return names


def main() -> None:
    os.environ.setdefault("MPLBACKEND", "Agg")
    folder = os.getcwd()
    answer = os.fdopen(os.dup(1), "w", encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    space: dict = {"__name__": "__main__"}
    count = [0]
    for line in sys.stdin:
        try:
            code = str(json.loads(line).get("code") or "")
        except ValueError:
            continue
        before = snapshot(folder)
        captured = io.StringIO()
        error = ""
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            try:
                compiled = compile(code, "<analysis>", "exec")
                exec(compiled, space)  # noqa: S102 (it's what the worker is for, sandboxed)
            except BaseException:  # a SystemExit too: the worker stays up
                error = traceback.format_exc(limit=8)
        charts = save_charts(folder, count)
        after = snapshot(folder)
        changed = sorted(n for n, t in after.items() if before.get(n) != t and n not in charts)
        output = captured.getvalue()
        if len(output) > OUTPUT_MAX:
            output = output[:OUTPUT_MAX] + f"\n… ({len(output) - OUTPUT_MAX} more characters)"
        answer.write(
            json.dumps({"output": output, "error": error, "charts": charts, "files": changed})
            + "\n"
        )
        answer.flush()


if __name__ == "__main__":
    main()
