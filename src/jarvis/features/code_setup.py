"""Eden Code: each new isolated copy made ready by the project's own setup, and, where the
owner turns it on, a container per copy (devcontainer.py has the files and docker).

A new copy (features/code_isolation.py's Desk.on_new_copy, before its session first
connects):
- Container: for a project the owner switched it on for (Setup and container pane), the
  copy gets a Docker container from the image the owner picked, else the one its
  .devcontainer/devcontainer.json names (or builds from a Dockerfile). The copy is mounted
  at its own path, the main repository's git data read-only. The session's Bash steps then
  run in it (a PreToolUse hook rewrites each into docker exec, which the session's
  permission mode then judges as it is: the card shows exactly what runs). A
  devcontainer.json is the repository's to write, so its image (or Dockerfile) is shown on a
  card the first time and whenever it changes; the owner's own pick needs none. Without
  docker, or with it stopped, the session says how to fix that and runs on the Mac. The
  container goes when its copy does (landed, discarded, swept), and an hourly tidy-up takes
  away any whose copy is gone.
- Setup: .jarvis/setup.sh, or the "setup" entry in .jarvis/launch.json, runs in the copy's
  folder (in its container when it has one), its output streamed to the window and its end
  in the transcript. The card shows the script the first time for each project and again
  whenever it changes (S21's rule for launch.json's commands, and .jarvis/ stays one of
  the folders a session can't edit unasked). Unanswered for ASK_SECONDS (an unattended run,
  say), it's skipped and the transcript says so. EDEN_MAIN_FOLDER tells the script where
  the project's main folder is (to copy or link something from there).

Window commands: code_setup_state {id | directory} (answers code_setup), code_setup_run {id}
(run it again in the session's copy: the same card when it's new).
Events: code_setup, code_setup_output {id, slug, lines, done, code}.
Settings (prefs.features): code_container_projects (project names whose copies get a
container), code_container_images ({project: image}, the owner's pick over the
devcontainer.json's).
Loop: code_containers_tidy.

Cost policy: nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shlex
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import HookMatcher

from .. import code_changes, devcontainer, jsonstore, lang, prefs, runproc
from ..codeplatform import code_task, other_agent
from ..devcontainer import Docker, Image, Setup
from .code_isolation import _project_names

log = logging.getLogger("jarvis")

PREF_PROJECTS = "code_container_projects"
PREF_IMAGES = "code_container_images"
ASK_SECONDS = 120.0  # a setup or container card waits this long, then it's skipped
SETUP_SECONDS = 900.0  # a setup that runs longer is stopped
OUTPUT_KEEP = 400  # lines of a setup's output kept for the pane
TAIL_LINES = 30  # lines of it in the transcript
EMIT_EVERY = 0.25  # seconds between batches of output to the windows
TIDY_EVERY = 3600.0


def _images(value: Any) -> dict[str, str] | None:
    """{project: image} (the owner's picks), or None for anything else."""
    if not isinstance(value, dict):
        return None
    return {
        k: v.strip()
        for k, v in list(value.items())[:200]
        if isinstance(k, str)
        and 0 < len(k) <= 200
        and "/" not in k
        and isinstance(v, str)
        and devcontainer.IMAGE.fullmatch(v.strip())
    }


prefs.register_feature_pref(PREF_PROJECTS, [], _project_names)
prefs.register_feature_pref(PREF_IMAGES, {}, _images)

ZH = {
    "Run {project}'s setup in the new copy?": "要在新副本里运行 {project} 的设置脚本吗？",
    "Run it": "运行",
    "Not this time": "这次不要",
    "Running the project's setup…": "正在运行项目的设置脚本……",
    "Setup finished in {seconds} s.": "设置脚本已完成，用时 {seconds} 秒。",
    "Setup failed (exit {code}) after {seconds} s; the session starts anyway.": "设置脚本失败（退出码 {code}），用时 {seconds} 秒；会话照常开始。",
    "Setup ran out of time after {minutes} min and was stopped; the session starts anyway.": "设置脚本超过 {minutes} 分钟被停下；会话照常开始。",
    "Setup was skipped: nobody said yes to it in time.": "设置脚本已跳过：没有人及时同意。",
    "Setup was skipped.": "设置脚本已跳过。",
    "Couldn't run the setup: {error}": "没能运行设置脚本：{error}",
    "Run {project}'s sessions in a container from {source}?": "要让 {project} 的会话在来自 {source} 的容器里运行吗？",
    "Use the container": "使用容器",
    "Run on the Mac": "在 Mac 上运行",
    "The container wasn't used: nobody said yes to it in time.": "没有使用容器：没有人及时同意。",
    "Couldn't build the container's image: {error}": "没能构建容器镜像：{error}",
    "Couldn't start the container: {error}": "没能启动容器：{error}",
    "This copy's git data isn't where Eden can tell, so it gets no container: this session runs its commands on the Mac.": "无法确定这个副本的 git 数据在哪里，所以它没有容器：这个会话在 Mac 上运行命令。",
    "Containers are on for {project}, but it has no image: pick one in Setup and container, or add .devcontainer/devcontainer.json. This session runs its commands on the Mac.": "{project} 已开启容器，但没有镜像：在“设置与容器”里选一个，或添加 .devcontainer/devcontainer.json。这个会话在 Mac 上运行命令。",
    "Setup and container": "设置与容器",
    "There's no copy to set up here.": "这里没有可以设置的副本。",
    "It's still working. Wait for it to finish, then run the setup.": "它还在工作。等它完成，再运行设置脚本。",
    # (Not "There's no setup in this project: add .jarvis/setup.sh.": its path says the old
    # wake word, which no Chinese sentence may (test_lang); it stays in English.)
    devcontainer.INSTALL: "Docker 不在这台 Mac 上，所以这个会话在 Mac 上照常运行命令。要在容器里运行，请安装 Docker Desktop（docker.com/products/docker-desktop），或免费、更轻量的 colima（brew install colima docker，然后 colima start）。",
    devcontainer.NOT_RUNNING: "Docker 已安装但没有运行，所以这个会话在 Mac 上照常运行命令。启动 Docker Desktop（或 colima start），下一个副本就会有容器。",
}
lang.add_texts(ZH)


def _detail_setup(setup: Setup, where: str) -> str:
    shown = setup.text if len(setup.text) <= 4000 else setup.text[:4000] + "\n[…the rest]"
    return (
        f"From {setup.source}, run {where}:\n\n{shown}\n\n"
        "It runs as you. The setup is the repository's to write (a cloned one's authors', "
        "or a session's): run it only if that's a script you trust. I ask again if it changes."
    )


class SetupDesk:
    """One hub's setup runs and containers."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.docker: Any = Docker()  # (the tests put a fake here)
        self.output: dict[str, list[str]] = {}  # slug -> the latest setup's output
        self.running: dict[str, runproc.Proc] = {}  # slug -> a setup running there now
        self._containers: dict[str, dict[str, Any]] | None = None
        self.sockets: dict[str, str] = {}  # container name -> docker's socket, for the sandbox

    # ── plumbing ──

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def note(self, task: Any, text: str) -> None:
        self.hub.tasks._log(task, "system", self.tr(text))

    def _ok_path(self) -> Path:
        return self.hub.feature_path("code-setup-ok.json")

    def approved(self) -> dict[str, list[str]]:
        try:
            data = jsonstore.load_json(self._ok_path(), dict) or {}
        except jsonstore.Unreadable:
            data = {}
        return {
            k: [f for f in v if isinstance(f, str)] for k, v in data.items() if isinstance(v, list)
        }

    def remember(self, project: str, fingerprint: str) -> None:
        kept = self.approved()
        kept[project] = [*[f for f in kept.get(project, []) if f != fingerprint], fingerprint][-50:]
        with contextlib.suppress(OSError):  # a full disk: it asks again next time
            jsonstore.save_json(self._ok_path(), kept)

    async def gate(
        self, project: str, fingerprint: str, question: str, detail: str, yes: str, no: str
    ) -> str:
        """The owner's answer: "yes" (now, or to this before), "no", or "late" when the
        card went unanswered."""
        if fingerprint in self.approved().get(project, []):
            return "yes"
        try:
            choice = await asyncio.wait_for(
                self.hub.request_approval(
                    self.tr(question),
                    self.tr(detail),
                    [("yes", self.tr(yes)), ("no", self.tr(no))],
                ),
                ASK_SECONDS,
            )
        except TimeoutError:
            return "late"
        if choice != "yes":
            return "no"
        await asyncio.to_thread(self.remember, project, fingerprint)
        return "yes"

    @staticmethod
    def project_key(copy: Any) -> str:
        """The project a copy is of (its main folder), as the approvals are kept."""
        return str(Path(copy.repo) / copy.prefix).rstrip("/")

    def containers(self) -> dict[str, dict[str, Any]]:
        if self._containers is None:
            try:
                data = jsonstore.load_json(self.hub.feature_path("code_containers.json"), dict)
            except jsonstore.Unreadable:
                data = None
            self._containers = {
                k: v for k, v in (data or {}).items() if isinstance(v, dict) and v.get("name")
            }
            for info in self._containers.values():
                self.pin(info)
        return self._containers

    def pin(self, info: dict[str, Any]) -> None:
        """Eden's own git in a container's copy runs on the git data recorded before the
        container started (code_changes.pin_git), never where the copy's files now point.
        A record from before there was one: its copy's .git file is taken only when it still
        points into the main repository's own git data (else no git runs there at all)."""
        checkout, pin = str(info.get("checkout") or ""), info.get("git", False)
        if checkout and (pin is None or isinstance(pin, dict)):
            code_changes.pin_git(checkout, pin)
            return
        desk = self.desk()
        copy = desk.store().by_path(Path(str(info.get("cwd") or "/"))) if desk else None
        if copy is None:
            return
        info["checkout"], info["git"] = str(copy.checkout), self.checked_pin(copy)
        code_changes.pin_git(copy.checkout, info["git"])

    @staticmethod
    def checked_pin(copy: Any) -> dict[str, str] | None:
        """A copy's git data as its .git file says (devcontainer.git_pin), only when that's in
        the main repository's own .git (blocking: reads files)."""
        found = devcontainer.git_pin(Path(copy.checkout))
        main = Path(copy.repo) / ".git"
        if found is None or not main.is_dir():
            return None
        return found if Path(found["common"]).resolve() == main.resolve() else None

    def save_containers(self) -> None:
        with contextlib.suppress(OSError):
            jsonstore.save_json(self.hub.feature_path("code_containers.json"), self.containers())

    def container_of(self, task: Any) -> dict[str, Any] | None:
        slug = (getattr(task, "workspace", None) or {}).get("slug", "")
        return self.containers().get(slug) if slug else None

    def desk(self) -> Any:
        return getattr(self.hub, "code_desk", None)

    # ── a new copy ──

    async def on_new_copy(self, task: Any, copy: Any) -> None:
        container = await self.make_container(task, copy)
        await self.setup(task, copy, container)

    # ── containers ──

    def wanted_image(self, copy: Any) -> tuple[Image | None, str]:
        """The image a copy's container is from: the owner's pick, else the project's
        devcontainer.json's; and why there's none (blocking: reads files)."""
        picked = (self.hub.prefs.feature(PREF_IMAGES) or {}).get(copy.project)
        if picked:
            return Image(image=picked), ""
        return devcontainer.read_devcontainer(copy.cwd)

    async def make_container(self, task: Any, copy: Any) -> dict[str, Any] | None:
        if copy.project not in (self.hub.prefs.feature(PREF_PROJECTS) or []):
            return None
        if str(getattr(copy, "group", "")).startswith("multi:"):
            return None  # (a multi-repo task's one session spans several copies: on the Mac)
        if other_agent(task):
            return None  # (its commands don't come through Claude Code's hooks)
        image, problem = await asyncio.to_thread(self.wanted_image, copy)
        if image is None:
            self.note(
                task,
                problem + " This session runs its commands on the Mac."
                if problem
                else f"Containers are on for {copy.project}, but it has no image: pick one in "
                "Setup and container, or add .devcontainer/devcontainer.json. This session "
                "runs its commands on the Mac.",
            )
            return None
        if problem := await self.docker.check():
            self.note(task, problem)
            return None
        if image.source:  # the repository's choice, not the owner's: a card
            what = (
                f"the image {image.image}"
                if image.image
                else (f"an image built from {image.dockerfile} (building it runs that Dockerfile)")
            )
            said = await self.gate(
                self.project_key(copy),
                "container:" + image.fingerprint,
                f"Run {copy.project}'s sessions in a container from {image.source}?",
                f"{image.source} asks for {what}. The copy is mounted in it read-write, the "
                "copy's git data read-only, and the session's commands run in "
                "there. An image is the repository's to choose: use it only if you trust "
                "where it comes from. I ask again if it changes.",
                "Use the container",
                "Run on the Mac",
            )
            if said != "yes":
                if said == "late":
                    self.note(task, "The container wasn't used: nobody said yes to it in time.")
                return None
        task.last_action = "Starting its container…"
        self.hub.tasks._changed()
        tag = image.image
        if not tag:
            tag = f"eden-{re.sub(r'[^a-z0-9]+', '-', copy.project.lower()).strip('-')}"
            tag = f"{tag or 'project'}:{image.fingerprint[:12]}"
            code, out = await self.docker.run(
                ["build", "-t", tag, "-f", image.dockerfile, image.context],
                cwd=copy.cwd,
                timeout=devcontainer.BUILD_SECONDS,
            )
            if code != 0:
                why = (out.strip().splitlines() or ["it ran out of time"])[-1][:300]
                self.note(task, f"Couldn't build the container's image: {why}")
                return None
        pin = await asyncio.to_thread(self.checked_pin, copy)
        if pin is None:  # (its git data can't be mounted read-only: no container)
            self.note(
                task,
                "This copy's git data isn't where Eden can tell, so it gets no "
                "container: this session runs its commands on the Mac.",
            )
            return None
        name = devcontainer.container_name(copy.slug)
        await self.docker.run(["rm", "-f", name])  # (one left from before, by the same name)
        args = devcontainer.run_args(name, copy.slug, tag, Path(copy.checkout), copy.cwd)
        code, out = await self.docker.run(args, timeout=devcontainer.RUN_SECONDS)
        if code != 0:
            why = (out.strip().splitlines() or ["it ran out of time"])[-1][:300]
            self.note(task, f"Couldn't start the container: {why}")
            return None
        info = {
            "name": name, "image": tag, "cwd": str(copy.cwd), "project": copy.project,
            "checkout": str(copy.checkout), "git": pin,
        }  # fmt: skip
        self.pin(info)
        self.containers()[copy.slug] = info
        self.save_containers()
        self.sockets[name] = await self.docker.socket()
        self.note(
            task,
            f"Commands run in the container {name} ({tag}), with this copy mounted at its own "
            "path. Each starts in the copy's folder. git there can read the history but not "
            "commit: Eden commits the copy's work when you land it or open its pull request.",
        )
        return info

    def on_copy_gone(self, slug: str) -> None:
        info = self.containers().pop(slug, None)
        self.output.pop(slug, None)
        if info is None:
            return
        if info.get("checkout"):
            code_changes.unpin_git(str(info["checkout"]))
        self.save_containers()
        self.sockets.pop(str(info.get("name")), None)
        self.hub._spawn(self.docker.run(["rm", "-f", str(info["name"])]))

    async def tidy(self) -> None:
        """Containers whose copy is gone (the app quit before it could take them away)."""
        desk = self.desk()
        if desk is None:
            return
        listed = {c.slug for c in desk.store().copies}
        for slug in [s for s in self.containers() if s not in listed]:
            self.on_copy_gone(slug)

    async def tidier(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                await self.tidy()
            except Exception:
                log.exception("couldn't tidy the copies' containers")
            await asyncio.sleep(TIDY_EVERY)

    # ── a session's commands in its container ──

    def hook(self, task: Any) -> HookMatcher:
        """PreToolUse on Bash: the step's command run in the copy's container instead.

        A command is left as it is only when it already is, word for word, the line this
        hook makes for this container (docker exec, this container, this folder, sh -c and
        one command): the session's sandbox lets docker's socket through for that line, so
        anything else that merely starts the same way ("<that line> true; rm -rf ~", or the
        same words with another container or a docker flag after them) is wrapped like any
        other command and runs in the container. The container this session connected with
        gone (its copy landed or discarded under it, the tidy-up), its Bash steps are
        refused rather than run on the Mac with docker's socket still open to them."""
        connected = self.container_of(task)
        name_then = str(connected["name"]) if connected else ""

        async def into_container(input_data: dict[str, Any], _id: Any, _ctx: Any) -> dict:
            info = self.container_of(task)
            tool_input = input_data.get("tool_input") or {}
            command = str(tool_input.get("command") or "")
            if input_data.get("tool_name") != "Bash" or not command:
                return {}
            if info is None or str(info.get("name")) != name_then:
                return {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "This copy's container is gone, so its "
                        "commands can't run: stop here and say so; a new session in it runs "
                        "them on the Mac.",
                    }
                }
            if self.is_own_line(info, command):
                return {}
            line = self.docker.exec_line(str(info["name"]), Path(info["cwd"]), command)
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "updatedInput": {**tool_input, "command": line},
                }
            }

        return HookMatcher(matcher="Bash", hooks=[into_container])

    def is_own_line(self, info: dict[str, Any], command: str) -> bool:
        """Whether a command is exactly a line the hook made: every word of docker exec's
        own, for this container and folder, then a single command for sh -c."""
        own = shlex.split(self.docker.exec_line(str(info["name"]), Path(info["cwd"]), ""))
        try:
            words = shlex.split(command)
        except ValueError:
            return False
        return len(words) == len(own) and words[:-1] == own[:-1] and bool(words[-1])

    # ── setup ──

    async def setup(self, task: Any, copy: Any, container: dict[str, Any] | None) -> None:
        found, problem = await asyncio.to_thread(devcontainer.read_setup, copy.cwd)
        if problem:
            self.note(task, problem)
        if found is None:
            return
        where = f"in the container {container['name']}" if container else "in the new copy"
        said = await self.gate(
            self.project_key(copy),
            found.fingerprint,
            f"Run {copy.project}'s setup in the new copy?",
            _detail_setup(found, where),
            "Run it",
            "Not this time",
        )
        if said != "yes":
            self.note(
                task,
                "Setup was skipped: nobody said yes to it in time."
                if said == "late"
                else "Setup was skipped.",
            )
            return
        await self.run_setup(task, copy, found, container)

    async def run_setup(
        self, task: Any, copy: Any, found: Setup, container: dict[str, Any] | None
    ) -> int | None:
        """The setup run to its end, its output to the window as it comes and its end in
        the transcript. Its exit code (None: it couldn't start, or ran out of time)."""
        slug = copy.slug
        lines: list[str] = []
        self.output[slug] = lines
        pending: list[str] = []
        loop = asyncio.get_running_loop()
        flush_at: list[asyncio.TimerHandle] = []

        def flush() -> None:
            flush_at.clear()
            if pending:
                self.hub.emit("code_setup_output", id=task.id, slug=slug, lines=list(pending))
                pending.clear()

        def take(new: list[str]) -> None:
            lines.extend(new)
            del lines[:-OUTPUT_KEEP]
            pending.extend(new)
            if not flush_at:
                flush_at.append(loop.call_later(EMIT_EVERY, flush))

        command = found.command()
        env = await asyncio.to_thread(self.docker.env)
        env = {**env, "EDEN_MAIN_FOLDER": self.project_key(copy), "EDEN_COPY": str(copy.cwd)}
        if container is not None:
            line = " ".join(
                [
                    f"EDEN_MAIN_FOLDER={_q(self.project_key(copy))}",
                    f"EDEN_COPY={_q(str(copy.cwd))}",
                    *(_q(part) for part in command),
                ]
            )
            command = self.docker.exec_argv(str(container["name"]), copy.cwd, line)
        task.last_action = "Running the project's setup…"
        self.hub.tasks._changed()
        self.note(task, f"Running the project's setup ({found.source})…")
        started = time.monotonic()
        proc = runproc.Proc(command, copy.cwd, env, take)
        self.running[slug] = proc
        code: int | None = None
        try:
            try:
                await proc.start()
            except OSError as exc:
                self.note(task, f"Couldn't run the setup: {exc.strerror or exc}")
                return None
            try:
                code = await asyncio.wait_for(proc.wait(), SETUP_SECONDS)
            except TimeoutError:
                await proc.stop(grace=2.0)
                code = None
        finally:
            self.running.pop(slug, None)
            for handle in flush_at:
                handle.cancel()
            flush()
        seconds = round(time.monotonic() - started)
        tail = "\n".join(lines[-TAIL_LINES:])
        if code == 0:
            said = self.tr(f"Setup finished in {seconds} s.")
        elif code is None:
            said = self.tr(
                f"Setup ran out of time after {int(SETUP_SECONDS // 60)} min and was stopped; "
                "the session starts anyway."
            )
        else:
            said = self.tr(
                f"Setup failed (exit {code}) after {seconds} s; the session starts anyway."
            )
        self.hub.tasks._log(task, "system", said + (f"\n```\n{tail}\n```" if tail else ""))
        self.hub.emit("code_setup_output", id=task.id, slug=slug, lines=[], done=True, code=code)
        return code

    # ── the window ──

    def _where(self, msg: dict[str, Any]) -> tuple[Path, str, Any, Any] | None:
        """(the folder, the project's name, the session, its copy) a command is about."""
        task = code_task(self.hub, msg)
        desk = self.desk()
        if task is not None:
            copy = desk.store().by_path(task.cwd) if desk is not None and task.workspace else None
            return task.cwd, copy.project if copy else task.cwd.name, task, copy
        try:
            folder = self.hub.tasks.resolve_dir(str(msg.get("directory") or ""))
        except (ValueError, OSError):
            return None
        return folder, folder.name, None, None

    def state(self, folder: Path, project: str) -> dict[str, Any]:
        found, problem = devcontainer.read_setup(folder)
        image, image_problem = devcontainer.read_devcontainer(folder)
        return {
            "project": project,
            "setup": {"source": found.source, "text": found.text[:8000]} if found else None,
            "problem": problem,
            "devcontainer": image.describe() if image else "",
            "devcontainer_source": image.source if image else "",
            "devcontainer_problem": image_problem,
        }

    async def cmd_state(self, msg: dict[str, Any]) -> None:
        where = self._where(msg)
        if where is None:
            return
        folder, project, task, copy = where
        found = await asyncio.to_thread(self.state, folder, project)
        on = project in (self.hub.prefs.feature(PREF_PROJECTS) or [])
        docker = await self.docker.check() if on else ""
        info = self.container_of(task) if task is not None else None
        self.hub.emit(
            "code_setup",
            key=f"id:{task.id}" if task is not None else f"dir:{msg.get('directory')}",
            **found,
            container={
                "on": on,
                "image": (self.hub.prefs.feature(PREF_IMAGES) or {}).get(project, ""),
                "docker": self.tr(docker) if docker else "",
                "running": info,
            },
            copy=copy.slug if copy is not None else "",
            output=self.output.get(copy.slug, [])[-OUTPUT_KEEP:] if copy is not None else [],
            busy=bool(copy is not None and copy.slug in self.running),
        )

    async def cmd_run(self, msg: dict[str, Any]) -> None:
        """The owner's Run setup again, in a session's copy (never the main folder: a setup
        makes a fresh copy ready, the main folder is the owner's own)."""
        where = self._where(msg)
        task = where[2] if where else None
        copy = where[3] if where else None
        if task is None or copy is None:
            self.hub.emit("caption", text=self.tr("There's no copy to set up here."))
            return
        if task.busy or copy.slug in self.running:
            self.hub.emit(
                "caption",
                text=self.tr("It's still working. Wait for it to finish, then run the setup."),
            )
            return
        found, problem = await asyncio.to_thread(devcontainer.read_setup, copy.cwd)
        if found is None:
            self.hub.emit(
                "caption",
                text=self.tr(problem or "There's no setup in this project: add .jarvis/setup.sh."),
            )
            return
        await self.setup(task, copy, self.container_of(task))
        await self.cmd_state({"id": task.id})


def _q(text: str) -> str:
    import shlex

    return shlex.quote(text)


class _Options:
    """What a session's connection gets (TaskManager.option_hooks): the hook that runs its
    commands in its copy's container, and the container's socket through the sandbox. The
    socket is all of docker to whatever reaches it (docker run -v $HOME:/h), so it's let
    through only because the hook leaves no Bash step on the Mac: every one becomes the
    exact docker exec line for this container (SetupDesk.is_own_line), and with the
    container gone they're refused."""

    def __init__(self, desk: SetupDesk) -> None:
        self.desk = desk

    def apply(self, task: Any, options: Any) -> None:
        if task.kind != "code" or other_agent(task):
            return
        info = self.desk.container_of(task)
        if info is None:
            return
        hooks = dict(options.hooks or {})
        hooks["PreToolUse"] = [*hooks.get("PreToolUse", []), self.desk.hook(task)]
        options.hooks = hooks
        socket = self.desk.sockets.get(str(info.get("name")), "")
        sandbox = options.sandbox if isinstance(options.sandbox, dict) else None
        if socket and sandbox is not None and sandbox.get("enabled"):
            network = dict(sandbox.get("network") or {})
            network["allowUnixSockets"] = [*network.get("allowUnixSockets", []), socket]
            options.sandbox = {**sandbox, "network": network}

    def key(self, task: Any) -> Any:
        info = self.desk.container_of(task)
        return info.get("name") if info else None


def install(hub: Any) -> None:
    desk = SetupDesk(hub)
    hub.code_setup = desk  # (for the tests)
    copies = getattr(hub, "code_desk", None)
    if copies is not None:
        copies.on_new_copy.append(desk.on_new_copy)
        copies.on_copy_gone.append(desk.on_copy_gone)
    hub.tasks.option_hooks.append(_Options(desk))
    hub.register_command("code_setup_state", lambda msg: hub._spawn(desk.cmd_state(msg)))
    hub.register_command("code_setup_run", lambda msg: hub._spawn(desk.cmd_run(msg)))
    hub.register_loop("code_containers_tidy", desk.tidier)
