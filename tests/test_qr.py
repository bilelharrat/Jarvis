"""The QR encoder behind the companion's pairing code (jarvis.qr): the standard's own
numbers, codes checked module for module against macOS's generator (Core Image), and read
back by macOS's decoder."""

import pytest

from jarvis import qr

# Core Image's CIQRCodeGenerator at level M, one hex string per row (padded to whole hex
# digits): version 1, version 7 (with version information) and version 11 (a two-byte
# length, blocks of two sizes).
CORE_IMAGE = {
    "hello": [
        "fe63f8", "82c208", "ba5ae8", "ba32e8", "bacae8", "820a08", "feabf8", "003800",
        "aa5090", "2c2218", "52e8f8", "c80210", "6b2a80", "00f538", "fe3738", "823d80",
        "bab718", "ba4330", "bae8a8", "824290", "feeb18",
    ],
    "é中文🙂" * 10: [
        "feae73d8cbf8", "823cd3c2d208", "ba89d55692e8", "ba2ea818dae8", "ba73bfcc3ae8",
        "82bc78ad8208", "feaaaaaaabf8", "0035a8c39800", "a30b9f976928", "498c0bea2f48",
        "5a4a9a0ca410", "7d50c7dbb8f8", "fe8114f26518", "ccf820a3afd0", "d779770edff0",
        "f12fbbfcb520", "4eb28b872518", "d911993bbae8", "33a42929e680", "75f7aaef5230",
        "9f884fb15fb0", "98f498fa38a0", "6a846adbbab0", "08d35896f8e8", "ffeceff21fc8",
        "5571532f2480", "0a236bad20e0", "7122aea862a0", "e29238e52b30", "1dfec6b6e2b8",
        "734923d6dde0", "193620a21cb8", "0f86ad3647c8", "746e772ae7a8", "0a5f29eded30",
        "783027c3c238", "9aef0fc24ff8", "00d4b8aba8d0", "fea33abeeaf0", "825d08ecb8a8",
        "ba72ef853f88", "ba0b62b3bcf8", "ba8afba3f008", "82056ae94720", "fec202314828",
    ],
    "a" * 250: [
        "fef9e34f2aaadbf8", "825a859522225a08", "bad360baf7777ae8", "ba10d2ca55556ae8",
        "ba041e4faaaab2e8", "82da8408a2222208", "feaaaaaaaaaaabf8", "00359f5888888000",
        "a37ea5bfaaaab128", "f1e36020d5555508", "832c7272ddddcda8", "fcb40fd5088880d0",
        "7a7ea5adaaaab2d8", "f5e36020d5555508", "332e5272ddddcda8", "5d964dd5088880d0",
        "7a1885adaaaab2d8", "75410020d5555508", "328a1472ddddcda8", "5d9649d5088880c8",
        "7a13052daaaab2d0", "75281320d5555508", "32c66772ddddcda8", "5d86db55088880d0",
        "462877adaaaab2d8", "69498da0d5555508", "9ade7f72ddddcda8", "891ecbd5088880d0",
        "6fa1772faaaabfd8", "38d10d28d5555888", "6ac6eefaddddcaa8", "989f5a48888888d0",
        "6fa1773faaaaafd8", "d5510d3a55554508", "9bc2aef75ddddaa8", "24fb1a4508889a50",
        "6fa5753aaaaab758", "1cb34d3a55554518", "97c6acf75ddddaa0", "2cdb5c4508889a40",
        "6eed1bbaaaaab758", "1dc1163a55554508", "975334f75ddddaa8", "2d7b524508889a50",
        "6ef0c93aaaaab758", "0d948b3a55554508", "275bbcf75ddddaa8", "6d6bda4508889a50",
        "eae8d93aaaaab758", "4d951b3a55554508", "3f42bcf75ddddaa8", "e97a5a4508889a50",
        "f368d93faaaabfd8", "00951b28d5555888", "fe82faeadddddaa8", "82183c58888888d0",
        "ba0cf93faaaabfd8", "ba115d3555554880", "bae69efdddddcab8", "825a184888889540",
        "fec5632aaaaabdc8",
    ],
}  # fmt: skip


def unpack(rows, size):
    return ["".join(f"{int(h, 16):0{len(h) * 4}b}")[:size] for h in rows]


@pytest.mark.parametrize("text", list(CORE_IMAGE))
def test_codes_match_macos_module_for_module(text):
    expected = CORE_IMAGE[text]
    assert qr.rows(qr.encode(text)) == unpack(expected, len(expected))


def test_reed_solomon_matches_the_standard_example():
    # HELLO WORLD at 1-M, as worked through in the standard's annex and thonky.com.
    data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    assert qr.rs_remainder(data, 10) == [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]


def test_format_and_version_information():
    level_m = [
        "101010000010010", "101000100100101", "101111001111100", "101101101001011",
        "100010111111001", "100000011001110", "100111110010111", "100101010100000",
    ]  # fmt: skip
    assert [f"{qr.format_bits(mask):015b}" for mask in range(8)] == level_m
    assert qr.version_bits(7) == 0x07C94 and qr.version_bits(8) == 0x085BC
    assert qr.version_bits(10) == 0x0A4D3


def test_capacity_and_versions():
    # Byte-mode capacities at level M, from the standard's table 7.
    for version, most in ((1, 14), (2, 26), (7, 122), (9, 180), (10, 213), (40, 2331)):
        assert qr.pick_version(most) == version
        if version < 40:
            assert qr.pick_version(most + 1) == version + 1
    with pytest.raises(qr.TooLong):
        qr.pick_version(2332)
    assert [len(qr.encode("x" * n)) for n in (14, 15, 122)] == [21, 25, 45]
    assert qr.alignment_positions(1) == []
    assert qr.alignment_positions(2) == [6, 18]
    assert qr.alignment_positions(7) == [6, 22, 38]
    assert qr.alignment_positions(32) == [6, 34, 60, 86, 112, 138]
    assert qr.alignment_positions(40) == [6, 30, 58, 86, 114, 142, 170]
    for version in range(1, 41):  # data and error correction fill the symbol exactly
        total = qr.raw_modules(version) // 8
        assert qr.data_codewords(version) + qr.ECC_PER_BLOCK[version] * qr.BLOCKS[version] == total


def test_the_penalty_rules():
    size = 21
    light = [[False] * size for _ in range(size)]
    # Runs: 42 lines of 21 (3 + 16 each); boxes: 20 x 20 (3 each); balance: all light (90).
    assert qr.penalty(light) == 42 * 19 + 400 * 3 + 90
    runs = qr._Runs(21)
    for length in (0, 1, 1, 3, 1, 1):  # quiet zone, then dark 1:1:3:1:1
        runs.add(length)
    runs.add(4)  # four light modules after it
    assert runs.finder_like() == 2  # quiet zone before, four light after: both sides count
    runs = qr._Runs(21)
    # Mid-line, with only two light modules on each side: not a finder look-alike.
    for length in (0, 2, 2, 1, 1, 3, 1, 1, 2):
        runs.add(length)
    assert runs.finder_like() == 0


def test_every_mask_is_a_valid_choice_and_the_best_is_picked():
    text = "jarvis-pair://Mac.local:8765?code=123456"
    scores = [qr.penalty(qr.encode(text, mask=m)) for m in range(8)]
    assert qr.encode(text) == qr.encode(text, mask=scores.index(min(scores)))


def _decode(modules):
    """macOS's own QR reader (Core Image), on the code drawn as a picture."""
    quartz = pytest.importorskip("Quartz")
    foundation = pytest.importorskip("Foundation")
    scale, border = 6, 4
    width = (len(modules) + 2 * border) * scale
    raw = bytearray([255]) * (width * width)
    for y, row in enumerate(modules):
        for x, dark in enumerate(row):
            if dark:
                for yy in range((y + border) * scale, (y + border + 1) * scale):
                    start = yy * width + (x + border) * scale
                    raw[start : start + scale] = bytes(scale)
    data = foundation.NSData.dataWithBytes_length_(bytes(raw), len(raw))
    image = quartz.CGImageCreate(
        width, width, 8, 8, width, quartz.CGColorSpaceCreateDeviceGray(),
        quartz.kCGImageAlphaNone, quartz.CGDataProviderCreateWithCFData(data), None, False,
        quartz.kCGRenderingIntentDefault,
    )  # fmt: skip
    detector = quartz.CIDetector.detectorOfType_context_options_(
        quartz.CIDetectorTypeQRCode,
        None,
        {quartz.CIDetectorAccuracy: quartz.CIDetectorAccuracyHigh},
    )
    if detector is None:
        pytest.skip("no QR reader on this Mac")
    found = detector.featuresInImage_(quartz.CIImage.imageWithCGImage_(image))
    return [f.messageString() for f in found]


@pytest.mark.parametrize(
    "text",
    [
        "jarvis-pair://Bilels-MacBook-Pro.local:8765?code=042917&fp="
        + "9f" * 32
        + "&name=Bilel%E2%80%99s%20MacBook%20Pro",
        "jarvis-pair://192.168.1.20:8765?code=000001&fp=" + "0a" * 32 + "&name=Mac",
        "The quick brown fox, 0123456789, 中文 and 🙂",
        "q" * 700,
    ],
)
def test_macos_reads_the_codes_back(text):
    assert _decode(qr.encode(text)) == [text]


def test_a_pairing_code_encodes_quickly():
    import time

    url = "jarvis-pair://Bilels-MacBook-Pro.local:8765?code=042917&fp=" + "9f" * 32 + "&name=Mac"
    started = time.perf_counter()
    qr.encode(url)
    assert time.perf_counter() - started < 1.0
