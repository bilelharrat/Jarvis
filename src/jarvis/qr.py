"""QR codes, drawn here: the phone companion's pairing code shows as one in Settings.

A small encoder for QR Code Model 2 (ISO/IEC 18004), just what pairing needs: byte mode,
error correction level M (about 15% of the code can be damaged or covered), and the
smallest version (1-40) the text fits in. The mask is the one of the eight with the lowest
penalty, as the standard scores them. No dependency: the window draws the modules it gets.
"""

from __future__ import annotations

# Level M, per version (index 0 unused): error correction codewords in each block, and
# how many blocks the codewords are split into (ISO/IEC 18004 table 9).
ECC_PER_BLOCK = (
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
)  # fmt: skip
BLOCKS = (
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
)  # fmt: skip
LEVEL_M_BITS = 0  # the format information's two bits for level M
PENALTY_RUN, PENALTY_BOX, PENALTY_FINDER, PENALTY_BALANCE = 3, 3, 40, 10


class TooLong(ValueError):
    """More than a version 40 code holds at level M (2,331 bytes)."""


# ── the Galois field and Reed-Solomon ──

_EXP = [0] * 512
_LOG = [0] * 256
_value = 1
for _i in range(255):
    _EXP[_i] = _value
    _LOG[_value] = _i
    _value <<= 1
    if _value & 0x100:
        _value ^= 0x11D  # x^8 + x^4 + x^3 + x^2 + 1
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _multiply(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def rs_generator(degree: int) -> list[int]:
    """The generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power
    first, without its leading 1."""
    poly = [1]
    for i in range(degree):
        nxt = [0] * (len(poly) + 1)
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _multiply(coef, _EXP[i])
        poly = nxt
    return poly[1:]


def rs_remainder(data: bytes | list[int], degree: int) -> list[int]:
    """The error correction codewords for these data codewords."""
    generator = rs_generator(degree)
    remainder = [0] * degree
    for byte in data:
        factor = byte ^ remainder.pop(0)
        remainder.append(0)
        for i, coef in enumerate(generator):
            remainder[i] ^= _multiply(coef, factor)
    return remainder


# ── sizes ──


def raw_modules(version: int) -> int:
    """Modules left for data and error correction once the function patterns are drawn."""
    result = (16 * version + 128) * version + 64
    if version >= 2:
        aligns = version // 7 + 2
        result -= (25 * aligns - 10) * aligns - 55
        if version >= 7:
            result -= 36
    return result


def data_codewords(version: int) -> int:
    return raw_modules(version) // 8 - ECC_PER_BLOCK[version] * BLOCKS[version]


def _count_bits(version: int) -> int:
    return 8 if version <= 9 else 16


def pick_version(length: int) -> int:
    """The smallest version that holds this many bytes at level M."""
    for version in range(1, 41):
        if 4 + _count_bits(version) + 8 * length <= data_codewords(version) * 8:
            return version
    raise TooLong(f"{length} bytes is more than a QR code holds")


def alignment_positions(version: int) -> list[int]:
    if version == 1:
        return []
    size = version * 4 + 17
    count = version // 7 + 2
    step = (version * 8 + count * 3 + 5) // (count * 4 - 4) * 2
    return [6] + sorted(size - 7 - i * step for i in range(count - 1))


# ── the codewords ──


def data_bits(data: bytes, version: int) -> list[int]:
    """Byte mode: the mode, the length, the bytes, then the terminator and padding."""
    bits: list[int] = []

    def put(value: int, count: int) -> None:
        bits.extend((value >> i) & 1 for i in reversed(range(count)))

    put(0b0100, 4)
    put(len(data), _count_bits(version))
    for byte in data:
        put(byte, 8)
    capacity = data_codewords(version) * 8
    put(0, min(4, capacity - len(bits)))
    put(0, -len(bits) % 8)
    pad = 0xEC
    while len(bits) < capacity:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    return bits


def codewords(data: bytes, version: int) -> list[int]:
    """The data split into blocks, each with its error correction, interleaved."""
    bits = data_bits(data, version)
    raw = [int("".join(map(str, bits[i : i + 8])), 2) for i in range(0, len(bits), 8)]
    blocks_n = BLOCKS[version]
    ecc = ECC_PER_BLOCK[version]
    total = raw_modules(version) // 8
    short = blocks_n - total % blocks_n  # blocks one data codeword shorter than the rest
    short_len = total // blocks_n - ecc
    blocks: list[list[int]] = []
    at = 0
    for i in range(blocks_n):
        size = short_len + (0 if i < short else 1)
        blocks.append(raw[at : at + size])
        at += size
    eccs = [rs_remainder(block, ecc) for block in blocks]
    out: list[int] = []
    for i in range(short_len + 1):
        out.extend(block[i] for block in blocks if i < len(block))
    for i in range(ecc):
        out.extend(e[i] for e in eccs)
    return out


# ── the matrix ──


def format_bits(mask: int, level_bits: int = LEVEL_M_BITS) -> int:
    """The 15 format bits: level and mask with their BCH(15,5) check, XOR-masked."""
    data = level_bits << 3 | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    return (data << 10 | rem) ^ 0x5412


def version_bits(version: int) -> int:
    """The 18 version bits (versions 7 and up): the version with its BCH(18,6) check."""
    rem = version
    for _ in range(12):
        rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
    return version << 12 | rem


class _Grid:
    def __init__(self, version: int) -> None:
        self.version = version
        self.size = version * 4 + 17
        self.dark = [[False] * self.size for _ in range(self.size)]
        self.function = [[False] * self.size for _ in range(self.size)]

    def put(self, x: int, y: int, dark: bool) -> None:
        self.dark[y][x] = dark
        self.function[y][x] = True

    def draw_function_patterns(self) -> None:
        size = self.size
        for i in range(size):  # the timing patterns
            self.put(6, i, i % 2 == 0)
            self.put(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):  # finders, with separators
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < size and 0 <= y < size:
                        ring = max(abs(dx), abs(dy))
                        self.put(x, y, ring not in (2, 4))
        positions = alignment_positions(self.version)
        last = len(positions) - 1
        for i, cy in enumerate(positions):
            for j, cx in enumerate(positions):
                if (i, j) in ((0, 0), (0, last), (last, 0)):
                    continue  # where the finders are
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.put(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)
        self.draw_format(0)  # reserves the format areas; drawn again with the real mask
        if self.version >= 7:
            bits = version_bits(self.version)
            for i in range(18):
                dark = (bits >> i) & 1 == 1
                a, b = size - 11 + i % 3, i // 3
                self.put(a, b, dark)
                self.put(b, a, dark)

    def draw_format(self, mask: int) -> None:
        bits = format_bits(mask)
        size = self.size

        def bit(i: int) -> bool:
            return (bits >> i) & 1 == 1

        for i in range(6):
            self.put(8, i, bit(i))
        self.put(8, 7, bit(6))
        self.put(8, 8, bit(7))
        self.put(7, 8, bit(8))
        for i in range(9, 15):
            self.put(14 - i, 8, bit(i))
        for i in range(8):
            self.put(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.put(8, size - 15 + i, bit(i))
        self.put(8, size - 8, True)  # the dark module

    def place(self, words: list[int]) -> None:
        """The codewords, two columns at a time, zigzagging up and down from the right."""
        size = self.size
        total = len(words) * 8
        i = 0
        right = size - 1
        while right >= 1:
            if right == 6:
                right = 5  # the vertical timing pattern's column is skipped
            upward = (right + 1) & 2 == 0
            for vert in range(size):
                y = size - 1 - vert if upward else vert
                for j in range(2):
                    x = right - j
                    if not self.function[y][x] and i < total:
                        self.dark[y][x] = (words[i >> 3] >> (7 - (i & 7))) & 1 == 1
                        i += 1
            right -= 2

    def apply_mask(self, mask: int) -> None:
        test = MASKS[mask]
        for y in range(self.size):
            row, function = self.dark[y], self.function[y]
            for x in range(self.size):
                if not function[x] and test(x, y):
                    row[x] = not row[x]


MASKS = (
    lambda x, y: (x + y) % 2 == 0,
    lambda x, y: y % 2 == 0,
    lambda x, y: x % 3 == 0,
    lambda x, y: (x + y) % 3 == 0,
    lambda x, y: (x // 3 + y // 2) % 2 == 0,
    lambda x, y: x * y % 2 + x * y % 3 == 0,
    lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
)


def penalty(modules: list[list[bool]]) -> int:
    """The standard's four penalty rules: runs of five or more alike, 2x2 boxes alike,
    finder-like patterns (dark 1:1:3:1:1 with four light modules beside it), and how far
    dark and light are from half and half."""
    size = len(modules)
    score = 0
    for line in [*modules, *(list(col) for col in zip(*modules, strict=True))]:
        runs = _Runs(size)
        color, run = False, 0  # the line starts after the light quiet zone
        for dark in line:
            if dark == color:
                run += 1
                if run == 5:
                    score += PENALTY_RUN
                elif run > 5:
                    score += 1
                continue
            runs.add(run)
            if not color:  # a light run just ended
                score += runs.finder_like() * PENALTY_FINDER
            color, run = dark, 1
        score += runs.end(color, run) * PENALTY_FINDER
    for y in range(size - 1):
        above, below = modules[y], modules[y + 1]
        for x in range(size - 1):
            if above[x] == above[x + 1] == below[x] == below[x + 1]:
                score += PENALTY_BOX
    dark = sum(sum(row) for row in modules)
    total = size * size
    score += ((abs(dark * 20 - total * 10) + total - 1) // total - 1) * PENALTY_BALANCE
    return score


class _Runs:
    """The lengths of a line's latest seven runs, newest first. A light run at either end
    of the line runs on into the quiet zone, counted as the line's length more."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.history = [0] * 7

    def add(self, length: int) -> None:
        if self.history[0] == 0:
            length += self.size  # the first run: light, from the quiet zone
        self.history = [length, *self.history[:6]]

    def finder_like(self) -> int:
        """0, 1 or 2 finder-like patterns ending at the light run just added."""
        h = self.history
        n = h[1]
        core = n > 0 and h[2] == h[4] == h[5] == n and h[3] == n * 3
        return (1 if core and h[0] >= n * 4 and h[6] >= n else 0) + (
            1 if core and h[6] >= n * 4 and h[0] >= n else 0
        )

    def end(self, color: bool, run: int) -> int:
        """The end of the line: its last run goes on into the quiet zone."""
        if color:  # a dark run ends at the edge
            self.add(run)
            run = 0
        self.add(run + self.size)
        return self.finder_like()


def encode(text: str | bytes, mask: int | None = None) -> list[list[bool]]:
    """The QR code for this text (UTF-8 bytes) at level M: rows of modules, True is dark,
    without the quiet zone around it. mask: one of the eight, else the best by penalty."""
    data = text.encode() if isinstance(text, str) else bytes(text)
    version = pick_version(len(data))
    words = codewords(data, version)
    best: tuple[int, list[list[bool]]] | None = None
    for candidate in range(8) if mask is None else (mask,):
        grid = _Grid(version)
        grid.draw_function_patterns()
        grid.place(words)
        grid.apply_mask(candidate)
        grid.draw_format(candidate)
        score = penalty(grid.dark) if mask is None else 0
        if best is None or score < best[0]:
            best = (score, grid.dark)
    assert best is not None
    return best[1]


def rows(modules: list[list[bool]]) -> list[str]:
    """The modules as strings of 0 and 1, row by row, for the window to draw."""
    return ["".join("1" if dark else "0" for dark in row) for row in modules]
