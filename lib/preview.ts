"use client";
import { db } from "./db";
import { applyOps, type ImageOp, type Region, type Rgb } from "./ops";

/** Longest side of images decoded for on-screen previews: enough detail to place boxes, small enough to stay fast. */
export const PREVIEW_SIDE = 1600;

/** Preview pixels plus the size of the stored image they were shrunk from. */
export type PreviewRgb = Rgb & { sourceWidth: number; sourceHeight: number };

const decoded = new Map<string, Promise<PreviewRgb | null>>();

/** A stored image as RGB pixels for previews, shrunk to PREVIEW_SIDE. Areas are fractions, so they land the same. */
export function previewRgb(hash: string): Promise<PreviewRgb | null> {
  let p = decoded.get(hash);
  if (!p) {
    p = (async () => {
      const blob = await db.getImage(hash);
      if (!blob) return null;
      // The same decoder as the images sent (no EXIF rotation, like Pillow), so boxes drawn here land on the same
      // pixels; then Pillow's thumbnail for the preview copy.
      const [{ decodeToRgb }, { thumbnail }] = await Promise.all([import("./decodeImage"), import("./pillow")]);
      const { image } = await decodeToRgb(new Uint8Array(await blob.arrayBuffer()));
      return { ...thumbnail(image, PREVIEW_SIDE), sourceWidth: image.width, sourceHeight: image.height };
    })().catch(() => null);
    decoded.set(hash, p);
  }
  return p;
}

/** Draws RGB pixels into a canvas element at their own size; CSS scales it to fit. */
export function paint(canvas: HTMLCanvasElement, img: Rgb) {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const out = ctx.createImageData(img.width, img.height);
  for (let i = 0, j = 0; j < img.data.length; i += 4, j += 3) {
    out.data[i] = img.data[j];
    out.data[i + 1] = img.data[j + 1];
    out.data[i + 2] = img.data[j + 2];
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

const thumbs = new Map<string, Promise<string | null>>();

/** A small JPEG of an image after its operations, for thumbnails of edited examples. Cached per image and edits. */
export function editedThumb(hash: string, ops: ImageOp[], regions: Region[], side = 320): Promise<string | null> {
  const key = `${hash}|${side}|${JSON.stringify(ops)}|${JSON.stringify(regions)}`;
  let p = thumbs.get(key);
  if (!p) {
    p = previewRgb(hash).then((rgb) => {
      if (!rgb) return null;
      const { image } = applyOps(rgb, ops, regions, { scale: rgb.width / rgb.sourceWidth });
      const scale = Math.min(1, side / Math.max(image.width, image.height));
      const full = document.createElement("canvas");
      paint(full, image);
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(image.width * scale));
      out.height = Math.max(1, Math.round(image.height * scale));
      const ctx = out.getContext("2d") as CanvasRenderingContext2D;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full, 0, 0, out.width, out.height);
      return out.toDataURL("image/jpeg", 0.85);
    });
    thumbs.set(key, p);
  }
  return p;
}
