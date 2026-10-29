"use client";
import { ArrowRight, Download, Eraser, Monitor, Moon, MoreHorizontal, RefreshCw, Sun, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useExperiment } from "@/lib/analysis";
import { exportExperiment } from "@/lib/export";
import { ALL } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { shortHash } from "@/lib/hash";
import { Button, cx, MenuItem, Modal, Popover } from "./ui";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("system");
  // Nothing is written back until the saved choice has been read, or the default would overwrite it.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const t = localStorage.getItem("harness-studio.theme") as Theme | null;
      if (t === "light" || t === "dark" || t === "system") setTheme(t);
    } catch {
      /* default */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("harness-studio.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme, loaded]);
  return [theme, setTheme];
}

type StepState = "current" | "stale" | "running" | "neutral";

const STATE_META: Record<StepState, { dot: string; ring: string; note: string }> = {
  current: { dot: "bg-good", ring: "border-good/40 bg-good-wash/60", note: "Up to date" },
  stale: { dot: "bg-warning", ring: "border-warning/60 bg-warning-wash", note: "Needs scoring" },
  running: { dot: "bg-accent animate-pulse", ring: "border-accent/50 bg-accent-wash", note: "Scoring…" },
  neutral: { dot: "bg-axis", ring: "border-line bg-surface-2", note: "" },
};

/** One link in the experiment chain. Flashes when its value changes; its colour says whether results are current. */
function Step({ label, value, state, title, children }: { label: string; value: string; state: StepState; title: string; children: ReactNode }) {
  const [flash, setFlash] = useState(0);
  const prev = useRef(value);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (prev.current !== value) {
      // A value appearing (a hash finishing computing) or settling while the page loads is not a change worth flagging.
      if (prev.current && value && Date.now() - mountedAt.current > 2000) setFlash((n) => n + 1);
      prev.current = value;
    }
  }, [value]);
  const meta = STATE_META[state];
  return (
    <div
      key={flash}
      title={`${title}${meta.note ? ` · ${meta.note}` : ""}`}
      className={cx("flex min-w-0 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors", meta.ring, flash > 0 && "value-flash")}
    >
      <span className={cx("size-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="text-[11px] font-medium text-ink-2">{label}</span>
      <span className="truncate font-mono text-[11px] text-ink">{children}</span>
    </div>
  );
}

export function Header() {
  const exp = useExperiment();
  const datasets = useStore((s) => s.datasets);
  const selection = useStore((s) => s.selection);
  const model = useStore((s) => s.settings.model);
  const hash = useStore((s) => (exp.prompt ? s.promptHashes[exp.prompt.id] : undefined));
  const train = datasets.find((d) => d.id === selection.train);
  const test = datasets.find((d) => d.id === selection.test);
  const [theme, setTheme] = useTheme();
  const [menu, setMenu] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeImages, setIncludeImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "reset" | "demo" | "clearDemo">(null);
  const live = useStore((s) => s.live);
  const roleState = (role: "train" | "test"): StepState => {
    if (live[role]) return "running";
    const a = exp[role];
    if (!(role === "train" ? train : test)) return "neutral";
    if (!a || a.stale || a.metrics.pending > 0) return "stale";
    return "current";
  };
  const promptState: StepState = live.train || live.test ? "running" : roleState("train") === "stale" || roleState("test") === "stale" ? "stale" : "current";
  const multiclass = exp.target?.type === "categorical" && exp.focus === ALL;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="size-7" />
          <div className="leading-tight">
            <div className="text-[14.5px] font-semibold tracking-tight">Image Decisions Lab</div>
          </div>
        </div>
        <nav aria-label="Experiment" className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 lg:flex scroll-thin">
          <Step label="Train" value={train?.hash ?? ""} state={roleState("train")} title={`Training set “${train?.name ?? "none"}”`}>
            {train ? shortHash(train.hash, 8) : "—"}
          </Step>
          <ArrowRight className="size-3.5 shrink-0 text-muted" />
          <Step label="Prompt" value={hash ?? ""} state={promptState} title={`Prompt “${exp.prompt?.name ?? "none"}”`}>
            {hash ? shortHash(hash, 8) : "—"}
          </Step>
          <ArrowRight className="size-3.5 shrink-0 text-muted" />
          <Step label="Model" value={model} state={promptState} title={model}>
            {model.split("/").pop()}
          </Step>
          <ArrowRight className="size-3.5 shrink-0 text-muted" />
          <Step
            label={multiclass ? "Cutoff" : "Threshold"}
            value={exp.threshold.value.toFixed(3)}
            state={exp.threshold.trainRunId ? (exp.train?.stale ? "stale" : "current") : multiclass ? "neutral" : "stale"}
            title={exp.threshold.source === "default" ? "Default: score the training set to fit one" : `From the training set (${exp.threshold.source})`}
          >
            {exp.threshold.value.toFixed(3)}
          </Step>
          <ArrowRight className="size-3.5 shrink-0 text-muted" />
          <Step label="Test" value={test?.hash ?? ""} state={roleState("test")} title={`Test set “${test?.name ?? "none"}”`}>
            {test ? shortHash(test.hash, 8) : "—"}
          </Step>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="primary" icon={<Download className="size-3.5" />} onClick={() => setExportOpen(true)} disabled={!exp.prompt || !hash}>
            Export experiment
          </Button>
          <div className="relative">
            <Button variant="ghost" aria-label="More" onClick={() => setMenu((m) => !m)} icon={<MoreHorizontal className="size-4" />} />
            <Popover open={menu} onClose={() => setMenu(false)} className="w-60">
              <div className="flex items-center justify-between px-2.5 py-1.5">
                <span className="text-[12.5px] text-ink-2">Theme</span>
                <div className="flex rounded-lg bg-surface-3 p-0.5">
                  {(
                    [
                      ["light", Sun],
                      ["system", Monitor],
                      ["dark", Moon],
                    ] as const
                  ).map(([t, Icon]) => (
                    <button key={t} aria-label={`${t} theme`} onClick={() => setTheme(t)} className={cx("rounded-md p-1", theme === t ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                      <Icon className="size-3.5" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="my-1 border-t border-line" />
              <MenuItem
                icon={<RefreshCw className="size-4" />}
                onClick={() => {
                  setMenu(false);
                  setConfirm("demo");
                }}
              >
                Reload demo data
              </MenuItem>
              <MenuItem
                icon={<Eraser className="size-4" />}
                onClick={() => {
                  setMenu(false);
                  setConfirm("clearDemo");
                }}
              >
                Clear demo
              </MenuItem>
              <MenuItem
                icon={<Trash2 className="size-4" />}
                tone="danger"
                onClick={() => {
                  setMenu(false);
                  setConfirm("reset");
                }}
              >
                Clear all local data
              </MenuItem>
            </Popover>
          </div>
        </div>
      </div>
      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export experiment"
        subtitle="One zip with everything needed to audit or reproduce these results."
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              icon={<Download className="size-3.5" />}
              onClick={async () => {
                if (!exp.prompt || !hash) return;
                setBusy(true);
                try {
                  await exportExperiment({ prompt: exp.prompt, promptHash: hash, model, mapping: exp.mapping, focus: exp.focus, threshold: exp.threshold, train: exp.train, test: exp.test, trainDataset: train, testDataset: test, includeImages });
                  setExportOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Download zip
            </Button>
          </>
        }
      >
        <ul className="space-y-1.5 text-[12.5px] text-ink-2">
          <li>
            <b className="font-medium text-ink">Prompt</b> with its hash, the question, the reference images and the exact request body.
          </li>
          <li>
            <b className="font-medium text-ink">Datasets</b>: manifests and hashes for the training and test sets.
          </li>
          <li>
            <b className="font-medium text-ink">Per-image results</b>: the model&apos;s raw answer, probabilities, prediction, outcome, cost and latency (JSONL and CSV).
          </li>
          <li>
            <b className="font-medium text-ink">Metrics and charts</b>: accuracy, balanced accuracy, per-class stats, confusion matrix, PR curves and histogram as JSON, and the charts as SVG.
          </li>
          <li>
            <b className="font-medium text-ink">Settings</b>: model, threshold ({exp.threshold.value.toFixed(3)}, {exp.threshold.source}), view ({exp.focus === ALL ? "all classes" : exp.focus}) and class groups.
          </li>
        </ul>
        <label className="mt-3 flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={includeImages} onChange={(e) => setIncludeImages(e.target.checked)} className="accent-[var(--accent)]" />
          Include dataset images (larger download)
        </label>
        {(exp.train?.stale || exp.test?.stale) && <p className="mt-2 rounded-lg bg-warning-wash px-2.5 py-1.5 text-[12px] text-warning-ink">Some results shown are from an earlier prompt version; the export marks them as stale.</p>}
      </Modal>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "reset" ? "Clear all local data?" : confirm === "clearDemo" ? "Clear the demo?" : "Reload the demo?"}
        subtitle={
          confirm === "reset"
            ? "Deletes every dataset, prompt, run and cached answer stored in this browser. Your API key and settings are kept."
            : confirm === "clearDemo"
              ? "Removes the demo datasets, prompts and runs. Your own datasets, prompts and runs are kept, and the demo will not come back on reload."
              : "Adds the demo datasets, prompts and cached results back. Your own data is kept."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm === "reset" || confirm === "clearDemo" ? "danger" : "primary"}
              onClick={async () => {
                if (confirm === "clearDemo") {
                  const { clearDemo } = await import("@/lib/demo");
                  await clearDemo();
                  location.reload();
                } else if (confirm === "reset") {
                  const dbs = await indexedDB.databases?.();
                  await Promise.all((dbs ?? []).filter((d) => d.name?.startsWith("harness-studio")).map((d) => new Promise((r) => { const req = indexedDB.deleteDatabase(d.name as string); req.onsuccess = req.onerror = req.onblocked = () => r(null); })));
                  location.reload();
                } else {
                  const { loadDemo } = await import("@/lib/demo");
                  await loadDemo();
                  location.reload();
                }
              }}
            >
              {confirm === "reset" ? "Delete everything" : confirm === "clearDemo" ? "Clear demo" : "Reload demo"}
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] text-ink-2">
          {confirm === "reset" ? "Export anything you want to keep first." : confirm === "clearDemo" ? "You can bring it back any time with “Reload demo data”." : "This takes a few seconds."}
        </p>
      </Modal>
    </header>
  );
}
