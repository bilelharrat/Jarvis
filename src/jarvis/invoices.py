"""Invoices by voice: "Jarvis, invoice Acme for ten hours of consulting at 150 an hour,
due in 30 days."

Each invoice gets the next number (INV-2026-001, …), is laid out as a clean one-page PDF
in ~/Documents/Jarvis/Invoices (drawn by the app window's own renderer; an HTML copy
when there's no window), and can go into a Mail draft with the PDF attached for the
user to read over and send. Nothing is ever sent from here. The business details at
the top come from Settings › Invoices, which the user fills in themselves.
"""

from __future__ import annotations

import contextlib
import errno
import html
import logging
import math
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, fields
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
_TEXT_FIELDS = ("number", "issued", "due", "client", "currency", "notes", "status", "path")
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


def build_tools(store: InvoiceStore, pdf: Pdf, prefs: Callable[[], Any], applescript: Script):
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
        try:
            invoice = store.create(
                args.get("client", ""),
                args.get("items"),
                currency=args.get("currency") or "USD",
                due_days=args.get("due_days", 30),
                tax_percent=args.get("tax_percent") or 0,
                notes=args.get("notes", ""),
                client_email=args.get("client_email", ""),
                client_address=args.get("client_address", ""),
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
        body = str(args.get("message") or "").strip() or (
            f"Hello,\n\nPlease find attached invoice {invoice.number} for "
            f"{money(invoice.total, invoice.currency)}, due {invoice.due}.\n\nThank you."
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

    return [create_invoice, email_invoice, list_invoices, mark_invoice_paid]


def build_server(store: InvoiceStore, pdf: Pdf, prefs: Callable[[], Any], applescript: Script):
    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.1.0", tools=build_tools(store, pdf, prefs, applescript)
    )


PROMPT = (
    "\n- Invoices: create_invoice makes a numbered PDF invoice from what the user says "
    "(client, lines with quantity and price, terms); email_invoice puts it in a Mail draft with "
    "the PDF attached for them to send; list_invoices and mark_invoice_paid keep track. Read "
    "back the total when you make one."
)
