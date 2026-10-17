"""Draws the Eden Code app icon (logo G "paper": Eden's mark in navy plus a coral cursor on a cream squircle) as
build/eden-code/icon.icns and icon-1024.png.

cd app && uv run --project .. python scripts/make_eden_code_icon.py
"""

import struct
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from make_icon import png

SIZE = 1024
SS = 2  # supersampling: drawn at 2x, then averaged down
OUT = Path(__file__).resolve().parents[1] / "build" / "eden-code"

# Ask Eden's mark (askeden web/chat/app.css .orb): two outlines in viewBox 43 81 410 422,
# stroked 18 wide with round joins, white on #0E2747.
VIEWBOX = (43, 81, 410, 422)
POLYGONS = [
    [(211, 93), (314, 90), (444, 236), (343, 353), (249, 352), (333, 251)],
    [(252, 235), (160, 346), (282, 491), (186, 494), (52, 350), (151, 234)],
]
STROKE = 18
NAVY = np.array([0x0E, 0x27, 0x47], dtype=np.float64)
CORAL = np.array([0xE5, 0x78, 0x6B], dtype=np.float64)
PAPER_TOP = np.array([0xFF, 0xFD, 0xF7], dtype=np.float64)
PAPER_BOTTOM = np.array([0xF1, 0xEC, 0xE0], dtype=np.float64)


def squircle(n: int, inset: float, size: float) -> np.ndarray:
    """macOS's icon shape: a superellipse (exponent 5) inside the 1024 grid's 824 square."""
    y, x = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    half = size / 2
    c = inset + half
    return (np.abs((x - c) / half) ** 5 + np.abs((y - c) / half) ** 5) <= 1.0


def stroke_mask(n: int, scale: float, ox: float, oy: float) -> np.ndarray:
    y, x = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    best = np.full((n, n), np.inf)
    for poly in POLYGONS:
        pts = [(ox + (px - VIEWBOX[0]) * scale, oy + (py - VIEWBOX[1]) * scale) for px, py in poly]
        for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1], strict=True):
            dx, dy = bx - ax, by - ay
            t = np.clip(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1)
            best = np.minimum(best, np.hypot(x - (ax + t * dx), y - (ay + t * dy)))
    outline = best <= STROKE * scale / 2
    fill = np.zeros((n, n), dtype=bool)
    for poly in POLYGONS:
        pts = [(ox + (px - VIEWBOX[0]) * scale, oy + (py - VIEWBOX[1]) * scale) for px, py in poly]
        inside = np.zeros((n, n), dtype=bool)
        for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1], strict=True):
            if ay == by:
                continue
            crosses = ((ay <= y) & (y < by)) | ((by <= y) & (y < ay))
            xi = ax + (y - ay) * (bx - ax) / (by - ay)
            inside ^= crosses & (x < xi)
        fill |= inside
    return outline | fill


def main() -> None:
    n = SIZE * SS
    tile = 824 * SS
    inset = 100 * SS
    shape = squircle(n, inset, tile)
    # Logo G sits on a 1024 design grid; map it into the 824 tile.
    k = tile / 1024
    scale = k
    # mark centre (430, 470) in the design; the viewBox centre is its middle.
    ox = inset + 430 * k - VIEWBOX[2] * scale / 2
    oy = inset + 470 * k - VIEWBOX[3] * scale / 2
    mark = stroke_mask(n, scale, ox, oy) & shape
    # Coral cursor: a round-capped bar from x 640 to 840 at y 700, 72 thick.
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    ax, bx, cy, r = inset + 640 * k + 36 * k, inset + 840 * k - 36 * k, inset + 700 * k, 36 * k
    cursor = (np.hypot(xx - np.clip(xx, ax, bx), yy - cy) <= r) & shape

    rgb = np.zeros((n, n, 3))
    t = np.clip((np.arange(n)[:, None] - inset) / tile, 0, 1)[..., None]
    rgb[:] = PAPER_TOP * (1 - t) + PAPER_BOTTOM * t
    rgb[mark] = NAVY
    rgb[cursor] = CORAL
    alpha = shape.astype(np.float64) * 255
    rgba = np.dstack([rgb, alpha]).reshape(SIZE, SS, SIZE, SS, 4).mean(axis=(1, 3))
    # Colour averaged only over the covered samples, so the edge doesn't darken.
    cov = rgba[..., 3:4] / 255
    rgba[..., :3] = np.where(cov > 0, rgba[..., :3] / np.maximum(cov, 1e-9), 0)
    rgba = np.clip(np.round(rgba), 0, 255).astype(np.uint8)

    OUT.mkdir(parents=True, exist_ok=True)
    big = OUT / "icon-1024.png"
    png(big, rgba)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for factor in (1, 2):
                px = size * factor
                name = f"icon_{size}x{size}{'@2x' if factor == 2 else ''}.png"
                subprocess.run(
                    ["sips", "-z", str(px), str(px), str(big), "--out", str(iconset / name)],
                    check=True,
                    capture_output=True,
                )
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True
        )
        # Windows .ico: PNG-compressed entries at the usual sizes.
        entries = []
        for px in (16, 24, 32, 48, 64, 128, 256):
            f = Path(tmp) / f"ico{px}.png"
            subprocess.run(
                ["sips", "-z", str(px), str(px), str(big), "--out", str(f)],
                check=True,
                capture_output=True,
            )
            entries.append((px, f.read_bytes()))
        head = struct.pack("<HHH", 0, 1, len(entries))
        offset = 6 + 16 * len(entries)
        table, blobs = b"", b""
        for px, data in entries:
            table += struct.pack(
                "<BBBBHHII", px % 256, px % 256, 0, 0, 1, 32, len(data), offset + len(blobs)
            )
            blobs += data
        (OUT / "icon.ico").write_bytes(head + table + blobs)
    print(f"wrote {OUT / 'icon.icns'}, icon.ico and {big}")


if __name__ == "__main__":
    main()
