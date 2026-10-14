"""B2: a copy's container could rewrite the git data mounted into it so that the next git
Eden runs on the Mac in that copy (git add -A as it lands, opens a pull request, shows the
changes) ran a program of the container's choosing: a clean filter in a config git reads
from a gitdir the container made. Real git in temp repositories; no docker (what the
container could write is written here directly, through the mounts git_mounts names)."""

from pathlib import Path

from test_code_changes import git, make_repo

from jarvis import code_changes, code_search, devcontainer


def a_copy(tmp_path: Path) -> tuple[Path, Path, Path]:
    """A main repository and a worktree of it, as Eden makes a copy: (repo, checkout, own)."""
    repo = make_repo(tmp_path / "proj", {"a.py": "x\n"})
    checkout = tmp_path / "copies" / "proj"
    git(repo, "worktree", "add", "-q", "-b", "jarvis/c1", str(checkout))
    own = Path((checkout / ".git").read_text().split(":", 1)[1].strip())
    return repo, checkout, own


def plant(checkout: Path, own: Path, ran: Path, via: str) -> None:
    """What a container can do with a writable mount: a git dir of its own in the copy, a
    clean filter in its config, and git pointed at it (the copy's .git file, or the
    worktree's commondir)."""
    fake = checkout / ".cache" / "g"
    fake.mkdir(parents=True)
    git(fake.parent, "init", "-q", "--bare", str(fake))
    (fake / "config").write_text(
        f'[core]\n\trepositoryformatversion = 0\n\tbare = false\n'
        f'[filter "x"]\n\tclean = "touch {ran}; cat"\n'
    )
    (checkout / ".gitattributes").write_text("* filter=x\n")
    (checkout / "b.py").write_text("y\n")
    if via == "commondir":
        (own / "commondir").write_text(str(fake) + "\n")
    else:
        (checkout / ".git").write_text(f"gitdir: {fake}\n")


def test_the_container_cant_write_the_worktrees_own_git_data(tmp_path):
    _repo, checkout, own = a_copy(tmp_path)
    args = devcontainer.git_mounts(checkout)
    mounts = [args[i + 1] for i in range(0, len(args), 2)]
    assert all(m.endswith(":ro") for m in mounts), mounts
    assert f"{own}:{own}:ro" in mounts
    assert f"{checkout / '.git'}:{checkout / '.git'}:ro" in mounts  # its .git file too


def test_a_rewritten_git_pointer_runs_nothing_on_the_mac(tmp_path):
    for via in ("commondir", "dotgit"):
        case = tmp_path / via
        _repo, checkout, own = a_copy(case)
        pin = devcontainer.git_pin(checkout)
        assert pin is not None
        code_changes.pin_git(str(checkout), pin)
        try:
            ran = case / "ran-on-the-mac"
            plant(checkout, own, ran, via)
            done = code_changes.git(checkout, "add", "-A")
            code_changes.git(checkout, "status", "--porcelain")
            code_changes.git(checkout / ".cache", "status")  # (from a folder inside it)
            assert not ran.exists(), f"{via}: the container's filter ran on the Mac"
            log = code_changes.git(checkout, "log", "--format=%s", "-1")
            if via == "commondir":  # (git reads that file whatever it's told: none runs)
                assert not done.ok and "changed from inside" in done.err
                assert not log.ok and not code_search.is_git(checkout)
            else:  # git goes on with the copy's real data, the planted pointer ignored
                assert done.ok and log.ok and log.out.strip() == "start"
                assert "b.py" in code_changes.git(checkout, "diff", "--cached", "--name-only").out
        finally:
            code_changes.unpin_git(str(checkout))


def test_unpinned_the_same_plant_did_run_on_the_mac(tmp_path):
    """The escape as it was (and still is, for a copy no container ever had): proof the
    plant above is a real one."""
    for via in ("commondir", "dotgit"):
        _repo, checkout, own = a_copy(tmp_path / via)
        ran = tmp_path / via / "ran-on-the-mac"
        plant(checkout, own, ran, via)
        code_changes.git(checkout, "add", "-A")
        assert ran.exists(), via
