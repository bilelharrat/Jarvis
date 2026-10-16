"""The supervisor's words (codesupervisor): what an utterance asks of the sessions, which
session a spoken name means, what each session did, and what Jarvis says about them, in
English and Mandarin."""

import re
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import pytest

from jarvis import codesupervisor as cs
from jarvis import lang
from jarvis import voicecode as vc


def task(id, title="", folder="proj", status="waiting", busy=False, action="", prompt=""):
    return SimpleNamespace(
        id=id,
        kind="code",
        title=title,
        prompt=prompt,
        cwd=Path("/p") / folder,
        status=status,
        busy=busy,
        last_action=action,
    )


def kinds(*said):
    return [(a.kind if (a := cs.parse(s)) else None) for s in said]


# ── what's asked ──


@pytest.mark.parametrize(
    ("said", "kind"),
    [
        ("what's everyone doing?", "overview"),
        ("Jarvis, what is everyone doing", "overview"),
        ("so what are all the sessions up to", "overview"),
        ("how are the sessions doing", "overview"),
        ("give me a status update on my sessions", "overview"),
        ("who needs me", "waiting"),
        ("what does it want?", "waiting"),
        ("is anyone waiting for me", None),  # not one of the phrasings: left alone
        ("catch me up", "catch_up"),
        ("okay, catch me up on the sessions", "catch_up"),
        ("bring me up to speed", "catch_up"),
        ("what did I miss in the sessions", "catch_up"),
    ],
)
def test_questions_about_everyone(said, kind):
    ask = cs.parse(said)
    assert (ask.kind if ask else None) == kind


def test_everyday_words_are_only_about_the_sessions_while_voice_coding():
    for said, kind in (
        ("what did I miss?", "catch_up"),
        ("bring me up to speed", "catch_up"),
        ("give me a recap", "catch_up"),
        ("how's everyone doing", "overview"),
        ("who needs me", "waiting"),
        ("what does it want?", "waiting"),
        ("谁在等我", "waiting"),
    ):
        ask = cs.parse(said)
        assert (ask.kind, ask.weak) == (kind, True), said
    for said in (
        "catch me up",
        "what's everyone doing",
        "give me a recap of the sessions",
        "大家都在做什么",
    ):
        assert not cs.parse(said).weak, said
    # "Open the jarvis project" may mean an editor: only a switch moves voice focus.
    assert cs.parse("open the jarvis project").kind == "open"  # a file, if it named one
    assert cs.parse("打开jarvis项目") is None


def test_one_session_by_number_title_or_project():
    focus = cs.parse("switch to session 3")
    assert (focus.kind, focus.ref.num) == ("focus", 3)
    assert cs.parse("go back to session three").ref.num == 3
    assert cs.parse("switch to the test session").ref.name == "test"
    assert cs.parse("switch to the jarvis project").ref.project == "jarvis"
    assert cs.parse("talk to the session about the login page").ref.name == "the login page"
    tell = cs.parse("tell the refactor session to also update the docs")
    assert (tell.kind, tell.ref.name, tell.text) == ("message", "refactor", "also update the docs")
    assert cs.parse("Tell session 2 that the API moved to port 8080").text == (
        "the API moved to port 8080"
    )  # the words kept as said
    ask = cs.parse("ask the api session what it changed")
    assert (ask.kind, ask.text) == ("message", "What you changed?")  # "it" is the session
    assert cs.parse("ask session 2 to add tests").text == "add tests"
    assert cs.parse("have the docs session update the readme").text == "update the readme"
    for said in ("stop the api session", "tell the api session to stop", "cancel session 4"):
        assert cs.parse(said).kind == "stop", said
    for said in (
        "what does the docs session want?",
        "what's the docs session asking for",
        "what is session 5 waiting on",
        "read me the docs session's question",
    ):
        assert cs.parse(said).kind == "pending", said
    for said in ("how's the test session doing", "is the docs session done yet"):
        assert cs.parse(said).kind == "status", said


def test_session_commands_while_voice_coding():
    use = cs.parse("use gemini pro")
    assert (use.kind, use.text, use.focused) == ("model", "gemini pro", True)
    assert (cs.parse("ultracode on").on, cs.parse("turn off ultracode").on) == (True, False)
    assert cs.parse("disable ultra code").on is False
    lines = cs.parse("read lines 20 to 10 of hub dot py")
    assert (lines.kind, lines.text, lines.start, lines.end) == ("lines", "hub dot py", 10, 20)
    assert (
        cs.parse("show me line 7 of app.js").start,
        cs.parse("show me line 7 of app.js").end,
    ) == (7, 7)
    assert cs.parse("open hub dot py").text == "hub dot py"


def test_the_focused_sessions_own_words_and_requests_are_left_alone():
    # voicecode's commands and everyday requests for Claude are never taken.
    for said in (
        "add a retry around the query",
        "plan mode",
        "what changed",
        "exit code mode",
        "stop",
        "undo that",
        "rename this session to retry work",
        "what is the plan",
        "resume the retry refactor session",
        "tell the user session manager to refresh tokens",
        "why does the session expire after an hour",
        "what's the session timeout",
    ):
        assert cs.parse(said) is None, said


@pytest.mark.parametrize(
    ("said", "kind", "ref"),
    [
        ("大家都在做什么", "overview", None),
        ("贾维斯，所有会话都怎么样了", "overview", None),
        ("谁在等我", "waiting", None),
        ("给我补一下进度", "catch_up", None),
        ("切换到会话3", "focus", 3),
        ("切到第三个会话", "focus", 3),
        ("切换到测试会话", "focus", "测试"),
        ("切到jarvis项目", "focus", "jarvis"),
        ("停止测试会话", "stop", "测试"),
        ("让测试会话停下来", "stop", "测试"),
        ("文档会话想要什么", "pending", "文档"),
        ("测试会话在做什么", "status", "测试"),
    ],
)
def test_the_same_in_mandarin(said, kind, ref):
    ask = cs.parse(said)
    assert ask is not None and ask.kind == kind, said
    if isinstance(ref, int):
        assert ask.ref.num == ref
    elif ref:
        assert ref in (ask.ref.name, ask.ref.project)


def test_mandarin_messages_and_session_commands():
    tell = cs.parse("告诉重构会话也更新文档")
    assert (tell.kind, tell.ref.name, tell.text) == ("message", "重构", "也更新文档")
    assert cs.parse("跟会话2说，端口改成8080了").text == "端口改成8080了"
    assert cs.parse("问一下文档会话改了什么").text == "改了什么"
    assert cs.parse("打开 ultracode").on and not cs.parse("关闭ultracode").on
    lines = cs.parse("读一下hub.py的第10到20行")
    assert (lines.kind, lines.text, lines.start, lines.end) == ("lines", "hub.py", 10, 20)
    assert cs.parse("显示app.js第三行").start == 3
    assert cs.parse("打开hub.py").kind == "open"
    assert cs.parse("换成 Gemini Pro").text == "Gemini Pro"
    assert cs.parse("今天天气怎么样") is None


# ── which session ──


def test_sessions_are_found_by_number_words_or_project():
    tasks = [
        task(1, "Add a retry around the query", "jarvis"),
        task(2, "Write the docs for the API", "bsh"),
        task(3, "Fix the failing tests", "jarvis"),
        task(4, "Refactor the login flow", "api", status="closed"),
    ]
    assert cs.match(cs.Ref(num=3), tasks) == [tasks[2]]
    assert cs.match(cs.Ref(num=9), tasks) == []
    assert cs.match(cs.Ref(name="the tests"), tasks) == [tasks[2]]
    assert cs.match(cs.Ref(name="testing"), tasks) == [tasks[2]]  # stems match
    assert cs.match(cs.Ref(name="docs"), tasks) == [tasks[1]]
    assert cs.match(cs.Ref(name="refactoring"), tasks) == [tasks[3]]
    assert cs.match(cs.Ref(name="retyr"), tasks) == [tasks[0]]  # misheard, still close
    assert cs.match(cs.Ref(name="deploy"), tasks) == []
    assert cs.match(cs.Ref(name="the querry"), tasks) == [tasks[0]]  # a misheard word
    assert cs.match(cs.Ref(name="jarvis"), tasks) == [tasks[2], tasks[0]]  # its project: both
    assert cs.match(cs.Ref(project="bsh"), tasks) == [tasks[1]]
    assert cs.match(cs.Ref(name="weather"), tasks) == []
    assert cs.match(cs.Ref(name="测试"), [task(7, "修复失败的测试")]) != []


def test_an_open_session_wins_a_tie_with_a_closed_one():
    tasks = [task(1, "Fix the tests", status="closed"), task(2, "Fix the tests again")]
    assert cs.match(cs.Ref(name="fix the tests"), tasks) == [tasks[1]]


# ── the journal ──


def test_the_journal_keeps_turns_tests_and_what_was_seen():
    clock = iter(range(100, 200)).__next__
    j = cs.Journal(clock=clock)
    tool = {"role": "tool", "tool": "Bash", "tool_id": "t1", "detail": "$ uv run pytest -q"}
    j.event("task_log", {"id": 1, "entry": tool})
    j.event("task_log", {"id": 1, "entry": {**tool, "tool_id": "t2", "detail": "$ ls -la"}})
    j.event(
        "task_log_update",
        {"id": 1, "tool_id": "t1", "status": "done", "output": "412 passed in 3s"},
    )
    j.event("task_log_update", {"id": 1, "tool_id": "t2", "status": "done", "output": ""})
    finished = {
        "id": 1,
        "task_kind": "code",
        "status": "done",
        "result": "Added the retry.",
        "files": ["/p/a.py"],
    }
    j.event("task_finished", finished)
    (turn,) = j.unseen(1)
    assert turn.files == ["/p/a.py"] and turn.result == "Added the retry."
    assert [(r.command, r.passed, r.passed_count) for r in turn.tests] == [
        ("uv run pytest -q", True, 412)
    ]
    j.event("task_finished", {**finished, "status": "stopped"})  # the owner stopped it: not news
    assert len(j.unseen(1)) == 1
    j.mark_seen(1)
    assert j.unseen(1) == []
    j.event("task_finished", {**finished, "status": "failed", "files": []})
    assert [t.status for t in j.unseen(1)] == ["failed"]
    j.forget_others({2})
    assert j.unseen(1) == [] and 1 not in j.turns


def test_the_journal_outlasts_a_restart_by_session_id_and_bounded():
    now = [1000.0]
    sessions = {1: "sid-a", 2: "sid-b", 3: ""}
    j = cs.Journal(clock=lambda: now[0], session_of=sessions.get)
    saved = []
    j.on_change = lambda: saved.append(True)
    done = {"task_kind": "code", "status": "done", "result": "Fixed it. " * 200,
            "files": [f"/p/{n}.py" for n in range(100)]}  # fmt: skip
    j.event("task_finished", {**done, "id": 1})
    j.event("task_finished", {**done, "id": 3})  # no Claude session yet: nothing to keep
    now[0] = 1010.0
    j.mark_seen(2)
    assert saved
    snap = cs.Journal.snapshot(j)
    assert set(snap["sessions"]) == {"sid-a", "sid-b"}
    (turn,) = snap["sessions"]["sid-a"]["turns"]
    assert len(turn["result"]) == cs.SAVED_RESULT and len(turn["files"]) == cs.SAVED_FILES

    # After a restart: the same sessions, new ids.
    again = cs.Journal(clock=lambda: 1020.0, session_of={7: "sid-a", 8: "sid-b"}.get)
    again.restore(snap)
    (back,) = again.unseen(7)
    assert back.status == "done" and back.files[0] == "/p/0.py"
    assert again.unseen(8) == [] and again.seen[8] == 1010.0
    again.mark_seen(7)
    assert again.unseen(7) == []
    # Sessions not open again are kept till they are (or grow too old).
    later = cs.Journal(clock=lambda: 1000.0 + cs.SAVED_DAYS * 86400 + 30, session_of={}.get)
    later.restore(again.snapshot())
    assert later.snapshot()["sessions"] == {}


def test_a_damaged_catch_up_record_keeps_what_it_can():
    j = cs.Journal(clock=lambda: 500.0, session_of={1: "ok"}.get)
    j.restore({"sessions": {"ok": {"seen": "x", "turns": [
        {"at": 400, "status": "weird", "files": ["/a", 3], "tests": [{"command": "pytest",
         "passed": True, "failed_count": -1, "passed_count": 4}, "junk"]},
        {"at": "never"}, None]}, "": {}, "bad": [1]}})  # fmt: skip
    j.restore("not a record")
    j.restore({"sessions": []})
    (turn,) = j.unseen(1)
    assert turn.status == "done" and turn.files == ["/a"]
    assert [(r.command, r.passed, r.failed_count, r.passed_count) for r in turn.tests] == [
        ("pytest", True, 0, 4)
    ]
    assert list(j.kept) == []  # taken up by its session


def test_a_test_run_that_fails_counts_as_failed():
    j = cs.Journal()
    j.event(
        "task_log",
        {
            "id": 2,
            "entry": {"role": "tool", "tool": "Bash", "tool_id": "x", "detail": "$ npm test"},
        },
    )
    j.event(
        "task_log_update",
        {"id": 2, "tool_id": "x", "status": "failed", "output": "3 failed, 9 passed"},
    )
    j.event("task_finished", {"id": 2, "task_kind": "code", "status": "done", "result": ""})
    run = j.unseen(2)[0].tests[0]
    assert (run.passed, run.failed_count, run.passed_count) == (False, 3, 9)
    assert cs.TEST_COMMAND.search("cd app && xcodebuild -scheme App test")
    assert not cs.TEST_COMMAND.search("git status")


# The pass/fail parser on the outputs that fooled it: a summary past the first 2000
# characters, "N errors", a failing run that exited 0, and output that says no counts.


def test_counts_read_the_summary_of_a_long_run_kept_head_and_tail():
    from jarvis.tasks import kept_output

    long_run = "collecting ...\n" + "tests/test_x.py::test_case PASSED\n" * 400
    long_run += "FAILED tests/test_y.py::test_z\n=== 2 failed, 398 passed in 12.3s ===\n"
    kept = kept_output(long_run)
    assert len(kept) <= 2000 and kept.startswith("collecting") and "…" in kept
    assert cs.test_counts(kept) == (398, 2)
    assert cs.test_counts(long_run[:2000]) == (0, 0)  # what keeping only the head lost
    assert kept_output("short") == "short"


def test_errors_count_as_failures():
    assert cs.test_counts("=== 1 failed, 4 passed, 2 errors in 1.0s ===") == (4, 3)
    assert cs.test_counts("=== 3 errors in 0.40s ===") == (0, 3)
    assert cs.test_counts("=== 1 error in 0.40s ===") == (0, 1)
    assert cs.test_counts("Tests: 2 failed, 5 passed, 7 total") == (5, 2)
    assert cs.test_counts("  9 passing (40ms)\n  1 failing") == (9, 1)
    assert cs.test_counts("") == (0, 0) and cs.test_counts(None) == (0, 0)


def test_a_failing_run_that_exits_0_and_one_that_says_nothing():
    j = cs.Journal()
    for tool_id, output in (("a", "=== 2 errors in 0.4s ==="), ("b", "All done.")):
        tool = {"role": "tool", "tool": "Bash", "tool_id": tool_id, "detail": "$ pytest -q"}
        j.event("task_log", {"id": 3, "entry": tool})
        j.event(
            "task_log_update", {"id": 3, "tool_id": tool_id, "status": "done", "output": output}
        )
    j.event("task_finished", {"id": 3, "task_kind": "code", "status": "done", "result": ""})
    erred, silent = j.unseen(3)[0].tests
    assert (erred.passed, erred.failed_count, erred.passed_count) == (False, 2, 0)
    # Exited 0 with no counts: recorded as it exited; the proof calls it unknown.
    assert (silent.passed, silent.failed_count, silent.passed_count) == (True, 0, 0)


# ── what's said ──


def approval(task_id, **extra):
    return {
        "id": f"a{task_id}",
        "task_id": task_id,
        "tool": "Bash",
        "question": "Eden Code in proj wants to run a command",
        "detail": "$ npm test",
        "choices": [{"id": "allow", "label": "Yes"}, {"id": "deny", "label": "No"}],
        **extra,
    }


def test_the_overview_puts_who_needs_you_first():
    tasks = [
        task(1, "Add a retry", busy=True, status="running", action="Editing hub.py"),
        task(2, "Write the docs"),
        task(3, "Fix the tests"),
        task(4, "Old work", status="closed"),
    ]
    j = cs.Journal()
    j.event(
        "task_finished",
        {"id": 3, "task_kind": "code", "status": "done", "result": "All green now. More."},
    )
    said, told = cs.overview(tasks, {"a2": approval(2)}, j, "en")
    assert said == (
        "3 sessions. Session 2 (Write the docs) needs you: it wants to run a command. "
        "Session 1 (Add a retry) is working: editing hub dot py. "
        "Session 3 (Fix the tests) finished: All green now."
    )
    assert [t.id for t in told] == [2, 1, 3]  # the closed one with no news isn't said
    zh, _ = cs.overview(tasks, {"a2": approval(2)}, j, "zh")
    assert zh.startswith("3个会话。会话2（Write the docs）需要你：它想运行一条命令。会话1")
    assert cs.overview([], {}, j, "en")[0] == "No Eden Code sessions are open."


def test_many_sessions_are_said_four_at_a_time():
    tasks = [task(i, f"Task number {i}", busy=True, status="running") for i in range(1, 8)]
    said, told = cs.overview(tasks, {}, cs.Journal(), "en")
    assert said.startswith("7 sessions.") and said.endswith("3 more are on screen.")
    assert len(told) == cs.SAID_IN_FULL


def test_the_digest_says_files_tests_and_the_reply():
    j = cs.Journal()
    j.event(
        "task_log",
        {"id": 1, "entry": {"role": "tool", "tool": "Bash", "tool_id": "t", "detail": "$ pytest"}},
    )
    j.event("task_log_update", {"id": 1, "tool_id": "t", "status": "done", "output": "12 passed"})
    for result in ("Added the retry.", "Wrote a test for it. Then more."):
        j.event("task_finished", {"id": 1, "task_kind": "code", "status": "done", "result": result,
                                  "files": ["/p/hub.py", "/p/test_hub.py"]})  # fmt: skip
    lines = cs.digest_lines(task(1, "Add a retry"), j.unseen(1), "en", False)
    assert lines == [
        "Session 1 (Add a retry) finished 2 tasks.",
        "It changed 2 files: hub.py, test_hub.py.",
        "12 tests passed.",
        "It says: Wrote a test for it.",
    ]
    condensed = cs.digest_lines(task(1, "Add a retry"), j.unseen(1), "en", False, "Retry and test.")
    assert condensed[-1] == "It says: Retry and test."
    j.event(
        "task_finished",
        {"id": 1, "task_kind": "code", "status": "failed", "result": "Boom.", "files": []},
    )
    failed = cs.digest_lines(task(1, "Add a retry"), j.unseen(1)[-1:], "zh", False)
    assert failed == ["会话1（Add a retry）出错停下了：Boom."]


def test_a_pending_question_is_read_so_a_yes_answers_it():
    t = task(2, "Write the docs")
    bash = cs.pending_speech(t, approval(2), "en")
    assert bash == "Session 2 (Write the docs) wants to run npm test. Should it?"
    edit = approval(2, tool="Edit", detail="src/jarvis/hub.py\n- a\n+ b")
    assert (
        cs.pending_speech(t, edit, "en")
        == "Session 2 (Write the docs) wants to edit hub dot py. Should it?"
    )
    long_command = approval(2, detail="$ " + "word " * 12)
    assert cs.pending_speech(t, long_command, "en").endswith("wants to run a command. Should it?")
    plan = approval(2, ask_kind="plan", detail="1. Add a cache\n2. Test it", tool="ExitPlanMode")
    assert cs.pending_speech(t, plan, "en").endswith(
        "Say go, go with auto-edits, or keep planning."
    )
    question = approval(2, ask_kind="question", question="Which database?", choices=[
        {"id": "opt0", "label": "SQLite"}, {"id": "opt1", "label": "Postgres"}, {"id": "skip", "label": "Skip"}])  # fmt: skip
    assert cs.pending_speech(t, question, "en") == (
        "Session 2 (Write the docs) asks: Which database? Options: 1, SQLite; 2, Postgres."
    )
    assert (
        cs.pending_speech(t, approval(2), "zh")
        == "会话2（Write the docs）想运行 npm test。要让它运行吗？"
    )
    for spoken in (bash, cs.pending_speech(t, plan, "en")):
        # Its own voice heard back is never a yes: it doesn't end on an answer.
        assert vc.voice_answer(spoken, approval(2)) in (None, (vc.REASK, ""))


def test_which_session_numbers_the_candidates():
    spoken, choices = cs.which_speech(
        [task(3, "Fix the tests", "jarvis"), task(5, "Fix the tests", "api")], "en"
    )
    assert spoken == "Which session? 1, Fix the tests · jarvis; 2, Fix the tests · api."
    assert choices == [("s3", "Fix the tests · jarvis"), ("s5", "Fix the tests · api")]


def test_the_briefing_gets_facts_about_what_ran_while_you_were_away():
    j = cs.Journal(clock=lambda: 1000.0)
    j.event(
        "task_finished",
        {"id": 1, "task_kind": "code", "status": "done", "result": "x", "files": ["/a", "/b"]},
    )
    facts = cs.briefing_facts(
        [task(1, "Add a retry"), task(2, "Docs")], {"a2": approval(2)}, j, since=0
    )
    assert facts == (
        "1 thing needs the user — “Add a retry” in proj: finished, 2 files changed; "
        "“Docs” in proj: needs the user's OK"
    )
    assert cs.briefing_facts([task(1, "Add a retry")], {}, j, since=2000) == ""  # too long ago


def test_overnight_pull_requests_and_risky_changes_lead_the_briefing():
    from types import SimpleNamespace as NS

    j = cs.Journal(clock=lambda: 1000.0)
    j.event(
        "task_finished",
        {"id": 1, "task_kind": "code", "status": "done", "result": "x",
         "files": ["src/auth/session.py"]},
    )  # fmt: skip
    prs = {
        1: NS(state="open", checks="passed", mergeable="clean", draft=False, number=7),
        2: NS(state="open", checks="failed", mergeable="", draft=False, number=8),
    }
    facts = cs.briefing_facts(
        [task(1, "Login fix"), task(2, "Docs")], {}, j, since=0, pr_of=lambda t: prs.get(t.id)
    )
    assert facts.startswith("1 pull request ready, 1 thing needs the user — ")
    assert "pull request #7 is ready, it touches auth: worth a look" in facts
    assert "pull request #8's checks are failing" in facts


# ── the Chinese ──

_SLOT = re.compile(r"\{(\w+)\}")


def test_every_sentence_has_its_chinese_with_the_same_slots():
    for english, chinese in cs.ZH.items():
        assert Counter(_SLOT.findall(english)) == Counter(_SLOT.findall(chinese)), english
        assert lang.has_cjk(chinese), english
        assert not lang.find_wake_zh(_SLOT.sub("X", chinese))[0], chinese
        assert lang.ZH_TEXTS[english] == chinese  # registered with lang: translate knows it
    assert lang.translate("Ultracode off.") == "ultracode 已关闭。"
    assert lang.tr("Told {session}.", "zh", session="会话3") == "已转告会话3。"


def test_what_the_hand_points_at_is_kept_only_in_its_shapes():
    page = cs.clean_reference(
        {
            "kind": "page",
            "tag": "BUTTON onclick=x",
            "text": " Buy \n now ",
            "selector": "#buy",
            "box": {"x": 1, "y": 2.6, "width": 3, "height": 4},
            "url": "javascript:alert(1)",
            "image": {"media_type": "image/svg+xml", "data": "PHN2Zz4="},
        }
    )
    assert page["tag"] == "element" and page["text"] == "Buy now" and page["box"] == [1, 3, 3, 4]
    assert page["url"] == "" and page["image"] is None
    assert cs.clean_reference({"kind": "simulator", "x": 2, "y": -1})["x"] == 1.0
    assert cs.clean_reference({"kind": "simulator", "x": "a", "y": 0}) is None
    assert cs.clean_reference("page") is None and cs.clean_reference({"kind": "file"}) is None
    note = cs.reference_note(page)
    assert note.startswith(
        "[Pointed at while saying this, in the built-in browser (the page): a <element>"
    )
    assert cs.points_at("make this bigger") and cs.points_at("把这个改成蓝色")
    assert not cs.points_at("add a retry around the query")


def test_long_and_hostile_words_are_read_quickly():
    import time

    hostile = [
        "tell the " + "session " * 60,
        "tell " + "a " * 190 + "session to x",
        "what does the " + "x " * 190 + "session want",
        "read lines 1 to 2 of " + "a b " * 90,
        "ask the " + "session " * 30 + " what " * 20,
        "告诉" + "测试" * 140 + "会话也更新",
        "问" + "会话" * 140,
        "x" * 100_000,  # far past what's spoken: not even looked at
    ]
    for text in hostile:
        started = time.perf_counter()
        cs.parse(text)
        assert time.perf_counter() - started < 0.05, text[:30]  # well under 1 ms here


# A run's outcome as the proof needs it (receipts accuracy, roadmap 1): node's own summary
# is read; a step the owner refused, or one interrupted or still going when the turn ended,
# didn't run to its end; an edit after a run makes its pass out of date; a stopped turn's
# runs are still kept for its receipt.


def _bash(j, task_id, tool_id, command):
    j.event(
        "task_log",
        {
            "id": task_id,
            "entry": {"role": "tool", "tool": "Bash", "tool_id": tool_id, "detail": f"$ {command}"},
        },
    )


def _result(j, task_id, tool_id, status, output):
    j.event(
        "task_log_update", {"id": task_id, "tool_id": tool_id, "status": status, "output": output}
    )


def test_node_tests_own_summary_is_read():
    spec = "▶ signup\n  ✔ refuses a long email (1ms)\nℹ tests 5\nℹ suites 1\nℹ pass 4\nℹ fail 1\nℹ cancelled 0\n"
    assert cs.test_counts(spec) == (4, 1)
    tap = "ok 1 - a\nnot ok 2 - b\n1..2\n# tests 2\n# pass 1\n# fail 0\n# cancelled 1\n"
    assert cs.test_counts(tap) == (1, 1)  # (a cancelled test failed)
    assert cs.test_counts("ℹ tests 5\nℹ pass 5\nℹ fail 0\n") == (5, 0)


def test_refused_interrupted_and_unfinished_runs_never_passed_or_failed():
    j = cs.Journal()
    _bash(j, 1, "a", "pytest -q")
    _result(j, 1, "a", "failed", "The user said no: not now")
    _bash(j, 1, "b", "npm test")
    _result(j, 1, "b", "failed", "[Request interrupted by user for tool use]")
    _bash(j, 1, "c", "pytest tests/test_x.py")  # never answered: the turn ended first
    j.event("task_finished", {"id": 1, "task_kind": "code", "status": "done", "result": ""})
    runs = j.unseen(1)[0].tests
    assert [(r.command, r.passed, r.outcome) for r in runs] == [
        ("pytest -q", False, "refused"),
        ("npm test", False, "cancelled"),
        ("pytest tests/test_x.py", False, "cancelled"),
    ]
    assert cs.tests_verdict(runs)["state"] == "cancelled"
    assert cs.tests_verdict(runs[:1])["state"] == "refused"
    # A run that failed for real, with no count, is still a failure.
    _bash(j, 2, "d", "pytest")
    _result(j, 2, "d", "failed", "ImportError: no module named app")
    j.event("task_finished", {"id": 2, "task_kind": "code", "status": "done", "result": ""})
    assert j.unseen(2)[0].tests[0].outcome == ""


def test_an_edit_after_a_run_makes_its_pass_out_of_date_but_a_readme_doesnt():
    j = cs.Journal()
    _bash(j, 3, "t1", "pytest")
    _result(j, 3, "t1", "done", "5 passed in 0.1s")
    j.event(
        "task_log",
        {
            "id": 3,
            "entry": {
                "role": "tool",
                "tool": "Edit",
                "tool_id": "e1",
                "detail": "README.md\n- a\n+ b",
            },
        },
    )
    _result(j, 3, "e1", "done", "")
    assert not j._ran[3][0].edited_after
    j.event(
        "task_log",
        {
            "id": 3,
            "entry": {
                "role": "tool",
                "tool": "Edit",
                "tool_id": "e2",
                "detail": "app/signup.py\n- a\n+ b",
            },
        },
    )
    _result(j, 3, "e2", "failed", "String not found")  # (an edit that didn't happen)
    assert not j._ran[3][0].edited_after
    j.event(
        "task_log",
        {
            "id": 3,
            "entry": {
                "role": "tool",
                "tool": "Write",
                "tool_id": "e3",
                "detail": "app/signup.py (new contents)\n+ x",
            },
        },
    )
    _result(j, 3, "e3", "done", "")
    j.event("task_finished", {"id": 3, "task_kind": "code", "status": "done", "result": ""})
    runs = j.unseen(3)[0].tests
    assert runs[0].edited_after and cs.tests_verdict(runs)["state"] == "stale"
    # ... and it outlasts a restart.
    saved = cs._turn_in(cs._turn_out(j.unseen(3)[0]))
    assert saved.tests[0].edited_after and saved.tests[0].passed


def test_a_stopped_turns_runs_are_kept_for_its_proof_not_its_catch_up():
    j = cs.Journal(clock=lambda: 50.0)
    _bash(j, 4, "t", "pytest")
    _result(j, 4, "t", "done", "3 passed")
    j.event("task_finished", {"id": 4, "task_kind": "code", "status": "stopped", "result": ""})
    assert j.unseen(4) == []
    assert j.stopped[4].at == 50.0 and j.stopped[4].tests[0].passed_count == 3


def _run(passed, ok=3, bad=0, command="pytest", outcome="", edited=False):
    return cs.TestRun(command, passed, bad, ok, outcome, edited)


def test_the_verdict_never_says_passed_unless_a_pass_happened():
    v = cs.tests_verdict
    assert v([]) is None
    assert v([_run(True, 12)])["state"] == "passed"
    assert v([_run(True, 0)])["state"] == "unknown"  # exited fine, said no count
    assert v([_run(False, 2, 1)])["state"] == "failed"
    # Fail first, then the same command passes: the film's flow, a real pass.
    assert v([_run(False, 4, 1, "npm test"), _run(True, 5, 0, "npm test")])["state"] == "passed"
    # The suite failed, then one test file passed: still failed, and said why.
    narrow = v([_run(False, 49, 1, "pytest"), _run(True, 3, 0, "pytest tests/test_one.py")])
    assert narrow["state"] == "failed" and narrow["note"] == "a later, narrower run passed"
    assert narrow["run"].failed_count == 1
    # One file failed, then the whole suite passed: covered.
    assert (
        v([_run(False, 2, 1, "pytest tests/test_one.py"), _run(True, 50, 0, "pytest")])["state"]
        == "passed"
    )
    # A pass, then a run that was stopped: the pass stands (nothing changed in between).
    assert v([_run(True, 5), _run(False, 0, 0, outcome="cancelled")])["state"] == "passed"
    assert v([_run(True, 5, edited=True)])["state"] == "stale"
    assert v([_run(False, 0, 0, outcome="refused")])["state"] == "refused"
