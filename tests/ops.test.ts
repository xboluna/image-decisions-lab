import { describe, expect, it } from "vitest";
import { applyOps, describeOps, drawRectangle, rotateClockwise, spotlight, type Region, type Rgb } from "@/lib/ops";

/** A w×h image where each pixel's red channel encodes x and green encodes y, so crops are easy to check. */
function grid(w: number, h: number): Rgb {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, 100], (y * w + x) * 3);
  return { width: w, height: h, data };
}
const px = (img: Rgb, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3));
const regions: Region[] = [{ id: "r", name: "rack", box: [0.25, 0.5, 0.5, 0.75] }];

describe("applyOps", () => {
  it("crops a region with a margin on each side", () => {
    const { image } = applyOps(grid(200, 100), [{ kind: "crop", area: { region: "r" }, margin: 0.1 }], regions);
    // region: x 50..100, y 50..75 → margin 5 px and 2.5 px → x 45..105, y 47..78 (snapped outward)
    expect([image.width, image.height]).toEqual([60, 31]);
    expect(px(image, 0, 0)).toEqual([45, 47, 100]);
  });
  it("clamps a crop to the image", () => {
    const { image } = applyOps(grid(100, 100), [{ kind: "crop", area: { box: [0.9, 0.9, 1, 1] }, margin: 0.5 }], []);
    expect([image.width, image.height]).toEqual([15, 15]);
  });
  it("keeps later operations on the same object after a crop", () => {
    const ops = [
      { kind: "crop" as const, area: { region: "r" }, margin: 0.5 },
      { kind: "outline" as const, area: { region: "r" }, color: "#ff00ff", width: 2 },
    ];
    const { image } = applyOps(grid(200, 100), ops, regions);
    // crop starts at x 25, y 37; the region (50,50)-(100,75) is at (25,13)-(75,38); outline sits just outside it
    expect(px(image, 23, 20)).toEqual([255, 0, 255]);
    expect(px(image, 24, 20)).toEqual([255, 0, 255]);
    expect(px(image, 25, 20)).toEqual([50, 57, 100]); // inside the region: untouched
  });
  it("moves areas with a rotation", () => {
    const ops = [
      { kind: "rotate" as const, degrees: 90 as const },
      { kind: "crop" as const, area: { region: "r" }, margin: 0 },
    ];
    const { image } = applyOps(grid(200, 100), ops, regions);
    // the same 50×25 region, turned on its side
    expect([image.width, image.height]).toEqual([25, 50]);
    const values = new Set<number>();
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) values.add(px(image, x, y)[0]);
    expect(Math.min(...values)).toBe(50);
    expect(Math.max(...values)).toBe(99);
  });
  it("skips an operation whose region was deleted, with a warning", () => {
    const { image, warnings } = applyOps(grid(10, 10), [{ kind: "crop", area: { region: "gone" }, margin: 0 }], regions);
    expect(image.width).toBe(10);
    expect(warnings[0]).toMatch(/region no longer exists/);
  });
  it("describes a view in plain words", () => {
    expect(describeOps([{ kind: "crop", area: { region: "r" }, margin: 0.12 }, { kind: "outline", area: { region: "r" }, color: "#ff00ff", width: 0 }], regions)).toBe("Crop to rack +12%, outline rack");
    expect(describeOps([], regions)).toBe("The whole image");
  });
});

describe("primitives", () => {
  it("draws Pillow's rectangle band inside the inclusive box", () => {
    const img = drawRectangle(grid(10, 10), 2, 2, 7, 7, 2, [1, 2, 3]);
    expect(px(img, 2, 2)).toEqual([1, 2, 3]);
    expect(px(img, 3, 5)).toEqual([1, 2, 3]);
    expect(px(img, 4, 4)).toEqual([4, 4, 100]);
    expect(px(img, 8, 8)).toEqual([8, 8, 100]);
  });
  it("dims everything outside the spotlight, rounding half up", () => {
    const img = spotlight(grid(10, 10), 2, 2, 5, 5, 0.5);
    expect(px(img, 3, 3)).toEqual([3, 3, 100]);
    expect(px(img, 9, 0)).toEqual([5, 0, 50]); // 9 * 0.5 = 4.5 → 5
  });
  it("turns clockwise", () => {
    const r = rotateClockwise(grid(3, 2), 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(px(r, 1, 0)).toEqual([0, 0, 100]); // the old top-left is now top-right
    expect(px(rotateClockwise(r, 3), 0, 0)).toEqual([0, 0, 100]);
  });
});
