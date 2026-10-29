"use client";
import { AlertTriangle, ChevronLeft, ChevronRight, Code2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useExperiment, type Analysis } from "@/lib/analysis";
import type { Target } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import type { ClassMapping, Dataset, DatasetItem } from "@/lib/types";
import { classColor, classLabel, OUTCOME_META } from "./colors";
import { StoredImage } from "./StoredImage";
import { Badge, Button, cx, fmtUsd, HashChip, IconButton, Modal } from "./ui";

export function ItemDetail({ item, dataset, analysis, target, targetKey, mapping, position, onPrev, onNext, onClose }: {
  item: DatasetItem;
  dataset: Dataset;
  analysis: Analysis | null;
  target: Target | null;
  targetKey: string | undefined;
  mapping: ClassMapping;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}) {
  const row = analysis?.rowById.get(item.id);
  const inf = analysis?.inferenceById.get(item.id);
  const prompt = useStore((s) => s.prompts.find((p) => p.id === s.selection.prompt));
  const addExample = useStore((s) => s.addExample);
  const notify = useStore((s) => s.notify);
  const [showRaw, setShowRaw] = useState(false);
  const { threshold } = useExperiment();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext]);

  const gtRaw = targetKey ? item.labels[targetKey] : null;
  const alreadyExample = prompt?.examples.some((e) => e.imageHash === item.imageHash);
  // Test-set images are the holdout: they can never become reference examples.
  const isTestSet = useStore((s) => s.selection.test === dataset.id);
  const peeking = useStore((s) => !!s.peek);
  const canAdd = !isTestSet && !peeking && prompt && targetKey === prompt.targetKey && gtRaw != null;
  const add = () => {
    if (!prompt || gtRaw == null) return;
    addExample({ imageHash: item.imageHash, fileName: item.fileName, caption: "", label: prompt.targetType === "boolean" ? gtRaw === true || gtRaw === "true" : String(gtRaw) });
    notify(`Added ${item.fileName.split("/").pop()} to "${prompt.name}" as a ${prompt.targetType === "boolean" ? (gtRaw ? "positive" : "negative") : `"${gtRaw}"`} example. The prompt hash changed, so runs need re-scoring.`);
  };
  const outcome = row?.outcome ? OUTCOME_META[row.outcome] : null;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-5xl"
      title={<span className="font-mono text-[14px]">{item.fileName}</span>}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span>{dataset.name}</span>
          <span className="text-muted">·</span>
          <span className="tabular">{position}</span>
          <span className="text-muted">·</span>
          <span className="tabular">
            {item.width}×{item.height}
          </span>
          <HashChip hash={item.imageHash} prefix="img" title="Image sha256" />
        </span>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1.5fr_1fr]">
        <div className="relative">
          <div className="overflow-hidden rounded-xl border border-line bg-surface-3">
            <StoredImage hash={item.imageHash} kind="full" alt={item.fileName} className="max-h-[60vh] w-full object-contain" placeholderClassName="aspect-[16/10] h-auto" />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <IconButton label="Previous image (←)" onClick={onPrev} disabled={!onPrev}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <span className="text-[11.5px] text-muted">Use ← → to step through the filtered images</span>
            <IconButton label="Next image (→)" onClick={onNext} disabled={!onNext}>
              <ChevronRight className="size-4" />
            </IconButton>
          </div>
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Labels</div>
            <dl className="divide-y divide-line rounded-xl border border-line">
              {dataset.schema.map((s) => {
                const v = item.labels[s.key];
                return (
                  <div key={s.key} className={cx("flex items-center justify-between gap-3 px-3 py-1.5 text-[12.5px]", s.key === targetKey && "bg-accent-wash/50")}>
                    <dt className="truncate text-ink-2">
                      {s.key}
                      {s.key === targetKey && <span className="ml-1.5 text-[10.5px] text-accent-ink">scored</span>}
                    </dt>
                    <dd className="font-medium">{v == null ? <span className="text-muted">missing</span> : s.type === "boolean" ? (v ? "yes" : "no") : String(v)}</dd>
                  </div>
                );
              })}
            </dl>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Model answer</span>
              {outcome && (
                <Badge tone={outcome.tone}>
                  {outcome.tone === "good" ? "✓" : "✕"} {outcome.long}
                </Badge>
              )}
            </div>
            {!row || row.status === "pending" ? (
              <div className="rounded-xl border border-dashed border-line-strong px-3 py-4 text-center text-[12.5px] text-muted">Not scored yet with this prompt.</div>
            ) : row.status === "error" ? (
              <div className="flex gap-2 rounded-xl bg-critical-wash px-3 py-2.5 text-[12.5px] text-critical-ink">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{inf?.error ?? "The request failed."} Run again to retry.</span>
              </div>
            ) : row.status === "excluded" ? (
              <div className="rounded-xl bg-surface-3 px-3 py-2.5 text-[12.5px] text-ink-2">This image&apos;s class is excluded in the class groups, so it is not scored.</div>
            ) : (
              <div className="space-y-1.5 rounded-xl border border-line p-3">
                {Object.entries(row.probs)
                  .sort((a, b) => b[1] - a[1])
                  .map(([g, p]) => (
                    <div key={g} className="flex items-center gap-2 text-[12.5px]">
                      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: classColor(target, mapping, g) }} />
                      <span className={cx("w-24 truncate", g === row.pred ? "font-semibold text-ink" : "text-ink-2")}>{classLabel(target, g)}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                        <div className="h-full rounded-full" style={{ width: `${p * 100}%`, background: classColor(target, mapping, g) }} />
                      </div>
                      <span className="w-12 text-right tabular">{(p * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 border-t border-line pt-2 text-[11.5px] text-ink-2">
                  <span>
                    Actual <b className="font-medium text-ink">{classLabel(target, row.gt)}</b>
                  </span>
                  <span>
                    Predicted <b className="font-medium text-ink">
                      {row.predPositive !== undefined ? (target?.type === "boolean" ? (row.predPositive ? "yes" : "no") : row.predPositive ? classLabel(target, row.pred) : `not ${analysis?.view.mode === "binary" ? analysis.view.positive : ""}`) : classLabel(target, row.pred)}
                    </b>
                  </span>
                  {row.predPositive !== undefined && row.score != null && (
                    <span className="text-muted tabular">
                      score {row.score.toFixed(3)} {row.predPositive ? "≥" : "<"} threshold {threshold.value.toFixed(3)}
                    </span>
                  )}
                  {row.lowConfidence && <span className="text-warning-ink">Below review cutoff ({threshold.value.toFixed(2)})</span>}
                </div>
              </div>
            )}
            {inf && (
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
                <span>Cost</span>
                <span className="text-right tabular text-ink">{fmtUsd(inf.usage.costUsd)}</span>
                <span>Input tokens</span>
                <span className="text-right tabular text-ink">{inf.usage.inputTokens.toLocaleString()}</span>
                <span>Latency</span>
                <span className="text-right tabular text-ink">{(inf.latencyMs / 1000).toFixed(2)} s</span>
                <span>Served model</span>
                <span className="truncate text-right font-mono text-[10.5px] text-ink" title={inf.servedModel}>
                  {inf.servedModel ?? inf.model}
                </span>
                <span>Requested</span>
                <span className="text-right text-ink">{new Date(inf.requestedAt).toLocaleString()}</span>
                <span>Cache key</span>
                <span className="text-right">
                  <HashChip hash={inf.cacheKey} title="sha256 of (prompt hash, model, image hash)" />
                </span>
              </div>
            )}
            {inf && (
              <div className="mt-2">
                <button onClick={() => setShowRaw((s) => !s)} className="inline-flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink">
                  <Code2 className="size-3.5" /> {showRaw ? "Hide" : "Show"} raw response
                </button>
                {showRaw && <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-surface-3 p-2.5 font-mono text-[11px] leading-relaxed scroll-thin">{JSON.stringify(inf.raw, null, 2)}</pre>}
              </div>
            )}
          </div>

          {canAdd && (
            <div className="rounded-xl border border-line bg-surface-2 p-3">
              <div className="text-[12.5px] font-medium">Use as a reference example</div>
              <p className="mt-0.5 text-[11.5px] text-ink-2">
                Hard cases make the best references.
              </p>
              <Button className="mt-2" size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={add} disabled={alreadyExample}>
                {alreadyExample ? "Already in the prompt" : `Add to prompt as ${prompt?.targetType === "boolean" ? (gtRaw ? "positive" : "negative") : `"${String(gtRaw)}"`}`}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
