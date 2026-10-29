import type { ClassMapping, LabelValue } from "./types";

/**
 * Scoring. Pure functions: everything the charts, tiles and filters show is derived here from the ground truth,
 * the model's class probabilities, the class mapping and the threshold.
 *
 * Boolean target: score = P(yes), predicted yes when score >= threshold.
 * Categorical target, "all classes" view: predicted class = argmax; score = the top class's probability; the
 * threshold is a review cutoff (answers below it are flagged low-confidence but still scored).
 * Categorical target, one-class view: one-vs-rest on P(class), predicted positive when score >= threshold.
 */

export const ALL = "__all__";
export type Outcome = "TP" | "FP" | "FN" | "TN" | "correct" | "incorrect";
export type RowStatus = "scored" | "excluded" | "unlabeled" | "error" | "pending";

export type ScoreInput = {
  id: string;
  gt: LabelValue;
  /** Raw class probabilities from the model, or null when there is no answer yet. */
  probabilities: Record<string, number> | null;
  error?: string;
};

export type Target = { type: "boolean" } | { type: "categorical"; classes: string[] };

export type Row = {
  id: string;
  status: RowStatus;
  gt: string | null;
  pred: string | null;
  probs: Record<string, number>;
  score: number | null;
  /** Binary views only: the item is a positive case / was called positive. */
  gtPositive?: boolean;
  predPositive?: boolean;
  outcome: Outcome | null;
  lowConfidence: boolean;
};

export type View = { mode: "binary"; positive: string; label: string } | { mode: "multiclass" };

export function groupsFor(target: Target, mapping: ClassMapping): string[] {
  if (target.type === "boolean") return ["true", "false"];
  const groups: string[] = [];
  for (const c of target.classes) {
    const g = mapping[c] === undefined ? c : mapping[c];
    if (g != null && !groups.includes(g)) groups.push(g);
  }
  return groups;
}

export function viewFor(target: Target, focus: string): View {
  if (target.type === "boolean") return { mode: "binary", positive: "true", label: "yes" };
  if (focus === ALL) return { mode: "multiclass" };
  return { mode: "binary", positive: focus, label: focus };
}

/** Sums probabilities into the mapped groups and renormalizes over the classes that are still included. */
export function mapProbabilities(target: Target, mapping: ClassMapping, raw: Record<string, number>): Record<string, number> {
  if (target.type === "boolean") {
    const p = clamp01(raw.true ?? 1 - (raw.false ?? 0.5));
    return { true: p, false: 1 - p };
  }
  const groups = groupsFor(target, mapping);
  const out: Record<string, number> = Object.fromEntries(groups.map((g) => [g, 0]));
  let total = 0;
  for (const c of target.classes) {
    const g = mapping[c] === undefined ? c : mapping[c];
    if (g == null) continue;
    const p = Math.max(0, raw[c] ?? 0);
    out[g] += p;
    total += p;
  }
  for (const g of groups) out[g] = total > 0 ? out[g] / total : 1 / groups.length;
  return out;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
}

function mappedGt(target: Target, mapping: ClassMapping, gt: LabelValue): { gt: string | null; excluded: boolean } {
  if (gt == null) return { gt: null, excluded: false };
  if (target.type === "boolean") return { gt: gt === true || gt === "true" ? "true" : "false", excluded: false };
  const c = String(gt);
  const g = mapping[c] === undefined ? c : mapping[c];
  return g == null ? { gt: null, excluded: true } : { gt: g, excluded: false };
}

function argmax(probs: Record<string, number>, order: string[]): string {
  let best = order[0];
  for (const g of order) if ((probs[g] ?? 0) > (probs[best] ?? 0)) best = g;
  return best;
}

export function scoreRows(inputs: ScoreInput[], target: Target, mapping: ClassMapping, view: View, threshold: number): Row[] {
  const groups = groupsFor(target, mapping);
  return inputs.map((input) => {
    const { gt, excluded } = mappedGt(target, mapping, input.gt);
    const base: Row = { id: input.id, status: "pending", gt, pred: null, probs: {}, score: null, outcome: null, lowConfidence: false };
    if (excluded) return { ...base, status: "excluded" };
    if (input.error) return { ...base, status: "error" };
    if (!input.probabilities) return { ...base, status: gt == null ? "unlabeled" : "pending" };
    const probs = mapProbabilities(target, mapping, input.probabilities);
    const top = argmax(probs, groups);
    if (view.mode === "binary") {
      const score = probs[view.positive] ?? 0;
      const predPositive = score >= threshold;
      const pred = target.type === "boolean" ? (predPositive ? "true" : "false") : top;
      if (gt == null) return { ...base, status: "unlabeled", probs, score, pred, predPositive };
      const gtPositive = gt === view.positive;
      const outcome: Outcome = gtPositive ? (predPositive ? "TP" : "FN") : predPositive ? "FP" : "TN";
      return { ...base, status: "scored", probs, score, pred, predPositive, gtPositive, outcome };
    }
    const score = probs[top];
    if (gt == null) return { ...base, status: "unlabeled", probs, score, pred: top };
    return { ...base, status: "scored", probs, score, pred: top, outcome: top === gt ? "correct" : "incorrect", lowConfidence: score < threshold };
  });
}

export type ClassStats = { name: string; support: number; predicted: number; tp: number; precision: number | null; recall: number | null };

export type Metrics = {
  n: number;
  pending: number;
  errors: number;
  excluded: number;
  unlabeled: number;
  accuracy: number | null;
  balancedAccuracy: number | null;
  /** Binary views. */
  precision?: number | null;
  recall?: number | null;
  specificity?: number | null;
  f1?: number | null;
  counts?: { TP: number; FP: number; FN: number; TN: number };
  /** Multiclass view: answers at or above the review cutoff. */
  coverage?: number | null;
  accuracyAboveCutoff?: number | null;
  perClass: ClassStats[];
};

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function computeMetrics(rows: Row[], target: Target, mapping: ClassMapping, view: View): Metrics {
  const scored = rows.filter((r) => r.status === "scored");
  const base = {
    n: scored.length,
    pending: rows.filter((r) => r.status === "pending").length,
    errors: rows.filter((r) => r.status === "error").length,
    excluded: rows.filter((r) => r.status === "excluded").length,
    unlabeled: rows.filter((r) => r.status === "unlabeled").length,
  };
  const groups = groupsFor(target, mapping);
  const perClass: ClassStats[] = groups.map((g) => {
    const support = scored.filter((r) => r.gt === g).length;
    const predicted = scored.filter((r) => r.pred === g).length;
    const tp = scored.filter((r) => r.gt === g && r.pred === g).length;
    return { name: g, support, predicted, tp, precision: ratio(tp, predicted), recall: ratio(tp, support) };
  });
  if (view.mode === "binary") {
    const c = { TP: 0, FP: 0, FN: 0, TN: 0 };
    for (const r of scored) c[r.outcome as "TP"]++;
    const recall = ratio(c.TP, c.TP + c.FN);
    const specificity = ratio(c.TN, c.TN + c.FP);
    const precision = ratio(c.TP, c.TP + c.FP);
    const ba = recall != null && specificity != null ? (recall + specificity) / 2 : (recall ?? specificity);
    const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
    return { ...base, accuracy: ratio(c.TP + c.TN, scored.length), balancedAccuracy: ba, precision, recall, specificity, f1, counts: c, perClass };
  }
  const recalls = perClass.filter((p) => p.support > 0).map((p) => p.recall as number);
  const confident = scored.filter((r) => !r.lowConfidence);
  return {
    ...base,
    accuracy: ratio(scored.filter((r) => r.outcome === "correct").length, scored.length),
    balancedAccuracy: recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : null,
    coverage: ratio(confident.length, scored.length),
    accuracyAboveCutoff: ratio(confident.filter((r) => r.outcome === "correct").length, confident.length),
    perClass,
  };
}

/** Rows: actual class. Columns: predicted class. Binary views use [positive, negative]. */
export function confusionMatrix(rows: Row[], target: Target, mapping: ClassMapping, view: View): { labels: string[]; keys: string[]; cells: number[][] } {
  const scored = rows.filter((r) => r.status === "scored");
  if (view.mode === "binary") {
    const labels = target.type === "boolean" ? ["yes", "no"] : [view.positive, `not ${view.positive}`];
    const keys = ["pos", "neg"];
    const cells = [
      [scored.filter((r) => r.gtPositive && r.predPositive).length, scored.filter((r) => r.gtPositive && !r.predPositive).length],
      [scored.filter((r) => !r.gtPositive && r.predPositive).length, scored.filter((r) => !r.gtPositive && !r.predPositive).length],
    ];
    return { labels, keys, cells };
  }
  const groups = groupsFor(target, mapping);
  return { labels: groups, keys: groups, cells: groups.map((a) => groups.map((p) => scored.filter((r) => r.gt === a && r.pred === p).length)) };
}

/** Whether a row falls in a confusion-matrix cell (keys from confusionMatrix). */
export function inCell(row: Row, view: View, actual: string, predicted: string): boolean {
  if (row.status !== "scored") return false;
  if (view.mode === "binary") return (actual === "pos") === !!row.gtPositive && (predicted === "pos") === !!row.predPositive;
  return row.gt === actual && row.pred === predicted;
}

export const BIN_COUNT = 20;

/** Score histogram, stacked by positive/negative (binary views) or correct/incorrect (multiclass view). */
export function histogram(rows: Row[], view: View, bins = BIN_COUNT): { edges: number[]; series: { key: string; label: string; counts: number[] }[] } {
  const edges = Array.from({ length: bins + 1 }, (_, i) => i / bins);
  const scored = rows.filter((r) => r.status === "scored" && r.score != null);
  const bin = (s: number) => Math.min(bins - 1, Math.floor(s * bins));
  const count = (pred: (r: Row) => boolean) => {
    const counts = new Array(bins).fill(0);
    for (const r of scored) if (pred(r)) counts[bin(r.score as number)]++;
    return counts;
  };
  if (view.mode === "binary") {
    return {
      edges,
      series: [
        { key: "neg", label: view.label === "yes" ? "Actually no" : `Actually not ${view.label}`, counts: count((r) => !r.gtPositive) },
        { key: "pos", label: view.label === "yes" ? "Actually yes" : `Actually ${view.label}`, counts: count((r) => !!r.gtPositive) },
      ],
    };
  }
  return {
    edges,
    series: [
      { key: "incorrect", label: "Wrong class", counts: count((r) => r.outcome === "incorrect") },
      { key: "correct", label: "Right class", counts: count((r) => r.outcome === "correct") },
    ],
  };
}

export type PrPoint = { threshold: number; precision: number; recall: number };
export type PrCurve = { key: string; label: string; points: PrPoint[]; ap: number | null; positives: number };

/** Precision-recall curve from (score, isPositive) pairs: one point per distinct score, highest first. */
export function prCurve(pairs: { score: number; positive: boolean }[]): { points: PrPoint[]; ap: number | null; positives: number } {
  const positives = pairs.filter((p) => p.positive).length;
  if (!pairs.length || !positives) return { points: [], ap: null, positives };
  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  const points: PrPoint[] = [];
  let tp = 0;
  let fp = 0;
  let ap = 0;
  let prevRecall = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].positive) tp++;
    else fp++;
    if (i + 1 < sorted.length && sorted[i + 1].score === sorted[i].score) continue;
    const recall = tp / positives;
    const precision = tp / (tp + fp);
    ap += (recall - prevRecall) * precision;
    prevRecall = recall;
    points.push({ threshold: sorted[i].score, precision, recall });
  }
  return { points, ap, positives };
}

/** The binary curve, or one-vs-rest curves per class plus the micro-average over all classes. */
export function prCurves(rows: Row[], target: Target, mapping: ClassMapping, view: View): PrCurve[] {
  const scored = rows.filter((r) => r.status === "scored");
  if (target.type === "boolean") {
    const c = prCurve(scored.map((r) => ({ score: r.probs.true, positive: r.gt === "true" })));
    return [{ key: "true", label: "yes", ...c }];
  }
  const groups = groupsFor(target, mapping);
  const perClass = groups.map((g) => ({ key: g, label: g, ...prCurve(scored.map((r) => ({ score: r.probs[g] ?? 0, positive: r.gt === g }))) }));
  const micro = prCurve(scored.flatMap((r) => groups.map((g) => ({ score: r.probs[g] ?? 0, positive: r.gt === g }))));
  if (view.mode === "binary") return perClass;
  return [{ key: ALL, label: "All classes (micro)", ...micro }, ...perClass];
}

/** The threshold with the best balanced accuracy on these rows; ties go to the one closest to 0.5. */
export function fitThreshold(rows: Row[]): number | null {
  const pts = rows.filter((r) => r.status === "scored" && r.score != null).map((r) => ({ s: r.score as number, pos: !!r.gtPositive }));
  const pos = pts.filter((p) => p.pos).length;
  const neg = pts.length - pos;
  if (!pos || !neg) return null;
  const scores = [...new Set(pts.map((p) => p.s))].sort((a, b) => a - b);
  const candidates = new Set<number>([0.5]);
  for (let i = 0; i < scores.length; i++) {
    const next = i + 1 < scores.length ? scores[i + 1] : 1;
    candidates.add(round4((scores[i] + next) / 2));
    candidates.add(round4(scores[i]));
  }
  let best = 0.5;
  let bestBa = -1;
  for (const t of candidates) {
    let tp = 0;
    let tn = 0;
    for (const p of pts) {
      if (p.pos && p.s >= t) tp++;
      if (!p.pos && p.s < t) tn++;
    }
    const ba = (tp / pos + tn / neg) / 2;
    if (ba > bestBa + 1e-12 || (Math.abs(ba - bestBa) <= 1e-12 && Math.abs(t - 0.5) < Math.abs(best - 0.5))) {
      bestBa = ba;
      best = t;
    }
  }
  return best;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
