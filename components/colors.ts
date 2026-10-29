import type { Outcome, Target } from "@/lib/metrics";
import type { ClassMapping } from "@/lib/types";

export const CLASS_COLORS = 4;

/**
 * Colour follows the class, never its rank: a group takes the slot of the first original class mapped into it.
 * Classes past the fourth are grey and carry their name as text.
 */
export function classColor(target: Target | null, mapping: ClassMapping, group: string | null | undefined): string {
  if (group == null || !target) return "var(--muted)";
  if (target.type === "boolean") return group === "true" ? "var(--class-1)" : "var(--class-2)";
  const idx = target.classes.findIndex((c) => (mapping[c] === undefined ? c : mapping[c]) === group);
  if (idx < 0) return "var(--muted)";
  return idx < CLASS_COLORS ? `var(--class-${idx + 1})` : "var(--muted)";
}

export function classLabel(target: Target | null, group: string | null | undefined): string {
  if (group == null) return "—";
  if (target?.type === "boolean") return group === "true" ? "yes" : "no";
  return group;
}

export const OUTCOME_META: Record<Outcome, { label: string; long: string; tone: "good" | "critical" | "serious"; color: string }> = {
  TP: { label: "TP", long: "True positive", tone: "good", color: "var(--good)" },
  TN: { label: "TN", long: "True negative", tone: "good", color: "var(--good)" },
  FP: { label: "FP", long: "False positive", tone: "critical", color: "var(--critical)" },
  FN: { label: "FN", long: "False negative", tone: "serious", color: "var(--serious)" },
  correct: { label: "Right", long: "Right class", tone: "good", color: "var(--good)" },
  incorrect: { label: "Wrong", long: "Wrong class", tone: "critical", color: "var(--critical)" },
};
