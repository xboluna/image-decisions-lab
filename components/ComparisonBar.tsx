"use client";
import { ArrowLeftRight, Eye, Undo2 } from "lucide-react";
import type { Analysis, Comparison, VersionOption } from "@/lib/analysis";
import { shortHash } from "@/lib/hash";
import { useStore } from "@/lib/store";
import { Button, cx, timeAgo } from "./ui";

export function versionLabel(v: { promptName: string; promptHash: string; model: string }, otherModel?: string): string {
  const model = otherModel && v.model !== otherModel ? ` · ${v.model.split("/").pop()}` : "";
  return `${v.promptName} · ${shortHash(v.promptHash, 8)}${model}`;
}

function VersionChip({ name, hash, model, tone }: { name: string; hash: string; model?: string; tone: "working" | "baseline" }) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5", tone === "working" ? "border-accent/40 bg-accent-wash" : "border-line-strong bg-surface")}>
      <span className="truncate font-medium text-ink">{name}</span>
      <span className="font-mono text-[11px] text-ink-2">{shortHash(hash, 8)}</span>
      {model && <span className="truncate font-mono text-[11px] text-muted">{model.split("/").pop()}</span>}
    </span>
  );
}

/**
 * Says which version every delta on the page is measured against, lets the user pick another one, and lets them
 * look at that version (prompt, results and all) before switching back to the one they are working on.
 */
export function ComparisonBar({ comparison, a }: { comparison: Comparison | null; a: Analysis }) {
  const setBaseline = useStore((s) => s.setBaseline);
  const startPeek = useStore((s) => s.startPeek);
  const endPeek = useStore((s) => s.endPeek);
  if (!comparison) return null;
  const { baseline, options, peeking, working } = comparison;
  const b = a.baseline;
  const partialNote =
    b && b.paired < b.scored ? `Deltas use the ${b.paired} of ${b.scored} images scored in both versions.` : b && !b.complete ? "That version's run on this set is incomplete." : null;

  if (peeking) {
    return (
      <div data-comparison className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-warning/60 bg-warning-wash px-3 py-2 text-[12.5px] text-ink-2">
        <Eye className="size-4 shrink-0 text-warning-ink" />
        <span>Viewing</span>
        <VersionChip name={a.run.promptName} hash={a.run.promptHash} model={a.run.model !== working?.model ? a.run.model : undefined} tone="baseline" />
        {working && (
          <>
            <span>compared against your working version</span>
            <VersionChip name={working.promptName} hash={working.promptHash} tone="working" />
          </>
        )}
        <Button size="sm" variant="primary" className="ml-auto" icon={<Undo2 className="size-3.5" />} onClick={endPeek}>
          Switch back
        </Button>
        {partialNote && <span className="w-full text-[11.5px] text-warning-ink">{partialNote}</span>}
      </div>
    );
  }

  if (!baseline) {
    return (
      <div data-comparison className="flex items-center gap-2 rounded-xl border border-dashed border-line-strong px-3 py-2 text-[12.5px] text-muted">
        <ArrowLeftRight className="size-4 shrink-0" />
        Nothing to compare against yet. Change the prompt or model and score again to see what changed.
      </div>
    );
  }

  const canView = !!baseline.snapshot;
  return (
    <div data-comparison className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
      <ArrowLeftRight className="size-4 shrink-0 text-muted" />
      <span>Comparing against</span>
      <select
        aria-label="Version to compare against"
        value={baseline.key}
        onChange={(e) => setBaseline(e.target.value)}
        className="h-7 min-w-0 max-w-[340px] truncate rounded-lg border border-line-strong bg-surface px-1.5 text-[12.5px] font-medium text-ink outline-none focus:border-accent"
      >
        {options.map((o: VersionOption) => (
          <option key={o.key} value={o.key}>
            {versionLabel(o, working?.model)} · {timeAgo(o.startedAt)}
            {o.complete ? "" : " · partial run"}
          </option>
        ))}
      </select>
      {!b && <span className="text-muted">· not scored on this set</span>}
      <Button
        size="sm"
        className="ml-auto"
        icon={<Eye className="size-3.5" />}
        disabled={!canView}
        title={canView ? "Show this version's prompt and results. Switch back any time." : "This version's prompt text was not saved, so only its results can be compared."}
        onClick={() => baseline.snapshot && startPeek({ prompt: baseline.snapshot, hash: baseline.promptHash, model: baseline.model })}
      >
        See this prompt
      </Button>
      {partialNote && <span className="w-full text-[11.5px] text-warning-ink">{partialNote}</span>}
    </div>
  );
}
