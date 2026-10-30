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
from pathlib import Path

from PIL import Image

JPEG_QUALITY = 85


def model_jpeg(path: str | Path, max_side: int, quality: int = JPEG_QUALITY) -> tuple[bytes, tuple[int, int]]:
    img = Image.open(path).convert("RGB")
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
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for src in args.inputs:
        data, (w, h) = model_jpeg(src, args.max_side, args.quality)
        name = f"{src.stem}.jpg"
        (args.out / name).write_bytes(data)
        print(f"{hashlib.sha256(data).hexdigest()}  {w}x{h}  {name}")


if __name__ == "__main__":
    main()
