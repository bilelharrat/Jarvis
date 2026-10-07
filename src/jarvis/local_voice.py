"""JARVIS's own voice, on this Mac: Kokoro-82M (ONNX, run with onnxruntime), offline and
free. Settings › Speaking offers it as "JARVIS (on this Mac)"; it is also the voice that
speaks when a cloud voice fails or the Mac is offline, once it's downloaded.

- Nothing is shipped: OFFLINE_VOICE_FILES says where each file comes from. They download
  only when the owner presses Download in Settings › Speaking (the size shown first,
  progress while it runs, each file's SHA-256 checked before it's kept).
- English only (local_phonemes.py turns text into Kokoro's phonemes with misaki's
  lexicons). Chinese, and a sentence with a word the lexicon doesn't know, are said by the
  Mac voice, as before.
- Sentence by sentence: each one's audio is ready as soon as the model has made it, so the
  first words play while the rest is still being made.
- Model missing or broken: the Mac voice speaks, and JARVIS says so once.

Cost policy: no Claude model is called. The model runs on this Mac's CPU.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import numpy as np

from . import local_phonemes, voiceprint
from .lang import has_cjk

log = logging.getLogger("jarvis")

LOCAL_RATE = 24_000  # Kokoro's output
STYLE_DIM = 256
FOLDER = "offline_voice"

_HF = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"
_MISAKI = "https://raw.githubusercontent.com/hexgrad/misaki/main/misaki/data"

# THE ONE PLACE to point the offline voice at its files: {file name: {url, sha256, size}}.
# Until every file has an https url and a 64-character sha256, Settings says the voice
# isn't set up in this build and nothing downloads.
# - The model and voices: checked against the Hugging Face repo's LFS pointers (their
#   sha256 and size), 2026-09-30. model_quantized is the int8 export: 92 MB against the
#   full-precision 326 MB, and it runs faster on a CPU.
# - The lexicons are plain git files, so the repo publishes no checksum for them: their
#   sha256 and size stay empty until the owner downloads them once and fills them in
#   (scripts/offline_voice_pin.py prints both).
OFFLINE_VOICE_FILES: dict[str, dict[str, Any]] = {
    "kokoro.onnx": {
        "url": f"{_HF}/onnx/model_quantized.onnx",
        "sha256": "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
        "size": 92361116,
    },
    "bm_george.bin": {
        "url": f"{_HF}/voices/bm_george.bin",
        "sha256": "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc",
        "size": 522240,
    },
    "af_heart.bin": {
        "url": f"{_HF}/voices/af_heart.bin",
        "sha256": "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
        "size": 522240,
    },
    "am_michael.bin": {
        "url": f"{_HF}/voices/am_michael.bin",
        "sha256": "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
        "size": 522240,
    },
    "us_gold.json": {
        "url": f"{_MISAKI}/us_gold.json",
        "sha256": "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f",
        "size": 3000469,
    },
    "us_silver.json": {
        "url": f"{_MISAKI}/us_silver.json",
        "sha256": "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475",
        "size": 3099517,
    },
    "gb_gold.json": {
        "url": f"{_MISAKI}/gb_gold.json",
        "sha256": "29e62f4b60261c88f7f3c2c7811ca3825978948090b72d2b27d565b729282f71",
        "size": 2838552,
    },
    "gb_silver.json": {
        "url": f"{_MISAKI}/gb_silver.json",
        "sha256": "48131e2d92ccc41655f4543e87e0f938e71463eb5a54be7f0693bb712ebb6bce",
        "size": 3663898,
    },
}

# The voices offered: id -> (the name shown, British?). Kokoro's "b" voices were trained
# on British phonemes, so they read with the British lexicon.
VOICES: dict[str, tuple[str, bool]] = {
    "bm_george": ("George · British", True),
    "af_heart": ("Heart · American", False),
    "am_michael": ("Michael · American", False),
}
DEFAULT_VOICE = "bm_george"
SPEED_MIN, SPEED_MAX = 0.5, 2.0

# What the pane says while the model fails (engine.error, the reason, goes to the log).
RUN_FAILED = "JARVIS’s offline voice couldn’t run, so the Mac voice spoke instead."


class Unavailable(RuntimeError):
    """The offline voice can't run: files missing or damaged, or onnxruntime failed."""


def configured(files: dict[str, dict[str, Any]] | None = None) -> bool:
    """Every file has a place to come from and a checksum to check it against."""
    files = OFFLINE_VOICE_FILES if files is None else files
    return all(
        str(f.get("url") or "").startswith("https://")
        and re.fullmatch(r"[0-9a-f]{64}", str(f.get("sha256") or "").lower())
        for f in files.values()
    )


def total_size(files: dict[str, dict[str, Any]] | None = None) -> int:
    files = OFFLINE_VOICE_FILES if files is None else files
    return sum(int(f.get("size") or 0) for f in files.values())


def _all_here(folder: Path, files: dict[str, dict[str, Any]]) -> bool:
    """Every one of the files is in the folder (downloaded)."""
    return all((folder / name).is_file() for name in files)


def _session(path: Path) -> Any:
    try:
        import onnxruntime
    except Exception as exc:  # pragma: no cover - it's a dependency
        raise Unavailable(f"onnxruntime isn't available ({exc})") from exc
    opts = onnxruntime.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 2) - 1))
    try:
        return onnxruntime.InferenceSession(
            os.fspath(path), providers=["CPUExecutionProvider"], sess_options=opts
        )
    except Exception as exc:
        raise Unavailable(f"the voice model couldn't load ({exc})") from exc


class Engine:
    """The model, lexicons and voice styles in one folder, loaded when first needed and
    kept (one per hub: switching voices never reloads the model)."""

    def __init__(
        self,
        folder: Path,
        session_factory: Callable[[Path], Any] | None = None,
        files: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.folder = folder
        self.files = OFFLINE_VOICE_FILES if files is None else files
        self.session_factory = session_factory or _session
        self._session: Any = None
        self._names: dict[str, str] = {}
        self._lexicons: dict[bool, local_phonemes.Lexicon] = {}
        self._styles: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()  # loading (threads)
        self._turn: asyncio.Lock | None = None  # one sentence at a time, in order
        self.error = ""  # why it couldn't run last

    def downloaded(self) -> bool:
        return _all_here(self.folder, self.files)

    # ── loading (blocking: call off the event loop) ──

    def session(self) -> Any:
        with self._lock:
            if self._session is None:
                path = self.folder / "kokoro.onnx"
                if not path.is_file():
                    raise Unavailable("the voice model isn't downloaded")
                session = self.session_factory(path)
                names = {}
                for spec in session.get_inputs():
                    kind = str(getattr(spec, "type", ""))
                    name = spec.name
                    if "speed" in name.lower():
                        names["speed"] = name
                        names["speed_type"] = kind
                    elif "int" in kind:
                        names["tokens"] = name
                    else:
                        names["style"] = name
                if not {"tokens", "style", "speed"} <= names.keys():
                    raise Unavailable("the voice model's inputs aren't Kokoro's")
                self._session, self._names = session, names
            return self._session

    def lexicon(self, british: bool) -> local_phonemes.Lexicon:
        with self._lock:
            if british not in self._lexicons:
                accent = "gb" if british else "us"
                try:
                    self._lexicons[british] = local_phonemes.Lexicon.load(
                        self.folder / f"{accent}_gold.json",
                        self.folder / f"{accent}_silver.json",
                        british,
                    )
                except (OSError, ValueError) as exc:
                    raise Unavailable(f"the voice's lexicon couldn't load ({exc})") from exc
            return self._lexicons[british]

    def style(self, voice: str) -> np.ndarray:
        with self._lock:
            if voice not in self._styles:
                path = self.folder / f"{voice}.bin"
                try:
                    data = np.fromfile(path, dtype="<f4")
                except OSError as exc:
                    raise Unavailable(f"the voice {voice} isn't downloaded") from exc
                if data.size == 0 or data.size % STYLE_DIM:
                    raise Unavailable(f"the voice {voice} is damaged")
                self._styles[voice] = data.reshape(-1, STYLE_DIM)
            return self._styles[voice]

    def load(self, voice: str) -> None:
        """Everything a voice needs, loaded now (the app warms it at startup)."""
        self.session()
        self.lexicon(VOICES.get(voice, ("", False))[1])
        self.style(voice)

    def synthesize(self, phonemes: str, voice: str, speed: float) -> np.ndarray:
        """One sentence's phonemes -> float32 audio at LOCAL_RATE."""
        session = self.session()
        styles = self.style(voice)
        speed_type = np.int32 if "int32" in self._names["speed_type"] else np.float32
        parts = []
        for piece in local_phonemes.chunks(phonemes):
            ids = local_phonemes.token_ids(piece)[: local_phonemes.MAX_TOKENS]
            if not ids:
                continue
            style = styles[min(len(ids), styles.shape[0] - 1)][None, :]
            out = session.run(
                None,
                {
                    self._names["tokens"]: np.array([[0, *ids, 0]], dtype=np.int64),
                    self._names["style"]: style.astype(np.float32),
                    self._names["speed"]: np.array([speed], dtype=speed_type),
                },
            )[0]
            parts.append(np.asarray(out, dtype=np.float32).ravel())
        return np.concatenate(parts) if parts else np.zeros(0, np.float32)

    def turn(self) -> asyncio.Lock:
        if self._turn is None:
            self._turn = asyncio.Lock()
        return self._turn


class LocalVoice:
    """One of the offline voices, at a speed: what the Speaker speaks with."""

    def __init__(self, engine: Engine, voice: str = DEFAULT_VOICE, speed: float = 1.0) -> None:
        self.engine = engine
        self.voice = voice if voice in VOICES else DEFAULT_VOICE
        self.speed = float(min(SPEED_MAX, max(SPEED_MIN, speed)))

    @property
    def british(self) -> bool:
        return VOICES[self.voice][1]

    def same(self, other: Any) -> bool:
        return (
            isinstance(other, LocalVoice)
            and other.engine is self.engine
            and other.voice == self.voice
            and abs(other.speed - self.speed) < 0.005
        )

    def speaks(self, text: str) -> bool:
        """English text, with the files in place (Chinese: the Mac voice)."""
        return bool(text.strip()) and not has_cjk(text) and self.engine.downloaded()

    def _phonemes(self, sentence: str) -> str | None:
        found, unknown = local_phonemes.phonemize(sentence, self.engine.lexicon(self.british))
        if unknown:
            log.info("offline voice: %d unknown word(s); the Mac voice says it", len(unknown))
        return found

    def _make(self, sentence: str) -> np.ndarray | None:
        phonemes = self._phonemes(sentence)
        if not phonemes:
            return None
        return self.engine.synthesize(phonemes, self.voice, self.speed)

    async def pieces(self, text: str) -> AsyncIterator[tuple[str, Any]]:
        """("audio", float32 at LOCAL_RATE) sentence by sentence, or ("mac", text) for what
        the Mac voice should say instead: a sentence it can't pronounce, or everything left
        when the model fails (engine.error then says why)."""
        from .speech import split_sentences

        sentences, _ = split_sentences(text, final=True, min_chars=1)
        for i, sentence in enumerate(sentences):
            try:
                async with self.engine.turn():
                    audio = await asyncio.to_thread(self._make, sentence)
            except Exception as exc:  # missing or damaged files, onnxruntime's own errors
                self.engine.error = str(exc)[:200] or type(exc).__name__
                log.warning("offline voice failed (%s)", self.engine.error)
                yield "mac", " ".join(sentences[i:])
                return
            self.engine.error = ""
            if audio is None:
                yield "mac", sentence
            elif audio.size:
                yield "audio", audio


# ── the files: downloaded when the owner asks ──


class Store:
    """The offline voice's files beside prefs.json, and their download."""

    def __init__(self, folder: Path, files: dict[str, dict[str, Any]] | None = None) -> None:
        self.folder = folder
        self.files = OFFLINE_VOICE_FILES if files is None else files
        self.fetch: Any = None  # the download's fetcher (tests pass a fake)
        self.session_factory: Callable[[Path], Any] | None = None  # (tests pass a fake)
        self.downloading: dict[str, int] | None = None
        self.error = ""
        self._engine: Engine | None = None

    def configured(self) -> bool:
        return configured(self.files)

    def ready(self) -> bool:
        return _all_here(self.folder, self.files)

    def engine(self) -> Engine:
        if self._engine is None:
            self._engine = Engine(self.folder, self.session_factory, self.files)
        return self._engine

    def voice(self, voice: str, speed: float = 1.0) -> LocalVoice:
        return LocalVoice(self.engine(), voice, speed)

    async def download(self, on_progress: Callable[[], None] | None = None) -> bool:
        """Every file not yet here, one after another, each checked. True when all are."""
        if self.downloading is not None:
            return False
        if not self.configured():
            self.error = "The offline voice isn’t set up in this build."
            return False
        total = total_size(self.files)
        done_before = sum(
            int(f.get("size") or 0) for n, f in self.files.items() if (self.folder / n).is_file()
        )
        self.downloading = {"done": done_before, "total": total}
        self.error = ""
        base, last = [done_before], [done_before]

        def progress(done: int, _total: int) -> None:
            now = base[0] + done
            self.downloading = {"done": now, "total": total}
            if on_progress is not None and now - last[0] >= (1 << 20):
                last[0] = now
                on_progress()

        try:
            for name, spec in self.files.items():
                dest = self.folder / name
                if dest.is_file():
                    continue
                await voiceprint.download(dest, spec, progress, self.fetch)
                base[0] += int(spec.get("size") or 0)
            log.info("offline voice: downloaded")
            return True
        except Exception as exc:
            log.warning("offline voice: download failed: %s", exc)
            self.error = f"The offline voice didn’t download: {exc}"
            return False
        finally:
            self.downloading = None
            self._engine = None  # fresh files: load them anew

    def remove(self) -> None:
        for name in self.files:
            for path in (self.folder / name, self.folder / f"{name}.part"):
                path.unlink(missing_ok=True)
        self._engine = None

    def public(self) -> dict[str, Any]:
        engine = self._engine
        return {
            "configured": self.configured(),
            "ready": self.ready(),
            "size": total_size(self.files),
            "downloading": self.downloading,
            "error": self.error or (RUN_FAILED if engine is not None and engine.error else ""),
            "voices": [{"id": k, "name": v[0]} for k, v in VOICES.items()],
        }


def store_for(hub: Any) -> Store:
    """The hub's offline-voice files (made on first use, kept on the hub)."""
    store = getattr(hub, "offline_voice", None)
    if store is None:
        store = Store(Path(hub.feature_path(FOLDER)))
        hub.offline_voice = store
    return store
