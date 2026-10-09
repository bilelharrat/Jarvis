"""A code interpreter in the main chat, as the ChatGPT, Claude and Gemini apps have one: JARVIS
writes Python and runs it to calculate, analyse data and draw charts, and sees what it printed.

- run_python {code}: runs in a worker that keeps its variables for the conversation
  (interpreter_worker.py), in its own folder, Documents › Jarvis › Analysis › <when it began>.
  Charts left open are saved there as PNGs, shown in the window and given back to Claude.
- analysis_add_file {path}: copies a file from the owner's home into that folder, so code can
  read it (a CSV, a spreadsheet).

Sandboxed (sandbox-exec): no network, nothing written outside its folder, nothing read in the
owner's home but its folder and its Python. Two minutes a run, then the worker is stopped (its
variables go; its files stay). A new conversation gets a new worker and folder.

Its Python is its own (Application Support › Jarvis › interpreter), set up with uv on first use
with numpy, pandas, matplotlib, scipy, openpyxl and pillow; until then (or without uv) it's
JARVIS's own Python, which has numpy.

Window: the event analysis_run {rid, code, output, error, charts: [{name, data}], files,
folder}; the command analysis_reveal {} shows the folder in Finder.

Claude cost policy: no model is called here; the code is the conversation's own.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

log = logging.getLogger("jarvis")

RUN_SECONDS = 120.0
SETUP_SECONDS = 600.0
IDLE_SECONDS = 30 * 60
CODE_MAX = 100_000
FILE_MAX_BYTES = 200 * 1024 * 1024
CHART_MAX_BYTES = 3 * 1024 * 1024
CHARTS_BACK = 4
PACKAGES = ("numpy", "pandas", "matplotlib", "scipy", "openpyxl", "pillow")

PROMPT = (
    "You can run Python with run_python (a code interpreter): use it for anything numeric, "
    "for data analysis, and for charts, rather than working figures out in your head. It's "
    "sandboxed: no internet, and none of the owner's files unless copied in first with "
    "analysis_add_file (give it the file's path). Variables stay between runs in this "
    "conversation; files you write stay in its folder. numpy, pandas, matplotlib, scipy, "
    "openpyxl and pillow are there once it's set up. For a chart, draw it with matplotlib "
    "and leave the figure open: it's saved, shown to the owner, and you see it too. Then "
    "answer in words; don't paste the code back unless asked."
)


def analysis_root() -> Path:
    return Path.home() / "Documents" / "Jarvis" / "Analysis"


def find_uv() -> str | None:
    found = shutil.which("uv")
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "bin" / "uv",
        Path("/opt/homebrew/bin/uv"),
        Path("/usr/local/bin/uv"),
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def profile(work: Path, readable: list[Path]) -> str:
    """The sandbox: no network; in the home folder, read only its folder and Python, write
    only its folder."""

    def quote(path: Path) -> str:
        return json.dumps(str(path))

    home = Path.home().resolve()
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        f"(deny file-write* (subpath {quote(home)}))",
        f"(deny file-read-data (subpath {quote(home)}))",
        "(allow file-read-data "
        + " ".join(f"(subpath {quote(p)})" for p in [work, *readable])
        + ")",
        f"(allow file-write* (subpath {quote(work)}))",
    ]
    return "\n".join(lines)


class Worker:
    """One sandboxed Python, with its folder."""

    def __init__(self, process: Any, folder: Path, session: str) -> None:
        self.process = process
        self.folder = folder
        self.session = session
        self.used = time.monotonic()
        self.lock = asyncio.Lock()

    def alive(self) -> bool:
        return self.process.returncode is None

    def stop(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self.process.kill()

    async def run(self, code: str) -> dict[str, Any]:
        self.used = time.monotonic()
        self.process.stdin.write((json.dumps({"code": code}) + "\n").encode())
        await self.process.stdin.drain()
        line = await asyncio.wait_for(self.process.stdout.readline(), RUN_SECONDS)
        if not line:
            raise EOFError
        return json.loads(line)


class Interpreter:
    def __init__(self, hub: Any, home: Path | None = None, root: Path | None = None) -> None:
        from ..prefs import APP_SUPPORT

        self.hub = hub
        self.home = home or APP_SUPPORT / "interpreter"
        self.root = root or analysis_root()
        self.worker: Worker | None = None
        self._setup: asyncio.Task | None = None
        self.sandbox = Path("/usr/bin/sandbox-exec").exists()

    # ── its Python ──

    @property
    def venv_python(self) -> Path:
        return self.home / "venv" / "bin" / "python"

    def ready(self) -> bool:
        return (self.home / "ready.json").is_file() and self.venv_python.exists()

    async def setup(self) -> bool:
        """The interpreter's own Python with its packages (once); False when it can't be."""
        if self.ready():
            return True
        uv = find_uv()
        if uv is None:
            return False
        if self._setup is None or self._setup.done():
            self._setup = asyncio.ensure_future(self._make(uv))
        try:
            return await asyncio.wait_for(asyncio.shield(self._setup), SETUP_SECONDS)
        except (TimeoutError, Exception):
            return False

    async def _make(self, uv: str) -> bool:
        self.home.mkdir(parents=True, exist_ok=True)
        version = f"{sys.version_info.major}.{sys.version_info.minor}"
        steps = [
            [uv, "venv", "--python", version, str(self.home / "venv")],
            [uv, "pip", "install", "--python", str(self.venv_python), *PACKAGES],
        ]
        for step in steps:
            process = await asyncio.create_subprocess_exec(
                *step, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
            )
            _out, err = await process.communicate()
            if process.returncode != 0:
                log.warning("interpreter setup failed: %s", err.decode(errors="replace")[-400:])
                return False
        (self.home / "ready.json").write_text(json.dumps({"packages": list(PACKAGES)}))
        return True

    def python(self) -> str:
        return str(self.venv_python) if self.ready() else sys.executable

    @staticmethod
    def prefixes(python: str) -> list[Path]:
        """What the sandboxed Python has to read: its own folders."""
        out = subprocess.run(
            [python, "-c", "import sys; print(sys.prefix); print(sys.base_prefix)"],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.split("\n")
        paths = {Path(p).resolve() for p in out if p.strip()}
        paths.add(Path(python).resolve().parent.parent)
        return sorted(paths)

    # ── its worker ──

    def _folder(self) -> Path:
        stamp = time.strftime("%Y-%m-%d %H.%M.%S")
        folder = self.root / stamp
        n = 2
        while folder.exists():
            folder = self.root / f"{stamp} ({n})"
            n += 1
        folder.mkdir(parents=True)
        return folder

    async def _start(self, session: str) -> Worker:
        python = self.python()
        folder = self._folder()
        for hidden in (".mpl", ".tmp"):
            (folder / hidden).mkdir()
        script = self.home / "worker.py"
        self.home.mkdir(parents=True, exist_ok=True)
        from .. import interpreter_worker

        script.write_text(Path(interpreter_worker.__file__).read_text())
        command = [python, "-I", str(script)]
        if self.sandbox:
            readable = [*await asyncio.to_thread(self.prefixes, python), self.home]
            command = ["/usr/bin/sandbox-exec", "-p", profile(folder.resolve(), readable), *command]
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(folder),
            "TMPDIR": str(folder / ".tmp"),
            "MPLCONFIGDIR": str(folder / ".mpl"),
            "MPLBACKEND": "Agg",
            "PYTHONUNBUFFERED": "1",
            "LANG": "en_US.UTF-8",
        }
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=folder,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            limit=4 * 1024 * 1024,
        )
        return Worker(process, folder, session)

    async def worker_for(self, session: str) -> Worker:
        w = self.worker
        stale = w is not None and (
            not w.alive()
            or time.monotonic() - w.used > IDLE_SECONDS
            or (w.session and session and w.session != session)
        )
        if w is None or stale:
            if w is not None:
                w.stop()
            await self.setup()
            self.worker = w = await self._start(session)
        if session and not w.session:  # a new conversation's first answer named it
            w.session = session
        return w

    def stop(self) -> None:
        if self.worker is not None:
            self.worker.stop()
            self.worker = None

    # ── the tools ──

    async def run(self, code: str) -> tuple[list[dict[str, Any]], bool]:
        code = str(code or "")
        if not code.strip():
            return [{"type": "text", "text": "There was no code to run."}], True
        if len(code) > CODE_MAX:
            return [{"type": "text", "text": "That's too much code for one run."}], True
        session = str(getattr(self.hub, "_session_id", "") or "")
        worker = await self.worker_for(session)
        async with worker.lock:
            try:
                result = await worker.run(code)
            except TimeoutError:
                worker.stop()
                self.worker = None
                return [
                    {
                        "type": "text",
                        "text": "The run took over two minutes and was stopped. Its variables "
                        "are gone; files it wrote stay. Try something lighter, or in steps.",
                    }
                ], True
            except (EOFError, ValueError, OSError, BrokenPipeError):
                worker.stop()
                self.worker = None
                return [
                    {
                        "type": "text",
                        "text": "The interpreter stopped (it may have run out of memory). "
                        "Its variables are gone; run again to start afresh.",
                    }
                ], True
        return self._answer(worker, code, result), bool(result.get("error"))

    def _answer(self, worker: Worker, code: str, result: dict[str, Any]) -> list[dict[str, Any]]:
        charts = []
        for name in result.get("charts") or []:
            path = worker.folder / str(name)
            with contextlib.suppress(OSError):
                data = path.read_bytes()
                if len(data) <= CHART_MAX_BYTES:
                    charts.append({"name": path.name, "data": base64.b64encode(data).decode()})
        files = [str(f) for f in result.get("files") or []]
        output = str(result.get("output") or "")
        error = str(result.get("error") or "")
        self.hub.emit(
            "analysis_run",
            rid=getattr(self.hub, "_rid", ""),
            code=code,
            output=output,
            error=error,
            charts=charts,
            files=files,
            folder=str(worker.folder),
        )
        words = []
        if output:
            words.append(f"Output:\n{output}")
        if error:
            words.append(f"Error:\n{error}")
        if charts:
            words.append(
                "Charts (shown to the owner, and below): " + ", ".join(c["name"] for c in charts)
            )
        if files:
            words.append("Files written: " + ", ".join(files[:30]))
        if not words:
            words.append("It ran, and printed nothing.")
        if not self.ready():
            words.append(
                "(Only numpy is here for now: pandas, matplotlib and the rest are being set up.)"
            )
        content: list[dict[str, Any]] = [{"type": "text", "text": "\n\n".join(words)}]
        for chart in charts[:CHARTS_BACK]:
            content.append({"type": "image", "data": chart["data"], "mimeType": "image/png"})
        return content

    async def add_file(self, path: str) -> tuple[str, bool]:
        try:
            source = Path(str(path or "")).expanduser().resolve()
        except OSError:
            return "That file can't be found.", True
        home = Path.home().resolve()
        if not source.is_file() or home not in source.parents:
            return "Only a file in the owner's home folder can be added.", True
        from ..private_folders import is_private, refusal

        if is_private(source):  # its output goes to Claude: a private folder's files never do
            return refusal(source), True
        if source.stat().st_size > FILE_MAX_BYTES:
            return "That file is over 200 MB.", True
        worker = await self.worker_for(str(getattr(self.hub, "_session_id", "") or ""))
        target = worker.folder / source.name
        await asyncio.to_thread(shutil.copy2, source, target)
        return f"Copied in: read it as '{target.name}' (it's in the working folder).", False

    def build_server(self):
        interpreter = self

        @tool(
            "run_python",
            "Run Python code in the sandboxed code interpreter and get back what it printed, "
            "any error, and charts (matplotlib figures left open). Variables persist between "
            "runs in this conversation. No internet; no owner files unless added first.",
            {
                "type": "object",
                "properties": {"code": {"type": "string"}},
                "required": ["code"],
            },
        )
        async def run_python(args):
            content, error = await interpreter.run(args.get("code", ""))
            out: dict[str, Any] = {"content": content}
            if error:
                out["is_error"] = True
            return out

        @tool(
            "analysis_add_file",
            "Copy a file from the owner's Mac (a path in their home folder) into the code "
            "interpreter's working folder, so run_python can read it by its name.",
            {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        )
        async def analysis_add_file(args):
            text, error = await interpreter.add_file(args.get("path", ""))
            out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            if error:
                out["is_error"] = True
            return out

        return create_sdk_mcp_server(
            name="interpreter", version="0.1.0", tools=[run_python, analysis_add_file]
        )

    # ── the window ──

    def reveal(self, _msg: dict[str, Any]) -> None:
        folder = self.worker.folder if self.worker else self.root
        folder.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            subprocess.Popen(["/usr/bin/open", str(folder)])


def install(hub: Any) -> None:
    if os.environ.get("JARVIS_NO_INTERPRETER"):
        return
    interpreter = Interpreter(hub)
    hub.interpreter = interpreter
    hub.register_server(
        "interpreter",
        interpreter.build_server,
        prompt=PROMPT,
        labels={"run_python": "Ran Python", "analysis_add_file": "Added a file to the analysis"},
    )
    hub.register_command("analysis_reveal", interpreter.reveal)
