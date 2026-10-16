"""Eden Cloud's API end to end, with the fake backend: auth, limits, a whole run through the
real runner (a fake Claude Code CLI, real git), cancel, the time limit, the budget, cleanup."""

from __future__ import annotations

import asyncio
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from eden_cloud.app import build
from eden_cloud.auth import AuthError, Verifier
from eden_cloud.backends import FakeBackend
from eden_cloud.config import Settings
from fakes import ACCOUNT, DEV, KEY, OTHER, Signer, fake_claude, git, repo_with_bundle, start_runner


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


def make(tmp_path, backend=None, clock=None, **kw):
    kw.setdefault("dev_tokens", {DEV: ACCOUNT})
    settings = Settings(data_dir=tmp_path / "data", backend="fake", **kw)
    backend = backend or FakeBackend()
    app = build(settings, backend=backend, watch=False, clock=clock)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cloud")
    return app, client, backend


AUTH = {"authorization": f"Bearer {DEV}"}


def body(head, **kw):
    out = {
        "brief": "Add hello.txt",
        "anthropic_key": KEY,
        "source": {"kind": "bundle", "branch": "feature", "base": head},
    }
    out.update(kw)
    return out


# ── who may call ──


def test_tokens_from_askeden_are_checked_with_its_key():
    signer = Signer()
    v = Verifier(signer.public)
    user = v.verify(f"Bearer {signer.token()}")
    assert (user.account, user.plan) == (ACCOUNT, "plus")
    for bad, code in [
        (signer.token(aud="else"), "signed_out"),
        (signer.token(exp=int(time.time()) - 600), "expired"),
        (signer.token(exp=int(time.time()) + 3600), "expired"),  # longer than any we mint
        (signer.token(kind="web"), "forbidden"),
        (signer.token(sub="not-an-account"), "signed_out"),
        (Signer().token(), "signed_out"),  # someone else's key
        ("jv1.x.y.z", "wrong_token"),
        ("", "signed_out"),
    ]:
        with pytest.raises(AuthError) as err:
            v.verify(f"Bearer {bad}" if bad else "")
        assert err.value.code == code, bad
    assert v.verify(f"Bearer {signer.token(plan='free')}").plan == "free"


def test_a_service_without_a_key_takes_no_token():
    with pytest.raises(AuthError) as err:
        Verifier("").verify(f"Bearer {Signer().token()}")
    assert err.value.status == 503


def test_production_refuses_dev_tokens_and_local_backends():
    s = Settings(
        production=True, dev_tokens={DEV: ACCOUNT}, backend="docker", public_url="http://x"
    )
    problems = " ".join(s.problems())
    assert "DEV_TOKENS" in problems and "development only" in problems and "https" in problems
    with pytest.raises(RuntimeError):
        build(s, backend=FakeBackend(), watch=False)


async def test_plus_only_by_default(tmp_path):
    signer = Signer()
    settings = Settings(data_dir=tmp_path / "d", backend="fake", askeden_public_key=signer.public)
    app = build(settings, backend=FakeBackend(), watch=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://c") as c:
        free = {"authorization": f"Bearer {signer.token(plan='free')}"}
        r = await c.get("/v1/me", headers=free)
        assert r.status_code == 402 and r.json()["code"] == "plan_needed"
        r = await c.get("/v1/me", headers={"authorization": f"Bearer {signer.token()}"})
        assert r.status_code == 200 and r.json()["limits"]["max_running"] == 1
        assert (await c.get("/v1/runs")).status_code == 401


# ── submitting ──


async def test_submissions_are_checked(tmp_path):
    _app, c, backend = make(tmp_path)
    head = "a" * 40
    for bad in [
        body(head, brief=""),
        body(head, anthropic_key=""),
        body(head, anthropic_key="not-a-key-at-all-0123456789"),
        body(head, source={"kind": "bundle", "branch": "--upload-pack=x", "base": head}),
        body(head, source={"kind": "bundle", "branch": "a..b", "base": head}),
        body(head, source={"kind": "bundle", "branch": "main", "base": "HEAD"}),
        body(
            head, source={"kind": "git", "branch": "main", "url": "https://user:pw@github.com/a/b"}
        ),
        body(head, source={"kind": "git", "branch": "main", "url": "file:///etc"}),
        body(head, source={"kind": "git", "branch": "main", "url": "ssh://github.com/a/b"}),
        body(head, model="claude; rm -rf /"),
    ]:
        r = await c.post("/v1/runs", json=bad, headers=AUTH)
        assert r.status_code == 400, (bad, r.text)
    r = await c.post("/v1/runs", json=body(head, budget_usd=1000, max_minutes=9999), headers=AUTH)
    assert r.status_code == 201
    run = r.json()
    assert run["state"] == "uploading" and run["budget_usd"] == 20.0 and run["max_minutes"] == 60
    assert "anthropic_key" not in r.text and KEY not in r.text and "brief" not in run
    r = await c.put(f"/v1/runs/{run['id']}/source", content=b"not a bundle", headers=AUTH)
    assert r.status_code == 400
    assert not backend.started


async def test_another_account_cant_see_a_run(tmp_path):
    other = "other-dev-token-0123456789abcdef"
    _app, c, _backend = make(tmp_path, dev_tokens={DEV: ACCOUNT, other: OTHER})
    run_id = (await c.post("/v1/runs", json=body("b" * 40), headers=AUTH)).json()["id"]
    h = {"authorization": f"Bearer {other}"}
    for method, path in [
        ("GET", ""),
        ("GET", "/events"),
        ("POST", "/cancel"),
        ("GET", "/result"),
        ("PUT", "/source"),
        ("DELETE", ""),
    ]:
        r = await c.request(method, f"/v1/runs/{run_id}{path}", headers=h)
        assert r.status_code == 404, (method, path)
    assert (await c.get("/v1/runs", headers=h)).json()["runs"] == []
    assert len((await c.get("/v1/runs", headers=AUTH)).json()["runs"]) == 1


async def test_waiting_runs_are_capped(tmp_path):
    _app, c, backend = make(tmp_path, max_queued_per_user=1)
    ok = [await c.post("/v1/runs", json=body("c" * 40), headers=AUTH) for _ in range(3)]
    assert [r.status_code for r in ok] == [201, 201, 429]


# ── a whole run ──


async def test_a_run_from_bundle_to_reviewable_result(tmp_path):
    loop = asyncio.get_running_loop()
    threads = []
    holder = {}

    def on_start(launch):
        assert launch.env["ANTHROPIC_API_KEY"] == KEY and launch.env["EDEN_RUN_TOKEN"].startswith(
            "ert1."
        )
        work = tmp_path / "work"
        work.mkdir()
        threads.append(start_runner(launch, holder["c"], loop, work, fake_claude(tmp_path)))

    backend = FakeBackend(on_start)
    app, c, _ = make(tmp_path, backend=backend)
    holder["c"] = c
    _repo, head, bundle = repo_with_bundle(tmp_path)
    run = (await c.post("/v1/runs", json=body(head), headers=AUTH)).json()
    r = await c.put(f"/v1/runs/{run['id']}/source", content=bundle, headers=AUTH)
    assert r.status_code == 200 and r.json()["state"] in ("starting", "running")
    # The key is gone from the service once the machine has it.
    assert app.state.service._keys == {}
    # The Mac follows its events by long-polling.
    seen, after = [], 0
    for _ in range(100):
        r = await c.get(
            f"/v1/runs/{run['id']}/events", params={"after": after, "wait": 2}, headers=AUTH
        )
        data = r.json()
        seen += [e["line"] for e in data["events"]]
        after = data["events"][-1]["seq"] if data["events"] else after
        if data["run"]["state"] in ("done", "failed"):
            break
    thread, done = threads[0]
    await asyncio.to_thread(thread.join, 30)
    final = (await c.get(f"/v1/runs/{run['id']}", headers=AUTH)).json()
    assert final["state"] == "done", (final["error"], final["exit_code"])
    assert final["cost_usd"] == pytest.approx(0.12) and final["has_result"] and final["has_diff"]
    assert any('"init"' in line for line in seen) and any('"result"' in line for line in seen)
    # The machine was stopped (its workspace with it), the source deleted, the token dead.
    assert backend.stopped == [f"eden-run-{run['id']}"]
    assert not (app.state.store.dir(run["id"]) / "source.bundle").exists()
    r = await c.get(
        f"/v1/runner/{run['id']}/job", headers={"authorization": "Bearer " + "ert1." + "x" * 43}
    )
    assert r.status_code == 401
    # The result: a bundle that lands on the branch, and the diff.
    diff = (await c.get(f"/v1/runs/{run['id']}/diff", headers=AUTH)).text
    assert "hello.txt" in diff
    result = tmp_path / "back.bundle"
    result.write_bytes((await c.get(f"/v1/runs/{run['id']}/result", headers=AUTH)).content)
    git(_repo, "fetch", "-q", str(result), "refs/heads/feature:refs/eden/back")
    assert git(_repo, "show", "refs/eden/back:hello.txt") == "hi"
    assert git(_repo, "log", "-1", "--format=%an", "refs/eden/back") == "Eden Cloud"
    assert done["code"] == 0
    # Deleting it deletes everything.
    assert (await c.delete(f"/v1/runs/{run['id']}", headers=AUTH)).status_code == 204
    assert (await c.get(f"/v1/runs/{run['id']}", headers=AUTH)).status_code == 404
    assert not app.state.store.dir(run["id"]).exists()


async def test_over_budget_stops_it(tmp_path):
    loop = asyncio.get_running_loop()
    threads = []
    holder = {}

    def on_start(launch):
        work = tmp_path / "work"
        work.mkdir()
        threads.append(
            start_runner(
                launch,
                holder["c"],
                loop,
                work,
                fake_claude(tmp_path),
                {"FAKE_CLAUDE_MODE": "spend"},
            )
        )

    backend = FakeBackend(on_start)
    _app, c, _ = make(tmp_path, backend=backend)
    holder["c"] = c
    _repo, head, bundle = repo_with_bundle(tmp_path)
    run = (await c.post("/v1/runs", json=body(head, budget_usd=2), headers=AUTH)).json()
    await c.put(f"/v1/runs/{run['id']}/source", content=bundle, headers=AUTH)
    for _ in range(60):
        state = (await c.get(f"/v1/runs/{run['id']}", headers=AUTH)).json()
        if state["state"] not in ("starting", "running"):
            break
        await asyncio.sleep(0.25)
    assert state["state"] == "over_budget", state
    assert "budget" in state["error"]
    thread, _done = threads[0]
    await asyncio.to_thread(thread.join, 30)  # (the runner hears stop and kills Claude Code)
    assert not thread.is_alive()


# ── limits over time, cancel, cleanup ──


async def test_time_limit_cancel_and_cleanup(tmp_path):
    clock = Clock()
    backend = FakeBackend()
    app, c, _ = make(tmp_path, backend=backend, clock=clock, max_running_per_user=1)
    service = app.state.service
    first = (await c.post("/v1/runs", json=body("d" * 40, max_minutes=5), headers=AUTH)).json()
    second = (await c.post("/v1/runs", json=body("d" * 40), headers=AUTH)).json()
    await c.put(f"/v1/runs/{first['id']}/source", content=b"# v2 git bundle\nx", headers=AUTH)
    await c.put(f"/v1/runs/{second['id']}/source", content=b"# v2 git bundle\nx", headers=AUTH)

    def states():
        return {x["id"]: service.store.get(x["id"]).state for x in (first, second)}

    assert states() == {first["id"]: "starting", second["id"]: "queued"}  # one at a time
    clock.now += 6 * 60
    await service.tick()
    assert states() == {first["id"]: "timed_out", second["id"]: "starting"}  # the next one starts
    r = await c.post(f"/v1/runs/{second['id']}/cancel", headers=AUTH)
    assert r.json()["state"] == "cancelled"
    assert backend.stopped == [f"eden-run-{first['id']}", f"eden-run-{second['id']}"]
    use = (await c.get("/v1/me", headers=AUTH)).json()["usage"]
    assert use["running"] == 0 and use["minutes_used"] == pytest.approx(6.0, abs=0.1)
    clock.now += 25 * 3600
    await service.tick()
    assert service.store.get(first["id"]) is None and service.store.get(second["id"]) is None


async def test_a_machine_that_dies_fails_the_run_and_a_restart_forgets_keys(tmp_path):
    clock = Clock()
    backend = FakeBackend()
    app, c, _ = make(tmp_path, backend=backend, clock=clock)
    service = app.state.service
    run = (await c.post("/v1/runs", json=body("e" * 40), headers=AUTH)).json()
    await c.put(f"/v1/runs/{run['id']}/source", content=b"# v2 git bundle\nx", headers=AUTH)
    backend.live[f"eden-run-{run['id']}"] = False
    clock.now += 60
    await service.tick()
    assert service.store.get(run["id"]).state == "failed"
    # A run still waiting when the service restarts: its key went with the old process.
    waiting = (await c.post("/v1/runs", json=body("e" * 40), headers=AUTH)).json()
    service._keys.clear()
    service._recovered = False
    await service.recover()
    assert "send it again" in service.store.get(waiting["id"]).error


async def test_daily_minutes_run_out(tmp_path):
    clock = Clock()
    app, c, _ = make(tmp_path, clock=clock, daily_minutes_per_user=10, max_queued_per_user=5)
    service = app.state.service
    run = (await c.post("/v1/runs", json=body("f" * 40, max_minutes=60), headers=AUTH)).json()
    await c.put(f"/v1/runs/{run['id']}/source", content=b"# v2 git bundle\nx", headers=AUTH)
    assert service.store.get(run["id"]).deadline == pytest.approx(
        clock.now + 600
    )  # what's left today
    clock.now += 601
    await service.tick()
    r = await c.post("/v1/runs", json=body("f" * 40), headers=AUTH)
    assert r.status_code == 429 and r.json()["code"] == "over_daily"


async def test_backend_failure_fails_the_run(tmp_path):
    backend = FakeBackend()
    backend.fail = "no capacity"
    app, c, _ = make(tmp_path, backend=backend)
    run = (await c.post("/v1/runs", json=body("1" * 40), headers=AUTH)).json()
    r = await c.put(f"/v1/runs/{run['id']}/source", content=b"# v2 git bundle\nx", headers=AUTH)
    assert r.json()["state"] == "failed" and "no capacity" in r.json()["error"]
    assert app.state.service._keys == {}


def test_git_is_here():
    assert subprocess.run(["git", "--version"], capture_output=True).returncode == 0
    assert Path(__file__).exists()
