import { describe, expect, it } from "vitest";
import { ALL, computeMetrics, confusionMatrix, fitThreshold, histogram, mapProbabilities, prCurve, prCurves, scoreRows, viewFor, type ScoreInput, type Target } from "@/lib/metrics";

const bool: Target = { type: "boolean" };
const cat: Target = { type: "categorical", classes: ["left", "center", "right"] };

function boolInputs(pairs: [boolean, number][]): ScoreInput[] {
  return pairs.map(([gt, p], i) => ({ id: `i${i}`, gt, probabilities: { true: p, false: 1 - p } }));
}

describe("binary scoring", () => {
  const inputs = boolInputs([
    [true, 0.9],
    [true, 0.6],
    [true, 0.3],
    [false, 0.4],
    [false, 0.2],
    [false, 0.1],
  ]);
  it("counts outcomes at a threshold", () => {
    const view = viewFor(bool, ALL);
    const rows = scoreRows(inputs, bool, {}, view, 0.5);
    const m = computeMetrics(rows, bool, {}, view);
    expect(m.counts).toEqual({ TP: 2, FN: 1, FP: 0, TN: 3 });
    expect(m.accuracy).toBeCloseTo(5 / 6);
    expect(m.balancedAccuracy).toBeCloseTo((2 / 3 + 1) / 2);
    expect(m.precision).toBe(1);
  });
  it("fits the threshold that maximises balanced accuracy", () => {
    const more = boolInputs([[true, 0.9], [true, 0.6], [true, 0.3], [true, 0.25], [false, 0.4], [false, 0.2], [false, 0.1]]);
    const rows = scoreRows(more, bool, {}, viewFor(bool, ALL), 0.5);
    const t = fitThreshold(rows)!;
    expect(t).toBe(0.25);
    const m = computeMetrics(scoreRows(more, bool, {}, viewFor(bool, ALL), t), bool, {}, viewFor(bool, ALL));
    expect(m.counts).toEqual({ TP: 4, FN: 0, FP: 1, TN: 2 });
  });
  it("returns null when only one class is present", () => {
    const rows = scoreRows(boolInputs([[true, 0.9]]), bool, {}, viewFor(bool, ALL), 0.5);
    expect(fitThreshold(rows)).toBeNull();
  });
  it("builds a 2x2 confusion matrix and a stacked histogram", () => {
    const view = viewFor(bool, ALL);
    const rows = scoreRows(inputs, bool, {}, view, 0.5);
    expect(confusionMatrix(rows, bool, {}, view).cells).toEqual([
      [2, 1],
      [0, 3],
    ]);
    const h = histogram(rows, view);
    expect(h.series.find((s) => s.key === "pos")!.counts.reduce((a, b) => a + b)).toBe(3);
  });
});

describe("categorical scoring with class groups", () => {
  const inputs: ScoreInput[] = [
    { id: "a", gt: "left", probabilities: { left: 0.7, center: 0.2, right: 0.1 } },
    { id: "b", gt: "right", probabilities: { left: 0.5, center: 0.1, right: 0.4 } },
    { id: "c", gt: "center", probabilities: { left: 0.1, center: 0.8, right: 0.1 } },
    { id: "d", gt: "center", probabilities: null, error: "timeout" },
  ];
  it("scores argmax with macro recall as balanced accuracy", () => {
    const view = viewFor(cat, ALL);
    const rows = scoreRows(inputs, cat, {}, view, 0);
    const m = computeMetrics(rows, cat, {}, view);
    expect(m.n).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.accuracy).toBeCloseTo(2 / 3);
    expect(m.balancedAccuracy).toBeCloseTo((1 + 1 + 0) / 3);
  });
  it("merges classes by summing probabilities", () => {
    const mapping = { left: "side", right: "side" };
    expect(mapProbabilities(cat, mapping, { left: 0.5, center: 0.1, right: 0.4 })).toEqual({ side: 0.9, center: 0.1 });
    const view = viewFor(cat, ALL);
    const m = computeMetrics(scoreRows(inputs, cat, mapping, view, 0), cat, mapping, view);
    expect(m.accuracy).toBe(1);
    expect(m.perClass.map((p) => p.name)).toEqual(["side", "center"]);
  });
  it("excludes a class and renormalises over the rest", () => {
    const mapping = { right: null };
    const probs = mapProbabilities(cat, mapping, { left: 0.5, center: 0.3, right: 0.2 });
    expect(probs.left).toBeCloseTo(0.625);
    const rows = scoreRows(inputs, cat, mapping, viewFor(cat, ALL), 0);
    expect(rows.find((r) => r.id === "b")!.status).toBe("excluded");
  });
  it("supports a one-vs-rest view of a class", () => {
    const view = viewFor(cat, "left");
    const rows = scoreRows(inputs, cat, {}, view, 0.6);
    const m = computeMetrics(rows, cat, {}, view);
    expect(m.counts).toEqual({ TP: 1, FP: 0, FN: 0, TN: 2 });
  });
  it("builds per-class and micro PR curves", () => {
    const rows = scoreRows(inputs, cat, {}, viewFor(cat, ALL), 0);
    const curves = prCurves(rows, cat, {}, viewFor(cat, ALL));
    expect(curves.map((c) => c.key)).toEqual([ALL, "left", "center", "right"]);
  });
});

describe("prCurve", () => {
  it("computes average precision for a perfect ranking", () => {
    const c = prCurve([
      { score: 0.9, positive: true },
      { score: 0.8, positive: true },
      { score: 0.1, positive: false },
    ]);
    expect(c.ap).toBeCloseTo(1);
    expect(c.points.at(-1)!.recall).toBe(1);
  });
});
