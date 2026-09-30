"""The diagnostics file (jarvis.features.ops.diagnostics): the newest logs within the size
asked for, every secret masked, versions without running anything, and the security
review reduced to its headlines."""

import json
import os
import zipfile
from datetime import datetime

from jarvis.features.ops import diagnostics


def test_the_newest_logs_fit_the_budget_starting_at_a_whole_line(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "jarvis.log.1").write_text("old line\n" * 100)
    os.utime(logs / "jarvis.log.1", (1, 1))
    (logs / "jarvis.log").write_text("".join(f"line {i:04d}\n" for i in range(200)))
    (logs / "unrelated.txt").write_text("not a log of ours")
    (logs / "backend.log").symlink_to(tmp_path / "elsewhere.log")  # never followed
    (tmp_path / "elsewhere.log").write_text("secret")
    tails = diagnostics.log_tails(logs, 500)
    assert [name for name, _raw in tails][0] == "jarvis.log"
    body = tails[0][1].decode()
    assert body.startswith("line ") and body.endswith("line 0199\n")
    assert sum(len(raw) for _name, raw in tails) <= 500
    assert all(name != "backend.log" for name, _raw in tails)


def test_the_commit_is_read_from_git_files(tmp_path):
    git = tmp_path / ".git"
    (git / "refs" / "heads").mkdir(parents=True)
    (git / "HEAD").write_text("ref: refs/heads/main\n")
    (git / "refs" / "heads" / "main").write_text("0123456789abcdef0123\n")
    assert diagnostics.git_commit(tmp_path) == "0123456789ab"
    (git / "refs" / "heads" / "main").unlink()
    (git / "packed-refs").write_text("# pack-refs\nfedcba9876543210 refs/heads/main\n")
    assert diagnostics.git_commit(tmp_path) == "fedcba987654"
    assert diagnostics.git_commit(tmp_path / "nothing") == ""


def test_the_bundle_masks_and_keeps_only_headlines(tmp_path):
    home = tmp_path / "home"
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "jarvis.log").write_text(
        f"2026-09-29 20:00:00,000 ERROR token=abcdef123456 in {home}/Documents for bob@x.io\n"
    )
    checkup = {"checks": [{"id": "logs", "details": ["api_key: sk-abcdefghijklmnopqrst12"]}]}
    review = {
        "findings": [
            {
                "id": "companion",
                "state": "risk",
                "summary": "On, without encryption",
                "items": [{"label": "Ann's iPhone"}],
            }
        ]
    }
    path = diagnostics.build(
        tmp_path / "out",
        logs=logs,
        home=home,
        info={"macos": "27.0"},
        checkup=checkup,
        review=review,
        megabytes=7,  # not one of the sizes offered: the default
        clock=lambda: datetime(2026, 9, 29, 20, 15, 12),
    )
    assert path.name == "Jarvis diagnostics 2026-09-29 at 20.15.12.zip"
    with zipfile.ZipFile(path) as zf:
        log = zf.read("logs/jarvis.log").decode()
        checked = json.loads(zf.read("checkup.json"))
        security = json.loads(zf.read("security.json"))
        readme = zf.read("README.txt").decode()
    assert log == "2026-09-29 20:00:00,000 ERROR token=[hidden] in ~/Documents for [email]\n"
    assert checked["checks"][0]["details"] == ["api_key: [hidden]"]
    assert security == [{"id": "companion", "state": "risk", "summary": "On, without encryption"}]
    assert "the last 2 MB" in readme
    again = diagnostics.build(
        tmp_path / "out",
        logs=logs,
        home=home,
        info={},
        checkup=None,
        review=None,
        clock=lambda: datetime(2026, 9, 29, 20, 15, 12),
    )
    assert again.name == "Jarvis diagnostics 2026-09-29 at 20.15.12 2.zip"
    assert not [p for p in os.listdir(tmp_path / "out") if p.startswith(".")]


def test_versions_run_nothing():
    info = diagnostics.versions({"claude": "Max · 2.1.284"})
    assert info["python"] and info["claude"] == "Max · 2.1.284"
    assert "macos" in info and "machine" in info
