"""Round-2 optimization pass (askeden/docs/bug-sweep/r2-optimize-eden-code.md): the same
results, sooner. Land's secret scan rules lines out cheaply before its costly patterns; a diff
stops git at a file too big to show and makes the rest without it; the Git panel asks git one
thing fewer; the projects' branches are read side by side; and the Problems pane's checkers
stop with the app again."""

import asyncio
import random
import re
import time
from dataclasses import replace

from code_session_fakes import make_hub
from test_code_changes import git, make_repo

from jarvis import code_changes, diagnostics, secret_scan, worktrees
from jarvis.features import code_git

# ── Land's secret scan: the cheap checks change no finding ──


def scan_every_pattern(text: str) -> list[tuple[str, str]]:
    """secret_scan.scan_line as it was: every pattern tried on every line."""
    ss = secret_scan
    text = text[: ss.LINE_CHARS]
    found, taken = [], []

    def free(span):
        return all(span[1] <= a or span[0] >= b for a, b in taken)

    for kind, pattern in ss.PATTERNS:
        for m in pattern.finditer(text):
            if not free(m.span()):
                continue
            taken.append(m.span())
            if kind == "Private key":
                found.append((kind, m.group(0)))
            elif kind == "Password in a URL":
                found.append((kind, m.group(0).replace(m.group(1), "••••")))
            else:
                found.append((kind, ss.mask(m.group(0))))
    for m in ss.ASSIGNED.finditer(text):
        value = m.group("value")
        if not free(m.span("value")) or ss._PLACEHOLDER.search(value):
            continue
        if re.fullmatch(r"[A-Za-z_][\w.]*", value) and not re.search(r"\d", value):
            continue
        if ss._random_looking(value):
            taken.append(m.span("value"))
            found.append((f"Secret-looking value for {m.group('name')[:40]}", ss.mask(value)))
    if not ss._HASHY.search(text):
        for m in ss.QUOTED.finditer(text):
            value = m.group(1)
            if not free(m.span(1)) or ss._PLACEHOLDER.search(value):
                continue
            mixed = (
                re.search(r"[a-z]", value)
                and re.search(r"[A-Z]", value)
                and re.search(r"\d", value)
            )
            if mixed and ss.entropy(value) >= 4.5:
                taken.append(m.span(1))
                found.append(("High-entropy string", ss.mask(value)))
    return found


SECRETS = [
    "AKIAZ7Q2LMN8PR4TV7WY", "ghp_" + "a1B2c3D4" * 5, "github_pat_" + "x1" * 30,
    "glpat-abcdefghij1234567890", "xoxb-1234567890-abcdefghij",
    "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
    "sk_live_abcdefghij1234567890", "AIza" + "B9" * 17 + "c", "GOCSPX-abcdefghijklmnopqrstuv",
    "sk-ant-api03-" + "Zx9" * 10, "sk-proj-" + "Ab1" * 12, "hf_" + "Ab1" * 11, "npm_" + "a1" * 18,
    "pypi-" + "Ab1_" * 14, "SG.abcdefghij123456.ABCDEFGHIJ123456", "SK" + "0123456789abcdef" * 2,
    "key-" + "0123456789abcdef" * 2, "MTk4NjIyNDgzNDcxOTI1MjQ4" + ".Cl2FMQ." + "ZnCjm1XVW7vRze4b7Cq4se7kKWs",
    "123456789:AA" + "b" * 33, "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw",
    "postgres://admin:hunter2pass@db.example.org", "-----BEGIN RSA PRIVATE KEY-----",
    "Zx9Kq2LmN8pR4tV7wY1bC3dF6gH0jS5u", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF",
]  # fmt: skip
# Names as code spells them, and as re's IGNORECASE also reads them (ſ for s, K for k, İ
# for i): non-ASCII lines are always given ASSIGNED's search.
NAMES = [
    "api_key", "API-KEY", "apiKey", "client_secret", "Password", "pwd", "authKey", "access_key",
    "PRIVATE_KEY", "credential", "signing-key", "token", "TOKEN", "seCret", "ſecret",
    "credentİal", "apiKey", "passwd", "value", "name",
]  # fmt: skip
CODE = [
    "import { thing } from './module.js';",
    "  const value = computeSomething(arg, 'string literal', 3);",
    "  // comment about token handling and the secret sauce",
    "  if (user.password === undefined) { return null; }",
    "  url: 'https://api.example.com/v1/items/7',",
    "  apiKey: process.env.API_KEY,",
    "def handler(req):  # sha256 integrity check",
    "SKIP = True",
    "",
]


def lines_to_check(n: int = 6000) -> list[str]:
    rnd = random.Random(11)
    out = list(CODE)
    ops = [" = ", ": ", "=", ":=", " => ", '": "', "='"]
    for _ in range(n):
        k = rnd.random()
        if k < 0.4:
            q = rnd.choice(['"', "'", "`", ""])
            out.append(rnd.choice(NAMES) + rnd.choice(ops) + q + rnd.choice(SECRETS) + q)
        elif k < 0.6:
            out.append(rnd.choice(CODE) + " " + rnd.choice(SECRETS))
        elif k < 0.8:
            chars = list(rnd.choice(CODE + SECRETS) or "x")
            for _ in range(3):
                chars[rnd.randrange(len(chars))] = rnd.choice("ſKİı=:\"'`.-_ é漢")
            out.append("".join(chars))
        else:
            out.append(f'const x = "{rnd.choice(SECRETS)}"; // sha256 ' * rnd.randint(1, 3))
    return out


def test_the_secret_scans_cheap_checks_find_exactly_what_every_pattern_finds():
    lines = lines_to_check()
    found = 0
    for line in lines:
        expected = scan_every_pattern(line)
        assert secret_scan.scan_line(line) == expected, line
        found += len(expected)
    assert found > 2000  # (the lines do hold secrets of every kind)
    kinds = {k for line in lines for k, _ in scan_every_pattern(line)}
    assert {kind for kind, _ in secret_scan.PATTERNS} <= kinds


def test_ordinary_code_is_scanned_several_times_faster():
    ordinary = [  # (no secret's name in them: most lines of code)
        "import { thing } from './module.js';",
        "  const value = computeSomething(arg, 'string literal', 3);",
        "  if (user.name === undefined) { return null; }",
        "    for (const item of items) { total += item.price * item.count; }",
        "export default function handler(req, res) {",
        "  res.status(200).json({ id: 7, name: 'item' });",
    ]
    lines = [f"{line} {i}" for i in range(3000) for line in ordinary]
    started = time.perf_counter()
    for line in lines:
        scan_every_pattern(line)
    every = time.perf_counter() - started
    started = time.perf_counter()
    for line in lines:
        assert not secret_scan.scan_line(line)
    cheap = time.perf_counter() - started
    assert cheap < every / 3, (cheap, every)


# ── a diff with a file too big to show: git stopped there, the rest made without it ──


def test_a_huge_files_diff_stops_git_and_the_rest_is_the_same_in_the_same_order(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(code_changes, "PATCH_BYTES", 50_000)
    big = "".join(f"line {i:07d} of a big text file\n" for i in range(4000))  # 140 KB
    files = {
        "a.txt": "1\n",
        "big1.txt": big,
        "c [odd] name*.txt": "3\n",
        "d/big2.txt": big,
        "e.txt": "5\n",
        "old.txt": big,
        "z.txt": "26\n",
    }
    repo = make_repo(tmp_path / "proj", files)
    for name in ("a.txt", "c [odd] name*.txt", "e.txt", "z.txt"):
        (repo / name).write_text("changed\n")
    (repo / "big1.txt").write_text(big.upper())
    (repo / "d" / "big2.txt").write_text(big.replace("line", "LINE"))
    git(repo, "mv", "old.txt", "renamed.txt")  # a rename whose patch is huge
    every_4th = [ln.upper() if i % 4 == 0 else ln for i, ln in enumerate(big.splitlines(True))]
    (repo / "renamed.txt").write_text("".join(every_4th))  # (75% alike: still a rename)
    real = code_changes.git
    calls = []

    def counted(cwd, *args, **kw):
        calls.append((args, kw.get("stop") is not None))
        return real(cwd, *args, **kw)

    monkeypatch.setattr(code_changes, "git", counted)
    view = code_changes.session_view(repo, [], scoped=False)
    got = [(f.path, f.status, f.big, f.added, f.removed, len(f.hunks)) for f in view.files]
    diffs = [stopping for args, stopping in calls if "diff" in args]
    assert diffs == [True, True, True, True]  # stopped at each big file, then once to the end
    # The same view as before, when git went on writing each big file's patch to the end.
    monkeypatch.setattr(code_changes, "_diff_patch", old_diff_patch)
    before = code_changes.session_view(repo, [], scoped=False)
    assert got == [
        (f.path, f.status, f.big, f.added, f.removed, len(f.hunks)) for f in before.files
    ]
    assert [f.path for f in before.files] == [f.path for f in view.files]
    by = {f.path: f for f in view.files}
    assert by["big1.txt"].big and by["d/big2.txt"].big and by["renamed.txt"].big
    assert by["renamed.txt"].status == "R" and by["renamed.txt"].old_path == "old.txt"
    assert not by["c [odd] name*.txt"].big and by["c [odd] name*.txt"].added == 1


def old_diff_patch(top, args, spec):
    cut: set[int] = set()
    found = code_changes.git(top, *args, "--", spec, timeout=60, cut=cut)
    files = code_changes.parse_patch(found.out) if found.ok else []
    for i in cut:
        if i < len(files):
            files[i].big, files[i].binary, files[i].hunks = True, True, []
    return files


def test_git_stops_writing_a_big_patch_once_it_is_known_to_be_too_big(tmp_path, monkeypatch):
    monkeypatch.setattr(code_changes, "PATCH_BYTES", 50_000)
    big = "".join(f"line {i:07d}\n" for i in range(200_000))  # 2.6 MB
    repo = make_repo(tmp_path / "proj", {"big.txt": big, "small.txt": "1\n"})
    (repo / "big.txt").write_text(big.replace("line", "LINE"))
    (repo / "small.txt").write_text("2\n")
    stop: dict = {}
    found = code_changes.git(
        repo, *code_changes._diff_args(), "--", ".", cut=set(), stop=stop, timeout=60
    )
    assert found.ok and found.out == ""  # nothing before it; small.txt is made next, alone
    assert stop["index"] == 0 and b"Binary files differ" in stop["section"]
    files = code_changes.diff_files(code_changes.repo_of(repo), "HEAD")
    assert [(f.path, f.big) for f in files] == [("big.txt", True), ("small.txt", False)]


# ── the Git panel: one git fewer, the same answer ──


def test_the_git_panel_reads_its_folder_and_a_merge_under_way_from_one_git(tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "proj", {"a.txt": "1\n"})
    real = code_changes.git
    asked = []

    def counted(cwd, *args, **kw):
        asked.append(args)
        return real(cwd, *args, **kw)

    monkeypatch.setattr(code_git, "git", counted)
    monkeypatch.setattr(code_changes, "git", counted)
    monkeypatch.setattr(worktrees, "git", counted)
    plain = code_git.state(repo)
    assert plain["repo"] and not plain["merging"] and not plain["rebasing"]
    assert len(asked) == 6  # (it was 7: the git folder and MERGE_HEAD asked apart)
    head = git(repo, "rev-parse", "HEAD").strip()
    (repo / ".git" / "MERGE_HEAD").write_text(head + "\n")
    assert code_git.state(repo)["merging"]
    (repo / ".git" / "MERGE_HEAD").unlink()
    (repo / ".git" / "rebase-merge").mkdir()
    assert code_git.state(repo)["rebasing"] and not code_git.state(repo)["merging"]
    assert code_git.state(tmp_path / "nowhere") == {"repo": False}


# ── the projects' branches, side by side ──


async def test_the_projects_branches_are_read_side_by_side_in_the_lists_order(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    root = tmp_path / "projects"
    for i in range(12):
        folder = root / f"p{i:02d}"
        folder.mkdir(parents=True)
        if i % 3:
            make_repo(folder, {"a": "1\n"})
            git(folder, "checkout", "-q", "-b", f"branch-{i}")
    hub = make_hub(replace(settings, projects_dir=root), quiet_speaker, isolated)
    real = hub._git
    running = {"now": 0, "most": 0}

    async def slow(path, *args, **kw):
        running["now"] += 1
        running["most"] = max(running["most"], running["now"])
        try:
            await asyncio.sleep(0.05)
            return await real(path, *args, **kw)
        finally:
            running["now"] -= 1

    monkeypatch.setattr(hub, "_git", slow)
    items = await hub._projects_overview()
    assert [i["name"] for i in items] == [f"p{i:02d}" for i in range(12)]
    assert [i["branch"] for i in items] == [f"branch-{i}" if i % 3 else "" for i in range(12)]
    assert [i["git"] for i in items] == [bool(i % 3) for i in range(12)]
    assert 1 < running["most"] <= 8


async def test_a_projects_git_card_asks_its_three_questions_at_once(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    root = tmp_path / "projects"
    repo = make_repo(root / "alpha", {"a.txt": "1\n", "b.txt": "2\n"})
    (repo / "a.txt").write_text("changed\n")
    hub = make_hub(replace(settings, projects_dir=root), quiet_speaker, isolated)
    real = hub._git
    running = {"now": 0, "most": 0}

    async def slow(path, *args, **kw):
        running["now"] += 1
        running["most"] = max(running["most"], running["now"])
        try:
            await asyncio.sleep(0.05)
            return await real(path, *args, **kw)
        finally:
            running["now"] -= 1

    monkeypatch.setattr(hub, "_git", slow)
    card = await hub._git_status("alpha")
    assert card["git"] and card["branch"] == "main"
    assert card["files"] == [{"status": "M", "path": "a.txt"}]
    assert "1 file changed" in card["stat"] and len(card["log"]) == 1
    assert running["most"] == 3


# ── the Problems pane's checkers stop with the app ──


def test_the_problems_checkers_stop_when_the_app_quits(monkeypatch):
    stopped = []
    monkeypatch.setattr(diagnostics.runproc, "kill_all_now", lambda procs: stopped.append(procs))
    diags = diagnostics.Diagnostics(lambda *a, **k: None)
    diags._procs = {"ruff": "running ruff"}
    diags.shutdown()  # (it was nested inside _report, after a return: never a method)
    assert stopped == [["running ruff"]]
