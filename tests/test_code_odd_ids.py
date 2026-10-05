"""A window command's session id that isn't a number (null, words, a list, infinity, NaN)
names no session: Jarvis Code's platform commands (codeplatform.code_task: cr_*, cs_*, cu_*,
the plugins' and connectors' panes) and an @mention's origin (codepeers) do nothing with it
and log no traceback, as hub._msg_int reads one."""

import asyncio
import logging
from types import SimpleNamespace

from test_code_peers import recording
from test_code_voice_feature import close_all, hub_with, session

from jarvis.codeplatform import code_task

ODD = [None, "words", [1], {"a": 1}, float("inf"), float("-inf"), float("nan"), 1e400, -1e400]


def test_code_task_reads_odd_ids_as_no_session():
    task = SimpleNamespace(kind="code")
    hub = SimpleNamespace(tasks=SimpleNamespace(tasks={3: task}))
    assert code_task(hub, {"id": 3}) is task
    assert code_task(hub, {"id": "3"}) is task  # (a number in words, as before)
    assert code_task(hub, {"id": 3.0}) is task
    for odd in ODD:
        assert code_task(hub, {"id": odd}) is None, odd
    assert code_task(hub, {}) is None


async def test_platform_commands_with_odd_ids_log_no_traceback(
    settings, quiet_speaker, isolated, tmp_path, caplog
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    session(hub, "proj", "Add a retry")
    caplog.set_level(logging.WARNING)
    for kind in (
        "cr_state",
        "cs_state",
        "cs_session",
        "cu_cap",
        "cl_lanes",
        "cm_state",
        "cx_state",
        "cx_details",
        "cx_context",
    ):
        for odd in ODD:
            await hub.handle({"type": kind, "id": odd})
    await asyncio.sleep(0.05)  # (the background ones)
    failed = [r for r in caplog.records if r.levelno >= logging.ERROR or r.exc_info]
    assert failed == []
    close_all(hub)


async def test_a_mention_from_an_odd_origin_still_goes_to_its_session(
    settings, quiet_speaker, isolated, tmp_path, caplog
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj", "api")
    api = session(hub, "proj", "Serve the API")
    sent = recording(hub)
    peers = hub.code_voice.peers
    for odd in (float("inf"), 1e400, float("nan"), [2]):
        assert peers.mention(odd, f"@session-{api.id} what port?", None) == api.id
    assert [(s[0], s[1]) for s in sent] == [(api.id, "what port?")] * 4
    assert peers._session(float("inf")) is None
    assert peers._session(api.id) is api
    assert not [r for r in caplog.records if r.exc_info]
    close_all(hub)
