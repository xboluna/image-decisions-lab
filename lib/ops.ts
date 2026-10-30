/**
 * Image operations: an ordered list of edits applied to an image before it is sent to the model. They run on raw
 * RGB pixels with plain integer arithmetic, so every browser produces the same pixels, and each one has a direct
 * Pillow equivalent (see scripts/reference_pipeline.py) for checking parity with a Python pipeline.
 *
 * Areas are given in normalized coordinates of the original image (0..1), either inline or by naming one of the
 * prompt's regions, so the same crop lands on the same object in every image of a fixed-camera dataset. Earlier
 * operations (a crop, a rotation) move later ones' areas with the image.
 */

export type Rgb = { width: number; height: number; data: Uint8Array };

/** x0, y0, x1, y1 as fractions of the original image's width and height. */
export type Box = [number, number, number, number];

export type Region = { id: string; name: string; box: Box };

export type Area = { region: string } | { box: Box };

export type ImageOp =
  | { kind: "crop"; area: Area; /** Extra context on each side, as a fraction of the area's width and height. */ margin: number }
  | { kind: "outline"; area: Area; color: string; /** Line width in pixels; 0 picks one from the image size. */ width: number }
  | { kind: "spotlight"; area: Area; /** Brightness kept outside the area, 0..1. */ dim: number }
  | { kind: "rotate"; /** Clockwise. */ degrees: 90 | 180 | 270 };

/** One image sent to the model: the source image after these operations, introduced by the caption. */
export type ImageView = {
  id: string;
  caption: string;
  ops: ImageOp[];
  /** Enlarge small results (e.g. a tight crop) up to the prompt's image size instead of sending them small. */
  enlarge: boolean;
};

export const OP_LABELS: Record<ImageOp["kind"], string> = {
  crop: "Crop",
  outline: "Outline",
  spotlight: "Spotlight",
  rotate: "Rotate",
};

export const DEFAULT_OUTLINE = "#ff00ff";

/** A new operation of this kind on the given area (a rotate has no area and ignores it). */
export function defaultOp(kind: ImageOp["kind"], area: Area): ImageOp {
  switch (kind) {
    case "crop":
      return { kind, area, margin: 0.12 };
    case "outline":
      return { kind, area, color: DEFAULT_OUTLINE, width: 0 };
    case "spotlight":
      return { kind, area, dim: 0.35 };
    case "rotate":
      return { kind, degrees: 180 };
  }
}

/** Affine map from original-image pixels to current-image pixels, built from crops and quarter turns. */
type Transform = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function apply(t: Transform, x: number, y: number): [number, number] {
  return [t.a * x + t.b * y + t.e, t.c * x + t.d * y + t.f];
}

function then(t: Transform, n: Transform): Transform {
  // n ∘ t
  return {
    a: n.a * t.a + n.b * t.c,
    b: n.a * t.b + n.b * t.d,
    c: n.c * t.a + n.d * t.c,
    d: n.c * t.b + n.d * t.d,
    e: n.a * t.e + n.b * t.f + n.e,
    f: n.c * t.e + n.d * t.f + n.f,
  };
}

export function resolveArea(area: Area, regions: Region[]): Box | null {
  if ("box" in area) return area.box;
  return regions.find((r) => r.id === area.region)?.box ?? null;
}

/** The area as a pixel box [x0, y0, x1) in the current image: corners mapped, then snapped outward to whole pixels. */
function pixelBox(box: Box, src: { width: number; height: number }, t: Transform, img: { width: number; height: number }): [number, number, number, number] {
  const [ax, ay] = apply(t, box[0] * src.width, box[1] * src.height);
  const [bx, by] = apply(t, box[2] * src.width, box[3] * src.height);
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)));
  const x1 = Math.min(img.width, Math.ceil(Math.max(ax, bx)));
  const y1 = Math.min(img.height, Math.ceil(Math.max(ay, by)));
  return [x0, y0, Math.max(x0 + 1, x1), Math.max(y0 + 1, y1)];
}

export function crop(img: Rgb, x0: number, y0: number, x1: number, y1: number): Rgb {
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 3, ((y0 + y) * img.width + x1) * 3), y * width * 3);
  return { width, height, data };
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 0, 255];
}

/** Pillow's ImageDraw.rectangle(xy, outline, width=w): a band w pixels wide inside the inclusive box, clipped. */
export function drawRectangle(img: Rgb, x0: number, y0: number, x1: number, y1: number, w: number, color: [number, number, number]): Rgb {
  const out = { ...img, data: new Uint8Array(img.data) };
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 3;
    out.data[i] = color[0];
    out.data[i + 1] = color[1];
    out.data[i + 2] = color[2];
  };
  for (let k = 0; k < w; k++) {
    const l = x0 + k;
    const t = y0 + k;
    const r = x1 - k;
    const b = y1 - k;
    if (l > r || t > b) break;
    for (let x = l; x <= r; x++) {
      paint(x, t);
      paint(x, b);
    }
    for (let y = t; y <= b; y++) {
      paint(l, y);
      paint(r, y);
    }
  }
  return out;
}

/** Everything outside the box scaled by `dim` (rounded half up), like Pillow's Image.point(lambda v: int(v * dim + 0.5)). */
export function spotlight(img: Rgb, x0: number, y0: number, x1: number, y1: number, dim: number): Rgb {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.floor(v * dim + 0.5));
  const out = { ...img, data: new Uint8Array(img.data) };
  for (let y = 0; y < img.height; y++) {
    const inside = y >= y0 && y < y1;
    for (let x = 0; x < img.width; x++) {
      if (inside && x >= x0 && x < x1) continue;
      const i = (y * img.width + x) * 3;
      out.data[i] = lut[img.data[i]];
      out.data[i + 1] = lut[img.data[i + 1]];
      out.data[i + 2] = lut[img.data[i + 2]];
    }
  }
  return out;
}

/** Quarter turn clockwise, k times: Pillow's transpose(ROTATE_270) for one clockwise turn. */
export function rotateClockwise(img: Rgb, k: 1 | 2 | 3): Rgb {
  const { width: w, height: h } = img;
  const outW = k === 2 ? w : h;
  const outH = k === 2 ? h : w;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [nx, ny] = k === 1 ? [h - 1 - y, x] : k === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      const s = (y * w + x) * 3;
      const d = (ny * outW + nx) * 3;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
    }
  return { width: outW, height: outH, data };
}

function rotateTransform(k: 1 | 2 | 3, w: number, h: number): Transform {
  // continuous coordinates: clockwise turn of a w×h image
  if (k === 1) return { a: 0, b: -1, c: 1, d: 0, e: h, f: 0 };
  if (k === 2) return { a: -1, b: 0, c: 0, d: -1, e: w, f: h };
  return { a: 0, b: 1, c: -1, d: 0, e: 0, f: w };
}

/** Outline width when none is set: 1/250 of the longer side, at least 4 pixels. */
export function autoLineWidth(img: { width: number; height: number }): number {
  return Math.max(4, Math.round(Math.max(img.width, img.height) / 250));
}

export type OpsResult = { image: Rgb; warnings: string[] };

/**
 * Applies the operations in order. Areas that cannot be resolved (a deleted region) are skipped with a warning.
 * `scale` is for on-screen previews of a downscaled copy (preview pixels per original pixel): outline widths are
 * worked out at full size and scaled, so the preview looks like what is sent.
 */
export function applyOps(src: Rgb, ops: ImageOp[], regions: Region[], opts: { scale?: number } = {}): OpsResult {
  const scale = opts.scale ?? 1;
  let img = src;
  let t = IDENTITY;
  const warnings: string[] = [];
  for (const op of ops) {
    if (op.kind === "rotate") {
      const k = (op.degrees / 90) as 1 | 2 | 3;
      t = then(t, rotateTransform(k, img.width, img.height));
      img = rotateClockwise(img, k);
      continue;
    }
    const box = resolveArea(op.area, regions);
    if (!box) {
      warnings.push(`${OP_LABELS[op.kind]} skipped: its region no longer exists.`);
      continue;
    }
    const [x0, y0, x1, y1] = pixelBox(box, src, t, img);
    if (op.kind === "crop") {
      const mx = (x1 - x0) * op.margin;
      const my = (y1 - y0) * op.margin;
      const cx0 = Math.max(0, Math.floor(x0 - mx));
      const cy0 = Math.max(0, Math.floor(y0 - my));
      const cx1 = Math.min(img.width, Math.ceil(x1 + mx));
      const cy1 = Math.min(img.height, Math.ceil(y1 + my));
      img = crop(img, cx0, cy0, cx1, cy1);
      t = then(t, { a: 1, b: 0, c: 0, d: 1, e: -cx0, f: -cy0 });
    } else if (op.kind === "outline") {
      const full = op.width > 0 ? op.width : autoLineWidth({ width: img.width / scale, height: img.height / scale });
      const w = scale === 1 ? full : Math.max(1, Math.round(full * scale));
      // drawn just outside the area, so the line never covers what is being judged
      img = drawRectangle(img, x0 - w, y0 - w, x1 - 1 + w, y1 - 1 + w, w, hexToRgb(op.color));
    } else if (op.kind === "spotlight") {
      img = spotlight(img, x0, y0, x1, y1, op.dim);
    }
  }
  return { image: img, warnings };
}

/** The size of the image after the operations, without touching pixels (only crops and turns change it). */
export function opsSize(width: number, height: number, ops: ImageOp[], regions: Region[]): [number, number] {
  const src = { width, height };
  let img = { width, height };
  let t = IDENTITY;
  for (const op of ops) {
    if (op.kind === "rotate") {
      const k = (op.degrees / 90) as 1 | 2 | 3;
      t = then(t, rotateTransform(k, img.width, img.height));
      if (k !== 2) img = { width: img.height, height: img.width };
      continue;
    }
    if (op.kind !== "crop") continue;
    const box = resolveArea(op.area, regions);
    if (!box) continue;
    const [x0, y0, x1, y1] = pixelBox(box, src, t, img);
    const mx = (x1 - x0) * op.margin;
    const my = (y1 - y0) * op.margin;
    const cx0 = Math.max(0, Math.floor(x0 - mx));
    const cy0 = Math.max(0, Math.floor(y0 - my));
    img = { width: Math.min(img.width, Math.ceil(x1 + mx)) - cx0, height: Math.min(img.height, Math.ceil(y1 + my)) - cy0 };
    t = then(t, { a: 1, b: 0, c: 0, d: 1, e: -cx0, f: -cy0 });
  }
  return [img.width, img.height];
}

/**
 * Size of an image enlarged so its longest side is exactly maxSide, the other side rounded half up. Defined
 * explicitly (not with Python's round, which rounds half to even) so the reference pipeline computes the same.
 */
export function enlargedSize(width: number, height: number, maxSide: number): [number, number] {
  if (width >= height) return [maxSide, Math.max(1, Math.floor((height * maxSide) / width + 0.5))];
  return [Math.max(1, Math.floor((width * maxSide) / height + 0.5)), maxSide];
}

/** Plain-language summary of a view, for captions and lists. */
export function describeOps(ops: ImageOp[], regions: Region[]): string {
  if (!ops.length) return "The whole image";
  const name = (a: Area) => ("box" in a ? "a custom area" : (regions.find((r) => r.id === a.region)?.name ?? "a missing region"));
  return ops
    .map((op) => {
      switch (op.kind) {
        case "crop":
          return `crop to ${name(op.area)}${op.margin ? ` +${Math.round(op.margin * 100)}%` : ""}`;
        case "outline":
          return `outline ${name(op.area)}`;
        case "spotlight":
          return `spotlight ${name(op.area)}`;
        case "rotate":
          return `rotate ${op.degrees}°`;
      }
    })
    .join(", ")
    .replace(/^./, (c) => c.toUpperCase());
}
