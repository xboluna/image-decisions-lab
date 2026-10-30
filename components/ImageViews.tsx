"use client";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Crop, Focus, Frame, Layers, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { uid } from "@/lib/hash";
import { modelInfo } from "@/lib/models";
import { applyOps, autoLineWidth, DEFAULT_OUTLINE, defaultOp, describeOps, enlargedSize, opsSize, OP_LABELS, resolveArea, type Area, type Box, type ImageOp, type ImageView, type Region, type Rgb } from "@/lib/ops";
import { thumbnailSize } from "@/lib/pillow";
import { paint, previewRgb, type PreviewRgb } from "@/lib/preview";
import { imagesPerRequest, promptViews, viewCaption, WHOLE_IMAGE } from "@/lib/prompt";
import type { Prompt } from "@/lib/types";
import { Badge, Button, cx, IconButton, inputClass, Modal, Popover, Segmented, Spinner } from "./ui";

/* ---------- shared pieces ---------- */

const STAGE_COLORS = ["#2a78d6", "#d68a00", "#d6457f", "#6a5ad6", "#0f9d8a", "#7a8a00"];
const OUTLINE_SWATCHES = ["#ff00ff", "#ffd400", "#00e5ff", "#ff2d2d", "#39ff14", "#ffffff"];

export function useRgb(hash: string | undefined): PreviewRgb | null | undefined {
  const [rgb, setRgb] = useState<PreviewRgb | null | undefined>(undefined);
  useEffect(() => {
    if (!hash) return setRgb(null);
    let live = true;
    setRgb(undefined);
    void previewRgb(hash).then((r) => live && setRgb(r));
    return () => {
      live = false;
    };
  }, [hash]);
  return rgb;
}

/** RGB pixels on a canvas, scaled by CSS. */
export function RgbCanvas({ img, className, label }: { img: Rgb; className?: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paint(ref.current, img);
  }, [img]);
  return <canvas ref={ref} role="img" aria-label={label} className={className} />;
}

/** What the model receives for one view of one image: the operations applied, at the size it is sent. */
export function ViewPreview({ rgb, ops, regions, maxSide, enlarge, title, caption, compact }: { rgb: PreviewRgb; ops: ImageOp[]; regions: Region[]; maxSide: number; enlarge: boolean; title: string; caption?: string; compact?: boolean }) {
  const { image, warnings } = useMemo(() => applyOps(rgb, ops, regions, { scale: rgb.width / rgb.sourceWidth }), [rgb, ops, regions]);
  // The size sent comes from the full-size image (previews are a downscaled copy), resized as the pipeline does.
  const [w, h] = opsSize(rgb.sourceWidth, rgb.sourceHeight, ops, regions);
  const [sw, sh] = enlarge && Math.max(w, h) < maxSide ? enlargedSize(w, h, maxSide) : (thumbnailSize(w, h, maxSide) ?? [w, h]);
  const sent = `${sw}×${sh}`;
  return (
    <figure className="min-w-0" data-view-preview>
      <div className={cx("flex items-center justify-center overflow-hidden rounded-lg border border-line bg-[repeating-conic-gradient(var(--surface-3)_0_25%,var(--surface-2)_0_50%)] bg-[length:16px_16px]", compact ? "h-24" : "h-44")}>
        <RgbCanvas img={image} label={title} className="max-h-full max-w-full object-contain" />
      </div>
      <figcaption className="mt-1 flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="truncate font-medium text-ink">{title}</span>
        <span className="shrink-0 tabular text-muted">{sent} px</span>
      </figcaption>
      {caption && <div className="truncate text-[11px] text-ink-2" title={caption}>{caption}</div>}
      {warnings.map((w) => (
        <div key={w} className="text-[11px] text-warning-ink">
          {w}
        </div>
      ))}
    </figure>
  );
}

export type StageBox = { id: string; label: string; box: Box; color: string; editable: boolean };

/**
 * An image with boxes on top. Drag a box to move it, drag a corner to resize it, drag on empty image to draw a new
 * one (when onCreate is given). Arrow keys nudge the selected box; Shift moves it further.
 */
export function BoxStage({ rgb, boxes, selected, onSelect, onChange, onCreate, label }: { rgb: Rgb; boxes: StageBox[]; selected: string | null; onSelect: (id: string | null) => void; onChange: (id: string, box: Box) => void; onCreate?: (box: Box) => void; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<null | { id: string | null; mode: "move" | "nw" | "ne" | "sw" | "se" | "new"; start: [number, number]; box: Box }>(null);
  const [draft, setDraftState] = useState<Box | null>(null);
  // Listeners are attached once per drag and read the latest values from refs, so a parent re-render (previews
  // update on every move) never leaves a gap where the pointerup could be missed.
  const draftRef = useRef<Box | null>(null);
  const setDraft = (b: Box | null) => {
    draftRef.current = b;
    setDraftState(b);
  };
  const handlers = useRef({ onChange, onCreate });
  handlers.current = { onChange, onCreate };
  const point = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const [x, y] = point(e);
      const [sx, sy] = drag.start;
      const [x0, y0, x1, y1] = drag.box;
      const min = 0.01;
      let b: Box;
      if (drag.mode === "new") b = [Math.min(sx, x), Math.min(sy, y), Math.max(sx, x), Math.max(sy, y)];
      else if (drag.mode === "move") {
        const dx = Math.min(Math.max(x - sx, -x0), 1 - x1);
        const dy = Math.min(Math.max(y - sy, -y0), 1 - y1);
        b = [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
      } else {
        b = [
          drag.mode.includes("w") ? Math.min(x, x1 - min) : x0,
          drag.mode.includes("n") ? Math.min(y, y1 - min) : y0,
          drag.mode.includes("e") ? Math.max(x, x0 + min) : x1,
          drag.mode.includes("s") ? Math.max(y, y0 + min) : y1,
        ];
      }
      const rounded = b.map((v) => Math.round(v * 10000) / 10000) as Box;
      if (drag.mode === "new") setDraft(rounded);
      else if (drag.id) handlers.current.onChange(drag.id, rounded);
    };
    const up = () => {
      const d = draftRef.current;
      const create = handlers.current.onCreate;
      if (drag.mode === "new" && d && create && d[2] - d[0] > 0.01 && d[3] - d[1] > 0.01) create(d);
      setDrag(null);
      setDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);
  const sel = boxes.find((b) => b.id === selected && b.editable);
  return (
    <div
      ref={wrap}
      tabIndex={0}
      aria-label={label}
      data-box-stage
      className={cx("relative w-full select-none overflow-hidden rounded-lg border border-line bg-surface-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]", onCreate ? "cursor-crosshair" : "cursor-default")}
      style={{ aspectRatio: `${rgb.width} / ${rgb.height}` }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("[data-box]")) return;
        onSelect(null);
        if (onCreate) {
          const p = point(e);
          setDrag({ id: null, mode: "new", start: p, box: [p[0], p[1], p[0], p[1]] });
        }
      }}
      onKeyDown={(e) => {
        if (!sel) return;
        const step = e.shiftKey ? 0.02 : 0.002;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        const [x0, y0, x1, y1] = sel.box;
        const dx = Math.min(Math.max(d[0], -x0), 1 - x1);
        const dy = Math.min(Math.max(d[1], -y0), 1 - y1);
        onChange(sel.id, [x0 + dx, y0 + dy, x1 + dx, y1 + dy].map((v) => Math.round(v * 10000) / 10000) as Box);
      }}
    >
      <RgbCanvas img={rgb} label={label} className="absolute inset-0 size-full" />
      {boxes.map((b) => {
        const on = b.id === selected;
        return (
          <div
            key={b.id}
            data-box={b.id}
            className={cx("absolute", b.editable ? "cursor-move" : "pointer-events-none")}
            style={{ left: `${b.box[0] * 100}%`, top: `${b.box[1] * 100}%`, width: `${(b.box[2] - b.box[0]) * 100}%`, height: `${(b.box[3] - b.box[1]) * 100}%`, boxShadow: `0 0 0 ${on ? 2 : 1.5}px ${b.color}, 0 0 0 ${on ? 4 : 3}px rgba(255,255,255,0.7)`, background: on ? `${b.color}22` : "transparent", borderStyle: b.editable ? "solid" : "dashed" }}
            onPointerDown={(e) => {
              if (!b.editable) return;
              e.stopPropagation();
              onSelect(b.id);
              wrap.current?.focus();
              setDrag({ id: b.id, mode: "move", start: point(e), box: b.box });
            }}
          >
            <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded px-1 text-[10.5px] font-semibold text-white" style={{ background: b.color }}>
              {b.label}
            </span>
            {on &&
              b.editable &&
              (["nw", "ne", "sw", "se"] as const).map((c) => (
                <span
                  key={c}
                  data-handle={c}
                  className={cx("absolute size-3 rounded-sm border-2 border-white", c[0] === "n" ? "-top-1.5" : "-bottom-1.5", c[1] === "w" ? "-left-1.5" : "-right-1.5", c === "nw" || c === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize")}
                  style={{ background: b.color }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setDrag({ id: b.id, mode: c, start: point(e), box: b.box });
                  }}
                />
              ))}
          </div>
        );
      })}
      {draft && <div className="pointer-events-none absolute border-2 border-dashed border-white bg-white/10" style={{ left: `${draft[0] * 100}%`, top: `${draft[1] * 100}%`, width: `${(draft[2] - draft[0]) * 100}%`, height: `${(draft[3] - draft[1]) * 100}%` }} />}
    </div>
  );
}

const OP_ICONS: Record<ImageOp["kind"], ReactNode> = {
  crop: <Crop className="size-3.5" />,
  outline: <Frame className="size-3.5" />,
  spotlight: <Focus className="size-3.5" />,
  rotate: <RotateCw className="size-3.5" />,
};

const OP_HELP: Record<ImageOp["kind"], string> = {
  crop: "Keep only the area, plus a margin of context around it.",
  outline: "Draw a frame just outside the area. A colour that appears nowhere in your images works best.",
  spotlight: "Darken everything outside the area, keeping its surroundings visible.",
  rotate: "Turn the image clockwise. Later areas turn with it.",
};

function AddOpMenu({ onAdd, label = "Add operation" }: { onAdd: (kind: ImageOp["kind"]) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} align="left" className="w-72">
        {(Object.keys(OP_LABELS) as ImageOp["kind"][]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setOpen(false);
              onAdd(k);
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-3"
          >
            <span className="mt-0.5 text-muted">{OP_ICONS[k]}</span>
            <span>
              <span className="block text-[13px] font-medium">{OP_LABELS[k]}</span>
              <span className="block text-[11.5px] leading-snug text-ink-2">{OP_HELP[k]}</span>
            </span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

const CUSTOM = "__custom__";

/** One operation's settings. Areas are a named region or a box drawn just for this operation. */
function OpRow({ op, index, count, regions, selected, onSelect, onChange, onRemove, onMove, allowCustom }: { op: ImageOp; index: number; count: number; regions: Region[]; selected: boolean; onSelect: () => void; onChange: (op: ImageOp) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; allowCustom: boolean }) {
  const area = "area" in op ? op.area : null;
  const areaValue = area ? ("box" in area ? CUSTOM : area.region) : "";
  return (
    <li
      data-op={op.kind}
      onClick={onSelect}
      className={cx("rounded-lg border bg-surface px-2.5 py-2 transition-colors", selected ? "border-accent ring-2 ring-[var(--focus)]" : "border-line hover:border-line-strong")}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-muted">{OP_ICONS[op.kind]}</span>
        <span className="text-[12.5px] font-semibold">{OP_LABELS[op.kind]}</span>
        <span className="ml-auto flex items-center">
          <IconButton label={`Move ${OP_LABELS[op.kind].toLowerCase()} up`} className="size-6" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3.5" />
          </IconButton>
          <IconButton label={`Move ${OP_LABELS[op.kind].toLowerCase()} down`} className="size-6" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-3.5" />
          </IconButton>
          <IconButton label={`Remove ${OP_LABELS[op.kind].toLowerCase()}`} className="size-6" onClick={onRemove}>
            <X className="size-3.5" />
          </IconButton>
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-[12px] text-ink-2">
        {area && (
          <>
            <span>Area</span>
            <select
              aria-label={`${OP_LABELS[op.kind]} area`}
              value={areaValue}
              onChange={(e) => {
                const v = e.target.value;
                const cur = resolveArea(area, regions) ?? [0.3, 0.3, 0.7, 0.7];
                const next: Area = v === CUSTOM ? { box: cur } : { region: v };
                onChange({ ...op, area: next } as ImageOp);
              }}
              className="h-7 min-w-0 rounded-md border border-line-strong bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              {(allowCustom || areaValue === CUSTOM) && <option value={CUSTOM}>Drawn for this step</option>}
              {areaValue && areaValue !== CUSTOM && !regions.some((r) => r.id === areaValue) && <option value={areaValue}>Missing region</option>}
            </select>
          </>
        )}
        {op.kind === "crop" && (
          <>
            <span>Margin</span>
            <span className="flex items-center gap-2">
              <input type="range" min={0} max={1} step={0.01} value={op.margin} aria-label="Crop margin" onChange={(e) => onChange({ ...op, margin: Number(e.target.value) })} className="min-w-0 flex-1 accent-[var(--accent)]" />
              <span className="w-10 text-right tabular text-ink">{Math.round(op.margin * 100)}%</span>
            </span>
          </>
        )}
        {op.kind === "outline" && (
          <>
            <span>Colour</span>
            <span className="flex flex-wrap items-center gap-1">
              {OUTLINE_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Outline colour ${c}`}
                  aria-pressed={op.color.toLowerCase() === c}
                  onClick={() => onChange({ ...op, color: c })}
                  className={cx("size-5 rounded-md border", op.color.toLowerCase() === c ? "border-ink ring-2 ring-[var(--focus)]" : "border-line-strong")}
                  style={{ background: c }}
                />
              ))}
              <input type="color" aria-label="Custom outline colour" value={op.color} onChange={(e) => onChange({ ...op, color: e.target.value })} className="h-5 w-6 cursor-pointer rounded border border-line-strong bg-transparent p-0" />
            </span>
            <span>Width</span>
            <span className="flex items-center gap-2">
              <select aria-label="Outline width" value={op.width} onChange={(e) => onChange({ ...op, width: Number(e.target.value) })} className="h-7 rounded-md border border-line-strong bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent">
                <option value={0}>Automatic</option>
                {[2, 3, 4, 6, 8, 12].map((w) => (
                  <option key={w} value={w}>
                    {w} px
                  </option>
                ))}
              </select>
            </span>
          </>
        )}
        {op.kind === "spotlight" && (
          <>
            <span>Outside</span>
            <span className="flex items-center gap-2">
              <input type="range" min={0} max={1} step={0.05} value={op.dim} aria-label="Brightness outside the area" onChange={(e) => onChange({ ...op, dim: Number(e.target.value) })} className="min-w-0 flex-1 accent-[var(--accent)]" />
              <span className="w-10 text-right tabular text-ink">{Math.round(op.dim * 100)}%</span>
            </span>
          </>
        )}
        {op.kind === "rotate" && (
          <>
            <span>Turn</span>
            <Segmented<string>
              size="sm"
              value={String(op.degrees)}
              onChange={(v) => onChange({ ...op, degrees: Number(v) as 90 | 180 | 270 })}
              options={[
                { value: "90", label: "90°" },
                { value: "180", label: "180°" },
                { value: "270", label: "270°" },
              ]}
            />
          </>
        )}
      </div>
    </li>
  );
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/* ---------- prompt views editor ---------- */

type Draft = { regions: Region[]; views: ImageView[] };

const PRESETS: { id: string; label: string; help: string; build: (region: string) => ImageView[] }[] = [
  { id: "crop", label: "Crop to the region", help: "One image: the region with a little context.", build: (r) => [{ id: uid("vw"), caption: "", ops: [{ kind: "crop", area: { region: r }, margin: 0.12 }], enlarge: true }] },
  {
    id: "outline",
    label: "Whole image, region outlined",
    help: "One image: everything, with a magenta frame around the region.",
    build: (r) => [{ id: uid("vw"), caption: "Judge only what is inside the magenta frame.", ops: [{ kind: "outline", area: { region: r }, color: DEFAULT_OUTLINE, width: 0 }], enlarge: false }],
  },
  {
    id: "context-zoom",
    label: "Whole image + framed close-up",
    help: "Two images: the whole image for context, then a close-up of the framed region.",
    build: (r) => [
      { id: uid("vw"), caption: "The whole image. The region to judge is inside the magenta frame.", ops: [{ kind: "outline", area: { region: r }, color: DEFAULT_OUTLINE, width: 0 }], enlarge: false },
      {
        id: uid("vw"),
        caption: "Close-up of the same region, framed in magenta. It is not a second image.",
        ops: [
          { kind: "outline", area: { region: r }, color: DEFAULT_OUTLINE, width: 0 },
          { kind: "crop", area: { region: r }, margin: 0.5 },
        ],
        enlarge: true,
      },
    ],
  },
];

/** Edit a prompt's regions and views on real images, with live previews of exactly what each view sends. */
export function ViewsEditor({ prompt, samples, model, onSave, onClose }: { prompt: Prompt; samples: { hash: string; name: string }[]; model: string; onSave: (d: Draft) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    regions: structuredClone(prompt.regions ?? []),
    views: structuredClone(prompt.views?.length ? prompt.views : [{ ...WHOLE_IMAGE, id: uid("vw") }]),
  }));
  const [sample, setSample] = useState(0);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(draft.regions[0]?.id ?? null);
  const [selectedOp, setSelectedOp] = useState<{ view: number; op: number } | null>(null);
  const current = samples[sample];
  const rgb = useRgb(current?.hash);
  const regionColor = (id: string) => STAGE_COLORS[Math.max(0, draft.regions.findIndex((r) => r.id === id)) % STAGE_COLORS.length];
  const usage = (id: string) => draft.views.reduce((n, v) => n + v.ops.filter((o) => "area" in o && "region" in o.area && o.area.region === id).length, 0);
  const setView = (i: number, view: ImageView) => setDraft((d) => ({ ...d, views: d.views.map((v, k) => (k === i ? view : v)) }));

  const addRegion = (box: Box = [0.35, 0.35, 0.65, 0.65]) => {
    const n = draft.regions.length + 1;
    const region: Region = { id: uid("rg"), name: `Region ${n}`, box };
    setDraft((d) => ({ ...d, regions: [...d.regions, region] }));
    setSelectedRegion(region.id);
    return region;
  };
  const areaForNewOp = (): Area => {
    const id = selectedRegion ?? draft.regions[0]?.id ?? addRegion().id;
    return { region: id };
  };
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    const id = selectedRegion ?? draft.regions[0]?.id ?? addRegion().id;
    setDraft((d) => ({ ...d, views: p.build(id) }));
    setSelectedOp(null);
  };

  // No views, or one that changes nothing: the whole image is sent as it is.
  const plainView = draft.views.length === 0 || (draft.views.length === 1 && !draft.views[0].ops.length);
  const shownViews = draft.views.length ? draft.views : [WHOLE_IMAGE];
  const preview: Prompt = { ...prompt, ...draft };
  const perRequest = imagesPerRequest(preview);
  const cap = modelInfo(model)?.maxImages;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-6xl"
      title="Image views"
      subtitle="What the model sees of each image: draw regions on a sample, then build one or more views from crops, outlines and spotlights."
      footer={
        <>
          <span className="mr-auto flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
            <Badge tone={cap && perRequest > cap ? "critical" : "neutral"}>
              {perRequest} image{perRequest === 1 ? "" : "s"} per request{cap ? ` · ${model.split("/").pop()} accepts ${cap}` : ""}
            </Badge>
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              // Untouched settings are stored empty, so the prompt keeps its plain request layout and hash.
              const plain = plainView && (!draft.views.length || (!draft.views[0].caption.trim() && !draft.views[0].enlarge));
              onSave({ ...draft, views: plain ? [] : draft.views, regions: plain && !draft.regions.length ? [] : draft.regions });
            }}
          >
            Save views
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]" data-views-editor>
        <div className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[12px] text-ink-2">
              Sample <span className="tabular">{samples.length ? sample + 1 : 0}</span> of {samples.length} · <span className="font-mono text-[11px]">{current?.name ?? "no images"}</span>
            </div>
            <div className="flex items-center gap-1">
              <IconButton label="Previous sample" disabled={sample === 0} onClick={() => setSample((s) => s - 1)}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <IconButton label="Next sample" disabled={sample >= samples.length - 1} onClick={() => setSample((s) => s + 1)}>
                <ChevronRight className="size-4" />
              </IconButton>
            </div>
          </div>
          {rgb ? (
            <BoxStage
              rgb={rgb}
              label="Sample image with regions"
              boxes={draft.regions.map((r) => ({ id: r.id, label: r.name, box: r.box, color: regionColor(r.id), editable: true }))}
              selected={selectedRegion}
              onSelect={(id) => id && setSelectedRegion(id)}
              onChange={(id, box) => setDraft((d) => ({ ...d, regions: d.regions.map((r) => (r.id === id ? { ...r, box } : r)) }))}
              onCreate={(box) => addRegion(box)}
            />
          ) : (
            <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-line-strong text-[12.5px] text-muted">{rgb === null ? "Add a training dataset to see samples." : <Spinner />}</div>
          )}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-2">
                Regions <span className="font-normal text-muted">· drag on the image to draw one; the same area is used on every image</span>
              </span>
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => addRegion()}>
                Add region
              </Button>
            </div>
            {draft.regions.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-[12px] text-muted">No regions yet. Draw a box around the object to judge.</div>
            ) : (
              <ul className="space-y-1">
                {draft.regions.map((r) => (
                  <li key={r.id} className={cx("flex items-center gap-2 rounded-lg border px-2 py-1", r.id === selectedRegion ? "border-accent bg-accent-wash/40" : "border-line")} onClick={() => setSelectedRegion(r.id)}>
                    <span className="size-3 shrink-0 rounded-sm" style={{ background: regionColor(r.id) }} />
                    <input
                      aria-label="Region name"
                      value={r.name}
                      onChange={(e) => setDraft((d) => ({ ...d, regions: d.regions.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)) }))}
                      className="h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[12.5px] font-medium outline-none hover:border-line focus:border-accent"
                    />
                    <span className="font-mono text-[10.5px] text-muted tabular">{r.box.map((v) => v.toFixed(2)).join(" ")}</span>
                    {usage(r.id) > 0 && <span className="text-[11px] text-muted">used {usage(r.id)}×</span>}
                    <IconButton
                      label={`Delete ${r.name}`}
                      className="size-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDraft((d) => ({ ...d, regions: d.regions.filter((x) => x.id !== r.id) }));
                        if (selectedRegion === r.id) setSelectedRegion(null);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-line pt-3" data-sent-previews>
            <div className="mb-2 text-[12px] font-medium text-ink-2">
              Sent for this sample <span className="font-normal text-muted">· exactly what the model receives, in order</span>
            </div>
            {rgb ? (
              <div className="grid grid-cols-2 gap-3">
                {shownViews.map((view, i) => (
                  <ViewPreview key={view.id} rgb={rgb} ops={view.ops} regions={draft.regions} maxSide={prompt.imageMaxSide} enlarge={view.enlarge} title={draft.views.length ? `View ${i + 1}` : "The whole image"} caption={shownViews.length > 1 || view.caption.trim() ? viewCaption(view, i, draft) : undefined} />
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-muted">No sample image.</div>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          {plainView && (
            <div className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="text-[12.5px] font-medium">Start from a preset</div>
              <div className="mt-2 grid gap-1.5">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" onClick={() => applyPreset(p)} className="rounded-lg border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:border-accent hover:bg-accent-wash/40">
                    <span className="block text-[12.5px] font-medium">{p.label}</span>
                    <span className="block text-[11.5px] text-ink-2">{p.help}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {draft.views.length === 0 && (
            <div className="rounded-xl border border-dashed border-line-strong px-3 py-3 text-[12px] text-muted" data-no-views>
              No views: the whole image is sent as it is. Add a view or start from a preset.
            </div>
          )}
          <ol className="space-y-2.5">
            {draft.views.map((view, i) => (
              <li key={view.id} className="rounded-xl border border-line bg-surface-2 p-2.5" data-view={i + 1}>
                <div className="flex items-center gap-1.5">
                  <Layers className="size-3.5 text-muted" />
                  <span className="text-[12.5px] font-semibold">View {i + 1}</span>
                  <span className="min-w-0 truncate text-[11.5px] text-muted">· {describeOps(view.ops, draft.regions)}</span>
                  <span className="ml-auto flex">
                    <IconButton label={`Move view ${i + 1} up`} className="size-6" disabled={i === 0} onClick={() => setDraft((d) => ({ ...d, views: moveItem(d.views, i, i - 1) }))}>
                      <ArrowUp className="size-3.5" />
                    </IconButton>
                    <IconButton label={`Move view ${i + 1} down`} className="size-6" disabled={i === draft.views.length - 1} onClick={() => setDraft((d) => ({ ...d, views: moveItem(d.views, i, i + 1) }))}>
                      <ArrowDown className="size-3.5" />
                    </IconButton>
                    <IconButton label={`Remove view ${i + 1}`} className="size-6" onClick={() => setDraft((d) => ({ ...d, views: d.views.filter((_, k) => k !== i) }))}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </span>
                </div>
                <textarea
                  rows={1}
                  aria-label={`Caption for view ${i + 1}`}
                  value={view.caption}
                  placeholder={draft.views.length > 1 ? viewCaption({ ...view, caption: "" }, i, draft) : "Caption sent before this image (optional)"}
                  onChange={(e) => setView(i, { ...view, caption: e.target.value })}
                  className={cx(inputClass, "mt-1.5 min-h-[30px] resize-y py-1 text-[12px] leading-snug [field-sizing:content]")}
                />
                {view.ops.length > 0 && (
                  <ol className="mt-1.5 space-y-1.5">
                    {view.ops.map((op, k) => (
                      <OpRow
                        key={k}
                        op={op}
                        index={k}
                        count={view.ops.length}
                        regions={draft.regions}
                        selected={selectedOp?.view === i && selectedOp.op === k}
                        onSelect={() => {
                          setSelectedOp({ view: i, op: k });
                          if ("area" in op && "region" in op.area) setSelectedRegion(op.area.region);
                        }}
                        onChange={(next) => setView(i, { ...view, ops: view.ops.map((o, j) => (j === k ? next : o)) })}
                        onRemove={() => setView(i, { ...view, ops: view.ops.filter((_, j) => j !== k) })}
                        onMove={(d) => setView(i, { ...view, ops: moveItem(view.ops, k, k + d) })}
                        allowCustom={false}
                      />
                    ))}
                  </ol>
                )}
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1">
                  <AddOpMenu onAdd={(kind) => setView(i, { ...view, ops: [...view.ops, kind === "rotate" ? defaultOp(kind, { box: [0, 0, 1, 1] }) : defaultOp(kind, areaForNewOp())] })} />
                  <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2" title="Small results (a tight crop) are sent at the full image size instead of their own size">
                    <input type="checkbox" checked={view.enlarge} onChange={(e) => setView(i, { ...view, enlarge: e.target.checked })} className="accent-[var(--accent)]" aria-label={`Enlarge view ${i + 1}`} />
                    Enlarge to {prompt.imageMaxSide}px
                  </label>
                </div>
              </li>
            ))}
          </ol>
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setDraft((d) => ({ ...d, views: [...d.views, { id: uid("vw"), caption: "", ops: [], enlarge: false }] }))}>
            Add view
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- single image editor ---------- */

/**
 * Edits one image: a reference example, or a new example cut from any image. Operations draw their own areas
 * (or use the prompt's regions); the result is stored as edits of the original, so it stays reproducible.
 */
export function ImageEditor({ hash, name, initialOps, regions, maxSide, title, saveLabel, onSave, onClose }: { hash: string; name: string; initialOps: ImageOp[]; regions: Region[]; maxSide: number; title: string; saveLabel: string; onSave: (ops: ImageOp[]) => void; onClose: () => void }) {
  const [ops, setOps] = useState<ImageOp[]>(() => (initialOps.length ? structuredClone(initialOps) : [defaultOp("crop", { box: [0.3, 0.3, 0.7, 0.7] }) as ImageOp]));
  const [selected, setSelected] = useState<number | null>(0);
  const rgb = useRgb(hash);
  const lastArea = (): Area => {
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i];
      if ("area" in o) return structuredClone(o.area);
    }
    return { box: [0.3, 0.3, 0.7, 0.7] };
  };
  // Boxes: each drawn area once (shared by every step that uses it), plus the prompt's regions, dashed.
  const stageBoxes: StageBox[] = [];
  ops.forEach((o, i) => {
    if (!("area" in o) || !("box" in o.area)) return;
    stageBoxes.push({ id: `op${i}`, label: `${i + 1} · ${OP_LABELS[o.kind]}`, box: o.area.box, color: STAGE_COLORS[i % STAGE_COLORS.length], editable: true });
  });
  regions.forEach((r, i) => stageBoxes.push({ id: `rg${r.id}`, label: r.name, box: r.box, color: STAGE_COLORS[(i + 3) % STAGE_COLORS.length], editable: false }));

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-5xl"
      title={title}
      subtitle={<span className="font-mono text-[12px]">{name}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(ops)}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]" data-image-editor>
        <div className="min-w-0 space-y-2">
          {rgb ? (
            <BoxStage
              rgb={rgb}
              label="Image to edit"
              boxes={stageBoxes}
              selected={selected != null ? `op${selected}` : null}
              onSelect={(id) => setSelected(id ? Number(id.slice(2)) : null)}
              onChange={(id, box) => {
                const i = Number(id.slice(2));
                const old = ops[i];
                if (!("area" in old) || !("box" in old.area)) return;
                const prev = old.area.box;
                // Steps that shared this box move with it.
                setOps((cur) => cur.map((o) => ("area" in o && "box" in o.area && o.area.box.join() === prev.join() ? ({ ...o, area: { box } } as ImageOp) : o)));
              }}
              onCreate={(box) => {
                setOps((cur) => [...cur, defaultOp("crop", { box }) as ImageOp]);
                setSelected(ops.length);
              }}
            />
          ) : (
            <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-line-strong">{rgb === null ? <span className="text-[12.5px] text-muted">This image is not stored in this browser.</span> : <Spinner />}</div>
          )}
          <p className="text-[11.5px] text-muted">Drag on the image to crop to a new area. Drag a box to move it, its corners to resize it; arrow keys nudge it.</p>
        </div>
        <div className="min-w-0 space-y-3">
          {ops.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[12px] text-muted">No edits: the whole image is used.</div>
          ) : (
            <ol className="space-y-1.5">
              {ops.map((op, k) => (
                <OpRow
                  key={k}
                  op={op}
                  index={k}
                  count={ops.length}
                  regions={regions}
                  selected={selected === k}
                  onSelect={() => setSelected(k)}
                  onChange={(next) => setOps((cur) => cur.map((o, j) => (j === k ? next : o)))}
                  onRemove={() => {
                    setOps((cur) => cur.filter((_, j) => j !== k));
                    setSelected(null);
                  }}
                  onMove={(d) => setOps((cur) => moveItem(cur, k, k + d))}
                  allowCustom
                />
              ))}
            </ol>
          )}
          <AddOpMenu
            label="Add edit"
            onAdd={(kind) => {
              setOps((cur) => [...cur, defaultOp(kind, lastArea())]);
              setSelected(ops.length);
            }}
          />
          {rgb && (
            <div className="border-t border-line pt-3">
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">Result</div>
              <ViewPreview rgb={rgb} ops={ops} regions={regions} maxSide={maxSide} enlarge={false} title="Sent as" />
              {ops.some((o) => o.kind === "outline" && o.width === 0) && (
                <div className="mt-1 text-[11px] text-muted">Automatic outline width: 1/250 of the longer side where it is drawn, at least 4 px ({autoLineWidth({ width: rgb.sourceWidth, height: rgb.sourceHeight })} px on the whole image).</div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The views of a prompt, as one line each. */
export function viewSummary(prompt: Prompt): string[] {
  return promptViews(prompt).map((v, i) => `${promptViews(prompt).length > 1 ? `View ${i + 1}: ` : ""}${describeOps(v.ops, prompt.regions ?? [])}`);
}

/** A thumbnail of an image after its edits (or the plain stored thumbnail when there are none). */
export function OpsThumb({ hash, ops, regions, alt, className }: { hash: string; ops: ImageOp[]; regions: Region[]; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = JSON.stringify(ops) + JSON.stringify(regions);
  useEffect(() => {
    let live = true;
    void import("@/lib/preview").then(({ editedThumb }) => editedThumb(hash, ops, regions).then((u) => live && setUrl(u)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, key]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={alt} className={className} /> : <div className={cx("shimmer", className)} />;
}
