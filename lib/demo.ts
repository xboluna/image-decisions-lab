"use client";
import { db } from "./db";
import { importDataset, type FileEntry } from "./importer";
import { parseJsonl } from "./manifest";
import type { ClassMapping, Inference, Prompt, Run } from "./types";

export const DEMO_VERSION = 5;

type Seed = {
  version: number;
  datasets: { id: string; path: string; name: string; description: string }[];
  prompts: Prompt[];
  runs: Run[];
  inferences: Inference[];
  selection: { train: string; test: string; prompt: string };
  mappings?: Record<string, ClassMapping>;
  /** The model the seeded runs were scored with: the seeded prompts' model, and the default for new prompts. */
  model?: string;
};

const SETTINGS_KEY = "harness-studio.settings";

// Always revalidate: a stale cached manifest or seed would name images that no longer exist.
const fresh = (url: string) => fetch(url, { cache: "no-cache" });

async function fetchDataset(path: string): Promise<FileEntry[]> {
  const res = await fresh(`/demo/${path}/metadata.jsonl`);
  if (!res.ok) throw new Error(`Demo manifest ${path} is missing.`);
  const manifest = await res.text();
  const { rows } = parseJsonl(manifest);
  const files: FileEntry[] = [{ path: `${path}/metadata.jsonl`, file: new Blob([manifest]) }];
  const sidecar = await fresh(`/demo/${path}/dataset.json`);
  if (sidecar.ok) files.push({ path: `${path}/dataset.json`, file: await sidecar.blob() });
  const images = await Promise.all(
    rows.map(async (r) => {
      const res = await fresh(`/demo/${path}/${r.fileName}`);
      if (!res.ok) throw new Error(`Demo image ${r.fileName} is missing.`);
      return { path: `${path}/${r.fileName}`, file: await res.blob() };
    }),
  );
  return [...files, ...images];
}

/** Loads the bundled demo: two datasets, prompts, and the cached answers of the runs shown on first visit. */
export async function loadDemo(onProgress?: (text: string) => void): Promise<void> {
  const res = await fresh("/demo/seed.json");
  if (!res.ok) throw new Error("The demo bundle could not be downloaded.");
  const seed = (await res.json()) as Seed;
  // Download everything first, so a failed download leaves the installed demo untouched.
  const files = await Promise.all(seed.datasets.map((d) => fetchDataset(d.path)));
  await removeDemo();
  for (const [i, d] of seed.datasets.entries()) {
    onProgress?.(`Loading ${d.name}`);
    const { dataset } = await importDataset(files[i], { id: d.id, name: d.name, description: d.description, source: "demo" });
    if (dataset.hash !== seed.runs.find((r) => r.datasetId === d.id)?.datasetHash && seed.runs.some((r) => r.datasetId === d.id)) {
      console.warn(`Demo dataset ${d.name} hashed to ${dataset.hash}, which differs from the seeded runs.`);
    }
  }
  // The seeded prompts are scored with the seed's model; seeded runs get their version hashes when the store loads.
  for (const p of seed.prompts) await db.putPrompt(p.model || !seed.model ? p : { ...p, model: seed.model });
  if (seed.inferences.length) await db.putInferences(seed.inferences);
  for (const r of seed.runs) await db.putRun(r);
  const ui = (await db.getMeta<Record<string, unknown>>("ui")) ?? {};
  await db.setMeta("ui", { ...ui, selection: seed.selection, mappings: seed.mappings ?? {} });
  await db.setMeta("demoVersion", DEMO_VERSION);
  if (seed.model) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, model: seed.model }));
    } catch {
      /* storage blocked: the default model is used */
    }
  }
}

/** Removes the bundled demo's datasets, prompts and runs, leaving the user's own data alone. */
export async function removeDemo(): Promise<void> {
  for (const d of await db.listDatasets()) if (d.source === "demo" || d.id.startsWith("ds_demo_")) await db.deleteDataset(d.id);
  for (const p of await db.listPrompts()) if (p.id.startsWith("pr_demo_")) await db.deletePrompt(p.id);
  for (const r of await db.listRuns()) if (r.datasetId.startsWith("ds_demo_") || r.promptId.startsWith("pr_demo_")) await db.deleteRun(r.id);
}

async function demoImagesReadable(): Promise<boolean> {
  const demo = (await db.listDatasets()).filter((d) => d.source === "demo" || d.id.startsWith("ds_demo_"));
  const prompts = (await db.listPrompts()).filter((p) => p.id.startsWith("pr_demo_"));
  const hashes = new Set([...demo.flatMap((d) => d.items.map((i) => i.imageHash)), ...prompts.flatMap((p) => p.examples.map((e) => e.imageHash))]);
  for (const hash of hashes) if (!(await db.getThumb(hash))) return false;
  return true;
}

/** Removes the demo for good: it is not seeded again on reload ("Reload demo data" brings it back). */
export async function clearDemo(): Promise<void> {
  await removeDemo();
  await db.setMeta("demoVersion", DEMO_VERSION);
}

export async function seedDemoIfEmpty(): Promise<void> {
  const version = await db.getMeta<number>("demoVersion");
  if (version && version < DEMO_VERSION) {
    // An older demo is installed: swap it for the current one.
    await removeDemo();
    try {
      await loadDemo();
    } catch (err) {
      console.error("Demo update failed", err);
    }
    return;
  }
  if (version) {
    // The demo is installed: make sure its images can still be read, and restore them if not.
    if (!(await demoImagesReadable())) {
      try {
        await loadDemo();
      } catch (err) {
        console.error("Demo repair failed", err);
      }
    }
    return;
  }
  if ((await db.listDatasets()).length) return;
  try {
    await loadDemo();
  } catch (err) {
    console.error("Demo seeding failed", err);
  }
}
