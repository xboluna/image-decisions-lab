import { describe, expect, it } from "vitest";
import { compareRows } from "@/lib/compare";
import { scoreRows, viewFor, type ScoreInput, type Target } from "@/lib/metrics";

const cat: Target = { type: "categorical", classes: ["1", "2"] };
const view = viewFor(cat, "__all__");
const run = (p: Record<string, number>) =>
  scoreRows(
    Object.entries(p).map(([id, p2]): ScoreInput => ({ id, gt: id.startsWith("two") ? "2" : "1", probabilities: { "1": 1 - p2, "2": p2 } })),
    cat,
    {},
    view,
    0,
  );

describe("compareRows", () => {
  it("finds images that were fixed and broken", () => {
    const before = run({ two_a: 0.3, two_b: 0.9, one_a: 0.2, one_b: 0.8 });
    const after = run({ two_a: 0.9, two_b: 0.4, one_a: 0.1, one_b: 0.7 });
    const c = compareRows(before, after);
    expect(c.fixed.map((x) => x.id)).toEqual(["two_a"]);
    expect(c.broke.map((x) => x.id)).toEqual(["two_b"]);
    expect(c.stillRight).toBe(1);
    expect(c.stillWrong).toBe(1);
  });
  it("skips images scored in only one run", () => {
    const before = scoreRows([{ id: "two_a", gt: "2", probabilities: null, error: "timeout" }], cat, {}, view, 0);
    const after = run({ two_a: 0.9 });
    const c = compareRows(before, after);
    expect(c.fixed).toHaveLength(0);
    expect(c.notComparable).toBe(1);
  });
});

import { computeMetrics } from "@/lib/metrics";
import { pairedRows, pickBaselines } from "@/lib/compare";

describe("pickBaselines", () => {
  const run = (id: string, promptHash: string, startedAt: string, complete = true) => ({ id, promptHash, model: "m", startedAt, complete });
  const current = run("now", "B", "2026-10-29T12:00");
  it("prefers the newest complete run of a version over a newer partial one", () => {
    const full = run("full", "A", "2026-10-29T10:00");
    const cancelled = run("cancelled", "A", "2026-10-29T11:00", false);
    const picks = pickBaselines([full, cancelled, current], current, (r) => r.complete);
    expect(picks).toEqual([{ run: full, complete: true }]);
  });
  it("falls back to a partial run, flagged, when a version has no complete run", () => {
    const partial = run("partial", "A", "2026-10-29T11:00", false);
    expect(pickBaselines([partial, current], current, (r) => r.complete)).toEqual([{ run: partial, complete: false }]);
  });
  it("offers each other version once, the one scored just before first, never the current version", () => {
    const older = run("older", "A", "2026-10-29T09:00");
    const prev = run("prev", "C", "2026-10-29T11:00");
    const sameVersion = run("same", "B", "2026-10-29T08:00");
    const later = run("later", "D", "2026-10-29T13:00");
    expect(pickBaselines([older, prev, sameVersion, later, current], current, () => true).map((p) => p.run.id)).toEqual(["prev", "older", "later"]);
  });
});

describe("pairedRows", () => {
  it("computes both sides' balanced accuracy on the same images", () => {
    // The baseline only finished the images it got right; unpaired, it would look perfect.
    const before = scoreRows(
      [
        { id: "two_a", gt: "2", probabilities: { "1": 0.1, "2": 0.9 } },
        { id: "one_a", gt: "1", probabilities: null },
        { id: "one_b", gt: "1", probabilities: null },
      ],
      cat,
      {},
      view,
      0,
    );
    const after = run({ two_a: 0.9, one_a: 0.8, one_b: 0.2 });
    const p = pairedRows(before, after);
    expect(p.before.map((r) => r.id)).toEqual(["two_a"]);
    expect(p.after.map((r) => r.id)).toEqual(["two_a"]);
    expect(computeMetrics(p.after, cat, {}, view).balancedAccuracy).toBe(computeMetrics(p.before, cat, {}, view).balancedAccuracy);
  });
});

import { preferredRun } from "@/lib/compare";

describe("preferredRun", () => {
  const r = (id: string, status: string, startedAt: string, complete: boolean) => ({ id, status, startedAt, complete });
  it("shows a run that is still scoring", () => {
    expect(preferredRun([r("done", "done", "1", true), r("live", "running", "2", false)], (x) => x.complete)?.id).toBe("live");
  });
  it("prefers an older complete run over a newer cancelled one", () => {
    expect(preferredRun([r("done", "done", "1", true), r("cancelled", "cancelled", "2", false)], (x) => x.complete)?.id).toBe("done");
  });
  it("falls back to the newest partial run", () => {
    expect(preferredRun([r("a", "failed", "1", false), r("b", "cancelled", "2", false)], (x) => x.complete)?.id).toBe("b");
  });
});
