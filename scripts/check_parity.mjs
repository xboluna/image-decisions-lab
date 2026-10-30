// Checks that the browser's image pipeline (lib/modelImage.ts) writes the same bytes as the Python reference
// (scripts/reference_pipeline.py) for every demo image plus generated edge cases, at several max sides.
// Usage: node scripts/check_parity.mjs [--keep]        (Node >= 22.18 for TypeScript; uv for the Python side)
// Prints one row per input class; exits 1 if any exact-format input differs by a byte.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript) throw new Error("Needs Node 22.18 or later, which runs lib/*.ts directly.");
// lib/*.ts are ES modules in a package without "type": "module"; Node warns about each one, harmlessly.
process.removeAllListeners("warning");
process.on("warning", (w) => w.code !== "MODULE_TYPELESS_PACKAGE_JSON" && console.warn(w));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDES = [512, 1024, 1280];
const QUALITY = 85;
const PILLOW = "pillow==12.2.0";
const work = mkdtempSync(path.join(tmpdir(), "parity-"));

// Edge cases, generated with Pillow from a demo photo so they look like real photos.
const GENERATE = String.raw`
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
base = Image.open(sys.argv[2]).convert("RGB")
def photo(w, h):
    img = base.resize((w, h), Image.BICUBIC)
    noise = Image.effect_noise((w, h), 24).convert("RGB")
    return Image.blend(img, noise, 0.08)
photo(6000, 4000).save(f"{out}/large-6000x4000.jpg", quality=92)
photo(4200, 3150).save(f"{out}/large-4200x3150-444.jpg", quality=90, subsampling=0)
photo(1001, 667).save(f"{out}/odd-1001x667.png")
photo(777, 1333).save(f"{out}/odd-portrait-777x1333-progressive.jpg", quality=88, progressive=True)
photo(1283, 1283).save(f"{out}/odd-square-1283-422.jpg", quality=80, subsampling=1)
photo(300, 200).save(f"{out}/small-300x200.jpg", quality=90)
photo(640, 480).save(f"{out}/small-640x480.png")
photo(1600, 1200).convert("L").save(f"{out}/gray-1600x1200.jpg", quality=90)
photo(900, 700).convert("L").save(f"{out}/gray-900x700.png")
rgba = photo(1500, 1000).convert("RGBA")
alpha = Image.linear_gradient("L").resize((1500, 1000))
rgba.putalpha(alpha)
rgba.save(f"{out}/rgba-1500x1000.png")
photo(1400, 900).convert("P", palette=Image.ADAPTIVE, colors=200).save(f"{out}/palette-1400x900.png")
photo(1200, 900).convert("P", palette=Image.ADAPTIVE, colors=16).save(f"{out}/palette4bit-1200x900.png", bits=4)
photo(1000, 700).convert("LA").save(f"{out}/gray-alpha-1000x700.png")
photo(1100, 800).convert("1").save(f"{out}/bilevel-1100x800.png")
Image.frombytes("I;16", (1200, 800), bytes(range(256)) * (1200 * 800 * 2 // 256)).save(f"{out}/gray16-1200x800.png")
photo(2000, 1500).save(f"{out}/comment-2000x1500.jpg", quality=90, comment=b"scanned 2024")
exif = Image.Exif(); exif[0x0112] = 6
photo(1800, 1200).save(f"{out}/exif-rotated-1800x1200.jpg", quality=90, exif=exif)
photo(3000, 20).save(f"{out}/strip-3000x20.png")
photo(20, 2500).save(f"{out}/tall-strip-20x2500.png")
photo(1700, 1100).save(f"{out}/bmp-1700x1100.bmp")
photo(1000, 800).save(f"{out}/webp-1000x800.webp", quality=90)
photo(1000, 800).save(f"{out}/gif-1000x800.gif")
`;

// Byte-equal is the goal; otherwise decode both with Pillow and report the largest channel difference.
const COMPARE = String.raw`
import sys
from PIL import Image, ImageChops
for line in sys.stdin.read().split("\n"):
    if not line: continue
    a, b = line.split("\t")
    x, y = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    if x.size != y.size: print(f"size {x.size} vs {y.size}"); continue
    print(max(hi for lo, hi in ImageChops.difference(x, y).getextrema()))
`;

const uv = (args, input) => execFileSync("uv", ["run", "--quiet", ...args], { cwd: root, input, encoding: "utf8", maxBuffer: 1 << 26 });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const synthetic = path.join(work, "synthetic");
mkdirSync(synthetic);
console.log("Generating edge cases...");
uv(["--with", PILLOW, "python", "-", synthetic, path.join(root, "public/demo/train/images/scene0_frame112.jpg")], GENERATE);
// PNG variants Pillow does not write: interlaced, 2-bit greyscale, 16-bit RGB.
const png = await import("fast-png");
const odd = png.decode(readFileSync(path.join(synthetic, "odd-1001x667.png")));
writeFileSync(path.join(synthetic, "interlaced-1001x667.png"), png.encode(odd, { interlace: "Adam7" }));
const rgb16 = Uint16Array.from(odd.data, (v, i) => v * 257 + (i % 251));
writeFileSync(path.join(synthetic, "rgb16-1001x667.png"), png.encode({ width: odd.width, height: odd.height, data: rgb16, channels: 3, depth: 16 }));
const rowBytes = Math.ceil((odd.width * 2) / 8);
const gray2 = new Uint8Array(rowBytes * odd.height);
for (let y = 0; y < odd.height; y++) {
  for (let x = 0; x < odd.width; x++) gray2[y * rowBytes + (x >> 2)] |= (odd.data[(y * odd.width + x) * 3] >> 6) << (6 - 2 * (x & 3));
}
writeFileSync(path.join(synthetic, "gray2bit-1001x667.png"), png.encode({ width: odd.width, height: odd.height, data: gray2, channels: 1, depth: 2 }));

const inputs = [
  ...["train", "test"].flatMap((set) => {
    const dir = path.join(root, "public/demo", set, "images");
    return readdirSync(dir).sort().map((f) => ({ file: path.join(dir, f), kind: `demo ${set} (JPEG)` }));
  }),
  ...readdirSync(synthetic).sort().map((f) => ({ file: path.join(synthetic, f), kind: f.replace(/\.[^.]+$/, "") })),
];

// The browser module itself, run by Node with the same WebAssembly decoder the page loads from public/.
const { setJpegWasmLoader } = await import(path.join(root, "lib/decodeImage.ts"));
const { encodeForModel } = await import(path.join(root, "lib/modelImage.ts"));
setJpegWasmLoader(() => WebAssembly.compile(readFileSync(path.join(root, "node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"))));

const rows = [];
for (const side of SIDES) {
  const refDir = path.join(work, `ref-${side}`);
  uv([path.join(root, "scripts/reference_pipeline.py"), "--max-side", String(side), "--quality", String(QUALITY), "--out", refDir, ...inputs.map((i) => i.file)]);
  const browserDir = path.join(work, `browser-${side}`);
  mkdirSync(browserDir);
  const pending = [];
  for (const input of inputs) {
    const name = `${path.basename(input.file).replace(/\.[^.]+$/, "")}.jpg`;
    const ref = readFileSync(path.join(refDir, name));
    const row = { kind: input.kind, side, identical: false, maxDiff: null, exact: true, note: "" };
    rows.push(row);
    try {
      const out = await encodeForModel(new Uint8Array(readFileSync(input.file)), side, QUALITY);
      row.exact = out.exact;
      writeFileSync(path.join(browserDir, name), out.jpeg);
      row.identical = sha(out.jpeg) === sha(ref);
      if (!row.identical) pending.push({ row, a: path.join(refDir, name), b: path.join(browserDir, name) });
    } catch (err) {
      row.exact = false;
      row.note = `browser-only decoder (${err.message})`;
    }
  }
  if (pending.length) {
    const diffs = uv(["--with", PILLOW, "python", "-c", COMPARE], pending.map((p) => `${p.a}\t${p.b}`).join("\n")).trim().split("\n");
    pending.forEach((p, i) => (p.row.maxDiff = diffs[i]));
  }
}

// One row per input class: demo images grouped, each edge case on its own.
const groups = new Map();
for (const r of rows) {
  const g = groups.get(r.kind) ?? { kind: r.kind, files: new Set(), sides: new Set(), total: 0, identical: 0, maxDiff: 0, notes: new Set() };
  g.total++;
  g.sides.add(r.side);
  if (r.identical) g.identical++;
  if (r.maxDiff != null) g.maxDiff = Number.isNaN(Number(r.maxDiff)) ? r.maxDiff : Math.max(Number(g.maxDiff) || 0, Number(r.maxDiff));
  if (r.note) g.notes.add(r.note);
  groups.set(r.kind, g);
}
const table = [
  "| input | cases | byte-identical | max pixel diff |",
  "|---|---|---|---|",
  ...[...groups.values()].map((g) => {
    const note = g.notes.size ? [...g.notes][0] : "";
    return `| ${g.kind} | ${g.total} | ${note ? "n/a" : `${g.identical}/${g.total}`} | ${note || (g.identical === g.total ? "0" : g.maxDiff)} |`;
  }),
];
console.log(`\nSides ${SIDES.join(", ")}, quality ${QUALITY}, ${PILLOW}\n`);
console.log(table.join("\n"));
const failed = rows.filter((r) => r.exact && !r.identical);
console.log(failed.length ? `\nFAIL: ${failed.length} exact-format cases differ.` : `\nOK: every exact-format case is byte-identical (${rows.filter((r) => r.exact).length} cases).`);
if (process.argv.includes("--keep")) console.log(`Outputs kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
