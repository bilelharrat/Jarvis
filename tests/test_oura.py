"""The owner's Oura ring (features/oura.py): OAuth kept in the Keychain, refreshed with Oura's
single-use refresh tokens, and last night's sleep in words for the briefing and questions."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import date
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx

from jarvis.connectors import MemoryVault
from jarvis.features import oura as oura_module
from jarvis.features.oura import Oura

TODAY = date(2026, 10, 1)


def night(day, hours, start="23:40", end="07:30", kind="long_sleep", **more):
    return {
        "day": day,
        "type": kind,
        "total_sleep_duration": int(hours * 3600),
        "bedtime_start": f"{day}T{start}:00-07:00",
        "bedtime_end": f"{day}T{end}:00-07:00",
        **more,
    }


DATA = {
    "daily_sleep": [{"day": "2026-10-01", "score": 82}],
    "sleep": [
        night(
            "2026-10-01",
            7.5,
            deep_sleep_duration=4800,
            rem_sleep_duration=6300,
            light_sleep_duration=15900,
            efficiency=91,
            lowest_heart_rate=52,
            average_hrv=48,
        ),
        night("2026-10-01", 0.5, start="14:00", end="14:30", kind="late_nap"),
        night("2026-09-30", 6.5),
        night("2026-09-29", 6.5),
        night("2026-09-28", 6.5),
    ],
    "daily_readiness": [{"day": "2026-10-01", "score": 79, "temperature_deviation": 0.4}],
    "daily_activity": [{"day": "2026-09-30", "steps": 9412, "score": 85}],
}


class Server:
    """Oura's token endpoint and API, as far as JARVIS uses them."""

    def __init__(self):
        self.tokens_given = []
        self.calls = []
        self.reject_next = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth/token":
            form = parse_qs(request.content.decode())
            if form["client_id"] != ["cid"] or form["client_secret"] != ["secret"]:
                # As Oura answers: a pair it doesn't know, before anything else.
                return httpx.Response(
                    401,
                    json={
                        "status": 401,
                        "error": "invalid_client",
                        "error_description": "Invalid client",
                    },
                )
            if form.get("code") == ["jarvis-check"]:
                return httpx.Response(400, json={"error": "invalid_grant"})
            self.tokens_given.append(form)
            n = len(self.tokens_given)
            return httpx.Response(
                200,
                json={
                    "access_token": f"access{n}",
                    "refresh_token": f"refresh{n}",
                    "expires_in": 86400,
                },
            )
        kind = request.url.path.rsplit("/", 1)[-1]
        self.calls.append((kind, request.headers.get("Authorization")))
        if self.reject_next:
            self.reject_next = False
            return httpx.Response(401)
        return httpx.Response(200, json={"data": DATA.get(kind, []), "next_token": None})


class Hub:
    def __init__(self):
        self.events = []
        self.connectors = SimpleNamespace(vault=MemoryVault())

    def emit(self, kind, **values):
        self.events.append((kind, values))


def made(connected=True):
    hub = Hub()
    server = Server()
    oura = Oura(hub, transport=httpx.MockTransport(server))
    asyncio.run(oura.save_client({"client_id": "cid", "client_secret": "secret"}))
    assert oura.client() == {"client_id": "cid", "client_secret": "secret"}
    if connected:
        hub.connectors.vault.set(
            "oura",
            "oauth_tokens",
            json.dumps(
                {"access_token": "a0", "refresh_token": "r0", "expires_at": time.time() + 3600}
            ),
        )
    return hub, oura, server


def test_last_night_in_words():
    _hub, oura, server = made()
    data = asyncio.run(oura.fetch(today=TODAY))
    text = oura.summary(data, 1)
    assert "sleep score 82" in text
    assert "slept 7 h 30 min (23:40 to 07:30)" in text  # the main sleep, not the nap
    assert "deep 1 h 20 min, REM 1 h 45 min, light 4 h 25 min" in text
    assert "efficiency 91%; lowest heart rate 52; average HRV 48 ms" in text
    assert "readiness 79; body temperature +0.4 °C from usual" in text
    assert "60 min more sleep than their week's average" in text
    assert "The day before: 9,412 steps, activity score 85." in text
    assert {kind for kind, _auth in server.calls} == {
        "daily_sleep",
        "sleep",
        "daily_readiness",
        "daily_activity",
    }
    assert all(auth == "Bearer a0" for _kind, auth in server.calls)


def test_it_goes_in_the_briefing_as_private_health_facts():
    _hub, oura, _server = made()
    added = []
    oura.hub.proactive_feature = SimpleNamespace(
        briefing=SimpleNamespace(add_facts=lambda *a, **k: added.append((a, k)))
    )
    assert oura.attach() and oura.attach()  # once
    assert len(added) == 1 and added[0][0][0] == "health" and added[0][1] == {"private": True}
    facts = asyncio.run(oura.briefing_facts())
    assert facts.startswith("From the Oura ring: Last night: sleep score")


def test_nothing_when_not_connected_or_not_synced(monkeypatch):
    _hub, oura, _server = made(connected=False)
    assert asyncio.run(oura.briefing_facts()) == ""
    _hub, oura, _server = made()
    monkeypatch.setitem(DATA, "daily_sleep", [])
    monkeypatch.setitem(DATA, "sleep", [])
    monkeypatch.setitem(DATA, "daily_readiness", [])
    monkeypatch.setitem(DATA, "daily_activity", [])
    assert "hasn't synced" in asyncio.run(oura.briefing_facts())


def test_an_expired_token_is_refreshed_and_the_new_refresh_token_kept():
    hub, oura, server = made()
    tokens = json.loads(hub.connectors.vault.get("oura", "oauth_tokens"))
    tokens["expires_at"] = 0
    hub.connectors.vault.set("oura", "oauth_tokens", json.dumps(tokens))
    asyncio.run(oura.fetch(today=TODAY))
    assert server.tokens_given[0]["grant_type"] == ["refresh_token"]
    assert server.tokens_given[0]["refresh_token"] == ["r0"]
    kept = json.loads(hub.connectors.vault.get("oura", "oauth_tokens"))
    assert kept["refresh_token"] == "refresh1" and kept["access_token"] == "access1"


def test_a_token_turned_down_early_is_refreshed_once():
    _hub, oura, server = made()
    server.reject_next = True
    asyncio.run(oura.fetch(1, today=TODAY))
    assert len(server.tokens_given) == 1


def test_disconnecting_forgets_the_tokens():
    hub, oura, _server = made()
    oura.disconnect()
    assert hub.connectors.vault.get("oura", "oauth_tokens") is None
    assert not oura.connected()
    assert oura.client()["client_id"] == "cid"  # the app stays, to reconnect


def test_the_tool_answers_or_says_why():
    _hub, oura, _server = made(connected=False)
    server = oura.build_server()
    assert server is not None
    with_error = asyncio.run(oura.briefing_facts())
    assert with_error == ""


def test_the_briefing_puts_the_rings_numbers_in_its_health_section():
    from jarvis.features.proactive.briefing import Briefing

    hub = SimpleNamespace(prefs=SimpleNamespace(feature=lambda key: None), weather=None)
    briefing = Briefing(hub)

    async def facts():
        return "From the Oura ring: Last night: sleep score 82."

    briefing.add_facts("health", facts, private=True)
    line = asyncio.run(briefing._section("health", [], ""))
    assert line.startswith("From the Oura ring: Last night: sleep score 82.")
    assert "phone_health" in line


def signing_in(oura, monkeypatch, answer):
    """Connect, with the browser and the catcher faked: answer(state) is what comes back."""
    opened = []
    monkeypatch.setattr(oura_module.webbrowser, "open", opened.append)

    async def wait():
        while not opened:
            await asyncio.sleep(0.01)
        state = parse_qs(opened[0].split("?", 1)[1])["state"][0]
        return answer(state)

    async def go():
        oura.callback = SimpleNamespace(wait=wait)
        await oura.connect()

    asyncio.run(go())
    return parse_qs(opened[0].split("?", 1)[1]) if opened else None, opened


def test_with_the_secret_it_signs_in_server_side_and_renews(monkeypatch):
    hub, oura, server = made(connected=False)
    query, opened = signing_in(
        oura, monkeypatch, lambda state: {"code": "the-code", "state": state}
    )
    assert opened[0].startswith("https://developer.ouraring.com/authorize?")
    assert query["response_type"] == ["code"] and query["client_id"] == ["cid"]
    assert query["redirect_uri"] == [oura_module.connectors.REDIRECT_URI]
    assert server.tokens_given[0]["grant_type"] == ["authorization_code"]
    assert server.tokens_given[0]["code"] == ["the-code"]
    assert oura.connected() and not oura.error and oura.days_left() is None
    assert hub.events[-1][1]["connected"] is True


def test_without_a_secret_it_signs_in_with_the_client_id_alone(monkeypatch):
    hub, oura, server = made(connected=False)
    asyncio.run(oura.save_client({"client_id": "cid", "client_secret": ""}))
    query, _ = signing_in(
        oura,
        monkeypatch,
        lambda state: {"access_token": "implicit", "expires_in": "2592000", "state": state},
    )
    assert query["response_type"] == ["token"]
    assert server.tokens_given == []  # no secret, no token endpoint
    tokens = json.loads(hub.connectors.vault.get("oura", "oauth_tokens"))
    assert tokens["access_token"] == "implicit" and tokens["refresh_token"] == ""
    assert oura.days_left() == 29
    asyncio.run(oura.fetch(1, today=TODAY))
    assert server.calls[0][1] == "Bearer implicit"


def test_the_id_pasted_as_the_secret_still_connects(monkeypatch):
    hub, oura, _server = made(connected=False)
    asyncio.run(oura.save_client({"client_id": "cid", "client_secret": "cid"}))
    assert not oura.error and oura.secret() == ""
    query, _ = signing_in(oura, monkeypatch, lambda state: {"access_token": "t", "state": state})
    assert query["response_type"] == ["token"] and oura.connected()


def test_a_secret_oura_turns_down_falls_back_to_the_client_id(monkeypatch):
    hub, oura, _server = made(connected=False)
    hub.connectors.vault.set(
        "oura", "oauth_client", json.dumps({"client_id": "cid", "client_secret": "wrong"})
    )
    query, _ = signing_in(oura, monkeypatch, lambda state: {"access_token": "t", "state": state})
    assert query["response_type"] == ["token"] and oura.connected()


def test_a_sign_in_for_another_request_or_refused_isnt_kept(monkeypatch):
    _hub, oura, server = made(connected=False)
    signing_in(oura, monkeypatch, lambda state: {"code": "code", "state": "not-ours"})
    assert not oura.connected() and "different request" in oura.error
    signing_in(oura, monkeypatch, lambda state: {"error": "access_denied", "state": state})
    assert not oura.connected() and "access_denied" in oura.error
    assert server.tokens_given == []


def test_a_month_long_sign_in_is_mentioned_before_it_ends():
    hub, oura, _server = made()
    hub.connectors.vault.set(
        "oura",
        "oauth_tokens",
        json.dumps(
            {"access_token": "a0", "refresh_token": "", "expires_at": time.time() + 2 * 86400 + 60}
        ),
    )
    facts = asyncio.run(oura.briefing_facts())
    assert "ends in 2 days" in facts
    hub.connectors.vault.set(
        "oura",
        "oauth_tokens",
        json.dumps({"access_token": "a0", "refresh_token": "", "expires_at": 0}),
    )
    oura._cache = None
    assert "needs reconnecting" in asyncio.run(oura.briefing_facts())


def test_the_catcher_hands_back_what_comes_after_the_hash():
    async def run():
        import socket

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        catcher = oura_module.TokenCatcher(port=port)
        waiting = asyncio.ensure_future(catcher.wait(timeout=5))
        await asyncio.sleep(0.1)
        async with httpx.AsyncClient() as http:
            page = await http.get(f"http://127.0.0.1:{port}/callback")
            done = await http.get(f"http://127.0.0.1:{port}/done?access_token=tok&state=s1")
        return page.text, done.text, await waiting

    page, done, found = asyncio.run(run())
    assert "location.hash" in page and "/done?" in page
    assert done.startswith("Connected to Jarvis")
    assert found == {"access_token": "tok", "state": "s1"}


def test_a_sleep_question_carries_the_rings_numbers():
    _hub, oura, _server = made()
    oura._cache = None
    asyncio.run(oura.fetch(today=date.today()))  # what "now" reads
    extra = asyncio.run(
        oura.context("how much sleep did i get last night and whats the score", None)
    )
    assert extra["note"].startswith("Live from the owner's Oura ring (connected):")
    assert extra["reads"] == [("private", "your Oura data")]
    assert asyncio.run(oura.context("what's on my calendar", None)) is None
    assert asyncio.run(oura.context("how did I sleep", "words sent on")) is None
    _hub, oura, _server = made(connected=False)
    assert asyncio.run(oura.context("how did I sleep", None)) is None
