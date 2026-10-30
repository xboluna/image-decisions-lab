"use client";
import { AlertTriangle, CheckCircle2, Database, FileArchive, FileText, FolderOpen, History, PackageOpen } from "lucide-react";
import { useRef, useState } from "react";
import { importBundle, scanBundle, type BundleImportResult, type BundlePlan, type BundleRole } from "@/lib/bundleImport";
import { filesFromDataTransfer, filesFromInput, type FileEntry, type ImportProgress } from "@/lib/importer";
import { useStore } from "@/lib/store";
import { Button, cx, HashChip, Modal, ProgressBar, Segmented } from "./ui";

type Phase = "pick" | "scanning" | "review" | "importing" | "done";

/** Import a whole experiment (or any folder with a prompt and datasets) in one go. */
export function BundleImportDialog() {
  const open = useStore((s) => s.bundleImportOpen);
  const setOpen = useStore((s) => s.setBundleImportOpen);
  const hydrate = useStore((s) => s.hydrate);
  const [phase, setPhase] = useState<Phase>("pick");
  const [plan, setPlan] = useState<BundlePlan | null>(null);
  const [roles, setRoles] = useState<BundleRole[]>([]);
  const [usePrompt, setUsePrompt] = useState(true);
  const [restore, setRestore] = useState(true);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BundleImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPhase("pick");
    setPlan(null);
    setRoles([]);
    setUsePrompt(true);
    setRestore(true);
    setProgress(null);
    setError(null);
    setResult(null);
  };
  const close = () => {
    if (phase === "scanning" || phase === "importing") return;
    reset();
    setOpen(false);
  };

  async function scan(files: FileEntry[]) {
    setError(null);
    setPhase("scanning");
    try {
      const p = await scanBundle(files, setProgress);
      setPlan(p);
      setRoles(p.datasets.map((d) => (d.imagesFound > 0 ? d.role : "skip")));
      setPhase("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("pick");
    } finally {
      setProgress(null);
    }
  }

  // Read the chosen files, then clear the input so choosing the same folder or zip again (after Back) still fires.
  const pick = (input: HTMLInputElement) => {
    const files = input.files ? filesFromInput(input.files) : [];
    input.value = "";
    if (files.length) void scan(files);
  };

  // Only one dataset per role: choosing a role for one dataset frees it from the other.
  const setRole = (i: number, role: BundleRole) =>
    setRoles((cur) => cur.map((r, j) => (j === i ? role : role !== "skip" && r === role ? "skip" : r)));

  async function run() {
    if (!plan) return;
    setPhase("importing");
    setError(null);
    try {
      const chosen: BundlePlan = { ...plan, datasets: plan.datasets.map((d, i) => ({ ...d, role: roles[i] })), prompt: usePrompt ? plan.prompt : null };
      const r = await importBundle(chosen, { restoreAnswers: restore, existingPromptNames: useStore.getState().prompts.map((p) => p.name), onProgress: setProgress });
      await hydrate();
      const s = useStore.getState();
      for (const d of r.datasets) if (d.role !== "skip") s.selectDataset(d.role, d.dataset.id);
      if (r.prompt) s.selectPrompt(r.prompt.id);
      // The restored answers belong to the exported run's model; select it so they show as current.
      if (r.restoredModel && r.restoredModel !== s.settings.model) s.setSettings({ model: r.restoredModel });
      setResult(r);
      setPhase("done");
    } catch (err) {
      // Nothing was kept (the import rolls back), but reload so the page matches what is stored.
      await hydrate();
      setError(err instanceof Error ? err.message : String(err));
      setPhase("review");
    } finally {
      setProgress(null);
    }
  }

  // Answers can be restored when the exact dataset version they were scored on is being imported, in any role.
  const restorable = plan?.results.filter((r) => plan.datasets.some((d, i) => roles[i] !== "skip" && d.exportedHash === r.run.dataset_hash.replace(/^sha256:/, ""))) ?? [];
  const answers = plan?.results.reduce((s, r) => s + r.predictions.filter((p) => p.raw_probabilities && !p.error).length, 0) ?? 0;
  const willImport = plan ? roles.filter((r) => r !== "skip").length + (usePrompt && plan.prompt ? 1 : 0) : 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title={phase === "done" ? "Imported" : "Import experiment"}
      subtitle={phase === "pick" || phase === "scanning" ? "A folder or zip with datasets and a prompt, such as an exported experiment." : undefined}
      footer={
        phase === "done" ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : phase === "review" || phase === "importing" ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={phase === "importing"}>
              Back
            </Button>
            <Button variant="primary" onClick={run} loading={phase === "importing"} disabled={!willImport}>
              Import
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={close} disabled={phase === "scanning"}>
            Cancel
          </Button>
        )
      }
    >
      {(phase === "pick" || phase === "scanning") && (
        <div className="space-y-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragging(false);
              if (phase === "pick") void scan(await filesFromDataTransfer(e.dataTransfer));
            }}
            className={cx("flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors", dragging ? "border-accent bg-accent-wash" : "border-line-strong bg-surface-2")}
          >
            <PackageOpen className={cx("size-7", dragging ? "text-accent" : "text-muted")} />
            <div className="mt-2 text-[13px] font-medium">{phase === "scanning" ? "Reading files…" : "Drop an experiment folder or a .zip here"}</div>
            <div className="mt-0.5 max-w-md text-[12.5px] text-ink-2">Nothing is imported until you review what was found.</div>
            {phase === "pick" && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => folderInput.current?.click()}>
                  Choose folder
                </Button>
                <Button size="sm" icon={<FileArchive className="size-3.5" />} onClick={() => zipInput.current?.click()}>
                  Choose zip
                </Button>
              </div>
            )}
            <input ref={folderInput} type="file" className="hidden" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => pick(e.currentTarget)} />
            <input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" aria-label="Experiment zip" onChange={(e) => pick(e.currentTarget)} />
          </div>
          {phase === "scanning" && progress && <ProgressBar value={progress.total ? progress.done / progress.total : 0} />}
          {error && <ErrorBox text={error} />}
          <details className="group rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
            <summary className="cursor-pointer select-none font-medium text-ink-2 group-open:text-ink">What can be imported</summary>
            <div className="mt-2 space-y-2 text-ink-2">
              <p>
                <b className="font-medium text-ink">An exported experiment</b> (⋯ → Export experiment, with images): its datasets, prompt and the model&apos;s saved answers, so results appear without scoring
                again.
              </p>
              <p>
                <b className="font-medium text-ink">Any folder</b> with a <code className="font-mono text-[11.5px]">prompt.json</code> (from Download prompt) and dataset folders in the ImageFolder layout. Folders named
                train / test / holdout / val get that role; you can change it before importing.
              </p>
              <pre className="overflow-x-auto rounded-lg bg-surface-3 p-2.5 font-mono text-[11px] leading-relaxed text-ink scroll-thin">{`my-experiment/
  prompt.json   examples/…
  train/metadata.jsonl   train/images/…
  test/metadata.jsonl    test/images/…`}</pre>
            </div>
          </details>
        </div>
      )}

      {(phase === "review" || phase === "importing") && plan && (
        <div className="space-y-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{plan.kind === "experiment" ? "Exported experiment" : "Folder"}</div>
          <ul className="divide-y divide-line rounded-xl border border-line" data-bundle-plan>
            {plan.datasets.map((d, i) => (
              <li key={d.root} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                <Database className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{d.name}</div>
                  <div className="truncate text-[11.5px] text-muted">
                    <span className="font-mono">{d.folder}</span> · {d.imagesFound} of {d.rows} images
                  </div>
                </div>
                <Segmented<BundleRole>
                  size="sm"
                  value={roles[i]}
                  onChange={(r) => setRole(i, r)}
                  disabled={d.imagesFound === 0 || phase === "importing"}
                  options={[
                    { value: "train", label: "Training" },
                    { value: "test", label: "Test" },
                    { value: "skip", label: "Skip" },
                  ]}
                />
              </li>
            ))}
            {plan.prompt && (
              <li className="flex items-center gap-3 px-3 py-2.5">
                <FileText className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{plan.prompt.name}</div>
                  <div className="text-[11.5px] text-muted">
                    Prompt · {plan.prompt.examples} reference example{plan.prompt.examples === 1 ? "" : "s"}
                  </div>
                </div>
                <label className="flex items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" checked={usePrompt} onChange={(e) => setUsePrompt(e.target.checked)} className="accent-[var(--accent)]" disabled={phase === "importing"} />
                  Import
                </label>
              </li>
            )}
            {plan.results.length > 0 && (
              <li className="flex items-center gap-3 px-3 py-2.5">
                <History className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">Saved model answers</div>
                  <div className="text-[11.5px] text-muted">
                    {answers} answers ({plan.results.map((r) => `${r.role === "train" ? "training" : "test"} ${r.predictions.filter((p) => p.raw_probabilities && !p.error).length}`).join(", ")}) from{" "}
                    <span className="font-mono">{plan.results[0].run.model.split("/").pop()}</span>
                    {restorable.length === 0 ? " · none of their datasets is being imported" : restorable.length < plan.results.length ? " · only for the datasets being imported" : ""}
                  </div>
                </div>
                <label className="flex items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" checked={restore && usePrompt && restorable.length > 0} onChange={(e) => setRestore(e.target.checked)} className="accent-[var(--accent)]" disabled={!usePrompt || !restorable.length || phase === "importing"} />
                  Restore
                </label>
              </li>
            )}
          </ul>
          {plan.warnings.length > 0 && <Warnings items={plan.warnings} />}
          {phase === "importing" && progress && (
            <div>
              <div className="mb-1 flex justify-between text-[12px] text-ink-2">
                <span>{progress.phase}</span>
                <span className="tabular">
                  {progress.done} / {progress.total}
                </span>
              </div>
              <ProgressBar value={progress.total ? progress.done / progress.total : 0} />
            </div>
          )}
          {error && <ErrorBox text={error} />}
        </div>
      )}

      {phase === "done" && result && (
        <div className="space-y-3" data-bundle-result>
          <div className="flex items-start gap-3 rounded-xl bg-good-wash p-3 text-good-ink">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
            <div className="space-y-1 text-[13px]">
              {result.datasets.map((d) => (
                <div key={d.dataset.id} className="flex flex-wrap items-center gap-2 text-ink-2">
                  <b className="font-medium text-ink">{d.role === "train" ? "Training set" : "Test set"}:</b> {d.dataset.name} · {d.dataset.items.length} images
                  <HashChip hash={d.dataset.hash} prefix="ds" />
                </div>
              ))}
              {result.prompt && (
                <div className="text-ink-2">
                  <b className="font-medium text-ink">Prompt:</b> {result.prompt.name}
                </div>
              )}
              {result.restoredAnswers > 0 && (
                <div className="text-ink-2">
                  <b className="font-medium text-ink">Restored</b> {result.restoredAnswers} saved answers in {result.restoredRuns} run{result.restoredRuns === 1 ? "" : "s"}: no scoring needed.
                  {result.restoredModel && (
                    <>
                      {" "}
                      Model set to <span className="font-mono text-[12px]">{result.restoredModel.split("/").pop()}</span>, which produced them.
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          {result.warnings.length > 0 && <Warnings items={result.warnings} />}
        </div>
      )}
    </Modal>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-xl bg-critical-wash px-3 py-2.5 text-[12.5px] text-critical-ink">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      {text}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  return (
    <div className="rounded-xl bg-warning-wash px-3 py-2.5 text-[12.5px] text-warning-ink">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-4" /> {items.length} note{items.length === 1 ? "" : "s"}
      </div>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.slice(0, 6).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        {items.length > 6 && <li>…and {items.length - 6} more</li>}
      </ul>
    </div>
  );
}
