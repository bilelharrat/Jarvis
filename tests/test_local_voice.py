"""JARVIS's offline voice: its phonemes (local_phonemes.py), the model (local_voice.py,
with a fake ONNX session) and the checked download (fake). No model, no network, no audio."""

import hashlib
import json
import time
from types import SimpleNamespace

import numpy as np
import pytest

from jarvis import local_phonemes as lp
from jarvis import local_voice

GOLD = {
    "hello": "həlˈO",
    "this": "ðˈɪs",
    "is": "ˈɪz",
    "jarvis": "ʤˈɑɹvɪs",
    "Jarvis": "ʤˈɑɹvɪs",
    "the": "ðə",
    "meeting": "mˈiɾɪŋ",
    "at": "ˈæt",
    "three": "θɹˈi",
    "thirty": "θˈɜɹɾi",
    "tomorrow": "təmˈɑɹO",
    "voice": "vˈYs",
    "print": "pɹˈɪnt",
    "book": "bˈʊk",
    "wait": "wˈAt",
    "make": "mˈAk",
    "stop": "stˈɑp",
    "cat": "kˈæt",
    "to": "tə",
    "have": "hˈæv",
    "i": "ˈI",
    "read": {"DEFAULT": "ɹˈid", "VBD": "ɹˈɛd", "VBN": "ɹˈɛd", "NOUN": None},
    "record": {"DEFAULT": "ɹᵻkˈɔɹd", "NOUN": "ɹˈɛkɚd", "VERB": "ɹᵻkˈɔɹd"},
    "my": "mˈI",
    "apple": "ˈæpəl",
    "orange": "ˈɔɹɪnʤ",
    "N": "ˈɛn",
    "A": "ˈA",
    "S": "ˈɛs",
    "plan": "plˈæn",
    "one": "wˈʌn",
    "two": "tˈu",
}
SILVER = {"yes": "jˈɛs", "done": "dˈʌn", "all": "ˈɔl", "now": "nˈW", "later": "lˈAɾɚ"}


@pytest.fixture
def lexicon():
    return lp.Lexicon(GOLD, SILVER)


# ── words and numbers ──


def test_numbers_money_times_and_abbreviations_become_words():
    said = lp.normalize("Dr. Smith paid $42.50 at 3:30 pm. It's 2026; 12,500 people, 45%.")
    assert said == (
        "Doctor Smith paid forty-two dollars and fifty cents at three thirty PM. It's twenty"
        " twenty-six; twelve thousand five hundred people, forty-five percent."
    )
    assert lp.normalize("the 21st at 7am, £1 and 3.14") == (
        "the twenty-first at seven AM, one pound and three point one four"
    )
    assert lp.normalize("$1.2m and 9:05") == "one point two million dollars and nine oh five"
    assert lp.normalize("£2.50 and £0.01") == "two pounds and fifty pence and one penny"
    assert lp.number_words(1_000_001) == "one million one"
    assert lp.ordinal_words(12) == "twelfth" and lp.ordinal_words(40) == "fortieth"
    assert lp.year_words(1905) == "nineteen oh five" and lp.year_words(2000) == "two thousand"


def test_words_come_from_the_lexicon_gold_before_silver(lexicon):
    found, unknown = lp.phonemize("Hello, this is Jarvis. Yes!", lexicon)
    assert unknown == []
    assert found == "həlˈO, ðˈɪs ˈɪz ʤˈɑɹvɪs. jˈɛs!"


def test_heteronyms_follow_the_word_before(lexicon):
    assert lp.phonemize("I read.", lexicon)[0] == "ˈI ɹˈid."
    assert lp.phonemize("I have read", lexicon)[0] == "ˈI hˈæv ɹˈɛd"
    assert lp.phonemize("my record", lexicon)[0] == "mˈI ɹˈɛkɚd"
    assert lp.phonemize("to record", lexicon)[0] == "tə ɹᵻkˈɔɹd"


def test_articles_suffixes_compounds_and_acronyms(lexicon):
    assert lp.phonemize("the apple", lexicon)[0] == "ði ˈæpəl"  # before a vowel
    assert lp.phonemize("the cat", lexicon)[0] == "ðə kˈæt"
    assert lp.phonemize("a cat, plan A.", lexicon)[0] == "ɐ kˈæt, plˈæn ˈA."
    assert lp.phonemize("cats books", lexicon)[0] == "kˈæts bˈʊks"
    assert lp.phonemize("oranges", lexicon)[0] == "ˈɔɹɪnʤᵻz"
    assert lp.phonemize("waited stopped", lexicon)[0] == "wˈAtᵻd stˈɑpt"
    assert lp.phonemize("making", lexicon)[0] == "mˈAkɪŋ"
    assert lp.phonemize("voiceprint", lexicon)[0] == "vˈYspɹˌɪnt"
    assert lp.phonemize("NSA", lexicon)[0] == "ˈɛn ˈɛs ˈA"
    british = lp.Lexicon(GOLD, SILVER, british=True)
    assert lp.phonemize("oranges", british)[0] == "ˈɔɹɪnʤɪz"


def test_an_unknown_word_leaves_the_sentence_to_the_mac_voice(lexicon):
    found, unknown = lp.phonemize("Hello Bilel.", lexicon)
    assert found is None and unknown == ["Bilel"]


def test_tokens_and_long_sentences():
    ids = lp.token_ids("həlˈO, wˈʌn!")
    assert ids[:3] == [lp.VOCAB["h"], lp.VOCAB["ə"], lp.VOCAB["l"]] and 0 not in ids
    assert lp.token_ids("h☃") == [lp.VOCAB["h"]]  # unknown symbols dropped
    long = ", ".join(["həlˈO wˈʌn tˈu"] * 60)
    pieces = lp.chunks(long, limit=100)
    assert all(len(lp.token_ids(p)) <= 100 for p in pieces)
    assert " ".join(pieces).replace(" ", "") == long.replace(" ", "")


def test_the_lexicon_files_are_read_defensively(tmp_path):
    (tmp_path / "g.json").write_text(json.dumps(GOLD), encoding="utf-8")
    (tmp_path / "s.json").write_text("[1, 2]", encoding="utf-8")
    with pytest.raises(ValueError):
        lp.Lexicon.load(tmp_path / "g.json", tmp_path / "s.json")


# ── the model (a fake ONNX session) ──


class FakeSession:
    """Kokoro's inputs; audio as long as the tokens (100 samples each). delay: seconds
    per token, like a model that takes longer for a longer sentence."""

    def __init__(self, delay=0.0, fail=False, speed_type="tensor(float)"):
        self.delay, self.fail, self.calls = delay, fail, []
        self.speed_type = speed_type

    def get_inputs(self):
        return [
            SimpleNamespace(name="input_ids", type="tensor(int64)", shape=[1, "n"]),
            SimpleNamespace(name="style", type="tensor(float)", shape=[1, 256]),
            SimpleNamespace(name="speed", type=self.speed_type, shape=[1]),
        ]

    def run(self, _outputs, feed):
        if self.fail:
            raise RuntimeError("onnx went wrong")
        tokens = feed["input_ids"]
        self.calls.append(feed)
        time.sleep(self.delay * tokens.shape[1])
        return [np.full((1, 100 * tokens.shape[1]), 0.25, dtype=np.float32)]


def voice_files(folder, voices=("bm_george", "af_heart", "am_michael")):
    """The offline voice's files as a download would leave them (fakes), and a files
    table whose checksums match them."""
    folder.mkdir(parents=True, exist_ok=True)
    contents = {"kokoro.onnx": b"fake model"}
    for v in voices:
        contents[f"{v}.bin"] = np.arange(510 * 256, dtype="<f4").tobytes()
    for accent in ("us", "gb"):
        contents[f"{accent}_gold.json"] = json.dumps(GOLD).encode()
        contents[f"{accent}_silver.json"] = json.dumps(SILVER).encode()
    files = {
        name: {
            "url": f"https://example.test/{name}",
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        }
        for name, data in contents.items()
    }
    return contents, files


def fake_engine(folder, **session):
    contents, files = voice_files(folder)
    for name, data in contents.items():
        (folder / name).write_bytes(data)
    fake = FakeSession(**session)
    made = local_voice.Engine(folder, lambda _path: fake, files)
    made.fake = fake
    return made


def fake_fetch(contents, fail_on=None):
    async def fetch(url):
        name = url.rsplit("/", 1)[1]
        data = b"tampered" if name == fail_on else contents[name]
        for i in range(0, len(data), 7):
            yield len(data), data[i : i + 7]

    return fetch


@pytest.fixture
def engine(tmp_path):
    return fake_engine(tmp_path)


def test_the_engine_feeds_kokoro_its_tokens_style_and_speed(engine):
    audio = engine.synthesize("həlˈO", "bm_george", 1.1)
    feed = engine.fake.calls[0]
    ids = lp.token_ids("həlˈO")
    assert feed["input_ids"].tolist() == [[0, *ids, 0]] and feed["input_ids"].dtype == np.int64
    style = np.arange(510 * 256, dtype=np.float32).reshape(510, 256)[len(ids)]
    assert np.array_equal(feed["style"][0], style)  # the row for this many tokens
    assert feed["speed"].dtype == np.float32 and feed["speed"][0] == pytest.approx(1.1)
    assert audio.dtype == np.float32 and audio.size == 100 * (len(ids) + 2)


def test_an_older_export_takes_its_speed_as_an_integer(tmp_path):
    engine = fake_engine(tmp_path, speed_type="tensor(int32)")
    engine.synthesize("həlˈO", "af_heart", 1)
    assert engine.fake.calls[0]["speed"].dtype == np.int32


def test_a_model_without_kokoros_inputs_is_refused(engine):
    engine.fake.get_inputs = lambda: [SimpleNamespace(name="x", type="tensor(float)", shape=[1])]
    with pytest.raises(local_voice.Unavailable):
        engine.session()


def test_a_damaged_voice_file_is_refused(engine):
    (engine.folder / "af_heart.bin").write_bytes(b"\0" * 10)
    with pytest.raises(local_voice.Unavailable):
        engine.style("af_heart")


async def test_it_speaks_sentence_by_sentence_and_hands_the_mac_what_it_cant(engine):
    voice = local_voice.LocalVoice(engine, "af_heart")
    got = [
        (kind, v if kind == "mac" else v.size)
        async for kind, v in voice.pieces("Hello, this is Jarvis. Hello Bilel. Yes, done.")
    ]
    assert [k for k, _ in got] == ["audio", "mac", "audio"]
    assert got[1][1] == "Hello Bilel."
    assert len(engine.fake.calls) == 2


async def test_a_failing_model_hands_the_rest_to_the_mac_voice(engine):
    engine.fake.fail = True
    voice = local_voice.LocalVoice(engine)
    got = [piece async for piece in voice.pieces("Hello. This is Jarvis.")]
    assert got == [("mac", "Hello. This is Jarvis.")]
    assert "onnx went wrong" in engine.error


def test_it_speaks_english_only(engine):
    voice = local_voice.LocalVoice(engine)
    assert voice.speaks("Hello there.") and not voice.speaks("你好，我是贾维斯。")
    (engine.folder / "kokoro.onnx").unlink()
    assert not voice.speaks("Hello there.")  # removed since: the Mac voice


async def test_the_first_words_come_before_the_rest_is_made(engine):
    """Time to first audio: one sentence's synthesis, not the whole reply's."""
    engine.fake.delay = 0.002  # 2 ms a token: ~40-70 ms a sentence here
    voice = local_voice.LocalVoice(engine)
    text = "Hello, this is Jarvis. The meeting is at three thirty tomorrow. Yes, all done now."
    start = time.perf_counter()
    first = None
    async for _kind, _audio in voice.pieces(text):
        first = first or time.perf_counter() - start
    total = time.perf_counter() - start
    assert len(engine.fake.calls) == 3
    assert first < total * 0.5, (first, total)


# ── the download ──


async def test_the_download_fetches_every_file_and_checks_each(tmp_path):
    contents, files = voice_files(tmp_path / "src")
    store = local_voice.Store(tmp_path / "voice", files)
    store.fetch = fake_fetch(contents)
    assert await store.download(lambda: None)
    assert store.ready() and store.downloading is None and store.error == ""
    assert (tmp_path / "voice" / "us_gold.json").read_bytes() == contents["us_gold.json"]
    store.remove()
    assert not store.ready() and not any((tmp_path / "voice").iterdir())


async def test_a_file_that_doesnt_match_its_checksum_is_not_kept(tmp_path):
    contents, files = voice_files(tmp_path / "src")
    store = local_voice.Store(tmp_path / "voice", files)
    store.fetch = fake_fetch(contents, fail_on="us_gold.json")
    assert not await store.download()
    assert "checksum" in store.error and not store.ready()
    assert not (tmp_path / "voice" / "us_gold.json").exists()


async def test_nothing_downloads_until_this_build_knows_every_checksum(tmp_path):
    store = local_voice.Store(tmp_path)
    store.fetch = fake_fetch({})
    assert not local_voice.configured()  # the lexicons' checksums aren't pinned yet
    assert not await store.download()
    assert store.error == "The offline voice isn’t set up in this build."
    model = local_voice.OFFLINE_VOICE_FILES["kokoro.onnx"]
    assert model["url"].startswith("https://") and len(model["sha256"]) == 64
