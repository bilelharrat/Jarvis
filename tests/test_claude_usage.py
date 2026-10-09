"""Claude usage for the Session card: every answer counted, limits kept, days summed."""

import asyncio
from datetime import datetime
from types import SimpleNamespace

from claude_agent_sdk import RateLimitEvent, RateLimitInfo, ResultMessage
from test_hub import make_hub

from jarvis.claude_usage import UsageBook, model_name

NOON = datetime(2026, 9, 29, 12, 0).timestamp()
DAY = 86400


def usage(i=1000, o=200, cr=5000, cw=300):
    return {
        "input_tokens": i,
        "output_tokens": o,
        "cache_read_input_tokens": cr,
        "cache_creation_input_tokens": cw,
    }


def test_answers_add_up_by_day_source_and_model(tmp_path):
    now = [NOON]
    book = UsageBook(tmp_path / "usage.json", clock=lambda: now[0])
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    book.record("code", 0.30, usage(o=800), "claude-sonnet-5-5")
    now[0] -= 3 * DAY  # three days ago
    book.record("code", 1.00, usage(), "claude-opus-5-5")
    now[0] = NOON
    s = book.summary()
    assert s["today"]["cost"] == 0.4 and s["today"]["requests"] == 2
    assert s["today"]["tokens"] == 6500 + 7100
    assert s["week"]["cost"] == 1.4 and s["month"]["requests"] == 3
    assert [x["name"] for x in s["week"]["sources"]] == ["Eden Code", "JARVIS"]
    assert s["week"]["models"][0] == {**s["week"]["models"][0], "name": "Opus 5.5", "cost": 1.1}
    assert len(s["history"]) == 14 and s["history"][-1]["cost"] == 0.4
    assert s["history"][-4]["cost"] == 1.0
    assert s["session"]["requests"] == 3


def test_it_survives_a_restart_and_forgets_after_90_days(tmp_path):
    now = [NOON - 100 * DAY]
    book = UsageBook(tmp_path / "usage.json", clock=lambda: now[0])
    book.record("jarvis", 5.0, usage(), "claude-opus-5-5")
    now[0] = NOON
    book.record("jarvis", 0.25, usage(), "claude-opus-5-5")
    book.flush()
    again = UsageBook(tmp_path / "usage.json", clock=lambda: now[0])
    assert again.summary()["month"]["cost"] == 0.25
    assert list(again.days) == ["2026-09-29"]  # the day 100 days ago is gone
    assert again.summary()["session"]["requests"] == 0  # a session is this run only


def test_limits_keep_the_latest_and_drop_a_window_that_has_reset(tmp_path):
    now = [NOON]
    book = UsageBook(tmp_path / "usage.json", clock=lambda: now[0])
    book.limit(RateLimitInfo(status="allowed", utilization=0.34, rate_limit_type="five_hour",
                             resets_at=int(NOON + 3600)))  # fmt: skip
    book.limit(RateLimitInfo(status="allowed_warning", utilization=0.81,
                             rate_limit_type="seven_day", resets_at=int(NOON + 4 * DAY)))  # fmt: skip
    limits = {x["type"]: x for x in book.summary()["limits"]}
    assert limits["five_hour"]["utilization"] == 0.34 and limits["seven_day"]["status"] == (
        "allowed_warning"
    )
    now[0] += 2 * 3600  # the five-hour window has reset since: its number is old news
    limits = {x["type"]: x for x in book.summary()["limits"]}
    assert limits["five_hour"]["utilization"] is None
    assert limits["seven_day"]["utilization"] == 0.81


def test_nothing_is_counted_for_an_answer_with_no_usage(tmp_path):
    book = UsageBook(tmp_path / "usage.json")
    book.record("jarvis", None, None, "")
    assert book.summary()["today"]["requests"] == 0


def test_model_names():
    assert model_name("claude-opus-5-5") == "Opus 5.5"
    assert model_name("claude-haiku-4-5") == "Haiku 4.5"
    assert model_name("gemini-flash-latest") == "gemini-flash-latest"


async def test_the_hub_counts_its_answers_code_turns_and_limits(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()

    def result(total):
        return ResultMessage(
            subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
            session_id="s1", total_cost_usd=total, usage=usage(),
            model_usage={"claude-opus-5-5": {}},
        )  # fmt: skip

    await hub._on_message("r1", result(0.10))
    await hub._on_message("r2", result(0.25))  # a running total: this answer cost 0.15
    hub._code_usage(SimpleNamespace(model="claude-sonnet-5-5"), 0.5, result(0.5))
    info = RateLimitInfo(status="allowed", utilization=0.4, rate_limit_type="five_hour")
    await hub._on_message("r3", RateLimitEvent(rate_limit_info=info, uuid="u", session_id="s1"))
    s = hub.usage.summary()
    assert round(s["today"]["cost"], 2) == 0.75 and s["today"]["requests"] == 3
    assert {x["name"] for x in s["today"]["sources"]} == {"JARVIS", "Eden Code"}
    assert s["limits"][0]["utilization"] == 0.4
    await asyncio.sleep(1.1)
    events = [e for e in _drain(q) if e["type"] == "usage"]
    assert events and events[-1]["limits"][0]["utilization"] == 0.4
    assert hub.snapshot()["usage"]["today"]["requests"] == 3
    assert hub.usage.path.parent == hub.prefs_store.path.parent  # beside the test's prefs


def _drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def test_the_usage_endpoints_answer_becomes_limits(tmp_path):
    from jarvis.claude_usage import parse_plan

    plan = parse_plan(
        {
            "five_hour": {"utilization": 77.0, "resets_at": "2026-09-30T09:59:59.9+00:00"},
            "seven_day": {"utilization": 47, "resets_at": "2026-10-06T23:59:59+00:00"},
            "seven_day_opus": None,
            "extra_usage": {"is_enabled": False, "utilization": None},
        }
    )
    assert set(plan) == {"five_hour", "seven_day"}
    assert plan["five_hour"]["utilization"] == 0.77
    assert (
        plan["five_hour"]["resets_at"]
        == datetime.fromisoformat("2026-09-30T09:59:59.9+00:00").timestamp()
    )
    book = UsageBook(tmp_path / "usage.json", clock=lambda: NOON)
    book.plan({"five_hour": {"utilization": 0.85, "resets_at": NOON + 60}})
    five = book.summary()["limits"][0]
    assert five["utilization"] == 0.85 and five["status"] == "allowed_warning"
    book.plan({"five_hour": {"utilization": 1.0, "resets_at": NOON + 60}})
    assert book.summary()["limits"][0]["status"] == "rejected"
    assert parse_plan("nonsense") == {} and parse_plan({"five_hour": {"utilization": "x"}}) == {}


def test_the_login_is_read_and_an_expired_one_skipped():
    from jarvis.claude_usage import login_token

    def keychain(token, expires_ms):
        def run(cmd, **_k):
            assert cmd[:2] == ["security", "find-generic-password"] and "-w" in cmd
            body = {"claudeAiOauth": {"accessToken": token, "expiresAt": expires_ms}}
            return SimpleNamespace(stdout=__import__("json").dumps(body))

        return run

    assert login_token(keychain("tok", (NOON + 3600) * 1000), now=NOON) == "tok"
    assert login_token(keychain("tok", (NOON + 10) * 1000), now=NOON) is None  # about to lapse
    assert login_token(lambda *a, **k: SimpleNamespace(stdout=""), now=NOON) is None

    def missing(*_a, **_k):
        raise OSError("no security tool")

    assert login_token(missing) is None


async def test_the_plan_is_asked_with_the_login_and_nothing_else():
    import httpx

    from jarvis.claude_usage import USAGE_URL, fetch_plan

    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"five_hour": {"utilization": 12, "resets_at": None}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        plan = await fetch_plan(client, token="tok")
        assert plan == {"five_hour": {"utilization": 0.12, "resets_at": None}}
        assert str(seen[0].url) == USAGE_URL and seen[0].method == "GET"
        assert seen[0].headers["authorization"] == "Bearer tok"

    def refused(_request):
        return httpx.Response(401, json={"error": "expired"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(refused)) as client:
        assert await fetch_plan(client, token="tok") is None


async def test_api_providers_are_listed_and_counted_on_their_own(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    gem = SimpleNamespace(name="Google Gemini", kind="gemini")
    orouter = SimpleNamespace(name="OpenRouter", kind="openrouter")
    hub.providers.providers = {"g": gem, "o": orouter}
    hub.providers.provider_of = lambda ref: {"custom:g1": gem}.get(ref)

    def result(total, n=1000):
        return ResultMessage(
            subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
            session_id="s1", total_cost_usd=total, usage=usage(i=n),
            model_usage={"gemini-flash-latest": {}},
        )  # fmt: skip

    hub._connected_ref = "custom:g1"  # JARVIS on the Gemini fallback
    await hub._on_message("r1", result(0.40))
    hub._code_usage(SimpleNamespace(model="custom:g1"), 0.9, result(0.9, n=5000))
    s = hub.usage_summary()
    rows = {p["name"]: p for p in s["providers"]}
    assert list(rows) == ["Google Gemini", "OpenRouter"]  # every added one, used or not
    assert rows["Google Gemini"]["month"]["requests"] == 2
    assert rows["Google Gemini"]["month"]["tokens"] == usage()["output_tokens"] * 2 + 6000 + 2 * (
        5000 + 300
    )
    # Claude Code only prices Anthropic's models: Gemini's answers carry tokens, not a price.
    assert rows["Google Gemini"]["month"]["cost"] == 0 and s["today"]["cost"] == 0
    assert rows["OpenRouter"]["month"]["requests"] == 0
    # Removed since: still shown with what it used.
    hub.providers.providers = {"o": orouter}
    assert [p["name"] for p in hub.usage_summary()["providers"]] == ["OpenRouter", "Google Gemini"]


async def test_on_the_hub_s_loop_the_file_is_written_in_a_thread_newest_last(tmp_path, monkeypatch):
    """An answer's end is no time to wait for the disk: the save goes to a thread, with a
    copy of the numbers, and an older copy never lands over a newer one."""
    import json
    import threading

    from jarvis import claude_usage

    now = [NOON]
    path = tmp_path / "usage.json"
    book = UsageBook(path, clock=lambda: now[0])
    writers = []
    real = claude_usage.jsonstore.save_json

    def save(target, data, **kw):
        writers.append(threading.current_thread())
        real(target, data, **kw)

    monkeypatch.setattr(claude_usage.jsonstore, "save_json", save)
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    assert not path.exists()  # not on the loop: it's under way in a thread
    book.record("jarvis", 0.20, usage(), "claude-opus-5-5")  # within SAVE_EVERY: kept for later
    await book._task
    assert writers and threading.main_thread() not in writers
    saved = json.loads(path.read_text())
    assert saved["days"]["2026-09-29"]["requests"] == 1  # the copy made as it was asked for
    assert book._dirty  # the second answer isn't on disk yet
    book.flush()  # as the hub closes: the newest, at once
    assert json.loads(path.read_text())["days"]["2026-09-29"]["requests"] == 2
    book._write({"days": {}, "limits": {}}, 1, 1)  # a late, older write changes nothing
    assert json.loads(path.read_text())["days"]["2026-09-29"]["requests"] == 2


async def test_a_save_that_fails_in_its_thread_is_tried_again(tmp_path, monkeypatch):
    from jarvis import claude_usage

    now = [NOON]
    book = UsageBook(tmp_path / "usage.json", clock=lambda: now[0])

    def full(*_a, **_k):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(claude_usage.jsonstore, "save_json", full)
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    await book._task
    assert book._dirty and book._saved_at == 0.0
    monkeypatch.undo()
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")  # the next answer saves both
    await book._task
    assert not book._dirty
    assert UsageBook(tmp_path / "usage.json").days["2026-09-29"]["requests"] == 2


async def test_a_damaged_file_nested_too_deep_to_copy_is_still_saved_and_counted(tmp_path):
    """A copy of the numbers takes about twice the stack a save does. A damaged usage.json
    nested past what a copy can follow (its junk kept as it came) is saved at once, as it
    always was, so an answer and a limit are still counted and nothing raises."""
    import json
    import sys

    frames, f = 0, sys._getframe()
    while f is not None:
        frames, f = frames + 1, f.f_back
    deep = (sys.getrecursionlimit() - frames) * 3 // 4  # too deep to copy; not to save
    path = tmp_path / "usage.json"
    junk = '{"a":' * deep + "1" + "}" * deep
    path.write_text('{"days": {}, "limits": {"junk": ' + junk + "}}")
    now = [NOON]
    book = UsageBook(path, clock=lambda: now[0])
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    assert book._task is None and not book._dirty  # saved here and now
    assert json.loads(path.read_text())["days"]["2026-09-29"]["requests"] == 1
    now[0] += 60
    book.limit(RateLimitInfo(status="rejected", utilization=1.0, rate_limit_type="five_hour"))
    assert json.loads(path.read_text())["limits"]["five_hour"]["status"] == "rejected"
    now[0] += 60
    book.plan({"seven_day": {"utilization": 0.5, "resets_at": None}})
    saved = json.loads(path.read_text())
    assert saved["limits"]["seven_day"]["status"] == "allowed"
    assert "junk" in saved["limits"] and not book._dirty
    assert book.summary()["today"]["requests"] == 1


def _counted(monkeypatch):
    """Every write of usage.json, as it was written."""
    import json

    from jarvis import claude_usage

    writes = []
    real = claude_usage.jsonstore.save_json

    def save(target, data, **kw):
        writes.append(json.loads(json.dumps(data)))
        real(target, data, **kw)

    monkeypatch.setattr(claude_usage.jsonstore, "save_json", save)
    return writes


async def test_a_plan_found_as_it_was_waits_for_the_next_save_or_the_flush(tmp_path, monkeypatch):
    """The plan's windows are asked for every few minutes while a window is open. Found as
    they were, only when they were seen moves: once the file and its .bak hold everything
    else, that's no write of its own, but the next save takes it along, and so does the
    flush as the hub closes (a write under way when it came leaves the book dirty)."""
    import json

    now = [NOON]
    path = tmp_path / "usage.json"
    book = UsageBook(path, clock=lambda: now[0])
    writes = _counted(monkeypatch)
    window = {"five_hour": {"utilization": 0.25, "resets_at": NOON + 3600}}
    book.plan(window)
    await book._task
    assert json.loads(path.read_text())["limits"]["five_hour"]["seen"] == NOON
    now[0] += 180
    book.plan(window)  # as it was, but the .bak hasn't got it yet: written once more
    await book._task
    assert len(writes) == 2 and not book._dirty
    bak = json.loads(path.with_name("usage.json.bak").read_text())
    assert bak["limits"]["five_hour"]["utilization"] == 0.25
    now[0] += 180
    book.plan(window)  # as it was, and so are the file and its .bak: no write
    await book._task
    assert len(writes) == 2
    assert book.limits["five_hour"]["seen"] == NOON + 360 and book._dirty
    assert book.summary()["limits"][0]["utilization"] == 0.25
    book.flush()  # as the hub closes
    assert json.loads(path.read_text())["limits"]["five_hour"]["seen"] == NOON + 360
    now[0] += 180
    moved = {"five_hour": {"utilization": 0.3, "resets_at": NOON + 3600}}
    book.plan(moved)  # it moved
    await book._task
    saved = json.loads(path.read_text())["limits"]["five_hour"]
    assert saved["utilization"] == 0.3 and saved["seen"] == NOON + 540
    now[0] += 180
    book.plan(moved)
    await book._task
    now[0] += 180
    book.plan(moved)
    await book._task
    assert len(writes) == 5  # the move, and the look after it; not the one after that
    # A look that finds it as it was while a write is under way: still kept for later.
    now[0] += 180
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    book.plan(moved)
    await book._task
    assert book._dirty
    book.flush()
    assert json.loads(path.read_text())["limits"]["five_hour"]["seen"] == NOON + 1080
    # Anything else in the entry (a limit Claude Code reported) makes it a change.
    now[0] += 180
    book.limit(RateLimitInfo(status="allowed", utilization=0.3, rate_limit_type="five_hour"))
    await book._task
    now[0] += 180
    book.plan(moved)
    await book._task
    assert json.loads(path.read_text())["limits"]["five_hour"]["seen"] == NOON + 1440


async def test_an_answer_counted_just_after_a_write_is_saved_by_the_next_plan_look(
    tmp_path, monkeypatch
):
    """An answer that ends within SAVE_EVERY of a write (the limit Claude Code reported on
    the same turn, say) isn't written for itself: the plan look after it writes it, found
    as it was or not, so a crash after that never loses it."""
    import json

    now = [NOON]
    path = tmp_path / "usage.json"
    book = UsageBook(path, clock=lambda: now[0])
    window = {"five_hour": {"utilization": 0.25, "resets_at": NOON + 3600}}
    for _ in range(3):  # (the file and its .bak as they'd be after a while)
        book.plan(window)
        await book._task
        now[0] += 180
    writes = _counted(monkeypatch)
    book.limit(RateLimitInfo(status="allowed", utilization=0.25, rate_limit_type="five_hour"))
    await book._task
    now[0] += 2
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    assert len(writes) == 1 and book._dirty  # within SAVE_EVERY of the limit's write
    now[0] += 45  # PLAN_AFTER_ANSWER
    book.plan(window)
    await book._task
    assert json.loads(path.read_text())["days"]["2026-09-29"]["requests"] == 1
    assert len(writes) == 2 and not book._dirty
    # The same with no limit before it: an answer just after a plan look's own write.
    now[0] += 180
    book.plan(window)
    await book._task
    now[0] += 2
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    now[0] += 45
    book.plan(window)
    await book._task
    assert json.loads(path.read_text())["days"]["2026-09-29"]["requests"] == 2
    assert not book._dirty


async def test_a_damaged_or_removed_file_comes_back_with_the_newest_numbers(tmp_path, monkeypatch):
    """Every look used to write, so the .bak a damaged file comes back from had the latest
    answer a look later, and a file removed while the app runs came back. A look found as
    it was still writes until both are so."""
    import json

    now = [NOON]
    path = tmp_path / "usage.json"
    book = UsageBook(path, clock=lambda: now[0])
    window = {"five_hour": {"utilization": 0.25, "resets_at": NOON + 3600}}
    book.plan(window)
    await book._task
    now[0] += 60
    book.record("jarvis", 0.10, usage(), "claude-opus-5-5")
    await book._task
    writes = _counted(monkeypatch)
    now[0] += 180
    book.plan(window)  # the look after the answer: its .bak gets the answer too
    await book._task
    now[0] += 180
    book.plan(window)
    await book._task
    assert len(writes) == 1
    path.unlink()  # removed while the app runs
    for n in (2, 3, 3):  # written again, then once more for its .bak, then left as it is
        now[0] += 180
        book.plan(window)
        await book._task
        assert len(writes) == n
    assert json.loads(path.read_text())["days"]["2026-09-29"]["requests"] == 1
    path.with_name("usage.json.bak").unlink()  # its .bak too
    for n in (4, 5, 5):
        now[0] += 180
        book.plan(window)
        await book._task
        assert len(writes) == n
    assert path.with_name("usage.json.bak").exists()
    path.write_text("{ torn")
    again = UsageBook(path, clock=lambda: now[0])  # damaged: read from its .bak
    assert again.summary()["today"]["requests"] == 1
