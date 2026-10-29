"use client";
import { AlertTriangle, CheckCircle2, FileArchive, FolderOpen, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";
import { filesFromDataTransfer, filesFromInput, importDataset, type FileEntry, type ImportProgress } from "@/lib/importer";
import { FORMAT_DOC_URL } from "@/lib/manifest";
import { useStore, type Role } from "@/lib/store";
import type { Dataset } from "@/lib/types";
import { Button, cx, Field, HashChip, inputClass, Modal, ProgressBar } from "./ui";

const SAMPLE = `{"file_name": "images/0001.jpg", "upside_down_tubes": "2", "has_open_tube": false}
{"file_name": "images/0002.jpg", "upside_down_tubes": "0", "has_open_tube": true}`;

export function UploadDialog({ open, onClose, role }: { open: boolean; onClose: () => void; role: Role }) {
  const addDataset = useStore((s) => s.addDataset);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ dataset: Dataset; warnings: string[] } | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setFiles(null);
    setBusy(false);
    setProgress(null);
    setError(null);
    setResult(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const summary = files
    ? (() => {
        const images = files.filter((f) => /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.path)).length;
        const zips = files.filter((f) => f.path.toLowerCase().endsWith(".zip")).length;
        const manifest = files.find((f) => /(^|\/)metadata\.(jsonl|csv)$/.test(f.path));
        return { images, zips, manifest: manifest?.path, total: files.length };
      })()
    : null;

  async function run() {
    if (!files) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importDataset(files, { name, description, onProgress: setProgress, source: "upload" });
      await addDataset(r.dataset, role);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={result ? "Dataset ready" : "New dataset"}
      subtitle={result ? undefined : "Images plus a manifest in the Hugging Face ImageFolder layout. Everything stays in this browser."}
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={run} disabled={!files || busy} loading={busy}>
              Import {summary?.images ? `${summary.images} images` : ""}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl bg-good-wash p-3 text-good-ink">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
            <div className="text-[13px]">
              <div className="font-semibold">{result.dataset.name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-ink-2">
                {result.dataset.items.length} images · {result.dataset.schema.length} label{result.dataset.schema.length === 1 ? "" : "s"} ·
                <HashChip hash={result.dataset.hash} prefix="ds" title="Dataset version" />
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-line">
            {result.dataset.schema.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-[12.5px] last:border-b-0">
                <span className="font-medium">{s.key}</span>
                <span className="text-ink-2">{s.type === "boolean" ? "yes / no" : s.classes.join(" · ")}</span>
              </div>
            ))}
          </div>
          {result.warnings.length > 0 && <Warnings items={result.warnings} />}
        </div>
      ) : (
        <div className="space-y-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Optional: defaults to the folder name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bench photos, March" className={inputClass} />
            </Field>
            <Field label="Description" hint="Optional">
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Where the images came from" className={inputClass} />
            </Field>
          </div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragging(false);
              setError(null);
              setFiles(await filesFromDataTransfer(e.dataTransfer));
            }}
            className={cx(
              "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors",
              dragging ? "border-accent bg-accent-wash" : files ? "border-good bg-good-wash/40" : "border-line-strong bg-surface-2",
            )}
          >
            <UploadCloud className={cx("size-7", dragging ? "text-accent" : "text-muted")} />
            {summary ? (
              <div className="mt-2 text-[13px]">
                <div className="font-medium">
                  {summary.total} file{summary.total === 1 ? "" : "s"} ready{summary.zips ? ` (${summary.zips} zip)` : `: ${summary.images} images`}
                </div>
                <div className="mt-0.5 text-ink-2">{summary.manifest ? `Manifest: ${summary.manifest}` : summary.zips ? "The zip is unpacked on import." : "No metadata.jsonl or metadata.csv found yet."}</div>
              </div>
            ) : (
              <div className="mt-2 text-[13px]">
                <div className="font-medium">Drop a dataset folder or a .zip here</div>
                <div className="mt-0.5 text-ink-2">The folder must contain metadata.jsonl (or metadata.csv) and the images it names.</div>
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => folderInput.current?.click()}>
                Choose folder
              </Button>
              <Button size="sm" icon={<FileArchive className="size-3.5" />} onClick={() => zipInput.current?.click()}>
                Choose zip
              </Button>
            </div>
            <input
              ref={folderInput}
              type="file"
              className="hidden"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => e.target.files && setFiles(filesFromInput(e.target.files))}
            />
            <input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => e.target.files && setFiles(filesFromInput(e.target.files))} />
          </div>
          {busy && progress && (
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
          {error && (
            <div className="flex gap-2 rounded-xl bg-critical-wash px-3 py-2.5 text-[12.5px] text-critical-ink">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {error}
            </div>
          )}
          <details className="group rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
            <summary className="cursor-pointer select-none font-medium text-ink-2 group-open:text-ink">Format: Hugging Face ImageFolder with metadata</summary>
            <div className="mt-2 space-y-2 text-ink-2">
              <pre className="overflow-x-auto rounded-lg bg-surface-3 p-2.5 font-mono text-[11px] leading-relaxed text-ink scroll-thin">{`my-dataset/
  metadata.jsonl
  dataset.json        (optional: name, description, class order)
  images/0001.jpg
  images/0002.jpg`}</pre>
              <p>One JSON object per line. file_name is the image path relative to the manifest; every other key is a label:</p>
              <pre className="overflow-x-auto rounded-lg bg-surface-3 p-2.5 font-mono text-[11px] leading-relaxed text-ink scroll-thin">{SAMPLE}</pre>
              <p>
                <b className="font-medium text-ink">true/false</b> values make a yes/no label; <b className="font-medium text-ink">strings</b> make a class label (one of several values, such as
                0 / 1 / 2). A metadata.csv with a file_name column works too. Images with no value for a label are kept but not scored on it.{" "}
                <a className="text-accent-ink underline-offset-2 hover:underline" href={FORMAT_DOC_URL} target="_blank" rel="noreferrer">
                  Format reference
                </a>
              </p>
              <p>The dataset is hashed over its images, labels and label schema. The same files always give the same hash; renaming never changes it.</p>
            </div>
          </details>
        </div>
      )}
    </Modal>
  );
}

function Warnings({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 4);
  return (
    <div className="rounded-xl bg-warning-wash px-3 py-2.5 text-[12.5px] text-warning-ink">
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-4" /> {items.length} note{items.length === 1 ? "" : "s"}
      </div>
      <ul className="list-disc space-y-0.5 pl-5">
        {shown.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {items.length > 4 && (
        <button className="mt-1 underline-offset-2 hover:underline" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
