"""Synthetic microphone audio for the voice tests (16 kHz mono float32): a voice-like
signal (a pitched pulse train through vowel formants, a syllable at a time) and the room
sounds a loudness detector takes for speech (noise, hum, a fan, typing, a door). Nothing
is recorded or played: every signal is made here, the same way on every run."""

import numpy as np

RATE = 16_000
BLOCK = 800  # 50 ms, as the microphone delivers it

# (F1, F2, F3) of a, i, u, e, o
_VOWELS = [
    (730, 1090, 2440),
    (270, 2290, 3010),
    (300, 870, 2240),
    (530, 1840, 2480),
    (570, 840, 2410),
]


def _resonate(x, freq, bandwidth):
    """A two-pole formant resonator, as its (30 ms) impulse response."""
    r = np.exp(-np.pi * bandwidth / RATE)
    theta = 2 * np.pi * freq / RATE
    k = np.arange(int(0.03 * RATE))
    h = r**k * np.sin((k + 1) * theta) / np.sin(theta)
    return np.convolve(x, h)[: x.size]


def voice(seconds=2.0, level=0.3, seed=1):
    """Something that sounds like someone talking: a wandering 100-150 Hz pitch, a new
    vowel every 180 ms, each syllable swelling and fading, a little breath noise."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    f0 = 120 + 25 * np.sin(2 * np.pi * 0.7 * t) + 10 * np.sin(2 * np.pi * 3.1 * t)
    phase = np.cumsum(f0 / RATE)
    pulses = np.zeros(n)
    pulses[np.nonzero(np.diff(np.floor(phase)) > 0)[0]] = 1.0
    glottal = np.convolve(pulses, np.hanning(40))[:n]
    out = np.zeros(n)
    syllable = int(0.18 * RATE)
    for start in range(0, n, syllable):
        f1, f2, f3 = _VOWELS[rng.integers(len(_VOWELS))]
        piece = glottal[start : start + syllable]
        shaped = _resonate(piece, f1, 80) + _resonate(piece, f2, 90) + _resonate(piece, f3, 120)
        swell = np.sin(np.pi * np.arange(piece.size) / piece.size) ** 0.6
        out[start : start + syllable] = shaped * swell
    breath = rng.standard_normal(n) * np.repeat(rng.random(n // syllable + 1), syllable)[:n]
    out += 0.02 * breath
    return (level * out / np.max(np.abs(out))).astype(np.float32)


def silence(seconds=1.0, level=0.0005, seed=2):
    """A quiet room: a faint hiss."""
    return (level * np.random.default_rng(seed).standard_normal(int(seconds * RATE))).astype(
        np.float32
    )


def noise(seconds=2.0, level=0.1, seed=3):
    return (level * np.random.default_rng(seed).standard_normal(int(seconds * RATE))).astype(
        np.float32
    )


def hum(seconds=2.0, level=0.2, freq=120.0):
    t = np.arange(int(seconds * RATE)) / RATE
    return (level * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def fan(seconds=2.0, level=0.15, seed=4):
    """Low, rumbling noise (white noise through a 50 ms moving average)."""
    rough = np.random.default_rng(seed).standard_normal(int(seconds * RATE))
    smooth = np.convolve(rough, np.ones(800) / 800, mode="same")
    return (level * smooth / np.max(np.abs(smooth))).astype(np.float32)


def typing(seconds=2.0, level=0.5, seed=5):
    """Key clicks: sharp decaying bursts, 6-10 a second."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    out = np.zeros(n)
    click = np.exp(-np.arange(160) / 25) * rng.standard_normal(160)
    at = 0
    while at < n - 160:
        out[at : at + 160] += click * rng.uniform(0.5, 1.0)
        at += int(rng.uniform(0.1, 0.17) * RATE)
    return (level * out / np.max(np.abs(out))).astype(np.float32)


def door(seconds=1.0, level=0.8, seed=6):
    """A door shutting: a loud thud that dies away over a quarter of a second."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    thud = np.exp(-np.arange(n) / (0.06 * RATE)) * rng.standard_normal(n)
    thud = np.convolve(thud, np.ones(8) / 8, mode="same")
    return (level * thud / np.max(np.abs(thud))).astype(np.float32)


def blocks(audio):
    """The audio as the microphone hands it over: 50 ms blocks (a partial last one dropped)."""
    count = audio.size // BLOCK
    return [audio[i * BLOCK : (i + 1) * BLOCK] for i in range(count)]


def rms(block):
    return float(np.sqrt(np.mean(block.astype(np.float64) ** 2)))
