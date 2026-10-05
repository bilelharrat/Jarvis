"""Where a spoken request's time goes (hub.Stages): the first-sound line counts from the
owner's last word, with the quiet waited out, the time in line, the transcription, the voice
check and the answer each shown. Before, it counted from when the utterance left the
queue, so a request held up behind a busy room still read "0.10s after you stopped
talking". Canned audio and a fake transcriber: no microphone."""

import asyncio
import logging
import re
import time

from test_hub import Listener, make_hub
from test_voice_id import Words, speech

from jarvis import hub as hub_module


async def test_a_spoken_request_carries_its_stages(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})
    hub.transcriber = Words("Jarvis, what's on tomorrow?", 0.2)
    asked = []

    async def fake_ask(request, **kw):
        asked.append((request, kw.get("stages")))
        return ""

    hub.ask = fake_ask
    # The utterance ended half a second ago: something ahead of it held it in line.
    ended = time.monotonic() - 0.5
    hub._heard.put_nowait(("full", ended, speech("owner")))
    deadline = time.monotonic() + 30  # a busy Mac can take seconds over it
    while not asked and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    asked_by = time.monotonic()
    ((request, stages),) = asked
    assert request == "what's on tomorrow"
    assert stages.endpoint == hub_module.HANDS_FREE_ENDPOINT
    # In line from when it ended (not from when it left the line), then the transcriber's
    # 0.2 s; together never more than the time it has really been since it ended.
    assert stages.queued >= 0.45 and stages.stt >= 0.2
    assert stages.queued + stages.stt <= asked_by - ended
    hub._heard.put_nowait(None)


async def test_the_first_sound_line_counts_from_the_last_word(
    settings, quiet_speaker, isolated, caplog
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    now = time.monotonic()
    hub._asked_at = now - 0.7
    hub._turn_stages = hub_module.Stages(spoke_end=now - 2.5, endpoint=1.1, queued=0.4, stt=0.3)
    hub._voice_wait = 0.05
    hub._first_sound_logged = False
    with caplog.at_level(logging.INFO, logger="jarvis"):
        hub._on_speaking(True)
    (line,) = [r.getMessage() for r in caplog.records if r.getMessage().startswith("first sound")]
    numbers = [float(n) for n in re.findall(r"(\d+\.\d+)s", line)]
    total, endpoint, queued, stt, check, answering, request = numbers
    assert 2.5 <= total < 2.6 and (endpoint, queued, stt, check) == (1.1, 0.4, 0.3, 0.05)
    assert 0.7 <= answering < 0.8 and request == answering
    assert "after you stopped talking (end of speech" in line


async def test_a_typed_request_has_no_spoken_stages(settings, quiet_speaker, isolated, caplog):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub._asked_at = time.monotonic() - 0.4
    hub._turn_stages = None
    hub._first_sound_logged = False
    with caplog.at_level(logging.INFO, logger="jarvis"):
        hub._on_speaking(True)
    (line,) = [r.getMessage() for r in caplog.records if r.getMessage().startswith("first sound")]
    assert re.fullmatch(r"first sound 0\.4\ds after the request", line)
