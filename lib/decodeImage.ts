/**
 * Decodes an image file to the 8-bit RGB pixels Pillow's `Image.open(f).convert("RGB")` produces.
 *
 * JPEG goes through libjpeg (mozjpeg's decoder, compiled to WebAssembly) with libjpeg-turbo's defaults: ISLOW IDCT
 * and fancy upsampling, the same code path Pillow's bundled libjpeg-turbo takes. PNG and uncompressed BMP are
 * lossless, so any correct decoder matches once Pillow's mode conversions are copied. Like Pillow, nothing here
 * applies EXIF orientation, colour profiles or PNG gamma, and alpha is dropped rather than composited.
 * Anything else (WebP, GIF, CMYK JPEG, compressed or paletted BMP) falls back to the browser's decoder and is
 * reported as not pixel-exact.
 */

import type { Rgb } from "./pillow.ts";

export type Decoded = {
  image: Rgb;
  /** The decoder reproduces Pillow's pixels exactly. False for the browser fallback. */
  exact: boolean;
  format: "jpeg" | "png" | "bmp" | "other";
  /** A JPEG COM marker; Pillow copies it into the JPEG it saves. */
  comment?: Uint8Array;
};

// In the browser the decoder's glue code fetches mozjpeg_dec.wasm itself (the bundler emits it as an asset).
// Node (scripts, tests) has no page to fetch from, so it passes the compiled module.
let loadWasm: (() => Promise<WebAssembly.Module>) | null = null;

export function setJpegWasmLoader(loader: () => Promise<WebAssembly.Module>) {
  loadWasm = loader;
  jpegDecoder = null;
}

type JpegDecode = (buffer: ArrayBuffer, options: { preserveOrientation: boolean }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
let jpegDecoder: Promise<JpegDecode> | null = null;

function decoder(): Promise<JpegDecode> {
  jpegDecoder ??= (async () => {
    const mod = await import("@jsquash/jpeg/decode.js");
    const init = mod.init as unknown as (module?: WebAssembly.Module) => Promise<void>;
    await init(loadWasm ? await loadWasm() : undefined);
    return mod.default as unknown as JpegDecode;
  })();
  jpegDecoder.catch(() => (jpegDecoder = null));
  return jpegDecoder;
}

function rgbaToRgb(width: number, height: number, rgba: ArrayLike<number>): Rgb {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    data[i] = rgba[j];
    data[i + 1] = rgba[j + 1];
    data[i + 2] = rgba[j + 2];
  }
  return { width, height, data };
}

/** Walks the JPEG markers up to the first scan: the frame's component count and the last COM payload. */
function jpegInfo(bytes: Uint8Array): { components: number; comment?: Uint8Array } {
  let components = 0;
  let comment: Uint8Array | undefined;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xfe) comment = bytes.slice(i + 4, i + 2 + length);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) components = bytes[i + 9];
    i += 2 + length;
  }
  return { components, comment };
}

async function decodeJpeg(bytes: Uint8Array): Promise<Decoded | null> {
  const { components, comment } = jpegInfo(bytes);
  // The decoder cannot output CMYK/YCCK as RGB; Pillow's CMYK->RGB conversion would differ anyway.
  if (components !== 1 && components !== 3) return null;
  const decode = await decoder();
  try {
    // preserveOrientation: false leaves EXIF rotation alone, as Image.open does
    const img = await decode(bytes.slice().buffer, { preserveOrientation: false });
    return { image: rgbaToRgb(img.width, img.height, img.data), exact: true, format: "jpeg", comment };
  } catch (err) {
    jpegDecoder = null; // a fatal libjpeg error leaves the module unusable
    throw err;
  }
}

/** PngImagePlugin's modes, then convert("RGB"): low bit depths scale to 0..255, 16-bit keeps the high byte. */
async function decodePng(bytes: Uint8Array): Promise<Decoded | null> {
  // fast-png mis-reads Adam7 rows below 8 bits per sample
  const interlaced = bytes[28] === 1;
  if (interlaced && bytes[24] < 8) return null;
  const { decode } = await import("fast-png");
  const png = decode(bytes);
  const { width, height, depth, channels } = png;
  const n = width * height;
  const out = new Uint8Array(n * 3);
  let src: ArrayLike<number> = png.data;
  if (depth < 8) {
    // Rows of packed 1, 2 or 4 bit samples (greyscale or palette, so one channel), each row byte-aligned.
    const unpacked = new Uint8Array(n);
    const rowBytes = Math.ceil((width * depth) / 8);
    const mask = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = x * depth;
        unpacked[y * width + x] = (png.data[y * rowBytes + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
      }
    }
    src = unpacked;
  }
  if (png.palette) {
    // Indices past the end of the palette read Pillow's initial greyscale ramp.
    const palette = png.palette;
    for (let i = 0; i < n; i++) {
      const index = src[i];
      const entry = palette[index];
      out[i * 3] = entry ? entry[0] : index;
      out[i * 3 + 1] = entry ? entry[1] : index;
      out[i * 3 + 2] = entry ? entry[2] : index;
    }
    return { image: { width, height, data: out }, exact: true, format: "png" };
  }
  const sample = (v: number): number => {
    if (depth === 16) return v >> 8;
    if (depth === 8) return v;
    return depth === 1 ? v * 255 : depth === 2 ? v * 0x55 : v * 0x11;
  };
  for (let i = 0; i < n; i++) {
    const p = i * channels;
    if (channels >= 3) {
      out[i * 3] = sample(src[p]);
      out[i * 3 + 1] = sample(src[p + 1]);
      out[i * 3 + 2] = sample(src[p + 2]);
    } else {
      // 16-bit greyscale opens as I;16, and I;16 -> RGB clips at 255 instead of shifting (Convert.c I16_RGB).
      const v = depth === 16 && channels === 1 ? Math.min(src[p], 255) : sample(src[p]);
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v;
    }
  }
  return { image: { width, height, data: out }, exact: true, format: "png" };
}

/** Uncompressed 24- or 32-bit BMP (BI_RGB, or BI_BITFIELDS with the standard masks); null for anything else. */
function decodeBmp(bytes: Uint8Array): Decoded | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 54) return null;
  const offset = view.getUint32(10, true);
  const header = view.getUint32(14, true);
  if (header < 40) return null;
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const standardMasks =
    compression === 3 &&
    bpp === 32 &&
    bytes.length >= 66 &&
    view.getUint32(54, true) === 0x00ff0000 &&
    view.getUint32(58, true) === 0x0000ff00 &&
    view.getUint32(62, true) === 0x000000ff;
  if (!(bpp === 24 || bpp === 32) || !(compression === 0 || standardMasks) || width <= 0 || rawHeight === 0) return null;
  const height = Math.abs(rawHeight);
  const step = bpp / 8;
  const stride = Math.ceil((width * step) / 4) * 4;
  if (offset + stride * height > bytes.length) return null;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * step;
      const o = (y * width + x) * 3;
      data[o] = bytes[p + 2];
      data[o + 1] = bytes[p + 1];
      data[o + 2] = bytes[p];
    }
  }
  return { image: { width, height, data }, exact: true, format: "bmp" };
}

/** The browser's own decoder, for formats without an exact decoder here. Not guaranteed to match Pillow. */
async function decodeWithBrowser(bytes: Uint8Array): Promise<Decoded> {
  if (typeof createImageBitmap === "undefined") throw new Error("This image format needs a browser to decode.");
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const { width, height } = bitmap;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("This browser cannot draw images to a canvas.");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { image: rgbaToRgb(width, height, ctx.getImageData(0, 0, width, height).data), exact: false, format: "other" };
}

export async function decodeToRgb(bytes: Uint8Array): Promise<Decoded> {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return (await decodeJpeg(bytes)) ?? decodeWithBrowser(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return (await decodePng(bytes)) ?? decodeWithBrowser(bytes);
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return decodeBmp(bytes) ?? decodeWithBrowser(bytes);
  return decodeWithBrowser(bytes);
}
