"""The voice feature (features/voice.py) on a hub: the hands-free listener it makes, the
voice detector it gives each stream, and the Settings pane's commands and event."""

import pytest
from conftest import FakeClient

from jarvis import vad
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub
from jarvis.listen import ContinuousListener


def make_hub(settings, speaker, isolated, **extra):
    return Hub(
        settings, client_factory=FakeClient, speaker=speaker, poll=False, **isolated, **extra
    )


def events(hub):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    return sent


@pytest.fixture
def fresh_vad(monkeypatch):
    monkeypatch.setattr(vad, "_session", None)
    monkeypatch.setattr(vad, "_failure", "")


def test_it_makes_the_apps_hands_free_listener_but_leaves_a_given_one(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    voice = voice_feature.feature_for(hub)
    assert "voice" in hub.features and hub.listener_factory == voice.make_listener
    hub.prefs.mic = "default"
    listener = hub.listener_factory(lambda _a: None, None, 1.1)
    assert isinstance(listener, ContinuousListener) and not listener.running
    assert listener.device_preference == "default" and listener.silence_seconds == 1.1
    assert listener.voice_factory == voice.voice_detector

    own = object()
    other = make_hub(settings, quiet_speaker, isolated, listener_factory=own)
    assert other.listener_factory is own  # a test's (or another caller's) own listener


def test_each_stream_gets_the_detector_chosen(settings, quiet_speaker, isolated, fresh_vad):
    hub = make_hub(settings, quiet_speaker, isolated)
    voice = voice_feature.feature_for(hub)
    gate = voice.voice_detector()
    assert isinstance(gate, vad.VoiceGate)  # neural is the default
    hub.set_feature_prefs({"voice_vad_threshold": 0.7})
    assert gate.threshold() == 0.7  # read live: no reopen needed
    hub.set_feature_prefs({"voice_detector": "energy"})
    assert voice.voice_detector() is None


def test_a_detector_that_cant_load_leaves_loudness(
    settings, quiet_speaker, isolated, fresh_vad, monkeypatch
):
    def missing():
        raise vad.Unavailable("no model here")

    monkeypatch.setattr(vad, "model_path", missing)
    hub = make_hub(settings, quiet_speaker, isolated)
    assert voice_feature.feature_for(hub).voice_detector() is None


async def test_the_pane_changes_only_its_own_settings_and_reopens_the_stream(
    settings, quiet_speaker, isolated, fresh_vad
):
    hub = make_hub(settings, quiet_speaker, isolated)
    voice = voice_feature.feature_for(hub)

    class Running:
        running, reopened = True, 0

        def reopen(self):
            self.reopened += 1

    voice.listener = running = Running()
    sent = events(hub)
    await hub._handle(
        {
            "type": "voice_settings",
            "changes": {"voice_detector": "energy", "hands_free": True, "voice_vad_threshold": 2},
        }
    )
    assert hub.prefs.feature("voice_detector") == "energy"
    assert hub.prefs.feature("voice_vad_threshold") == vad.MAX_THRESHOLD  # kept in range
    assert hub.prefs.hands_free is False  # not the pane's to change
    assert running.reopened == 1
    kind, state = sent[-1]
    assert kind == "voice" and state["detector"] == "energy"
    assert state["neural_ok"] is True and state["neural_why"] == ""

    await hub._handle({"type": "voice_settings", "changes": {"voice_detector": "loud"}})
    assert hub.prefs.feature("voice_detector") == "energy" and running.reopened == 1
    await hub._handle({"type": "voice_settings", "changes": {"voice_vad_threshold": 0.4}})
    assert running.reopened == 1  # the threshold is read live


async def test_the_pane_says_why_the_model_is_unavailable(
    settings, quiet_speaker, isolated, fresh_vad, monkeypatch
):
    def missing():
        raise vad.Unavailable("silero_vad_v6.onnx isn't in faster-whisper's package")

    monkeypatch.setattr(vad, "model_path", missing)
    hub = make_hub(settings, quiet_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_status"})
    state = sent[-1][1]
    assert state["neural_ok"] is False and "silero_vad_v6.onnx" in state["neural_why"]
