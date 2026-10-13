"""Eden Code hardening (the 2026-10-13 audit, items W1-W7, W21, W29-W31): spending caps that
hold with sessions in parallel, forks and reconnects counted once, the midnight reset on
time, a session's own usage-limit reset, the restart check that waits for terminals, !
runs, test runs and preview checks, test reports read off the loop, watch mode's bounds,
and no git on the Mac."""

from types import SimpleNamespace

from code_session_fakes import make_hub

from jarvis import hub as hub_module

# ── W31: no git installed ──


async def test_no_git_on_the_mac_is_no_answer_not_an_error(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)

    async def no_git(*_args, **_kwargs):
        raise FileNotFoundError(2, "No such file or directory", "git")

    monkeypatch.setattr(hub_module.asyncio, "create_subprocess_exec", no_git)
    assert await hub._git(tmp_path, "rev-parse", "--abbrev-ref", "HEAD") == ""


# ── W21: what a quiet update waits for ──


async def test_a_restart_waits_for_terminal_jobs_bang_runs_test_runs_and_preview_checks(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert not hub.busy()
    idle = SimpleNamespace(exited=False, busy=lambda: "")
    working = SimpleNamespace(exited=False, busy=lambda: "sleep 60")
    gone = SimpleNamespace(exited=True, busy=lambda: "sleep 60")
    hub.code_terminal.shells.items = {"t1": idle, "t2": gone}
    assert not hub.busy()  # a shell at its prompt, or one that ended, loses nothing
    hub.code_terminal.shells.items["t3"] = working
    assert hub.busy()
    hub.code_terminal.shells.items = {}
    hub.code_terminal.runs["r1"] = object()  # a ! command running
    assert hub.busy()
    hub.code_terminal.runs.clear()
    runs = hub.code_verify.tests.runs
    runs["/p"] = SimpleNamespace(status="passed")
    assert not hub.busy()
    runs["/p"].status = "running"
    assert hub.busy()
    runs.clear()
    hub.code_verify.sessions[1] = SimpleNamespace(checking=True)
    assert hub.busy()
    hub.code_verify.sessions[1].checking = False
    assert not hub.busy()

    def broken():
        raise RuntimeError("psutil can't see it")

    hub.code_terminal.shells.items = {"t4": SimpleNamespace(exited=False, busy=broken)}
    assert not hub.busy()  # a shell that can't be asked never holds an update back
