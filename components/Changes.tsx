"use client";
import { ArrowRight, Filter } from "lucide-react";
import { useMemo, useState } from "react";
import { scoreRun, type Analysis } from "@/lib/analysis";
import { compareRows, type Change, type ItemChange } from "@/lib/compare";
import { shortHash } from "@/lib/hash";
import { computeMetrics, type Row } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import type { ClassMapping, Run } from "@/lib/types";
import { ChartCard } from "./charts";
import { classColor, classLabel } from "./colors";
import { ItemDetail } from "./ItemDetail";
import type { ChartFilters } from "./Results";
import { StoredImage } from "./StoredImage";
import { Button, cx, fmtPct, Segmented, timeAgo } from "./ui";

/** Earlier runs on the same dataset version and label, one per prompt version and model, newest first. */
function earlierRuns(runs: Run[], current: Run): Run[] {
  const seen = new Set<string>();
  const out: Run[] = [];
  const candidates = runs
    .filter((r) => r.id !== current.id && r.datasetHash === current.datasetHash && r.targetKey === current.targetKey && r.status !== "running" && Object.keys(r.results).length > 0)
    .filter((r) => r.promptHash !== current.promptHash || r.model !== current.model)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const r of candidates) {
    const key = `${r.promptHash}|${r.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  // The version scored just before this one comes first; versions scored after it follow.
  const before = out.filter((r) => r.startedAt < current.startedAt);
  return [...before, ...out.filter((r) => r.startedAt >= current.startedAt)];
}

function runLabel(r: Run, current: Run): string {
  const model = r.model !== current.model ? ` · ${r.model.split("/").pop()}` : "";
  return `${r.promptName} · ${shortHash(r.promptHash, 8)}${model}`;
}

function Prediction({ row, a, mapping }: { row: Row; a: Analysis; mapping: ClassMapping }) {
  const label = a.view.mode === "binary" && a.target.type !== "boolean" ? (row.predPositive ? classLabel(a.target, a.view.positive) : `not ${a.view.positive}`) : classLabel(a.target, row.pred);
  const color = a.view.mode === "binary" ? classColor(a.target, mapping, row.predPositive ? (a.target.type === "boolean" ? "true" : a.view.positive) : a.target.type === "boolean" ? "false" : null) : classColor(a.target, mapping, row.pred);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span className="font-medium text-ink">{a.target.type === "boolean" && a.view.mode === "binary" ? (row.predPositive ? "yes" : "no") : label}</span>
      {row.score != null && <span className="tabular text-muted">{row.score.toFixed(2)}</span>}
    </span>
  );
}

export function ChangesCard({ a, mapping, threshold, setFilters }: { a: Analysis; mapping: ClassMapping; threshold: number; setFilters: (f: Partial<ChartFilters>) => void }) {
  const runs = useStore((s) => s.runs);
  const inferences = useStore((s) => s.inferences);
  const options = useMemo(() => earlierRuns(runs, a.run), [runs, a.run]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [pickedTab, setTab] = useState<Change | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const other = options.find((r) => r.id === pickedId) ?? options[0];

  const result = useMemo(() => {
    if (!other) return null;
    const before = scoreRun(a.dataset, other, inferences, a.target, mapping, a.view, threshold);
    return { cmp: compareRows(before, a.rows), baBefore: computeMetrics(before, a.target, mapping, a.view).balancedAccuracy };
  }, [other, a, inferences, mapping, threshold]);

  if (!other || !result) {
    return (
      <ChartCard title="What changed" subtitle="Image by image, against the previous prompt version">
        <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 text-center text-[12.5px] text-ink-2">
          <ArrowRight className="mb-2 size-4 text-muted" />
          Change the prompt or model and score this set again. Every image whose answer went from wrong to right, or right to wrong, shows up here.
        </div>
      </ChartCard>
    );
  }

  const { cmp, baBefore } = result;
  const baAfter = a.metrics.balancedAccuracy;
  const delta = baBefore != null && baAfter != null ? baAfter - baBefore : null;
  // Regressions first, unless there are none.
  const tab: Change = pickedTab ?? (cmp.broke.length || !cmp.fixed.length ? "broke" : "fixed");
  const list = tab === "fixed" ? cmp.fixed : cmp.broke;
  const openIndex = open ? list.findIndex((c) => c.id === open) : -1;
  const item = (c: ItemChange) => a.dataset.items.find((i) => i.id === c.id);
  const versionLabel = other.startedAt < a.run.startedAt ? "previous version" : "later version";

  return (
    <ChartCard
      title="What changed"
      subtitle={
        options.length > 1 ? (
          <label className="inline-flex max-w-full items-center gap-1">
            vs
            <select
              aria-label="Compare with run"
              value={other.id}
              onChange={(e) => setPickedId(e.target.value)}
              className="min-w-0 max-w-[220px] truncate rounded border border-line bg-surface px-1 text-[11.5px] text-ink-2 outline-none focus:border-accent"
            >
              {options.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r, a.run)} · {timeAgo(r.startedAt)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span title={`Scored ${new Date(other.startedAt).toLocaleString()}`}>
            vs {versionLabel}: {runLabel(other, a.run)}
          </span>
        )
      }
    >
      <div className="flex h-full flex-col" data-changes>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-ink-2">
          <span>Balanced accuracy</span>
          <span className="tabular">{fmtPct(baBefore)}</span>
          <ArrowRight className="size-3 self-center text-muted" />
          <span className="font-semibold tabular text-ink">{fmtPct(baAfter)}</span>
          {delta != null && (
            <span className={cx("font-medium tabular", Math.abs(delta) < 0.0005 ? "text-muted" : delta > 0 ? "text-good-ink" : "text-critical-ink")}>
              {delta > 0 ? "▲" : delta < 0 ? "▼" : ""} {Math.abs(delta * 100).toFixed(1)} pts
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Segmented<Change>
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "broke", label: <span className="inline-flex items-center gap-1"><span className="text-critical-ink">✕</span> Broke {cmp.broke.length}</span> },
              { value: "fixed", label: <span className="inline-flex items-center gap-1"><span className="text-good-ink">✓</span> Fixed {cmp.fixed.length}</span> },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<Filter className="size-3.5" />}
            disabled={!list.length}
            onClick={() => setFilters({ ids: { label: `${tab === "fixed" ? "fixed" : "broke"} since ${shortHash(other.promptHash, 8)} (${list.length})`, ids: list.map((c) => c.id) } })}
          >
            Show in grid
          </Button>
        </div>
        <ul className="mt-2 max-h-[236px] min-h-[120px] flex-1 space-y-1 overflow-y-auto pr-1 scroll-thin">
          {list.length === 0 ? (
            <li className="flex h-full min-h-[120px] items-center justify-center text-center text-[12px] text-muted">
              {tab === "fixed" ? "No image went from wrong to right." : "No image went from right to wrong."}
            </li>
          ) : (
            list.map((c) => {
              const it = item(c);
              if (!it) return null;
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => setOpen(c.id)} className="flex w-full items-center gap-2 rounded-lg p-1 text-left transition-colors hover:bg-surface-3">
                    <span className="h-9 w-14 shrink-0 overflow-hidden rounded-md bg-surface-3">
                      <StoredImage hash={it.imageHash} alt={it.fileName} className="size-full object-cover" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[10.5px] text-muted">{it.fileName.split("/").pop()}</span>
                      <span className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-2">
                        <Prediction row={c.before} a={a} mapping={mapping} />
                        <ArrowRight className="size-3 text-muted" />
                        <Prediction row={c.after} a={a} mapping={mapping} />
                        <span className="text-muted">· actual {classLabel(a.target, c.after.gt)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <div className="mt-1.5 border-t border-line pt-1.5 text-[11px] text-muted tabular">
          {cmp.stillRight} still right · {cmp.stillWrong} still wrong{cmp.notComparable ? ` · ${cmp.notComparable} not scored in both` : ""}
        </div>
      </div>
      {open && openIndex >= 0 && item(list[openIndex]) && (
        <ItemDetail
          item={item(list[openIndex])!}
          dataset={a.dataset}
          analysis={a}
          target={a.target}
          targetKey={a.run.targetKey}
          mapping={mapping}
          position={`${openIndex + 1} of ${list.length} ${tab}`}
          onPrev={openIndex > 0 ? () => setOpen(list[openIndex - 1].id) : undefined}
          onNext={openIndex < list.length - 1 ? () => setOpen(list[openIndex + 1].id) : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </ChartCard>
  );
}
