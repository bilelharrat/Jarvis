"""Two claps turn hand control on: the detector, on made-up microphone audio."""

import numpy as np
import pytest

from jarvis.listen import BLOCK_SECONDS, SAMPLE_RATE, ClapDetector

RATE = SAMPLE_RATE


def room(seconds, seed=1):
    return np.random.default_rng(seed).normal(0, 0.002, int(seconds * RATE)).astype(np.float32)


def clap(audio, at, amp=0.6, echo=0.04, seed=2):
    """A click that dies in a few ms, with a faint room echo behind it."""
    rng = np.random.default_rng(seed + int(at * 1000))
    t = np.arange(int(0.4 * RATE)) / RATE
    burst = rng.normal(0, 1, t.size) * (amp * np.exp(-t / 0.006) + amp * echo * np.exp(-t / 0.08))
    start = int(at * RATE)
    end = min(audio.size, start + t.size)
    audio[start:end] += burst[: end - start].astype(np.float32)


def syllable(audio, at, amp=0.12, burst=True, length=0.18):
    """A spoken "pa": maybe a plosive click, then a voiced vowel."""
    t = np.arange(int(length * RATE)) / RATE
    vowel = (
        amp
        * np.sin(2 * np.pi * 180 * t)
        * np.minimum(1, t / 0.02)
        * np.minimum(1, (t[-1] - t) / 0.03)
    )
    start = int(at * RATE)
    audio[start : start + t.size] += vowel.astype(np.float32)
    if burst:
        clap(audio, at - 0.01, amp=0.3, echo=0)


def run(audio, threshold=0.012):
    """Feeds it block by block, as the microphone does; when each double clap was heard."""
    detector = ClapDetector()
    block = int(RATE * BLOCK_SECONDS)
    heard = []
    for i in range(0, audio.size - block + 1, block):
        if detector.feed(audio[i : i + block], threshold):
            heard.append(round((i + block) / RATE, 2))
    return heard


def test_two_claps_are_heard_once_just_after_the_second():
    audio = room(3)
    clap(audio, 1.0)
    clap(audio, 1.35)
    heard = run(audio)
    assert len(heard) == 1
    assert 1.6 <= heard[0] <= 1.8


def test_two_claps_in_an_echoing_room():
    audio = room(3)
    clap(audio, 1.0, echo=0.12)
    clap(audio, 1.5, echo=0.12, amp=0.4)
    assert len(run(audio)) == 1


@pytest.mark.parametrize("gap", [0.2, 0.5, 0.75])
def test_claps_at_an_easy_pace(gap):
    audio = room(3)
    clap(audio, 1.0)
    clap(audio, 1.0 + gap)
    assert len(run(audio)) == 1


def test_one_clap_is_not_enough():
    audio = room(3)
    clap(audio, 1.0)
    assert run(audio) == []


def test_claps_too_far_apart():
    audio = room(4)
    clap(audio, 1.0)
    clap(audio, 2.2)
    assert run(audio) == []


def test_three_claps_are_not_two():
    audio = room(3)
    for at in (1.0, 1.3, 1.6):
        clap(audio, at)
    assert run(audio) == []


def test_a_loud_and_a_faint_click_are_not_a_pair():
    audio = room(3)
    clap(audio, 1.0, amp=0.8)
    clap(audio, 1.35, amp=0.08)
    assert run(audio) == []


def test_talking_is_not_clapping():
    audio = room(4)
    for i, at in enumerate(np.arange(0.8, 3.0, 0.24)):
        syllable(audio, at, burst=i % 2 == 0)
    assert run(audio) == []


def test_pa_pa_is_not_two_claps():
    audio = room(3)
    syllable(audio, 1.0)
    syllable(audio, 1.4)
    assert run(audio) == []


def test_typing_is_not_clapping():
    audio = room(5)
    rng = np.random.default_rng(7)
    at = 0.8
    while at < 4.2:
        clap(audio, at, amp=0.15, echo=0)
        at += rng.uniform(0.09, 0.3)
    assert run(audio) == []


def test_claps_then_talking_right_away():
    audio = room(3)
    clap(audio, 1.0)
    clap(audio, 1.35)
    syllable(audio, 1.5, burst=False, length=0.4)
    assert run(audio) == []


def test_silence_and_a_steady_room_hear_nothing():
    assert run(room(3)) == []
    assert run(np.zeros(3 * RATE, dtype=np.float32)) == []


def test_each_clap_is_reported_for_tuning():
    audio = room(3)
    clap(audio, 1.0)
    levels = []
    detector = ClapDetector(on_clap=levels.append)
    block = int(RATE * BLOCK_SECONDS)
    for i in range(0, audio.size - block + 1, block):
        detector.feed(audio[i : i + block], 0.012)
    assert len(levels) == 1 and levels[0] > 0.05


def test_across_many_rooms_and_hands():
    """Random loudness, pace and echo: nearly every pair is heard, and random talk and
    typing almost never sound like one (the numbers this was tuned to; not a real room)."""
    rng = np.random.default_rng(42)
    missed = 0
    for k in range(60):
        audio = room(3, seed=k)
        gap, amp, echo = rng.uniform(0.18, 0.78), rng.uniform(0.12, 0.9), rng.uniform(0, 0.15)
        clap(audio, 1.0, amp=amp, echo=echo, seed=k)
        clap(audio, 1.0 + gap, amp=amp * rng.uniform(0.6, 1.4), echo=echo, seed=k + 7)
        missed += len(run(audio)) != 1
    false = 0
    for k in range(60):
        audio = room(6, seed=k + 1000)
        at = 0.5
        while at < 5.5:
            if k % 2:
                amp, length = rng.uniform(0.04, 0.2), rng.uniform(0.08, 0.3)
                syllable(audio, at, amp=amp, burst=rng.random() < 0.5, length=length)
                at += rng.uniform(0.15, 0.5)
            else:
                clap(audio, at, amp=rng.uniform(0.05, 0.25), echo=0, seed=int(at * 100) + k)
                at += rng.uniform(0.08, 0.35)
        false += bool(run(audio))
    assert missed <= 2
    assert false <= 3
