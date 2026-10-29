import type { Row } from "./metrics";

export type Change = "fixed" | "broke";

export type ItemChange = {
  id: string;
  change: Change;
  before: Row;
  after: Row;
};

export type RunComparison = {
  fixed: ItemChange[];
  broke: ItemChange[];
  stillRight: number;
  stillWrong: number;
  /** Items scored in only one of the two runs (pending, failed or excluded in the other). */
  notComparable: number;
  /** Items whose prediction changed although both runs were right or both wrong. */
  otherChanges: number;
};

const isRight = (r: Row) => r.outcome === "TP" || r.outcome === "TN" || r.outcome === "correct";

/** Which images changed outcome between two runs on the same dataset, scored the same way. */
export function compareRows(before: Row[], after: Row[]): RunComparison {
  const prev = new Map(before.map((r) => [r.id, r]));
  const out: RunComparison = { fixed: [], broke: [], stillRight: 0, stillWrong: 0, notComparable: 0, otherChanges: 0 };
  for (const a of after) {
    const b = prev.get(a.id);
    if (!b || a.status !== "scored" || b.status !== "scored") {
      if (a.status === "scored" || b?.status === "scored") out.notComparable++;
      continue;
    }
    const was = isRight(b);
    const now = isRight(a);
    if (!was && now) out.fixed.push({ id: a.id, change: "fixed", before: b, after: a });
    else if (was && !now) out.broke.push({ id: a.id, change: "broke", before: b, after: a });
    else {
      if (now) out.stillRight++;
      else out.stillWrong++;
      if (a.pred !== b.pred) out.otherChanges++;
    }
  }
  // Biggest swings first: how far the score for the right answer moved.
  const swing = (c: ItemChange) => Math.abs((c.after.score ?? 0) - (c.before.score ?? 0));
  out.fixed.sort((x, y) => swing(y) - swing(x));
  out.broke.sort((x, y) => swing(y) - swing(x));
  return out;
}
