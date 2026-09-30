"""Invoicing beyond one invoice (invoices.InvoiceExtras, features/invoicing.py): the client
list, recurring invoices, Stripe payment links through the connector, overdue reminders and
the routine that sends them. Mail, Stripe and the calendar of days are fakes."""

import asyncio
import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import FakeClient

from jarvis import invoices, mailkit
from jarvis.features import invoicing
from jarvis.hub import Hub

TODAY = date(2026, 9, 29)


# ── the client list ──


def test_clients_are_saved_found_updated_and_removed(tmp_path):
    book = invoices.ClientBook(tmp_path / "clients.json")
    acme, new = book.save_client("Acme Corp", "ap@acme.com", "1 Main St", "usd")
    assert new and (acme.email, acme.currency) == ("ap@acme.com", "USD")
    same, new = book.save_client("acme corp", address="2 Main St")
    assert not new and same is acme and (acme.email, acme.address) == ("ap@acme.com", "2 Main St")
    assert book.find("ACME") is acme and book.find("nobody") is None
    with pytest.raises(ValueError, match="isn't an email"):
        book.save_client("Globex", "not an address")
    again = invoices.ClientBook(tmp_path / "clients.json")
    assert [c["name"] for c in again.public()] == ["Acme Corp"]
    assert again.remove("acme") is not None and again.public() == []


def test_a_damaged_client_row_is_kept_and_never_shown(tmp_path):
    path = tmp_path / "clients.json"
    path.write_text(json.dumps([{"id": "a1", "name": "Acme"}, {"id": 5, "name": ["x"]}, "junk"]))
    book = invoices.ClientBook(path)
    assert [c["name"] for c in book.public()] == ["Acme"]
    book.save_client("Globex")
    kept = json.loads(path.read_text())
    assert {"id": 5, "name": ["x"]} in kept and "junk" in kept


# ── recurring invoices ──


def test_a_schedule_keeps_its_day_of_the_month(tmp_path):
    recurring = invoices.Recurring(tmp_path / "recurring.json")
    lines = [{"description": "Retainer", "quantity": 1, "unit_price": 2000}]
    monthly = recurring.add("Acme", lines, "monthly", "2027-01-31", today=TODAY)
    assert invoices.describe_schedule(monthly) == "every month on the 31st, next on 31 January 2027"
    recurring.keep(monthly)
    recurring.advance(monthly, date(2027, 1, 31))
    assert monthly.next == "2027-02-28"
    recurring.advance(monthly, date(2027, 2, 28))
    assert monthly.next == "2027-03-31"
    recurring.advance(monthly, date(2027, 6, 1))  # off for months: on to the next one, once
    assert monthly.next == "2027-06-30"
    weekly = recurring.add("Globex", lines, "weekly", "2026-10-05", today=TODAY)
    assert invoices.describe_schedule(weekly) == "every week on Monday, next on 5 October 2026"
    assert (
        invoices.schedule_total(
            recurring.add("X", lines, "yearly", "2026-10-01", tax_percent=10, today=TODAY)
        )
        == 2200.0
    )
    for bad in [
        ("Acme", lines, "daily", "2026-10-01"),
        ("Acme", lines, "monthly", "2026-01-01"),
        ("", lines, "monthly", "2026-10-01"),
    ]:
        with pytest.raises(ValueError):
            recurring.add(*bad, today=TODAY)
    again = invoices.Recurring(tmp_path / "recurring.json")
    assert [x["client"] for x in again.public()] == ["Acme"] and again.due(date(2027, 1, 1)) == []
    assert again.stop("acme") is not None and again.public() == []


# ── the tools ──


class Desk:
    """InvoiceExtras on fakes: cards answered as told, Mail and Stripe recorded."""

    def __init__(self, tmp_path, answers=(), asked=(), stripe=""):
        self.cards, self.sent, self.links = [], [], []
        self.answers, self.asked_for = list(answers), set(asked)
        self.stripe = stripe
        self.clients = invoices.ClientBook(tmp_path / "clients.json")
        self.recurring = invoices.Recurring(tmp_path / "recurring.json")
        self.extras = invoices.InvoiceExtras(
            clients=self.clients,
            recurring=self.recurring,
            ask=self.ask,
            asked=lambda action: action in self.asked_for,
            stripe_ready=lambda: self.stripe,
            payment_link=self.link,
            send=self.send,
            today=lambda: TODAY,
        )

    async def ask(self, question, detail, spoken, choices):
        self.cards.append((question, detail, spoken, choices))
        return self.answers.pop(0) if self.answers else True

    async def link(self, invoice):
        self.links.append(invoice.number)
        return "https://buy.stripe.com/test_abc123"

    async def send(self, to, subject, body, file):
        self.sent.append((to, subject, body, file))


def tools_for(tmp_path, desk, sender="Robert Doe Studio\n1 Main St"):
    store = invoices.InvoiceStore(tmp_path / "invoices.json", tmp_path / "Invoices")

    async def pdf(_page):
        return b"%PDF-1.4 fake"

    async def applescript(*_a, **_k):
        return ""

    prefs = SimpleNamespace(invoice_from=sender, invoice_payment="")
    tools = {
        t.name: t.handler
        for t in invoices.build_tools(store, pdf, lambda: prefs, applescript, desk.extras)
    }
    return store, tools


def text(out):
    return out["content"][0]["text"]


async def test_a_saved_client_fills_in_their_invoice(tmp_path):
    desk = Desk(tmp_path, asked={"save_client"})
    store, tools = tools_for(tmp_path, desk)
    out = await tools["save_client"](
        {"name": "Acme", "email": "ap@acme.com", "address": "1 Main St", "currency": "EUR"}
    )
    assert text(out) == "Added Acme in your clients." and desk.cards == []  # the owner asked
    await tools["create_invoice"](
        {"client": "acme", "items": [{"description": "Design", "unit_price": 500}]}
    )
    invoice = store.invoices[-1]
    assert (invoice.client, invoice.client_email, invoice.client_address, invoice.currency) == (
        "Acme",
        "ap@acme.com",
        "1 Main St",
        "EUR",
    )
    assert text(await tools["list_clients"]({})) == "Acme · ap@acme.com · 1 Main St · EUR"


async def test_changing_the_client_list_unasked_shows_a_card(tmp_path):
    desk = Desk(tmp_path, answers=[False, True, False])
    _store, tools = tools_for(tmp_path, desk)
    out = await tools["save_client"]({"name": "Acme", "email": "ap@acme.com"})
    assert out["is_error"] and desk.cards[0][0] == "Save Acme to your clients?"
    await tools["save_client"]({"name": "Acme"})
    out = await tools["remove_client"]({"name": "Acme"})
    assert out["is_error"] and desk.cards[-1][3] == ("Remove", "Keep")
    assert desk.clients.find("Acme") is not None


async def test_a_recurring_invoice_is_shown_then_kept(tmp_path):
    desk = Desk(tmp_path, asked={"save_client"})
    _store, tools = tools_for(tmp_path, desk)
    await tools["save_client"]({"name": "Acme", "email": "ap@acme.com"})
    out = await tools["create_recurring_invoice"](
        {
            "client": "Acme",
            "items": [{"description": "Retainer", "unit_price": 2000}],
            "every": "monthly",
            "start": "2026-10-01",
            "email": True,
        }  # fmt: skip
    )
    assert text(out) == "Set up: Acme, $2,000.00, every month on the 1st, next on 1 October 2026."
    question, detail, spoken, choices = desk.cards[-1]
    assert question == "Invoice Acme $2,000.00 every month on the 1st, next on 1 October 2026?"
    assert "Each one is offered to ap@acme.com on a Send card first." in detail
    assert choices == ("Set it up", "Not now")
    assert "[" in text(await tools["list_recurring_invoices"]({}))
    out = await tools["create_recurring_invoice"](
        {
            "client": "Globex",
            "items": [{"description": "x", "unit_price": 1}],
            "every": "monthly",
            "start": "2026-10-01",
            "email": True,
        }  # fmt: skip
    )
    assert out["is_error"] and "I need Globex's address" in text(out)
    desk.answers = [False]
    out = await tools["stop_recurring_invoice"]({"invoice": "acme"})
    assert out["is_error"] and desk.recurring.find("acme") is not None


async def test_a_reminder_shows_the_email_and_goes_once_a_week(tmp_path):
    desk = Desk(tmp_path)
    store, tools = tools_for(tmp_path, desk)
    await tools["create_invoice"](
        {
            "client": "Acme",
            "client_email": "ap@acme.com",
            "due_days": 10,
            "items": [{"description": "Design", "unit_price": 500}],
        }  # fmt: skip
    )
    invoice = store.invoices[-1]
    invoice.issued, invoice.due = "2026-09-01", "2026-09-11"
    invoice.payment_link = "https://buy.stripe.com/test_abc123"
    store.save()
    assert "INV-2026-001 · Acme · $500.00 · 18 days late · ap@acme.com" in text(
        await tools["overdue_invoices"]({})
    )
    out = await tools["send_invoice_reminder"]({"number": "1"})
    assert text(out) == "Reminded Acme about INV-2026-001."
    question, detail, spoken, choices = desk.cards[-1]
    assert question == "Send Acme a reminder about INV-2026-001?" and choices == (
        "Send",
        "Don't send",
    )
    assert detail.startswith(
        "To Acme <ap@acme.com>\nSubject: Reminder: invoice INV-2026-001 is overdue\nAttached: "
    )
    to, subject, body, file = desk.sent[-1]
    assert to == "ap@acme.com" and file == invoice.path and Path(file).exists()
    assert (
        "was due on 11 September 2026. You can pay online here: https://buy.stripe.com/test_abc123"
        in body
    )
    assert body.endswith("Thank you,\nRobert Doe Studio")
    out = await tools["send_invoice_reminder"]({"number": "1"})
    assert out["is_error"] and "a week after that" in text(out) and len(desk.sent) == 1
    invoice.status = "paid"
    assert "is paid" in text(await tools["send_invoice_reminder"]({"number": "1"}))


async def test_a_payment_link_needs_stripe_and_a_yes(tmp_path):
    desk = Desk(tmp_path, stripe="Stripe isn't connected (Tools & Accounts › Stripe).")
    store, tools = tools_for(tmp_path, desk)
    await tools["create_invoice"](
        {"client": "Acme", "items": [{"description": "x", "unit_price": 99}]}
    )
    out = await tools["invoice_payment_link"]({"number": "1"})
    assert (
        out["is_error"]
        and "Stripe isn't connected" in text(out)
        and "invoice itself is ready" in text(out)
    )
    desk.stripe, desk.answers = "", [False, True]
    out = await tools["invoice_payment_link"]({"number": "1"})
    assert out["is_error"] and desk.links == []
    assert desk.cards[-1][0] == "Create a Stripe payment link for INV-2026-001 (Acme, $99.00)?"
    out = await tools["invoice_payment_link"]({"number": "1"})
    assert text(out) == "Payment link for INV-2026-001: https://buy.stripe.com/test_abc123"
    assert store.invoices[-1].payment_link == "https://buy.stripe.com/test_abc123"


# ── the hub's side ──


def make_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub._say = lambda _text: None
    return hub


def stripe_tool(name, props, required=()):
    return SimpleNamespace(
        name=name,
        input_schema={
            "type": "object",
            "properties": {p: {} for p in props},
            "required": list(required),
        },
    )


class StripeLive:
    status = "connected"
    tools = [
        stripe_tool("create_product", ["name", "description"], ["name"]),
        stripe_tool(
            "create_price",
            ["product", "unit_amount", "currency"],
            ["product", "unit_amount", "currency"],
        ),
        stripe_tool("create_payment_link", ["price", "quantity"], ["price", "quantity"]),
        stripe_tool("list_customers", []),
    ]

    def __init__(self):
        self.calls = []

    async def call(self, name, args):
        self.calls.append((name, args))
        answer = {
            "create_product": '{"id": "prod_Q1w2e3"}',
            "create_price": '{"id": "price_9Z8y7"}',
            "create_payment_link": '{"id": "plink_1", "url": "https://buy.stripe.com/test_7sI00"}',
        }[name]
        return {"content": [{"type": "text", "text": answer}]}


async def test_stripe_through_the_connector(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = invoicing.InvoiceDesk(hub)
    assert desk.stripe_ready() == "Stripe isn't connected (Tools & Accounts › Stripe)."
    live = StripeLive()
    hub.connectors.connections["stripe"] = SimpleNamespace(policy="ask")
    hub.connectors.live["stripe"] = live
    assert desk.stripe_ready() == ""
    invoice = invoices.Invoice(
        "INV-2026-001", "2026-09-29", "2026-10-29", "Acme", [invoices.Line("Design", 2, 49.995)]
    )
    assert await desk.payment_link(invoice) == "https://buy.stripe.com/test_7sI00"
    assert live.calls == [
        (
            "create_product",
            {"name": "Invoice INV-2026-001", "description": "Acme, invoice INV-2026-001"},
        ),
        ("create_price", {"product": "prod_Q1w2e3", "unit_amount": 9999, "currency": "usd"}),
        ("create_payment_link", {"price": "price_9Z8y7", "quantity": 1}),
    ]
    yen = invoices.Invoice(
        "INV-2026-002",
        "2026-09-29",
        "2026-10-29",
        "Acme",
        [invoices.Line("x", 1, 5000)],
        currency="JPY",
    )
    await desk.payment_link(yen)
    assert live.calls[-2][1]["unit_amount"] == 5000  # yen are whole
    hub.connectors.connections["stripe"].policy = "read_only"
    assert "read-only" in desk.stripe_ready()
    live.tools = live.tools[:1]
    hub.connectors.connections["stripe"].policy = "ask"
    assert "doesn't offer create_price, create_payment_link" in desk.stripe_ready()


async def test_a_recurring_invoice_goes_out_on_its_day(settings, quiet_speaker, isolated):
    alerts, ran = [], []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.notify = lambda alert, **_kw: alerts.append(alert)

    async def run(script, *args, **_kw):
        ran.append((script, args))
        return ""

    day = [date(2026, 10, 1)]
    desk = invoicing.InvoiceDesk(hub, run=run, today=lambda: day[0])
    desk.clients.save_client("Acme", "ap@acme.com", "1 Main St")
    schedule = desk.recurring.add(
        "Acme",
        [{"description": "Retainer", "unit_price": 2000}],
        "monthly",
        "2026-10-01",
        email=True,
        today=TODAY,
    )
    desk.recurring.keep(schedule)
    assert await desk.issue_due() == ["INV-2026-001"]
    invoice = hub.invoices.invoices[-1]
    assert (invoice.client_email, invoice.recurring) == ("ap@acme.com", schedule.id)
    assert Path(invoice.path).suffix == ".html"  # no window in a test: the HTML copy
    assert alerts[0].text == "Issued INV-2026-001 for Acme: $2,000.00, the monthly invoice."
    assert schedule.next == "2026-11-01" and await desk.issue_due() == []
    for _ in range(100):
        if hub.approvals:
            break
        await asyncio.sleep(0.01)
    card = next(iter(hub.approvals.values()))
    assert card["question"] == "Email Acme invoice INV-2026-001?"
    assert [c["label"] for c in card["choices"]] == ["Send", "Don't send"]
    assert ran == []
    hub.resolve(card["id"], "allow")
    await asyncio.gather(*desk._offers)
    script, args = ran[0]
    assert script == mailkit.SEND_SCRIPT and args[0] == "ap@acme.com" and args[6] == invoice.path


async def test_a_recurring_invoice_whose_file_fails_is_issued_once(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.notify = lambda alert, **_kw: None

    async def broken(_page):
        raise RuntimeError("the renderer crashed")

    hub.pdf_call = broken
    desk = invoicing.InvoiceDesk(hub, today=lambda: date(2026, 10, 1))
    lines = [{"description": "Retainer", "unit_price": 2000}]
    desk.recurring.keep(desk.recurring.add("Acme", lines, "monthly", "2026-10-01", today=TODAY))
    assert await desk.issue_due() == ["INV-2026-001"]
    assert (
        desk.error
        == "INV-2026-001 is issued, but its file couldn't be made (the renderer crashed)."
    )
    assert await desk.issue_due() == [] and len(hub.invoices.invoices) == 1  # never again
    again = invoices.Recurring(desk.recurring.path)
    assert again.public()[0]["next"] == "2026-11-01"


async def test_the_reminders_routine_is_switched_on_and_off(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    events = []
    real_emit = hub.emit

    def emit(kind, **data):
        events.append(kind)
        real_emit(kind, **data)

    hub.emit = emit
    desk = hub.invoicing
    assert not desk.reminders_on()
    await desk.command({"type": "invoice_reminders", "on": True})
    routine = hub.routines.items[-1]
    assert (routine.name, routine.kind, routine.time) == ("Invoice reminders", "weekdays", "09:00")
    assert "send_invoice_reminder" in routine.prompt and desk.reminders_on()
    assert events[-2:] == ["routines", "invoicing"]
    await desk.command({"type": "invoice_reminders", "on": True})
    assert len(hub.routines.items) == 1  # never twice
    hub.routines.set_enabled(routine.id, False)
    assert not desk.reminders_on()
    await desk.command({"type": "invoice_reminders", "on": False})
    assert hub.routines.items == [] and hub.prefs.feature("invoice_reminder_routine") == ""


async def test_the_feature_takes_the_invoices_servers_place(
    settings, quiet_speaker, isolated, monkeypatch
):
    seen = []

    def spy(store, pdf, prefs, applescript, extras=None):
        seen.append(extras)
        return {"type": "sdk", "name": "invoices"}

    monkeypatch.setattr(invoices, "build_server", spy)
    hub = make_hub(settings, quiet_speaker, isolated)
    assert hub._feature_servers()["invoices"] == {"type": "sdk", "name": "invoices"}
    assert isinstance(seen[-1], invoices.InvoiceExtras)
    assert "send_invoice_reminder" in hub._feature_prompt()
