/**
 * The image the model is sent: the canonical pipeline, byte for byte what scripts/reference_pipeline.py writes.
 *
 *   img = Image.open(f).convert("RGB")
 *   img.thumbnail((max_side, max_side))      # BICUBIC, reducing_gap=2.0; never upscales
 *   img.save(buf, "JPEG", quality=85)        # libjpeg-turbo defaults: 4:2:0, baseline, standard tables
 *
 * The model's answer on a borderline image can flip after a one-level pixel change, so "looks the same" is not
 * enough: the browser must send what a production Python harness sends.
 */

import { decodeToRgb, type Decoded } from "./decodeImage.ts";
import { encodeJpeg } from "./jpegEncoder.ts";
import { applyOps, type ImageOp, type Region } from "./ops.ts";
import { resample, thumbnail } from "./pillow.ts";

export type ModelImage = {
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** False when the input format had no Pillow-exact decoder and the browser decoded it instead. */
  exact: boolean;
};

export async function encodeForModel(bytes: Uint8Array, maxSide: number, quality: number, view: ViewSpec = { ops: [], regions: [], enlarge: false }): Promise<ModelImage> {
  return renderView(await decodeToRgb(bytes), view, maxSide, quality);
}

/**
 * Size of an image enlarged so its longest side is exactly maxSide, the other side rounded half up. Defined
 * explicitly (not with Python's round, which rounds half to even) so the reference pipeline computes the same.
 */
export function enlargedSize(width: number, height: number, maxSide: number): [number, number] {
  if (width >= height) return [maxSide, Math.max(1, Math.floor((height * maxSide) / width + 0.5))];
  return [Math.max(1, Math.floor((width * maxSide) / height + 0.5)), maxSide];
}

export type ViewSpec = { ops: ImageOp[]; regions: Region[]; enlarge: boolean };

/**
 * One view of an already decoded image: its operations on the full-resolution pixels, then Pillow's thumbnail (or,
 * for `enlarge` when the result is smaller than maxSide, Image.resize to enlargedSize with BICUBIC), then the JPEG.
 * reference_pipeline.py `view_jpeg` is the Pillow equivalent.
 */
export function renderView(decoded: Decoded, view: ViewSpec, maxSide: number, quality: number): ModelImage {
  const { image } = applyOps(decoded.image, view.ops, view.regions);
  const longest = Math.max(image.width, image.height);
  const sized = view.enlarge && longest < maxSide ? resample(image, ...enlargedSize(image.width, image.height, maxSide)) : thumbnail(image, maxSide);
  return { jpeg: encodeJpeg(sized, quality, decoded.comment), width: sized.width, height: sized.height, exact: decoded.exact };
}
