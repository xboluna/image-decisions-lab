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

/** count: categorical over ordered buckets, scored as categorical plus how far off each answer is (CountMetrics). */
export type Target = { type: "boolean" } | { type: "categorical" | "count"; classes: string[] };

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
  /** Count targets, all-buckets view. */
  count?: CountMetrics;
  perClass: ClassStats[];
};

/**
 * How close count answers are, with buckets as positions 0, 1, 2… (after merges, in bucket order). exact: the most
 * likely bucket is the true one (accuracy). withinOne: it is at most one bucket off. mae: the mean distance from the
 * true bucket to the expected bucket, Σ position × probability, so a hedged answer is partly wrong.
 */
export type CountMetrics = { exact: number | null; withinOne: number | null; mae: number | null };

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
  const accuracy = ratio(scored.filter((r) => r.outcome === "correct").length, scored.length);
  return {
    ...base,
    accuracy,
    balancedAccuracy: recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : null,
    coverage: ratio(confident.length, scored.length),
    accuracyAboveCutoff: ratio(confident.filter((r) => r.outcome === "correct").length, confident.length),
    ...(target.type === "count" ? { count: countMetrics(scored, groups, accuracy) } : {}),
    perClass,
  };
}

export function countMetrics(scored: Row[], groups: string[], exact: number | null): CountMetrics {
  const pos = new Map(groups.map((g, i) => [g, i]));
  let near = 0;
  let distance = 0;
  for (const r of scored) {
    const t = pos.get(r.gt as string) as number;
    if (Math.abs(t - (pos.get(r.pred as string) as number)) <= 1) near++;
    distance += Math.abs(t - expectedBucket(r.probs, groups));
  }
  return { exact, withinOne: ratio(near, scored.length), mae: scored.length ? distance / scored.length : null };
}

/** Σ position × probability over the buckets (probabilities are already normalized over the included buckets). */
export function expectedBucket(probs: Record<string, number>, groups: string[]): number {
  return groups.reduce((s, g, i) => s + i * (probs[g] ?? 0), 0);
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

/**
 * Robust metrics, shown when "Advanced metrics" is on.
 *
 * AUROC: the chance a random positive scores above a random negative (Mann-Whitney; ties count half). It ignores
 * the threshold entirely. In the all-classes view it is averaged one-vs-rest over classes with both cases.
 *
 * Cross-validated balanced accuracy: the threshold fitted on one half of the images, applied to the other half,
 * and the other way round. It shows how much the fitted threshold
 * flatters the training set. The halves are stratified by class (see stratifiedHalves). Binary views only, since
 * the all-classes view fits no threshold.
 *
 * Macro balanced accuracy: each class scored one-vs-rest (recall and specificity of "predicted this class"),
 * averaged over classes with at least `minPositives` images, so rare classes with a handful of images do not swing it.
 */
export type AdvancedMetrics = {
  auroc: number | null;
  crossValidatedBa: number | null;
  macroBa: number | null;
  macroClasses: number;
};

export function auroc(pairs: { score: number; positive: boolean }[]): number | null {
  const pos = pairs.filter((p) => p.positive).map((p) => p.score);
  const neg = pairs.filter((p) => !p.positive).map((p) => p.score);
  if (!pos.length || !neg.length) return null;
  // Rank-sum form of Mann-Whitney U, with average ranks for ties: O(n log n).
  const all = pairs.map((p) => ({ s: p.score, pos: p.positive })).sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k].pos) rankSumPos += avgRank;
    i = j + 1;
  }
  const u = rankSumPos - (pos.length * (pos.length + 1)) / 2;
  return u / (pos.length * neg.length);
}

/** A stable, well-mixed 32-bit hash of an id: FNV-1a, then MurmurHash3's finalizer so every bit depends on every character. */
export function mixedHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Splits rows into two fixed halves, stratified by class: within positives and within negatives, rows are ordered
 * by a mixed hash of their id and dealt alternately. Each half gets about half of each class, however the images
 * are named, and the split never changes for the same images.
 */
export function stratifiedHalves(rows: Row[]): [Row[], Row[]] {
  const halves: [Row[], Row[]] = [[], []];
  for (const group of [rows.filter((r) => r.gtPositive), rows.filter((r) => !r.gtPositive)]) {
    const ordered = [...group].sort((x, y) => mixedHash(x.id) - mixedHash(y.id) || (x.id < y.id ? -1 : 1));
    ordered.forEach((r, i) => halves[i % 2].push(r));
  }
  return halves;
}

function balancedAccuracyAt(rows: Row[], threshold: number): { tp: number; fn: number; tn: number; fp: number } {
  const c = { tp: 0, fn: 0, tn: 0, fp: 0 };
  for (const r of rows) {
    const call = (r.score as number) >= threshold;
    if (r.gtPositive) call ? c.tp++ : c.fn++;
    else call ? c.fp++ : c.tn++;
  }
  return c;
}

export function crossValidatedBa(rows: Row[]): number | null {
  const scored = rows.filter((r) => r.status === "scored" && r.score != null && r.gtPositive !== undefined);
  const halves = stratifiedHalves(scored);
  const total = { tp: 0, fn: 0, tn: 0, fp: 0 };
  for (const [fit, score] of [
    [halves[0], halves[1]],
    [halves[1], halves[0]],
  ]) {
    const t = fitThreshold(fit);
    if (t == null) return null; // a half without both positives and negatives cannot fit a threshold
    const c = balancedAccuracyAt(score, t);
    total.tp += c.tp;
    total.fn += c.fn;
    total.tn += c.tn;
    total.fp += c.fp;
  }
  const pos = total.tp + total.fn;
  const neg = total.tn + total.fp;
  if (!pos || !neg) return null;
  return (total.tp / pos + total.tn / neg) / 2;
}

export function macroBalancedAccuracy(rows: Row[], groups: string[], minPositives = 3): { value: number | null; classes: number } {
  const scored = rows.filter((r) => r.status === "scored" && r.pred != null && r.gt != null);
  const bas: number[] = [];
  for (const g of groups) {
    const pos = scored.filter((r) => r.gt === g);
    const neg = scored.filter((r) => r.gt !== g);
    if (pos.length < minPositives || !neg.length) continue;
    const recall = pos.filter((r) => r.pred === g).length / pos.length;
    const specificity = neg.filter((r) => r.pred !== g).length / neg.length;
    bas.push((recall + specificity) / 2);
  }
  return { value: bas.length ? bas.reduce((a, b) => a + b, 0) / bas.length : null, classes: bas.length };
}

export function computeAdvanced(rows: Row[], target: Target, mapping: ClassMapping, view: View, minPositives = 3): AdvancedMetrics {
  const scored = rows.filter((r) => r.status === "scored");
  const groups = groupsFor(target, mapping);
  let au: number | null;
  if (view.mode === "binary") {
    au = auroc(scored.filter((r) => r.score != null).map((r) => ({ score: r.score as number, positive: !!r.gtPositive })));
  } else {
    const per = groups.map((g) => auroc(scored.map((r) => ({ score: r.probs[g] ?? 0, positive: r.gt === g })))).filter((x): x is number => x != null);
    au = per.length ? per.reduce((a, b) => a + b, 0) / per.length : null;
  }
  // In a binary view the prediction is the threshold call, so score the classes that call distinguishes.
  const macroRows =
    view.mode === "binary"
      ? scored.map((r) => ({ ...r, gt: r.gtPositive ? "pos" : "neg", pred: r.predPositive ? "pos" : "neg" }))
      : scored;
  const macro = macroBalancedAccuracy(macroRows, view.mode === "binary" ? ["pos", "neg"] : groups, minPositives);
  return { auroc: au, crossValidatedBa: view.mode === "binary" ? crossValidatedBa(scored) : null, macroBa: macro.value, macroClasses: macro.classes };
}
