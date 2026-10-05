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

    def cpu() -> float:
        """This thread's CPU time to read the page: a busy Mac's other work doesn't count
        (it slowed the wall clock tenfold)."""
        started = time.thread_time()
        t.amount_on_page(99_999.99, "USD", page)
        t.page_currencies(page)
        t.charge_currency(99_999.99, "USD", page)
        return time.thread_time() - started

    # Under a second here (0.2 to 0.7 s); seconds to minutes before. Up to three tries: a
    # busy Mac moves a thread between fast and slow cores.
    spent = [cpu()]
    while spent[-1] >= 1.5 and len(spent) < 3:
        spent.append(cpu())
    assert min(spent) < 1.5, spent


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


def _shop_page(lines: int = 300) -> dict:
    words = "the quick brown fox order cart account help news review delivery size".split()
    text = [" ".join(words[(i + j) % len(words)] for j in range(3 + i % 11)) for i in range(lines)]
    for i in range(0, lines, 7):
        text[i] += f" ${i}.99"
    return {
        "url": "https://shop.example/products/kettle",
        "title": "Kettle",
        "text": "\n".join(text)[:PAGE_CAP],
        "actions": [f"Option {i}" for i in range(80)] + ["Add to cart", "Buy now"],
        "links": [{"text": f"Link number {i} to somewhere else"} for i in range(200)],
    }


def test_a_page_s_lines_are_read_for_amounts_once_a_look(monkeypatch):
    """Totals, currencies and amounts all come from one read of each line (they each read
    every line again before, three and four times a click)."""
    page = _shop_page()
    read = []
    real = t.money_in
    monkeypatch.setattr(t, "money_in", lambda line: read.append(line) or real(line))
    view = t.PageView(page)
    assert view.context and "USD" in view.currencies and view.amounts
    assert not view.money and view.totals == []
    assert len(read) == len(view.lines)


def test_a_click_on_a_full_page_is_weighed_quickly():
    page = _shop_page()
    guard = t.TransactionGuard()
    started = time.perf_counter()
    for _ in range(5):
        assert guard.allow_click(page["url"], "Add to cart", page=page).allowed
        assert guard.allow_submit(page).allowed is False  # "Buy now" pays
    assert time.perf_counter() - started < 1.5  # about 0.04 s here; 0.15 s before


def test_a_button_s_kind_is_kept_for_the_next_read_but_never_long_words():
    t._commit_kind.cache_clear()
    assert t.is_commit_button("Place order") == "purchase"
    assert t.is_commit_button("Place order") == "purchase"
    assert t._commit_kind.cache_info().hits == 1
    long = "Place order " + "x" * t.KIND_KEPT
    assert t.is_commit_button(long) is None
    assert t._commit_kind.cache_info().currsize == 1  # a sentence isn't kept


def test_labels_are_cut_as_the_window_cuts_them():
    assert t._as_label("a" * 48) == "a" * 48
    assert t._as_label("a" * 100) == "a" * 47 + "…"
    assert t._as_label("\U0001f600" * 30) == "\U0001f600" * 23 + "…"  # two units each
    assert t._as_label("a" * 46 + "\U0001f600" + "b" * 10) == "a" * 46 + "…"
    assert t._as_label("a" * 40 + "\U0001f600" * 5) == "a" * 40 + "\U0001f600" * 3 + "…"
    assert t._units("a\U0001f600\ud800") == 4
