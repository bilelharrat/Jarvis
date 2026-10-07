"""Speech that learns the owner's words: corrections, their own words, names as hints.
Everything in a temp folder; no microphone, no model, no Contacts."""

import asyncio
import json

import pytest

from jarvis import hearing
from jarvis.hearing import Hearing, best_span, diff_pairs, parse_correction, similarity


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def ear(tmp_path, clock):
    return Hearing(tmp_path / "hearing.json", clock=clock)


def said(ear, transcript, command=None):
    """A spoken request: transcribed (fix), then asked with the words after the wake word."""
    fixed = ear.fix(transcript)
    command = command if command is not None else fixed
    return ear.owner_said(command)


# ── reading a correction ──


@pytest.mark.parametrize(
    "text, meant, heard",
    [
        ("No, I said Okin", "Okin", ""),
        ("no I said Okin.", "Okin", ""),
        ("I meant Hormuz", "Hormuz", ""),
        ("I said Okin, not akin", "Okin", "akin"),
        ("No, it's Okin", "Okin", ""),
        ("not akin, Okin", "Okin", "akin"),
        ("Jarvis, no, I said “Okin”", "Okin", ""),
        ("no, I said Kai, K-A-I", "Kai", ""),
        ("我说的是欧金", "欧金", ""),
        ("不对，我说的是欧金，不是奥金", "欧金", "奥金"),
        ("不是奥金，是欧金", "欧金", "奥金"),
    ],
)
def test_parse_correction(text, meant, heard):
    assert parse_correction(text) == (meant, heard)


@pytest.mark.parametrize(
    "text",
    [
        "it's raining",  # "it's" only counts after a no
        "I mean, can you check the weather in Paris?",
        "call Okin",
        "",
        "not now",
        "No, it's fine, not a problem at all really because it was great",
    ],
)
def test_not_a_correction(text):
    assert parse_correction(text) is None


def test_similarity_hears_alike_sounds():
    assert similarity("akin", "Okin") >= 0.6
    assert similarity("for moose", "Hormuz") >= 0.6
    assert similarity("Tuesday", "Friday") < 0.6


def test_best_span_finds_the_misheard_words():
    prev = "what's happening in the strait of for moose"
    start, end = best_span(prev, "Hormuz")
    assert prev[start:end] == "for moose"
    assert best_span("call Okin", "Okin") is None  # heard right: nothing to fix
    assert best_span("what's the time", "Hormuz") is None


def test_diff_pairs():
    assert diff_pairs("call akin about the lease", "call Okin about the lease") == [
        ("akin", "Okin")
    ]
    assert diff_pairs("a b c d e f g", "totally different words entirely now and more") == []


# ── learning from what the owner says ──


def test_spoken_correction_is_learned_and_applied(ear):
    assert said(ear, "Jarvis, call akin about the lease", "call akin about the lease") is None
    fix = said(ear, "no, I said Okin")
    assert (fix.heard, fix.meant) == ("akin", "Okin")
    assert fix.corrected == "call Okin about the lease"
    assert "Okin" in fix.told() and "akin" in fix.told()
    assert "put right" in fix.note()
    assert ear.fix("text akin that I'm late") == "text Okin that I'm late"
    assert ear.fix("taking the bus") == "taking the bus"  # whole words only
    assert "Okin" in ear.hotwords()
    assert ear.hotwords().startswith("Jarvis ")


def test_explicit_heard_needs_no_likeness(ear):
    said(ear, "remind me about the for moose report")
    fix = said(ear, "I meant Hormuz, not for moose")
    assert (fix.heard, fix.meant) == ("for moose", "Hormuz")
    assert fix.corrected == "remind me about the Hormuz report"
    assert ear.apply("the For Moose strait") == "the Hormuz strait"


def test_restated_request_teaches_the_one_word(ear):
    said(ear, "call akin about the lease tomorrow")
    fix = said(ear, "I said call Okin about the lease tomorrow")
    assert (fix.heard, fix.meant) == ("akin", "Okin")
    assert fix.corrected == "call Okin about the lease tomorrow"


def test_changed_mind_is_not_a_mishearing(ear):
    said(ear, "book the room for Tuesday at ten")
    assert said(ear, "I said book the room for Friday at ten") is None
    assert ear.corrections == {}


def test_typed_correction_of_a_spoken_request(ear):
    said(ear, "email akin the deck")
    fix = ear.owner_said("no, I said Okin")  # typed: never transcribed
    assert fix is not None and fix.via == "typed"
    assert ear.apply("akin") == "Okin"


def test_old_request_is_not_corrected(ear, clock):
    said(ear, "call akin")
    clock.t += hearing.CORRECTION_SECONDS + 1
    assert said(ear, "no, I said Okin").heard == ""  # the word alone, no mapping
    assert ear.corrections == {}
    assert "Okin" in ear.hotwords()


def test_filler_is_not_learned(ear):
    said(ear, "what's on my calendar")
    assert said(ear, "I mean the weather") is None
    assert not ear.corrections and "weather" not in ear.words


def test_saying_it_back_undoes_it(ear):
    said(ear, "call akin")
    said(ear, "no, I said Okin")
    assert ear.apply("akin") == "Okin"
    said(ear, "call Okin")
    said(ear, "no, I said akin, not Okin")
    assert ear.apply("akin") == "akin"
    assert ear.corrections == {}


def test_common_word_needs_two_corrections(ear):
    ear.correct("to", "Tao")
    assert ear.apply("go to bed") == "go to bed"
    ear.correct("to", "Tao")
    assert ear.apply("go to bed") == "go Tao bed"


def test_corrections_in_force_are_worked_out_once_per_look(ear, monkeypatch):
    """describe() marks the corrections not yet in force (a common word needs two) from one
    look at them, not one per correction (300 of them took a sixth of a second), and
    apply() looks once too; what they say is unchanged."""
    ear.correct("to", "Tao")
    ear.correct("akin", "Okin")
    ear.correct("for moose", "Hormuz")
    looks = []
    real = Hearing._active
    monkeypatch.setattr(Hearing, "_active", lambda self: looks.append(1) or real(self))
    assert ear.describe() == (
        "Corrections I apply: “for moose” → “Hormuz”; “akin” → “Okin”; “to” → “Tao” (needs "
        "one more). Words I listen for: Tao, Okin, Hormuz."
    )
    assert len(looks) == 1
    looks.clear()
    assert ear.apply("go to Akin about for moose") == "go to Okin about Hormuz"
    assert len(looks) == 1
    ear.correct("to", "Tao")  # the second time: in force from now on
    assert ear.apply("go to bed") == "go Tao bed"
    assert "(needs one more)" not in ear.describe()


def test_wake_word_is_never_learned(ear):
    with pytest.raises(ValueError):
        ear.correct("service", "Jarvis")
    with pytest.raises(ValueError):
        ear.correct("Jarvis", "Travis")
    assert ear.apply("Jarvis, call Travis") == "Jarvis, call Travis"


def test_chinese_correction(tmp_path, clock):
    ear = Hearing(tmp_path / "h.json", clock=clock, lang=lambda: "zh")
    said(ear, "给奥金打电话")
    fix = said(ear, "不对，我说的是欧金")
    assert (fix.heard, fix.meant) == ("奥金", "欧金")
    assert ear.apply("明天见奥金") == "明天见欧金"
    assert "欧金" in fix.told("zh")


def test_edit_in_the_window(ear):
    ear.fix("send the draft to akin")
    learned = ear.learn_edit("send the draft to akin", "send the draft to Okin")
    assert [(c.heard, c.meant) for c in learned] == [("akin", "Okin")]
    # a rewrite, a changed mind, or text that was never heard teaches nothing
    ear.fix("meet on Tuesday")
    assert ear.learn_edit("meet on Tuesday", "meet on Friday") == []
    assert ear.learn_edit("something never heard", "something never Okin") == []


def test_words_the_owner_uses_become_hints(ear):
    for _ in range(hearing.SAID_ENOUGH):
        ear.owner_said("what's new with Zainar and the Q3 plan")
    hints = ear.hotwords()
    assert "Zainar" in hints and "Q3" in hints
    assert "What's" not in hints and "the" not in hints.split()


def test_seeds_are_hints_never_corrections(ear):
    ear.seed("calendar", ["Priya Raman", "ann@zainar.com", "Jarvis", "the"])
    ear.seed("contacts", ["Bob Chen", "Dmitri Ivanov"])
    hints = ear.hotwords()
    assert "Priya Raman" in hints and "ann" in hints
    assert "Dmitri" not in hints  # a contact only once the owner has said them
    for _ in range(1):
        ear.owner_said("text Dmitri I'm late")
    assert "Dmitri Ivanov" in ear.hotwords()
    assert ear.apply("Priya") == "Priya" and not ear.corrections


def test_hotwords_are_capped(ear):
    for i in range(80):
        ear.teach(f"Name{i}x")
    hints = ear.hotwords()
    assert len(hints.split()) <= hearing.HOTWORDS
    assert len(hints) <= hearing.HOTWORD_CHARS
    assert hints.split()[0] == "Jarvis"
    zh = ear.hotwords(base="贾维斯")
    assert zh.startswith("贾维斯")


def test_off_learns_and_changes_nothing(tmp_path, clock):
    on = [True]
    ear = Hearing(tmp_path / "h.json", clock=clock, enabled=lambda: on[0])
    ear.correct("akin", "Okin")
    on[0] = False
    assert ear.apply("akin") == "akin"
    assert ear.hotwords() == "Jarvis"
    assert ear.owner_said("no, I said Zed") is None


def test_saved_and_read_back(tmp_path, clock):
    path = tmp_path / "hearing.json"
    ear = Hearing(path, clock=clock)
    ear.correct("akin", "Okin")
    ear.teach("Hormuz")
    data = json.loads(path.read_text())
    assert data["corrections"]["akin"]["meant"] == "Okin"
    again = Hearing(path, clock=clock)
    assert again.apply("akin") == "Okin"
    assert "Hormuz" in again.hotwords()


def test_usage_counts_are_saved_in_batches(tmp_path, clock):
    path = tmp_path / "hearing.json"
    ear = Hearing(path, clock=clock)
    ear.owner_said("ping Zainar")
    ear.owner_said("ping Zainar again")  # within the minute: not yet
    first = json.loads(path.read_text())["words"]["zainar"]["count"]
    clock.t += hearing.SAVE_EVERY + 1
    ear.owner_said("ping Zainar")
    assert json.loads(path.read_text())["words"]["zainar"]["count"] > first


def test_damaged_file_is_kept_aside(tmp_path, clock):
    path = tmp_path / "hearing.json"
    path.write_text("{not json")
    ear = Hearing(path, clock=clock)
    assert ear.corrections == {}
    ear.correct("akin", "Okin")
    assert Hearing(path, clock=clock).apply("akin") == "Okin"
    assert list(tmp_path.glob("hearing.json.bad-*"))


def test_caps(ear):
    for i in range(hearing.MAX_CORRECTIONS + 20):
        ear.corrections[f"heard{i}"] = {"meant": f"Meant{i}", "count": 1, "at": "", "via": "x"}
    ear.correct("akin", "Okin")
    assert len(ear.corrections) <= hearing.MAX_CORRECTIONS
    assert "akin" in ear.corrections
    for i in range(hearing.MAX_WORDS + 50):
        ear.owner_said(f"call Person{i}x")
    assert len(ear.words) <= hearing.MAX_WORDS
    assert "okin" in ear.words  # a corrected word outlasts ones said once


def test_forget_and_describe(ear):
    ear.correct("akin", "Okin")
    assert "“akin” → “Okin”" in ear.describe()
    assert ear.forget("Okin")
    assert ear.apply("akin") == "akin"
    assert ear.describe() == "Nothing learned yet."
    assert ear.public() == {"corrections": [], "words": []}


def test_tools_are_gated(ear):
    asked = []

    async def gate(action, question):
        asked.append((action, question))
        return action == "learn_word"

    tools = {t.name: t for t in hearing.build_tools(ear, gate)}
    out = asyncio.run(tools["learn_word"].handler({"word": "Hormuz", "sounds_like": "for moose"}))
    assert "Learned" in out["content"][0]["text"]
    assert asked[0] == ("learn_word", "Learn to hear “for moose” as “Hormuz”?")
    assert ear.apply("for moose") == "Hormuz"
    out = asyncio.run(tools["forget_word"].handler({"what": "Hormuz"}))
    assert out.get("is_error")  # the gate said no
    assert ear.apply("for moose") == "Hormuz"
    listed = asyncio.run(tools["learned_words"].handler({}))
    assert "Hormuz" in listed["content"][0]["text"]


def test_dictation_edited_before_sending(ear):
    ear.fix("tell akin the deck is ready")  # the composer's mic
    assert ear.owner_said("tell Okin the deck is ready") is None  # typed, after fixing it
    assert ear.apply("akin") == "Okin"
    ear.fix("lunch on Tuesday")
    ear.owner_said("lunch on Friday")  # a changed mind teaches nothing
    assert ear.apply("Tuesday") == "Tuesday"
    ear.fix("play some jazz")
    ear.owner_said("what's the weather in Paris tomorrow")  # something else entirely
    assert set(ear.corrections) == {"akin"}


def test_names_in_memory_facts():
    names = hearing.names_in(
        ["Ann Lee is the user's co-founder.", "The user meets Priya at Zainar on Mondays."]
    )
    assert "Ann Lee" not in names  # a sentence's first word could be anything
    assert {"Lee", "Priya", "Zainar", "Mondays"} <= set(names)


def test_spelled_out_letters_are_the_word():
    """Spelled-out letters are the word, however they come: after the word, after "spelled",
    alone, and at the end of a correction. They start a word of their own: "spelled K-A-I"
    was learned as "dKAI" (the d of spelled taken for a letter), "O K I N" as "Kin" and
    "Okin O K I N" as "nOKIN"."""
    assert hearing._spelled("Okin, O-K-I-N") == "Okin"
    assert hearing._spelled("Kai, spelled K-A-I") == "Kai"
    assert hearing._spelled("spelled K-A-I") == hearing._spelled("Spelled K-A-I") == "Kai"
    assert hearing._spelled("spelt O K I N") == hearing._spelled("that's O-K-I-N.") == "Okin"
    assert hearing._spelled("O K I N") == hearing._spelled("Okin O K I N") == "Okin"
    assert hearing._spelled("Hormuz H O R M U Z") == "Hormuz"
    assert hearing._spelled("k.a.i") == "kai"  # lowercase letters keep their case
    assert hearing._spelled("Okin") == "Okin"  # nothing spelled: as it was
    assert hearing._spelled("Okin O O") == "Okin O O"  # two letters spell nothing
    assert hearing._spelled("A B C") == "Abc"
    assert parse_correction("no, I said Kai, K A I") == ("Kai", "")
    assert parse_correction("no, I said Okin O K I N") == ("Okin", "")


def test_an_initialism_written_with_its_periods_is_kept(ear):
    """Letters with a period after each one are an initialism as it's written, never a word
    spelled out: "W.H.O." isn't the common word who (which can't be learned), "R.E.M." isn't
    Rem, and four letters don't lose the first ("N.A.S.A." was learned as Asa). Spelled-out
    letters with a full stop after them, or after "spelled", are still the word."""
    for written in ("W.H.O.", "R.E.M.", "U.S.A.", "S.O.S.", "U. S. A.", "N.A.S.A."):
        assert hearing._spelled(written) == written
    assert ear.teach("W.H.O.") == "W.H.O"
    assert ear.teach("N.A.S.A.") == "N.A.S.A"
    assert ear.correct("are am", "R.E.M.").meant == "R.E.M"
    assert hearing._spelled("O-K-I-N.") == hearing._spelled("O K I N.") == "Okin"
    assert hearing._spelled("O. K-I N.") == "Okin"  # one gap without a period: spelled
    assert hearing._spelled("spelled R.E.M.") == "Rem"


def test_a_long_word_from_a_tool_is_read_in_no_time(ear):
    """The learn_word tool's word can be any length: letters and spaces that end in
    something else took time with the square of their length (a third of a second for 4 KB,
    seconds for more, on the event loop). Past a sentence's length nothing is spelled."""
    import time

    hostile = "a " * 20_000 + "!!"
    started = time.thread_time()
    assert hearing._spelled(hostile) == hostile
    tools = {t.name: t for t in hearing.build_tools(ear)}
    out = asyncio.run(tools["learn_word"].handler({"word": hostile}))
    assert time.thread_time() - started < 0.5
    assert out["content"][0]["text"].startswith("Learned the word")  # its first 40 characters


def test_hints_are_read_from_a_copy_while_a_request_counts_words(ear):
    """The hub asks for the hints from a transcription's thread while a request on the
    event loop may be counting the owner's words: they're read from a copy of the words
    taken at once, so a word added meanwhile never ends the transcription with "dictionary
    changed size during iteration"."""

    class Busy(dict):
        """A word whose first look adds another, as the loop's thread could meanwhile."""

        def __getitem__(self, key):
            if key == "why" and "zainar" not in ear.words:
                ear.words["zainar"] = {"word": "Zainar", "count": 1, "at": "", "why": "said"}
            return super().__getitem__(key)

    ear.teach("Okin")
    ear.words["okin"] = Busy(ear.words["okin"])
    assert ear.hotwords() == "Jarvis Okin"
    assert "zainar" in ear.words  # added while the hints were read, and harmlessly


def test_settings_and_the_tool_show_the_same_words_listened_for(ear):
    """The words it listens for, the most used first: taught and corrected ones, and those
    the owner said often enough; a name said once isn't one yet."""
    ear.teach("Okin")
    for _ in range(hearing.SAID_ENOUGH):
        ear.owner_said("call Zainar now")
    ear.owner_said("meet Priya")
    assert ear.public()["words"] == [
        {"word": "Okin", "count": hearing.SAID_ENOUGH + 1, "why": "taught"},
        {"word": "Zainar", "count": hearing.SAID_ENOUGH, "why": "said"},
    ]
    assert ear.describe() == "Words I listen for: Okin, Zainar."
    assert ear.describe("zai") == "Words I listen for: Zainar."
    assert ear.describe("priya") == "Nothing learned about that yet."
