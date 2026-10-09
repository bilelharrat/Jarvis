"""Search by meaning on a PC: the second brain's passages as vectors from a small multilingual
sentence model run on this computer with ONNX Runtime (already in the app for speech), in place
of the Mac's Apple models (embeddings.HelperEmbedder and its Swift helper).

- The model is paraphrase-multilingual-MiniLM-L12-v2 (50+ languages, English and Arabic among
  them), quantized to 8 bits: about 120 MB, fetched once from Hugging Face into the app's data
  folder, and only after the owner turns Search by meaning on (ensure_model). Nothing else is
  ever downloaded, and no text leaves the computer: the vectors are made here.
- A passage becomes the mean of its token vectors (the model's own pooling), made unit length
  and padded with zeros to embeddings.DIM, so the vectors file, the search and the links are
  the Mac's, unchanged (zeros change no cosine). Its space is named MODEL, so these vectors are
  only ever compared with each other.
- Anything missing (no model yet, a file that won't load) gives no embedder: searches go on by
  words, exactly as before.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("jarvis")

REPO = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MODEL_FILE = "onnx/model_quint8_avx2.onnx"
TOKENIZER_FILE = "tokenizer.json"
MODEL = "minilm-l12-multilingual"  # the vectors' space (embeddings: one model, one space)
MAX_TOKENS = 256  # what the model was trained on; longer passages are cut
BATCH = 16


def model_dir() -> Path:
    from .prefs import APP_SUPPORT

    return APP_SUPPORT / "models" / "meaning"


def model_ready(folder: Path | None = None) -> bool:
    folder = folder or model_dir()
    return (folder / MODEL_FILE).is_file() and (folder / TOKENIZER_FILE).is_file()


def ensure_model(folder: Path | None = None) -> bool:
    """The model's two files, fetched once (only ever called after the owner turned Search by
    meaning on). True when they are here."""
    folder = folder or model_dir()
    if model_ready(folder):
        return True
    from huggingface_hub import hf_hub_download

    folder.mkdir(parents=True, exist_ok=True)
    for name in (TOKENIZER_FILE, MODEL_FILE):
        hf_hub_download(REPO, name, local_dir=str(folder))
    return model_ready(folder)


class OnnxEmbedder:
    """embeddings.Embedder on ONNX Runtime: texts in, (MODEL, unit vector) out."""

    def __init__(self, folder: Path | None = None, *, session: Any = None, tokenizer: Any = None) -> None:
        folder = folder or model_dir()
        if session is None:
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = 2  # (a background job: the rest of the app stays quick)
            session = ort.InferenceSession(str(folder / MODEL_FILE), options, providers=["CPUExecutionProvider"])
        if tokenizer is None:
            from tokenizers import Tokenizer

            tokenizer = Tokenizer.from_file(str(folder / TOKENIZER_FILE))
            tokenizer.enable_truncation(max_length=MAX_TOKENS)
            tokenizer.enable_padding()
        self.session = session
        self.tokenizer = tokenizer
        self.inputs = {i.name for i in session.get_inputs()}
        self._lock = threading.Lock()

    def embed(self, texts: list[str], timeout: float | None = None) -> list[Any]:
        from .embeddings import DIM, EMBED_CHARS

        out: list[Any] = []
        for start in range(0, len(texts), BATCH):
            batch = [str(t or "")[:EMBED_CHARS] for t in texts[start : start + BATCH]]
            keep = [i for i, t in enumerate(batch) if t.strip()]
            answers: list[Any] = ["empty"] * len(batch)
            if keep:
                try:
                    vecs = self._vectors([batch[i] for i in keep])
                except Exception as exc:  # one bad batch is that batch's error, not the rebuild's
                    log.warning("search by meaning: the model failed on %d passages (%s)", len(keep), exc)
                    vecs = None
                for n, i in enumerate(keep):
                    if vecs is None:
                        answers[i] = "error: the model failed"
                        continue
                    v = np.zeros(DIM, dtype=np.float32)
                    size = min(DIM, vecs.shape[1])
                    v[:size] = vecs[n, :size]
                    norm = float(np.linalg.norm(v))
                    answers[i] = (MODEL, v / norm) if norm > 0 and np.isfinite(norm) else "error: an empty vector"
            out.extend(answers)
        return out

    def _vectors(self, texts: list[str]) -> np.ndarray:
        encoded = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in encoded], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        with self._lock:
            hidden = self.session.run(None, {k: v for k, v in feed.items() if k in self.inputs})[0]
        weights = mask[..., None].astype(np.float32)
        summed = (np.asarray(hidden, dtype=np.float32) * weights).sum(axis=1)
        return summed / np.clip(weights.sum(axis=1), 1e-9, None)

    def close(self) -> None:
        self.session = None


def embedder() -> OnnxEmbedder | None:
    """The model ready to use, or None (not fetched yet, or it won't load)."""
    if not model_ready():
        return None
    try:
        return OnnxEmbedder()
    except Exception as exc:
        log.warning("search by meaning: the model would not load (%s)", exc)
        return None
