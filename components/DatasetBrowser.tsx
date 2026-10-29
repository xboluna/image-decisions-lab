"use client";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Filter, ImageOff, Search, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis";
import { inCell, type Outcome, type Row, type Target } from "@/lib/metrics";
import type { ClassMapping, Dataset, DatasetItem, LabelSchema } from "@/lib/types";
import type { ChartFilters } from "./Results";
import { classColor, classLabel, OUTCOME_META } from "./colors";
import { ItemDetail } from "./ItemDetail";
import { StoredImage } from "./StoredImage";
import { Badge, Button, cx, IconButton, inputClass, Popover, Segmented } from "./ui";

const PAGE_SIZES = [40, 80, 160];

function Pager({ page, pages, pageSize, total, onPage, onPageSize }: { page: number; pages: number; pageSize: number; total: number; onPage: (n: number) => void; onPageSize: (n: number) => void }) {
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav aria-label="Image pages" className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[12px] text-ink-2">
      <span className="tabular">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <label className="mr-2 flex items-center gap-1.5">
          Per page
          <select aria-label="Images per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="h-7 rounded-lg border border-line-strong bg-surface px-1.5 text-[12px] outline-none focus:border-accent">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <IconButton label="Previous page" onClick={() => onPage(page - 1)} disabled={page === 0}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="min-w-[72px] text-center tabular">
          Page {page + 1} of {pages}
        </span>
        <IconButton label="Next page" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
    </nav>
  );
}

export type ColorBy = "none" | "label" | "prediction" | "outcome";

export type Filters = ChartFilters & {
  labels: Record<string, string[]>;
  predicted: string[];
  outcomes: Outcome[];
  status: ("error" | "excluded" | "low" | "pending")[];
  search: string;
};

export const emptyFilters: Filters = { labels: {}, predicted: [], outcomes: [], status: [], search: "", span: null, cell: null };

function labelValueKey(v: DatasetItem["labels"][string]): string {
  return v == null ? "(missing)" : String(v);
}

export function applyFilters(items: DatasetItem[], f: Filters, a: Analysis | null): DatasetItem[] {
  const q = f.search.trim().toLowerCase();
  return items.filter((item) => {
    if (q && !item.fileName.toLowerCase().includes(q)) return false;
    for (const [key, vals] of Object.entries(f.labels)) if (vals.length && !vals.includes(labelValueKey(item.labels[key]))) return false;
    if (!a) return true;
    const row = a.rowById.get(item.id);
    if (f.predicted.length && (!row?.pred || !f.predicted.includes(row.pred))) return false;
    if (f.outcomes.length && (!row?.outcome || !f.outcomes.includes(row.outcome))) return false;
    if (f.span && (row?.score == null || row.score < f.span[0] || row.score > f.span[1])) return false;
    if (f.cell && (!row || !inCell(row, a.view, f.cell.actual, f.cell.predicted))) return false;
    if (f.status.length) {
      const hit = f.status.some((s) => (s === "low" ? row?.lowConfidence : row?.status === s));
      if (!hit) return false;
    }
    return true;
  });
}

function MultiChips({ options, selected, onChange, disabled, render }: { options: { value: string; count?: number; color?: string }[]; selected: string[]; onChange: (v: string[]) => void; disabled?: boolean; render?: (v: string) => React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((s) => s !== o.value) : [...selected, o.value])}
            className={cx(
              "inline-flex h-6.5 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors disabled:cursor-not-allowed",
              on ? "border-accent bg-accent-wash text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
            )}
          >
            {o.color && <span className="size-2 rounded-[3px]" style={{ background: o.color }} />}
            {render ? render(o.value) : o.value}
            {o.count != null && <span className="tabular text-muted">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function FilterGroup({ title, children, disabled, hint }: { title: string; children: React.ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <div className={cx("min-w-0", disabled && "opacity-45")} title={disabled ? hint : undefined}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        {title}
        {disabled && <span className="font-normal normal-case tracking-normal">· {hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function DatasetBrowser({ dataset, analysis, target, targetKey, mapping, filters, setFilters, colorBy, setColorBy, wide, fill }: {
  dataset: Dataset;
  analysis: Analysis | null;
  target: Target | null;
  targetKey: string | undefined;
  mapping: ClassMapping;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  colorBy: ColorBy;
  setColorBy: (c: ColorBy) => void;
  wide: boolean;
  /** Fill the panel's remaining height with every image, scrolling inside it. */
  fill?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const filtered = useMemo(() => applyFilters(dataset.items, filters, analysis), [dataset.items, filters, analysis]);
  const hasRun = !!analysis;
  const noRunHint = "score this set to enable";
  const binary = analysis?.view.mode === "binary";

  const labelOptions = (s: LabelSchema) => {
    const counts = new Map<string, number>();
    for (const item of dataset.items) {
      const k = labelValueKey(item.labels[s.key]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const order = s.type === "boolean" ? ["true", "false"] : s.classes;
    return [...order, ...[...counts.keys()].filter((k) => !order.includes(k))]
      .filter((v) => counts.has(v))
      .map((v) => ({ value: v, count: counts.get(v), color: s.key === targetKey && target ? classColor(target, mapping, target.type === "categorical" ? (mapping[v] === undefined ? v : (mapping[v] ?? undefined)) : v) : undefined }));
  };

  const active: { key: string; label: string; clear: () => void }[] = [];
  if (filters.search) active.push({ key: "search", label: `“${filters.search}”`, clear: () => setFilters({ search: "" }) });
  for (const [k, vals] of Object.entries(filters.labels)) if (vals.length) active.push({ key: `l:${k}`, label: `${k}: ${vals.join(", ")}`, clear: () => setFilters({ labels: { ...filters.labels, [k]: [] } }) });
  if (filters.predicted.length) active.push({ key: "pred", label: `predicted: ${filters.predicted.map((p) => classLabel(target, p)).join(", ")}`, clear: () => setFilters({ predicted: [] }) });
  if (filters.outcomes.length) active.push({ key: "out", label: filters.outcomes.map((o) => OUTCOME_META[o].label).join(", "), clear: () => setFilters({ outcomes: [] }) });
  if (filters.span) active.push({ key: "span", label: `score ${filters.span[0].toFixed(2)}–${filters.span[1].toFixed(2)}`, clear: () => setFilters({ span: null }) });
  if (filters.cell && analysis) {
    const idx = (k: string) => analysis.confusion.keys.indexOf(k);
    active.push({ key: "cell", label: `actual ${analysis.confusion.labels[idx(filters.cell.actual)]} → predicted ${analysis.confusion.labels[idx(filters.cell.predicted)]}`, clear: () => setFilters({ cell: null }) });
  }
  if (filters.status.length) active.push({ key: "status", label: filters.status.map((s) => (s === "low" ? "below cutoff" : s)).join(", "), clear: () => setFilters({ status: [] }) });

  const outcomeOptions: Outcome[] = binary ? ["TP", "FP", "FN", "TN"] : ["correct", "incorrect"];
  const outcomeCounts = new Map<Outcome, number>();
  analysis?.rows.forEach((r) => r.outcome && outcomeCounts.set(r.outcome, (outcomeCounts.get(r.outcome) ?? 0) + 1));
  const predCounts = new Map<string, number>();
  analysis?.rows.forEach((r) => r.pred && r.status === "scored" && predCounts.set(r.pred, (predCounts.get(r.pred) ?? 0) + 1));

  const detailIndex = detail ? filtered.findIndex((i) => i.id === detail) : -1;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageItems = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const goTo = (n: number) => {
    setPage(Math.min(Math.max(0, n), pages - 1));
    scrollRef.current?.scrollTo({ top: 0 });
  };
  // A new filter starts again at the first page.
  useEffect(() => {
    setPage(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filters, dataset.id]);
  // Stepping through images in the viewer keeps the grid on the page that holds the open image.
  useEffect(() => {
    if (detailIndex >= 0 && Math.floor(detailIndex / pageSize) !== safePage) setPage(Math.floor(detailIndex / pageSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailIndex]);

  return (
    <div className={cx(fill && "@container flex flex-1 flex-col")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-[260px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <input aria-label="Search file names" value={filters.search} onChange={(e) => setFilters({ search: e.target.value })} placeholder="Search file names" className={cx(inputClass, "h-8 pl-8")} />
        </div>
        <div className="relative">
          <Button size="md" icon={<Filter className="size-3.5" />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            Filters
            {active.filter((x) => x.key !== "search").length > 0 && <Badge tone="accent">{active.filter((x) => x.key !== "search").length}</Badge>}
            <ChevronDown className="size-3.5 text-muted" />
          </Button>
          <Popover open={open} onClose={() => setOpen(false)} align="left" className="max-h-[70vh] w-[min(560px,90vw)] overflow-y-auto p-3.5 scroll-thin">
            <div className="space-y-3.5">
              {dataset.schema.map((s) => (
                <FilterGroup key={s.key} title={`${s.key}${s.key === targetKey ? " · scored label" : ""}`}>
                  <MultiChips
                    options={labelOptions(s)}
                    selected={filters.labels[s.key] ?? []}
                    onChange={(v) => setFilters({ labels: { ...filters.labels, [s.key]: v } })}
                    render={(v) => (s.type === "boolean" ? (v === "true" ? "yes" : v === "false" ? "no" : v) : v)}
                  />
                </FilterGroup>
              ))}
              <div className="border-t border-line" />
              <FilterGroup title="Predicted class" disabled={!hasRun} hint={noRunHint}>
                <MultiChips
                  disabled={!hasRun}
                  options={(analysis?.groups ?? (target?.type === "categorical" ? target.classes : ["true", "false"])).map((g) => ({ value: g, count: predCounts.get(g) ?? 0, color: classColor(target, mapping, g) }))}
                  selected={filters.predicted}
                  onChange={(v) => setFilters({ predicted: v })}
                  render={(v) => classLabel(target, v)}
                />
              </FilterGroup>
              <FilterGroup title="Outcome" disabled={!hasRun} hint={noRunHint}>
                <MultiChips
                  disabled={!hasRun}
                  options={outcomeOptions.map((o) => ({ value: o, count: outcomeCounts.get(o) ?? 0, color: OUTCOME_META[o].color }))}
                  selected={filters.outcomes}
                  onChange={(v) => setFilters({ outcomes: v as Outcome[] })}
                  render={(v) => OUTCOME_META[v as Outcome].long}
                />
              </FilterGroup>
              <FilterGroup title={binary ? "Score range" : "Confidence range"} disabled={!hasRun} hint={noRunHint}>
                <div className="flex items-center gap-2 text-[12px] text-ink-2">
                  {(["from", "to"] as const).map((end, i) => (
                    <label key={end} className="flex items-center gap-1">
                      {end}
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={!hasRun}
                        value={filters.span ? filters.span[i] : i === 0 ? "" : ""}
                        placeholder={i === 0 ? "0" : "1"}
                        onChange={(e) => {
                          const v = Math.min(1, Math.max(0, Number(e.target.value)));
                          const cur = filters.span ?? [0, 1];
                          const next: [number, number] = i === 0 ? [v, cur[1]] : [cur[0], v];
                          setFilters({ span: e.target.value === "" ? null : [Math.min(...next), Math.max(...next)] });
                        }}
                        className={cx(inputClass, "h-7 w-20 py-0")}
                      />
                    </label>
                  ))}
                  <span className="text-muted">or drag across the histogram</span>
                </div>
              </FilterGroup>
              <FilterGroup title="Needs attention" disabled={!hasRun} hint={noRunHint}>
                <MultiChips
                  disabled={!hasRun}
                  options={[
                    { value: "error", count: analysis?.metrics.errors ?? 0 },
                    { value: "pending", count: analysis?.metrics.pending ?? 0 },
                    { value: "excluded", count: analysis?.metrics.excluded ?? 0 },
                    ...(binary ? [] : [{ value: "low", count: analysis?.rows.filter((r) => r.lowConfidence).length ?? 0 }]),
                  ]}
                  selected={filters.status}
                  onChange={(v) => setFilters({ status: v as Filters["status"] })}
                  render={(v) => ({ error: "Failed request", pending: "Not scored yet", excluded: "Excluded class", low: "Below review cutoff" })[v]}
                />
              </FilterGroup>
            </div>
          </Popover>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-muted">Color by</span>
          <Segmented<ColorBy>
            size="sm"
            value={colorBy}
            onChange={setColorBy}
            options={[
              { value: "none", label: "None" },
              { value: "label", label: "Label" },
              { value: "prediction", label: "Prediction", disabled: !hasRun, title: hasRun ? undefined : "Score this set to enable" },
              { value: "outcome", label: "Outcome", disabled: !hasRun, title: hasRun ? undefined : "Score this set to enable" },
            ]}
          />
        </div>
        <div className="ml-auto text-[12px] text-ink-2 tabular">
          {filtered.length === dataset.items.length ? `${dataset.items.length} images` : `${filtered.length} of ${dataset.items.length} images`}
        </div>
      </div>
      {active.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {active.map((f) => (
            <span key={f.key} className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-wash pl-2 pr-1 text-[12px] text-accent-ink">
              {f.label}
              <button aria-label={`Clear ${f.label}`} onClick={f.clear} className="rounded p-0.5 hover:bg-accent/15">
                <X className="size-3" />
              </button>
            </span>
          ))}
          <button className="text-[12px] text-ink-2 underline-offset-2 hover:text-ink hover:underline" onClick={() => setFilters(emptyFilters)}>
            Clear all
          </button>
        </div>
      )}
      <ColorLegend colorBy={colorBy} target={target} mapping={mapping} analysis={analysis} />
      {filtered.length === 0 ? (
        <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong py-10 text-center">
          <ImageOff className="size-5 text-muted" />
          <div className="mt-1.5 text-[13px] font-medium">No images match these filters</div>
          <button className="mt-1 text-[12.5px] text-accent-ink hover:underline" onClick={() => setFilters(emptyFilters)}>
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className={cx("-mx-1 mt-3 overflow-y-auto px-1 pb-1 pt-1 scroll-thin", fill ? "flex-1 basis-0" : "max-h-[70vh]")}
            // When filling the panel, never shorter than two rows of cards: card width from the container width
            // (5 columns, 10px gaps), a 16:10 image plus its caption, one gap, and the padding.
            style={fill ? { minHeight: "calc(2 * ((100cqw - 40px) / 5 * 0.625 + 48px) + 10px + 8px)" } : undefined}
            data-grid-scroll
          >
            <div className={cx("grid content-start gap-2.5", wide ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-8" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5")}>
              {pageItems.map((item) => (
                <ImageCard key={item.id} item={item} row={analysis?.rowById.get(item.id)} scoreClass={analysis?.view.mode === "binary" ? analysis.view.positive : null} target={target} targetKey={targetKey} mapping={mapping} colorBy={colorBy} onOpen={() => setDetail(item.id)} />
              ))}
            </div>
          </div>
          {filtered.length > PAGE_SIZES[0] && (
          <Pager
            page={safePage}
            pages={pages}
            pageSize={pageSize}
            total={filtered.length}
            onPage={goTo}
            onPageSize={(n) => {
              setPageSize(n);
              goTo(0);
            }}
          />
          )}
        </>
      )}
      {detail && detailIndex >= 0 && (
        <ItemDetail
          item={filtered[detailIndex]}
          dataset={dataset}
          analysis={analysis}
          target={target}
          targetKey={targetKey}
          mapping={mapping}
          position={`${detailIndex + 1} of ${filtered.length}`}
          onPrev={detailIndex > 0 ? () => setDetail(filtered[detailIndex - 1].id) : undefined}
          onNext={detailIndex < filtered.length - 1 ? () => setDetail(filtered[detailIndex + 1].id) : undefined}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function ColorLegend({ colorBy, target, mapping, analysis }: { colorBy: ColorBy; target: Target | null; mapping: ClassMapping; analysis: Analysis | null }) {
  if (colorBy === "none" || !target) return null;
  let entries: { color: string; label: string }[] = [];
  if (colorBy === "outcome") {
    const keys: Outcome[] = analysis?.view.mode === "binary" ? ["TP", "TN", "FP", "FN"] : ["correct", "incorrect"];
    entries = keys.map((k) => ({ color: OUTCOME_META[k].color, label: OUTCOME_META[k].long }));
  } else {
    const groups = analysis?.groups ?? (target.type === "categorical" ? target.classes : ["true", "false"]);
    entries = groups.map((g) => ({ color: classColor(target, mapping, g), label: classLabel(target, g) }));
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
      <span className="text-muted">{colorBy === "label" ? "Border: actual label" : colorBy === "prediction" ? "Border: predicted class" : "Border: outcome"}</span>
      {entries.map((e) => (
        <span key={e.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  );
}

const ImageCard = memo(function ImageCard({ item, row, scoreClass, target, targetKey, mapping, colorBy, onOpen }: { item: DatasetItem; row: Row | undefined; scoreClass: string | null | undefined; target: Target | null; targetKey: string | undefined; mapping: ClassMapping; colorBy: ColorBy; onOpen: () => void }) {
  const raw = targetKey ? item.labels[targetKey] : undefined;
  const gtGroup = row?.gt ?? (raw == null ? null : target?.type === "boolean" ? String(raw) : (mapping[String(raw)] === undefined ? String(raw) : mapping[String(raw)]));
  const ring =
    colorBy === "label"
      ? classColor(target, mapping, gtGroup)
      : colorBy === "prediction"
        ? row?.pred
          ? classColor(target, mapping, row.pred)
          : null
        : colorBy === "outcome"
          ? row?.outcome
            ? OUTCOME_META[row.outcome].color
            : null
          : null;
  const outcome = row?.outcome ? OUTCOME_META[row.outcome] : null;
  const dim = row?.status === "excluded";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx("group relative flex flex-col overflow-hidden rounded-xl border bg-surface text-left transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-pop", ring ? "border-transparent" : "border-line")}
      style={ring ? { boxShadow: `0 0 0 2.5px ${ring}` } : undefined}
    >
      <div className={cx("relative aspect-[16/10] w-full overflow-hidden bg-surface-3", dim && "opacity-40")}>
        <StoredImage hash={item.imageHash} alt={item.fileName} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        {gtGroup != null && (
          <span className="absolute left-1.5 top-1.5 inline-flex h-5 max-w-[75%] items-center gap-1 rounded-md bg-black/60 px-1.5 text-[10.5px] font-medium text-white backdrop-blur-sm">
            <span className="size-2 shrink-0 rounded-[3px]" style={{ background: classColor(target, mapping, gtGroup) }} />
            <span className="truncate">{classLabel(target, gtGroup)}</span>
          </span>
        )}
        {outcome && (
          <span
            className={cx(
              "absolute right-1.5 top-1.5 inline-flex h-5 items-center rounded-md bg-surface px-1.5 text-[10.5px] font-semibold shadow-card",
              outcome.tone === "good" ? "text-good-ink" : outcome.tone === "critical" ? "text-critical-ink" : "text-serious-ink",
            )}
            title={outcome.long}
          >
            {outcome.tone === "good" ? "✓ " : "✕ "}
            {outcome.label}
          </span>
        )}
        {row?.status === "error" && (
          <span className="absolute right-1.5 top-1.5 inline-flex h-5 items-center gap-1 rounded-md bg-surface px-1.5 text-[10.5px] font-semibold text-critical-ink shadow-card">
            <AlertTriangle className="size-3" /> failed
          </span>
        )}
        {dim && <span className="absolute right-1.5 top-1.5 rounded-md bg-surface/90 px-1.5 text-[10.5px] text-ink-2">excluded</span>}
      </div>
      <div className="w-full px-2 pb-1.5 pt-1">
        <div className="truncate font-mono text-[10.5px] text-muted" title={item.fileName}>
          {item.fileName.split("/").pop()}
        </div>
        {row?.score != null && row.pred != null ? (
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[11.5px] font-medium text-ink">
              {scoreClass ? (target?.type === "boolean" ? "P(yes)" : `P(${scoreClass})`) : `→ ${row.pred}`}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full" style={{ width: `${row.score * 100}%`, background: classColor(target, mapping, scoreClass ?? row.pred) }} />
            </div>
            <span className="text-[11px] tabular text-ink-2">{row.score.toFixed(2)}</span>
            {row.lowConfidence && (
              <span title="Below the review cutoff" className="text-warning-ink">
                <AlertTriangle className="size-3" />
              </span>
            )}
          </div>
        ) : (
          <div className="mt-0.5 h-[18px] text-[11px] text-muted">{row?.status === "pending" || !row ? "not scored" : ""}</div>
        )}
      </div>
    </button>
  );
});
