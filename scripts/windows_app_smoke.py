"""Launches the installed Windows app and looks at it the way a screen reader does: finds its
window, waits for the page to load, reads the window through UI Automation, takes a screenshot,
and tails the backend's log. Run by the Windows workflow after the installer has been run
silently:

    uv run python scripts/windows_app_smoke.py jarvis|eden-code

Writes app-smoke/<app>.png, <app>-outline.txt and <app>-backend.log; exits 1 if the window never
showed, the page never loaded, or a screen reader couldn't see its controls.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

APPS = {
    "jarvis": {
        "folder": "J.A.R.V.I.S.",
        "product": "J.A.R.V.I.S.",
        "title": "jarvis",
        "logs": "Jarvis",
        "expect": ["Talk to Jarvis"],
    },
    "eden-code": {"folder": "Eden Code", "title": "eden code", "logs": "Eden Code", "expect": []},
    # askeden.com in a window of its own (no engine, no Claude Code in it: the page is the site's)
    "ask-eden": {
        "folder": "Ask Eden",
        "title": "askeden.com",
        "logs": "Ask Eden",
        "expect": [],
    },  # (its window is titled by the page: "Eden · askeden.com")
}
OUT = Path("app-smoke")


def hotkey_state(label: str) -> str:
    """Whether a key combination ("Ctrl+Alt+J") is free right now, or held by a program (RegisterHotKey
    says so: error 1409 is "already registered")."""
    import ctypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    *names, key = label.split("+")
    mods = 0x4000  # MOD_NOREPEAT
    for name in names:
        mods |= {"Alt": 0x1, "Ctrl": 0x2, "Shift": 0x4, "Win": 0x8}[name]
    vk = {"Space": 0x20, "Enter": 0x0D}.get(key) or ord(key.upper())
    if user32.RegisterHotKey(None, 0x6A76, mods, vk):
        user32.UnregisterHotKey(None, 0x6A76)
        return "free"
    return f"taken (error {ctypes.get_last_error()})"


TALK_KEYS = ("Ctrl+Alt+J", "Ctrl+Alt+K", "Ctrl+Alt+H", "Ctrl+Alt+L", "Alt+Shift+Space")


def hotkeys_free() -> dict[str, str]:
    return {label: hotkey_state(label) for label in TALK_KEYS}


def page_probe(port: int, expressions: dict[str, str]) -> tuple[dict, list[str]]:
    """What the app's page says for each JavaScript expression, and the errors it logged, through
    the debugging port the app was started with. ({}, [reason]) when the port doesn't answer."""
    import json
    import urllib.request

    from websockets.sync.client import connect

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=10) as r:
            pages = json.load(r)
        page = next(p for p in pages if p.get("type") == "page" and "127.0.0.1" in p.get("url", ""))
        results: dict = {}
        logged: list[str] = []
        with connect(page["webSocketDebuggerUrl"], max_size=None, open_timeout=10) as ws:
            counter = [0]

            def call(method: str, params: dict | None = None) -> dict:
                counter[0] += 1
                ws.send(json.dumps({"id": counter[0], "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(ws.recv(timeout=20))
                    if msg.get("id") == counter[0]:
                        return msg.get("result", {})
                    if msg.get("method") == "Runtime.exceptionThrown":
                        d = msg["params"]["exceptionDetails"]
                        logged.append(
                            f"exception: {(d.get('exception') or {}).get('description') or d.get('text')}"
                        )
                    elif msg.get("method") == "Runtime.consoleAPICalled":
                        a = msg["params"]
                        if a.get("type") in ("error", "warning", "assert"):
                            said = " ".join(
                                str(x.get("value", x.get("description", ""))) for x in a["args"]
                            )
                            logged.append(f"console.{a['type']}: {said}")

            call(
                "Runtime.enable"
            )  # the page's earlier messages come again, ahead of the first answer
            for name, expression in expressions.items():
                got = call(
                    "Runtime.evaluate",
                    {"expression": expression, "returnByValue": True, "awaitPromise": True},
                )
                results[name] = (got.get("result") or {}).get("value", got.get("exceptionDetails"))
        return results, logged
    except Exception as exc:  # noqa: BLE001 - a probe: it never fails the check
        return {}, [f"the page could not be asked: {type(exc).__name__}: {exc}"]


PAGE_QUESTIONS = {
    "platform": "navigator.platform",
    "title": "document.title",
    "hint": "document.getElementById('hint') && document.getElementById('hint').textContent.replace(/\\s+/g, ' ').trim()",
    "state line": "document.getElementById('state-line') && document.getElementById('state-line').textContent",
    "feature scripts": "[...document.scripts].filter((s) => /features\\//.test(s.src)).length",
    "accessibility.js loaded": "[...document.scripts].some((s) => /accessibility\\.js/.test(s.src))",
    "jarvisAccessibility": "typeof window.jarvisAccessibility === 'object' ? Object.keys(window.jarvisAccessibility).join(',') : typeof window.jarvisAccessibility",
    "accessibility state": "window.jarvisAccessibility && window.jarvisAccessibility.state ? JSON.stringify(window.jarvisAccessibility.state()).slice(0, 400) : null",
    "contrast": "document.documentElement.dataset.contrast || ''",
    "talk key": "window.jarvisShell && window.jarvisShell.askLabel ? window.jarvisShell.askLabel() : null",
    "talk key raw": "String(window.jarvisShell && window.jarvisShell.askLabel && window.jarvisShell.askLabel())",
    "shell object": "typeof window.jarvisShell === 'object' && window.jarvisShell ? Object.keys(window.jarvisShell).join(',') : typeof window.jarvisShell",
    "app bridge": "window.jarvisApp ? Object.keys(window.jarvisApp).join(',') : 'none'",
    "shell settings group": "!!document.getElementById('shell-group')",
    "shown talk key": "document.getElementById('shell-key-ask') ? document.getElementById('shell-key-ask').textContent : 'no such element'",
}


def main(which: str) -> int:
    if sys.platform != "win32":
        print("This runs on Windows.")
        return 0
    from jarvis import winhands, winuia

    app = APPS[which]
    OUT.mkdir(exist_ok=True)
    local = Path(os.environ["LOCALAPPDATA"])
    folder = local / "Programs" / app["folder"]
    exes = (
        [p for p in folder.glob("*.exe") if not p.name.lower().startswith(("uninstall", "elevate"))]
        if folder.is_dir()
        else []
    )
    failures: list[str] = []
    print(f"install folder {folder}: {[p.name for p in exes]}", flush=True)
    if not exes:
        print("FAILED the app isn't installed")
        return 1
    # Windows stops at 260 characters in a path unless long paths are switched on: how long is the
    # longest one inside the install, and so how long a user name still leaves room for it.
    longest = sorted((len(str(p.relative_to(folder))) for p in folder.rglob("*")), reverse=True)[:3]
    # (C:\Users\<name>\AppData\Local\Programs\<app>\<inside>, and a path may be 259 long)
    fixed = len("C:\\Users\\") + len("\\AppData\\Local\\Programs\\") + len(app["folder"]) + 1
    print(
        f"longest paths inside the install: {longest}; "
        f"a user name up to {259 - fixed - longest[0]} characters is safe",
        flush=True,
    )
    # Claude's own program, which Eden Code and Jarvis run their work through: is it in the install?
    claude = next(iter(folder.rglob("claude.exe")), None)
    if which == "ask-eden":
        pass  # (Ask Eden is the website in a window: it has no engine of its own)
    elif claude is None:
        print("claude.exe: NOT in the install (Claude Code would have to be installed separately)")
    else:
        try:
            ran = subprocess.run(
                [str(claude), "--version"], capture_output=True, text=True, timeout=60, check=False
            )
            print(
                f"claude.exe: {claude.relative_to(folder)} says {ran.stdout.strip()!r} {ran.stderr.strip()[:200]!r}"
            )
        except (OSError, subprocess.SubprocessError) as exc:
            failures.append(f"claude.exe doesn't run: {exc}")
    if which == "jarvis":
        print(f"key combinations before the app starts: {hotkeys_free()}", flush=True)
    console = open(OUT / f"{which}-console.txt", "w", encoding="utf-8")  # noqa: SIM115 - the app's own output (main process)
    debug_port = 9333
    proc = subprocess.Popen(
        [str(exes[0]), "--enable-logging=stderr", f"--remote-debugging-port={debug_port}"],
        stdout=console,
        stderr=subprocess.STDOUT,
    )
    window = None
    for _ in range(180):
        time.sleep(0.5)
        window = next(
            (w for w in winhands.list_windows() if app["title"] in w["title"].lower()), None
        )
        if window:
            break
    print(f"window: {window and window['title']!r} ({window and window['app']})", flush=True)
    if not window:
        failures.append("the window never showed")
        print("windows open:", [w["title"] for w in winhands.list_windows()])
    outline = {"text": "", "lines": 0}
    if window:
        time.sleep(3)
        winhands.focus_window(window["handle"])
        loaded = False
        for _ in range(120):  # the page, once the backend has answered (up to a minute)
            time.sleep(0.5)
            outline = winuia.outline(max_nodes=400, max_chars=20000)
            if outline["lines"] >= 12 and "loading" not in outline["text"].lower()[:200]:
                loaded = True
                break
        print(f"outline: {outline['lines']} lines, loaded={loaded}", flush=True)
        if not loaded:
            failures.append("the page never loaded as something a screen reader can read")
        for want in app["expect"]:
            if want.lower() not in outline["text"].lower():
                failures.append(f"a screen reader doesn't find {want!r}")
        (OUT / f"{which}-outline.txt").write_text(outline["text"], encoding="utf-8")
        png, w, h, _rect = winhands.screenshot(1, 1280)
        (OUT / f"{which}.png").write_bytes(png)
        print(f"screenshot {w}x{h}", flush=True)
        time.sleep(2)  # the feature scripts, which load after the page does
        answers, logged = page_probe(debug_port, PAGE_QUESTIONS)
        for _ in range(30):  # the app tells the page its keys a moment after the page has loaded
            if answers.get("talk key") or not answers:
                break
            time.sleep(1)
            answers, logged = page_probe(debug_port, PAGE_QUESTIONS)
        print("--- what the page says about itself:")
        for name, value in answers.items():
            print(f"  {name}: {value!r}", flush=True)
        print(f"--- {len(logged)} console error(s)/warning(s) in the page:")
        for line in logged[:30]:
            print(f"  {line[:400]}", flush=True)
        if which == "jarvis":
            said = answers.get("talk key")
            if not isinstance(said, str) or not said:
                failures.append("the page doesn't say which key talks to it")
            elif hotkey_state(said) == "free":
                failures.append(
                    f"the page says {said} talks to it, but the app doesn't hold that key"
                )
            else:
                print(f"the app holds {said}, as the page says", flush=True)
        (OUT / f"{which}-page.txt").write_text(
            "\n".join(f"{k}: {v!r}" for k, v in answers.items()) + "\n" + "\n".join(logged),
            encoding="utf-8",
        )
    log_dirs = [local / app["logs"] / "Logs", local / "Jarvis" / "Logs"]
    seen: set[Path] = set()
    for folder in log_dirs:
        for name in ("backend.log", "jarvis.log"):
            path = folder / name
            if path.is_file() and path not in seen:
                seen.add(path)
                every = path.read_text(encoding="utf-8", errors="replace").splitlines()
                (OUT / f"{which}-{folder.parent.name}-{name}").write_text(
                    "\n".join(every), encoding="utf-8"
                )
                print(f"--- {path}: {len(every)} lines; the errors and warnings, once each:")
                shown: set[str] = set()
                for i, line in enumerate(every):
                    if "Traceback" in line:  # its last line says what went wrong
                        j = i + 1
                        while j < len(every) and every[j].startswith((" ", "\t")):
                            j += 1
                        text = f"  {every[i - 1][:100] if i else ''}\n    -> {every[j] if j < len(every) else ''}"
                    elif re.search(r"\b(ERROR|WARNING|CRITICAL)\b", line):
                        text = line
                    else:
                        continue
                    key = re.sub(r"^[\d:,. -]+", "", text)[:120]
                    if key not in shown and len(shown) < 40:
                        shown.add(key)
                        print(text[:500], flush=True)
    if which == "jarvis":
        # The installer's own shortcuts, with no key on them (the running app holds the Talk key; a key on
        # the shortcut would be held by Windows instead, and the app could not have it).
        places = [
            Path(os.environ["USERPROFILE"]) / "Desktop",
            Path(os.environ.get("PUBLIC", r"C:\Users\Public")) / "Desktop",
            Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs",
            Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData"))
            / "Microsoft"
            / "Windows"
            / "Start Menu"
            / "Programs",
        ]
        links = [
            p
            for base in places
            if base.is_dir()
            for p in base.rglob("*.lnk")
            if "j.a.r.v.i.s" in p.name.lower()
        ]
        print(f"shortcuts made by the installer: {[str(p) for p in links]}", flush=True)
        if not links:
            failures.append("the installer made no shortcut")
        for lnk in links:
            ran = subprocess.run(
                ["powershell.exe", "-NoProfile", "-Command",
                 f"$s = (New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}'); "
                 "'key=' + $s.Hotkey; 'target=' + $s.TargetPath"],
                capture_output=True, text=True, timeout=60, check=False,
            )  # fmt: skip
            said = " | ".join(x.strip() for x in ran.stdout.splitlines() if x.strip())
            print(f"  {lnk.name}: {said}", flush=True)
            if "target=" not in said or said.endswith("target="):
                failures.append(f"the shortcut {lnk.name} has no program it opens")
            if "key=" in said and not said.split("|")[0].strip() == "key=":
                failures.append(
                    f"the shortcut {lnk.name} has a key of its own ({said.split('|')[0].strip()})"
                )
        run = subprocess.run(
            ["reg", "query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"],
            capture_output=True, text=True, check=False,
        )  # fmt: skip
        mine = [line.strip() for line in run.stdout.splitlines() if "--hidden" in line]
        print(f"opens at sign-in: {mine or 'NOT in the Run list'}", flush=True)
        if not mine:
            failures.append("it didn't put itself in the sign-in list")
    print("\n--- what a screen reader reads ---\n" + outline["text"][:3500], flush=True)
    proc.kill()
    console.close()
    shown = (
        (OUT / f"{which}-console.txt").read_text(encoding="utf-8", errors="replace").splitlines()
    )
    problems = [
        line
        for line in shown
        if any(
            w in line for w in ("didn't load", "Error", "error:", "Uncaught", "ENOENT", "failed")
        )
    ]
    print("--- the app's own output: " + f"{len(shown)} lines, {len(problems)} look like problems")
    print("\n".join(problems[:40]))
    subprocess.run(["taskkill", "/IM", exes[0].name, "/F", "/T"], capture_output=True, check=False)
    for f in failures:
        print("FAILED", f)
    print("ok" if not failures else f"{len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "jarvis"))
