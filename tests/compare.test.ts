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
