"use client";
import { Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { groupsFor, type Target } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import type { ClassMapping } from "@/lib/types";
import { classColor } from "./colors";
import { Button, cx, inputClass } from "./ui";

const EXCLUDE = "__exclude__";

/**
 * Merge, exclude or keep each class. Scoring only: merged classes add their probabilities, excluded classes drop
 * their images and renormalise the rest. The model is asked the same question, so no new run is needed.
 */
export function ClassGroups({ target, mapping }: { target: Extract<Target, { type: "categorical" }>; mapping: ClassMapping }) {
  const prompt = useStore((s) => s.prompts.find((p) => p.id === s.selection.prompt));
  const setMapping = useStore((s) => s.setMapping);
  const [newGroup, setNewGroup] = useState("");
  const groups = groupsFor(target, mapping);
  const [extra, setExtra] = useState<string[]>([]);
  const options = [...new Set([...target.classes, ...groups, ...extra])];
  if (!prompt) return null;
  const update = (cls: string, value: string) => {
    const next = { ...mapping };
    if (value === cls) delete next[cls];
    else next[cls] = value === EXCLUDE ? null : value;
    setMapping(prompt.targetKey, next);
  };
  const included = target.classes.filter((c) => mapping[c] !== null).length;
  return (
    <div>
      <div className="text-[13px] font-semibold">Class groups</div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-2">
        Merge classes to see if a coarser label scores better, or exclude a class. Scoring only: probabilities are summed per group, so no new model calls are made. Applies to both sets.
      </p>
      <div className="mt-2.5 space-y-1.5">
        {target.classes.map((c) => {
          const v = mapping[c] === undefined ? c : mapping[c] === null ? EXCLUDE : (mapping[c] as string);
          return (
            <div key={c} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: v === EXCLUDE ? "var(--axis)" : classColor(target, mapping, v) }} />
              <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", v === EXCLUDE && "text-muted line-through")}>{c}</span>
              <span className="text-[11px] text-muted">→</span>
              <select
                aria-label={`Group for ${c}`}
                value={v}
                onChange={(e) => update(c, e.target.value)}
                className="h-7 w-[140px] rounded-lg border border-line-strong bg-surface px-1.5 text-[12px] outline-none focus:border-accent"
              >
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o === c ? `${o} (itself)` : o}
                  </option>
                ))}
                <option value={EXCLUDE} disabled={included <= 2 && v !== EXCLUDE}>
                  Exclude
                </option>
              </select>
            </div>
          );
        })}
      </div>
      <form
        className="mt-2.5 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newGroup.trim();
          if (name && !options.includes(name)) setExtra((x) => [...x, name]);
          setNewGroup("");
        }}
      >
        <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name, e.g. one_or_more" className={cx(inputClass, "h-7 py-0 text-[12px]")} />
        <Button size="sm" type="submit" icon={<Plus className="size-3.5" />}>
          Add
        </Button>
      </form>
      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2">
        <span className="text-[11.5px] text-muted">
          {groups.length} group{groups.length === 1 ? "" : "s"} scored
        </span>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setMapping(prompt.targetKey, {})} disabled={!Object.keys(mapping).length}>
          Reset
        </Button>
      </div>
    </div>
  );
}
