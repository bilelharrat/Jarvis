# ruff: noqa: F811  (the fixtures hub and projects come from test_code_share)
"""Share live (features/code_share.py) against a link holder who isn't the teammate it was
meant for, and against a long session: made-up viewer ids get no fresh budget, no seats and
no flood of suggestions; the limiter stays small and quick; twenty viewers' first polls work
out the changes once; a long transcript is cleaned once, off the app's loop, oldest page
first; a step's outcome reaches a viewer that already had its entry; a private key in the
changes is withheld from BEGIN to END. (These were the break round's reproductions; each now
asserts the fixed behaviour.)"""

import asyncio
import threading
import time
from pathlib import Path

import httpx
from claude_agent_sdk import ToolResultBlock
from test_code_changes import make_repo
from test_code_share import client_for, hub, latest, projects, session, share_url  # noqa: F401

from jarvis import code_changes
from jarvis.features import code_share
from jarvis.remote import Devices, create_remote_app


def token_of(hub):
    return share_url(hub).rsplit("/", 1)[1]


async def test_made_up_viewer_ids_dont_get_a_fresh_comment_budget(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({code_share.PREF_COMMENTS: True})
    hub.code_share.cmd_start({"id": task.id, "comments": True})
    token = token_of(hub)
    client = client_for(hub, tmp_path)
    # A suggestion from an id that never opened the page: refused, and no caption.
    codes = [
        client.post(f"/share/{token}/comment", json={"v": f"viewer-{i:04d}", "text": f"spam {i}"}).status_code
        for i in range(200)
    ]
    assert set(codes) == {403}
    assert [d for k, d in hub.events if k == "caption"] == []
    # Ids that do open it: only a few new ones a minute from one address, and their
    # suggestions share the address's budget.
    for i in range(50):
        client.get(f"/share/{token}/state", params={"v": f"viewer-{i:04d}"})
    share = next(iter(hub.code_share.shares.values()))
    watching = sorted(share.viewers)
    assert len(watching) <= code_share.VIEWERS_PER_ADDRESS
    codes = [
        client.post(f"/share/{token}/comment", json={"v": watching[i % len(watching)], "text": f"spam {i}"}).status_code
        for i in range(50)
    ]
    captions = [d for k, d in hub.events if k == "caption"]
    assert codes.count(200) <= code_share.RATES["address_comment"][1]
    assert len(captions) == codes.count(200) and codes.count(429) >= 40


async def test_the_limiter_stays_small_and_quick_with_made_up_viewers():
    lim = code_share.Limiter()
    t0 = time.perf_counter()
    for i in range(1000):
        lim.wait(f"s:{i}", "view")
    early = time.perf_counter() - t0
    t0 = time.perf_counter()
    for i in range(1000, 21000):
        lim.wait(f"s:{i}", "view")
    late = (time.perf_counter() - t0) / 20
    assert len(lim._buckets) <= code_share.BUCKETS_KEPT
    assert late < 5 * early + 0.01  # (it was quadratic: every call swept the whole dict)
    # The most recently used stay: a share's own bucket, used on every call, is never lost.
    lim = code_share.Limiter(kept=3)
    for i in range(10):
        lim.wait("share", "share_view")
        lim.wait(f"made-up-{i}", "view")
    assert ("share", "share_view") in lim._buckets and len(lim._buckets) == 3


async def test_a_link_holder_cant_take_every_seat(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    hub.code_share.cmd_start({"id": task.id})
    token = token_of(hub)
    squatter = client_for(hub, tmp_path)
    for i in range(code_share.MAX_VIEWERS):
        squatter.get(f"/share/{token}/state", params={"v": f"squat-{i:03d}"})
    share = next(iter(hub.code_share.shares.values()))
    assert share.watching() <= code_share.VIEWERS_PER_ADDRESS
    # The teammate, from another address on the network, gets in.
    app = create_remote_app(hub, Devices(tmp_path / "devices.json"))
    transport = httpx.ASGITransport(app=app, client=("192.168.1.77", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="https://t") as teammate:
        reply = await teammate.get(f"/share/{token}/state", params={"v": "real-teammate"})
    assert reply.status_code == 200, reply.text


async def test_twenty_viewers_first_polls_work_out_the_changes_once(hub, projects, tmp_path, monkeypatch):
    task, _ = await session(hub, projects)
    # Every viewer from its own seat, with budget to spare: only the single flight is tested.
    monkeypatch.setattr(code_share, "VIEWERS_PER_ADDRESS", code_share.MAX_VIEWERS)
    monkeypatch.setitem(code_share.RATES, "address_view", (10_000, 10_000))
    monkeypatch.setitem(code_share.RATES, "new_viewer", (10_000, 10_000))
    hub.code_share.limiter = code_share.Limiter()
    hub.code_share.cmd_start({"id": task.id})
    token = token_of(hub)
    real = code_changes.task_view
    calls = [0]
    lock = threading.Lock()

    def slow(*a, **k):
        with lock:
            calls[0] += 1
        time.sleep(0.3)
        return real(*a, **k)

    monkeypatch.setattr(code_changes, "task_view", slow)
    app = create_remote_app(hub, Devices(tmp_path / "devices.json"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://t") as c:
        replies = await asyncio.gather(*[
            c.get(f"/share/{token}/state", params={"v": f"viewer-{v:03d}"})
            for v in range(code_share.MAX_VIEWERS) for _ in range(20)
        ])  # fmt: skip
    ok = [r for r in replies if r.status_code == 200]
    assert ok and calls[0] == 1
    assert len({r.json()["changes_key"] for r in ok}) == 1


async def test_a_long_transcript_is_cleaned_once_off_the_loop_oldest_page_first(hub, projects, tmp_path, monkeypatch):
    task, _ = await session(hub, projects)
    first = task.seq
    blob = ("lorem ipsum token=abc /Users/x/proj " * 200)[: code_share.ENTRY_CHARS * 2]
    for _ in range(600):
        hub.tasks._log(task, "tool", blob, tool="Bash", status="done", output=blob)
    hub.code_share.cmd_start({"id": task.id})
    token = token_of(hub)
    loop_thread = threading.get_ident()
    cleaned = []
    real = hub.code_share.entry_for_viewer

    def counting(task_, e):
        cleaned.append(threading.get_ident())
        return real(task_, e)

    monkeypatch.setattr(hub.code_share, "entry_for_viewer", counting)
    client = client_for(hub, tmp_path)
    pages = [client.get(f"/share/{token}/state", params={"v": f"viewer-{i:03d}", "since": 0}).json()
             for i in range(3)]  # fmt: skip
    # Each entry cleaned once for every viewer, in a thread (never on the app's loop).
    assert len(cleaned) == code_share.ENTRIES_AT_ONCE
    assert loop_thread not in cleaned
    # The oldest first, with more to come: a viewer back from a pause misses nothing.
    page = pages[0]
    assert page["more"] is True
    numbers = [e["n"] for e in page["entries"]]
    kept = [e["n"] for e in task.transcript if e["role"] in code_share.ROLES]
    assert numbers[0] == kept[0] and numbers == sorted(numbers) and len(numbers) <= code_share.ENTRIES_AT_ONCE
    seen = set(numbers)
    since = page["entries"][-1]["n"]
    while page["more"]:
        page = client.get(f"/share/{token}/state", params={"v": "viewer-000", "since": since}).json()
        seen |= {e["n"] for e in page["entries"]}
        since = max([since, *(e["n"] for e in page["entries"])])
    assert set(kept) <= seen and task.seq > first


async def test_a_steps_outcome_reaches_a_viewer_that_had_its_entry(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    hub.tasks._log(task, "tool", "Run the tests", tool="Bash", tool_id="tu-1", status="")
    task.tool_ids["tu-1"] = None
    hub.code_share.cmd_start({"id": task.id})
    token = token_of(hub)
    client = client_for(hub, tmp_path)
    data = client.get(f"/share/{token}/state", params={"v": "viewer-one"}).json()
    step = next(e for e in data["entries"] if e.get("tool") == "Bash")
    assert step["status"] == "" and "output" not in step
    since, seen = data["entries"][-1]["n"], data["u"]
    # Nothing new: nothing sent.
    again = client.get(f"/share/{token}/state", params={"v": "viewer-one", "since": since, "u": seen}).json()
    assert again["entries"] == []
    hub.tasks._tool_result(task, ToolResultBlock(tool_use_id="tu-1", content="12 passed", is_error=False))
    later = client.get(f"/share/{token}/state", params={"v": "viewer-one", "since": since, "u": seen}).json()
    [step] = later["entries"]
    assert step["n"] == next(e["n"] for e in data["entries"] if e.get("tool") == "Bash")
    assert step["status"] == "done" and "12 passed" in step["output"]
    assert later["u"] > seen
    # Told once: with the new u, it isn't sent again.
    last = client.get(f"/share/{token}/state",
                      params={"v": "viewer-one", "since": since, "u": later["u"]}).json()  # fmt: skip
    assert last["entries"] == []


PEM_BODY = ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
            "QyNTUxOQAAACBkZXBsb3kta2V5LWZvci10aGUtdGVzdHMtb25seS0xMjM0NTY3OAAAAJg"]  # fmt: skip


async def test_a_private_key_in_the_changes_is_withheld_from_begin_to_end(hub, projects, tmp_path):
    task, repo = await session(hub, projects)
    (repo / "notes.txt").write_text(
        "deploy key below\n-----BEGIN OPENSSH PRIVATE KEY-----\n"
        + "\n".join(PEM_BODY)
        + "\n-----END OPENSSH PRIVATE KEY-----\nthe end\n"
    )
    hub.code_share.cmd_start({"id": task.id})
    client = client_for(hub, tmp_path)
    reply = client.get(f"/share/{token_of(hub)}/state", params={"v": "viewer-one"})
    assert all(line not in reply.text for line in PEM_BODY)
    files = {f["path"]: f for f in reply.json()["changes"]["files"]}
    lines = [t for h in files["notes.txt"]["hunks"] for _, t in h["lines"]]
    assert "deploy key below" in lines and "the end" in lines
    assert lines.count(code_share.WITHHELD) == 4


def test_key_lines_cover_a_hunk_that_starts_or_ends_inside_a_key():
    tail = [("+", PEM_BODY[1]), ("+", "-----END RSA PRIVATE KEY-----"), ("+", "x = 1")]
    assert code_share._key_lines(tail) == {0, 1}
    head = [("+", "y = 2"), ("+", "-----BEGIN PRIVATE KEY-----"), ("+", PEM_BODY[0])]
    assert code_share._key_lines(head) == {1, 2}
    assert code_share._key_lines([(" ", "nothing here")]) == set()


async def test_the_project_name_and_private_addresses_are_cleaned_and_a_yes_isnt_an_id(hub, projects, tmp_path):
    user = Path.home().name
    make_repo(projects / user, {"a.py": "x = 1\n"})
    task = hub.tasks.start("", user, mode="ask", title="T")
    hub.tasks._log(task, "tool", "ssh", tool="Bash", status="done",
                   output="Host prod\n  HostName 10.0.0.5\n  public 8.8.8.8 local 127.0.0.1")  # fmt: skip
    assert hub.code_share.start({"id": True}) == "Open a session to share it."
    hub.code_share.cmd_start({"id": task.id})
    data = client_for(hub, tmp_path).get(f"/share/{token_of(hub)}/state",
                                         params={"v": "viewer-one"}).json()  # fmt: skip
    if len(user) >= 3:
        assert data["project"] == "<user>"
    out = next(e for e in data["entries"] if e.get("tool") == "Bash")["output"]
    assert "10.0.0.5" not in out and "(an address on the owner's network)" in out
    assert "8.8.8.8" in out and "127.0.0.1" in out
