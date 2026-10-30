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

import { decodeToRgb } from "./decodeImage.ts";
import { encodeJpeg } from "./jpegEncoder.ts";
import { thumbnail } from "./pillow.ts";

export type ModelImage = {
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** False when the input format had no Pillow-exact decoder and the browser decoded it instead. */
  exact: boolean;
};

export async function encodeForModel(bytes: Uint8Array, maxSide: number, quality: number): Promise<ModelImage> {
  const { image, exact, comment } = await decodeToRgb(bytes);
  const resized = thumbnail(image, maxSide);
  return { jpeg: encodeJpeg(resized, quality, comment), width: resized.width, height: resized.height, exact };
}
