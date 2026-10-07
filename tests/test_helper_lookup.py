"""The downloadable app's prebuilt Swift helpers (swift_helper.prebuilt): every helper's
builder takes the one in JARVIS_HELPERS_DIR while its .sha256 is the source's hash, and
otherwise builds with swiftc as before. swiftc is a stand-in here; nothing is compiled."""

import asyncio
import hashlib
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest
from conftest import FakeClient

from jarvis import audio, codelook, hands_guard, prefs, speech, swift_helper
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub

SRC = Path(swift_helper.__file__).parent


def builders():
    """Each helper's source and its builder. Helpers in native/ and audio/, and the voice
    player, go through the shared builders (swift_helper.ensure, audio.build); the rest have
    their own."""
    table = {
        "jarvis-player": (speech.PLAYER_SOURCE, speech.ensure_player),
        "jarvis-look": (codelook.HELPER_SOURCE, lambda: codelook.ensure_helper()),
        "jarvis-axprobe": (hands_guard.AX_SOURCE, hands_guard.ensure_probe),
    }
    for source in sorted(swift_helper.NATIVE.glob("jarvis-*.swift")):
        table[source.stem] = (source, lambda name=source.stem: swift_helper.ensure(name))
    for source in sorted(audio.HERE.glob("jarvis-*.swift")):
        table[source.stem] = (source, lambda name=source.stem: audio.build(name))
    return table


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def swiftc(tmp_path, monkeypatch):
    """Builds land in a temp Application Support; each swiftc run is recorded."""
    monkeypatch.setattr(prefs, "APP_SUPPORT", tmp_path / "support")
    monkeypatch.setattr(swift_helper, "_failed", set())
    runs = []

    def fake(argv, **_kw):
        runs.append(argv)
        out = Path(argv[argv.index("-o") + 1])
        out.write_bytes(b"built here")
        out.chmod(0o755)
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(subprocess, "run", fake)
    return runs


def shelf(tmp_path, monkeypatch, name, source, *, recorded=None, mode=0o755):
    """A helpers folder as the app carries it, holding `name` built from `source`."""
    folder = tmp_path / "helpers"
    folder.mkdir(exist_ok=True)
    binary = folder / name
    binary.write_bytes(b"prebuilt")
    binary.chmod(mode)
    (folder / f"{name}.sha256").write_text(f"{recorded or digest(source)}\n")
    monkeypatch.setenv(swift_helper.HELPERS_ENV, str(folder))
    return binary


def test_every_helper_source_has_a_builder_that_asks_for_the_prebuilt_one_first():
    sources = {p.stem for p in SRC.rglob("jarvis-*.swift")}
    missing = sources - set(builders())
    assert not missing, (
        f"{sorted(missing)}: build these through swift_helper.ensure or audio.build, or have "
        "their builder ask swift_helper.prebuilt() first and add it to builders() here "
        "(the downloadable app has no swiftc)"
    )


@pytest.mark.parametrize("name", sorted(builders()))
def test_the_prebuilt_helper_is_used_when_its_hash_matches(name, tmp_path, monkeypatch, swiftc):
    source, build = builders()[name]
    binary = shelf(tmp_path, monkeypatch, name, source)
    assert build() == binary
    assert swiftc == []  # never compiled


@pytest.mark.parametrize("name", sorted(builders()))
def test_a_stale_hash_is_built_afresh(name, tmp_path, monkeypatch, swiftc):
    source, build = builders()[name]
    binary = shelf(tmp_path, monkeypatch, name, source, recorded="0" * 64)
    built = build()
    assert built is not None and built != binary and built.read_bytes() == b"built here"
    assert built.parent == tmp_path / "support" / "bin" and len(swiftc) == 1


@pytest.mark.parametrize("name", sorted(builders()))
def test_without_the_folder_it_builds_as_before(name, tmp_path, monkeypatch, swiftc):
    source, build = builders()[name]
    monkeypatch.setenv(swift_helper.HELPERS_ENV, str(tmp_path / "no-such-folder"))
    built = build()
    assert built is not None and built.parent == tmp_path / "support" / "bin"
    assert len(swiftc) == 1
    monkeypatch.delenv(swift_helper.HELPERS_ENV)
    assert build() == built and len(swiftc) == 1  # unset: the cached build, as ever


def test_a_helper_file_that_isnt_a_program_is_passed_over(tmp_path, monkeypatch, swiftc):
    source = speech.PLAYER_SOURCE
    shelf(tmp_path, monkeypatch, "jarvis-player", source, mode=0o644)
    built = speech.ensure_player()
    assert built is not None and built.parent == tmp_path / "support" / "bin" and swiftc
    (tmp_path / "helpers" / "jarvis-player").unlink()
    (tmp_path / "helpers" / "jarvis-player").mkdir()  # a folder by that name: not a program
    assert swift_helper.prebuilt("jarvis-player", source) is None


def test_the_recorded_hash_is_read_strictly(tmp_path, monkeypatch):
    source = speech.PLAYER_SOURCE
    binary = shelf(tmp_path, monkeypatch, "jarvis-player", source)
    record = tmp_path / "helpers" / "jarvis-player.sha256"
    record.write_text(f"{digest(source)}  jarvis-player.swift\n")  # shasum's own format
    assert swift_helper.prebuilt("jarvis-player", source) == binary
    record.write_text(digest(source)[:10])  # the cache's short hash is not the whole one
    assert swift_helper.prebuilt("jarvis-player", source) is None
    record.write_bytes(b"\xff\xfe")
    assert swift_helper.prebuilt("jarvis-player", source) is None
    record.unlink()
    assert swift_helper.prebuilt("jarvis-player", source) is None
    assert swift_helper.prebuilt("jarvis-player", tmp_path / "gone.swift") is None


def test_the_search_helper_is_found_where_the_app_keeps_it(tmp_path, monkeypatch, swiftc):
    """Search by meaning asks binary_for() whether its helper is there yet: the prebuilt
    one is, so searches use it without a build."""
    source = swift_helper.NATIVE / "jarvis-embed.swift"
    binary = shelf(tmp_path, monkeypatch, "jarvis-embed", source)
    assert swift_helper.binary_for("jarvis-embed") == binary and binary.exists()
    assert swiftc == []


async def test_a_helper_that_cant_run_on_this_mac_leaves_whisper_listening(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    """The app's jarvis-hear is built for macOS 26 (SpeechAnalyzer): on an older Mac dyld
    can't find those symbols and stops it at launch. Apple's recognizer is then unavailable,
    said plainly, and Whisper goes on listening; nothing is compiled in its place."""
    source = audio.HERE / "jarvis-hear.swift"
    folder = tmp_path / "helpers"
    folder.mkdir()
    dead = folder / "jarvis-hear"
    dead.write_text("#!/bin/sh\nkill -ABRT $$\n")  # dyld: "Symbol not found", abort
    dead.chmod(0o755)
    (folder / "jarvis-hear.sha256").write_text(digest(source) + "\n")
    monkeypatch.setenv(swift_helper.HELPERS_ENV, str(folder))

    real_run = subprocess.run

    def no_swiftc(argv, **kw):
        if argv and argv[0] == "swiftc":
            raise AssertionError("nothing is compiled in the app")
        return real_run(argv, **kw)

    monkeypatch.setattr(subprocess, "run", no_swiftc)
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub._loop = asyncio.get_running_loop()
    ears = voice_feature.feature_for(hub).ears
    hub.set_feature_prefs({"voice_engine": "apple"})
    started = time.monotonic()
    await ears.refresh()
    assert ears.path == dead and ears.state == "failed" and ears.recognizer is None
    assert ears.why == "Apple's speech recognition isn't available on this Mac"
    assert time.monotonic() - started < 30
    assert hub.heard_live(np.zeros(1600, np.float32)) is None  # Whisper's
