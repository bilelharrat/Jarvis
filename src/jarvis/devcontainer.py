"""A project's own setup and its container, for Eden Code's isolated copies
(features/code_setup.py does the asking and the running).

Setup: what makes a fresh copy ready to work in (install the dependencies, make a .env from
the example, build what the tests need). The project says it in .jarvis/setup.sh (run with
bash in the copy's folder), or, without one, as a "setup" entry in .jarvis/launch.json: a
command line, or a list of them run in order, stopping at the first that fails. Both are
the repository's to write, so whoever wrote the repository (or a session) chose what runs:
the feature shows it on a card before the first run and whenever it changes. .jarvis/ is
one of the folders a session can't edit unasked (tasks._PROTECTED_DIRS).

Containers: a project with .devcontainer/devcontainer.json (or .devcontainer.json at its
top) names an image, or a Dockerfile to build one from. The owner can pick an image
instead. A copy's container mounts the copy at the same path it has on the Mac, so every
path a session sees means the same inside; the main repository's git data is mounted
read-only (git can read history in there, never write hooks or objects the Mac would run).
Docker is never required: without it, the feature says how to install it and the session
runs its commands on the Mac as usual.

Nothing here calls a model. Every docker call runs with a timeout.
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import runproc

SETUP_FILE = ".jarvis/setup.sh"
LAUNCH_FILE = ".jarvis/launch.json"
SETUP_MAX = 64_000  # bytes of a setup script read; past this it's refused, not cut
DEVCONTAINER_FILES = (".devcontainer/devcontainer.json", ".devcontainer.json")
DEVCONTAINER_MAX = 256_000
# An image name as docker takes one ([registry/]name[:tag][@digest]); nothing a shell or
# docker's own flags could take for something else (no spaces, no leading dash).
IMAGE = re.compile(r"[a-z0-9][a-z0-9._/:@+-]{0,250}")
KEEP_ALIVE = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"
CHECK_SECONDS = 15.0
RUN_SECONDS = 600.0  # pulling a big image the first time takes a while
BUILD_SECONDS = 1800.0

INSTALL = (
    "Docker isn't on this Mac, so this session runs its commands on the Mac as usual. To "
    "run them in a container, install Docker Desktop (docker.com/products/docker-desktop), "
    "or the free, lighter colima (brew install colima docker, then colima start)."
)
NOT_RUNNING = (
    "Docker is installed but isn't running, so this session runs its commands on the Mac "
    "as usual. Start Docker Desktop (or colima start), and the next copy gets its container."
)


# ── setup ──


@dataclass(frozen=True)
class Setup:
    source: str  # the file it's from
    text: str  # the script, as the card shows it and as it runs

    @property
    def fingerprint(self) -> str:
        """What a yes to it covers: the file it's from and every byte of it."""
        return hashlib.sha256(f"{self.source}\0{self.text}".encode()).hexdigest()[:24]

    def command(self) -> list[str]:
        """What runs, in the copy's folder: the script file itself, or the entry's lines."""
        if self.source == SETUP_FILE:
            return ["/bin/bash", SETUP_FILE]
        return ["/bin/sh", "-c", self.text]


def read_setup(cwd: Path) -> tuple[Setup | None, str]:
    """The project's setup, if it has one, and what's wrong with it, in plain words."""
    script = cwd / SETUP_FILE
    if script.is_symlink():
        return None, f"{SETUP_FILE} is a link, so it isn't run: make it a file in the project."
    if script.is_file():
        try:
            raw = script.read_bytes()
        except OSError as exc:
            return None, f"Couldn't read {SETUP_FILE}: {exc.strerror or exc}"
        if len(raw) > SETUP_MAX:
            return None, f"{SETUP_FILE} is over {SETUP_MAX // 1000} KB, so it isn't run."
        text = raw.decode(errors="replace")
        return (Setup(SETUP_FILE, text), "") if text.strip() else (None, "")
    launch = cwd / LAUNCH_FILE
    if not launch.is_file() or launch.is_symlink():
        return None, ""
    try:
        data = json.loads(launch.read_bytes()[:DEVCONTAINER_MAX])
    except (OSError, ValueError):
        return None, f"{LAUNCH_FILE} can't be read, so its setup isn't run."
    entry = data.get("setup") if isinstance(data, dict) else None
    if entry is None:
        return None, ""
    lines = [entry] if isinstance(entry, str) else entry if isinstance(entry, list) else None
    if not lines or not all(isinstance(line, str) for line in lines):
        return None, f'The "setup" entry in {LAUNCH_FILE} must be a command or a list of them.'
    lines = [line.strip() for line in lines if line.strip()]
    if not lines:
        return None, ""
    text = "set -e\n" + "\n".join(lines) if len(lines) > 1 else lines[0]
    if len(text) > SETUP_MAX:
        return None, f'The "setup" entry in {LAUNCH_FILE} is too long, so it isn\'t run.'
    return Setup(LAUNCH_FILE, text), ""


# ── devcontainer.json ──


def strip_jsonc(text: str) -> str:
    """JSON with comments (// and /* */) and trailing commas, as devcontainer.json allows,
    made plain JSON. Strings are left as they are ("https://…" keeps its slashes)."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


@dataclass(frozen=True)
class Image:
    image: str = ""  # a ready image
    dockerfile: str = ""  # or one built from this Dockerfile (relative to the copy's folder)
    context: str = "."  # its build context (relative to the copy's folder)
    source: str = ""  # where it was read ("" for the owner's own pick)

    @property
    def fingerprint(self) -> str:
        shape = f"{self.image}\0{self.dockerfile}\0{self.context}\0{self.source}"
        return hashlib.sha256(shape.encode()).hexdigest()[:24]

    def describe(self) -> str:
        if self.image:
            return self.image
        return f"built from {self.dockerfile}"


def _inside(cwd: Path, rel: str) -> str | None:
    """A path a devcontainer.json names, relative to the copy's folder, only if it stays
    inside it."""
    try:
        path = (cwd / rel).resolve()
        top = cwd.resolve()
    except (OSError, RuntimeError):
        return None
    if path != top and top not in path.parents:
        return None
    return path.relative_to(top).as_posix() or "."


def read_devcontainer(cwd: Path) -> tuple[Image | None, str]:
    """The image the project's devcontainer.json names (or the Dockerfile it builds), and
    what couldn't be used of it."""
    for rel in DEVCONTAINER_FILES:
        path = cwd / rel
        if not path.is_file() or path.is_symlink():
            continue
        try:
            data = json.loads(strip_jsonc(path.read_bytes()[:DEVCONTAINER_MAX].decode()))
        except (OSError, ValueError, UnicodeDecodeError):
            return None, f"{rel} can't be read."
        if not isinstance(data, dict):
            return None, f"{rel} can't be read."
        image = data.get("image")
        if isinstance(image, str) and image.strip():
            if not IMAGE.fullmatch(image.strip()):
                return None, f"{rel} names an image docker wouldn't take: {image[:80]}"
            return Image(image=image.strip(), source=rel), ""
        build = data.get("build") if isinstance(data.get("build"), dict) else {}
        dockerfile = build.get("dockerfile") or build.get("dockerFile") or data.get("dockerFile")
        if isinstance(dockerfile, str) and dockerfile.strip():
            base = Path(rel).parent  # relative to the devcontainer.json's own folder
            context = build.get("context") if isinstance(build.get("context"), str) else "."
            file_rel = _inside(cwd, str(base / dockerfile.strip()))
            context_rel = _inside(cwd, str(base / context))
            if file_rel is None or context_rel is None:
                return None, f"{rel} builds from outside the project, so it isn't used."
            return Image(dockerfile=file_rel, context=context_rel, source=rel), ""
        if data.get("dockerComposeFile"):
            return None, f"{rel} uses Docker Compose, which Eden Code doesn't run: pick an image."
        return None, f"{rel} names no image or Dockerfile."
    return None, ""


def container_name(slug: str) -> str:
    return f"eden-{slug}"[:63]


def git_mounts(checkout: Path) -> list[str]:
    """docker -v arguments for a worktree's git data: the main repository's read-only, the
    worktree's own folder in it (its index, HEAD) writable."""
    marker = checkout / ".git"
    try:
        line = marker.read_text().strip() if marker.is_file() else ""
    except OSError:
        line = ""
    if not line.startswith("gitdir:"):
        return []
    own = Path(line[7:].strip())
    if not own.is_absolute():
        own = (checkout / own).resolve()
    common = own.parent.parent  # <repo>/.git/worktrees/<name> -> <repo>/.git
    if common.name != ".git" and not (common / "objects").is_dir():
        return []
    return ["-v", f"{common}:{common}:ro", "-v", f"{own}:{own}"]


# ── docker ──


class Docker:
    """The docker command line, found on the owner's own PATH. The tests put a fake here."""

    def __init__(self) -> None:
        self._path: str | None = None

    def env(self) -> dict[str, str]:
        return runproc.shell_env()

    def path(self) -> str | None:
        if self._path is None:
            found = runproc.which("docker", self.env(), Path.home())
            self._path = found or ""
        return self._path or None

    async def run(
        self, args: list[str], cwd: Path | None = None, timeout: float = CHECK_SECONDS
    ) -> tuple[int | None, str]:
        """One docker command to its end: its exit code (None: it couldn't start, or ran
        out of time) and its output."""
        docker = self.path()
        if docker is None:
            return None, "docker isn't installed"
        return await runproc.run_quiet([docker, *args], cwd or Path.home(), self.env(), timeout)

    async def check(self) -> str:
        """Nothing when docker is there and running, else what to do about it."""
        if self.path() is None:
            return INSTALL
        code, _out = await self.run(["version", "--format", "{{.Server.Version}}"])
        return "" if code == 0 else NOT_RUNNING

    async def socket(self) -> str:
        """The unix socket the docker command talks to (for Claude Code's sandbox to let
        it through), or ""."""
        code, out = await self.run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
        host = out.strip().splitlines()[-1] if code == 0 and out.strip() else ""
        return host[7:] if host.startswith("unix://") else ""

    def exec_argv(self, name: str, cwd: Path, command: str) -> list[str]:
        """A command line run in the container, in the copy's folder (the same path in
        there)."""
        return [self.path() or "docker", "exec", "-w", str(cwd), name, "/bin/sh", "-c", command]

    def exec_line(self, name: str, cwd: Path, command: str) -> str:
        """The same, as one shell command line (what a session's Bash step becomes)."""
        return shlex.join(self.exec_argv(name, cwd, command))


def run_args(name: str, slug: str, image: str, checkout: Path, cwd: Path) -> list[str]:
    """docker run's arguments for a copy's container: kept running, the copy mounted at its
    own path, its git data as git_mounts says, no way to gain privileges inside."""
    return [
        "run", "-d", "--name", name, "--label", f"eden.copy={slug}",
        "--security-opt", "no-new-privileges",
        "-v", f"{checkout}:{checkout}", *git_mounts(checkout), "-w", str(cwd),
        "--entrypoint", "/bin/sh", image, "-c", KEEP_ALIVE,
    ]  # fmt: skip


def describe(info: dict[str, Any]) -> str:
    return f"{info.get('name')} ({info.get('image')})"
