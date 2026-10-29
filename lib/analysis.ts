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
import { useStore, type Role } from "./store";
import type { ClassMapping, Dataset, Inference, Prompt, Run } from "./types";

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
};

export type ThresholdInfo = {
  value: number;
  fitted: number | null;
  overridden: boolean;
  /** "fitted" from the training run, "manual" when moved by hand, "default" when there is no training run. */
  source: "fitted" | "manual" | "default";
  trainRunId: string | null;
};

export function pickRun(runs: Run[], dataset: Dataset | undefined, prompt: Pick<Prompt, "targetKey"> | undefined, hash: string | undefined, model: string): { run: Run; stale: boolean } | null {
  if (!dataset || !prompt) return null;
  const sameData = runs.filter((r) => r.datasetHash === dataset.hash && r.targetKey === prompt.targetKey && Object.keys(r.results).length + (r.status === "running" ? 1 : 0) > 0);
  const exact = sameData.filter((r) => r.promptHash === hash && r.model === model);
  if (exact.length) return { run: exact[exact.length - 1], stale: false };
  if (sameData.length) return { run: sameData[sameData.length - 1], stale: true };
  return null;
}

export function targetFor(dataset: Dataset, prompt: Prompt): Target | null {
  const s = dataset.schema.find((x) => x.key === prompt.targetKey);
  if (!s || s.type !== prompt.targetType) return null;
  return s.type === "boolean" ? { type: "boolean" } : { type: "categorical", classes: s.classes };
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
  };
}

/** Both panels' analyses. The threshold is fitted on the training run and applied unchanged to the test run. */
export function useExperiment(): { train: Analysis | null; test: Analysis | null; threshold: ThresholdInfo; prompt: Prompt | undefined; target: Target | null; mapping: ClassMapping; focus: string } {
  const s = useStore(
    useShallow((st) => ({
      datasets: st.datasets,
      prompts: st.prompts,
      runs: st.runs,
      inferences: st.inferences,
      promptHashes: st.promptHashes,
      selection: st.selection,
      model: st.settings.model,
      mappings: st.mappings,
      focus: st.focus,
      thresholds: st.thresholds,
    })),
  );
  return useMemo(() => {
    const prompt = s.prompts.find((p) => p.id === s.selection.prompt);
    const hash = prompt ? s.promptHashes[prompt.id] : undefined;
    const trainDs = s.datasets.find((d) => d.id === s.selection.train);
    const testDs = s.datasets.find((d) => d.id === s.selection.test);
    const mapping = (prompt && s.mappings[prompt.targetKey]) || {};
    const target = prompt && (trainDs ?? testDs) ? targetFor((trainDs ?? testDs) as Dataset, prompt) : null;
    const focus = target && target.type === "categorical" && (s.focus === ALL || groupsFor(target, mapping).includes(s.focus)) ? s.focus : ALL;
    const view = target ? viewFor(target, focus) : null;
    const defaultT = view?.mode === "multiclass" ? 0 : 0.5;
    let threshold: ThresholdInfo = { value: defaultT, fitted: null, overridden: false, source: "default", trainRunId: null };

    let train: Analysis | null = null;
    const trainPick = pickRun(s.runs, trainDs, prompt, hash, s.model);
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
    const testPick = pickRun(s.runs, testDs, prompt, hash, s.model);
    if (testDs && prompt && testPick && target && targetFor(testDs, prompt)) {
      test = analyse("test", testDs, testPick, prompt, s.inferences, mapping, focus, threshold.value, target);
    }
    return { train, test, threshold, prompt, target, mapping, focus };
  }, [s]);
}
