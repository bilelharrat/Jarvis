"""How close a built page is to the design it was built from: a perceptual comparison in pure
numpy (no image library), for Eden Code's "Match a design" (features/code_design.py).

The app decodes both pictures and shrinks them to one small size (app/features/design-match.js);
here they're compared:

- Structure: SSIM on the luminance (Wang et al. 2004), with a 7×7 box window computed from
  integral images, on pictures shrunk to at most COMPARE_SIDE pixels a side. Shrinking first
  makes it forgiving of a pixel's shift and anti-aliasing, which a person wouldn't see.
- Colour: the mean difference of the two chroma channels, per window.
- The score: STRUCTURE_WEIGHT of the first and the rest of the second, from 0 (nothing alike)
  to 1 (the same), as a percentage on screen.
- The heat-map: the dissimilarity of a grid of cells (0 alike … 255 nothing alike), which the
  window paints over the page; and the regions that differ most, in words, for the session.

Pure functions: no files, no network.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
from typing import Any

import numpy as np

COMPARE_SIDE = 256  # the longest side the pictures are compared at
WINDOW = 7  # SSIM's box window
STRUCTURE_WEIGHT = 0.7
GRID_ROWS = 24  # the heat-map's cells down (across: in proportion)
MAX_PIXELS = 512 * 512  # what the app may send for one picture
C1 = (0.01 * 255) ** 2
C2 = (0.03 * 255) ** 2
GOOD_ENOUGH = 0.95  # a match this close needs no more rounds
REGIONS = (("top", "middle", "bottom"), ("left", "centre", "right"))


@dataclass
class Comparison:
    score: float  # 0..1
    structure: float
    colour: float
    rows: int  # the heat-map's grid
    cols: int
    heat: list[int] = field(default_factory=list)  # rows × cols, row by row, 0..255
    regions: list[tuple[str, float]] = field(default_factory=list)  # most different first

    def public(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 4),
            "structure": round(self.structure, 4),
            "colour": round(self.colour, 4),
            "rows": self.rows,
            "cols": self.cols,
            "heat": self.heat,
            "regions": [[name, round(v, 3)] for name, v in self.regions],
        }


def decode_rgb(data: Any, width: Any, height: Any) -> np.ndarray:
    """A picture the app sent: base64 of width × height × 3 bytes (RGB, row by row).
    Raises ValueError for anything else."""
    try:
        w, h = int(width), int(height)
    except (TypeError, ValueError):
        raise ValueError("The picture's size is missing.") from None
    if not (1 <= w and 1 <= h and w * h <= MAX_PIXELS):
        raise ValueError("The picture's size is out of range.")
    if not isinstance(data, str):
        raise ValueError("The picture is missing.")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("The picture isn't readable.") from None
    if len(raw) != w * h * 3:
        raise ValueError("The picture's bytes don't match its size.")
    return np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)


def shrink(img: np.ndarray, side: int = COMPARE_SIDE) -> np.ndarray:
    """Area-averaged down to at most `side` pixels on its longest side (never up)."""
    h, w = img.shape[:2]
    factor = max(1, int(np.ceil(max(h, w) / side)))
    if factor == 1:
        return img.astype(np.float64)
    hh, ww = h // factor, w // factor
    cut = img[: hh * factor, : ww * factor].astype(np.float64)
    shape = (hh, factor, ww, factor) + cut.shape[2:]
    return cut.reshape(shape).mean(axis=(1, 3))


def _box(a: np.ndarray, k: int) -> np.ndarray:
    """The mean of every k × k window that fits ('valid'), from an integral image."""
    s = np.pad(a, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    total = s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]
    return total / (k * k)


def _channels(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Luma and two chroma channels (BT.601), 0..255."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return y, cb, cr


def ssim_map(x: np.ndarray, y: np.ndarray, k: int = WINDOW) -> np.ndarray:
    """SSIM of each k × k window of two grey pictures of one size."""
    mx, my = _box(x, k), _box(y, k)
    vx = _box(x * x, k) - mx * mx
    vy = _box(y * y, k) - my * my
    cov = _box(x * y, k) - mx * my
    num = (2 * mx * my + C1) * (2 * cov + C2)
    den = (mx * mx + my * my + C1) * (vx + vy + C2)
    return num / den


def _cells(values: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """The mean of each cell of a rows × cols grid laid over `values`."""
    h, w = values.shape
    ys = np.linspace(0, h, rows + 1).astype(int)
    xs = np.linspace(0, w, cols + 1).astype(int)
    out = np.zeros((rows, cols))
    for i in range(rows):
        for j in range(cols):
            cell = values[ys[i] : max(ys[i + 1], ys[i] + 1), xs[j] : max(xs[j + 1], xs[j] + 1)]
            out[i, j] = cell.mean() if cell.size else 0.0
    return out


def compare(design: np.ndarray, built: np.ndarray, rows: int = GRID_ROWS) -> Comparison:
    """Two RGB pictures of one size (the design, and the page as built) compared."""
    if design.shape != built.shape or design.ndim != 3 or design.shape[2] != 3:
        raise ValueError("The two pictures must be the same size.")
    a, b = shrink(design), shrink(built)
    h, w = a.shape[:2]
    if min(h, w) < WINDOW:
        raise ValueError("The pictures are too small to compare.")
    ya, cba, cra = _channels(a)
    yb, cbb, crb = _channels(b)
    structure = np.clip(ssim_map(ya, yb), 0.0, 1.0)  # (a negative SSIM is as unlike as 0)
    chroma = (np.abs(cba - cbb) + np.abs(cra - crb)) / 2
    colour = 1.0 - np.clip(_box(chroma, WINDOW) / 128.0, 0.0, 1.0)
    local = STRUCTURE_WEIGHT * structure + (1 - STRUCTURE_WEIGHT) * colour
    rows = max(1, min(rows, local.shape[0]))
    cols = max(1, min(local.shape[1], round(rows * local.shape[1] / local.shape[0])))
    grid = 1.0 - _cells(local, rows, cols)
    heat = np.clip(np.round(grid * 255), 0, 255).astype(int).ravel().tolist()
    named = []
    region = _cells(1.0 - local, 3, 3)
    for i, vertical in enumerate(REGIONS[0]):
        for j, horizontal in enumerate(REGIONS[1]):
            name = "the centre" if (i, j) == (1, 1) else f"{vertical} {horizontal}"
            named.append((name, float(region[i, j])))
    named.sort(key=lambda item: item[1], reverse=True)
    return Comparison(
        score=float(local.mean()),
        structure=float(structure.mean()),
        colour=float(colour.mean()),
        rows=rows,
        cols=cols,
        heat=heat,
        regions=named,
    )


def percent(score: float) -> str:
    return f"{max(0.0, min(1.0, score)) * 100:.0f}%"


def feedback(result: Comparison, round_no: int, rounds: int, size: tuple[int, int]) -> str:
    """What the session is told for a refinement round: the score and where the page and the
    design differ most. The picture of the page goes with it."""
    worst = [(name, v) for name, v in result.regions if v >= 0.08][:4]
    lines = [
        f"Design match, round {round_no} of {rounds}: the page as built scores "
        f"{percent(result.score)} against the design (layout and shapes {percent(result.structure)}, "
        f"colour {percent(result.colour)}), compared at {size[0]}×{size[1]}.",
    ]
    if worst:
        lines.append("Where it differs most from the design:")
        lines += [f"- {name}: {percent(v)} different" for name, v in worst]
    else:
        lines.append("No region stands out; the differences are small and spread out.")
    lines.append(
        "The attached picture is the page as it renders now; the design is the picture from "
        "the first message. Change the page to match the design more closely (layout, "
        "spacing, sizes, colours, type), then say what you changed."
    )
    return "\n".join(lines)
