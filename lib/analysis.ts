"use client";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ALL,
  computeMetrics,
  confusionMatrix,
  fitThreshold,
  groupsFor,
  histogram,
  prCurves,
  scoreRows,
  viewFor,
  type Metrics,
  type Row,
  type ScoreInput,
  type Target,
  type View,
} from "./metrics";
import { pairedRows, pickBaselines, preferredRun } from "./compare";
import { activeModel, useStore, type Role } from "./store";
import type { ClassMapping, Dataset, Inference, Prompt, Run } from "./types";

/** A prompt version: the prompt hash and the model it was scored with. */
export const versionKey = (r: { promptHash: string; model: string }) => `${r.promptHash}|${r.model}`;

/** The run of the comparison version on this panel's dataset, scored the same way as the run being shown. */
export type BaselineView = {
  run: Run;
  complete: boolean;
  rows: Row[];
  /** Metrics of both versions on the images scored in both, so deltas reflect only the prompt or model change. */
  before: Metrics;
  after: Metrics;
  paired: number;
  scored: number;
};

export type VersionOption = { key: string; promptHash: string; model: string; promptName: string; startedAt: string; complete: boolean; snapshot?: Prompt };

export type Comparison = {
  /** Versions available to compare against, the one scored just before the viewed version first. */
  options: VersionOption[];
  /** The version compared against, or null when there is none. */
  baseline: VersionOption | null;
  /** True while looking at the comparison version instead of the working one. */
  peeking: boolean;
  /** The version being edited (selected prompt and model). */
  working: { key: string; promptName: string; promptHash: string; model: string } | null;
};

export type Analysis = {
  role: Role;
  dataset: Dataset;
  run: Run;
  /** The run was made with a different prompt version or model than the one selected now. */
  stale: boolean;
  target: Target;
  view: View;
  groups: string[];
  rows: Row[];
  rowById: Map<string, Row>;
  metrics: Metrics;
  confusion: ReturnType<typeof confusionMatrix>;
  hist: ReturnType<typeof histogram>;
  curves: ReturnType<typeof prCurves>;
  inferenceById: Map<string, Inference>;
  baseline: BaselineView | null;
};

export type ThresholdInfo = {
  value: number;
  fitted: number | null;
  overridden: boolean;
  /** "fitted" from the training run, "manual" when moved by hand, "default" when there is no training run. */
  source: "fitted" | "manual" | "default";
  trainRunId: string | null;
};

export function pickRun(
  runs: Run[],
  dataset: Dataset | undefined,
  prompt: Pick<Prompt, "targetKey"> | undefined,
  hash: string | undefined,
  model: string,
  inferences: Record<string, Inference>,
): { run: Run; stale: boolean } | null {
  if (!dataset || !prompt) return null;
  const sameData = runs.filter((r) => r.datasetHash === dataset.hash && r.targetKey === prompt.targetKey && Object.keys(r.results).length + (r.status === "running" ? 1 : 0) > 0);
  const complete = (r: Run) => isCompleteRun(r, dataset, inferences);
  const exact = preferredRun(
    sameData.filter((r) => r.promptHash === hash && r.model === model),
    complete,
  );
  if (exact) return { run: exact, stale: false };
  // No run of this version yet: show the most recently scored other version, marked stale.
  const newest = [...sameData].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!newest) return null;
  const run = preferredRun(
    sameData.filter((r) => versionKey(r) === versionKey(newest)),
    complete,
  );
  return run ? { run, stale: true } : null;
}

export function targetFor(dataset: Dataset, prompt: Prompt): Target | null {
  const s = dataset.schema.find((x) => x.key === prompt.targetKey);
  if (!s || s.type !== prompt.targetType) return null;
  return s.type === "boolean" ? { type: "boolean" } : { type: s.type, classes: s.classes };
}

function inputsFor(dataset: Dataset, run: Run, inferences: Record<string, Inference>, key: string): { inputs: ScoreInput[]; byId: Map<string, Inference> } {
  const byId = new Map<string, Inference>();
  const inputs = dataset.items.map((item) => {
    const k = run.results[item.id];
    const inf = k ? inferences[k] : undefined;
    if (inf) byId.set(item.id, inf);
    return { id: item.id, gt: item.labels[key] ?? null, probabilities: inf?.ok ? inf.probabilities : null, error: inf && !inf.ok ? (inf.error ?? "failed") : undefined };
  });
  return { inputs, byId };
}

/** One run's rows, scored the same way as the run being shown (same target, class groups, view and threshold). */
export function scoreRun(dataset: Dataset, run: Run, inferences: Record<string, Inference>, target: Target, mapping: ClassMapping, view: View, threshold: number): Row[] {
  return scoreRows(inputsFor(dataset, run, inferences, run.targetKey).inputs, target, mapping, view, threshold);
}

function analyse(role: Role, dataset: Dataset, picked: { run: Run; stale: boolean }, prompt: Prompt, inferences: Record<string, Inference>, mapping: ClassMapping, focus: string, threshold: number, target: Target): Analysis {
  const view = viewFor(target, focus);
  const { inputs, byId } = inputsFor(dataset, picked.run, inferences, prompt.targetKey);
  const rows = scoreRows(inputs, target, mapping, view, threshold);
  return {
    role,
    dataset,
    run: picked.run,
    stale: picked.stale,
    target,
    view,
    groups: groupsFor(target, mapping),
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    metrics: computeMetrics(rows, target, mapping, view),
    confusion: confusionMatrix(rows, target, mapping, view),
    hist: histogram(rows, view),
    curves: prCurves(rows, target, mapping, view),
    inferenceById: byId,
    baseline: null,
  };
}

/** A run that finished and has a good answer for every image in its dataset. */
export function isCompleteRun(r: Run, dataset: Dataset, inferences: Record<string, Inference>): boolean {
  return r.status === "done" && dataset.items.every((i) => inferences[r.results[i.id]]?.ok);
}

type Viewed = { prompt: Prompt; hash: string; model: string };

function comparisonFor(
  s: { runs: Run[]; inferences: Record<string, Inference>; prompts: Prompt[]; promptHashes: Record<string, string>; baselineKey: string | null },
  viewed: Viewed,
  working: Comparison["working"],
  peeking: boolean,
  train: Analysis | null,
  datasets: Dataset[],
): Comparison {
  const vKey = versionKey({ promptHash: viewed.hash, model: viewed.model });
  const hashes = new Set(datasets.map((d) => d.hash));
  const candidates = s.runs.filter((r) => hashes.has(r.datasetHash) && r.targetKey === viewed.prompt.targetKey && r.status !== "running" && Object.keys(r.results).length > 0 && versionKey(r) !== vKey);
  const complete = (r: Run) => {
    const d = datasets.find((x) => x.hash === r.datasetHash);
    return !!d && isCompleteRun(r, d, s.inferences);
  };
  // Order: versions as offered against the training run (scored just before it first), then any others.
  const order: string[] = [];
  if (train) for (const b of pickBaselines(candidates.filter((r) => r.datasetHash === train.dataset.hash), train.run, complete)) order.push(versionKey(b.run));
  for (const r of [...candidates].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) if (!order.includes(versionKey(r))) order.push(versionKey(r));
  const options: VersionOption[] = order.map((key) => {
    const runs = candidates.filter((r) => versionKey(r) === key).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const newest = runs[0];
    const snapshot = runs.find((r) => r.promptSnapshot)?.promptSnapshot ?? s.prompts.find((p) => s.promptHashes[p.id] === newest.promptHash);
    return { key, promptHash: newest.promptHash, model: newest.model, promptName: snapshot?.name ?? newest.promptName, startedAt: newest.startedAt, complete: runs.some(complete), snapshot };
  });
  const wanted = peeking ? working?.key : s.baselineKey;
  const baseline = options.find((o) => o.key === wanted) ?? (peeking ? null : (options[0] ?? null));
  return { options, baseline, peeking, working };
}

function attachBaseline(a: Analysis | null, key: string | undefined, s: { runs: Run[]; inferences: Record<string, Inference> }, mapping: ClassMapping, threshold: number): Analysis | null {
  if (!a || !key) return a;
  const runs = s.runs.filter((r) => r.datasetHash === a.dataset.hash && r.targetKey === a.run.targetKey && r.status !== "running" && Object.keys(r.results).length > 0 && versionKey(r) === key);
  const pick = pickBaselines(runs, a.run, (r) => isCompleteRun(r, a.dataset, s.inferences))[0];
  if (!pick) return a;
  const rows = scoreRun(a.dataset, pick.run, s.inferences, a.target, mapping, a.view, threshold);
  const paired = pairedRows(rows, a.rows);
  return {
    ...a,
    baseline: {
      run: pick.run,
      complete: pick.complete,
      rows,
      before: computeMetrics(paired.before, a.target, mapping, a.view),
      after: computeMetrics(paired.after, a.target, mapping, a.view),
      paired: paired.after.length,
      scored: a.metrics.n,
    },
  };
}

/**
 * Both panels' analyses. The threshold is fitted on the training run and applied unchanged to the test run. Each
 * panel also carries the run of the comparison version, so every delta compares the same two versions.
 */
export function useExperiment(): {
  train: Analysis | null;
  test: Analysis | null;
  threshold: ThresholdInfo;
  prompt: Prompt | undefined;
  promptHash: string | undefined;
  model: string;
  target: Target | null;
  mapping: ClassMapping;
  focus: string;
  comparison: Comparison | null;
} {
  const s = useStore(
    useShallow((st) => ({
      datasets: st.datasets,
      prompts: st.prompts,
      runs: st.runs,
      inferences: st.inferences,
      promptHashes: st.promptHashes,
      selection: st.selection,
      model: activeModel(st),
      mappings: st.mappings,
      focus: st.focus,
      thresholds: st.thresholds,
      baselineKey: st.baselineKey,
      peek: st.peek,
    })),
  );
  return useMemo(() => {
    const selected = s.prompts.find((p) => p.id === s.selection.prompt);
    const selectedHash = selected ? s.promptHashes[selected.id] : undefined;
    const working = selected && selectedHash ? { key: versionKey({ promptHash: selectedHash, model: s.model }), promptName: selected.name, promptHash: selectedHash, model: s.model } : null;
    // While peeking, everything below is computed for the comparison version instead of the working one.
    const prompt = s.peek?.prompt ?? selected;
    const hash = s.peek?.hash ?? selectedHash;
    const model = s.peek?.model ?? s.model;
    const trainDs = s.datasets.find((d) => d.id === s.selection.train);
    const testDs = s.datasets.find((d) => d.id === s.selection.test);
    const mapping = (prompt && s.mappings[prompt.targetKey]) || {};
    const target = prompt && (trainDs ?? testDs) ? targetFor((trainDs ?? testDs) as Dataset, prompt) : null;
    const focus = target && target.type !== "boolean" && (s.focus === ALL || groupsFor(target, mapping).includes(s.focus)) ? s.focus : ALL;
    const view = target ? viewFor(target, focus) : null;
    const defaultT = view?.mode === "multiclass" ? 0 : 0.5;
    let threshold: ThresholdInfo = { value: defaultT, fitted: null, overridden: false, source: "default", trainRunId: null };

    let train: Analysis | null = null;
    const trainPick = pickRun(s.runs, trainDs, prompt, hash, model, s.inferences);
    if (trainDs && prompt && trainPick && target && targetFor(trainDs, prompt)) {
      const first = analyse("train", trainDs, trainPick, prompt, s.inferences, mapping, focus, defaultT, target);
      const fitted = first.view.mode === "binary" ? fitThreshold(first.rows) : null;
      const key = `${trainPick.run.id}|${focus}`;
      const manual = s.thresholds[key];
      const value = manual ?? fitted ?? defaultT;
      threshold = { value, fitted, overridden: manual != null, source: manual != null ? "manual" : fitted != null ? "fitted" : "default", trainRunId: trainPick.run.id };
      train = value === defaultT ? first : analyse("train", trainDs, trainPick, prompt, s.inferences, mapping, focus, value, target);
    }
    let test: Analysis | null = null;
    const testPick = pickRun(s.runs, testDs, prompt, hash, model, s.inferences);
    if (testDs && prompt && testPick && target && targetFor(testDs, prompt)) {
      test = analyse("test", testDs, testPick, prompt, s.inferences, mapping, focus, threshold.value, target);
    }
    const datasets = [trainDs, testDs].filter(Boolean) as Dataset[];
    const comparison = prompt && hash ? comparisonFor(s, { prompt, hash, model }, working, !!s.peek, train, datasets) : null;
    const key = comparison?.baseline?.key;
    train = attachBaseline(train, key, s, mapping, threshold.value);
    test = attachBaseline(test, key, s, mapping, threshold.value);
    return { train, test, threshold, prompt, promptHash: hash, model, target, mapping, focus, comparison };
  }, [s]);
}
