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
    assert [x["name"] for x in s["week"]["sources"]] == ["Jarvis Code", "JARVIS"]
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
    assert {x["name"] for x in s["today"]["sources"]} == {"JARVIS", "Jarvis Code"}
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
