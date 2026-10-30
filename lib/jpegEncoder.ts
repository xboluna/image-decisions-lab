/**
 * A baseline JPEG encoder that writes the same bytes as Pillow's `img.save(buf, "JPEG", quality=q)`.
 *
 * Pillow hands an RGB image to libjpeg-turbo with jpeg_set_defaults + jpeg_set_quality(q, force_baseline): YCbCr,
 * 4:2:0, the Annex K quantization tables, the standard Huffman tables (no optimize), ISLOW DCT, no restart markers,
 * a JFIF 1.01 header with a 1:1 aspect and nothing else. This file ports exactly that path (jccolor.c,
 * jcsample.c h2v2_downsample, jcprepct.c edge padding, jfdctint.c, jcdctmgr.c reciprocal quantization as built
 * with SIMD, jccoefct.c dummy blocks, jchuff.c, jcmarker.c). Canvas encoders and mozjpeg differ from it.
 */

import type { Rgb } from "./pillow";

const NATURAL_ORDER = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const STD_LUMINANCE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103,
  77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMINANCE_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...Array(32).fill(99),
];

type HuffSpec = { bits: number[]; vals: number[] };
const DC_LUMINANCE: HuffSpec = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMINANCE: HuffSpec = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMINANCE: HuffSpec = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23,
    0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
    0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
    0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2,
    0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
    0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMINANCE: HuffSpec = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1,
    0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63,
    0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
    0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
    0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
    0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

/** jpeg_quality_scaling + jpeg_add_quant_table with force_baseline. Natural (row-major) order. */
export function quantTable(basic: number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return basic.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** compute_reciprocal with 16-bit DCTELEMs (libjpeg-turbo built with SIMD, as Pillow's wheels are). */
function divisors(table: number[]) {
  const recip = new Float64Array(64);
  const corr = new Float64Array(64);
  const shift = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    const divisor = table[i] << 3;
    if (divisor <= 1) {
      recip[i] = 1;
      corr[i] = 0;
      shift[i] = -16;
      continue;
    }
    const b = 31 - Math.clz32(divisor);
    let r = 16 + b;
    let fq = Math.floor(2 ** r / divisor);
    const fr = 2 ** r % divisor;
    let c = Math.floor(divisor / 2);
    if (fr === 0) {
      fq = Math.floor(fq / 2);
      r--;
    } else if (fr <= Math.floor(divisor / 2)) c++;
    else fq++;
    recip[i] = fq & 0xffff;
    corr[i] = c & 0xffff;
    shift[i] = r - 16;
  }
  return { recip, corr, shift };
}

type Divisors = ReturnType<typeof divisors>;

const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;
const CONST_BITS = 13;
const PASS1_BITS = 2;

// Products in the column pass can pass 2^31, so shift with floor division rather than >>.
const descale = (x: number, n: number) => Math.floor((x + 2 ** (n - 1)) / 2 ** n);

/** jpeg_fdct_islow, in place on 64 level-shifted samples. Output is scaled up by 8. */
function fdctIslow(d: Float64Array) {
  for (let r = 0; r < 64; r += 8) {
    const tmp0 = d[r] + d[r + 7];
    const tmp7 = d[r] - d[r + 7];
    const tmp1 = d[r + 1] + d[r + 6];
    const tmp6 = d[r + 1] - d[r + 6];
    const tmp2 = d[r + 2] + d[r + 5];
    const tmp5 = d[r + 2] - d[r + 5];
    const tmp3 = d[r + 3] + d[r + 4];
    const tmp4 = d[r + 3] - d[r + 4];
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;
    d[r] = (tmp10 + tmp11) * (1 << PASS1_BITS);
    d[r + 4] = (tmp10 - tmp11) * (1 << PASS1_BITS);
    const z1 = (tmp12 + tmp13) * FIX_0_541196100;
    d[r + 2] = descale(z1 + tmp13 * FIX_0_765366865, CONST_BITS - PASS1_BITS);
    d[r + 6] = descale(z1 + tmp12 * -FIX_1_847759065, CONST_BITS - PASS1_BITS);
    const o = odd(tmp4, tmp5, tmp6, tmp7);
    d[r + 7] = descale(o[0], CONST_BITS - PASS1_BITS);
    d[r + 5] = descale(o[1], CONST_BITS - PASS1_BITS);
    d[r + 3] = descale(o[2], CONST_BITS - PASS1_BITS);
    d[r + 1] = descale(o[3], CONST_BITS - PASS1_BITS);
  }
  for (let c = 0; c < 8; c++) {
    const tmp0 = d[c] + d[c + 56];
    const tmp7 = d[c] - d[c + 56];
    const tmp1 = d[c + 8] + d[c + 48];
    const tmp6 = d[c + 8] - d[c + 48];
    const tmp2 = d[c + 16] + d[c + 40];
    const tmp5 = d[c + 16] - d[c + 40];
    const tmp3 = d[c + 24] + d[c + 32];
    const tmp4 = d[c + 24] - d[c + 32];
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;
    d[c] = descale(tmp10 + tmp11, PASS1_BITS);
    d[c + 32] = descale(tmp10 - tmp11, PASS1_BITS);
    const z1 = (tmp12 + tmp13) * FIX_0_541196100;
    d[c + 16] = descale(z1 + tmp13 * FIX_0_765366865, CONST_BITS + PASS1_BITS);
    d[c + 48] = descale(z1 + tmp12 * -FIX_1_847759065, CONST_BITS + PASS1_BITS);
    const o = odd(tmp4, tmp5, tmp6, tmp7);
    d[c + 56] = descale(o[0], CONST_BITS + PASS1_BITS);
    d[c + 40] = descale(o[1], CONST_BITS + PASS1_BITS);
    d[c + 24] = descale(o[2], CONST_BITS + PASS1_BITS);
    d[c + 8] = descale(o[3], CONST_BITS + PASS1_BITS);
  }
}

const oddOut = new Float64Array(4);
/** The odd part of both passes (LL&M figure 8); returns the undescaled outputs 7, 5, 3, 1. */
function odd(tmp4: number, tmp5: number, tmp6: number, tmp7: number): Float64Array {
  let z1 = tmp4 + tmp7;
  let z2 = tmp5 + tmp6;
  let z3 = tmp4 + tmp6;
  let z4 = tmp5 + tmp7;
  const z5 = (z3 + z4) * FIX_1_175875602;
  tmp4 *= FIX_0_298631336;
  tmp5 *= FIX_2_053119869;
  tmp6 *= FIX_3_072711026;
  tmp7 *= FIX_1_501321110;
  z1 *= -FIX_0_899976223;
  z2 *= -FIX_2_562915447;
  z3 *= -FIX_1_961570560;
  z4 *= -FIX_0_390180644;
  z3 += z5;
  z4 += z5;
  oddOut[0] = tmp4 + z1 + z3;
  oddOut[1] = tmp5 + z2 + z4;
  oddOut[2] = tmp6 + z2 + z3;
  oddOut[3] = tmp7 + z1 + z4;
  return oddOut;
}

/** convsamp + fdct + quantize for the 8x8 block at (x, y) of a plane; writes quantized coefficients to out. */
function forwardDct(plane: Uint8Array, stride: number, x: number, y: number, div: Divisors, work: Float64Array, out: Int32Array) {
  for (let r = 0; r < 8; r++) {
    const row = (y + r) * stride + x;
    for (let c = 0; c < 8; c++) work[r * 8 + c] = plane[row + c] - 128;
  }
  fdctIslow(work);
  for (let i = 0; i < 64; i++) {
    const t = work[i];
    const a = t < 0 ? -t : t;
    const q = Math.floor(((a + div.corr[i]) * div.recip[i]) / 2 ** (div.shift[i] + 16));
    out[i] = t < 0 ? -q : q;
  }
}

type Huff = { code: Int32Array; size: Int32Array };
function huffTable(spec: HuffSpec): Huff {
  const code = new Int32Array(256);
  const size = new Int32Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < spec.bits[len - 1]; i++) {
      code[spec.vals[k]] = c++;
      size[spec.vals[k]] = len;
      k++;
    }
    c <<= 1;
  }
  return { code, size };
}

class ByteWriter {
  buf = new Uint8Array(1 << 16);
  length = 0;
  byte(b: number) {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = b;
  }
  word(w: number) {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }
  bytes(list: ArrayLike<number>) {
    for (let i = 0; i < list.length; i++) this.byte(list[i]);
  }
  result() {
    return this.buf.slice(0, this.length);
  }
}

class BitWriter {
  private acc = 0;
  private n = 0;
  private out: ByteWriter;
  constructor(out: ByteWriter) {
    this.out = out;
  }
  put(value: number, size: number) {
    if (!size) return;
    this.acc = (this.acc << size) | (value & ((1 << size) - 1));
    this.n += size;
    while (this.n >= 8) {
      const b = (this.acc >> (this.n - 8)) & 0xff;
      this.out.byte(b);
      if (b === 0xff) this.out.byte(0);
      this.n -= 8;
    }
    this.acc &= (1 << this.n) - 1;
  }
  /** flush_bits: pad the last byte with ones. */
  flush() {
    if (this.n > 0) this.put(0x7f, 8 - this.n);
  }
}

const nbits = (v: number) => (v === 0 ? 0 : 32 - Math.clz32(v));

function encodeBlock(bits: BitWriter, block: Int32Array, lastDc: number, dc: Huff, ac: Huff) {
  let temp = block[0] - lastDc;
  let n = nbits(Math.abs(temp));
  bits.put(dc.code[n], dc.size[n]);
  if (n) bits.put(temp < 0 ? temp - 1 : temp, n);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    temp = block[NATURAL_ORDER[k]];
    if (temp === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      bits.put(ac.code[0xf0], ac.size[0xf0]);
      run -= 16;
    }
    n = nbits(Math.abs(temp));
    const symbol = (run << 4) + n;
    bits.put(ac.code[symbol], ac.size[symbol]);
    bits.put(temp < 0 ? temp - 1 : temp, n);
    run = 0;
  }
  if (run > 0) bits.put(ac.code[0], ac.size[0]);
}

/** rgb_ycc_start's fixed-point tables (SCALEBITS 16). */
const YCC = (() => {
  const FIX = (x: number) => Math.floor(x * 65536 + 0.5);
  const t = (f: (i: number) => number) => Int32Array.from({ length: 256 }, (_, i) => f(i));
  const half = 1 << 15;
  const offset = 128 << 16;
  return {
    rY: t((i) => FIX(0.299) * i),
    gY: t((i) => FIX(0.587) * i),
    bY: t((i) => FIX(0.114) * i + half),
    rCb: t((i) => -FIX(0.16874) * i),
    gCb: t((i) => -FIX(0.33126) * i),
    bCb: t((i) => FIX(0.5) * i + offset + half - 1),
    gCr: t((i) => -FIX(0.41869) * i),
    bCr: t((i) => -FIX(0.08131) * i),
  };
})();

function writeHeaders(w: ByteWriter, width: number, height: number, lumaQ: number[], chromaQ: number[], comment?: Uint8Array) {
  w.word(0xffd8);
  w.word(0xffe0); // JFIF APP0: version 1.01, no density unit, 1:1, no thumbnail
  w.word(16);
  w.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  if (comment) {
    w.word(0xfffe);
    w.word(comment.length + 2);
    w.bytes(comment);
  }
  for (const [index, table] of [lumaQ, chromaQ].entries()) {
    w.word(0xffdb);
    w.word(67);
    w.byte(index);
    for (let k = 0; k < 64; k++) w.byte(table[NATURAL_ORDER[k]]);
  }
  w.word(0xffc0);
  w.word(17);
  w.byte(8);
  w.word(height);
  w.word(width);
  w.byte(3);
  w.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  for (const [klass, spec] of [
    [0x00, DC_LUMINANCE],
    [0x10, AC_LUMINANCE],
    [0x01, DC_CHROMINANCE],
    [0x11, AC_CHROMINANCE],
  ] as const) {
    w.word(0xffc4);
    w.word(2 + 1 + 16 + spec.vals.length);
    w.byte(klass);
    w.bytes(spec.bits);
    w.bytes(spec.vals);
  }
  w.word(0xffda);
  w.word(12);
  w.bytes([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
}

/**
 * Encodes packed RGB as Pillow does with save(format="JPEG", quality=quality). comment is written as a COM marker,
 * as Pillow does when the source image carried one (im.info["comment"]).
 */
export function encodeJpeg(img: Rgb, quality: number, comment?: Uint8Array): Uint8Array {
  const { width: W, height: H, data } = img;
  if (W < 1 || H < 1 || W > 65535 || H > 65535) throw new Error(`Cannot encode a ${W}x${H} image as JPEG.`);
  const lumaQ = quantTable(STD_LUMINANCE_QUANT, quality);
  const chromaQ = quantTable(STD_CHROMINANCE_QUANT, quality);
  const lumaDiv = divisors(lumaQ);
  const chromaDiv = divisors(chromaQ);

  const mcusX = Math.ceil(W / 16);
  const mcusY = Math.ceil(H / 16);
  const PW = mcusX * 16;
  const PH = mcusY * 16;
  const evenH = H + (H & 1);

  // Colour conversion; the right edge is replicated to the MCU width (expand_right_edge) and the bottom row to
  // the next row pair (expand_bottom_edge of the conversion buffer).
  const Y = new Uint8Array(PW * PH);
  const Cb = new Uint8Array(PW * evenH);
  const Cr = new Uint8Array(PW * evenH);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const o = y * PW + x;
      Y[o] = (YCC.rY[r] + YCC.gY[g] + YCC.bY[b]) >> 16;
      Cb[o] = (YCC.rCb[r] + YCC.gCb[g] + YCC.bCb[b]) >> 16;
      Cr[o] = (YCC.bCb[r] + YCC.gCr[g] + YCC.bCr[b]) >> 16;
    }
    for (const plane of [Y, Cb, Cr]) plane.fill(plane[y * PW + W - 1], y * PW + W, (y + 1) * PW);
  }
  for (let y = H; y < evenH; y++) {
    Cb.copyWithin(y * PW, (H - 1) * PW, H * PW);
    Cr.copyWithin(y * PW, (H - 1) * PW, H * PW);
  }
  // The luma plane is padded by replicating its last row down to the iMCU height.
  for (let y = H; y < PH; y++) Y.copyWithin(y * PW, (H - 1) * PW, H * PW);

  // h2v2_downsample (bias 1, 2, 1, 2, ... along each row), then pad the downsampled rows to the iMCU height.
  const CW = PW / 2;
  const CH = PH / 2;
  const down = (src: Uint8Array) => {
    const out = new Uint8Array(CW * CH);
    const rows = evenH / 2;
    for (let y = 0; y < rows; y++) {
      const r0 = 2 * y * PW;
      const r1 = r0 + PW;
      let bias = 1;
      for (let x = 0; x < CW; x++) {
        out[y * CW + x] = (src[r0 + 2 * x] + src[r0 + 2 * x + 1] + src[r1 + 2 * x] + src[r1 + 2 * x + 1] + bias) >> 2;
        bias ^= 3;
      }
    }
    for (let y = rows; y < CH; y++) out.copyWithin(y * CW, (rows - 1) * CW, rows * CW);
    return out;
  };
  const CbD = down(Cb);
  const CrD = down(Cr);

  const w = new ByteWriter();
  writeHeaders(w, W, H, lumaQ, chromaQ, comment);
  const bits = new BitWriter(w);
  const dcL = huffTable(DC_LUMINANCE);
  const acL = huffTable(AC_LUMINANCE);
  const dcC = huffTable(DC_CHROMINANCE);
  const acC = huffTable(AC_CHROMINANCE);

  // Luma blocks past the image's own block count are dummies: zero AC, DC copied from the previous block.
  const lumaBlocksX = Math.ceil(W / 8);
  const lumaBlocksY = Math.ceil(H / 8);
  const work = new Float64Array(64);
  const lumaBlocks = [0, 1, 2, 3].map(() => new Int32Array(64));
  const cb = new Int32Array(64);
  const cr = new Int32Array(64);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let i = 0; i < 4; i++) {
        const bx = mx * 2 + (i & 1);
        const by = my * 2 + (i >> 1);
        const block = lumaBlocks[i];
        if (bx < lumaBlocksX && by < lumaBlocksY) forwardDct(Y, PW, bx * 8, by * 8, lumaDiv, work, block);
        else {
          block.fill(0);
          block[0] = lumaBlocks[i - 1][0];
        }
      }
      forwardDct(CbD, CW, mx * 8, my * 8, chromaDiv, work, cb);
      forwardDct(CrD, CW, mx * 8, my * 8, chromaDiv, work, cr);
      for (const block of lumaBlocks) {
        encodeBlock(bits, block, dcY, dcL, acL);
        dcY = block[0];
      }
      encodeBlock(bits, cb, dcCb, dcC, acC);
      dcCb = cb[0];
      encodeBlock(bits, cr, dcCr, dcC, acC);
      dcCr = cr[0];
    }
  }
  bits.flush();
  w.word(0xffd9);
  return w.result();
}
