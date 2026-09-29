import subprocess

import pytest

from jarvis import code_vocab, diffspeak


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    (root / "src" / "hub.py").write_text(
        "MAX_RETRIES = 3\n\nclass Hub:\n    def ask(self):\n        return 1\n\n    def notify(self):\n        return 2\n"
    )
    (root / "src" / "voicecode.py").write_text("def speakable(text):\n    return text\n")
    (root / "web").mkdir()
    (root / "web" / "app.js").write_text(
        "function onVoiceCode(focus) {}\nconst renderPills = () => {}\n"
    )
    run = lambda *a: subprocess.run(["git", "-C", str(root), *a], check=True, capture_output=True)  # noqa: E731
    run("init", "-q")
    run("-c", "user.email=t@t", "-c", "user.name=t", "add", ".")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start")
    return root


def test_spoken_code_becomes_code():
    n = code_vocab.normalize
    assert n("open hub dot py") == "open hub.py"
    assert n("rename it to snake case max retries in hub") == "rename it to max_retries in hub"
    assert n("call camel case use effect") == "call useEffect"
    assert n("add constant case max buffer") == "add MAX_BUFFER"
    assert n("look in src slash jarvis") == "look in src/jarvis"


def test_names_resolve_to_the_projects_files_and_symbols(repo):
    vocab = code_vocab.ProjectVocab(repo)
    vocab.refresh(force=True)
    assert set(vocab.idents) >= {"Hub", "ask", "notify", "speakable", "onVoiceCode", "MAX_RETRIES"}
    assert "hub" in vocab.hotwords().split()
    assert vocab.mentions("add a retry in hub dot py") == ["src/hub.py"]
    assert "src/voicecode.py" in vocab.mentions("check the voice code file")
    assert "MAX_RETRIES" in vocab.mentions("bump max retries to five")
    assert "onVoiceCode" in vocab.mentions("fix on voice code in the app")
    hint = vocab.hint("make speakable shorter")
    assert "speakable" in hint and "misheard" in hint
    assert vocab.hint("hello there") == ""


def test_the_diff_out_loud(repo):
    (repo / "src" / "hub.py").write_text(
        "MAX_RETRIES = 5\n\nclass Hub:\n    def ask(self):\n        return 1 + 1\n\n    def notify(self):\n        return 2\n"
    )
    (repo / "src" / "new_thing.py").write_text("x = 1\ny = 2\n")
    changes = diffspeak.collect(repo)
    said = diffspeak.summary(changes)
    assert said.startswith("2 files changed, 4 lines added and 2 removed.")
    assert "New file new thing dot py, 2 lines." in said
    assert "hub dot py: 2 added, 2 removed" in said
    pieces = diffspeak.hunks(changes)
    assert pieces[1].where == "ask" and "return 1 + 1" in diffspeak.describe_hunk(pieces[1])
    only = diffspeak.collect(repo, only={str(repo / "src" / "new_thing.py")})
    assert [c.path for c in only] == ["src/new_thing.py"]
    assert diffspeak.collect(repo.parent) is None  # not a git repo


def test_a_clean_tree_says_so(repo):
    assert diffspeak.summary(diffspeak.collect(repo)) == (
        "No changes yet: the working tree matches the last commit."
    )


async def test_requests_carry_hints_and_explanations_quote_the_change(
    settings, quiet_speaker, isolated, repo
):
    from dataclasses import replace

    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=repo.parent), quiet_speaker, isolated=isolated)
    await hub.start()
    hub.say = lambda text, follow_up=True: None
    await hub.voice_code("proj")
    task = hub.voicecode.task
    sent = []
    hub.tasks.send = lambda task_id, text: sent.append(text) or True
    await hub.voicecode.handle("add a retry in hub dot py")
    assert sent[-1].startswith("add a retry in hub.py") and "Likely meant: src/hub.py" in sent[-1]
    (repo / "src" / "hub.py").write_text("MAX_RETRIES = 9\n")
    await hub.voicecode.handle("explain the first change")
    assert "explain this change" in sent[-1] and "MAX_RETRIES = 9" in sent[-1]
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    await hub.voicecode.handle("what changed")
    assert said[-1].startswith("1 file changed")
    task.handle.cancel()
