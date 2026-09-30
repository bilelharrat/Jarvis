"""Voice for reviewing a session's changes (features/code_review_voice.py), in English and
Mandarin: the phrases it takes (and the ones it leaves for Claude), then each one carried
out on a real session: keep and undo numbered changes, a note on one change, land, review
and commit. Real git in temp repositories; fake Claude Code and a fake reviewer."""

import asyncio
import json
from dataclasses import replace

import pytest
from test_code_changes import Session, git, make_repo, numbered

from jarvis import voicecode
from jarvis.features import code_review_voice as crv


@pytest.mark.parametrize(
    ("said", "kind", "arg", "text"),
    [
        (
            "keep 1 and 3, undo 2",
            "code_hunks",
            {"keep": [1, 3], "undo": [2], "keep_all": False},
            "",
        ),
        (
            "keep one and three and undo two",
            "code_hunks",
            {"keep": [1, 3], "undo": [2], "keep_all": False},
            "",
        ),
        ("undo change 2", "code_hunks", {"keep": [], "undo": [2], "keep_all": False}, ""),
        ("revert the second one", "code_hunks", {"keep": [], "undo": [2], "keep_all": False}, ""),
        ("keep the last one", "code_hunks", {"keep": [-1], "undo": [], "keep_all": False}, ""),
        ("keep them all", "code_hunks", {"keep": [], "undo": [], "keep_all": True}, ""),
        ("Jarvis, on change 3, rename that Variable", "code_note", 3, "rename that Variable"),
        ("for the third change: use a set", "code_note", 3, "use a set"),
        ("land it", "code_land", None, ""),
        ("merge it back", "code_land", None, ""),
        ("review this", "code_review", False, ""),
        ("review my changes please", "code_review", False, ""),
        ("deep review", "code_review", True, ""),
        ("review it thoroughly", "code_review", True, ""),
        ("commit with message fix the login bug.", "code_commit", None, "Fix the login bug"),
        ("commit this, message: “Tidy the retry loop”", "code_commit", None, "Tidy the retry loop"),
        (
            "保留第一处和第三处，撤销第二处",
            "code_hunks",
            {"keep": [1, 3], "undo": [2], "keep_all": False},
            "",
        ),
        ("贾维斯，撤销第2个修改。", "code_hunks", {"keep": [], "undo": [2], "keep_all": False}, ""),
        ("保留十二和两", "code_hunks", {"keep": [12, 2], "undo": [], "keep_all": False}, ""),
        ("全部保留", "code_hunks", {"keep": [], "undo": [], "keep_all": True}, ""),
        ("第三处改动，把那个变量改名", "code_note", 3, "把那个变量改名"),
        ("把它合并回去", "code_land", None, ""),
        ("审查一下这些改动", "code_review", False, ""),
        ("深度审查", "code_review", True, ""),
        ("提交，信息是修复登录", "code_commit", None, "修复登录"),
        ("用“修复登录”作为提交信息提交", "code_commit", None, "修复登录"),
    ],
)
def test_the_phrases_it_takes(said, kind, arg, text):
    intent = voicecode.parse(said)
    assert (intent.kind, intent.arg, intent.text) == (kind, arg, text)


@pytest.mark.parametrize(
    "said",
    [
        "keep going",
        "undo all",  # undoing everything by voice is left to Claude to ask about
        "keep it simple",
        "on second thought, stop",
        "for one thing, the tests are slow",
        "commit messages should be short",
        "review the architecture docs and tell me what's missing",
        "保留这个想法",
        "我们合并一下这两个函数",
    ],
)
def test_the_phrases_it_leaves_for_claude(said):
    assert voicecode.parse(said).kind == "send"


def test_the_commands_before_it_still_win():
    assert voicecode.parse("undo that").kind == "undo"
    assert voicecode.parse("undo the last change").kind == "undo"  # the last round, rewound
    assert (voicecode.parse("commit that").kind, voicecode.parse("commit that").arg) == (
        "git",
        "commit",
    )
    assert voicecode.parse("what changed").kind == "changes"
    assert [crv.zh_number(n) for n in ("十二", "二十三", "两", "7", "十", "最后")] == [
        12,
        23,
        2,
        7,
        10,
        -1,
    ]


# ── carried out ──


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.said = []
    hub.say = lambda text, follow_up=True: hub.said.append(text)
    hub.cards, hub.answers = [], []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


async def until(condition, tries=3000):
    for _ in range(tries):
        if condition():
            return True
        await asyncio.sleep(0.01)
    return False


async def three_changes(hub, projects):
    """A session whose edits made three hunks in a.py (changes 1, 2 and 3, top to bottom)."""
    repo = make_repo(projects / "proj", {"a.py": numbered(60)})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    s.turn("u-1")
    for n, word in ((5, "five"), (25, "twenty-five"), (45, "forty-five")):
        s.edit(repo / "a.py", f"line {n}\n", f"line {word} = {n}\n")
    return repo, task


async def test_keep_and_undo_numbered_changes_by_voice(hub, projects):
    repo, task = await three_changes(hub, projects)
    await hub.voicecode.handle("keep 1 and 3, undo 2", task=task)
    assert hub.said[-1] == "Kept changes 1 and 3. Undid 1 change."
    text = (repo / "a.py").read_text()
    assert "line five = 5" in text and "line 25\n" in text and "line forty-five = 45" in text
    kept = [d["kept"] for k, d in hub.events if k == "code_kept"][-1]
    assert len(kept) == 2
    await hub.voicecode.handle("undo change 5", task=task)
    assert hub.said[-1] == "There's no change 5: there are 2."
    await hub.voicecode.handle("keep the last one", task=task)
    assert hub.said[-1] == "Kept change 2."


async def test_a_note_on_a_change_goes_to_the_session_with_the_change_quoted(hub, projects):
    _repo, task = await three_changes(hub, projects)
    sent = []
    hub.tasks.send = lambda task_id, text, *a, **k: sent.append(text) or True
    await hub.voicecode.handle("on change 2, rename that to twenty_five", task=task)
    assert sent == [
        "Review comments:\n- a.py:25 (`line twenty-five = 25`) — rename that to twenty_five"
    ]
    assert hub.said[-1] == "Sent your note on change 2."


async def test_land_it_by_voice_asks_out_loud_first(hub, projects):
    repo, shared = await three_changes(hub, projects)
    await hub.voicecode.handle("land it", task=shared)
    assert hub.said[-1] == "This session isn't in an isolated copy, so there's nothing to land."
    task = hub.tasks.start("", "proj", isolate=True, title="voice work")
    assert await until(lambda: task.workspace and task.client is not None)
    (task.cwd / "voice.txt").write_text("said\n")
    spoken = []
    hub._say = lambda text: spoken.append(text)
    hub.answers = ["land"]
    await hub.voicecode.handle("land it", task=task)
    assert spoken == [f"Land {task.workspace['branch']} in main?"]  # the card, said aloud
    assert hub.said[-1].startswith("Landed jarvis/") and (repo / "voice.txt").exists()


async def test_review_this_says_what_it_found_when_it_is_done(hub, projects):
    _repo, task = await three_changes(hub, projects)

    async def fake(prompt, **kw):
        return json.dumps(
            [{"severity": "high", "file": "a.py", "line": 5, "title": "t", "detail": "", "fix": ""}]
        )

    hub.code_reviews.ai = fake
    await hub.voicecode.handle("review this", task=task)
    assert hub.said[-1] == "Reviewing; I'll say when it's done."
    assert await until(lambda: len(hub.said) == 2)
    assert hub.said[-1] == "The review found 1 problem, 1 of them serious. It's on screen."


async def test_commit_with_a_message_stages_the_sessions_changes_and_still_asks(hub, projects):
    repo, task = await three_changes(hub, projects)
    (repo / "owner.txt").write_text("the owner's own file\n")
    spoken = []
    hub._say = lambda text: spoken.append(text)
    hub.answers = ["commit"]
    await hub.voicecode.handle("commit with message make the numbers words", task=task)
    assert spoken == ["Commit 1 file as “Make the numbers words”?"]
    assert hub.said[-1] == "Committed."
    assert git(repo, "log", "-1", "--format=%s").strip() == "Make the numbers words"
    assert git(repo, "status", "--porcelain").strip() == "?? owner.txt"  # never the owner's
    assert any(k == "caption" and d["text"].startswith("Committed ") for k, d in hub.events)


async def test_it_answers_in_chinese_when_the_owner_speaks_chinese(hub, projects):
    repo, task = await three_changes(hub, projects)
    hub.set_prefs({"language": "zh"})
    await hub.voicecode.handle("撤销第一处改动", task=task)
    assert hub.said[-1] == "已撤销 1 处改动。" and "line 5\n" in (repo / "a.py").read_text()
    await hub.voicecode.handle("保留一和二", task=task)
    assert hub.said[-1] == "已保留第 1、2 处改动。"
    await hub.voicecode.handle("撤销第九处改动", task=task)
    assert hub.said[-1] == "没有第 9 处改动：一共只有 2 处。"
