"use client";
import { AlertTriangle, ChevronDown, Database, Download, History, PackageOpen, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { pickRun, targetFor, useExperiment, type Analysis } from "@/lib/analysis";
import { db } from "@/lib/db";
import { exportDataset } from "@/lib/export";
import { computeMetrics, fitThreshold, scoreRows, viewFor, ALL } from "@/lib/metrics";
import { inferenceKey } from "@/lib/prompt";
import { datasetMismatch, runBlockers, useStore, type Role } from "@/lib/store";
import type { Dataset } from "@/lib/types";
import { DatasetBrowser, emptyFilters, type ColorBy, type Filters } from "./DatasetBrowser";
import { ComparisonBar } from "./ComparisonBar";
import { ChartsRow, MetricTiles, ViewControls } from "./Results";
import { UploadDialog } from "./UploadDialog";
import { Button, Card, cx, Field, fmtPct, fmtUsd, HashChip, inputClass, MenuItem, Modal, Popover, ProgressBar, timeAgo } from "./ui";

function useCacheStatus(dataset: Dataset | undefined, hash: string | undefined, model: string, version: number) {
  const [cached, setCached] = useState<number | null>(null);
  useEffect(() => {
    if (!dataset || !hash) return setCached(null);
    let live = true;
    void (async () => {
      const keys = await Promise.all(dataset.items.map((i) => inferenceKey(hash, model, i.imageHash)));
      const hits = await db.getInferences(keys);
      if (live) setCached(hits.filter((h) => h?.ok).length);
    })();
    return () => {
      live = false;
    };
  }, [dataset, hash, model, version]);
  return cached;
}

function DatasetPicker({ role, current, onNew }: { role: Role; current: Dataset | undefined; onNew: () => void }) {
  const datasets = useStore((s) => s.datasets);
  const selectDataset = useStore((s) => s.selectDataset);
  const other = useStore((s) => s.selection[role === "train" ? "test" : "train"]);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative -ml-1.5 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Choose ${role === "train" ? "training" : "test"} dataset`}
        className="group flex min-w-0 max-w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-surface-3"
      >
        <span className="truncate text-[17px] font-semibold tracking-tight">{current?.name ?? "No dataset selected"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-aria-expanded:rotate-180" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="left" className="w-[min(420px,85vw)]">
        <div className="max-h-[50vh] overflow-y-auto scroll-thin">
          {datasets.filter((d) => d.id !== other).length === 0 && (
            <div className="px-2.5 py-2 text-[12.5px] text-muted">{datasets.length ? `The only dataset is the ${role === "train" ? "test" : "training"} set. Upload another.` : "No datasets yet."}</div>
          )}
          {datasets
            .filter((d) => d.id !== other)
            .map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                selectDataset(role, d.id);
                setOpen(false);
              }}
              className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-3", d.id === current?.id && "bg-accent-wash/60")}
            >
              <Database className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{d.name}</span>
                <span className="block truncate text-[11.5px] text-muted">
                  {d.items.length} images · {d.schema.map((s) => s.key).join(", ")}
                </span>
              </span>
              <span className="font-mono text-[10.5px] text-muted">{d.hash.slice(0, 8)}</span>
            </button>
            ))}
        </div>
        <div className="mt-1 border-t border-line pt-1">
          <MenuItem
            icon={<Plus className="size-4" />}
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            New dataset…
          </MenuItem>
        </div>
      </Popover>
    </div>
  );
}

function LabelSummary({ dataset, targetKey }: { dataset: Dataset; targetKey?: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {dataset.schema.map((s) => {
        const counts = new Map<string, number>();
        for (const i of dataset.items) {
          const v = i.labels[s.key];
          if (v != null) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
        }
        const detail = s.type === "boolean" ? `yes ${counts.get("true") ?? 0} · no ${counts.get("false") ?? 0}` : s.classes.map((c) => `${c} ${counts.get(c) ?? 0}`).join(" · ");
        return (
          <span
            key={s.key}
            title={detail}
            className={cx("inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11.5px]", s.key === targetKey ? "border-accent/40 bg-accent-wash text-accent-ink" : "border-line bg-surface-2 text-ink-2")}
          >
            <span className="font-medium">{s.key}</span>
            <span className="opacity-70">{s.type === "boolean" ? "yes/no" : `${s.classes.length} classes`}</span>
          </span>
        );
      })}
    </div>
  );
}

function RunHistory({ dataset, role }: { dataset: Dataset; role: Role }) {
  const runs = useStore((s) => s.runs);
  const inferences = useStore((s) => s.inferences);
  const prompts = useStore((s) => s.prompts);
  const promptHashes = useStore((s) => s.promptHashes);
  const selection = useStore((s) => s.selection);
  const datasets = useStore((s) => s.datasets);
  const model = useStore((s) => s.settings.model);
  const mappings = useStore((s) => s.mappings);
  const [open, setOpen] = useState(false);
  const mine = runs.filter((r) => r.datasetHash === dataset.hash && Object.keys(r.results).length).reverse();
  const prompt = prompts.find((p) => p.id === selection.prompt);
  const currentHash = prompt ? promptHashes[prompt.id] : undefined;
  const rows = useMemo(() => {
    if (!open) return [];
    const trainDs = datasets.find((d) => d.id === selection.train);
    return mine.map((r) => {
      const target = dataset.schema.find((s) => s.key === r.targetKey);
      if (!target) return { r, ba: null as number | null };
      const t = target.type === "boolean" ? ({ type: "boolean" } as const) : ({ type: "categorical", classes: target.classes } as const);
      const mapping = mappings[r.targetKey] ?? {};
      const view = viewFor(t, ALL);
      const inputs = dataset.items.map((i) => {
        const inf = inferences[r.results[i.id]];
        return { id: i.id, gt: i.labels[r.targetKey] ?? null, probabilities: inf?.ok ? inf.probabilities : null };
      });
      let threshold = view.mode === "binary" ? 0.5 : 0;
      if (view.mode === "binary") {
        const trainRun = role === "train" ? r : pickRun(runs.filter((x) => x.role === "train" && x.promptHash === r.promptHash && x.model === r.model), trainDs, { targetKey: r.targetKey }, r.promptHash, r.model, inferences)?.run;
        if (trainRun && trainDs) {
          const trainInputs = trainDs.items.map((i) => {
            const inf = inferences[trainRun.results[i.id]];
            return { id: i.id, gt: i.labels[r.targetKey] ?? null, probabilities: inf?.ok ? inf.probabilities : null };
          });
          threshold = fitThreshold(scoreRows(role === "train" ? inputs : trainInputs, t, mapping, view, 0.5)) ?? 0.5;
        }
      }
      return { r, ba: computeMetrics(scoreRows(inputs, t, mapping, view, threshold), t, mapping, view).balancedAccuracy };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runs, inferences, dataset, mappings]);
  if (!mine.length) return null;
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        History · {mine.length}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-[min(520px,90vw)] p-2">
        <div className="px-1.5 pb-1.5 pt-0.5 text-[12.5px] font-semibold">Runs on this dataset version</div>
        <div className="max-h-[50vh] overflow-y-auto scroll-thin">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-muted">
                <th className="px-1.5 py-1 font-medium">Prompt</th>
                <th className="px-1.5 py-1 font-medium">Model</th>
                <th className="px-1.5 py-1 text-right font-medium" title="Balanced accuracy at the fitted threshold (yes/no labels) or argmax (class labels), with no class groups">
                  BA
                </th>
                <th className="px-1.5 py-1 text-right font-medium">Cost</th>
                <th className="px-1.5 py-1 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ r, ba }) => (
                <tr key={r.id} className={cx("border-t border-line", r.promptHash === currentHash && r.model === model && "bg-accent-wash/50")}>
                  <td className="max-w-[190px] px-1.5 py-1.5">
                    <div className="truncate font-medium">{r.promptName}</div>
                    <div className="font-mono text-[10.5px] text-muted">
                      {r.promptHash.slice(0, 10)} · {r.targetKey}
                      {r.promptHash === currentHash && r.model === model && <span className="ml-1 font-sans text-accent-ink">current</span>}
                    </div>
                  </td>
                  <td className="max-w-[120px] truncate px-1.5 py-1.5 font-mono text-[10.5px] text-ink-2" title={r.model}>
                    {r.model.split("/").pop()}
                  </td>
                  <td className="px-1.5 py-1.5 text-right font-semibold tabular">{fmtPct(ba)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular text-ink-2">{fmtUsd(r.costUsd)}</td>
                  <td className="whitespace-nowrap px-1.5 py-1.5 text-right text-ink-2">{timeAgo(r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Popover>
    </div>
  );
}

function RenameDialog({ dataset, onClose }: { dataset: Dataset; onClose: () => void }) {
  const rename = useStore((s) => s.renameDataset);
  const [name, setName] = useState(dataset.name);
  const [description, setDescription] = useState(dataset.description);
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit dataset details"
      subtitle="Names and descriptions are labels only: they never change the dataset hash."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await rename(dataset.id, name, description);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={inputClass} />
        </Field>
      </div>
    </Modal>
  );
}

export function DatasetPanel({ role, fillHeight }: { role: Role; fillHeight?: number | null }) {
  const exp = useExperiment();
  const analysis: Analysis | null = exp[role];
  const datasets = useStore((s) => s.datasets);
  const selection = useStore((s) => s.selection);
  const settings = useStore((s) => s.settings);
  const live = useStore((s) => s.live[role]);
  const runError = useStore((s) => s.runErrors[role]);
  const startRun = useStore((s) => s.startRun);
  const setBundleImportOpen = useStore((s) => s.setBundleImportOpen);
  const cancelRun = useStore((s) => s.cancelRun);
  const deleteDataset = useStore((s) => s.deleteDataset);
  const promptHashes = useStore((s) => s.promptHashes);
  const blockers = useStore(useShallow((s) => runBlockers(s, role)));
  const peeking = useStore((s) => !!s.peek);
  const mismatch = useStore(
    useShallow((s) => {
      const m = datasetMismatch(s);
      return { blocking: m.blocking, message: m.message };
    }),
  );
  const runsLen = useStore((s) => s.runs.length);
  const dataset = datasets.find((d) => d.id === selection[role]);
  const prompt = exp.prompt;
  const hash = prompt ? promptHashes[prompt.id] : undefined;
  const cached = useCacheStatus(dataset, hash, settings.model, runsLen + (live ? 0 : 1));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [filters, setFiltersState] = useState<Filters>(emptyFilters);
  const [colorBy, setColorBy] = useState<ColorBy>("label");
  const wide = role === "test";
  const setFilters = (f: Partial<Filters>) => setFiltersState((cur) => ({ ...cur, ...f }));

  useEffect(() => {
    setFiltersState(emptyFilters);
  }, [dataset?.id, exp.focus, prompt?.targetKey]);
  useEffect(() => {
    if (analysis && colorBy === "label") setColorBy("outcome");
    if (!analysis && (colorBy === "outcome" || colorBy === "prediction")) setColorBy("label");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!analysis]);

  const title = role === "train" ? "Training set" : "Test set";
  const eyebrow = role === "train" ? "Training set · fit and iterate" : "Test set · holdout, scored with the training threshold";
  const target = dataset && prompt ? targetFor(dataset, prompt) : null;
  const uncached = dataset && cached != null ? dataset.items.length - cached : null;
  const trainRun = exp.train?.run;
  const upToDate = !!analysis && !analysis.stale && uncached === 0 && analysis.metrics.pending === 0 && analysis.run.status === "done";
  const promptMismatch = role === "test" && analysis && trainRun && (analysis.run.promptHash !== trainRun.promptHash || analysis.run.model !== trainRun.model);

  return (
    <Card className={cx("p-4 sm:p-5", !!fillHeight && "flex flex-col")} style={fillHeight ? { minHeight: fillHeight } : undefined} aria-label={title} data-panel={role}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{eyebrow}</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
            <DatasetPicker role={role} current={dataset} onNew={() => setUploadOpen(true)} />
            {dataset && <HashChip hash={dataset.hash} prefix="ds" title="Dataset version (sha256 over images, labels and schema)" />}
            {dataset && <span className="text-[12px] text-muted tabular">{dataset.items.length} images</span>}
          </div>
          {dataset?.description && <p className="mt-0.5 max-w-2xl text-[12.5px] text-ink-2">{dataset.description}</p>}
        </div>
        <div className="flex items-center gap-1">
          {dataset && <RunHistory dataset={dataset} role={role} />}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setUploadOpen(true)}>
            New
          </Button>
          {dataset && (
            <>
              <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setRenameOpen(true)} aria-label="Edit dataset details">
                <span className="hidden sm:inline">Edit</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={downloading}
                icon={<Download className="size-3.5" />}
                onClick={async () => {
                  setDownloading(true);
                  try {
                    await exportDataset(dataset);
                  } finally {
                    setDownloading(false);
                  }
                }}
                title="Download images, metadata.jsonl and dataset.json (with the hash) as a zip"
              >
                Download
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)} aria-label="Delete dataset" />
            </>
          )}
        </div>
      </div>

      {!dataset ? (
        <div className="mt-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-line-strong bg-surface-2 py-12 text-center">
          <Database className="size-6 text-muted" />
          <div className="mt-2 text-[14px] font-semibold">Add a {role === "train" ? "training" : "test"} dataset</div>
          <p className="mt-1 max-w-sm text-[12.5px] text-ink-2">
            {role === "train" ? "Upload a folder of labelled images to fit and tune the prompt on." : "Keep a holdout set apart from the training set. It is scored with the training threshold, never its own."}
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setUploadOpen(true)}>
              New dataset
            </Button>
            {role === "train" && (
              <Button icon={<PackageOpen className="size-3.5" />} onClick={() => setBundleImportOpen(true)}>
                Import experiment
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <LabelSummary dataset={dataset} targetKey={prompt?.targetKey} />
          </div>

          {mismatch.message && (
            <div className={cx("mt-3 flex gap-2 rounded-xl px-3 py-2.5 text-[12.5px]", mismatch.blocking ? "bg-critical-wash text-critical-ink" : "bg-warning-wash text-warning-ink")}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <b className="font-semibold">{mismatch.blocking ? "Datasets do not match. " : "Label schemas differ. "}</b>
                {mismatch.message}
              </span>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
            {live ? (
              <>
                <Button variant="secondary" icon={<Square className="size-3 fill-current" />} onClick={() => cancelRun(role)}>
                  Stop
                </Button>
                <div className="min-w-[160px] flex-1">
                  <div className="mb-1 flex justify-between text-[12px] text-ink-2 tabular">
                    <span>
                      Scoring {live.progress.done} of {live.progress.total}
                      {live.progress.cached ? ` · ${live.progress.cached} cached` : ""}
                      {live.progress.errors ? ` · ${live.progress.errors} failed` : ""}
                    </span>
                    <span>{fmtUsd(live.progress.costUsd)}</span>
                  </div>
                  <ProgressBar value={live.progress.total ? live.progress.done / live.progress.total : 0} />
                </div>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  icon={<Play className="size-3.5 fill-current" />}
                  onClick={() => startRun(role)}
                  disabled={blockers.length > 0 || upToDate}
                  title={blockers[0] ?? (upToDate ? "Every answer for this prompt version is already scored" : undefined)}
                >
                  Score {role === "train" ? "training" : "test"} set
                </Button>
                <div className="min-w-0 flex-1 text-[12px] text-ink-2">
                  {blockers.length ? (
                    <span className={cx("inline-flex items-start gap-1.5", peeking ? "text-ink-2" : "text-critical-ink")}>
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      {blockers[0]}
                    </span>
                  ) : uncached == null ? (
                    <span className="text-muted">Checking cache…</span>
                  ) : uncached === 0 ? (
                    <span>All {dataset.items.length} answers already cached{upToDate ? "" : ": scoring loads them instantly"}</span>
                  ) : (
                    <span>
                      <b className="font-medium text-ink tabular">{uncached}</b> of {dataset.items.length} images need a model call
                      {cached ? ` (${cached} cached)` : ""} · <span className="font-mono text-[11px]">{settings.model}</span>
                      {!settings.apiKey && <span className="text-warning-ink"> · add an API key in Settings</span>}
                    </span>
                  )}
                </div>

              </>
            )}
          </div>
          {runError && (
            <div className="mt-2 flex gap-2 rounded-xl bg-critical-wash px-3 py-2.5 text-[12.5px] text-critical-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {runError}
            </div>
          )}
          {analysis?.stale && !live && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-warning-wash px-3 py-2.5 text-[12.5px] text-warning-ink">
              <AlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                Showing results from an earlier version: prompt <span className="font-mono">{analysis.run.promptHash.slice(0, 10)}</span> (“{analysis.run.promptName}”)
                {analysis.run.model !== settings.model ? ` on ${analysis.run.model}` : ""}. The current prompt is <span className="font-mono">{hash?.slice(0, 10)}</span>. Score again to see the
                effect of your changes.
              </span>
            </div>
          )}
          {promptMismatch && !analysis?.stale && (
            <div className="mt-2 flex gap-2 rounded-xl bg-warning-wash px-3 py-2.5 text-[12.5px] text-warning-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              The training and test results come from different prompt versions or models, so the threshold may not transfer. Score both sets with the current prompt.
            </div>
          )}
          {role === "test" && !exp.train && analysis && (
            <div className="mt-2 flex gap-2 rounded-xl bg-warning-wash px-3 py-2.5 text-[12.5px] text-warning-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              No training run for this prompt: the test set uses the default threshold. Score the training set to fit one.
            </div>
          )}

          {analysis && target && (
            <div className="mt-4 space-y-3">
              <ComparisonBar comparison={exp.comparison} a={analysis} />
              <MetricTiles a={analysis} mapping={exp.mapping} />
              <ViewControls role={role} target={target} mapping={exp.mapping} focus={exp.focus} threshold={exp.threshold} a={analysis} />
              <ChartsRow a={analysis} role={role} threshold={exp.threshold} focus={exp.focus} mapping={exp.mapping} filters={filters} setFilters={setFilters} wide={wide} />
            </div>
          )}

          <div className={cx("mt-4 border-t border-line pt-4", !!fillHeight && "flex flex-1 basis-0 flex-col")}>
            <DatasetBrowser
              dataset={dataset}
              analysis={analysis}
              target={target}
              targetKey={prompt?.targetKey}
              mapping={exp.mapping}
              filters={filters}
              setFilters={setFilters}
              colorBy={colorBy}
              setColorBy={setColorBy}
              wide={wide}
              fill={!!fillHeight}
            />
          </div>
        </>
      )}

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} role={role} />
      {renameOpen && dataset && <RenameDialog dataset={dataset} onClose={() => setRenameOpen(false)} />}
      {confirmDelete && dataset && (
        <Modal
          open
          onClose={() => setConfirmDelete(false)}
          title={`Delete “${dataset.name}”?`}
          subtitle="The dataset is removed from this browser. Cached model answers are kept, so re-importing the same files restores its results."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await deleteDataset(dataset.id);
                  setConfirmDelete(false);
                }}
              >
                Delete dataset
              </Button>
            </>
          }
        >
          <p className="text-[12.5px] text-ink-2">Download it first if you need a copy: the zip includes the images, the manifest and the dataset hash.</p>
        </Modal>
      )}
    </Card>
  );
}

