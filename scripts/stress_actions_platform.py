"""Stress what JARVIS does for the owner (email, orders, files, price alerts, texts) and the
platform under it (JARVIS as an MCP server, the relay to models on this Mac, widgets), with
fakes only: a synthetic Mail index, a temp home folder and a fake Trash, a fake clipboard,
CNBC's quotes made up, a fake model server behind the relay, the MCP endpoint on a Unix
socket of its own in a temp folder. Nothing is sent, moved or changed on this Mac, no model
is called and nothing leaves it.

    uv run python scripts/stress_actions_platform.py            (about a minute)
    uv run python scripts/stress_actions_platform.py --quick    (smaller numbers)

Each part prints what it did, how fast, and what held; the script exits 1 when something
that should hold didn't.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import resource
import shutil
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import httpx  # noqa: E402

from jarvis import file_actions, mailkit, sms, widgets  # noqa: E402
from jarvis import stock_alerts as alerts_module  # noqa: E402
from jarvis.features import orders as orders_feature  # noqa: E402
from jarvis.mcp_endpoint import Endpoint  # noqa: E402
from jarvis.openai_relay import OpenAIRelay  # noqa: E402

QUICK = "--quick" in sys.argv
FAILED: list[str] = []
RNG = random.Random(20260930)


def held(ok: bool, what: str) -> None:
    print(f"    {'held' if ok else 'BROKE'}: {what}")
    if not ok:
        FAILED.append(what)


def ms(seconds: float) -> str:
    return f"{seconds * 1000:.1f} ms"


def percentiles(samples: list[float]) -> str:
    ordered = sorted(samples)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    return f"median {ms(statistics.median(ordered))}, p95 {ms(p95)}, max {ms(ordered[-1])}"


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)  # bytes on macOS


# ── a synthetic Mail index ──

SCHEMA = """
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, sender INTEGER, subject INTEGER,
    summary INTEGER, date_received INTEGER, mailbox INTEGER, deleted INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, subject_prefix TEXT,
    global_message_id INTEGER);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY, summary TEXT);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER, type INTEGER,
    address INTEGER, position INTEGER);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER,
    message_id_header TEXT);
INSERT INTO mailboxes VALUES (1, 'imap://UUID-1/INBOX'), (2, 'imap://UUID-1/Sent%20Messages'),
    (3, 'imap://UUID-1/Deleted%20Messages'), (4, 'imap://UUID-1/Archive');
"""


def make_index(path: Path, emails: list[tuple[str, str, str, str, datetime]]) -> None:
    """emails: (address, name, subject, summary, when), written in one transaction."""
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    cur = db.cursor()
    for n, (address, name, subject, summary, when) in enumerate(emails, 1):
        cur.execute("INSERT INTO addresses (address, comment) VALUES (?, ?)", (address, name))
        sender = cur.lastrowid
        cur.execute("INSERT INTO subjects (subject) VALUES (?)", (subject,))
        subject_id = cur.lastrowid
        cur.execute("INSERT INTO summaries (summary) VALUES (?)", (summary,))
        summary_id = cur.lastrowid
        cur.execute(
            "INSERT INTO message_global_data (message_id, message_id_header) VALUES (?, ?)",
            (n, f"<m{n}@mail.test>"),
        )
        cur.execute(
            """INSERT INTO messages (sender, subject, summary, date_received, mailbox, read,
               subject_prefix, global_message_id) VALUES (?,?,?,?,1,1,'',?)""",
            (sender, subject_id, summary_id, int(when.timestamp()), cur.lastrowid),
        )
    db.commit()
    db.close()


def add_email(path: Path, address: str, name: str, subject: str, summary: str = "") -> None:
    make_more = sqlite3.connect(path)
    cur = make_more.cursor()
    cur.execute("INSERT INTO addresses (address, comment) VALUES (?, ?)", (address, name))
    sender = cur.lastrowid
    cur.execute("INSERT INTO subjects (subject) VALUES (?)", (subject,))
    subject_id = cur.lastrowid
    cur.execute("INSERT INTO summaries (summary) VALUES (?)", (summary,))
    cur.execute(
        """INSERT INTO messages (sender, subject, summary, date_received, mailbox, read,
           subject_prefix) VALUES (?,?,?,?,1,0,'')""",
        (sender, subject_id, cur.lastrowid, int(datetime.now().timestamp())),
    )
    make_more.commit()
    make_more.close()


class Prefs:
    def __init__(self, **features):
        self.features = features

    def feature(self, key):
        return self.features.get(key)


def fake_hub(folder: Path, **features) -> SimpleNamespace:
    heard: list = []

    async def allow(*_a, **_k):
        return "allow"

    return SimpleNamespace(
        prefs=Prefs(**features),
        feature_path=lambda name: folder / name,
        notify=lambda alert, **_k: heard.append(alert),
        emit=lambda *_a, **_k: None,
        language="en",
        heard=heard,
        _say=lambda _text: None,
        request_approval=allow,
        poll=False,
    )


# ── 1. the inbox ──


def stress_inbox(tmp: Path) -> None:
    count = 5_000 if QUICK else 30_000
    print(f"\n[inbox] a Mail index of {count:,} emails: search, headlines, what Claude reads")
    people = [(f"person{i}@example.com", f"Person {i}") for i in range(400)]
    now = datetime.now()
    emails = [
        (
            *RNG.choice(people),
            f"{RNG.choice(['Invoice', 'Lunch?', 'Q3 plan', 'Re: the deck', '100% done'])} {n}",
            "x" * RNG.randint(20, 400),
            now - timedelta(minutes=n * 7),
        )
        for n in range(count)
    ]
    path = tmp / "Envelope Index"
    started = time.perf_counter()
    make_index(path, emails)
    print(f"    built in {time.perf_counter() - started:.1f} s")
    times, sizes = [], []
    for n in range(40 if QUICK else 120):
        who = people[n % len(people)]
        t0 = time.perf_counter()
        found = mailkit.search(path, addresses=[who[0]], limit=20)
        found += mailkit.search(path, subject="invoice", limit=20)
        found += mailkit.search(path, name=who[1], limit=20)
        text = mailkit.describe(found)
        times.append(time.perf_counter() - t0)
        sizes.append(len(text))
    print(f"    3 searches and a description: {percentiles(times)}; text {max(sizes):,} chars max")
    ids = [f"<m{n}@mail.test>" for n in RNG.sample(range(1, count), 50)]
    t0 = time.perf_counter()
    shown = mailkit.headlines(path, ids)
    print(f"    50 headlines for a tidy-up card: {ms(time.perf_counter() - t0)}")
    held(max(sizes) < 40_000, "what one search hands Claude stays bounded (limit 20 each)")
    held(len(shown) == 50, "every id found for the tidy-up card")
    held(statistics.median(times) < 0.5, "a search answers in well under a second")


# ── 2. orders ──


def stress_orders(tmp: Path) -> None:
    orders_count = 300 if QUICK else 1_000
    noise = 600 if QUICK else 2_000
    print(f"\n[orders] {orders_count:,} order emails among {noise:,} others, then 100 new ones")
    merchants = [f"Shop{m}" for m in range(50)]
    now = datetime.now()
    emails = []
    for n in range(orders_count):
        merchant = RNG.choice(merchants)
        status = RNG.choice(["has shipped", "is out for delivery", "was delivered"])
        emails.append(
            (
                f"ship@{merchant.lower()}.com",
                merchant,
                f"Your {merchant} order #{100000 + n} {status}",
                "UPS 1Z999AA10123456784",
                now - timedelta(days=10, minutes=n),
            )
        )
    for n in range(noise):
        emails.append(("news@deals.com", "Deals", f"Weekly deals {n}", "", now - timedelta(days=9)))
    RNG.shuffle(emails)
    path = tmp / "orders-index"
    make_index(path, emails)
    folder = tmp / "orders-hub"
    folder.mkdir()
    hub = fake_hub(folder, orders_on=True)
    asked: list[str] = []

    async def model(prompt):  # never reached on a quiet read
        asked.append(prompt)
        return '{"kind": "none"}'

    desk = orders_feature.Orders(hub, mail_db=lambda: path, model=model)

    async def run() -> tuple[int, list[float]]:
        looks = []
        for _ in range((orders_count + noise) // orders_feature.PER_LOOK + 2):
            t0 = time.perf_counter()
            await desk.look()
            looks.append(time.perf_counter() - t0)
        return len(looks), looks

    looks, times = asyncio.run(run())
    public = desk.public()
    payload = len(json.dumps(public))
    print(
        f"    quiet first read: {looks} looks, {percentiles(times)} each; "
        f"{len(desk.book.orders)} orders kept, window payload {payload / 1024:.1f} KB"
    )
    held(hub.heard == [] and asked == [], "the whole backlog was read quietly, no model asked")
    held(len(desk.book.orders) <= 200, "the book keeps at most 200 orders")
    held(payload < 200_000, "what the window gets stays small")
    for n in range(100):
        add_email(path, "ship@shop7.com", "Shop7", f"Your Shop7 order #{900000 + n} has shipped")
    t0 = time.perf_counter()
    asyncio.run(desk.look())
    print(f"    100 new emails in one look: {ms(time.perf_counter() - t0)}")
    t0 = time.perf_counter()
    desk.book.save()
    saved = time.perf_counter() - t0
    size = (folder / "orders.json").stat().st_size
    t0 = time.perf_counter()
    again = orders_feature.orders.Book(folder / "orders.json")
    again.load()
    print(
        f"    orders.json {size / 1024:.1f} KB: saved in {ms(saved)}, read in {ms(time.perf_counter() - t0)}"
    )
    held(len(again.orders) == len(desk.book.orders), "what was saved reads back whole")


# ── 3. files with undo ──


def stress_files(tmp: Path) -> None:
    actions_count = 100
    print(f"\n[files] {actions_count} undoable moves, renames and trashes, then undo them all")
    home = tmp / "home"
    for folder in ("Desktop", "Documents", "Downloads", ".Trash", "Documents/Archive"):
        (home / folder).mkdir(parents=True)
    originals = {}
    for n in range(actions_count):
        path = home / "Desktop" / f"note {n}.txt"
        path.write_text(f"n{n}")
        originals[path] = f"n{n}"

    def trash(path: Path) -> Path:
        dest = home / ".Trash" / path.name
        k = 2
        while os.path.lexists(dest):
            dest = home / ".Trash" / f"{path.stem} {k}{path.suffix}"
            k += 1
        os.rename(path, dest)
        return dest

    board = {"text": "the owner's"}
    fa = file_actions.FileActions(
        tmp / "file_actions.json",
        home=home,
        trash=trash,
        clipboard=(lambda: board["text"], lambda text: board.update(text=text)),
    )
    times = []
    for n, path in enumerate(originals):
        t0 = time.perf_counter()
        kind = n % 3
        if kind == 0:
            fa.move(fa.plan_move([str(path)], str(home / "Documents")))
        elif kind == 1:
            src, dest = fa.plan_rename(str(path), f"renamed {n}")
            fa.rename(src, dest)
        else:
            fa.trash(fa.plan_trash([str(path)]))
        times.append(time.perf_counter() - t0)
    log_size = (tmp / "file_actions.json").stat().st_size
    print(
        f"    {actions_count} changes: {percentiles(times)} each; undo log {log_size / 1024:.1f} KB"
    )
    t0 = time.perf_counter()
    undone = 0
    while True:
        try:
            said = fa.undo()
        except file_actions.Refused:
            break
        undone += 1
        if "Not all of it" in said:
            FAILED.append(f"undo left something behind: {said}")
    print(f"    {undone} undone in {ms(time.perf_counter() - t0)}")
    back = all(p.exists() and p.read_text() == text for p, text in originals.items())
    held(undone == actions_count, "all 100 changes could be undone")
    held(back, "every file is back where it was, as it was")
    held(not any((home / ".Trash").iterdir()), "nothing left in the Trash")
    for n in range(file_actions.KEEP + 20):  # past the log's size: the oldest are let go
        path = home / "Desktop" / f"note {n}.txt"
        if not path.exists():
            path.write_text("x")
        fa.move(fa.plan_move([str(path)], str(home / "Documents" / "Archive")))
        fa.undo()
    held(len(fa.records) <= file_actions.KEEP, f"the undo log keeps at most {file_actions.KEEP}")
    refused = 0
    for raw in (
        "~/desktop",
        f"{home}/LIBRARY/x",
        f"{home}/.ssh/config",
        "/etc/hosts",
        f"{home}/../x",
    ):
        try:
            fa.check_item(raw.replace("~", str(home)))
        except file_actions.Refused:
            refused += 1
    held(refused == 5, "protected places refused, whatever their spelling")


# ── 4. price alerts ──


def stress_price_alerts(tmp: Path) -> None:
    checks = 2_000 if QUICK else 10_000
    print(
        f"\n[price alerts] a storm: 30 alerts and 20 watchlist tickers, {checks:,} checks over 10 days"
    )
    clock = {"at": datetime(2026, 10, 5, 6, 0)}  # a Monday morning
    store = alerts_module.AlertStore(tmp / "price_alerts.json", lambda: clock["at"])
    symbols = [f"T{n}" for n in range(20)]
    for n in range(30):
        symbol = symbols[n % 20]
        kind = ("above", "below", "move")[n % 3]
        store.add(symbol, kind, 5.0 if kind == "move" else 100.0 + (n % 7), last=100.0)
    prices = {s: 100.0 for s in symbols}
    fired: dict[str, int] = {}
    session_moves: dict[tuple[str, str], int] = {}
    times = []
    for step in range(checks):
        clock["at"] += timedelta(minutes=10 * 24 * 60 / checks)
        et_hour = (clock["at"].hour + 3) % 24  # this Mac on Pacific time: New York's hour
        weekday = clock["at"].weekday()
        status = "open" if weekday < 5 and 9 <= et_hour < 16 else "closed"
        quotes = {}
        for s in symbols:
            if status == "open":
                prices[s] *= 1 + RNG.gauss(0, 0.01)
            pct = (prices[s] / 100.0 - 1) * 100
            last = prices[s] if step % 97 else RNG.choice([0.0, float("nan")])  # bad quotes too
            quotes[s] = {"symbol": s, "last": last, "pct": pct, "status": status}
        t0 = time.perf_counter()
        out = store.check(quotes, symbols, 5.0)
        times.append(time.perf_counter() - t0)
        day = clock["at"].date().isoformat()
        fired[day] = fired.get(day, 0) + len(out)
        for key, _title, _text in out:
            if key.startswith("move:"):
                session = alerts_module.session_day(clock["at"])
                who = (key.split(":")[1], session)
                session_moves[who] = session_moves.get(who, 0) + 1
    print(f"    each check {percentiles(times)}; heads-ups a day: {dict(sorted(fired.items()))}")
    held(max(fired.values()) <= alerts_module.DAILY_CAP, "never more than 8 heads-ups a day")
    held(max(session_moves.values(), default=1) == 1, "a watchlist move is told once a session")

    lost = []

    def churn(n: int) -> None:
        for k in range(20):
            alert = store.add(f"C{n}", "above", 1000.0 + k, last=1.0)
            if k % 2:
                store.remove(alert.id)
            else:
                lost.append(alert.id)

    def checking() -> None:
        for _ in range(200):
            store.check({}, [], 0)

    for alert in list(store.alerts):
        store.remove(alert.id)
    threads = [threading.Thread(target=churn, args=(n,)) for n in range(4)]
    threads += [threading.Thread(target=checking) for _ in range(4)]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    kept = {a.id for a in alerts_module.AlertStore(tmp / "price_alerts.json").alerts}
    missing = [i for i in lost if i not in kept]
    print(f"    4 threads setting and removing while 4 check: {ms(time.perf_counter() - t0)}")
    held(not missing, f"no alert set while others checked was lost ({len(lost)} set)")


# ── 5. texts to the Jarvis number: guessing codes ──


def stress_codes() -> None:
    tries = 20_000
    print(f"\n[jarvis number] {tries:,} guessed codes against one open card, Unicode digits too")
    now = {"t": 0.0}
    codes = sms.Codes(clock=lambda: now["t"])
    card = codes.new("card", {"allow": "Send"})
    hits = paused = crashed = 0
    for n in range(tries):
        now["t"] += 1
        text = RNG.choice(
            [f"YES {n % 10000:04d}", f"好的 {n % 10000:04d}", "yes ٤٨٢١", "yes ４８２１"]
        )
        try:
            got = sms.answer(text)
            if got is None:
                continue
            result = codes.check(got[1])
        except Exception:  # noqa: BLE001 - what this stress is looking for
            crashed += 1
            continue
        if result is card:
            hits += 1
        elif result == "paused":
            paused += 1
    print(f"    right guesses {hits}, answers refused while paused {paused}")
    held(crashed == 0, "no text of any script stops the look")
    held(hits <= 1, "guessing never gets through (paused after 5 wrong an hour)")


# ── 6. JARVIS as an MCP server ──


def stress_mcp() -> None:
    calls = 400 if QUICK else 1_500
    print(f"\n[mcp] {calls:,} calls from 20 apps at once over the endpoint's Unix socket")
    folder = Path(tempfile.mkdtemp(prefix="jvmcp", dir="/tmp")) / "mcp"
    hub = fake_hub(folder.parent, mcp_ask=False)
    hub.kb = SimpleNamespace(
        search=lambda q, k=8, **_: [
            {"id": "n1", "title": "Lease", "source": "notes", "group": "", "excerpt": "May 1"}
        ],
        get=lambda _i: None,
    )
    hub.memory = SimpleNamespace(search=lambda _q: [SimpleNamespace(text="Ann is a co-founder.")])
    endpoint = Endpoint(hub, folder)

    async def run():
        await endpoint.start()
        try:
            token = (folder / "token").read_text().strip()
            transport = httpx.AsyncHTTPTransport(uds=str(folder / "sock"))
            async with httpx.AsyncClient(transport=transport, base_url="http://jarvis") as client:
                latencies, statuses = [], {}

                async def one(n: int) -> None:
                    t0 = time.perf_counter()
                    r = await client.post(
                        "/call",
                        json={
                            "tool": "recall" if n % 2 else "search_notes",
                            "arguments": {"query": "x"},
                        },
                        headers={
                            "Authorization": f"Bearer {token}",
                            "X-Jarvis-Session": f"app{n % 20:04d}xyz",
                            "X-Jarvis-Client": "claude-code",
                        },
                    )
                    latencies.append(time.perf_counter() - t0)
                    statuses[r.status_code] = statuses.get(r.status_code, 0) + 1

                t0 = time.perf_counter()
                for start in range(0, calls, 50):
                    await asyncio.gather(*(one(n) for n in range(start, min(calls, start + 50))))
                took = time.perf_counter() - t0
                wrong = [
                    (
                        await client.get("/tools", headers={"Authorization": "Bearer guess"})
                    ).status_code
                    for _ in range(8)
                ]
                return latencies, statuses, took, wrong
        finally:
            await endpoint.stop()

    latencies, statuses, took, wrong = asyncio.run(run())
    print(f"    {calls / took:.0f} calls/s; {percentiles(latencies)}; answers {statuses}")
    held(
        statuses.get(200, 0) == 120 and statuses.get(429, 0) == calls - 120,
        "120 calls a minute, the rest refused",
    )
    held(wrong[:5] == [401] * 5 and set(wrong[5:]) == {429}, "five wrong tokens lock the door")
    held(not folder.exists() or not (folder / "sock").exists(), "the socket is gone once it stops")
    shutil.rmtree(folder.parent, ignore_errors=True)


# ── 7. the relay to a model on this Mac ──


def stress_relay() -> None:
    requests = 200 if QUICK else 800
    print(
        f"\n[relay] {requests} streamed replies, 50 at a time, from a fake model server; failures mixed in"
    )

    def sse(*chunks):
        return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        n = int(body["messages"][-1]["content"].split()[-1])
        if n % 10 == 3:  # the server fails part-way
            text = sse(
                {"choices": [{"index": 0, "delta": {"content": "Half"}}]},
                {"error": {"message": "out of memory"}},
            )
        elif n % 10 == 7:  # not a model server
            text = "<!doctype html><title>Router</title>"
        else:
            words = [
                {"choices": [{"index": 0, "delta": {"content": f"word{k} "}}]} for k in range(40)
            ]
            text = sse(*words, {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        return httpx.Response(200, text=text, headers={"content-type": "text/event-stream"})

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(answer)))

    async def run():
        outcomes = {"done": 0, "error": 0, "silent": 0}
        latencies = []

        async def one(n: int) -> None:
            t0 = time.perf_counter()
            body = {
                "model": "qwen3",
                "stream": True,
                "messages": [{"role": "user", "content": f"say {n}"}],
            }
            _status, _data, events = await relay.messages("http://localhost:11434", "local", body)
            text = "".join([piece async for piece in events])
            latencies.append(time.perf_counter() - t0)
            if "event: error" in text:
                outcomes["error"] += 1
            elif "message_stop" in text and "word39" in text:
                outcomes["done"] += 1
            else:
                outcomes["silent"] += 1

        t0 = time.perf_counter()
        for start in range(0, requests, 50):
            await asyncio.gather(*(one(n) for n in range(start, min(requests, start + 50))))
        return outcomes, latencies, time.perf_counter() - t0

    outcomes, latencies, took = asyncio.run(run())
    print(f"    {requests / took:.0f} replies/s; {percentiles(latencies)}; {outcomes}")
    held(outcomes["silent"] == 0, "no reply ends quietly: each is whole or an error")
    held(outcomes["error"] == requests // 5, "each failure mixed in came back as an error")


# ── 8. widgets ──


def stress_widgets(tmp: Path) -> None:
    count = 1_000
    print(f"\n[widgets] {count:,} widgets made, pins past the dashboard's size, a damaged store")
    store = widgets.WidgetStore(tmp / "widgets.json")
    t0 = time.perf_counter()
    made = [
        store.add(f"W{n}", f"<svg><text>{n}</text></svg>", scripts=bool(n % 2))
        for n in range(count)
    ]
    print(f"    {count:,} made in {ms(time.perf_counter() - t0)}; shown {len(store.shown)}")
    pinned = refused = 0
    for w in made[-40:]:
        try:
            store.pin(w.id)
            pinned += 1
        except ValueError:
            refused += 1
    held(
        len(store.shown) == widgets.MAX_SHOWN,
        f"at most {widgets.MAX_SHOWN} kept while the app runs",
    )
    held(
        pinned == widgets.MAX_PINNED and refused == 40 - widgets.MAX_PINNED,
        f"at most {widgets.MAX_PINNED} pinned",
    )
    good = [w["id"] for w in widgets.WidgetStore(tmp / "widgets.json").public()]
    (tmp / "widgets.json").write_text(
        json.dumps(
            {"pinned": [{"id": "../../etc", "html": "x"}, 5, None, {"id": good[0], "html": 7}]}
        )
    )
    held(
        widgets.WidgetStore(tmp / "widgets.json").public() == [],
        "a hand-edited store pins nothing odd",
    )
    (tmp / "widgets.json").write_text('{"pinned": [')  # torn: a copy saved before comes back
    back = [w["id"] for w in widgets.WidgetStore(tmp / "widgets.json").public()]
    held(set(back) <= set(good), "a torn store comes back as an earlier save (or empty), never odd")


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="stress-ap-"))
    started = time.perf_counter()
    try:
        stress_inbox(tmp)
        stress_orders(tmp)
        stress_files(tmp)
        stress_price_alerts(tmp)
        stress_codes()
        stress_mcp()
        stress_relay()
        stress_widgets(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nall in {time.perf_counter() - started:.1f} s, peak memory {rss_mb():.0f} MB")
    if FAILED:
        print(f"BROKE: {len(FAILED)}")
        for what in FAILED:
            print(f"  - {what}")
        sys.exit(1)
    print("everything held")


if __name__ == "__main__":
    main()
