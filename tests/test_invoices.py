"""Invoices by voice: numbering, arithmetic, the page, the file, the Mail draft."""

from datetime import date
from types import SimpleNamespace

import pytest

from jarvis.invoices import InvoiceStore, build_tools, clean_lines, money, render_html


@pytest.fixture
def store(tmp_path):
    return InvoiceStore(tmp_path / "invoices.json", tmp_path / "Invoices")


def test_numbers_run_per_year_and_survive_a_restart(store, tmp_path):
    a = store.create(
        "Acme",
        [{"description": "Consulting", "quantity": 10, "unit_price": 150}],
        today=date(2026, 9, 29),
    )
    b = store.create(
        "Globex", [{"description": "Audit", "unit_price": 900}], today=date(2026, 10, 2)
    )
    assert (a.number, b.number) == ("INV-2026-001", "INV-2026-002")
    again = InvoiceStore(tmp_path / "invoices.json", tmp_path / "Invoices")
    assert (
        again.create(
            "Acme", [{"description": "x", "unit_price": 1}], today=date(2026, 12, 1)
        ).number
        == "INV-2026-003"
    )
    assert (
        again.create("Acme", [{"description": "x", "unit_price": 1}], today=date(2027, 1, 3)).number
        == "INV-2027-001"
    )
    assert again.find("2").client == "Globex" and again.find("INV-2026-001").client == "Acme"


def test_totals_tax_and_due_date(store):
    inv = store.create(
        "Acme",
        [
            {"description": "Design", "quantity": 2.5, "unit_price": "1,200"},
            {"description": "Hosting", "unit_price": 49.99},
        ],
        tax_percent=8.25,
        due_days=14,
        today=date(2026, 9, 29),
    )
    assert inv.subtotal == 3049.99 and inv.tax == 251.62 and inv.total == 3301.61
    assert inv.due == "2026-10-13"
    assert money(inv.total, "USD") == "$3,301.61" and money(1000, "JPY") == "¥1,000"


@pytest.mark.parametrize(
    "items",
    [
        [],
        None,
        [{"description": "", "unit_price": 5}],
        [{"description": "x", "quantity": 0, "unit_price": 5}],
        [{"description": "x", "unit_price": "lots"}],
        [{"description": "x", "unit_price": -3}],
        [{"description": "x", "unit_price": "nan"}],
        [{"description": "x", "quantity": "inf", "unit_price": 5}],
        [{"description": "x", "unit_price": "1e309"}],
    ],
)
def test_lines_that_do_not_add_up_are_refused(items):
    with pytest.raises(ValueError):
        clean_lines(items)


def test_the_page_escapes_what_it_is_given(store):
    inv = store.create(
        "<script>alert(1)</script> Co", [{"description": "<b>x</b>", "unit_price": 10}]
    )
    page = render_html(inv, "BSH Ventures\n2150 Shattuck", "Pay at pay.example.com")
    assert "<script>alert" not in page and "&lt;script&gt;" in page and "&lt;b&gt;x" in page
    assert "BSH Ventures" in page and "Pay at pay.example.com" in page and "$10.00" in page


def _tools(store, pdf_bytes=b"%PDF-1.4 test", sender="BSH Ventures\nBerkeley"):
    scripts = []

    async def pdf(_page):
        return pdf_bytes

    async def applescript(script, *args):
        scripts.append(args)
        return ""

    prefs = SimpleNamespace(invoice_from=sender, invoice_payment="")
    tools = {t.name: t.handler for t in build_tools(store, pdf, lambda: prefs, applescript)}
    return tools, scripts


async def test_create_invoice_files_a_pdf_and_reads_back_the_total(store):
    tools, _ = _tools(store)
    out = await tools["create_invoice"](
        {
            "client": "Acme",
            "items": [{"description": "Consulting", "quantity": 10, "unit_price": 150}],
        }
    )
    text = out["content"][0]["text"]
    assert "INV-" in text and "1,500 dollars" in text and not out.get("is_error")
    files = list(store.folder.iterdir())
    assert (
        len(files) == 1 and files[0].suffix == ".pdf" and files[0].read_bytes().startswith(b"%PDF")
    )


async def test_without_the_app_window_it_saves_html(store):
    tools, _ = _tools(store, pdf_bytes=None, sender="")
    out = await tools["create_invoice"](
        {"client": "Acme", "items": [{"description": "x", "unit_price": 5}]}
    )
    assert "Settings › Invoices" in out["content"][0]["text"]
    assert next(store.folder.iterdir()).suffix == ".html"


async def test_email_invoice_only_opens_a_draft_with_the_pdf(store):
    tools, scripts = _tools(store)
    await tools["create_invoice"](
        {
            "client": "Acme",
            "client_email": "ap@acme.com",
            "items": [{"description": "x", "unit_price": 5}],
        }
    )
    number = store.invoices[-1].number
    out = await tools["email_invoice"]({"number": number})
    to, subject, body, path = scripts[-1]
    assert to == "ap@acme.com" and subject == f"Invoice {number} from BSH Ventures"
    assert path.endswith(".pdf") and "draft" in out["content"][0]["text"]
    bad = await tools["email_invoice"]({"number": number, "to": "not an address"})
    assert bad.get("is_error")


async def test_list_and_mark_paid(store):
    tools, _ = _tools(store)
    assert "No invoices" in (await tools["list_invoices"]({}))["content"][0]["text"]
    await tools["create_invoice"](
        {"client": "Acme", "items": [{"description": "x", "unit_price": 5}]}
    )
    await tools["mark_invoice_paid"]({"number": "1", "paid": True})
    assert "paid" in (await tools["list_invoices"]({}))["content"][0]["text"]
