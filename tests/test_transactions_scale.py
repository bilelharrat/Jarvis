"""The purchase checks read third-party checkout pages: a hostile or just number-dense
page must never freeze the backend. The page text is capped at 14,000 characters
(app/page-preload.js); these run at four times that."""

import time

import pytest

from jarvis import transactions as t

PAGE_CAP = 14_000


@pytest.mark.parametrize(
    "line",
    [
        " ".join(["1"] * (PAGE_CAP * 2)),  # bare numbers: took 9 s at the cap
        " ".join(["111"] * PAGE_CAP),  # spaced groups and no currency: took 5.6 s
        " ".join(["111 111 €"] * (PAGE_CAP // 2)),
        "1" + ",11" * (PAGE_CAP * 2),
        " ".join(["Total 1", "12,34", "7:30", "15%"] * (PAGE_CAP // 4)),
    ],
    ids=["bare-numbers", "spaced-groups", "spaced-euros", "indian-grouping", "mixed"],
)
def test_a_number_dense_page_is_read_in_linear_time(line):
    page = {"text": line[: PAGE_CAP * 4]}
    started = time.perf_counter()
    t.amount_on_page(99_999.99, "USD", page)
    t.page_currencies(page)
    t.charge_currency(99_999.99, "USD", page)
    assert time.perf_counter() - started < 1.5  # about 0.15 s here; seconds to minutes before


def test_spaced_amounts_still_read_as_before():
    assert [m.value for m in t.money_in("Total 1 234,50 €")] == [1234.5]
    assert [m.value for m in t.money_in("12 345 678 €")] == [12_345_678]
    assert [m.value for m in t.money_in("999 999 999 999 kr")] == [999_999_999_999]
    assert t.amount_on_page(1234.5, "EUR", {"text": "Gesamt\n1 234,50 €"})
    assert not t.amount_on_page(1234.5, "USD", {"text": "Gesamt\n1 234,50 €"})


def test_bare_numbers_count_only_on_a_price_line():
    assert t.amount_on_page(56, "USD", {"text": "Total: 56"})
    assert not t.amount_on_page(56, "USD", {"text": "Seats left: 56"})
    assert t.amount_on_page(56.25, "USD", {"text": "Seats left: 56.25"})  # cents count
