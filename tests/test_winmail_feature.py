"""The email feature as the window uses it (features/winmail.py): the servers it guesses, the
sign-in check, saving an account without leaving its password anywhere but the secret store,
and what it registers with the hub."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from mailserver import TestMail
from test_mailbox import FakeVault

from jarvis import mailbox
from jarvis.features import winmail


@pytest.fixture
def server():
    s = TestMail()
    try:
        yield s
    finally:
        s.close()


def make_hub(tmp_path, monkeypatch, mac=False):
    monkeypatch.setattr(mailbox, "Vault", FakeVault)
    monkeypatch.setattr(winmail, "IS_MAC", mac)
    events, servers, commands = [], {}, {}

    async def gate(question, detail, spoken, choices=("Send", "Don't send")):
        return True

    hub = SimpleNamespace(
        prefs=SimpleNamespace(owner_name="Ann Test"),
        feature_path=lambda name: tmp_path / name,
        send_gate=gate,
        _say=lambda text: None,
        _turn_text="",
        poll=False,
        emit=lambda kind, **data: events.append((kind, data)),
        register_server=lambda name, build, **kw: servers.__setitem__(name, (build, kw)),
        register_command=lambda kind, handler, **kw: commands.__setitem__(kind, (handler, kw)),
        register_loop=lambda name, factory: hub.loops.append((name, factory)),
        loops=[],
    )
    winmail.install(hub)
    return hub, events, servers, commands


def local_fields(server):
    return dict(
        imap_host="127.0.0.1",
        imap_port=server.imap_port,
        imap_security="none",
        smtp_host="127.0.0.1",
        smtp_port=server.smtp_port,
        smtp_security="none",
    )


def run(handler, msg):
    asyncio.run(handler(msg))


def test_it_registers_the_mail_tools_and_commands_on_a_pc(tmp_path, monkeypatch):
    _hub, _events, servers, commands = make_hub(tmp_path, monkeypatch)
    assert "mail" in servers and servers["mail"][1]["labels"]["send_email"] == "Sent an email"
    assert set(commands) == {
        "mail_status",
        "mail_guess",
        "mail_check",
        "mail_save",
        "mail_remove",
        "mail_outlook",
    }
    assert commands["mail_check"][1] == {"slow": True} and commands["mail_save"][1] == {
        "slow": True
    }
    assert servers["mail"][0]() is not None  # the tool server builds


def test_on_a_mac_it_does_nothing(tmp_path, monkeypatch):
    _hub, _events, servers, commands = make_hub(tmp_path, monkeypatch, mac=True)
    assert servers == {} and commands == {}


def test_an_address_gets_its_providers_servers_and_advice(tmp_path, monkeypatch):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    run(commands["mail_guess"][0], {"address": "sam@gmail.com"})
    kind, data = events[-1]
    assert kind == "mail_guess" and data["ok"] and data["known"] and data["provider"] == "Gmail"
    assert "app password" in data["help"] and data["account"]["imap_host"] == "imap.gmail.com"
    run(commands["mail_guess"][0], {"address": "nonsense"})
    assert events[-1][1]["ok"] is False and "email address" in events[-1][1]["text"]
    run(commands["mail_guess"][0], {"address": "who@unknown-company.example"})
    assert (
        events[-1][1]["ok"]
        and not events[-1][1]["known"]
        and events[-1][1]["account"]["imap_host"] == "imap.unknown-company.example"
    )


def test_a_check_signs_in_to_both_servers_and_says_so(tmp_path, monkeypatch, server):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    server.store.add("INBOX", b"From: a@b.example\r\nSubject: hi\r\n\r\nhello")
    run(
        commands["mail_check"][0],
        {"address": "ann@test.example", "password": "app-password", **local_fields(server)},
    )
    kind, data = events[-1]
    assert (
        kind == "mail_check"
        and data["ok"]
        and data["text"]
        == "Signed in to ann@test.example. 1 unread in the inbox. Sending works too."
    )
    run(
        commands["mail_check"][0],
        {"address": "ann@test.example", "password": "nope", **local_fields(server)},
    )
    assert (
        events[-1][1]["ok"] is False
        and "refused the password" in events[-1][1]["text"]
        and "nope" not in events[-1][1]["text"]
    )


def test_saving_keeps_the_password_only_in_the_secret_store(tmp_path, monkeypatch, server):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    run(
        commands["mail_save"][0],
        {
            "address": "ann@test.example",
            "password": "app-password",
            "label": "Home",
            **local_fields(server),
        },
    )
    assert (
        events[-1][1]["ok"]
        and events[-1][1].get("saved")
        and events[-1][1]["text"].endswith("Saved.")
    )
    accounts_event = next(d for k, d in reversed(events) if k == "mail_accounts")
    [account] = accounts_event["accounts"]
    assert (
        account["address"] == "ann@test.example"
        and account["label"] == "Home"
        and account["has_password"] is True
    )
    assert account["name"] == "Ann Test"  # the owner's name goes on what's sent
    assert "app-password" not in str(events)
    assert "app-password" not in (tmp_path / "mail_accounts.json").read_text()
    assert hub.winmail.accounts.vault.get("ann@test.example") == "app-password"


def test_a_wrong_password_saves_nothing(tmp_path, monkeypatch, server):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    run(
        commands["mail_save"][0],
        {"address": "ann@test.example", "password": "wrong", **local_fields(server)},
    )
    assert events[-1][1]["ok"] is False
    assert (
        hub.winmail.accounts.all() == []
        and hub.winmail.accounts.vault.get("ann@test.example") is None
    )


def test_a_saved_account_can_be_checked_again_without_retyping_the_password(
    tmp_path, monkeypatch, server
):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    run(
        commands["mail_save"][0],
        {"address": "ann@test.example", "password": "app-password", **local_fields(server)},
    )
    run(commands["mail_check"][0], {"address": "ann@test.example", **local_fields(server)})
    assert events[-1][1]["ok"] is True
    run(commands["mail_check"][0], {"address": "other@test.example", **local_fields(server)})
    assert events[-1][1]["ok"] is False and "no saved password" in events[-1][1]["text"]


def test_removing_an_account_forgets_its_password(tmp_path, monkeypatch, server):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    run(
        commands["mail_save"][0],
        {"address": "ann@test.example", "password": "app-password", **local_fields(server)},
    )
    run(commands["mail_remove"][0], {"id": "ann@test.example"})
    assert (
        hub.winmail.accounts.all() == []
        and hub.winmail.accounts.vault.get("ann@test.example") is None
    )
    assert next(d for k, d in reversed(events) if k == "mail_accounts")["accounts"] == []
    run(commands["mail_remove"][0], {"id": "ann@test.example"})
    assert events[-1][1]["ok"] is False


def test_server_fields_from_the_window_are_typed_safely(tmp_path, monkeypatch):
    assert winmail._servers({"imap_host": " imap.x.example ", "imap_port": "993", "smtp_port": "abc", "imap_security": 5, "username": ""}) == {
        "imap_host": "imap.x.example", "imap_port": 993, "smtp_port": 0,
    }  # fmt: skip


def test_on_the_real_hub_the_mail_tools_reach_the_brain(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path
):
    from conftest import FakeClient

    from jarvis.hub import Hub

    monkeypatch.setattr(mailbox, "Vault", FakeVault)
    monkeypatch.setattr(winmail, "IS_MAC", False)
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert "mail" in hub._extra_servers
    built = hub._feature_servers()["mail"]
    assert built["name"] == "mail"
    assert "mail_save" in hub._commands and "mail_check" in hub._slow_commands
    assert "Email: list_emails" in hub._extra_prompt()
    from jarvis.hub import tool_label

    assert tool_label("mcp__mail__send_email") == "Sent an email"


def test_a_gmail_app_password_pasted_with_its_spaces_is_taken_as_it_is_meant(
    tmp_path, monkeypatch, server
):
    hub, events, _s, commands = make_hub(tmp_path, monkeypatch)
    server.store.users["ann@gmail.com"] = "abcdefghijklmnop"
    run(
        commands["mail_save"][0],
        {"address": "ann@gmail.com", "password": "abcd efgh ijkl mnop", **local_fields(server)},
    )
    assert (
        events[-1][1]["ok"]
        and hub.winmail.accounts.vault.get("ann@gmail.com") == "abcdefghijklmnop"
    )


# ── the index of this PC's mail, and the heads-up for new email that reads it ──


def saved_account(hub, server, address="ann@test.example", password="app-password", **kw):
    account = mailbox.account_from(address, name="Ann Test", **local_fields(server), **kw)
    hub.winmail.accounts.save(account, password)
    return account


def test_a_pass_reads_the_inboxes_into_the_index_and_points_the_readers_at_it(
    tmp_path, monkeypatch, server
):
    from mailserver import make_raw, when

    hub, _events, _servers, _commands = make_hub(tmp_path, monkeypatch)
    desk = hub.winmail
    assert desk.index_path() is None and desk.correspondents() == {}
    saved_account(hub, server)
    server.store.add(
        "INBOX", make_raw("Bea <bea@x.example>", "ann@test.example", "Old", "x", date=when(0.01))
    )
    server.store.add(
        "Sent", make_raw("Ann <ann@test.example>", "Cy <cy@u.example>", "Hi", "x", date=when(1))
    )
    assert asyncio.run(desk.index_pass(True)) == 0  # (what's waiting the first time is old news)
    assert desk.index_path() == desk.index.path
    assert desk.correspondents() == {"cy@u.example": "Cy"}
    server.store.add(
        "INBOX", make_raw("Bea <bea@x.example>", "ann@test.example", "New", "hello", date=when(0))
    )
    assert asyncio.run(desk.index_pass(False)) == 1


def test_an_account_that_cannot_sign_in_is_left_alone_for_a_while(tmp_path, monkeypatch, server):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    desk = hub.winmail
    saved_account(hub, server, password="wrong")
    assert asyncio.run(desk.index_pass()) == 0
    tries = len(server.store.logins)
    assert tries >= 1 and desk.backoff.waiting("ann@test.example")
    asyncio.run(desk.index_pass())
    assert len(server.store.logins) == tries  # (not asked again at once)


def test_outlook_is_only_asked_while_it_is_open(tmp_path, monkeypatch, server):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    desk = hub.winmail
    desk.accounts.save(mailbox.Account(id="outlook", address="ann@u.example", kind="outlook"))
    asked = []
    monkeypatch.setattr(winmail.winoutlook_mail, "running", lambda: False)
    monkeypatch.setattr(
        desk.service, "_imap", lambda *a, **k: asked.append(a) or asyncio.sleep(0, 0)
    )
    assert asyncio.run(desk.index_pass()) == 0 and asked == []
    monkeypatch.setattr(winmail.winoutlook_mail, "running", lambda: True)
    assert asyncio.run(desk.index_pass()) == 0 and len(asked) == 1


def test_the_loop_does_nothing_in_an_app_that_does_not_poll(tmp_path, monkeypatch):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    assert hub.poll is False
    assert asyncio.run(asyncio.wait_for(hub.winmail.watch(), 2)) is None


def test_the_pass_slows_while_heads_ups_for_email_are_off(tmp_path, monkeypatch):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    desk = hub.winmail
    assert desk.watching()  # (nothing says otherwise)
    hub.prefs.proactive = True
    hub.interrupts = SimpleNamespace(base_mode=lambda: "urgent")
    assert desk.watching()
    hub.interrupts = SimpleNamespace(base_mode=lambda: "off")
    assert not desk.watching()
    hub.interrupts = SimpleNamespace(base_mode=lambda: "urgent")
    hub.prefs.proactive = False
    assert not desk.watching()


def test_removing_an_account_takes_its_mail_out_of_the_index(tmp_path, monkeypatch, server):
    from mailserver import make_raw, when

    hub, _events, _servers, commands = make_hub(tmp_path, monkeypatch)
    desk = hub.winmail
    saved_account(hub, server)
    server.store.add(
        "Sent", make_raw("Ann <ann@test.example>", "Cy <cy@u.example>", "Hi", "x", date=when(1))
    )
    asyncio.run(desk.index_pass(True))
    assert desk.correspondents()
    run(commands["mail_remove"][0], {"id": "ann@test.example"})
    assert desk.correspondents() == {}


def test_the_loop_is_registered_with_the_hub(tmp_path, monkeypatch):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    assert [name for name, _factory in hub.loops] == ["mail_index"]
    assert hub.loops[0][1] == hub.winmail.watch


def test_on_a_pc_the_real_hub_reads_new_email_from_the_index_and_knows_the_owners_correspondents(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path
):
    from conftest import FakeClient

    from jarvis import hub as hub_module
    from jarvis import interrupts

    monkeypatch.setattr(mailbox, "Vault", FakeVault)
    monkeypatch.setattr(winmail, "IS_MAC", False)
    monkeypatch.setattr(hub_module.osplat, "IS_MAC", False)
    monkeypatch.setattr(interrupts, "APP_SUPPORT", tmp_path)
    own = {k: v for k, v in isolated.items() if k != "interrupter"}  # (the hub's own watcher)
    hub = hub_module.Hub(
        settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **own
    )
    assert "mail_index" in [name for name, _factory in hub._loops]
    assert hub.mail_index_path() is None and hub._known_names() == {}  # (nothing read yet)
    # No texts on a PC (not set up yet), and email is read from the index.
    assert hub.interrupts._db("message") is None
    hub.winmail.index.connect().close()
    assert hub.mail_index_path() is None  # (an index with no mail in it isn't pointed at)
    conn = hub.winmail.index.connect()
    conn.execute("INSERT INTO mailboxes (url) VALUES ('imap://aa/INBOX')")
    conn.commit()
    conn.close()
    assert hub.mail_index_path() == hub.winmail.index.path
    assert hub.interrupts._db("mail") == hub.winmail.index.path
    assert (
        "new texts" not in hub._feature_prompt() and "you watch new email" in hub._feature_prompt()
    )
    assert interrupts._access_line("Texts", "off", mac=False) == "Texts: not set up on this PC yet."
    assert "email account" in interrupts._access_line("Mail", "not_found", mac=False)
    assert "Full Disk Access" in interrupts._access_line("Mail", "not_found", mac=True)
    assert interrupts._access_line("Texts", "off", mac=True) == "Texts: not watched."


def test_an_account_that_hangs_is_left_behind_and_the_others_still_get_their_look(
    tmp_path, monkeypatch, server
):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    desk = hub.winmail
    saved_account(hub, server)
    monkeypatch.setattr(winmail, "ACCOUNT_SECONDS", 0.05)

    async def hang(*_a, **_k):
        await asyncio.sleep(5)

    monkeypatch.setattr(desk.service, "_imap", hang)
    assert asyncio.run(desk.index_pass()) == 0
    assert desk.backoff.waiting("ann@test.example")


def test_turning_heads_ups_on_ends_the_long_wait_within_a_step(tmp_path, monkeypatch):
    hub, _e, _s, _c = make_hub(tmp_path, monkeypatch)
    hub.poll = True
    desk = hub.winmail
    hub.prefs.proactive = True
    hub.interrupts = SimpleNamespace(base_mode=lambda: "off")
    monkeypatch.setattr(winmail, "FIRST_SECONDS", 0)
    slept, passes = [], []

    async def tick(seconds):
        slept.append(seconds)
        if len(slept) == 5:  # (the owner says "tell me about all my email")
            hub.interrupts = SimpleNamespace(base_mode=lambda: "all")
        if len(slept) > 12:
            raise asyncio.CancelledError

    async def a_pass(sent=False):
        passes.append((sent, len(slept)))  # (what it was asked, and how many waits had gone by)
        return 0

    monkeypatch.setattr(winmail.asyncio, "sleep", tick)
    monkeypatch.setattr(desk, "index_pass", a_pass)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(desk.watch())
    # a first look at once; then the owner's change is seen at the fifth wait, and the next look
    # comes then (a minute after the last), not a quarter of an hour after it
    assert passes[0] == (True, 1) and passes[1] == (False, 5)
    assert slept[1:].count(winmail.STEP_SECONDS) == len(slept) - 1
