"""Model Router coverage (features/code_router and features/code_router_events): Ask Gemini's
refusals (an oversized request, today's cap, Google unreachable); the full page opening, or
saying why it can't (not built, no Node, never answered); and the learner: when it runs, when
it's skipped, the nightly run, and every way its run can fail. The learner's Node process is
always a stand-in here; nothing real is started and nothing reaches the network."""

import asyncio
import json
import os
import time

import httpx
import pytest
from code_session_fakes import make_hub

from jarvis import utility_model
from jarvis.features import code_router, code_router_events
from jarvis.features._router_log import iso


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


def emitted(hub):
    out = []
    hub.emit = lambda kind, **data: out.append((kind, data))
    return out


BODY = {"contents": [{"parts": [{"text": "Rate: fix the typo"}]}]}
SECRET = "AIza" + "k" * 35


def classify(**more):
    return {"type": "model_router_classify", "rid": "r", "model": "gemini-3.6-flash", **more}


# ── Ask Gemini ──


async def test_an_oversized_or_contentless_rating_request_is_refused_before_google(
    hub, monkeypatch
):
    """A body without contents, or one bigger than the router ever sends, gets a 400 and
    never reaches Google (nor the key)."""
    events = emitted(hub)
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: SECRET)
    seen = []
    hub.code_router.transport = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200))
    huge = {"contents": [{"parts": [{"text": "x" * (code_router.MAX_REQUEST + 10)}]}]}
    for body in ({"generationConfig": {}}, huge):
        await hub._handle(classify(body=body))
    assert [d["status"] for _, d in events] == [400, 400]
    assert all("Not a request" in json.loads(d["body"])["error"]["message"] for _, d in events)
    assert seen == []


async def test_past_todays_gemini_cap_the_router_is_told_to_use_its_rules(hub, monkeypatch):
    """Once the day's ratings are used up, nothing goes to Google and the reply (429) says
    the router's own rules apply until tomorrow."""
    events = emitted(hub)
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: SECRET)
    monkeypatch.setitem(utility_model.POLICY, code_router.PURPOSE, 0)
    seen = []
    hub.code_router.transport = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200))
    await hub._handle(classify(body=BODY))
    ((kind, data),) = events
    assert kind == "model_router_classified" and data["status"] == 429
    assert "own rules until tomorrow" in json.loads(data["body"])["error"]["message"]
    assert seen == []


async def test_google_unreachable_is_a_502_naming_the_error_not_the_key(hub, monkeypatch):
    """A network failure on the way to Google answers 502 with the error's kind, and the
    key never appears in what the window gets."""
    events = emitted(hub)
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: SECRET)

    def down(request):
        raise httpx.ConnectError("refused", request=request)

    hub.code_router.transport = httpx.MockTransport(down)
    await hub._handle(classify(body=BODY))
    ((_, data),) = events
    assert data["status"] == 502 and "ConnectError" in data["body"]
    assert SECRET not in json.dumps(events)


async def test_a_key_google_echoes_back_is_blanked_out(hub, monkeypatch):
    """Should Google's reply ever quote the key, the window gets it blanked."""
    events = emitted(hub)
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: SECRET)
    hub.code_router.transport = httpx.MockTransport(
        lambda r: httpx.Response(403, text=f"bad key {SECRET}")
    )
    await hub._handle(classify(body=BODY))
    ((_, data),) = events
    assert data["status"] == 403 and SECRET not in data["body"] and "bad key" in data["body"]


# ── the full page ──


@pytest.fixture
def opened(monkeypatch):
    calls = []

    async def run_command(*args, **kw):
        calls.append(args)
        return ""

    monkeypatch.setattr(code_router.mac_tools, "run_command", run_command)
    return calls


async def test_the_page_already_up_is_just_opened(hub, opened):
    """When the page's server answers, Open opens it in the browser and starts nothing."""
    hub.code_router.transport = httpx.MockTransport(
        lambda r: httpx.Response(200 if r.url.path.endswith("/api/meta") else 404)
    )

    async def never():
        raise AssertionError("started a server that was already up")

    hub.code_router._start_page = never
    await hub._handle({"type": "model_router_open"})
    assert opened == [("open", code_router.UI_URL)]


async def test_a_page_that_cant_start_says_why_and_opens_nothing(
    hub, opened, tmp_path, monkeypatch
):
    """Nothing listening and the repo not built: the window gets a note to build it, and no
    browser opens."""
    events = emitted(hub)

    def refused(request):
        raise httpx.ConnectError("refused", request=request)

    hub.code_router.transport = httpx.MockTransport(refused)
    monkeypatch.setenv("MODEL_ROUTER_HOME", str(tmp_path / "Model Router"))
    await hub._handle({"type": "model_router_open"})
    ((kind, data),) = events
    assert kind == "model_router_note" and "npm run build" in data["text"]
    assert opened == []


def built(tmp_path, monkeypatch):
    home = tmp_path / "Model Router"
    (home / "dist" / "ui").mkdir(parents=True)
    (home / "dist" / "ui" / "server.js").write_text("")
    monkeypatch.setenv("MODEL_ROUTER_HOME", str(home))
    return home


async def test_the_page_needs_node_and_says_so(hub, tmp_path, monkeypatch):
    """Built but no Node.js anywhere: the reason is to install it, and nothing is spawned."""
    built(tmp_path, monkeypatch)
    monkeypatch.setattr(code_router.shutil, "which", lambda name: None)
    monkeypatch.setattr(code_router, "NODE_PATHS", (str(tmp_path / "no-node"),))

    async def spawn(*a, **kw):
        raise AssertionError("spawned without node")

    monkeypatch.setattr(code_router.asyncio, "create_subprocess_exec", spawn)
    assert "nodejs.org" in await hub.code_router._start_page()


async def test_a_page_that_never_answers_is_reported_and_has_no_gemini_key_without_one(
    hub, tmp_path, monkeypatch
):
    """Without a Gemini key the page's server isn't given one (nor a ratings cap); if it
    never answers, the reason is that the page didn't start."""
    home = built(tmp_path, monkeypatch)
    monkeypatch.setattr(code_router.shutil, "which", lambda name: "/usr/local/bin/node")
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: "")
    started = {}

    async def spawn(*args, env=None, cwd=None, **kw):
        started.update(args=args, env=env, cwd=cwd)
        return object()

    sleep = asyncio.sleep
    asked = []

    async def answers():
        asked.append(1)
        return False

    monkeypatch.setattr(code_router.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(code_router.asyncio, "sleep", lambda s: sleep(0))
    hub.code_router._answers = answers
    assert await hub.code_router._start_page() == "Model Router's page didn't start."
    assert len(asked) == 30
    assert started["cwd"] == str(home) and str(code_router.UI_PORT) in started["args"]
    assert "GEMINI_API_KEY" not in started["env"]
    assert "MODEL_ROUTER_UI_RATINGS_PER_DAY" not in started["env"]


# ── the learner: when it runs ──


def stand_in(events):
    ran = []

    async def learner(ev):
        ran.append(ev)
        return ""

    events.learner = learner
    return ran


async def test_the_learner_waits_for_enough_new_events_and_an_hour_between_runs(hub):
    """Fewer than LEARN_EVERY new events, or the last run under an hour ago: no run. Both
    met: it runs once and the count starts again."""
    events = hub.code_router_events
    ran = stand_in(events)
    state = events._load_state()
    state["learn"] = {"new": code_router_events.LEARN_EVERY - 1}
    events.maybe_learn()
    state["learn"] = {"new": code_router_events.LEARN_EVERY, "last": iso(time.time() - 60)}
    events.maybe_learn()
    await asyncio.sleep(0.02)
    assert ran == []
    state["learn"] = {"new": code_router_events.LEARN_EVERY, "last": iso(time.time() - 7200)}
    events.maybe_learn()
    assert await until(lambda: len(ran) == 1)
    assert await until(lambda: events._load_state()["learn"]["new"] == 0)
    assert events._load_state()["learn"]["note"] == ""


async def test_one_learner_run_at_a_time(hub):
    """While a run is under way, another reason to learn doesn't start a second one."""
    events = hub.code_router_events
    gate = asyncio.Event()
    ran = []

    async def learner(ev):
        ran.append(1)
        await gate.wait()
        return ""

    events.learner = learner
    events._load_state()["learn"] = {"new": 999}
    events.maybe_learn()
    assert await until(lambda: ran == [1])
    events.maybe_learn()
    events.maybe_learn(force=True)
    await asyncio.sleep(0.02)
    assert ran == [1]
    gate.set()
    assert await until(lambda: events._learning.done())


async def test_learning_switched_off_runs_nothing(hub):
    """The owner's "learn" switch off: nothing is learned however much is new."""
    events = hub.code_router_events
    ran = stand_in(events)
    hub.set_feature_prefs({"code_router_settings": {"learn": False}})
    events._load_state()["learn"] = {"new": 999}
    events.maybe_learn()
    events.maybe_learn(force=True)
    await asyncio.sleep(0.02)
    assert ran == []


def test_without_an_event_loop_the_learner_isnt_started(hub):
    """Called with no loop running (the app quitting, a thread), maybe_learn does nothing
    rather than fail."""
    events = hub.code_router_events
    stand_in(events)
    events._load_state()["learn"] = {"new": 999}
    events.maybe_learn()
    assert events._learning is None


async def test_the_nightly_run_learns_when_anything_was_logged_since_the_last(hub):
    """The nightly (forced) run skips when nothing was logged since the last run, and runs
    when the log was written after it, even with the count at zero."""
    events = hub.code_router_events
    ran = stand_in(events)
    events._load_state()["learn"] = {"new": 0, "last": iso(time.time() + 3600)}
    events.log.append({"ts": iso(), "kind": "route"})
    await events.log.flush()
    events.maybe_learn(force=True)  # (the log is older than the last run)
    await asyncio.sleep(0.02)
    assert ran == []
    events._load_state()["learn"] = {"new": 0, "last": iso(time.time() - 3600)}
    events.maybe_learn(force=True)
    assert await until(lambda: len(ran) == 1)


async def test_the_nightly_run_with_no_log_at_all_is_skipped(hub):
    """No log file and nothing counted: the nightly run has nothing to learn from."""
    events = hub.code_router_events
    ran = stand_in(events)
    events._load_state()["learn"] = {"new": 0}
    events.maybe_learn(force=True)
    await asyncio.sleep(0.02)
    assert ran == []


async def test_a_learner_that_raises_is_noted_and_keeps_the_count(hub):
    """A crash in the learner is caught: its note says it failed (and why), the new count
    stays so it tries again, and the windows are told."""
    events = hub.code_router_events
    pushed = []
    events._push_now = lambda: pushed.append(1)

    async def learner(ev):
        raise RuntimeError("boom")

    events.learner = learner
    events._load_state()["learn"] = {"new": 77}
    assert await events.run_learner() == "failed: RuntimeError"
    learn = events._load_state()["learn"]
    assert learn["new"] == 77 and learn["note"] == "failed: RuntimeError" and learn["last"]
    assert pushed == [1]


async def test_the_nightly_loop_prunes_then_learns_at_its_hour(hub, monkeypatch):
    """Each night it sleeps until NIGHTLY (never under a minute), then prunes the log and
    tries a forced learn; a failure in either doesn't stop the loop."""
    events = hub.code_router_events
    waits, did = [], []

    class Stop(Exception):
        pass

    async def sleep(seconds):
        waits.append(seconds)
        if len(waits) > 2:
            raise Stop

    def prune():
        did.append("prune")
        raise OSError("disk")

    def learn(force=False):
        did.append(("learn", force))
        raise RuntimeError("no")

    # The module's own asyncio only: patching asyncio.sleep itself stalled every other
    # coroutine sleeping meanwhile (the hub's loops, the test runner's).
    monkeypatch.setattr(code_router_events, "asyncio", _AsyncioWith(sleep=sleep))
    events.log.prune = prune
    events.maybe_learn = learn
    with pytest.raises(Stop):
        await events.nightly()
    assert did == ["prune", ("learn", True), "prune", ("learn", True)]
    assert all(60.0 <= w <= 86400 for w in waits)


class _AsyncioWith:
    """asyncio as one module sees it, with some of its functions swapped."""

    def __init__(self, **swapped):
        self.__dict__.update(swapped)

    def __getattr__(self, name):
        return getattr(asyncio, name)


# ── the learner's run (a stand-in Node process) ──


class Proc:
    def __init__(self, returncode=0, write=None, hang=False, err=b""):
        self.returncode = returncode
        self.write = write
        self.hang = hang
        self.err = err
        self.killed = False
        self.args = ()

    async def communicate(self):
        if self.hang:
            await asyncio.Event().wait()
        if self.write is not None:
            out = self.args[list(self.args).index("--out") + 1]
            self.write(out)
        return b"", self.err

    def kill(self):
        self.killed = True


@pytest.fixture
def learner_repo(tmp_path, monkeypatch):
    home = tmp_path / "Model Router"
    (home / "dist").mkdir(parents=True)
    (home / "package.json").write_text(json.dumps({"bin": {"model-router-learn": "dist/learn.js"}}))
    (home / "dist" / "learn.js").write_text("")
    monkeypatch.setenv("MODEL_ROUTER_HOME", str(home))
    monkeypatch.setattr(code_router_events, "_node", lambda: "/usr/local/bin/node")
    return home


def spawning(monkeypatch, proc):
    seen = []

    async def spawn(*args, **kw):
        proc.args = args
        seen.append((args, kw))
        return proc

    monkeypatch.setattr(code_router_events.asyncio, "create_subprocess_exec", spawn)
    return seen


async def logged(events, n=2):
    for i in range(n):
        events.log.append({"ts": iso(time.time() - 10 + i), "kind": "route", "i": i})
    await events.log.flush()


def writes(data):
    def write(out):
        with open(out, "w") as handle:
            handle.write(data if isinstance(data, str) else json.dumps(data))

    return write


GOOD = {
    "v": 1,
    "updated": "2026-10-13T03:40:00Z",
    "overrides": {"gpt-6.1-sol": {"capabilities": {"coding": 90}}},
    "report": [{"model": "gpt-6.1-sol", "dim": "coding", "from": 84, "to": 90, "n": 2}],
}


async def test_the_learner_without_node_says_so(hub, learner_repo, monkeypatch):
    """The repo is built but there's no Node.js: "no node", nothing spawned."""
    monkeypatch.setattr(code_router_events, "_node", lambda: None)
    seen = spawning(monkeypatch, Proc())
    assert await hub.code_router_events.run_learner() == "no node"
    assert seen == []


async def test_the_learner_with_no_events_yet_has_nothing_to_learn(hub, learner_repo, monkeypatch):
    """No log file at all: "no events", nothing spawned."""
    seen = spawning(monkeypatch, Proc())
    assert await hub.code_router_events.run_learner() == "no events"
    assert seen == []


async def test_a_learned_run_builds_on_what_was_learned_and_writes_it_unfrozen(
    hub, learner_repo, monkeypatch
):
    """The learner gets the log files, the last learned.json to build on and the time; what
    it writes becomes learned.json (unfrozen), and its scratch output is cleaned up."""
    events = hub.code_router_events
    await logged(events)
    events.learned_path().write_text(json.dumps({"v": 1, "overrides": {"old": {}}, "report": []}))
    given = {}

    def write(out):
        with open(out) as handle:
            given["before"] = json.load(handle)
        writes(GOOD)(out)

    seen = spawning(monkeypatch, Proc(write=write))
    events._load_state()["learn"] = {"new": 60}
    assert await events.run_learner() == ""
    ((args, kw),) = seen
    assert str(learner_repo / "dist" / "learn.js") in args
    assert str(events.log.path) in args and "--now" in args
    assert kw["cwd"] == str(learner_repo)
    assert given["before"]["overrides"] == {"old": {}}
    learned = events.learned()
    assert learned["overrides"] == GOOD["overrides"] and learned["frozen"] is False
    assert not hub.feature_path(".learned.next.json").exists()
    assert events._load_state()["learn"]["new"] == 0


async def test_after_a_reset_the_learner_reads_only_what_came_since(hub, learner_repo, monkeypatch):
    """After Reset learning, only events at or after the reset go to the learner, through a
    private scratch copy that's removed once it ran."""
    events = hub.code_router_events
    events.log.append({"ts": iso(time.time() - 7200), "kind": "route", "i": "old"})
    events.log.append({"ts": iso(time.time()), "kind": "route", "i": "new"})
    await events.log.flush()
    events._load_state()["since"] = iso(time.time() - 60)
    copied = {}

    def write(out):
        scratch = proc.args[list(proc.args).index("--out") - 1]
        with open(scratch) as handle:
            copied["rows"] = [json.loads(line)["i"] for line in handle]
        copied["path"] = scratch
        writes(GOOD)(out)

    proc = Proc(write=write)
    spawning(monkeypatch, proc)
    assert await events.run_learner() == ""
    assert copied["rows"] == ["new"]
    assert copied["path"].endswith(".model_router_events.since.jsonl")
    assert not hub.feature_path(".model_router_events.since.jsonl").exists()


async def test_a_learner_that_hangs_is_killed_and_timed_out(hub, learner_repo, monkeypatch):
    """Past LEARN_TIMEOUT the learner is killed; the note is "timed out" and nothing learned."""
    events = hub.code_router_events
    await logged(events)
    events.learned_path().write_text(json.dumps({"v": 1, "overrides": {"kept": {}}}))
    proc = Proc(returncode=None, hang=True)  # (killed, not yet reaped)
    spawning(monkeypatch, proc)
    monkeypatch.setattr(code_router_events, "LEARN_TIMEOUT", 0.05)
    assert await events.run_learner() == "timed out"
    assert proc.killed and events.learned()["overrides"] == {"kept": {}}
    assert events._load_state()["learn"]["note"] == "timed out"
    assert not hub.feature_path(".learned.next.json").exists()  # (no stale copy left)


@pytest.mark.parametrize(
    ("proc", "note"),
    [
        (Proc(returncode=2, err=b"TypeError: x"), "exit 2"),
        (Proc(write=os.remove), "no output"),  # (not even the copy it was given)
        (Proc(write=writes("{not json")), "no output"),
        (Proc(write=writes({"v": 2, "overrides": {}})), "bad output"),
        (Proc(write=writes([1, 2])), "bad output"),
    ],
)
async def test_a_learner_that_fails_or_writes_nonsense_learns_nothing(
    hub, learner_repo, monkeypatch, proc, note
):
    """A non-zero exit, no output, unreadable or foreign output: the note says which, the
    old learned.json stays, the count stays for the next try, and no scratch is left."""
    events = hub.code_router_events
    await logged(events)
    events.learned_path().write_text(json.dumps({"v": 1, "overrides": {"kept": {}}}))
    events._load_state()["learn"] = {"new": 60}
    spawning(monkeypatch, proc)
    assert await events.run_learner() == note
    assert events.learned()["overrides"] == {"kept": {}}
    assert events._load_state()["learn"]["new"] == 60
    assert not hub.feature_path(".learned.next.json").exists()


async def test_frozen_while_the_learner_ran_keeps_the_frozen_file(hub, learner_repo, monkeypatch):
    """The owner freezes learning mid-run: the run's output is dropped ("frozen")."""
    events = hub.code_router_events
    await logged(events)

    def write(out):
        events._freeze(True)
        writes(GOOD)(out)

    spawning(monkeypatch, Proc(write=write))
    assert await events.run_learner() == "frozen"
    learned = events.learned()
    assert learned["frozen"] is True and "gpt-6.1-sol" not in learned.get("overrides", {})


# ── learned.json, cleaned ──


def test_learned_json_is_cleaned_before_use():
    """Another version is ignored; overrides too big are left out; bad report rows are
    skipped and the report stops at 200 rows."""
    clean = code_router_events.clean_learned
    assert clean({"v": 3, "overrides": {"m": {}}}) == {}
    assert clean("nope") == {}
    big = {"v": 1, "overrides": {"m": {"x": "y" * (code_router_events.MAX_OVERRIDES_JSON + 1)}}}
    assert "overrides" not in clean(big)
    rows = ["junk", {"model": ""}] + [{"model": f"m{i}", "to": i} for i in range(250)]
    report = clean({"v": 1, "report": rows})["report"]
    assert len(report) == 200 and report[0] == {"model": "m0", "to": 0.0}


def test_no_test_can_reach_the_owner_s_real_model_router():
    """H8: conftest points $MODEL_ROUTER_HOME at an empty temp folder for every test."""
    from pathlib import Path

    home = code_router_events.model_router_home()
    assert home != Path.home() / "Model Router"
    assert home.is_dir() and not any(home.iterdir())
