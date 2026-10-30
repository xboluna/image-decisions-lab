/**
 * Pillow's Image.thumbnail, ported line for line so the browser resizes exactly like Python does.
 *
 * Mirrors Pillow 12 Image.thumbnail / Image.resize (size rounding, reducing_gap=2.0), libImaging/Reduce.c (the
 * integer box pre-reduction) and libImaging/Resample.c (BICUBIC, 8 bits per channel, fixed-point coefficients).
 * Images are packed 8-bit RGB. scripts/check_parity.mjs compares the result with Pillow.
 */

export type Rgb = { width: number; height: number; data: Uint8Array };

const PRECISION_BITS = 32 - 8 - 2;
const BICUBIC_SUPPORT = 2.0;
const REDUCING_GAP = 2.0;

function bicubicFilter(x: number): number {
  const a = -0.5;
  if (x < 0.0) x = -x;
  if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1;
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a;
  return 0.0;
}

function clip8(v: number): number {
  const s = v >> PRECISION_BITS;
  return s < 0 ? 0 : s > 255 ? 255 : s;
}

/** precompute_coeffs followed by normalize_coeffs_8bpc. in0 and in1 are C floats (the box is float[4]). */
function coefficients(inSize: number, in0: number, in1: number, outSize: number) {
  const scale = Math.fround(in1 - in0) / outSize;
  const filterscale = scale < 1.0 ? 1.0 : scale;
  const support = BICUBIC_SUPPORT * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale;
    let ww = 0.0;
    const ss = 1.0 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const w = bicubicFilter((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      if (ww !== 0.0) k[x] /= ww;
    }
    for (let x = 0; x < ksize; x++) {
      const v = x < xmax ? k[x] : 0;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, kk, bounds };
}

/** ImagingResample with BICUBIC: horizontal pass over the rows used, then vertical. box is (x0, y0, x1, y1). */
export function resample(img: Rgb, width: number, height: number, box: [number, number, number, number] = [0, 0, img.width, img.height]): Rgb {
  const [x0, y0, x1, y1] = box.map(Math.fround);
  const needHorizontal = width !== img.width || x0 !== 0 || x1 !== width;
  const needVertical = height !== img.height || y0 !== 0 || y1 !== height;
  const horiz = coefficients(img.width, x0, x1, width);
  const vert = coefficients(img.height, y0, y1, height);
  const yFirst = vert.bounds[0];
  const yLast = vert.bounds[height * 2 - 2] + vert.bounds[height * 2 - 1];
  const half = 1 << (PRECISION_BITS - 1);

  let src = img;
  if (needHorizontal) {
    for (let i = 0; i < height; i++) vert.bounds[i * 2] -= yFirst;
    const rows = yLast - yFirst;
    const out = new Uint8Array(width * rows * 3);
    const { ksize, kk, bounds } = horiz;
    for (let yy = 0; yy < rows; yy++) {
      const row = (yy + yFirst) * img.width * 3;
      for (let xx = 0; xx < width; xx++) {
        const xmin = bounds[xx * 2];
        const xmax = bounds[xx * 2 + 1];
        const k = xx * ksize;
        let s0 = half;
        let s1 = half;
        let s2 = half;
        for (let x = 0; x < xmax; x++) {
          const p = row + (x + xmin) * 3;
          const c = kk[k + x];
          s0 += img.data[p] * c;
          s1 += img.data[p + 1] * c;
          s2 += img.data[p + 2] * c;
        }
        const o = (yy * width + xx) * 3;
        out[o] = clip8(s0);
        out[o + 1] = clip8(s1);
        out[o + 2] = clip8(s2);
      }
    }
    src = { width, height: rows, data: out };
  }
  if (!needVertical) return needHorizontal ? src : { ...img, data: img.data.slice() };

  const out = new Uint8Array(src.width * height * 3);
  const { ksize, kk, bounds } = vert;
  for (let yy = 0; yy < height; yy++) {
    const k = yy * ksize;
    const ymin = bounds[yy * 2];
    const ymax = bounds[yy * 2 + 1];
    for (let xx = 0; xx < src.width; xx++) {
      let s0 = half;
      let s1 = half;
      let s2 = half;
      for (let y = 0; y < ymax; y++) {
        const p = ((y + ymin) * src.width + xx) * 3;
        const c = kk[k + y];
        s0 += src.data[p] * c;
        s1 += src.data[p + 1] * c;
        s2 += src.data[p + 2] * c;
      }
      const o = (yy * src.width + xx) * 3;
      out[o] = clip8(s0);
      out[o + 1] = clip8(s1);
      out[o + 2] = clip8(s2);
    }
  }
  return { width: src.width, height, data: out };
}

/** division_UINT32(n, 8) in Reduce.c: computed in single precision, then truncated. */
function reduceMultiplier(n: number): number {
  return Math.trunc(Math.fround(4294967296 / Math.fround(256 * n)));
}

/**
 * Image.reduce((xscale, yscale)): the mean of each xscale x yscale cell, partial cells at the right and bottom
 * edges included. Every Reduce.c variant (2x2, 3x3, NxN, corners) rounds as ((sum + n/2) * multiplier) >> 24;
 * for the power-of-two shortcuts the multiplier is an exact power of two, so one formula covers them all.
 */
export function reduce(img: Rgb, xscale: number, yscale: number): Rgb {
  const width = Math.ceil(img.width / xscale);
  const height = Math.ceil(img.height / yscale);
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const yFrom = y * yscale;
    const yTo = Math.min(yFrom + yscale, img.height);
    for (let x = 0; x < width; x++) {
      const xFrom = x * xscale;
      const xTo = Math.min(xFrom + xscale, img.width);
      const n = (xTo - xFrom) * (yTo - yFrom);
      const amend = Math.floor(n / 2);
      const mult = reduceMultiplier(n);
      let s0 = amend;
      let s1 = amend;
      let s2 = amend;
      for (let yy = yFrom; yy < yTo; yy++) {
        for (let xx = xFrom; xx < xTo; xx++) {
          const p = (yy * img.width + xx) * 3;
          s0 += img.data[p];
          s1 += img.data[p + 1];
          s2 += img.data[p + 2];
        }
      }
      const o = (y * width + x) * 3;
      // UINT32 arithmetic in C: wrap the product before the shift
      out[o] = Math.floor((s0 * mult) % 4294967296 / 16777216);
      out[o + 1] = Math.floor((s1 * mult) % 4294967296 / 16777216);
      out[o + 2] = Math.floor((s2 * mult) % 4294967296 / 16777216);
    }
  }
  return { width, height, data: out };
}

/** The size Image.thumbnail((maxSide, maxSide)) picks, or null when the image already fits (never upscales). */
export function thumbnailSize(width: number, height: number, maxSide: number): [number, number] | null {
  let x = Math.floor(maxSide);
  let y = Math.floor(maxSide);
  if (x >= width && y >= height) return null;
  const aspect = width / height;
  // min(floor, ceil, key=...) keeps the first on a tie, then max(..., 1)
  const roundAspect = (n: number, key: (v: number) => number) => {
    const lo = Math.floor(n);
    const hi = Math.ceil(n);
    return Math.max(key(hi) < key(lo) ? hi : lo, 1);
  };
  if (x / y >= aspect) x = roundAspect(y * aspect, (n) => Math.abs(aspect - n / y));
  else y = roundAspect(x / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - x / n)));
  return [x, y];
}

/**
 * Image.thumbnail((maxSide, maxSide)) with its defaults (BICUBIC, reducing_gap=2.0) on an already-decoded image,
 * i.e. after convert("RGB"), so draft() has nothing to do: when the image is at least twice the target size,
 * reduce() by the integer factor first, then resample the remaining (fractional) box.
 */
export function thumbnail(img: Rgb, maxSide: number): Rgb {
  const size = thumbnailSize(img.width, img.height, maxSide);
  if (!size || (size[0] === img.width && size[1] === img.height)) return img;
  const [width, height] = size;
  let box: [number, number, number, number] = [0, 0, img.width, img.height];
  let src = img;
  const factorX = Math.trunc(img.width / width / REDUCING_GAP) || 1;
  const factorY = Math.trunc(img.height / height / REDUCING_GAP) || 1;
  if (factorX > 1 || factorY > 1) {
    // _get_safe_box is the whole image here: the box starts at 0 and ends at the image edge.
    src = reduce(img, factorX, factorY);
    box = [0, 0, img.width / factorX, img.height / factorY];
  }
  // Image.resize's guard for extreme aspect ratios: resample the height first, then the width.
  if (src.height > src.width * 100 && height < src.height) {
    const tall = resample(src, src.width, height, [0, box[1], src.width, box[3]]);
    return resample(tall, width, height, [box[0], 0, box[2], height]);
  }
  return resample(src, width, height, box);
}
