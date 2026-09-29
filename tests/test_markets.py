from datetime import datetime
from zoneinfo import ZoneInfo

from jarvis import markets

QUOTES = {
    "FormattedQuoteResult": {
        "FormattedQuote": [
            {
                "symbol": ".SPX",
                "code": 0,
                "shortName": "S&P 500",
                "last": "7,683.69",
                "change": "-59.72",
                "change_pct": "-0.77%",
                "curmktstatus": "REG_MKT",
            },
            {
                "symbol": "US10Y",
                "code": 0,
                "shortName": "US 10-YR",
                "last": "5.234%",
                "change": "-0.008",
                "change_pct": "-0.15%",
            },
            {
                "symbol": "NVDA",
                "code": 0,
                "shortName": "NVIDIA",
                "last": "228.86",
                "change": "+3.79",
                "change_pct": "+1.68%",
                "ExtendedMktQuote": {"type": "PRE_MKT", "last": "229.42", "change_pct": "+0.24%"},
            },
            {
                "symbol": "META",
                "code": 0,
                "last": "715.62",
                "change": "-36.04",
                "change_pct": "-4.79%",
            },
            {"symbol": "FAKE", "code": 1},
        ]
    }
}


def test_parse_quotes():
    q = markets.parse_quotes(QUOTES)
    assert set(q) == {".SPX", "US10Y", "NVDA", "META"}  # unknown symbols dropped
    assert q[".SPX"]["last"] == 7683.69 and q[".SPX"]["pct"] == -0.77
    assert q["US10Y"]["yield"] is True and q["US10Y"]["last"] == 5.234
    assert q["NVDA"]["after"] == {"last": 229.42, "pct": 0.24, "kind": "pre"}


def test_chart_keeps_the_last_session_thinned():
    bars = [{"tradeTime": "20260927160000", "close": "1"}] + [
        {"tradeTime": f"20260928{h:02d}{m:02d}00", "close": str(100 + i)}
        for i, (h, m) in enumerate((h, m) for h in range(9, 16) for m in range(0, 60, 1))
    ]
    closes = markets.parse_chart({"barData": {"priceBars": bars}})
    assert closes[0] == 100 and closes[-1] == 100 + 419 and len(closes) <= markets.SPARK_POINTS + 1


def test_market_hours_in_new_york():
    ny = ZoneInfo("America/New_York")
    assert markets.market_status(datetime(2026, 9, 28, 10, 0, tzinfo=ny)) == "open"
    assert markets.market_status(datetime(2026, 9, 28, 8, 0, tzinfo=ny)) == "pre"
    assert markets.market_status(datetime(2026, 9, 28, 17, 0, tzinfo=ny)) == "after"
    assert markets.market_status(datetime(2026, 9, 28, 23, 0, tzinfo=ny)) == "closed"
    assert markets.market_status(datetime(2026, 9, 27, 12, 0, tzinfo=ny)) == "closed"  # Sunday


def test_headline_and_speech():
    q = markets.parse_quotes(QUOTES)
    spx = {**q[".SPX"], "name": "S&P 500"}
    line = markets.headline([spx], [q["NVDA"], q["META"]], "open")
    assert (
        line
        == "Stocks are down: S&P 500 −0.77%. Leading your list: NVDA +1.68%. Lagging: META −4.79%."
    )
    said = markets.spoken(
        {"headline": line, "indices": [spx], "macro": [{**q["US10Y"], "name": "10-yr"}]}
    )
    assert (
        "down 0.77 percent" in said
        and "up 1.68 percent" in said
        and "ten-year yield is 5.23 percent" in said
    )


def test_watchlist_cleaning():
    assert markets.clean_watchlist("aapl, $nvda msft AAPL bad!ticker") == ["AAPL", "NVDA", "MSFT"]
