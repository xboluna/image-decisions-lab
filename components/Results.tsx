"use client";
import { Layers, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { Analysis, ThresholdInfo } from "@/lib/analysis";
import { ALL, groupsFor, type Target } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import type { ClassMapping } from "@/lib/types";
import { ChartCard, ConfusionChart, Histogram, LegendKey, PrChart } from "./charts";
import { ChangesCard } from "./Changes";
import { ClassGroups } from "./ClassGroups";
import { classColor, classLabel } from "./colors";
import { Button, cx, fmtPct, InfoTip, Popover } from "./ui";

export type ChartFilters = {
  /** A fixed set of images, e.g. the ones that changed outcome since the last version. */
  ids: { label: string; ids: string[] } | null;
  span: [number, number] | null;
  cell: { actual: string; predicted: string } | null;
};

function Tile({ label, value, sub, delta, hero, title }: { label: string; value: string; sub?: string; delta?: number | null; hero?: boolean; title?: string }) {
  return (
    <div className={cx("min-w-0 rounded-xl border border-line px-3 py-2.5", hero ? "bg-accent-wash/60" : "bg-surface-2")}>
      <div className="flex min-w-0 items-center gap-1 text-[11.5px] font-medium text-ink-2">
        <span className="truncate">{label}</span>
        {title && <InfoTip text={title} label={`About ${label.toLowerCase()}`} />}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className={cx("font-semibold tracking-tight text-ink", hero ? "text-[24px]" : "text-[20px]")}>{value}</span>
        {delta != null && Number.isFinite(delta) && (
          <span className={cx("text-[11px] font-medium tabular", Math.abs(delta) < 0.0005 ? "text-muted" : delta > 0 ? "text-good-ink" : "text-critical-ink")} title="Change versus the version compared against">
            {delta > 0 ? "▲" : delta < 0 ? "▼" : ""} {Math.abs(delta * 100).toFixed(1)} pts
          </span>
        )}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted tabular">{sub}</div>}
    </div>
  );
}

const BA_HELP = "Balanced accuracy: the mean of per-class recall. For a yes/no label this is (sensitivity + specificity) / 2. Unlike accuracy it does not reward always guessing the common class.";

/** Metric tiles. Deltas compare against the comparison version, both measured on the images scored in both runs. */
export function MetricTiles({ a, mapping }: { a: Analysis; mapping: ClassMapping }) {
  const m = a.metrics;
  const b = a.baseline;
  const d = (key: "balancedAccuracy" | "accuracy" | "recall" | "specificity" | "precision" | "coverage" | "accuracyAboveCutoff") => {
    const after = b?.after[key];
    const before = b?.before[key];
    return after != null && before != null ? after - before : null;
  };
  const scoredSub = [`${m.n} scored`, m.excluded ? `${m.excluded} excluded` : "", m.errors ? `${m.errors} failed` : "", m.pending ? `${m.pending} pending` : ""].filter(Boolean).join(" · ");
  if (a.view.mode === "binary") {
    const c = m.counts!;
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <Tile hero label="Balanced accuracy" value={fmtPct(m.balancedAccuracy)} delta={d("balancedAccuracy")} sub={scoredSub} title={BA_HELP} />
        <Tile label="Accuracy" value={fmtPct(m.accuracy)} delta={d("accuracy")} sub={`${c.TP + c.TN} of ${m.n} right`} title="The share of scored images called correctly at the current threshold. Can look good on unbalanced data just by guessing the common answer." />
        <Tile label="Recall" value={fmtPct(m.recall)} delta={d("recall")} sub={`${c.TP} TP · ${c.FN} FN`} title="Sensitivity: the share of actual positives called positive." />
        <Tile label="Specificity" value={fmtPct(m.specificity)} delta={d("specificity")} sub={`${c.TN} TN · ${c.FP} FP`} title="The share of actual negatives called negative." />
        <Tile label="Precision" value={fmtPct(m.precision)} delta={d("precision")} sub={m.f1 != null ? `F1 ${m.f1.toFixed(3)}` : undefined} title="The share of positive calls that were right." />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      <Tile hero label="Balanced accuracy" value={fmtPct(m.balancedAccuracy)} delta={d("balancedAccuracy")} sub={scoredSub} title={BA_HELP} />
      <Tile label="Accuracy" value={fmtPct(m.accuracy)} delta={d("accuracy")} sub={`${m.perClass.reduce((s, p) => s + p.tp, 0)} of ${m.n} right`} title="The share of scored images whose most likely class matches the label. Can look good on unbalanced data just by guessing the common class." />
      <Tile label="Above review cutoff" value={fmtPct(m.coverage)} delta={d("coverage")} sub="share of answers kept" title="The share of answers whose top-class probability is at or above the review cutoff (the line on the histogram). Answers below it are flagged for review." />
      <Tile label="Accuracy above cutoff" value={fmtPct(m.accuracyAboveCutoff)} delta={d("accuracyAboveCutoff")} sub="on kept answers" title="Accuracy on only the answers at or above the review cutoff: how right the model is when it is confident enough to trust without review." />
      <div className="col-span-2 min-w-0 rounded-xl border border-line bg-surface-2 px-3 py-2 sm:col-span-1">
        <div className="text-[11.5px] font-medium text-ink-2">Recall per class</div>
        <div className="mt-1 space-y-1">
          {m.perClass.map((p) => (
            <div key={p.name} className="flex items-center gap-1.5 text-[11.5px]">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ background: classColor(a.target, mapping, p.name) }} />
              <span className="min-w-0 flex-1 truncate text-ink-2">{p.name}</span>
              <span className="tabular text-ink">{fmtPct(p.recall, 0)}</span>
              <span className="w-8 text-right tabular text-muted">n={p.support}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ViewControls({ role, target, mapping, focus, threshold, a }: { role: "train" | "test"; target: Target; mapping: ClassMapping; focus: string; threshold: ThresholdInfo; a: Analysis }) {
  const setFocus = useStore((s) => s.setFocus);
  const setThreshold = useStore((s) => s.setThreshold);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groups = groupsFor(target, mapping);
  const grouped = Object.keys(mapping).some((k) => mapping[k] !== undefined && mapping[k] !== k);
  const binary = a.view.mode === "binary";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {target.type === "categorical" && (
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-muted">View</span>
          <select
            aria-label="Results view"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            className="h-7 rounded-lg border border-line-strong bg-surface px-2 text-[12.5px] font-medium text-ink outline-none focus:border-accent"
          >
            <option value={ALL}>All classes (argmax)</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                One vs rest: {g}
              </option>
            ))}
          </select>
        </div>
      )}
      {target.type === "categorical" && (
        <div className="relative">
          {role === "train" ? (
            <Button size="sm" icon={<Layers className="size-3.5" />} onClick={() => setGroupsOpen((o) => !o)} aria-expanded={groupsOpen}>
              Class groups{grouped ? ` · ${groups.length}` : ""}
            </Button>
          ) : (
            grouped && (
              <span className="inline-flex items-center gap-1 text-[12px] text-ink-2">
                <Layers className="size-3.5 text-muted" /> Grouped as on the training set
              </span>
            )
          )}
          <Popover open={groupsOpen} onClose={() => setGroupsOpen(false)} align="left" className="w-[340px] p-3">
            <ClassGroups target={target} mapping={mapping} />
          </Popover>
        </div>
      )}
      <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-2">
        <span>
          {binary ? "Threshold" : "Review cutoff"} <b className="font-semibold tabular text-ink">{threshold.value.toFixed(3)}</b>
        </span>
        <span className="text-muted">
          {role === "test"
            ? threshold.trainRunId
              ? "· fixed by the training set"
              : "· default (score the training set to fit one)"
            : threshold.source === "fitted"
              ? "· fitted for best balanced accuracy"
              : threshold.source === "manual"
                ? `· set by hand${threshold.fitted != null ? ` (fitted ${threshold.fitted.toFixed(3)})` : ""}`
                : binary
                  ? "· default"
                  : "· drag the line to flag low-confidence answers"}
        </span>
        {role === "train" && threshold.overridden && threshold.trainRunId && (
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setThreshold(threshold.trainRunId as string, focus, null)}>
            {threshold.fitted != null ? "Reset to fitted" : "Reset"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChartsRow({ a, role, threshold, focus, mapping, filters, setFilters, wide }: { a: Analysis; role: "train" | "test"; threshold: ThresholdInfo; focus: string; mapping: ClassMapping; filters: ChartFilters; setFilters: (f: Partial<ChartFilters>) => void; wide: boolean }) {
  const setThreshold = useStore((s) => s.setThreshold);
  const setFocus = useStore((s) => s.setFocus);
  const binary = a.view.mode === "binary";
  const positive = a.view.mode === "binary" ? a.view.positive : null;
  const posColor = classColor(a.target, mapping, positive ?? "true");
  const seriesColor: Record<string, string> = binary
    ? { pos: posColor, neg: a.target.type === "boolean" ? classColor(a.target, mapping, "false") : "var(--axis)" }
    : { correct: "var(--good)", incorrect: "var(--critical)" };
  const xLabel = a.target.type === "boolean" ? "P(yes)" : binary ? `P(${positive})` : "Top-class probability";
  const canSet = role === "train" && !!threshold.trainRunId;
  const curves = a.curves.map((c) => ({ ...c, color: c.key === ALL ? "var(--ink-2)" : classColor(a.target, mapping, c.key) }));
  const operating = binary ? [{ key: positive ?? "true", precision: a.metrics.precision ?? null, recall: a.metrics.recall ?? null }] : [];
  const colors = binary ? [posColor, seriesColor.neg] : a.confusion.labels.map((g) => classColor(a.target, mapping, g));

  return (
    <div className={cx("grid gap-2.5 lg:grid-cols-2", wide && "2xl:grid-cols-4")}>
      <ChartCard
        title="Confidence distribution"
        subtitle={canSet ? "Drag the line to move the threshold · drag across bars to filter" : "Drag across bars to filter images"}
        legend={a.hist.series
          .slice()
          .reverse()
          .map((s) => (
            <LegendKey key={s.key} color={seriesColor[s.key]} label={s.label} />
          ))}
      >
        <Histogram
          role={role}
          edges={a.hist.edges}
          series={a.hist.series.map((s) => ({ ...s, color: seriesColor[s.key] }))}
          threshold={threshold.value}
          fitted={role === "train" ? threshold.fitted : null}
          thresholdTitle={binary ? "Decision threshold" : "Review cutoff"}
          onThreshold={canSet ? (v) => setThreshold(threshold.trainRunId as string, focus, v) : undefined}
          span={filters.span}
          onSpan={(span) => setFilters({ span })}
          xLabel={xLabel}
        />
      </ChartCard>
      <ChartCard title="Precision–recall" subtitle={binary ? "Dot: the current threshold" : canSet ? "One curve per class (one vs rest) · click a class curve to inspect it" : "One curve per class (one vs rest)"}>
        <PrChart
          role={role}
          curves={curves}
          operating={operating}
          onPick={
            canSet
              ? (t, key) => {
                  if (key === ALL) return;
                  if (!binary) setFocus(key);
                  setThreshold(threshold.trainRunId as string, binary ? focus : key, t);
                }
              : undefined
          }
        />
      </ChartCard>
      <ChartCard title="Confusion matrix" subtitle="Rows: actual · columns: predicted · click a cell to filter">
        <ConfusionChart
          role={role}
          labels={a.confusion.labels.map((l) => (a.target.type === "boolean" ? l : classLabel(a.target, l)))}
          keys={a.confusion.keys}
          cells={a.confusion.cells}
          colors={colors}
          selected={filters.cell}
          onSelect={(cell) => setFilters({ cell })}
        />
      </ChartCard>
      <ChangesCard a={a} mapping={mapping} setFilters={setFilters} />
    </div>
  );
}
