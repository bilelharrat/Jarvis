"""Invoices by voice: "Jarvis, invoice Acme for ten hours of consulting at 150 an hour,
due in 30 days."

Each invoice gets the next number (INV-2026-001, …), is laid out as a clean one-page PDF
in ~/Documents/Jarvis/Invoices (drawn by the app window's own renderer; an HTML copy
when there's no window), and can go into a Mail draft with the PDF attached for the
user to read over and send. The business details at the top come from Settings ›
Invoices, which the user fills in themselves.

With InvoiceExtras (features/invoicing.py fills them in from the hub) the same tools also
keep a client list (clients.json), recurring invoices (recurring.json), a Stripe payment
link per invoice through the Stripe connector, and payment reminders for overdue ones.
Nothing goes to anyone without its card: a reminder shows the exact email, a payment link
what Stripe gets, a recurring invoice its schedule.
"""

from __future__ import annotations

import contextlib
import errno
import html
import logging
import math
import os
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import jsonstore
from .prefs import APP_SUPPORT
from .textclean import clean_text

log = logging.getLogger("jarvis")

SERVER_NAME = "invoices"
INVOICES_DIR = Path.home() / "Documents" / "Jarvis" / "Invoices"
CURRENCIES = {"USD": "$", "EUR": "€", "GBP": "£", "CAD": "CA$", "AUD": "A$", "JPY": "¥", "CNY": "¥"}
MAX_ITEMS = 40


@dataclass
class Line:
    description: str
    quantity: float
    unit_price: float

    @property
    def amount(self) -> float:
        return round(self.quantity * self.unit_price, 2)


@dataclass
class Invoice:
    number: str
    issued: str  # YYYY-MM-DD
    due: str
    client: str
    lines: list[Line]
    currency: str = "USD"
    tax_percent: float = 0.0
    notes: str = ""
    client_email: str = ""
    client_address: str = ""
    status: str = "open"  # open | paid
    path: str = ""
    payment_link: str = ""  # a Stripe payment link made for it
    reminded: list[str] = field(default_factory=list)  # days a payment reminder went out
    recurring: str = ""  # the recurring invoice that issued it

    @property
    def subtotal(self) -> float:
        return round(sum(line.amount for line in self.lines), 2)

    @property
    def tax(self) -> float:
        return round(self.subtotal * self.tax_percent / 100, 2)

    @property
    def total(self) -> float:
        return round(self.subtotal + self.tax, 2)


def money(value: float, currency: str) -> str:
    symbol = CURRENCIES.get(currency, f"{currency} ")
    decimals = 0 if currency == "JPY" else 2
    return f"{'−' if value < 0 else ''}{symbol}{abs(value):,.{decimals}f}"


def spoken_money(value: float, currency: str) -> str:
    names = {"USD": "dollars", "EUR": "euros", "GBP": "pounds", "JPY": "yen", "CNY": "yuan"}
    whole = f"{value:,.2f}".rstrip("0").rstrip(".")
    return f"{whole} {names.get(currency, currency)}"


def clean_lines(items: Any) -> list[Line]:
    """Claude's line items -> Lines, refusing anything that doesn't add up."""
    if not isinstance(items, list) or not items:
        raise ValueError(
            "An invoice needs at least one line: a description, a quantity and a price."
        )
    lines = []
    for raw in items[:MAX_ITEMS]:
        if not isinstance(raw, dict):
            raise ValueError("Each line needs a description, a quantity and a unit price.")
        description = re.sub(r"\s+", " ", clean_text(raw.get("description", ""))).strip()[:200]
        try:
            given = raw.get("quantity")
            quantity = 1.0 if given in (None, "") else float(given)
            unit_price = float(str(raw.get("unit_price", "")).replace(",", "").lstrip("$€£¥"))
        except ValueError as exc:
            raise ValueError(
                f"I couldn't read the numbers on “{description or 'a line'}”."
            ) from exc
        if not description or quantity <= 0 or unit_price < 0:
            raise ValueError(
                f"The line “{description or '?'}” needs a quantity above zero and a price."
            )
        lines.append(Line(description, quantity, unit_price))
    return lines


_INVOICE_FIELDS = frozenset(f.name for f in fields(Invoice)) - {"lines"}
_TEXT_FIELDS = (
    "number",
    "issued",
    "due",
    "client",
    "currency",
    "notes",
    "status",
    "path",
    "payment_link",
    "recurring",
)
_CLEANED = ("client", "notes", "client_email", "client_address")


def _invoices_file(data: Any) -> bool:
    return isinstance(data, dict) and isinstance(data.get("invoices", []), list)


def _invoice_from(item: Any) -> Invoice | None:
    """An invoice from the file that can be listed, laid out and added up, with nothing
    hidden in its words; None for one that can't (another build's, a hand edit)."""
    try:
        lines = [
            Line(clean_text(x["description"]), float(x["quantity"]), float(x["unit_price"]))
            for x in item["lines"]
        ]
        invoice = Invoice(lines=lines, **{k: v for k, v in item.items() if k in _INVOICE_FIELDS})
        if not all(isinstance(getattr(invoice, k), str) for k in (*_TEXT_FIELDS, *_CLEANED)):
            return None
        if not isinstance(invoice.reminded, list):
            return None
        invoice.reminded = [d for d in invoice.reminded if isinstance(d, str)][-20:]
        datetime.fromisoformat(invoice.issued)
        datetime.fromisoformat(invoice.due)
        invoice.tax_percent = float(invoice.tax_percent)
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError, RecursionError):
        return None
    numbers = [
        invoice.tax_percent,
        *(x for line in lines for x in (line.quantity, line.unit_price)),
    ]
    if not all(math.isfinite(n) for n in numbers):
        return None
    for name in _CLEANED:
        setattr(invoice, name, clean_text(getattr(invoice, name)))
    return invoice


def _write_new(path: Path, data: bytes) -> Path:
    """Create the file, never writing over one that's there (an invoice already issued):
    "INV-2026-004 Acme (2).pdf" when the name is taken."""
    for n in range(1, 100):
        candidate = path if n == 1 else path.with_name(f"{path.stem} ({n}){path.suffix}")
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        except FileExistsError:
            continue
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        return candidate
    raise FileExistsError(errno.EEXIST, "Too many invoices by that name", str(path))


class InvoiceStore:
    """Issued invoices and the numbering, in Application Support. An invoice in the file
    that can't be read is left out (never listed or laid out) and written back as it was."""

    def __init__(self, path: Path | None = None, folder: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "invoices.json"
        self.folder = folder or INVOICES_DIR
        self.invoices: list[Invoice] = []
        self.broken: list[Any] = []  # invoices it can't use, kept in the file as they were
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self._load()

    def _load(self) -> None:
        try:
            data = jsonstore.load_json(self.path, _invoices_file)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("invoices: %s can't be read (%s); leaving it be", self.path.name, exc)
            return
        for item in (data or {}).get("invoices", []):
            invoice = _invoice_from(item)
            if invoice is not None:
                self.invoices.append(invoice)
            elif jsonstore.shallow(item):
                self.broken.append(item)

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        rows = [asdict(i) for i in self.invoices] + self.broken
        jsonstore.save_json(self.path, {"invoices": rows})

    def next_number(self, today: date) -> str:
        """The year's next number. The issued files count too, and invoices it couldn't
        read: a lost or damaged list never hands out a number already on an invoice (and
        the file named after it)."""
        prefix = f"INV-{today.year}-"
        names = [i.number for i in self.invoices]
        names += [str(r.get("number", "")) for r in self.broken if isinstance(r, dict)]
        with contextlib.suppress(OSError):
            names += [p.name for p in self.folder.iterdir()]
        pattern = re.compile(re.escape(prefix) + r"([0-9]+)(?![0-9])")
        taken = [int(m.group(1)) for name in names if (m := pattern.match(name))]
        return f"{prefix}{max(taken, default=0) + 1:03d}"

    def create(
        self,
        client: str,
        items: Any,
        *,
        currency: str = "USD",
        due_days: int = 30,
        tax_percent: float = 0.0,
        notes: str = "",
        client_email: str = "",
        client_address: str = "",
        today: date | None = None,
    ) -> Invoice:
        client = re.sub(r"\s+", " ", clean_text(client or "")).strip()[:120]
        if not client:
            raise ValueError("Who is the invoice for?")
        currency = (currency or "USD").strip().upper()[:3]
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("The currency should be a three-letter code like USD.")
        today = today or date.today()
        due_days = max(0, min(365, int(due_days or 0)))
        invoice = Invoice(
            number=self.next_number(today),
            issued=today.isoformat(),
            due=(today + timedelta(days=due_days)).isoformat(),
            client=client,
            lines=clean_lines(items),
            currency=currency,
            tax_percent=max(0.0, min(50.0, float(tax_percent or 0))),
            notes=clean_text(notes or "").strip()[:600],
            client_email=clean_text(client_email or "").strip()[:120],
            client_address=clean_text(client_address or "").strip()[:300],
        )
        self.invoices.append(invoice)
        try:
            self.save()
        except OSError as exc:  # not on disk, so not issued: the number stays free
            self.invoices.remove(invoice)
            raise ValueError(
                f"I couldn't save the invoice ({exc.strerror or exc}), so nothing was issued."
            ) from None
        return invoice

    def find(self, number: str) -> Invoice | None:
        want = number.strip().upper()
        for invoice in reversed(self.invoices):
            if invoice.number == want or invoice.number.endswith(f"-{want.lstrip('#').zfill(3)}"):
                return invoice
        return None

    def file_name(self, invoice: Invoice, ext: str) -> Path:
        safe = re.sub(r"[^\w .&\-]", "", invoice.client).strip()[:60] or "Client"
        return self.folder / f"{invoice.number} {safe}.{ext}"


# ── clients ──

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.IGNORECASE)
MAX_CLIENTS = 500


@dataclass
class Client:
    id: str
    name: str
    email: str = ""
    address: str = ""
    currency: str = ""
    notes: str = ""


def _plain(text: Any, limit: int) -> str:
    return re.sub(r"[ \t]+", " ", clean_text(text or "")).strip()[:limit]


class ClientBook:
    """The people and companies the owner invoices (clients.json beside invoices.json), so
    "invoice Acme" knows Acme's email, address and currency. A row it can't read is kept in
    the file as it was, never shown."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.clients: list[Client] = []
        self.broken: list[Any] = []
        self.unreadable = ""
        self.loaded = False

    def load(self) -> None:
        if self.loaded:
            return
        self.loaded = True
        try:
            data = jsonstore.load_json(self.path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            return
        for raw in data or []:
            client = _client_from(raw)
            if client is not None:
                self.clients.append(client)
            elif jsonstore.shallow(raw):
                self.broken.append(raw)

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [asdict(c) for c in self.clients] + self.broken)

    def find(self, name: str, *, exact: bool = False) -> Client | None:
        """By name exactly (ignoring case and spacing), else (unless exact) the one whose name
        holds it."""
        self.load()
        want = " ".join(str(name or "").casefold().split())
        if not want:
            return None
        same = [c for c in self.clients if " ".join(c.name.casefold().split()) == want]
        if same or exact:
            return same[0] if same else None
        near = [c for c in self.clients if want in c.name.casefold() or c.id == want]
        return near[0] if len(near) == 1 else None

    def save_client(
        self, name: str, email: str = "", address: str = "", currency: str = "", notes: str = ""
    ) -> tuple[Client, bool]:
        """Add a client, or update the one by that name: (it, whether it's new). ValueError
        says what's wrong."""
        self.load()
        name = _plain(name, 120)
        if not name:
            raise ValueError("A client needs a name.")
        email = _plain(email, 120)
        if email and not _EMAIL.match(email):
            raise ValueError(f"{email} isn't an email address.")
        currency = _plain(currency, 3).upper()
        if currency and not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("The currency should be a three-letter code like USD.")
        found = self.find(name)
        new = found is None or " ".join(found.name.casefold().split()) != " ".join(
            name.casefold().split()
        )
        if new:
            if len(self.clients) >= MAX_CLIENTS:
                raise ValueError(f"The client list holds at most {MAX_CLIENTS}.")
            found = Client(uuid.uuid4().hex[:8], name)
            self.clients.append(found)
        assert found is not None
        before = asdict(found)
        found.email = email or found.email
        found.address = _plain(address, 300) or found.address
        found.currency = currency or found.currency
        found.notes = _plain(notes, 300) or found.notes
        try:
            self.save()
        except OSError:
            if new:
                self.clients.remove(found)
            else:
                for key, value in before.items():
                    setattr(found, key, value)
            raise
        return found, new

    def remove(self, key: str) -> Client | None:
        found = self.find(key)
        if found is None:
            return None
        self.clients.remove(found)
        try:
            self.save()
        except OSError:
            self.clients.append(found)
            raise
        return found

    def public(self) -> list[dict[str, Any]]:
        self.load()
        return [asdict(c) for c in sorted(self.clients, key=lambda c: c.name.casefold())]


def _client_from(raw: Any) -> Client | None:
    if not isinstance(raw, dict):
        return None
    known = {f.name for f in fields(Client)}
    try:
        client = Client(**{k: v for k, v in raw.items() if k in known})
    except TypeError:
        return None
    if not all(isinstance(getattr(client, f.name), str) for f in fields(Client)):
        return None
    client.name = _plain(client.name, 120)
    if not (client.id and client.name):
        return None
    for name, limit in (("email", 120), ("address", 300), ("currency", 3), ("notes", 300)):
        setattr(client, name, _plain(getattr(client, name), limit))
    return client


# ── recurring invoices ──

EVERY = ("weekly", "monthly", "quarterly", "yearly")
MAX_SCHEDULES = 50


@dataclass
class Schedule:
    """An invoice that goes out on a schedule: to whom, for what, and when next."""

    id: str
    client: str
    lines: list[dict[str, Any]]
    every: str
    next: str  # YYYY-MM-DD: the next one's day
    anchor: int = 1  # the day of the month it keeps to (weekly: the weekday, 0 = Monday)
    currency: str = "USD"
    due_days: int = 30
    tax_percent: float = 0.0
    notes: str = ""
    email: bool = False  # each one is offered to the client by email, on a Send card
    active: bool = True
    issued: list[str] = field(default_factory=list)  # the numbers it has issued


def _months_on(day: date, months: int, anchor: int) -> date:
    import calendar

    month = day.month - 1 + months
    year, month = day.year + month // 12, month % 12 + 1
    return date(year, month, min(anchor, calendar.monthrange(year, month)[1]))


def next_after(day: date, every: str, anchor: int) -> date:
    """The schedule's next day after this one."""
    if every == "weekly":
        return day + timedelta(days=7)
    months = {"monthly": 1, "quarterly": 3, "yearly": 12}[every]
    return _months_on(day, months, anchor)


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def describe_schedule(schedule: Schedule, language: str = "en") -> str:
    """ "every month on the 1st, next on 1 October 2026" (每月1日，下次是2026年10月1日)."""
    nxt = date.fromisoformat(schedule.next)
    if language == "zh":
        when = {
            "weekly": f"每周{'一二三四五六日'[schedule.anchor % 7]}",
            "monthly": f"每月{schedule.anchor}日",
            "quarterly": f"每三个月的{schedule.anchor}日",
            "yearly": f"每年{nxt.month}月{nxt.day}日",
        }[schedule.every]
        return f"{when}，下次是{nxt.year}年{nxt.month}月{nxt.day}日"
    days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    when = {
        "weekly": f"every week on {days[schedule.anchor % 7]}",
        "monthly": f"every month on the {_ordinal(schedule.anchor)}",
        "quarterly": f"every three months on the {_ordinal(schedule.anchor)}",
        "yearly": f"every year on {nxt:%-d %B}",
    }[schedule.every]
    return f"{when}, next on {nxt:%-d %B %Y}"


def schedule_total(schedule: Schedule) -> float:
    subtotal = round(
        sum(round(float(x["quantity"]) * float(x["unit_price"]), 2) for x in schedule.lines), 2
    )
    return round(subtotal + round(subtotal * schedule.tax_percent / 100, 2), 2)


class Recurring:
    """The recurring invoices (recurring.json beside invoices.json). Each goes out on its
    day: the next number, the PDF, and (when the owner chose it) a Send card to email it."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.items: list[Schedule] = []
        self.broken: list[Any] = []
        self.unreadable = ""
        self.loaded = False

    def load(self) -> None:
        if self.loaded:
            return
        self.loaded = True
        try:
            data = jsonstore.load_json(self.path, list)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            return
        for raw in data or []:
            schedule = _schedule_from(raw)
            if schedule is not None:
                self.items.append(schedule)
            elif jsonstore.shallow(raw):
                self.broken.append(raw)

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [asdict(x) for x in self.items] + self.broken)

    def add(
        self,
        client: str,
        items: Any,
        every: str,
        start: str,
        *,
        currency: str = "USD",
        due_days: int = 30,
        tax_percent: float = 0.0,
        notes: str = "",
        email: bool = False,
        today: date | None = None,
    ) -> Schedule:
        """Checked, but not kept: keep() does that once the owner has said yes."""
        self.load()
        client = _plain(client, 120)
        if not client:
            raise ValueError("Who is the recurring invoice for?")
        if every not in EVERY:
            raise ValueError(f"every must be one of {', '.join(EVERY)}.")
        lines = [asdict(line) for line in clean_lines(items)]
        today = today or date.today()
        try:
            first = date.fromisoformat(str(start or today.isoformat())[:10])
        except ValueError:
            raise ValueError(f"“{start}” isn't a date: give it like 2026-10-01.") from None
        if first < today:
            raise ValueError("The first one can't be in the past.")
        currency = (currency or "USD").strip().upper()[:3]
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("The currency should be a three-letter code like USD.")
        if len([x for x in self.items if x.active]) >= MAX_SCHEDULES:
            raise ValueError(f"At most {MAX_SCHEDULES} recurring invoices.")
        return Schedule(
            uuid.uuid4().hex[:8],
            client,
            lines,
            every,
            first.isoformat(),
            anchor=first.weekday() if every == "weekly" else first.day,
            currency=currency,
            due_days=max(0, min(365, int(due_days or 0))),
            tax_percent=max(0.0, min(50.0, float(tax_percent or 0))),
            notes=_plain(notes, 600),
            email=bool(email),
        )

    def keep(self, schedule: Schedule) -> None:
        self.load()
        self.items.append(schedule)
        try:
            self.save()
        except OSError:
            self.items.remove(schedule)
            raise

    def find(self, key: str) -> Schedule | None:
        self.load()
        want = " ".join(str(key or "").casefold().split())
        live = [x for x in self.items if x.active]
        return next((x for x in live if x.id == want), None) or next(
            (x for x in live if want and want in x.client.casefold()), None
        )

    def stop(self, key: str) -> Schedule | None:
        found = self.find(key)
        if found is None:
            return None
        found.active = False
        try:
            self.save()
        except OSError:
            found.active = True
            raise
        return found

    def due(self, today: date) -> list[Schedule]:
        self.load()
        return [x for x in self.items if x.active and date.fromisoformat(x.next) <= today]

    def advance(self, schedule: Schedule, today: date) -> None:
        """On to its next day after today (a Mac that was off for two months issues the
        latest one, not a burst of them)."""
        day = date.fromisoformat(schedule.next)
        while day <= today:
            day = next_after(day, schedule.every, schedule.anchor)
        schedule.next = day.isoformat()

    def public(self) -> list[dict[str, Any]]:
        self.load()
        return [
            {**asdict(x), "when": describe_schedule(x), "total": schedule_total(x)}
            for x in self.items
            if x.active
        ]


def _schedule_from(raw: Any) -> Schedule | None:
    if not isinstance(raw, dict):
        return None
    known = {f.name for f in fields(Schedule)}
    try:
        schedule = Schedule(**{k: v for k, v in raw.items() if k in known})
        texts = (
            schedule.id,
            schedule.client,
            schedule.every,
            schedule.next,
            schedule.currency,
            schedule.notes,
        )
        if not all(isinstance(t, str) for t in texts) or schedule.every not in EVERY:
            return None
        date.fromisoformat(schedule.next)
        schedule.lines = [asdict(line) for line in clean_lines(schedule.lines)]
        schedule.anchor = int(schedule.anchor)
        schedule.due_days = max(0, min(365, int(schedule.due_days)))
        schedule.tax_percent = max(0.0, min(50.0, float(schedule.tax_percent)))
        if not math.isfinite(schedule.tax_percent):
            return None
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError):
        return None
    schedule.email = schedule.email is True
    schedule.active = schedule.active is not False
    schedule.issued = (
        [n for n in schedule.issued if isinstance(n, str)][-60:]
        if isinstance(schedule.issued, list)
        else []
    )
    return schedule


# ── overdue ──

REMIND_EVERY_DAYS = 7  # one reminder a week per invoice, at most


def overdue(store: InvoiceStore, today: date) -> list[Invoice]:
    return [i for i in store.invoices if i.status == "open" and date.fromisoformat(i.due) < today]


def reminder_email(invoice: Invoice, sender: str, today: date) -> tuple[str, str]:
    """(subject, body) of a payment reminder: polite, with the amount, the day it was due,
    the payment link when there is one, and the invoice attached again."""
    due = datetime.fromisoformat(invoice.due).strftime("%-d %B %Y")
    name = sender.strip().splitlines()[0] if sender.strip() else ""
    subject = f"Reminder: invoice {invoice.number} is overdue"
    pay = f" You can pay online here: {invoice.payment_link}" if invoice.payment_link else ""
    body = (
        f"Hello,\n\nThis is a friendly reminder that invoice {invoice.number} for "
        f"{money(invoice.total, invoice.currency)} was due on {due}.{pay} I've attached the "
        "invoice again for convenience.\n\nThank you" + (f",\n{name}" if name else ".")
    )
    return subject, body


def render_html(invoice: Invoice, sender: str = "", payment: str = "") -> str:
    """One page, the way a studio would send it: the numbers carry it."""
    e = html.escape
    rows = "".join(
        f"<tr><td>{e(line.description)}</td><td class=n>{line.quantity:g}</td>"
        f"<td class=n>{money(line.unit_price, invoice.currency)}</td>"
        f"<td class=n>{money(line.amount, invoice.currency)}</td></tr>"
        for line in invoice.lines
    )
    tax = (
        f"<tr><td>Tax ({invoice.tax_percent:g}%)</td><td class=n>{money(invoice.tax, invoice.currency)}</td></tr>"
        if invoice.tax_percent
        else ""
    )

    def block(text: str) -> str:
        return "<br>".join(e(part) for part in text.strip().splitlines() if part.strip())

    sender_lines = sender.strip().splitlines()
    sender_name = e(sender_lines[0]) if sender_lines else ""
    sender_rest = block("\n".join(sender_lines[1:]))
    issued = datetime.fromisoformat(invoice.issued).strftime("%-d %B %Y")
    due = datetime.fromisoformat(invoice.due).strftime("%-d %B %Y")
    client = block("\n".join([invoice.client, invoice.client_address, invoice.client_email]))
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{e(invoice.number)}</title>
<style>
@page {{ size: Letter; margin: 0; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font: 11pt/1.45 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; color: #1d1d1f; }}
.page {{ padding: 0.9in 0.85in; min-height: 11in; display: flex; flex-direction: column; }}
header {{ display: flex; justify-content: space-between; align-items: flex-start; }}
.from b {{ display: block; font-size: 14pt; letter-spacing: -0.01em; }}
.from span, .meta span {{ color: #6e6e73; font-size: 9.5pt; }}
h1 {{ margin: 0; font-size: 26pt; font-weight: 600; letter-spacing: -0.02em; text-align: right; }}
.meta {{ text-align: right; margin-top: 6px; }}
.meta div {{ font-size: 10pt; }}
.to {{ margin: 0.45in 0 0.3in; }}
.label {{ font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #86868b; margin-bottom: 4px; }}
table {{ width: 100%; border-collapse: collapse; }}
thead td {{ font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #86868b; border-bottom: 1px solid #d2d2d7; padding: 0 0 8px; }}
tbody td {{ padding: 10px 0; border-bottom: 1px solid #ececf0; vertical-align: top; }}
.n {{ text-align: right; white-space: nowrap; padding-left: 18px; font-variant-numeric: tabular-nums; }}
.totals {{ margin-left: auto; width: 46%; margin-top: 14px; }}
.totals td {{ padding: 5px 0; }}
.totals .due td {{ border-top: 1.5px solid #1d1d1f; padding-top: 10px; font-size: 14pt; font-weight: 600; }}
.notes {{ margin-top: 0.4in; font-size: 10pt; color: #3a3a3c; }}
footer {{ margin-top: auto; padding-top: 0.4in; font-size: 9pt; color: #86868b; }}
</style></head><body><div class="page">
<header><div class="from"><b>{sender_name or "Invoice"}</b><span>{sender_rest}</span></div>
<div><h1>Invoice</h1><div class="meta"><div><b>{e(invoice.number)}</b></div>
<div><span>Issued</span> {issued}</div><div><span>Due</span> {due}</div></div></div></header>
<div class="to"><div class="label">Billed to</div>{client}</div>
<table><thead><tr><td>Description</td><td class=n>Qty</td><td class=n>Rate</td><td class=n>Amount</td></tr></thead>
<tbody>{rows}</tbody></table>
<table class="totals"><tr><td>Subtotal</td><td class=n>{money(invoice.subtotal, invoice.currency)}</td></tr>{tax}
<tr class="due"><td>Amount due</td><td class=n>{money(invoice.total, invoice.currency)}</td></tr></table>
{f'<div class="notes"><div class="label">Notes</div>{block(invoice.notes)}</div>' if invoice.notes else ""}
{f'<div class="notes"><div class="label">Payment</div>{block(payment)}</div>' if payment.strip() else ""}
<footer>Thank you for your business.</footer>
</div></body></html>"""


DRAFT_SCRIPT = """on run argv
    tell application "Mail"
        set m to make new outgoing message with properties {subject:item 2 of argv, content:item 3 of argv, visible:true}
        if (item 1 of argv) is not "" then
            tell m to make new to recipient at end of to recipients with properties {address:item 1 of argv}
        end if
        tell content of m to make new attachment with properties {file name:(POSIX file (item 4 of argv))} at after the last paragraph
        activate
    end tell
end run"""

Pdf = Callable[[str], Awaitable[bytes | None]]
Script = Callable[..., Awaitable[str]]


async def issue(store: InvoiceStore, invoice: Invoice, pdf: Pdf, sender: str, payment: str) -> Path:
    """Lay the invoice out and file it: a PDF when the window can draw one, else HTML.
    Never over a file that's there: an invoice once issued stays as it was sent."""
    page = render_html(invoice, sender, payment)
    store.folder.mkdir(parents=True, exist_ok=True)
    data = await pdf(page)
    if data:
        path = _write_new(store.file_name(invoice, "pdf"), data)
    else:
        path = _write_new(store.file_name(invoice, "html"), page.encode("utf-8", "replace"))
    invoice.path = str(path)
    store.save()
    return path


@dataclass
class InvoiceExtras:
    """What the full invoices server can do beyond making and drafting invoices: callables
    features/invoicing.py makes from the hub (tests pass fakes).

    ask(question, detail, spoken, (yes, no)) -> the owner's yes on a card.
    asked(action) -> the owner's own words this request asked for exactly that change.
    named(text) -> the owner's own words gave this (an address), or the request has read
      nothing someone else wrote that could have.
    stripe_ready() -> "" when Stripe's connector can make payment links, else why not.
    payment_link(invoice) -> the link Stripe made (ValueError says why it couldn't).
    send(to, subject, body, file) -> Mail sends it with the file (after its card).
    """

    clients: ClientBook
    recurring: Recurring
    ask: Callable[[str, str, str, tuple[str, str]], Awaitable[bool]]
    asked: Callable[[str], bool]
    stripe_ready: Callable[[], str]
    payment_link: Callable[[Invoice], Awaitable[str]]
    send: Callable[[str, str, str, str], Awaitable[None]]
    changed: Callable[[], None] = lambda: None
    named: Callable[[str], bool] = lambda _text: True
    today: Callable[[], date] = date.today
    language: Callable[[], str] = lambda: "en"  # what the cards are said in: "en" or "zh"


def build_tools(
    store: InvoiceStore,
    pdf: Pdf,
    prefs: Callable[[], Any],
    applescript: Script,
    extras: InvoiceExtras | None = None,
):
    def _text(text: str, error: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
        if error:
            out["is_error"] = True
        return out

    @tool(
        "create_invoice",
        "Make an invoice: the next number, laid out as a PDF in Documents › Jarvis › Invoices. "
        "items: [{description, quantity, unit_price}]. currency: a code like USD. due_days: "
        "payment terms (default 30). tax_percent, notes, client_email and client_address are "
        "optional. Check the client and the numbers with the user if anything is unclear.",
        {
            "type": "object",
            "properties": {
                "client": {"type": "string"},
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {"type": "string"},
                            "quantity": {"type": "number"},
                            "unit_price": {"type": "number"},
                        },
                        "required": ["description", "unit_price"],
                    },
                },
                "currency": {"type": "string"},
                "due_days": {"type": "integer"},
                "tax_percent": {"type": "number"},
                "notes": {"type": "string"},
                "client_email": {"type": "string"},
                "client_address": {"type": "string"},
            },
            "required": ["client", "items"],
        },
    )
    async def create_invoice(args):
        p = prefs()
        saved = extras.clients.find(str(args.get("client") or "")) if extras else None
        try:
            invoice = store.create(
                saved.name if saved else args.get("client", ""),
                args.get("items"),
                currency=args.get("currency") or (saved.currency if saved else "") or "USD",
                due_days=args.get("due_days", 30),
                tax_percent=args.get("tax_percent") or 0,
                notes=args.get("notes", ""),
                client_email=args.get("client_email") or (saved.email if saved else ""),
                client_address=args.get("client_address") or (saved.address if saved else ""),
            )
        except ValueError as exc:
            return _text(str(exc), error=True)
        path = await issue(store, invoice, pdf, p.invoice_from, p.invoice_payment)
        missing = (
            ""
            if p.invoice_from.strip()
            else (" (Your business details aren't set: add them in Settings › Invoices.)")
        )
        return _text(
            f"{invoice.number} for {invoice.client}: {spoken_money(invoice.total, invoice.currency)}, "
            f"due {invoice.due}. Saved as {path.name} in Documents › Jarvis › Invoices.{missing}"
        )

    @tool(
        "email_invoice",
        "Put an invoice in a new Mail draft with the PDF attached, for the user to read over and "
        "send. It is never sent from here. number: e.g. INV-2026-004 (or just 4).",
        {
            "type": "object",
            "properties": {
                "number": {"type": "string"},
                "to": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["number"],
        },
    )
    async def email_invoice(args):
        invoice = store.find(str(args.get("number", "")))
        if invoice is None or not invoice.path or not Path(invoice.path).exists():
            return _text("I can't find that invoice's file.", error=True)
        to = str(args.get("to") or invoice.client_email or "").strip()
        if to and "@" not in to:
            return _text("The recipient needs to be an email address.", error=True)
        sender = prefs().invoice_from.strip().splitlines()
        name = sender[0] if sender else ""
        subject = f"Invoice {invoice.number}" + (f" from {name}" if name else "")
        pay = f" You can pay online here: {invoice.payment_link}" if invoice.payment_link else ""
        body = str(args.get("message") or "").strip() or (
            f"Hello,\n\nPlease find attached invoice {invoice.number} for "
            f"{money(invoice.total, invoice.currency)}, due {invoice.due}.{pay}\n\nThank you."
        )
        await applescript(DRAFT_SCRIPT, to, subject, body, invoice.path)
        return _text(f"The draft for {invoice.number} is open in Mail for you to check and send.")

    @tool("list_invoices", "The recent invoices: number, client, total, due date, paid or not.", {})
    async def list_invoices(_args):
        if not store.invoices:
            return _text("No invoices yet.")
        rows = [
            f"{i.number} · {i.client} · {money(i.total, i.currency)} · due {i.due} · {i.status}"
            for i in store.invoices[-20:][::-1]
        ]
        return _text("\n".join(rows))

    @tool(
        "mark_invoice_paid",
        "Mark an invoice as paid (or open again with paid: false).",
        {"number": str, "paid": bool},
    )
    async def mark_invoice_paid(args):
        invoice = store.find(str(args.get("number", "")))
        if invoice is None:
            return _text("I can't find that invoice.", error=True)
        was = invoice.status
        invoice.status = "paid" if args.get("paid", True) is not False else "open"
        try:
            store.save()
        except OSError as exc:  # what's shown stays what's saved
            invoice.status = was
            return _text(f"I couldn't save that ({exc.strerror or exc}).", error=True)
        return _text(f"{invoice.number} is marked {invoice.status}.")

    tools = [create_invoice, email_invoice, list_invoices, mark_invoice_paid]
    if extras is None:
        return tools
    return tools + extra_tools(store, prefs, extras)


def extra_tools(store: InvoiceStore, prefs: Callable[[], Any], extras: InvoiceExtras) -> list:
    """Clients, recurring invoices, payment links and reminders."""

    def zh() -> bool:
        from . import lang

        return lang.is_zh(extras.language())

    def said(value: float, currency: str) -> str:
        """An amount as a card says it: "2,000 dollars"; in Chinese its figures ($2,000.00),
        which Chinese speech reads as 两千美元."""
        return money(value, currency) if zh() else spoken_money(value, currency)

    def _text(text: str, error: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
        if error:
            out["is_error"] = True
        return out

    items_schema = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "quantity": {"type": "number"},
                "unit_price": {"type": "number"},
            },
            "required": ["description", "unit_price"],
        },
    }

    @tool(
        "save_client",
        "Add a client to the user's client list, or update one: name, and any of email, "
        "address, currency (a code like USD) and notes. Invoices for them then fill these in.",
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "email": {"type": "string"},
                "address": {"type": "string"},
                "currency": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["name"],
        },
    )
    async def save_client(args):
        name = _plain(args.get("name"), 120)
        shown = "\n".join(
            f"{label}: {_plain(args.get(key), 300)}"
            for key, label in (("email", "Email"), ("address", "Address"), ("currency", "Currency"))
            if _plain(args.get(key), 300)
        )
        # Where the client's invoices and reminders will go: after something someone else
        # wrote was read, an address the owner's words didn't give goes on the card.
        email = _plain(args.get("email"), 300)
        asked = extras.asked("save_client") and (not email or extras.named(email))
        if not asked and not await extras.ask(
            f"Save {name} to your clients?",
            shown,
            f"Save {name} to your clients?",
            ("Save", "Not now"),
        ):
            return _text("The user said no. Nothing was saved.", error=True)
        try:
            client, new = extras.clients.save_client(
                name,
                str(args.get("email") or ""),
                str(args.get("address") or ""),
                str(args.get("currency") or ""),
                str(args.get("notes") or ""),
            )
        except ValueError as exc:
            return _text(str(exc), error=True)
        except OSError as exc:
            return _text(f"I couldn't save the client list ({exc.strerror or exc}).", error=True)
        extras.changed()
        return _text(f"{'Added' if new else 'Updated'} {client.name} in your clients.")

    @tool("list_clients", "The user's clients: names, emails and addresses.", {})
    async def list_clients(_args):
        clients = extras.clients.public()
        if not clients:
            return _text("No clients saved yet.")
        return _text(
            "\n".join(
                " · ".join(x for x in (c["name"], c["email"], c["address"], c["currency"]) if x)
                for c in clients[:60]
            )
        )

    @tool("remove_client", "Take a client off the user's client list, by name.", {"name": str})
    async def remove_client(args):
        found = extras.clients.find(str(args.get("name") or ""))
        if found is None:
            return _text("There's no client by that name.", error=True)
        if not extras.asked("remove_client") and not await extras.ask(
            f"Remove {found.name} from your clients?",
            "Their invoices stay as they are.",
            f"Remove {found.name} from your clients?",
            ("Remove", "Keep"),
        ):
            return _text("The user said no. Nothing changed.", error=True)
        try:
            extras.clients.remove(found.id)
        except OSError as exc:
            return _text(f"I couldn't save the client list ({exc.strerror or exc}).", error=True)
        extras.changed()
        return _text(f"Removed {found.name} from your clients.")

    @tool(
        "create_recurring_invoice",
        "Invoice a client on a schedule: each time, the next number and the PDF, and (email: "
        "true) a card to email it to them. every: weekly, monthly, quarterly or yearly. start: "
        "the first one's day, YYYY-MM-DD (it keeps that day of the month). items as for "
        "create_invoice. The user sees the schedule and says yes first.",
        {
            "type": "object",
            "properties": {
                "client": {"type": "string"},
                "items": items_schema,
                "every": {"type": "string", "enum": list(EVERY)},
                "start": {"type": "string"},
                "currency": {"type": "string"},
                "due_days": {"type": "integer"},
                "tax_percent": {"type": "number"},
                "notes": {"type": "string"},
                "email": {"type": "boolean"},
            },
            "required": ["client", "items", "every", "start"],
        },
    )
    async def create_recurring_invoice(args):
        saved = extras.clients.find(str(args.get("client") or ""))
        try:
            schedule = extras.recurring.add(
                saved.name if saved else str(args.get("client") or ""),
                args.get("items"),
                str(args.get("every") or ""),
                str(args.get("start") or ""),
                currency=str(args.get("currency") or (saved.currency if saved else "") or "USD"),
                due_days=args.get("due_days", 30),
                tax_percent=args.get("tax_percent") or 0,
                notes=str(args.get("notes") or ""),
                email=bool(args.get("email")),
                today=extras.today(),
            )
        except (ValueError, TypeError) as exc:
            return _text(str(exc), error=True)
        if schedule.email and not (saved and saved.email):
            return _text(
                f"To email each one I need {schedule.client}'s address: save_client with it "
                "first, or set it up without email.",
                error=True,
            )
        total = money(schedule_total(schedule), schedule.currency)
        when = describe_schedule(schedule)
        lines = "\n".join(
            f"{x['description']}: {x['quantity']:g} × {money(x['unit_price'], schedule.currency)}"
            for x in schedule.lines
        )
        emailed = (
            f"\n\nEach one is offered to {saved.email} on a Send card first."
            if schedule.email
            else ""
        )
        spoken_when = describe_schedule(schedule, "zh" if zh() else "en")
        if not await extras.ask(
            f"Set up a recurring invoice for {schedule.client}?",
            f"{total} {when}\n{lines}\nDue {schedule.due_days} days after each.{emailed}",
            f"Set up a recurring invoice for {schedule.client}: "
            f"{said(schedule_total(schedule), schedule.currency)}, {spoken_when}?",
            ("Set it up", "Not now"),
        ):
            return _text("The user said no. Nothing was set up.", error=True)
        try:
            extras.recurring.keep(schedule)
        except OSError as exc:
            return _text(f"I couldn't save it ({exc.strerror or exc}).", error=True)
        extras.changed()
        return _text(f"Set up: {schedule.client}, {total}, {when}.")

    @tool("list_recurring_invoices", "The user's recurring invoices and when each is next.", {})
    async def list_recurring_invoices(_args):
        items = extras.recurring.public()
        if not items:
            return _text("No recurring invoices.")
        return _text(
            "\n".join(
                f"[{x['id']}] {x['client']} · {money(x['total'], x['currency'])} · {x['when']}"
                for x in items
            )
        )

    @tool(
        "stop_recurring_invoice",
        "Stop a recurring invoice, by its client's name or its id. Invoices already issued stay.",
        {"invoice": str},
    )
    async def stop_recurring_invoice(args):
        found = extras.recurring.find(str(args.get("invoice") or ""))
        if found is None:
            return _text("There's no recurring invoice like that.", error=True)
        if not extras.asked("stop_recurring") and not await extras.ask(
            f"Stop the recurring invoice for {found.client}?",
            f"{money(schedule_total(found), found.currency)} {describe_schedule(found)}.\n"
            "Invoices already issued stay as they are.",
            f"Stop the recurring invoice for {found.client}?",
            ("Stop it", "Keep it"),
        ):
            return _text("The user said no. It carries on.", error=True)
        try:
            extras.recurring.stop(found.id)
        except OSError as exc:
            return _text(f"I couldn't save that ({exc.strerror or exc}).", error=True)
        extras.changed()
        return _text(f"Stopped the recurring invoice for {found.client}.")

    @tool(
        "invoice_payment_link",
        "A Stripe payment link for an invoice, through the user's Stripe connector (Tools & "
        "Accounts): anyone with the link can pay the invoice's total. The user says yes "
        "first. It's kept with the invoice, and email_invoice and reminders include it.",
        {"number": str},
    )
    async def invoice_payment_link(args):
        invoice = store.find(str(args.get("number", "")))
        if invoice is None:
            return _text("I can't find that invoice.", error=True)
        if invoice.payment_link:
            return _text(f"{invoice.number} already has a payment link: {invoice.payment_link}")
        why = extras.stripe_ready()
        if why:
            return _text(f"No payment link: {why} The invoice itself is ready.", error=True)
        total = money(invoice.total, invoice.currency)
        if not await extras.ask(
            f"Create a Stripe payment link for {invoice.number} ({invoice.client}, {total})?",
            "Stripe gets the invoice number, the client's name and the amount. Anyone with "
            f"the link can pay {total} into your Stripe account.",
            f"Create a Stripe payment link for {invoice.number}, "
            f"{said(invoice.total, invoice.currency)}?",
            ("Create link", "Not now"),
        ):
            return _text("The user said no. No link was made.", error=True)
        try:
            url = await extras.payment_link(invoice)
        except ValueError as exc:
            return _text(f"Stripe didn't make the link: {exc}", error=True)
        invoice.payment_link = url
        try:
            store.save()
        except OSError as exc:
            return _text(f"The link is {url}, but I couldn't save it ({exc.strerror or exc}).")
        extras.changed()
        return _text(f"Payment link for {invoice.number}: {url}")

    @tool(
        "overdue_invoices",
        "The user's open invoices past their due date: how late, the client's email, and when "
        "a reminder last went.",
        {},
    )
    async def overdue_invoices(_args):
        today = extras.today()
        late = overdue(store, today)
        if not late:
            return _text("No invoices are overdue.")
        rows = []
        for i in late:
            days = (today - date.fromisoformat(i.due)).days
            last = f", reminded {i.reminded[-1]}" if i.reminded else ""
            to = i.client_email or "no email on it"
            rows.append(
                f"{i.number} · {i.client} · {money(i.total, i.currency)} · {days} days late · "
                f"{to}{last}"
            )
        return _text("\n".join(rows))

    @tool(
        "send_invoice_reminder",
        "Email a client a polite reminder about an overdue invoice, with the invoice attached "
        "again (and its payment link). At most one a week per invoice. The user sees and "
        "hears exactly what goes, and says yes first.",
        {"number": str},
    )
    async def send_invoice_reminder(args):
        invoice = store.find(str(args.get("number", "")))
        if invoice is None:
            return _text("I can't find that invoice.", error=True)
        today = extras.today()
        if invoice.status != "open":
            return _text(f"{invoice.number} is paid.", error=True)
        if date.fromisoformat(invoice.due) >= today:
            return _text(f"{invoice.number} isn't overdue: it's due {invoice.due}.", error=True)
        if not invoice.client_email:
            return _text(
                f"{invoice.number} has no email for {invoice.client}: save_client with it, "
                "then try again.",
                error=True,
            )
        if invoice.reminded:
            last = date.fromisoformat(invoice.reminded[-1][:10])
            if (today - last).days < REMIND_EVERY_DAYS:
                return _text(
                    f"{invoice.client} was reminded about {invoice.number} on {last}; the "
                    "next reminder can go a week after that.",
                    error=True,
                )
        path = Path(invoice.path) if invoice.path else None
        if path is None or not path.is_file():
            return _text(f"I can't find {invoice.number}'s file to attach.", error=True)
        subject, body = reminder_email(invoice, prefs().invoice_from, today)
        size = path.stat().st_size
        detail = (
            f"To {invoice.client} <{invoice.client_email}>\nSubject: {subject}\n"
            f"Attached: {path.name} ({max(1, size // 1000)} KB)\n\n{body}"
        )
        if not await extras.ask(
            f"Send {invoice.client} a reminder about {invoice.number}?",
            detail,
            f"Here's a payment reminder to {invoice.client} for {invoice.number}, "
            f"{said(invoice.total, invoice.currency)}. Do you want it sent?",
            ("Send", "Don't send"),
        ):
            return _text("The user said no. It wasn't sent.", error=True)
        try:
            await extras.send(invoice.client_email, subject, body, str(path))
        except Exception as exc:
            return _text(f"Mail couldn't send it: {exc}", error=True)
        invoice.reminded = [*invoice.reminded, today.isoformat()][-20:]
        try:
            store.save()
        except OSError:
            pass  # sent: the next reminder asks again, and the card shows the last one's date
        extras.changed()
        return _text(f"Reminded {invoice.client} about {invoice.number}.")

    return [
        save_client,
        list_clients,
        remove_client,
        create_recurring_invoice,
        list_recurring_invoices,
        stop_recurring_invoice,
        invoice_payment_link,
        overdue_invoices,
        send_invoice_reminder,
    ]


def build_server(
    store: InvoiceStore,
    pdf: Pdf,
    prefs: Callable[[], Any],
    applescript: Script,
    extras: InvoiceExtras | None = None,
):
    return create_sdk_mcp_server(
        name=SERVER_NAME,
        version="0.1.0",
        tools=build_tools(store, pdf, prefs, applescript, extras),
    )


PROMPT = (
    "\n- Invoices: create_invoice makes a numbered PDF invoice from what the user says "
    "(client, lines with quantity and price, terms); email_invoice puts it in a Mail draft with "
    "the PDF attached for them to send; list_invoices and mark_invoice_paid keep track. Read "
    "back the total when you make one."
)
