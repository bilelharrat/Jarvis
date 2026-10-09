"""A smoke test of the Windows hands on a real Windows desktop (run by the Windows workflow in
CI, or by hand on a PC): list the displays, take a screenshot, open Notepad, find its window,
type into it, read it back through UI Automation, press a control by name, and run the
guard's probe. It prints one line per step and exits 1 if any failed.

    uv run python scripts/windows_desktop_smoke.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time

report: list[tuple[str, bool, str]] = []


def step(name: str, fn) -> object:
    """Run one check: a truthy result passes (a string is its note), anything else fails."""
    started = time.monotonic()
    try:
        result = fn()
        ok = bool(result)
        note = "" if result is True else str(result)[:700]
    except Exception as exc:  # noqa: BLE001
        result, ok, note = None, False, f"{type(exc).__name__}: {exc}"[:600]
    seconds = time.monotonic() - started
    report.append((name, ok, note))
    print(f"{'ok    ' if ok else 'FAILED'} {name} [{seconds:.1f}s]  {note}", flush=True)
    return result


def dump(limit: int = 90) -> str:
    """What UI Automation reports under the window in front, raw (for finding out)."""
    from jarvis import winhands, winuia

    with winuia.Apartment():
        raw = winuia.Raw()
        top = raw.foreground()
        rows = []
        for el in raw.everything_under(top)[:limit]:
            n = raw.node(el)
            rows.append(
                f"{n['type'][:-7] or '?'}|{n['name'][:40]!r}|id={n['id'][:24]}|off={int(n['offscreen'])}"
                f"|tog={n['toggle']}|exp={n['expand']}|sel={n['selected']}"
            )
        return (
            f"front is {winhands.foreground_window().get('title')!r}; {len(rows)}:\n"
            + "\n".join(rows)
        )


def said(out: dict) -> str:
    """The words in a tool's answer (an error is marked, the way Claude would see it)."""
    words = "\n".join(c.get("text", "") for c in out.get("content", []) if c.get("type") == "text")
    return ("ERROR: " if out.get("is_error") else "") + words


def tool_steps(step, notepad: dict) -> None:
    """The tools Claude is given (computer.py), called as it calls them, through the guard."""
    import asyncio

    from jarvis import computer, hands_guard, winhands

    real_server = computer.create_sdk_mcp_server
    computer.create_sdk_mcp_server = lambda **k: k["tools"]

    async def declined(*_args) -> bool:  # a card would be asked; nobody is here to say yes
        return False

    guard = hands_guard.HandsGuard(
        reads=lambda: {}, words=lambda: "", asked=lambda _kind: False, send=declined
    )
    tools = {t.name: t.handler for t in computer.build_server(computer.Screen(), guard)}
    computer.create_sdk_mcp_server = (
        real_server  # (the app's own server is built the real way later)
    )

    def call(tool: str, args: dict) -> str:
        return said(asyncio.run(tools[tool](args)))

    def back() -> None:
        # (a hosted runner's own windows come to the front now and then)
        winhands.focus_window(notepad["handle"])
        time.sleep(0.4)

    def check(label: str, tool: str, wanted: tuple[str, ...], **args):
        def run():
            back()
            got = call(tool, args)
            assert not got.startswith("ERROR") and all(w in got for w in wanted), got[:600]
            return got[:300]

        step(label, run)

    check("tool list_windows", "list_windows", ("(in front)", "Notepad", "Display 1"))
    for _ in range(2):  # out of the menu bar, back to the page
        winhands.post_keys("escape")
        time.sleep(0.3)
    check("tool read_window", "read_window", ("Window:", "Hello from Jarvis", "File"))
    check("tool whats_focused", "whats_focused", ("Focus:", "Text Editor", "notepad.exe"))
    check("tool type_text (through the guard)", "type_text", ("Typed it",), text=" and more")
    time.sleep(0.5)
    check("what was typed is read back", "read_window", ("contains “and more”",))
    check("tool press_button (through the guard)", "press_button", ("Pressed", "File"), name="File")
    time.sleep(0.8)
    check("the menu it opened is read", "read_window", ("menu item", "Save"))
    check("tool press_keys escape", "press_keys", ("Pressed",), keys="escape")
    check("tool press_keys ctrl+a", "press_keys", ("Pressed",), keys="ctrl+a")
    check("tool focus_window", "focus_window", ("in front",), title="notepad")

    def screen():
        out = asyncio.run(tools["see_screen"]({}))
        images = [c for c in out.get("content", []) if c.get("type") == "image"]
        assert images and len(images[0]["data"]) > 1000, said(out)
        return f"{len(images[0]['data'])} base64 characters"

    step("tool see_screen", screen)
    check("tool find_files", "find_files", ("Nothing found",), query="zzz-no-such-file-qq")


FORM = r"""
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Jarvis test form'; $f.Width = 420; $f.Height = 300; $f.StartPosition = 'CenterScreen'
$l = New-Object System.Windows.Forms.Label
$l.Text = 'Sign in to the test'; $l.Left = 10; $l.Top = 10; $l.Width = 360
$e = New-Object System.Windows.Forms.TextBox
$e.AccessibleName = 'Email'; $e.Text = 'ann@example.com'; $e.Left = 10; $e.Top = 40; $e.Width = 300
$p = New-Object System.Windows.Forms.TextBox
$p.AccessibleName = 'Password'; $p.UseSystemPasswordChar = $true; $p.Text = 'hunter2-secret'
$p.Left = 10; $p.Top = 70; $p.Width = 300
$c = New-Object System.Windows.Forms.CheckBox
$c.Text = 'Remember me'; $c.Left = 10; $c.Top = 100; $c.Width = 200
$b = New-Object System.Windows.Forms.Button
$b.Text = 'Sign in'; $b.Left = 10; $b.Top = 130
$b.Add_Click({ $l.Text = 'Signed in as ' + $e.Text })
$f.Controls.AddRange(@($l, $e, $p, $c, $b))
[void]$f.ShowDialog()
"""

PAGE = """<!doctype html><meta charset="utf-8"><title>Jarvis test page</title>
<h1>Hello from the page</h1>
<p>Read <a href="https://example.com/docs?token=zzz">the docs</a> now.</p>
<button onclick="document.getElementById('o').textContent='it was pressed'">Press me</button>
<p id="o">not yet</p>
<label>Your name <input value="Ann"></label>
<label>Secret <input type="password" value="hunter2-page"></label>
"""


def wait_for_window(words: str, seconds: int = 40):
    from jarvis import winhands

    for _ in range(seconds * 2):
        time.sleep(0.5)
        hit = next((w for w in winhands.list_windows() if words in w["title"].lower()), None)
        if hit:
            return hit
    return None


def app_steps(step) -> None:
    """Apps other than Notepad: a classic Windows form (labels, a field, a password, a check box,
    a button) and a web page in Edge, read and used by name the way a screen reader would."""
    import tempfile
    from pathlib import Path

    from jarvis import winhands, winuia

    folder = Path(tempfile.mkdtemp())
    script = folder / "form.ps1"
    script.write_text(FORM, encoding="utf-8")
    form = subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", str(script)]
    )
    window = wait_for_window("jarvis test form")
    if window:
        time.sleep(1.5)
        winhands.focus_window(window["handle"])
        time.sleep(0.8)

        def shown():
            text = winuia.outline()["text"]
            wanted = ("Sign in to the test", "Email", "ann@example.com", "Remember me", "Sign in")
            missing = [w for w in wanted if w not in text]
            assert not missing, f"missing {missing}: {text[:500]}"
            return text[:400]

        step("a Windows form is read", shown)

        def password():
            text = winuia.outline()["text"]
            assert "hunter2" not in text, f"the password is in what is read: {text[:500]}"
            assert "password field: Password" in text, text[:500]
            assert "hunter2" not in str(winuia.focused()), "the password is in the focus"
            return "named, never read"

        step("its password field is named but never read", password)

        def check_box():
            first = winuia.press("Remember me")
            assert first.get("found"), first
            time.sleep(0.5)
            text = winuia.outline()["text"]
            assert re.search(r"check box: Remember me.*\bon\b", text), text[:500]
            return "pressed, now on"

        step("a check box is turned on by name", check_box)

        def button():
            result = winuia.press("Sign in", exact=True)
            assert result.get("found"), result
            if "x" in result:
                winhands.post_mouse("click", result["x"], result["y"])
            time.sleep(0.8)
            text = winuia.outline()["text"]
            assert "Signed in as ann@example.com" in text, text[:500]
            return "pressed; the form answered"

        step("a button is pressed by name and the form answers", button)

        def typed():
            result = winuia.set_text("Email", "bob@example.com")
            assert result.get("ok"), result
            time.sleep(0.4)
            assert "bob@example.com" in winuia.outline()["text"]
            return "field set"

        step("a field is filled in by name", typed)
    else:
        step("a Windows form is read", lambda: False)
    form.kill()
    subprocess.run(
        ["taskkill", "/F", "/FI", "WINDOWTITLE eq Jarvis test form"],
        capture_output=True,
        check=False,
    )

    page = folder / "page.html"
    page.write_text(PAGE, encoding="utf-8")
    edge = next(
        (
            c
            for c in (
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            )
            if Path(c).is_file()
        ),
        None,
    )
    if not edge:
        step("a web page in Edge", lambda: "Edge isn't on this machine")
        return
    browser = subprocess.Popen(
        [edge, "--no-first-run", "--no-default-browser-check", f"--user-data-dir={folder / 'edge'}",
         "--new-window", page.as_uri()]
    )  # fmt: skip
    window = wait_for_window("jarvis test page", 60)
    if window:
        time.sleep(3.0)
        winhands.focus_window(window["handle"])
        time.sleep(1.0)

        def read_page():
            text = ""
            for _ in range(10):  # the browser builds its accessibility tree once asked
                text = winuia.outline(max_nodes=400, max_chars=20000)["text"]
                if "Hello from the page" in text:
                    break
                time.sleep(1.0)
            wanted = ("Hello from the page", "the docs", "Press me", "Your name", "Ann")
            missing = [w for w in wanted if w not in text]
            assert not missing, f"missing {missing}: {text[:900]}"
            assert "hunter2" not in text, "the page's password is in what is read"
            assert "token=zzz" not in text
            return text[:300]

        step("a web page in Edge is read", read_page)

        def address():
            found = winuia.page_address()
            assert found.get("title") == "Jarvis test page", found
            assert "page.html" in found.get("url", ""), found
            return str(found)[:200]

        step("the page's address and title are found", address)

        def press_on_page():
            result = winuia.press("Press me")
            assert result.get("found"), result
            if "x" in result:
                winhands.post_mouse("click", result["x"], result["y"])
            time.sleep(1.0)
            assert "it was pressed" in winuia.outline(max_nodes=400)["text"]
            return "pressed; the page answered"

        step("a button on the page is pressed by name", press_on_page)
    else:
        step("a web page in Edge is read", lambda: "Edge showed no window")
    browser.kill()
    subprocess.run(["taskkill", "/IM", "msedge.exe", "/F"], capture_output=True, check=False)


def main() -> int:
    if sys.platform != "win32":
        print("This runs on Windows.")
        return 0
    from jarvis import win_tools, winhands, winuia

    step(
        "displays",
        lambda: (
            (shown := winhands.monitors())
            and f"{len(shown)} display(s), main {shown[0]['w']}x{shown[0]['h']}"
        ),
    )

    def shot():
        png, w, h, rect = winhands.screenshot(1, 1280)
        assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
        assert 0 < w <= 1280 and h > 0
        return f"{w}x{h} px PNG, {len(png)} bytes, display at {rect}"

    step("screenshot", shot)
    step(
        "start menu apps",
        lambda: (
            (apps := win_tools.start_apps())
            and f"{len(apps)} apps; Notepad -> {getattr(win_tools.match_app('notepad', apps), 'name', None)}"
        ),
    )

    # A runner's own pop-ups (Feedback Hub) take the keyboard from whatever is open: close them.
    for name in ("PilotshubApp.exe", "FeedbackHub.exe", "Widgets.exe"):
        subprocess.run(["taskkill", "/IM", name, "/F"], capture_output=True, check=False)
    proc = subprocess.Popen(["notepad.exe"])
    notepad = None
    for _ in range(40):
        time.sleep(0.5)
        notepad = next(
            (
                w
                for w in winhands.list_windows()
                if "notepad" in w["title"].lower() or "notepad" in (w["app"] or "").lower()
            ),
            None,
        )
        if notepad:
            break
    step(
        "notepad opened and listed", lambda: notepad and f"{notepad['title']!r} ({notepad['app']})"
    )
    if notepad:
        time.sleep(2.0)  # (a new app drops the first keys it is sent)
        step(
            "window brought to the front",
            lambda: winhands.focus_window(notepad["handle"]) or "NOT in front",
        )
        step(
            "it is the window in front",
            lambda: (
                (w := winhands.foreground_window()).get("handle") == notepad["handle"]
                and f"{w['title']!r}"
            ),
        )
        time.sleep(1.0)
        step("typed with the keyboard", lambda: winhands.post_text("Hello from Jarvis") or True)
        time.sleep(1.5)

        def read():
            info = winuia.outline()
            focus = winuia.focused()
            blob = info["text"] + " " + str(focus)
            assert "Hello from Jarvis" in blob, (
                f"not in what was read: {info['text'][:500]!r} / {focus!r}"
            )
            return f"{info['lines']} lines; focus {focus.get('role')} {focus.get('name')!r}"

        step("window read back through UI Automation", read)
        step(
            "outline shows controls",
            lambda: (
                (o := winuia.outline())["lines"] >= 3 and f"{o['lines']} lines:\n{o['text'][:700]}"
            ),
        )
        step(
            "a control found by name",
            lambda: (f := winuia.press("File", find_only=True)).get("found") and f"found {f}",
        )
        step(
            "guard probe: focus",
            lambda: (
                (p := winuia.probe_focus()).get("bundle")
                and f"{p['bundle']} / {p['window']!r} / focused {p.get('focused')}"
            ),
        )
        step("page address of a non-browser is empty", lambda: winuia.page_address() == {})
        step("keys parsed and sent", lambda: winhands.post_keys("ctrl+a") or True)
        step(
            "a menu pressed by name opens it",
            lambda: (r := winuia.press("File")).get("found") and f"pressed {r.get('name')!r}",
        )
        time.sleep(1.0)
        step(
            "what the menu offers is read",
            lambda: (
                ("Save" in (o := winuia.outline())["text"] or "New" in o["text"])
                and o["text"][:400]
            ),
        )
        winhands.post_keys("escape")
        time.sleep(0.5)
        winhands.focus_window(notepad["handle"])
        time.sleep(0.5)
        tool_steps(step, notepad)

    # An app Jarvis has never been told about, opened by name, read, and used by name.
    def calculator():
        apps = win_tools.start_apps()
        found = win_tools.match_app("calculator", apps)
        assert found is not None and not isinstance(found, list), (
            f"no single Calculator in the Start menu: {found}"
        )
        win_tools.launch(found)
        window = None
        for _ in range(40):
            time.sleep(0.5)
            window = next(
                (w for w in winhands.list_windows() if "calculator" in w["title"].lower()), None
            )
            if window:
                break
        assert window, "Calculator never showed"
        time.sleep(2.0)
        winhands.focus_window(window["handle"])
        time.sleep(1.0)
        pressed = []
        # The buttons are named "Seven", "Plus" in some versions of Calculator and "7", "Add" in
        # others: what Jarvis presses is whatever its outline of the window says.
        for names in (("7", "Seven"), ("Add", "Plus"), ("8", "Eight"), ("Equals",)):
            for name in names:
                result = winuia.press(name, exact=True)
                if result.get("found"):
                    break
            pressed.append((names[0], bool(result.get("found")), "x" in result))
            if "x" in result:  # nothing to invoke: a click on it, as press_button does
                winhands.post_mouse("click", result["x"], result["y"])
            time.sleep(0.4)
        text = winuia.outline()["text"]
        if not all(found for _n, found, _c in pressed):
            print(f"--- everything UI Automation sees in front ---\n{dump(400)}", flush=True)
            print(f"--- what Jarvis is shown ---\n{text}", flush=True)
            raise AssertionError(
                f"controls not found: {pressed}; "
                f"front {winhands.foreground_window().get('title')!r}; "
                f"windows {[w['title'] for w in winhands.list_windows()][:6]}"
            )
        lines = [line.strip() for line in text.splitlines()]
        shown = [line for line in lines if re.search(r"(^|\W)15(\W|$)", line)]
        assert shown, f"7 + 8 isn't on the display: {text[:600]}"
        display = shown
        return f"7 + 8: {display}"

    step("Calculator opened by name, 7 + 8 pressed by name, the answer read", calculator)
    subprocess.run(["taskkill", "/IM", "CalculatorApp.exe", "/F"], capture_output=True, check=False)

    app_steps(step)

    # The brain: Claude Code started with JARVIS's own options (a system prompt of about 40,000
    # characters, which Windows' command line cannot hold: longcmd.py puts it in a file). No
    # sign-in is needed to start it; this fails if the program won't start or won't take the options.
    def claude_code():
        import asyncio

        from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

        from jarvis import longcmd
        from jarvis.config import Settings
        from jarvis.hub import Hub

        assert longcmd.install(), "the fix for the long command line is not in place"

        async def start():
            hub = Hub(Settings(), poll=False)
            try:
                await asyncio.wait_for(hub._connect(), 120)
                options = hub.client.options
                transport = SubprocessCLITransport(prompt="", options=options)
                transport._cli_path = transport._find_cli()
                cmd = transport._build_command()
                return (
                    f"started; system prompt {len(options.system_prompt)} characters, "
                    f"command line {longcmd.line_length(cmd)} of 32767"
                )
            finally:
                client = getattr(hub, "client", None)
                if client is not None:
                    await client.disconnect()

        return asyncio.run(start())

    step("Claude Code starts with JARVIS's own options", claude_code)

    # Claude Code on Windows needs a shell tool: Git for Windows' bash, or PowerShell. A clean PC
    # (the usual laptop) has no Git and only Windows PowerShell, so try it that way: Git put
    # aside, and a PATH of Windows' own folders. The key is made up: the question is whether the
    # program gets past starting up (it then says the key is wrong), not whether it can answer.
    def claude_on_a_clean_pc():
        import shutil
        from pathlib import Path

        from claude_agent_sdk import ClaudeAgentOptions
        from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

        from jarvis import longcmd

        longcmd.install()
        exe = SubprocessCLITransport(prompt="", options=ClaudeAgentOptions())._find_cli()
        windows = os.environ.get("SystemRoot", r"C:\Windows")
        env = {
            **os.environ,
            "PATH": rf"{windows}\System32;{windows};{windows}\System32\WindowsPowerShell\v1.0",
            "ANTHROPIC_API_KEY": "sk-ant-api03-not-a-real-key",
        }
        for name in ("CLAUDE_CODE_GIT_BASH_PATH", "CLAUDECODE"):
            env.pop(name, None)
        git = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git"
        aside = git.with_name("Git-aside-for-test")
        moved = False
        try:
            if git.is_dir():
                git.rename(aside)
                moved = True
            ran = subprocess.run(
                [exe, "-p", "say hi", "--max-turns", "1", "--output-format", "json"],
                capture_output=True, text=True, timeout=120, env=env, check=False,
            )  # fmt: skip
        finally:
            if moved:
                aside.rename(git)
        said = (ran.stdout + ran.stderr).strip()
        assert "requires" not in said and "shell_tool_missing" not in said, said[:600]
        assert shutil.which("git", path=env["PATH"]) is None
        return f"git {'put aside' if moved else 'absent'}; exit {ran.returncode}; {said[:260]!r}"

    step("Claude Code starts on a PC with no Git and only Windows PowerShell", claude_on_a_clean_pc)

    # Where an email app password is kept: Windows Credential Manager, through keyring.
    def secret_store():
        from jarvis import mailbox

        vault = mailbox.Vault()
        who = "smoke-test@example.invalid"
        vault.set(who, "app-password-1234 zzzz")
        try:
            assert vault.get(who) == "app-password-1234 zzzz", "what came back is not what went in"
        finally:
            vault.delete(who)
        assert vault.get(who) is None, "it is still there after being deleted"
        import keyring

        return f"kept, read back and deleted ({type(keyring.get_keyring()).__name__})"

    step("the password store keeps and returns a secret", secret_store)

    # Windows' own voices, written to a file the way Jarvis uses them.
    def speech():
        import tempfile
        import wave
        from pathlib import Path

        out = Path(tempfile.mkdtemp()) / "hello.wav"
        listing = subprocess.run(
            [sys.executable, "-I", "-m", "jarvis.winsay", "-v", "?"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        ).stdout
        run = subprocess.run(
            [sys.executable, "-I", "-m", "jarvis.winsay", "-r", "190", "-o", str(out), "--data-format=LEI16@22050"],
            input=b"Hello from Jarvis.", capture_output=True, timeout=90, check=False,
        )  # fmt: skip
        assert out.is_file(), (
            f"no speech file; {run.stderr.decode(errors='replace')[:300]}; voices: {listing[:200]!r}"
        )
        with wave.open(str(out)) as w:
            seconds = w.getnframes() / w.getframerate()
        assert seconds > 0.4, f"only {seconds:.2f}s of speech"
        return f"{seconds:.1f}s of speech at {w.getframerate()} Hz; voices: {listing.strip().splitlines()[:3]}"

    step("Windows voice speaks to a file", speech)

    # What the microphone path does with a voice, without a microphone: Windows says a sentence
    # into a file, and the speech recogniser Jarvis listens with (Whisper) writes it down.
    def hearing():
        import tempfile
        from pathlib import Path

        from faster_whisper import decode_audio

        from jarvis import lang, listen

        out = Path(tempfile.mkdtemp()) / "request.wav"
        subprocess.run(
            [sys.executable, "-I", "-m", "jarvis.winsay", "-r", "170", "-o", str(out), "--data-format=LEI16@22050"],
            input=b"Open the calendar and read me my unread email.",
            capture_output=True, timeout=90, check=False,
        )  # fmt: skip
        assert out.is_file(), "no speech file"
        audio = decode_audio(str(out), sampling_rate=16000)
        started = time.monotonic()
        text = listen.Transcriber(lang.whisper_model("en", "base.en")).transcribe(audio)
        took = time.monotonic() - started
        assert "calendar" in text.lower() and "email" in text.lower(), f"heard {text!r}"
        return f"heard {text!r} ({took:.1f}s)"

    step("the recogniser hears a Windows voice", hearing)
    proc.kill()
    subprocess.run(["taskkill", "/IM", "notepad.exe", "/F"], capture_output=True, check=False)

    # Screen-reader mode switches itself on when a screen reader is running (Windows' flag for it,
    # or one of the well-known ones among the programs): none here, then Narrator, which comes
    # with Windows. (Narrator may not start on a machine with no sound.)
    def reader_running():
        from jarvis import osplat

        assert osplat.screen_reader_running() is False, (
            "a screen reader is reported with none running"
        )
        os.startfile(r"C:\Windows\System32\Narrator.exe")  # noqa: S606 - (through the shell: it asks to be elevated)
        started = False
        for _ in range(30):
            time.sleep(0.5)
            tasks = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq Narrator.exe"],
                capture_output=True,
                text=True,
                check=False,
            )
            started = started or "Narrator.exe" in tasks.stdout
            if osplat.screen_reader_running():
                break
        try:
            if not started:
                return "Narrator did not start on this machine, so there was nothing to detect"
            assert osplat.screen_reader_running(), "Narrator is running and it is not noticed"
            return "none, then Narrator: noticed"
        finally:
            subprocess.run(
                ["taskkill", "/IM", "Narrator.exe", "/F"], capture_output=True, check=False
            )

    step("a running screen reader is noticed", reader_running)
    failed = [n for n, ok, _ in report if not ok]
    print(
        f"\n{len(report) - len(failed)} ok, {len(failed)} failed"
        + (f": {failed}" if failed else "")
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
