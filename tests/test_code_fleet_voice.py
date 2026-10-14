"""The fleet by voice (F16): a named session's spoken diff ("what did session 3 change?",
file by file by function, never code read aloud) and everyone's changes in a line each, in
English and Mandarin, whatever the voice focus, with no model call."""

import subprocess

from test_code_voice_feature import close_all, hub_with, recording_sends, session

from jarvis import codesupervisor as cs


def git_project(path):
    path.mkdir(exist_ok=True)
    run = lambda *args: subprocess.run(["git", *args], cwd=path, check=True, capture_output=True)  # noqa: E731
    run("init", "-q")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "T")
    (path / "shop.py").write_text("def price(item):\n    return item.cost\n")
    run("add", ".")
    run("commit", "-q", "-m", "start")
    (path / "shop.py").write_text(
        "def price(item):\n    return round(item.cost * 1.2, 2)\n\n\ndef discount(item):\n    return 0\n"
    )
    return path / "shop.py"


def test_the_words_for_a_sessions_changes_and_everyones():
    assert cs.parse("what did session 3 change").kind == "changes"
    assert cs.parse("what did session 3 change").ref.num == 3
    assert cs.parse("what has the refactor session changed").ref.name == "refactor"
    assert cs.parse("read me the diff of session two").ref.num == 2
    assert cs.parse("what did everyone change").kind == "changes_all"
    assert cs.parse("第三个会话改了什么").ref.num == 3
    assert cs.parse("大家都改了什么").kind == "changes_all"
    # The focused session's own "what changed" stays voicecode's; catch-up stays catch-up.
    assert cs.parse("what changed") is None and cs.parse("what did you change") is None
    assert cs.parse("what changed in the coding sessions").kind == "catch_up"


async def test_a_named_sessions_spoken_diff_without_claude(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path)
    changed = git_project(tmp_path / "shop")
    task = session(hub, "shop", "Tax on prices")
    task.files_changed = {str(changed)}
    idle = session(hub, "shop", "Write the docs")
    reply = await hub.ask(f"what did session {task.id} change?")
    assert reply.startswith(f"Session {task.id} (Tax on prices): ")
    assert "shop" in reply and "price" in reply and "discount" in reply
    assert "round(" not in reply and "1.2" not in reply  # never code read aloud
    assert await hub.ask(f"what did session {idle.id} change") == (
        f"Session {idle.id} (Write the docs) hasn't changed any files yet."
    )
    assert await hub.ask("what did session 99 change") == "There's no Eden Code session 99."
    assert hub.client.queries == []
    close_all(hub)


async def test_everyones_changes_a_line_each_and_in_mandarin(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "api", "web")
    one = session(hub, "api", "Retry")
    one.files_changed = {str(tmp_path / "api" / "hub.py")}
    two = session(hub, "web", "Styles")
    two.files_changed = {str(tmp_path / "web" / f) for f in ("a.css", "b.css", "c.css", "d.css")}
    session(hub, "web", "Nothing yet")
    assert await hub.ask("what did everyone change?") == (
        f"Session {two.id} in web (Styles) changed 4 files: a.css, b.css, c.css, +1. "
        f"Session {one.id} in api (Retry) changed one file: hub.py."
    )
    hub.prefs.language = "zh"
    assert await hub.ask("大家都改了什么") == (
        f"Web 的会话{two.id}（Styles）改了 4 个文件：a.css, b.css, c.css, +1。"
        f"Api 的会话{one.id}（Retry）改了一个文件：hub.py。"
    )
    assert hub.client.queries == []
    close_all(hub)


async def test_while_voice_coding_another_sessions_diff_is_said_not_sent(
    settings, quiet_speaker, isolated, tmp_path
):
    import time

    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path)
    changed = git_project(tmp_path / "shop")
    other = session(hub, "shop", "Tax on prices")
    other.files_changed = {str(changed)}
    await hub.voice_code("shop")
    sent = recording_sends(hub)
    hub._armed_until = time.monotonic() + 5
    await hub.on_heard(f"what did session {other.id} change")
    assert sent == []
    assert said[-1].startswith(f"Session {other.id} (Tax on prices): ")
    close_all(hub)
