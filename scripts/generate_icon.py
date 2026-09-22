"""Generate package and browser icons with only the Python standard library."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

SIZE = 1024
BACKGROUND = (240, 240, 236, 255)
INK = (48, 53, 50, 255)
TRANSPARENT = (0, 0, 0, 0)
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def inside_round_rect(x: int, y: int, left: int, top: int, right: int, bottom: int, radius: int) -> bool:
    if left + radius <= x < right - radius or top + radius <= y < bottom - radius:
        return left <= x < right and top <= y < bottom
    cx = left + radius if x < left + radius else right - radius - 1
    cy = top + radius if y < top + radius else bottom - radius - 1
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def render_png(size: int) -> bytes:
    rows = []
    scale = size / SIZE

    def scaled(value: int) -> int:
        return round(value * scale)

    bars = ((262, 464, 382, 752), (442, 272, 562, 752), (622, 368, 742, 752))
    scaled_bars = tuple(tuple(scaled(value) for value in bar) for bar in bars)
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            color = BACKGROUND if inside_round_rect(x, y, scaled(36), scaled(36), scaled(988), scaled(988), scaled(224)) else TRANSPARENT
            if any(inside_round_rect(x, y, *bar, max(1, scaled(24))) for bar in scaled_bars):
                color = INK
            row.extend(color)
        rows.append(bytes(row))
    payload = b"".join(rows)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(payload, 9)) + chunk(b"IEND", b"")


def render_ico() -> bytes:
    images = [(size, render_png(size)) for size in ICON_SIZES]
    offset = 6 + 16 * len(images)
    entries = []
    payload = []
    for size, png in images:
        dimension = 0 if size == 256 else size
        entries.append(struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(png), offset))
        payload.append(png)
        offset += len(png)
    return struct.pack("<HHH", 0, 1, len(images)) + b"".join(entries) + b"".join(payload)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    png = render_png(SIZE)
    root.joinpath("assets", "icon.png").write_bytes(png)
    root.joinpath("assets", "icon.ico").write_bytes(render_ico())
    public = root.joinpath("frontend", "public")
    public.mkdir(parents=True, exist_ok=True)
    public.joinpath("icon.png").write_bytes(png)


if __name__ == "__main__":
    main()
