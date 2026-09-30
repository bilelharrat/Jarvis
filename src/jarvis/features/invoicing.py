"""Invoicing beyond one invoice: a client list, recurring invoices issued on their day, a
Stripe payment link per invoice through the owner's Stripe connector, and payment reminders
for overdue invoices through a routine the owner switches on (Settings › Invoicing).

The invoices server here is invoices.py's own, built with InvoiceExtras from the hub: it
takes the core one's place under the same name (the hub builds feature servers after its
own), so there's still one create_invoice, and every new tool asks as it should. A reminder
or a recurring invoice's email shows exactly what goes on a Send card; a payment link shows
what Stripe gets; a recurring invoice its schedule.

Claude cost policy: nothing here calls a model by itself. The reminders routine, once the
owner switches it on, is one ordinary JARVIS turn each weekday at 9 (routines.py), on the
owner's chosen model, like any routine; the reminders it sends are a fixed template.
Stripe's connector is the owner's own; creating a link is three of its tool calls.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import date
from pathlib import Path
from typing import Any

from .. import invoices, lang, mac_tools, mailkit, prefs

log = logging.getLogger("jarvis")

ISSUE_EVERY = 1800  # seconds between looks for recurring invoices due
ROUTINE_NAME = "Invoice reminders"
ROUTINE_PROMPT = (
    "Check my overdue invoices with overdue_invoices. For each one that has the client's email "
    "and no reminder in the last week, send it with send_invoice_reminder: I say yes to each "
    "on its card. If none are overdue, say so in a few words."
)
STRIPE = "stripe"  # the Stripe connector's id (connectors.CATALOG)
STRIPE_TOOLS = ("create_product", "create_price", "create_payment_link")
# Currencies Stripe counts in whole units, not cents.
ZERO_DECIMAL = frozenset(
    "BIF CLP DJF GNF ISK JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF XPF".split()
)
# And those it counts in thousandths (the last digit a zero).
THREE_DECIMAL = frozenset("BHD JOD KWD OMR TND".split())


def _routine_id(value: Any) -> str | None:
    return value if isinstance(value, str) and len(value) <= 32 else None


prefs.register_feature_pref("invoice_reminder_routine", "", _routine_id)

# The owner's own words asking for exactly this change (a clause that opens with it).
ASKED = {
    "save_client": (
        r"(?:add|save|put|store|remember|update|change|set)\s+(?:[\w'.&-]+\s+){0,6}?"
        r"(?:as\s+(?:a\s+|my\s+)?client|(?:to|in|on)\s+(?:my\s+|the\s+)?(?:clients?|client\s+list))\b"
        r"|(?:add|save)\s+(?:a\s+)?new\s+client\b"
    ),
    "remove_client": (
        r"(?:remove|delete|drop|take)\s+(?:[\w'.&-]+\s+){0,6}?(?:from|off|out\s+of)\s+"
        r"(?:my\s+|the\s+)?(?:clients?|client\s+list)\b"
    ),
    "stop_recurring": (
        r"(?:stop|cancel|end)\s+(?:[\w'.&-]+\s+){0,6}?"
        r"(?:recurring|monthly|weekly|quarterly|yearly|regular)\s+invoic"
    ),
}
ASKED_ZH = {
    "save_client": r"(?:把[^，,。]{1,20}?)?(?:加|添加|存|保存|记)(?:到|进|为|成)?(?:我的)?客户",
    "remove_client": r"(?:把[^，,。]{1,20}?)?从(?:我的)?客户(?:列表)?(?:里|中)?(?:删除|删掉|移除|去掉)",
    "stop_recurring": r"(?:停止|取消)[^，,。]{0,20}?(?:定期|周期|每月|每周|每季度|每年)发票",
}

lang.add_texts(
    {
        "Issued {number} for {client}: {amount}, the weekly invoice.": "已开出{client}的每周发票 {number}：{amount}。",
        "Issued {number} for {client}: {amount}, the monthly invoice.": "已开出{client}的每月发票 {number}：{amount}。",
        "Issued {number} for {client}: {amount}, the quarterly invoice.": "已开出{client}的季度发票 {number}：{amount}。",
        "Issued {number} for {client}: {amount}, the yearly invoice.": "已开出{client}的年度发票 {number}：{amount}。",
        "Email {client} invoice {number}?": "要把发票 {number} 发邮件给{client}吗？",
        "Here's invoice {number} for {client}, {amount}. Do you want it emailed to them?": "这是给{client}的发票 {number}，金额{amount}。要发邮件给对方吗？",
        "Save {client} to your clients?": "要把{client}存到你的客户里吗？",
        "Remove {client} from your clients?": "要把{client}从你的客户里删除吗？",
        "Stop the recurring invoice for {client}?": "要停止给{client}的定期发票吗？",
        "Set up a recurring invoice for {client}?": "要给{client}设置定期发票吗？",
        "Set up a recurring invoice for {client}: {amount}, {when}?": "要给{client}设置定期发票吗？每次{amount}，{when}。",
        "Create a Stripe payment link for {number}, {amount}?": "要为发票 {number} 生成 Stripe 付款链接吗？金额{amount}。",
        "Here's a payment reminder to {client} for {number}, {amount}. Do you want it sent?": "这是给{client}的付款提醒，发票 {number}，金额{amount}。要发送吗？",
        "Invoice reminders": "发票提醒",
        "Saved a client": "保存了一位客户",
        "Checked your clients": "查看了你的客户",
        "Removed a client": "删除了一位客户",
        "Set up a recurring invoice": "设置了定期发票",
        "Checked recurring invoices": "查看了定期发票",
        "Stopped a recurring invoice": "停止了定期发票",
        "Made a payment link": "生成了付款链接",
        "Checked overdue invoices": "查看了逾期发票",
        "Sent a payment reminder": "发送了付款提醒",
    }
)


async def _refuse(*_args: Any, **_kwargs: Any) -> str:
    """A hub that doesn't poll (a test's) never runs a script on the real Mac."""
    raise mac_tools.ToolFailure("not on this hub")


def _text_of(result: Any) -> str:
    return "\n".join(
        str(c.get("text") or "")
        for c in (result or {}).get("content") or []
        if isinstance(c, dict) and c.get("type") == "text"
    )


def found_id(text: str, prefix: str) -> str:
    m = re.search(rf"\b{prefix}[A-Za-z0-9]+", text)
    if m is None:
        raise ValueError(f"Stripe's answer had no {prefix.rstrip('_')} id.")
    return m.group(0)


def found_url(text: str) -> str:
    m = re.search(r"https://buy\.stripe\.com/[^\s\"'<>)\]]+", text)
    if m is None:
        raise ValueError("Stripe's answer had no payment link in it.")
    return m.group(0)


class InvoiceDesk:
    """The hub's side of invoicing: the stores, the Stripe connector, Mail, the routine and
    the recurring clock. A hub that doesn't poll (a test's) runs no real script."""

    def __init__(self, hub: Any, *, run=None, today=date.today) -> None:
        offline = not getattr(hub, "poll", True)
        self.hub = hub
        self.run = run or (_refuse if offline else mac_tools.run_applescript)
        self.today = today
        self.clients = invoices.ClientBook(hub.feature_path("clients.json"))
        self.recurring = invoices.Recurring(hub.feature_path("recurring.json"))
        self.error = ""
        self._offers: set[asyncio.Task] = set()

    def extras(self) -> invoices.InvoiceExtras:
        return invoices.InvoiceExtras(
            clients=self.clients,
            recurring=self.recurring,
            ask=self.ask,
            asked=self.asked,
            stripe_ready=self.stripe_ready,
            payment_link=self.payment_link,
            send=self.send,
            changed=self.publish,
            named=self.named,
            today=self.today,
            language=lambda: self.hub.language,
        )

    async def ask(self, question: str, detail: str, spoken: str, choices: tuple[str, str]) -> bool:
        return await self.hub.send_gate(question, detail, spoken, choices)

    def named(self, text: str) -> bool:
        """The owner's own words this request gave this text, or the request has read
        nothing (mail, a page, a file) that could have put it in Claude's mouth."""
        reads = self.hub._gate_reads()
        if not (reads.get("private") or reads.get("web")):
            return True
        said = " ".join(str(getattr(self.hub, "_turn_text", "") or "").lower().split())
        return bool(text) and text.lower() in said

    def asked(self, action: str) -> bool:
        from ..hub import _asks, user_asked

        words = str(getattr(self.hub, "_turn_text", "") or "")
        if action in ASKED and user_asked(_asks(ASKED[action]), words):
            return True
        return (
            action in ASKED_ZH
            and lang.is_zh(self.hub.language)
            # "你把Acme从客户里删掉了吗" is a question: asks for nothing
            and lang.user_asked_zh(
                lang._asks_zh(lang._NOT_DONE_ZH + "(?:" + ASKED_ZH[action] + ")"), words
            )
        )

    # Stripe

    def _stripe(self) -> tuple[Any, dict[str, Any]] | str:
        connectors = getattr(self.hub, "connectors", None)
        conn = (getattr(connectors, "connections", {}) or {}).get(STRIPE)
        live = (getattr(connectors, "live", {}) or {}).get(STRIPE)
        if conn is None or live is None:
            return "Stripe isn't connected (Tools & Accounts › Stripe)."
        if getattr(live, "status", "") != "connected":
            return "Stripe's connector isn't connected right now."
        if getattr(conn, "policy", "ask") == "read_only":
            return "Stripe is set to read-only in Tools & Accounts."
        tools = {getattr(t, "name", ""): t for t in getattr(live, "tools", []) or []}
        missing = [name for name in STRIPE_TOOLS if name not in tools]
        if missing:
            return f"Stripe's connector doesn't offer {', '.join(missing)}, so it can't make links."
        return live, tools

    def stripe_ready(self) -> str:
        found = self._stripe()
        return found if isinstance(found, str) else ""

    async def _call(self, live: Any, tool: Any, args: dict[str, Any]) -> str:
        schema = getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", None) or {}
        props = schema.get("properties") if isinstance(schema, dict) else None
        if props:
            args = {k: v for k, v in args.items() if k in props}
            missing = [k for k in schema.get("required") or [] if k not in args]
            if missing:
                raise ValueError(f"its {tool.name} wants {', '.join(missing)}.")
        result = await asyncio.wait_for(live.call(tool.name, args), 60)
        text = _text_of(result)
        if not isinstance(result, dict) or result.get("is_error"):
            raise ValueError(" ".join(text.split())[:200] or "it said no")
        return text

    async def payment_link(self, invoice: invoices.Invoice) -> str:
        found = self._stripe()
        if isinstance(found, str):
            raise ValueError(found)
        live, tools = found
        # Stripe counts in the currency's smallest unit: yen whole, dinars in thousandths
        # (a multiple of ten), the rest in hundredths.
        if invoice.currency in ZERO_DECIMAL:
            amount = int(round(invoice.total))
        elif invoice.currency in THREE_DECIMAL:
            amount = int(round(invoice.total * 100)) * 10
        else:
            amount = int(round(invoice.total * 100))
        product = await self._call(
            live,
            tools["create_product"],
            {
                "name": f"Invoice {invoice.number}",
                "description": f"{invoice.client}, invoice {invoice.number}",
            },
        )
        price = await self._call(
            live,
            tools["create_price"],
            {
                "product": found_id(product, "prod_"),
                "unit_amount": amount,
                "currency": invoice.currency.lower(),
            },
        )
        link = await self._call(
            live, tools["create_payment_link"], {"price": found_id(price, "price_"), "quantity": 1}
        )
        return found_url(link)

    # Mail

    async def send(self, to: str, subject: str, body: str, file: str) -> None:
        await self.run(mailkit.SEND_SCRIPT, to, "", "", subject, body, "", file, timeout=120)

    # recurring invoices

    async def run_clock(self) -> None:
        while True:
            try:
                await self.issue_due()
            except Exception:
                log.exception("invoicing: recurring invoices failed")
            await asyncio.sleep(ISSUE_EVERY)

    async def issue_due(self) -> list[str]:
        """Each recurring invoice whose day has come: the next number, its PDF, a heads-up,
        and (when it's emailed) the Send card."""
        from ..proactive import Alert

        today = self.today()
        store = self.hub.invoices
        issued: list[str] = []
        for schedule in self.recurring.due(today):
            # That very client: never another whose name holds this one ("Acme Holdings"
            # when Acme has been taken off the list).
            client = self.clients.find(schedule.client, exact=True)
            try:
                invoice = store.create(
                    schedule.client,
                    schedule.lines,
                    currency=schedule.currency,
                    due_days=schedule.due_days,
                    tax_percent=schedule.tax_percent,
                    notes=schedule.notes,
                    client_email=client.email if client else "",
                    client_address=client.address if client else "",
                    today=today,
                )
            except ValueError as exc:  # nothing was issued: it's tried again next look
                log.warning("invoicing: a recurring invoice couldn't be issued (%s)", exc)
                continue
            invoice.recurring = schedule.id
            # On to its next day before the file is made: an invoice whose layout fails is
            # still issued once, never again every half hour.
            schedule.issued = [*schedule.issued, invoice.number][-60:]
            self.recurring.advance(schedule, today)
            try:
                self.recurring.save()
            except OSError as exc:
                self.error = f"Couldn't save the recurring invoices ({exc.strerror or exc})."
            p = self.hub.prefs
            try:
                await invoices.issue(
                    store, invoice, self.hub.pdf_call, p.invoice_from, p.invoice_payment
                )
            except Exception as exc:
                log.warning("invoicing: %s's file couldn't be made (%s)", invoice.number, exc)
                self.error = f"{invoice.number} is issued, but its file couldn't be made ({exc})."
                issued.append(invoice.number)
                continue
            amount = invoices.money(invoice.total, invoice.currency)
            self.hub.notify(
                Alert(
                    f"invoice:{invoice.number}",
                    "invoice",
                    "Invoices",
                    f"Issued {invoice.number} for {invoice.client}: {amount}, the {schedule.every} invoice.",
                )
            )
            issued.append(invoice.number)
            if schedule.email and invoice.client_email:
                task = asyncio.ensure_future(self.offer_email(invoice))
                self._offers.add(task)
                task.add_done_callback(self._offered)
        if issued:
            self.publish()
        return issued

    def _offered(self, task: asyncio.Task) -> None:
        self._offers.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("invoicing: offering an invoice by email failed", exc_info=task.exception())

    def _said(self, invoice: invoices.Invoice) -> str:
        """The amount as a card says it (its figures in Chinese, read as 两千美元)."""
        if lang.is_zh(self.hub.language):
            return invoices.money(invoice.total, invoice.currency)
        return invoices.spoken_money(invoice.total, invoice.currency)

    async def offer_email(self, invoice: invoices.Invoice) -> bool:
        """A recurring invoice to its client: the Send card with exactly what goes, then Mail."""
        sender = self.hub.prefs.invoice_from.strip().splitlines()
        name = sender[0] if sender else ""
        subject = f"Invoice {invoice.number}" + (f" from {name}" if name else "")
        pay = f" You can pay online here: {invoice.payment_link}" if invoice.payment_link else ""
        body = (
            f"Hello,\n\nPlease find attached invoice {invoice.number} for "
            f"{invoices.money(invoice.total, invoice.currency)}, due {invoice.due}.{pay}\n\nThank you."
        )
        path = Path(invoice.path)
        detail = (
            f"To {invoice.client} <{invoice.client_email}>\nSubject: {subject}\n"
            f"Attached: {path.name}\n\n{body}"
        )
        if not await self.ask(
            f"Email {invoice.client} invoice {invoice.number}?",
            detail,
            f"Here's invoice {invoice.number} for {invoice.client}, "
            f"{self._said(invoice)}. Do you want it emailed to them?",
            ("Send", "Don't send"),
        ):
            return False
        try:
            await self.send(invoice.client_email, subject, body, str(path))
        except mac_tools.ToolFailure as exc:
            log.warning("invoicing: Mail didn't send %s (%s)", invoice.number, exc)
            return False
        return True

    # the reminders routine

    def _routine(self) -> Any:
        rid = self.hub.prefs.feature("invoice_reminder_routine") or ""
        return next((r for r in self.hub.routines.items if r.id == rid), None) if rid else None

    def reminders_on(self) -> bool:
        routine = self._routine()
        return bool(routine is not None and routine.enabled)

    def set_reminders(self, on: bool) -> None:
        routine = self._routine()
        try:
            if on and routine is None:
                routine = self.hub.routines.add(ROUTINE_NAME, ROUTINE_PROMPT, "weekdays", "09:00")
                self.hub.set_feature_prefs({"invoice_reminder_routine": routine.id})
            elif on and not routine.enabled:
                self.hub.routines.set_enabled(routine.id, True)
            elif not on and routine is not None:
                self.hub.routines.remove(routine.id)
                self.hub.set_feature_prefs({"invoice_reminder_routine": ""})
            self.error = ""
        except (OSError, ValueError) as exc:
            self.error = f"Couldn't change the routine ({getattr(exc, 'strerror', None) or exc})."
        self.hub.emit("routines", items=self.hub.routines.public())
        self.publish()

    # the window

    def public(self) -> dict[str, Any]:
        return {
            "clients": self.clients.public(),
            "recurring": self.recurring.public(),
            "reminders": self.reminders_on(),
            "stripe": self.stripe_ready(),
            "error": self.error,
        }

    def publish(self) -> None:
        self.hub.emit("invoicing", **self.public())

    async def command(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        key = str(msg.get("id") or "")
        try:
            if kind == "invoice_reminders":
                self.set_reminders(msg.get("on") is True)
                return
            if kind == "invoicing_client_remove" and key:
                self.clients.remove(key)
            elif kind == "invoicing_stop" and key:
                self.recurring.stop(key)
        except OSError as exc:
            self.error = f"Couldn't save that ({exc.strerror or exc})."
        self.publish()


def install(hub: Any) -> None:
    desk = InvoiceDesk(hub)
    hub.invoicing = desk
    extras = desk.extras()
    # Under invoices.py's own name: it takes the core invoices server's place, same tools
    # and more of them.
    hub.register_server(
        invoices.SERVER_NAME,
        lambda: invoices.build_server(
            hub.invoices, hub.pdf_call, lambda: hub.prefs, mac_tools.run_applescript, extras
        ),
        prompt=(
            "\n- Invoicing, more: save_client and list_clients keep the user's clients (an "
            "invoice for a saved client takes their email and address); "
            "create_recurring_invoice sets one up to go out weekly, monthly, quarterly or "
            "yearly; invoice_payment_link makes a Stripe payment link for an invoice through "
            "their Stripe connector; overdue_invoices lists late ones and "
            "send_invoice_reminder emails a client a polite reminder. Every one of these that "
            "reaches someone asks the user first."
        ),
        labels={
            "save_client": "Saved a client",
            "list_clients": "Checked your clients",
            "remove_client": "Removed a client",
            "create_recurring_invoice": "Set up a recurring invoice",
            "list_recurring_invoices": "Checked recurring invoices",
            "stop_recurring_invoice": "Stopped a recurring invoice",
            "invoice_payment_link": "Made a payment link",
            "overdue_invoices": "Checked overdue invoices",
            "send_invoice_reminder": "Sent a payment reminder",
        },
        quiet=("save_client", "remove_client", "stop_recurring_invoice"),
    )
    for kind in ("invoicing", "invoice_reminders", "invoicing_client_remove", "invoicing_stop"):
        hub.register_command(kind, desk.command)
    hub.register_loop("invoicing", desk.run_clock)
