# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow==12.2.0"]
# ///
"""The canonical image pipeline: what Image Decisions Lab sends to the model, in plain Pillow.

    uv run scripts/reference_pipeline.py --max-side 1024 --out sent/ photo1.jpg photo2.png ...

Writes sent/<name>.jpg for each input and prints "<sha256>  <width>x<height>  <name>.jpg". The browser builds the
same bytes (lib/modelImage.ts); `node scripts/check_parity.mjs` checks that it does.

The definition, and why each step is what it is:

- Image.open(...).convert("RGB"): no EXIF rotation (Pillow does not apply it on open), no colour management, alpha
  dropped (not composited), palette and low bit depth PNGs expanded the way Pillow's PNG plugin does.
- thumbnail((max_side, max_side)) with its defaults (BICUBIC, reducing_gap=2.0). Because the image is converted
  first, thumbnail's draft() step (libjpeg DCT scaling) never runs: the full-resolution pixels are reduced by an
  integer factor with reduce() when the image is at least twice the target, then resampled bicubically. That is
  integer arithmetic plus Pillow's fixed-point filter, which the browser reproduces exactly; JPEG DCT scaling would
  tie the result to libjpeg's scaled IDCTs instead. Images that already fit are never upscaled.
- save(buf, "JPEG", quality=85) with Pillow's defaults: baseline, 4:2:0 chroma subsampling, the standard (Annex K)
  quantization tables scaled to quality 85, standard Huffman tables (optimize=False), not progressive, JFIF 1.01
  header, no EXIF or ICC profile. A COM marker in the source JPEG is carried over, as Pillow does.

To send the same pixels from production, call `model_jpeg(path, max_side)` (or copy its three lines).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

JPEG_QUALITY = 85


def model_jpeg(path: str | Path, max_side: int, quality: int = JPEG_QUALITY) -> tuple[bytes, tuple[int, int]]:
    img = Image.open(path).convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue(), img.size


# ---- Image views: the operations of lib/ops.ts, in plain Pillow, with the same arithmetic ------------------------
#
# A view is {"ops": [...], "regions": [{"id", "box"}], "enlarge": bool}. Areas are fractions (x0, y0, x1, y1) of the
# original image, given inline as {"box": [...]} or by region id as {"region": "..."}. Operations run in order on the
# full-resolution RGB image; crops and quarter turns move later areas with the image. Every float step below is the
# same IEEE double arithmetic, in the same order, as lib/ops.ts, so pixel boxes match exactly.


def _apply(t, x, y):
    a, b, c, d, e, f = t
    return a * x + b * y + e, c * x + d * y + f


def _then(t, n):
    a, b, c, d, e, f = t
    na, nb, nc, nd, ne, nf = n
    return (na * a + nb * c, na * b + nb * d, nc * a + nd * c, nc * b + nd * d, na * e + nb * f + ne, nc * e + nd * f + nf)


def _area_box(area, regions):
    if "box" in area:
        return area["box"]
    return next((r["box"] for r in regions if r["id"] == area["region"]), None)


def _pixel_box(box, src_size, t, size):
    ax, ay = _apply(t, box[0] * src_size[0], box[1] * src_size[1])
    bx, by = _apply(t, box[2] * src_size[0], box[3] * src_size[1])
    x0 = max(0, math.floor(min(ax, bx)))
    y0 = max(0, math.floor(min(ay, by)))
    x1 = min(size[0], math.ceil(max(ax, bx)))
    y1 = min(size[1], math.ceil(max(ay, by)))
    return x0, y0, max(x0 + 1, x1), max(y0 + 1, y1)


def _hex(color):
    h = color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4)) if len(h) == 6 else (255, 0, 255)


def apply_ops(img: Image.Image, ops: list, regions: list) -> Image.Image:
    src_size = img.size
    t = (1, 0, 0, 1, 0, 0)
    for op in ops:
        kind = op["kind"]
        if kind == "rotate":
            w, h = img.size
            k = op["degrees"] // 90  # clockwise quarter turns
            img = img.transpose({1: Image.Transpose.ROTATE_270, 2: Image.Transpose.ROTATE_180, 3: Image.Transpose.ROTATE_90}[k])
            t = _then(t, {1: (0, -1, 1, 0, h, 0), 2: (-1, 0, 0, -1, w, h), 3: (0, 1, -1, 0, 0, w)}[k])
            continue
        box = _area_box(op["area"], regions)
        if box is None:
            continue  # a deleted region: skipped, as in the browser
        x0, y0, x1, y1 = _pixel_box(box, src_size, t, img.size)
        if kind == "crop":
            mx = (x1 - x0) * op["margin"]
            my = (y1 - y0) * op["margin"]
            cx0, cy0 = max(0, math.floor(x0 - mx)), max(0, math.floor(y0 - my))
            cx1, cy1 = min(img.size[0], math.ceil(x1 + mx)), min(img.size[1], math.ceil(y1 + my))
            img = img.crop((cx0, cy0, cx1, cy1))
            t = _then(t, (1, 0, 0, 1, -cx0, -cy0))
        elif kind == "outline":
            # 1/250 of the longer side, at least 4 px, rounded half up (not Python's round, which rounds half to even)
            w = op["width"] if op["width"] > 0 else max(4, math.floor(max(img.size) / 250 + 0.5))
            img = img.copy()
            # drawn just outside the area: a band w pixels wide inside the rectangle grown by w
            ImageDraw.Draw(img).rectangle((x0 - w, y0 - w, x1 - 1 + w, y1 - 1 + w), outline=_hex(op["color"]), width=w)
        elif kind == "spotlight":
            lut = [min(255, math.floor(v * op["dim"] + 0.5)) for v in range(256)]
            dark = img.point(lut * 3)
            dark.paste(img.crop((x0, y0, x1, y1)), (x0, y0))
            img = dark
    return img


def enlarged_size(width: int, height: int, max_side: int) -> tuple[int, int]:
    if width >= height:
        return max_side, max(1, math.floor(height * max_side / width + 0.5))
    return max(1, math.floor(width * max_side / height + 0.5)), max_side


def view_jpeg(path: str | Path, max_side: int, view: dict, quality: int = JPEG_QUALITY) -> tuple[bytes, tuple[int, int]]:
    """One view of an image, as sent: operations on the full image, then thumbnail (or enlarge), then the JPEG."""
    img = apply_ops(Image.open(path).convert("RGB"), view.get("ops", []), view.get("regions", []))
    if view.get("enlarge") and max(img.size) < max_side:
        img = img.resize(enlarged_size(*img.size, max_side), Image.Resampling.BICUBIC)
    else:
        img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue(), img.size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--max-side", type=int, required=True)
    parser.add_argument("--quality", type=int, default=JPEG_QUALITY)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--view", type=Path, help="a view as JSON (ops, regions, enlarge) to apply before resizing")
    args = parser.parse_args()
    view = json.loads(args.view.read_text()) if args.view else None
    args.out.mkdir(parents=True, exist_ok=True)
    for src in args.inputs:
        data, (w, h) = view_jpeg(src, args.max_side, view, args.quality) if view else model_jpeg(src, args.max_side, args.quality)
        name = f"{src.stem}.jpg"
        (args.out / name).write_bytes(data)
        print(f"{hashlib.sha256(data).hexdigest()}  {w}x{h}  {name}")


if __name__ == "__main__":
    main()
