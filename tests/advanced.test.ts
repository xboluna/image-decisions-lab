import { describe, expect, it } from "vitest";
import { auroc, computeAdvanced, crossValidatedBa, macroBalancedAccuracy, mixedHash, scoreRows, stratifiedHalves, viewFor, type Row, type Target } from "@/lib/metrics";

describe("auroc", () => {
  it("is 1 for a perfect ranking, 0.5 for all ties, 0 when reversed", () => {
    const perfect = [0.9, 0.8, 0.2, 0.1].map((s, i) => ({ score: s, positive: i < 2 }));
    expect(auroc(perfect)).toBe(1);
    expect(auroc([0.5, 0.5, 0.5].map((s, i) => ({ score: s, positive: i === 0 })))).toBe(0.5);
    expect(auroc(perfect.map((p) => ({ ...p, positive: !p.positive })))).toBe(0);
  });
  it("matches the pairwise definition", () => {
    const pairs = [0.9, 0.7, 0.7, 0.4, 0.3, 0.3, 0.1].map((score, i) => ({ score, positive: [0, 2, 4].includes(i) }));
    const pos = pairs.filter((p) => p.positive);
    const neg = pairs.filter((p) => !p.positive);
    let wins = 0;
    for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
    expect(auroc(pairs)).toBeCloseTo(wins / (pos.length * neg.length));
  });
  it("needs both classes", () => {
    expect(auroc([{ score: 0.4, positive: true }])).toBeNull();
  });
});

describe("cross-validated balanced accuracy", () => {
  const bool: Target = { type: "boolean" };
  const view = viewFor(bool, "__all__");
  it("mixes every bit of the id into the hash", () => {
    // ids that differ only in characters of equal parity used to land in the same half
    const highBits = ["a0", "a2", "a4", "a6", "a8", "c0", "c2"].map((id) => mixedHash(id) >>> 31);
    expect(new Set(highBits).size).toBe(2);
    expect(mixedHash("x.jpg")).toBe(mixedHash("x.jpg"));
  });
  it("splits each class evenly, however images are named", () => {
    // class-prefixed names: every positive starts with "pos_", every negative with "neg_"
    const rows = scoreRows(
      Array.from({ length: 30 }, (_, i) => ({ id: `${i < 12 ? "pos" : "neg"}_${i * 2}.jpg`, gt: i < 12, probabilities: { true: 0.5, false: 0.5 } })),
      bool,
      {},
      view,
      0.5,
    );
    const [a, b] = stratifiedHalves(rows);
    expect(a.filter((r) => r.gtPositive).length).toBe(6);
    expect(b.filter((r) => r.gtPositive).length).toBe(6);
    expect(a.length + b.length).toBe(30);
    expect(stratifiedHalves(rows)[0].map((r) => r.id)).toEqual(a.map((r) => r.id));
  });
  it("cross-validates class-prefixed names instead of giving up", () => {
    const rows = scoreRows(
      Array.from({ length: 20 }, (_, i) => ({ id: `${i % 2 ? "neg" : "pos"}_${i}.jpg`, gt: i % 2 === 0, probabilities: { true: i % 2 === 0 ? 0.7 : 0.3, false: 0 } })),
      bool,
      {},
      view,
      0.5,
    );
    expect(crossValidatedBa(rows)).toBe(1);
  });
  it("equals in-sample balanced accuracy on a separable set and drops when the fit overfits", () => {
    const sep = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, gt: i % 2 === 0, probabilities: { true: i % 2 === 0 ? 0.8 : 0.2, false: 0 } }));
    expect(crossValidatedBa(scoreRows(sep, bool, {}, view, 0.5))).toBe(1);
    // random scores: in-sample threshold fitting looks better than chance, held-out halves should not
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const noise = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, gt: i % 2 === 0, probabilities: { true: rand(), false: 0 } }));
    const cv = crossValidatedBa(scoreRows(noise, bool, {}, view, 0.5))!;
    expect(cv).toBeLessThan(0.7);
  });
});

describe("macro balanced accuracy", () => {
  const row = (gt: string, pred: string): Row => ({ id: Math.random().toString(), status: "scored", gt, pred, probs: {}, score: 1, outcome: gt === pred ? "correct" : "incorrect", lowConfidence: false });
  it("averages one-vs-rest balanced accuracy over classes with enough positives", () => {
    const rows = [row("a", "a"), row("a", "a"), row("a", "b"), row("b", "b"), row("b", "b"), row("b", "b"), row("c", "a")];
    const { value, classes } = macroBalancedAccuracy(rows, ["a", "b", "c"], 3);
    // a: recall 2/3, spec 3/4 ; b: recall 1, spec 3/4 ; c skipped (1 positive)
    expect(classes).toBe(2);
    expect(value).toBeCloseTo(((2 / 3 + 3 / 4) / 2 + (1 + 3 / 4) / 2) / 2);
  });
  it("is computed for every view", () => {
    const cat: Target = { type: "categorical", classes: ["1", "2"] };
    const rows = scoreRows(
      Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, gt: i < 4 ? "1" : "2", probabilities: { "1": i < 5 ? 0.9 : 0.1, "2": i < 5 ? 0.1 : 0.9 } })),
      cat,
      {},
      viewFor(cat, "__all__"),
      0,
    );
    const m = computeAdvanced(rows, cat, {}, viewFor(cat, "__all__"));
    expect(m.auroc).toBeGreaterThan(0.8);
    expect(m.crossValidatedBa).toBeNull();
    expect(m.macroBa).toBeCloseTo(0.875);
  });
});
