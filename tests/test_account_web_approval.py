"""A linked Mac approving a browser's sign-in to Eden at askeden.com (jarvis.account's
web_peek / web_answer, Settings' account_web_* commands). askeden.com is a fake
(account_fakes.FakeAskeden: an httpx MockTransport): never the network."""

import asyncio
import json

import httpx
import pytest
from account_fakes import TOKEN, FakeAskeden
from test_account import client, linked, setup  # noqa: F401  (setup: the hub fixture)
from test_hub import drain

from jarvis import account as account_mod
from jarvis.account import AccountError
from jarvis.connectors import MemoryVault

BROWSER = {"name": "Eden on the web: Safari on a Mac, near Lyon", "kind": "web"}


@pytest.mark.parametrize(
    ("typed", "code"),
    [
        ("K7QM-4ZTR", "K7QM-4ZTR"),
        ("k7qm4ztr", "K7QM-4ZTR"),
        (" k7qm 4ztr ", "K7QM-4ZTR"),
        ("jarvis-link://K7QM-4ZTR", "K7QM-4ZTR"),
        ("K7QM-4ZT", None),
        ("K7QM-4ZTI", None),  # I, L, O and U are never in a code
        ("", None),
        (None, None),
    ],
)
def test_codes_are_read_as_the_owner_types_them(typed, code):
    assert account_mod.normalize_code(typed) == code


async def test_a_browser_is_shown_by_name_then_approved_with_an_empty_body():
    fake = FakeAskeden()
    fake.waiting["K7QM-4ZTR"] = dict(BROWSER)
    made = await linked(fake)
    seen = await made.web_peek("k7qm4ztr")
    assert (seen.code, seen.name, seen.state) == ("K7QM-4ZTR", BROWSER["name"], "asking")
    assert made.public()["approval"]["name"] == BROWSER["name"]
    done = await made.web_answer("K7QM-4ZTR", True)
    assert done.state == "approved"
    assert fake.waiting_answers["K7QM-4ZTR"] == ("approved", {})
    method, path, body = fake.calls[-1]
    assert (method, path, body) == ("POST", "/link/K7QM-4ZTR/approve", {})
    await made.aclose()


async def test_the_macs_own_token_is_what_asks():
    fake = FakeAskeden()
    fake.waiting["K7QM-4ZTR"] = dict(BROWSER)
    seen = []
    handle = fake.handle

    def spy(request):
        seen.append(request.headers.get("authorization"))
        return handle(request)

    fake.transport = httpx.MockTransport(spy)
    made = client(fake)
    await made._keep(TOKEN, None)
    await made.web_peek("K7QM-4ZTR")
    assert seen == [f"Bearer {TOKEN}"]
    await made.aclose()


async def test_a_browser_turned_down_is_denied():
    fake = FakeAskeden()
    fake.waiting["K7QM-4ZTR"] = dict(BROWSER)
    made = await linked(fake)
    await made.web_peek("K7QM-4ZTR")
    done = await made.web_answer("K7QM-4ZTR", False)
    assert done.state == "denied"
    assert fake.waiting_answers["K7QM-4ZTR"][0] == "denied"
    await made.aclose()


async def test_a_macs_code_is_refused_here_before_askeden_would():
    fake = FakeAskeden()
    fake.waiting["K7QM-4ZTR"] = {"name": "Studio", "kind": "mac"}
    made = await linked(fake)
    with pytest.raises(AccountError) as caught:
        await made.web_peek("K7QM-4ZTR")
    assert caught.value.code == "not_web" and "iPhone" in caught.value.message
    assert made.approval is None
    # Nor can it be approved without a browser's peek in hand.
    with pytest.raises(AccountError):
        await made.web_answer("K7QM-4ZTR", True)
    assert [c for c in fake.calls if c[0] == "POST"] == []
    assert "K7QM-4ZTR" in fake.waiting
    await made.aclose()


async def test_only_the_code_looked_at_is_approved():
    fake = FakeAskeden()
    fake.waiting["K7QM-4ZTR"] = dict(BROWSER)
    fake.waiting["AAAA-BBBB"] = dict(BROWSER)
    made = await linked(fake)
    await made.web_peek("K7QM-4ZTR")
    with pytest.raises(AccountError):
        await made.web_answer("AAAA-BBBB", True)
    assert "AAAA-BBBB" in fake.waiting
    await made.aclose()


@pytest.mark.parametrize(
    ("waiting", "words"),
    [(None, account_mod.NOTHING_WAITING), ("expired", account_mod.CODE_EXPIRED)],
)
async def test_unknown_and_expired_codes_say_so(waiting, words):
    fake = FakeAskeden()
    if waiting:
        fake.waiting["K7QM-4ZTR"] = waiting
    made = await linked(fake)
    with pytest.raises(AccountError) as caught:
        await made.web_peek("K7QM-4ZTR")
    assert caught.value.message == words
    await made.aclose()


async def test_a_code_that_lapses_between_look_and_approve_says_so():
    fake = FakeAskeden()
    fake.waiting["K7QM-4ZTR"] = dict(BROWSER)
    made = await linked(fake)
    await made.web_peek("K7QM-4ZTR")
    fake.waiting["K7QM-4ZTR"] = "expired"
    done = await made.web_answer("K7QM-4ZTR", True)
    assert done.state == "error" and done.error == account_mod.CODE_EXPIRED
    await made.aclose()


async def test_not_linked_nothing_is_asked():
    fake = FakeAskeden()
    made = client(fake, MemoryVault())
    with pytest.raises(account_mod.SignedOut):
        await made.web_peek("K7QM-4ZTR")
    assert fake.calls == []
    await made.aclose()


async def test_a_bad_code_never_reaches_askeden():
    fake = FakeAskeden()
    made = await linked(fake)
    with pytest.raises(AccountError) as caught:
        await made.web_peek("hello")
    assert caught.value.message == account_mod.NOT_A_CODE and fake.calls == []
    await made.aclose()


async def test_settings_looks_up_approves_and_clears(setup):  # noqa: F811
    hub, fake = setup
    fake.waiting["K7QM-4ZTR"] = dict(BROWSER)
    await hub.account._keep(TOKEN, None)
    q = hub.subscribe()
    await hub._handle({"type": "account_web_peek", "code": "k7qm-4ztr"})
    await asyncio.sleep(0)
    shown = [e for e in drain(q) if e["type"] == "account"][-1]
    assert shown["approval"] == {
        "code": "K7QM-4ZTR",
        "name": BROWSER["name"],
        "state": "asking",
        "error": "",
    }
    await hub._handle({"type": "account_web_approve", "code": "K7QM-4ZTR"})
    await asyncio.sleep(0)
    shown = [e for e in drain(q) if e["type"] == "account"][-1]
    assert shown["approval"]["state"] == "approved"
    assert TOKEN not in json.dumps(shown)
    await hub._handle({"type": "account_web_clear"})
    await asyncio.sleep(0)
    assert [e for e in drain(q) if e["type"] == "account"][-1]["approval"] is None


async def test_settings_says_why_a_macs_code_is_refused(setup):  # noqa: F811
    hub, fake = setup
    fake.waiting["K7QM-4ZTR"] = {"name": "Studio", "kind": "mac"}
    await hub.account._keep(TOKEN, None)
    q = hub.subscribe()
    await hub._handle({"type": "account_web_peek", "code": "K7QM-4ZTR"})
    shown = [e for e in drain(q) if e["type"] == "account"][-1]
    assert shown["approval"] is None and shown["approval_error"] == account_mod.MAC_CODE
