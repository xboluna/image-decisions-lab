"use client";
import JSZip from "jszip";
import { db } from "./db";
import { sha256Bytes, uid } from "./hash";
import { imageSize, isImagePath, mimeFor, resizeJpeg } from "./image";
import { coerceLabel, datasetHash, inferSchema, MANIFEST_NAMES, normalizePath, parseCsv, parseJsonl, SIDECAR_NAME, type Sidecar } from "./manifest";
import type { Dataset, DatasetItem } from "./types";

export type FileEntry = { path: string; file: Blob };
export type ImportProgress = { phase: string; done: number; total: number };

/** Reads every file under the dropped folders (or files) with their relative paths. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<FileEntry[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return Array.from(dt.files).map((f) => ({ path: f.name, file: f }));
  const out: FileEntry[] = [];
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 entries per call; keep reading until it returns none.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

export function filesFromInput(list: FileList): FileEntry[] {
  return Array.from(list).map((f) => ({ path: normalizePath((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name), file: f }));
}

export async function expandZips(files: FileEntry[], onProgress?: (p: ImportProgress) => void): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (const entry of files) {
    if (!entry.path.toLowerCase().endsWith(".zip")) {
      out.push(entry);
      continue;
    }
    onProgress?.({ phase: "Unpacking zip", done: 0, total: 1 });
    const zip = await JSZip.loadAsync(await entry.file.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !n.startsWith("__MACOSX/") && !n.split("/").pop()?.startsWith("._"));
    for (const name of names) {
      const data = await zip.files[name].async("blob");
      out.push({ path: normalizePath(name), file: isImagePath(name) ? new Blob([data], { type: mimeFor(name) }) : data });
    }
  }
  return out;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

export type ImportResult = { dataset: Dataset; warnings: string[] };

export async function importDataset(
  input: FileEntry[],
  opts: { id?: string; name?: string; description?: string; source?: string; onProgress?: (p: ImportProgress) => void } = {},
): Promise<ImportResult> {
  const files = (await expandZips(input, opts.onProgress)).filter((f) => !f.path.split("/").pop()?.startsWith("."));
  const manifests = files
    .filter((f) => MANIFEST_NAMES.some((m) => f.path === m || f.path.endsWith(`/${m}`)))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || (a.path.endsWith(".jsonl") ? -1 : 1));
  if (!manifests.length) {
    throw new Error("No metadata.jsonl or metadata.csv found. Drop the folder that holds the manifest and the images, or a zip of it.");
  }
  const manifest = manifests[0];
  const root = dirname(manifest.path);
  const text = await manifest.file.text();
  const parsed = manifest.path.endsWith(".jsonl") ? parseJsonl(text) : parseCsv(text);
  const warnings = [...parsed.warnings];
  if (!parsed.rows.length) throw new Error(`${manifest.path} has no usable rows. ${warnings.join(" ")}`);

  let sidecar: Sidecar | undefined;
  const sidecarFile = files.find((f) => f.path === `${root}${SIDECAR_NAME}`);
  if (sidecarFile) {
    try {
      sidecar = JSON.parse(await sidecarFile.file.text()) as Sidecar;
    } catch {
      warnings.push("dataset.json is not valid JSON and was ignored.");
    }
  }
  const { schema, warnings: schemaWarnings } = inferSchema(parsed.rows, sidecar);
  warnings.push(...schemaWarnings);
  if (!schema.length) throw new Error("The manifest has no boolean or categorical label columns besides file_name.");

  const byPath = new Map(files.map((f) => [f.path, f]));
  const byBase = new Map<string, FileEntry[]>();
  for (const f of files) {
    const base = f.path.split("/").pop() ?? f.path;
    byBase.set(base, [...(byBase.get(base) ?? []), f]);
  }

  const items: DatasetItem[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    opts.onProgress?.({ phase: "Hashing and indexing images", done: i, total: parsed.rows.length });
    if (seen.has(row.fileName)) {
      warnings.push(`${row.fileName} appears more than once; only the first row was kept.`);
      continue;
    }
    seen.add(row.fileName);
    let file = byPath.get(root + row.fileName);
    if (!file) {
      const candidates = byBase.get(row.fileName.split("/").pop() ?? "") ?? [];
      if (candidates.length === 1) file = candidates[0];
    }
    if (!file) {
      missing++;
      continue;
    }
    const bytes = new Uint8Array(await file.file.arrayBuffer());
    const imageHash = await sha256Bytes(bytes);
    const blob = new Blob([bytes], { type: file.file.type || mimeFor(file.path) });
    let size: { width: number; height: number };
    try {
      size = await imageSize(blob);
    } catch {
      warnings.push(`${row.fileName} could not be decoded as an image and was skipped.`);
      continue;
    }
    if (!(await db.hasImage(imageHash))) {
      const thumb = await resizeJpeg(blob, 384, 0.8);
      await db.putImage(imageHash, blob, thumb.blob);
    }
    const labels: DatasetItem["labels"] = {};
    for (const s of schema) labels[s.key] = coerceLabel(s, row.values[s.key]);
    items.push({ id: row.fileName, fileName: row.fileName, imageHash, width: size.width, height: size.height, labels });
  }
  if (missing) warnings.push(`${missing} row${missing === 1 ? "" : "s"} name an image that was not in the upload and ${missing === 1 ? "was" : "were"} skipped.`);
  if (!items.length) throw new Error("None of the images named in the manifest were found next to it.");
  opts.onProgress?.({ phase: "Computing dataset hash", done: parsed.rows.length, total: parsed.rows.length });

  const fallbackName = root.replace(/\/$/, "").split("/").pop() || manifest.path.replace(/\.(jsonl|csv)$/, "");
  const dataset: Dataset = {
    id: opts.id ?? uid("ds"),
    name: opts.name?.trim() || sidecar?.name || fallbackName || "Untitled dataset",
    description: opts.description ?? sidecar?.description ?? "",
    createdAt: new Date().toISOString(),
    hash: await datasetHash(schema, items),
    format: "huggingface-imagefolder",
    schema,
    items,
    source: opts.source,
  };
  await db.putDataset(dataset);
  return { dataset, warnings };
}
