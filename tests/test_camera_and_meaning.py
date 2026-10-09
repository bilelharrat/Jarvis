"""Seeing through the camera (features/camera_look.py) and search by meaning on a PC (winembed)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np

from jarvis import embeddings, winembed
from jarvis.features import camera_look


def camera_hub(answer=None, available=True):
    emitted = []
    hub = SimpleNamespace(browser_available=available, emit=lambda kind, **d: emitted.append((kind, d)))
    cam = camera_look.Camera(hub)

    async def go(wait=1.0):
        task = asyncio.create_task(cam.snap(wait))
        await asyncio.sleep(0)
        if answer is not None:
            cam.result({"id": emitted[-1][1]["id"], **answer})
        return await task

    return cam, emitted, go


def test_one_picture_is_asked_of_the_window_and_comes_back_as_jpeg():
    cam, emitted, go = camera_hub({"image": "data:image/jpeg;base64,QUJD"})
    image, why = asyncio.run(go(3))
    assert (image, why) == ("QUJD", "")
    assert emitted[0][0] == "camera_cmd" and emitted[0][1]["wait"] == 3
    assert cam.calls == {}


def test_the_window_says_why_there_is_no_picture_and_waits_are_kept_short():
    _, emitted, go = camera_hub({"error": "No camera was found on this computer."})
    assert asyncio.run(go(99)) == ("", "No camera was found on this computer.")
    assert emitted[0][1]["wait"] == camera_look.WAIT_MAX
    _, emitted, go = camera_hub(available=False)
    image, why = asyncio.run(go())
    assert image == "" and "window" in why and emitted == []


def test_an_answer_for_another_picture_is_ignored():
    cam, _, _ = camera_hub()
    cam.result({"id": "nobody", "image": "x"})  # nothing waiting: no error


def test_the_prompt_reads_text_in_full_and_never_names_a_face():
    assert "word for word" in camera_look.PROMPT
    assert "Never say who a person is from their face" in camera_look.PROMPT


class FakeEncoding:
    def __init__(self, n):
        self.ids = list(range(1, n + 1)) + [0] * (4 - n)
        self.attention_mask = [1] * n + [0] * (4 - n)


class FakeTokenizer:
    def encode_batch(self, texts):
        return [FakeEncoding(min(4, len(t.split()))) for t in texts]


class FakeSession:
    def __init__(self):
        self.feeds = []

    def get_inputs(self):
        return [SimpleNamespace(name=n) for n in ("input_ids", "attention_mask", "token_type_ids")]

    def run(self, _outputs, feed):
        self.feeds.append(feed)
        b, t = feed["input_ids"].shape
        hidden = np.zeros((b, t, 384), dtype=np.float32)
        hidden[:, :, 0] = feed["input_ids"]  # a vector that depends on the words
        hidden[:, :, 1] = 1.0
        return [hidden]


def test_vectors_are_the_mean_of_the_words_unit_length_and_the_macs_size():
    session = FakeSession()
    emb = winembed.OnnxEmbedder(session=session, tokenizer=FakeTokenizer())
    out = emb.embed(["one two", "", "one two three four five"])
    assert out[1] == "empty"
    model, vec = out[0]
    assert model == winembed.MODEL and vec.shape == (embeddings.DIM,)
    assert abs(float(np.linalg.norm(vec)) - 1) < 1e-5 and float(np.abs(vec[384:]).sum()) == 0
    # padding never counts: "one two" is the mean of its two words only
    assert np.allclose(vec[:2] / vec[1], [1.5, 1.0])
    assert "token_type_ids" in session.feeds[0]


def test_a_failing_model_is_that_batchs_error_not_a_crash():
    class Broken(FakeSession):
        def run(self, *_):
            raise RuntimeError("bad")

    out = winembed.OnnxEmbedder(session=Broken(), tokenizer=FakeTokenizer()).embed(["a b"])
    assert out == ["error: the model failed"]


def test_without_the_models_files_there_is_no_embedder(tmp_path, monkeypatch):
    monkeypatch.setattr(winembed, "model_dir", lambda: tmp_path)
    assert winembed.model_ready() is False and winembed.embedder() is None
