"""Logbook's setting (features/code_logbook.py): the margin beside the transcript, shown or
folded away, kept in prefs across restarts. Its window side is tested in
tests/web/code-logbook.test.mjs."""

import json

from conftest import FakeClient

from jarvis import prefs
from jarvis.features import code_logbook
from jarvis.hub import Hub


def test_the_margin_shows_until_it_is_folded_and_stays_folded(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert hub.prefs.feature(code_logbook.PREF) is True  # shown at first
    hub.set_feature_prefs({code_logbook.PREF: False})
    assert hub.prefs.feature(code_logbook.PREF) is False
    hub.set_feature_prefs({code_logbook.PREF: "no"})  # not a yes or a no: the old one stays
    assert hub.prefs.feature(code_logbook.PREF) is False
    saved = json.loads(isolated["prefs_store"].path.read_text())
    assert saved["features"][code_logbook.PREF] is False
    assert prefs.PrefsStore(isolated["prefs_store"].path).prefs.feature(code_logbook.PREF) is False
