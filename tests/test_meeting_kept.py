"""Meeting.kept() works out each line's words and each echo comparison once and keeps them
for its next call (the panel asks every two seconds). What it returns must stay exactly what
comparing everything afresh gives, however the lines change between calls."""

import bisect
import difflib
import random
from datetime import datetime, timedelta

from jarvis import meeting as meeting_module
from jarvis.meeting import ECHO_ALIKE, ECHO_SECONDS, Meeting, _alike, _plain


def fresh(m: Meeting) -> list[tuple[datetime, str, str]]:
    """kept() as it was before anything was kept between calls."""
    speakers = m.speakers[: len(m.lines)]
    speakers += [m.label] * (len(m.lines) - len(speakers))
    rows = [(at, text, who) for (at, text), who in zip(m.lines, speakers, strict=True) if text]
    them = sorted((at, _plain(text)) for at, text, who in rows if who == "Them")
    if not them:
        return rows
    times = [at for at, _ in them]
    window = timedelta(seconds=ECHO_SECONDS)
    kept = []
    for at, text, who in rows:
        said = _plain(text)
        if who == "You" and len(said) >= 8:
            lo, hi = bisect.bisect_left(times, at - window), bisect.bisect_right(times, at + window)
            if any(
                difflib.SequenceMatcher(None, said, line).ratio() >= ECHO_ALIKE
                for _, line in them[lo:hi]
            ):
                continue
        kept.append((at, text, who))
    return kept


WORDS = (
    "we should ship the release on friday and then look at the budget numbers for next "
    "quarter because pricing matters to customers who asked about it can everyone see my "
    "screen"
).split()


def sentence(rng: random.Random) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(2, 14))).capitalize() + "."


def test_the_same_rows_as_comparing_afresh_while_the_lines_change(tmp_path):
    rng = random.Random(7)
    m = Meeting("Call", tmp_path, now=datetime(2026, 10, 4, 10, 0))
    m.label = "You"
    at = datetime(2026, 10, 4, 10, 0)
    for step in range(400):
        at += timedelta(seconds=rng.choice((0, 1, 2, 3, 5, 9)))
        roll = rng.random()
        if roll < 0.35:
            m.add(None, sentence(rng), at, speaker="Them")
        elif roll < 0.55 and m.lines:  # the call's line, heard back through the speakers
            heard = [t for (_a, t), w in zip(m.lines, m.speakers, strict=False) if w == "Them"]
            echo = rng.choice(heard or ["nothing yet"]).lower().rstrip(".")
            m.add(None, echo, at + timedelta(seconds=rng.choice((-20, -1, 1, 3, 14, 16))))
        elif roll < 0.75:
            m.add(None, sentence(rng), at)
        elif roll < 0.85 and m.lines:  # the notes model's better line
            index = rng.randrange(len(m.lines))
            m.lines[index] = (m.lines[index][0], sentence(rng))
        elif roll < 0.92 and m.lines:  # taken out as JARVIS's own words (meeting_agent)
            index = rng.randrange(len(m.lines))
            m.lines[index] = (m.lines[index][0], "")
        else:  # a line added directly, with no speaker kept
            m.lines.append((at, sentence(rng)))
        if step % 7 == 0:
            assert m.kept() == fresh(m)
    assert m.kept() == fresh(m) == m.kept()
    assert any(who == "You" for _at, _text, who in m.kept())
    assert len(m.kept()) < len([t for _a, t in m.lines if t])  # some echoes were left out


def test_what_is_kept_between_calls_follows_the_lines(tmp_path):
    m = Meeting("Call", tmp_path, now=datetime(2026, 10, 4, 10, 0))
    m.label = "You"
    at = datetime(2026, 10, 4, 10, 1)
    for i in range(60):
        m.add(None, f"Line {i} about the budget for next quarter.", at, speaker="Them")
        m.add(None, f"line {i} about the budget for next quarter", at + timedelta(seconds=1))
        at += timedelta(seconds=40)
    assert [who for _at, _text, who in m.kept()] == ["Them"] * 60  # every echo left out
    plains, echoes = len(m._plains._now), len(m._echoes._now)
    assert plains == 120 and echoes == 60  # each echo compared with its own call line
    for index in range(0, len(m.lines), 2):  # the notes model rewrote every call line
        m.lines[index] = (m.lines[index][0], f"Something else entirely, number {index}.")
    m.kept()
    m.kept()
    # Only what the latest round asked for is kept: the old lines' answers are gone.
    assert len(m._plains._now) == 120 and len(m._plains._before) <= 120
    assert all("budget" not in key[1] for key in m._echoes._now)


def test_alike_answers_as_the_full_comparison_does():
    rng = random.Random(3)
    texts = [_plain(sentence(rng)) for _ in range(300)]
    texts += ["can everyone see my screen", "can everyone see my screen please", "a", ""]
    for _ in range(3000):
        a, b = rng.choice(texts), rng.choice(texts)
        full = difflib.SequenceMatcher(None, a, b).ratio() >= ECHO_ALIKE
        assert _alike(a, b) == full
    assert meeting_module._alike("can everyone see my screen", "can everyone see my screen")


def test_a_call_unchanged_since_is_not_compared_again(tmp_path, monkeypatch):
    # The panel asks every two seconds: by an hour's call, comparing every microphone line
    # with the call's lines again each time took a third of a second of the voice loop.
    compared = []

    def counted(said: str, line: str) -> bool:
        compared.append((said, line))
        return _alike(said, line)

    monkeypatch.setattr(meeting_module, "_alike", counted)
    m = Meeting("Call", tmp_path, now=datetime(2026, 10, 4, 10, 0))
    m.label = "You"
    at = datetime(2026, 10, 4, 10, 1)
    for i in range(300):
        m.add(None, f"Them saying line number {i} of the call.", at, speaker="Them")
        m.add(None, f"me answering line {i} of the call", at + timedelta(seconds=2))
        at += timedelta(seconds=5)
    first = m.kept()
    assert len(compared) >= 300
    compared.clear()
    assert m.kept() == first and compared == []
    m.add(None, "one more thing from me", at)
    assert m.kept() == fresh(m) and 0 < len(compared) <= 3  # only the new line's


def test_rows_unchanged_since_the_last_look_are_given_again_as_they_were(tmp_path, monkeypatch):
    # Nothing new since the last look: the same rows, without going over the lines again
    # (by an hour's call that was 2-3 ms each look). Any change to a line, to who said one,
    # or to the label of lines added without a speaker gives rows worked out afresh.
    m = Meeting("Call", tmp_path, now=datetime(2026, 10, 4, 10, 0))
    m.label = "You"
    at = datetime(2026, 10, 4, 10, 1)
    for i in range(40):
        m.add(None, f"Line {i} about the budget for next quarter.", at, speaker="Them")
        m.add(None, f"line {i} about the budget for next quarter", at + timedelta(seconds=1))
        m.add(None, f"my own thought number {i} on pricing", at + timedelta(seconds=3))
        at += timedelta(seconds=40)
    sifted = []
    real = Meeting._sift
    monkeypatch.setattr(Meeting, "_sift", lambda self, who: sifted.append(1) or real(self, who))
    first = m.kept()
    assert first == fresh(m) and len(sifted) == 1
    first.clear()  # a caller's copy: changing it changes nothing kept
    assert m.kept() == m.kept() == fresh(m) and len(sifted) == 1

    def changed(change):
        change()
        assert m.kept() == fresh(m) and len(sifted) == 2
        assert m.kept() == fresh(m) and len(sifted) == 2
        sifted.clear()
        sifted.append(1)

    changed(lambda: m.add(None, "one more thing from me", at))
    changed(lambda: m.lines.__setitem__(4, (m.lines[4][0], "the notes model's better line")))
    changed(lambda: m.lines.__setitem__(1, (m.lines[1][0], "")))  # taken out (meeting_agent)
    changed(lambda: m.speakers.__setitem__(1, "Them"))
    changed(lambda: m.lines.append((at, "a line added with no speaker kept")))
    changed(lambda: setattr(m, "label", "Them"))  # that line's speaker
    changed(lambda: m.speakers.append("You"))
    assert [who for _at, text, who in m.kept() if text.startswith("a line added")] == ["You"]
