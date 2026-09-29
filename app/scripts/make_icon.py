"""Draws the J.A.R.V.I.S. app icon (a glowing reactor orb on a dark squircle) as build/icon.icns.

    cd app && uv run --project .. python scripts/make_icon.py
"""

import struct
import subprocess
import zlib
from pathlib import Path

import numpy as np

SIZE = 1024
BUILD = Path(__file__).resolve().parents[1] / "build"


def png(path: Path, rgba: np.ndarray) -> None:
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def draw() -> np.ndarray:
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) + 0.5
    c = SIZE / 2
    # macOS-style squircle, 824px within the 1024 canvas.
    half, n = 412.0, 5.0
    sq = (np.abs(x - c) / half) ** n + (np.abs(y - c) / half) ** n
    shape_alpha = np.clip((1.0 - sq) * 60, 0, 1)
    r = np.hypot(x - c, y - c)
    # Background: deep navy with a soft centre light.
    bg = np.stack([np.full_like(r, 4), np.full_like(r, 14), np.full_like(r, 24)], -1)
    bg += (np.clip(1 - r / 460, 0, 1) ** 2)[..., None] * np.array([6, 40, 60])
    col = bg
    cyan = np.array([56, 200, 245], dtype=np.float32)

    def ring(radius, width, strength):
        return np.exp(-((r - radius) / width) ** 2)[..., None] * cyan * strength

    col = col + ring(330, 5, 0.55) + ring(290, 2.5, 0.45) + ring(230, 2, 0.3)
    # Dashes on the outer ring.
    angle = np.arctan2(y - c, x - c)
    dashes = (np.sin(angle * 36) > 0.2).astype(np.float32)
    col = col + ring(370, 7, 0.5) * dashes[..., None]
    # Two bright arcs.
    arc = ((np.abs(angle + 2.2) < 0.35) | (np.abs(angle - 0.95) < 0.35)).astype(np.float32)
    col = col + np.exp(-((r - 330) / 10) ** 2)[..., None] * arc[..., None] * np.array([150, 240, 255])
    # The orb: a glowing core with a highlight.
    core = np.clip(1 - r / 150, 0, 1)
    col = col + (core**1.2)[..., None] * np.array([40, 160, 235]) + (np.exp(-(r / 150) ** 2) * 0.9)[..., None] * cyan
    hl = np.exp(-(((x - c + 45) ** 2 + (y - c + 50) ** 2) / (2 * 38**2)))
    col = col + hl[..., None] * np.array([200, 240, 255]) * 0.8
    col = col + (np.exp(-(r / 260) ** 2) * 0.25)[..., None] * cyan  # halo
    rgba = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(col, 0, 255).astype(np.uint8)
    rgba[..., 3] = (shape_alpha * 255).astype(np.uint8)
    return rgba


def main() -> None:
    BUILD.mkdir(exist_ok=True)
    iconset = BUILD / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    master = BUILD / "icon-1024.png"
    png(master, draw())
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = size * scale
            name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
            subprocess.run(["sips", "-z", str(px), str(px), str(master), "--out", str(iconset / name)],
                           check=True, capture_output=True)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True)
    print(f"Wrote {BUILD / 'icon.icns'}")


if __name__ == "__main__":
    main()
