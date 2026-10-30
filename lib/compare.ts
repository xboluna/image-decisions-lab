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

export type Baseline<R> = { run: R; complete: boolean };

/**
 * Earlier runs to compare against, one per prompt version and model. Each is the newest complete run of that
 * version (finished, every image answered); a partial run (cancelled, failed, interrupted by a reload, or with
 * failed answers) is offered only when that version has no complete run. Runs scored before the current one come
 * first, newest first.
 */
export function pickBaselines<R extends { id: string; promptHash: string; model: string; startedAt: string; status?: string }>(
  candidates: R[],
  current: R,
  isComplete: (r: R) => boolean,
): Baseline<R>[] {
  const byVersion = new Map<string, R[]>();
  for (const r of candidates) {
    if (r.id === current.id || (r.promptHash === current.promptHash && r.model === current.model)) continue;
    const key = `${r.promptHash}|${r.model}`;
    byVersion.set(key, [...(byVersion.get(key) ?? []), r]);
  }
  const picks: Baseline<R>[] = [];
  for (const runs of byVersion.values()) {
    const run = preferredRun(runs as (R & { status: string })[], isComplete) as R;
    picks.push({ run, complete: isComplete(run) });
  }
  picks.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  return [...picks.filter((p) => p.run.startedAt < current.startedAt), ...picks.filter((p) => p.run.startedAt >= current.startedAt)];
}

/** Both runs restricted to the images scored in both, so their metrics are computed on the same images. */
export function pairedRows(before: Row[], after: Row[]): { before: Row[]; after: Row[] } {
  const scoredBefore = new Set(before.filter((r) => r.status === "scored").map((r) => r.id));
  const shared = new Set(after.filter((r) => r.status === "scored" && scoredBefore.has(r.id)).map((r) => r.id));
  return { before: before.filter((r) => shared.has(r.id)), after: after.filter((r) => shared.has(r.id)) };
}

/**
 * The run that stands for a version on a dataset: a run still scoring (so its answers fill in live), otherwise the
 * newest complete run, otherwise the newest partial one. Used both for the version being viewed and the one
 * compared against, so a cancelled re-run never replaces a complete run on either side.
 */
export function preferredRun<R extends { status: string; startedAt: string }>(runs: R[], isComplete: (r: R) => boolean): R | undefined {
  const newestFirst = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (newestFirst[0]?.status === "running") return newestFirst[0];
  return newestFirst.find(isComplete) ?? newestFirst[0];
}
