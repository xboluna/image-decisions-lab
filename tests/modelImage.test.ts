import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { setJpegWasmLoader } from "@/lib/decodeImage";
import { encodeForModel } from "@/lib/modelImage";
import { reduce, thumbnailSize } from "@/lib/pillow";

const root = path.resolve(__dirname, "..");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const file = (p: string) => new Uint8Array(readFileSync(path.join(root, p)));

beforeAll(() => setJpegWasmLoader(async () => WebAssembly.compile(file("node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"))));

describe("Pillow thumbnail sizing", () => {
  it("keeps the aspect ratio the way Image.thumbnail rounds it, and never upscales", () => {
    expect(thumbnailSize(1024, 640, 512)).toEqual([512, 320]);
    expect(thumbnailSize(97, 61, 13)).toEqual([13, 8]);
    expect(thumbnailSize(4000, 3000, 1024)).toEqual([1024, 768]);
    expect(thumbnailSize(3000, 4000, 1024)).toEqual([768, 1024]);
    expect(thumbnailSize(3000, 20, 512)).toEqual([512, 3]);
    expect(thumbnailSize(1024, 640, 1024)).toBeNull();
    expect(thumbnailSize(300, 200, 1280)).toBeNull();
  });

  it("reduces with Reduce.c's rounding, partial edge cells included", () => {
    // 3x2 RGB image, reduced 2x2: one full cell and one 1x2 edge cell
    const data = Uint8Array.from([10, 0, 255, 11, 0, 255, 200, 1, 3, 13, 0, 254, 12, 1, 255, 201, 2, 4]);
    const out = reduce({ width: 3, height: 2, data }, 2, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    // (10+11+13+12+2)>>2 = 12, (0+0+0+1+2)>>2 = 0, (255+255+254+255+2)>>2 = 255; edge: (200+201+1)/2 = 201, 2, 4
    expect(Array.from(out.data)).toEqual([12, 0, 255, 201, 2, 4]);
  });
});

// Expected hashes come from `uv run scripts/reference_pipeline.py --max-side N --out DIR <input>` (Pillow 12.2.0).
describe("model image pipeline matches the Pillow reference byte for byte", () => {
  const png = "tests/fixtures/crop-97x61-rgba.png";
  const demo = "public/demo/train/images/scene0_frame112.jpg";
  const cases: [string, number, string, string][] = [
    [png, 13, "13x8", "f3b361cddfd7f5645a114e844f1b4e12741dccd0f7cf70183c2e691e72d23102"], // reduce 3x3, then bicubic
    [png, 20, "20x13", "1142443732d977d08b57d1858c3b5c920a10905aedb48e90debb998714c90785"], // reduce 2x2
    [png, 40, "40x25", "491ec8210aa77030cca42c2dd1b8d18624b6d04b560c62939dc1376c9858c306"], // bicubic only
    [png, 200, "97x61", "ae43592e41a3831c130e689f04ec8749284fa5c786b907e4da22609d3acee41b"], // fits: re-encoded only
    [demo, 333, "333x208", "19ead111323ac14f2bdcf1397731430069e1bf5d5e689d75efbf158cb050d5c8"],
    [demo, 512, "512x320", "bfc757fe75dc603ea1b030655fade3b3a17485ab4abfcbc798f2676a6272b0ce"],
    [demo, 1024, "1024x640", "18519c64dfcdcb0c01d18f359e31d72665e426cd8eab905b2283b09a07da2b0c"],
  ];
  for (const [input, side, size, expected] of cases) {
    it(`${path.basename(input)} at ${side}px`, async () => {
      const out = await encodeForModel(file(input), side, 85);
      expect(`${out.width}x${out.height}`).toBe(size);
      expect(out.exact).toBe(true);
      expect(sha(out.jpeg)).toBe(expected);
    });
  }
});
