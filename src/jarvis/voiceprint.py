"""The owner's voiceprint: a speaker embedding of their voice, and how close another
utterance's is to it (features/voice_id.py wires it into hands-free).

- fbank(): Kaldi-style 80-bin log-mel features (25 ms frames every 10 ms, mean-normalised),
  the input the common speaker-embedding exports (WeSpeaker ResNet, ECAPA-TDNN, 3D-Speaker)
  are trained on.
- OnnxEmbedder: one of those models run with onnxruntime (already a dependency). It is
  never shipped: SPEAKER_MODEL says where it downloads from, and it downloads only when the
  owner turns "Recognise my voice" on (download(), size shown first, checksum checked).
- enroll(): the voiceprint from the enrollment clips (their mean embedding), with a
  threshold tuned to this owner: how close their own clips are to the rest of them.
- Voiceprint.score(): cosine similarity with an utterance's embedding.

Nothing here opens the microphone or the network by itself; tests pass their own
embedder and fetcher.
"""

from __future__ import annotations

import hashlib
import math
import os
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import jsonstore

SAMPLE_RATE = 16_000

# THE ONE PLACE to point this feature at a model. url: an ONNX speaker-embedding export
# taking fbank features [batch, frames, 80] and returning [batch, dim]; sha256: its
# checksum; size: its size in bytes (shown before the download). Left empty until a URL
# and checksum have been verified: with no url, Settings says the voice model isn't set
# up in this build and the feature stays off (everything behaves as before).
SPEAKER_MODEL: dict[str, Any] = {
    # WeSpeaker's ResNet34 trained on VoxCeleb, as exported by the sherpa-onnx project
    # (fbank [batch, frames, 80] in, a 256-number embedding out). "recongition" is their
    # release's own spelling.
    "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx",
    "sha256": "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94",
    "size": 26534365,
}

MODEL_FILE = "speaker.onnx"
# Too little speech says little about who spoke: shorter utterances aren't checked.
MIN_SECONDS = 0.6
# Who spoke shows in the first seconds: a check embeds at most this much of an utterance,
# so a long one (a TV, a monologue) costs no more than a short one.
MAX_CHECK_SECONDS = 6.0
# Two cosine bars. At or above the owner's threshold: the owner. Below REJECT: someone
# else. Between them: unsure, which is answered but isn't the owner's word for a risky
# step. The owner's own clips set the threshold (enroll), kept inside these bounds.
#
# Measured on the owner's Mac (2026-10): enrollment clips, read in one sitting close to
# the microphone, agree at ~0.75 with each other, so the threshold always came out at the
# old 0.55 ceiling; the owner's live hands-free requests (another distance and room, short
# commands, sometimes the echo-cancelled microphone) scored 0.31-0.42 against it, and
# with "Everything" every one of them went unanswered (11,500 refusals in the log).
THRESHOLD = 0.30
THRESHOLD_LOW, THRESHOLD_HIGH = 0.25, 0.30
REJECT = 0.20
MARGIN = 0.1  # below the weakest of the owner's own enrollment clips
MIN_CLIPS = 3

OWNER, UNSURE, OTHER = "owner", "unsure", "other"


class Unavailable(RuntimeError):
    """The speaker model can't run here (missing, damaged, or onnxruntime failed)."""


# ── features ──

_MEL: dict[tuple[int, int], np.ndarray] = {}


def _mel_bank(bins: int, nfft: int, rate: int = SAMPLE_RATE) -> np.ndarray:
    key = (bins, nfft)
    if key not in _MEL:

        def mel(f: np.ndarray | float) -> np.ndarray:
            return 1127.0 * np.log1p(np.asarray(f, dtype=np.float64) / 700.0)

        low, high = mel(20.0), mel(rate / 2)
        centers = np.linspace(low, high, bins + 2)
        freqs = mel(np.arange(nfft // 2 + 1) * rate / nfft)
        bank = np.zeros((bins, nfft // 2 + 1), dtype=np.float32)
        for i in range(bins):
            left, mid, right = centers[i], centers[i + 1], centers[i + 2]
            up = (freqs - left) / (mid - left)
            down = (right - freqs) / (right - mid)
            bank[i] = np.clip(np.minimum(up, down), 0.0, None)
        _MEL[key] = bank
    return _MEL[key]


def fbank(audio: Any, bins: int = 80) -> np.ndarray:
    """[frames, bins] log-mel features of 16 kHz mono float audio, mean-normalised."""
    x = np.asarray(audio, dtype=np.float32).ravel() * 32768.0  # the int16 scale Kaldi uses
    frame, hop, nfft = 400, 160, 512
    if x.size < frame:
        return np.zeros((0, bins), dtype=np.float32)
    count = 1 + (x.size - frame) // hop
    index = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    frames = x[index]
    frames = frames - frames.mean(axis=1, keepdims=True)
    frames = np.concatenate(
        [frames[:, :1] * (1 - 0.97), frames[:, 1:] - 0.97 * frames[:, :-1]], axis=1
    )
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(frame) / (frame - 1))) ** 0.85
    power = np.abs(np.fft.rfft(frames * window, nfft)) ** 2
    feats = np.log(np.maximum(power @ _mel_bank(bins, nfft).T, np.finfo(np.float32).eps))
    feats -= feats.mean(axis=0, keepdims=True)
    return feats.astype(np.float32)


def unit(vector: Any) -> np.ndarray | None:
    v = np.asarray(vector, dtype=np.float32).ravel()
    norm = float(np.linalg.norm(v))
    if not v.size or not math.isfinite(norm) or norm == 0.0:
        return None
    return v / norm


def seconds(audio: Any) -> float:
    return float(getattr(audio, "size", 0) or 0) / SAMPLE_RATE


# ── the model ──


class OnnxEmbedder:
    """audio -> unit embedding, with the downloaded model. Thread-safe to call."""

    def __init__(self, path: Path) -> None:
        try:
            import onnxruntime
        except Exception as exc:  # pragma: no cover - it's a dependency
            raise Unavailable(f"onnxruntime isn't available ({exc})") from exc
        if not path.is_file():
            raise Unavailable("the voice model isn't downloaded")
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 2
        try:
            self.session = onnxruntime.InferenceSession(
                os.fspath(path), providers=["CPUExecutionProvider"], sess_options=opts
            )
        except Exception as exc:
            raise Unavailable(f"the voice model couldn't load ({exc})") from exc
        spec = self.session.get_inputs()[0]
        self.input = spec.name
        self.rank = len(spec.shape or [0, 0, 0])

    def __call__(self, audio: Any) -> np.ndarray | None:
        feats = fbank(audio)
        if feats.shape[0] < 10:
            return None
        batch = feats[None] if self.rank == 3 else feats
        out = self.session.run(None, {self.input: batch})[0]
        return unit(np.asarray(out)[0] if np.ndim(out) > 1 else out)


# ── the voiceprint ──


@dataclass
class Voiceprint:
    vector: np.ndarray
    threshold: float = THRESHOLD
    clips: int = 0
    made: float = 0.0

    def score(self, embedding: Any) -> float:
        v = unit(embedding)
        return float(np.dot(self.vector, v)) if v is not None else 0.0

    def matches(self, embedding: Any) -> bool:
        return self.score(embedding) >= self.threshold

    def judge(self, score: float) -> str:
        """OWNER, UNSURE or OTHER for a score (see THRESHOLD and REJECT)."""
        if score >= self.threshold:
            return OWNER
        return UNSURE if score >= min(REJECT, self.threshold) else OTHER

    def save(self, path: Path) -> None:
        jsonstore.save_json(
            path,
            {
                "vector": [round(float(x), 6) for x in self.vector],
                "threshold": round(self.threshold, 4),
                "clips": self.clips,
                "made": self.made,
            },
            backup=False,  # "Forget my voice" must leave no copy behind
        )

    @classmethod
    def load(cls, path: Path) -> Voiceprint | None:
        """The saved voiceprint, or None: missing, damaged or hand-edited into nonsense."""
        try:
            data, _how = jsonstore.read_json(path, dict)
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        try:
            vector = unit([float(x) for x in data.get("vector") or []])
            threshold = float(data.get("threshold", THRESHOLD))
            clips, made = int(data.get("clips") or 0), float(data.get("made") or 0)
        except (TypeError, ValueError):
            return None
        if vector is None or vector.size < 16 or not math.isfinite(threshold):
            return None
        threshold = min(max(threshold, THRESHOLD_LOW), THRESHOLD_HIGH)
        return cls(vector=vector, threshold=threshold, clips=clips, made=made)


def forget(path: Path) -> None:
    for p in (path, path.with_name(path.name + ".bak")):
        p.unlink(missing_ok=True)


def enroll(embeddings: list[Any]) -> Voiceprint:
    """The voiceprint of the owner's enrollment clips. Its threshold: a margin below how
    close the least typical of their own clips is to the others (leave one out), kept
    within the bounds above: clips from one sitting agree far more than the owner's live
    requests do, so the ceiling, not the clips, usually decides it."""
    vectors = [v for v in (unit(e) for e in embeddings) if v is not None]
    if len(vectors) < MIN_CLIPS:
        raise ValueError(f"need at least {MIN_CLIPS} clips, got {len(vectors)}")
    stack = np.stack(vectors)
    mean = unit(stack.mean(axis=0))
    assert mean is not None
    own = []
    for i in range(len(vectors)):
        rest = unit(np.delete(stack, i, axis=0).mean(axis=0))
        own.append(float(np.dot(stack[i], rest)) if rest is not None else 1.0)
    threshold = min(max(min(own) - MARGIN, THRESHOLD_LOW), THRESHOLD_HIGH)
    return Voiceprint(vector=mean, threshold=threshold, clips=len(vectors), made=time.time())


# ── the download ──

Fetch = Callable[[str], AsyncIterator[tuple[int, bytes]]]


async def _httpx_fetch(url: str) -> AsyncIterator[tuple[int, bytes]]:
    """(total bytes or 0, chunk) pairs of a download."""
    import httpx

    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0)
            async for chunk in response.aiter_bytes(1 << 16):
                yield total, chunk


async def download(
    dest: Path,
    model: dict[str, Any] | None = None,
    progress: Callable[[int, int], None] | None = None,
    fetch: Fetch | None = None,
) -> None:
    """Fetch the model to dest: to a .part file first, its SHA-256 checked before it's
    moved into place, so a cut or tampered download never becomes the model. Raises
    ValueError (not set up, too big, wrong checksum) or the fetch's own error."""
    model = model or SPEAKER_MODEL
    url, expected = str(model.get("url") or ""), str(model.get("sha256") or "").lower()
    size = int(model.get("size") or 0)
    if not url.startswith("https://") or len(expected) != 64:
        raise ValueError("the voice model isn't set up in this build")
    limit = max(size * 2, 1 << 20)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    digest, done = hashlib.sha256(), 0
    try:
        with part.open("wb") as out:
            async for total, chunk in (fetch or _httpx_fetch)(url):
                done += len(chunk)
                if done > limit:
                    raise ValueError("the voice model download is larger than expected")
                digest.update(chunk)
                out.write(chunk)
                if progress is not None:
                    progress(done, total or size)
        if digest.hexdigest() != expected:
            raise ValueError("the voice model download didn't match its checksum")
        os.replace(part, dest)
    finally:
        part.unlink(missing_ok=True)
