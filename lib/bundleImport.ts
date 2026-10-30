"use client";
import { db } from "./db";
import { uid } from "./hash";
import { isImagePath } from "./image";
import { expandZips, importDataset, type FileEntry, type ImportProgress } from "./importer";
import { MANIFEST_NAMES, normalizePath, parseCsv, parseJsonl } from "./manifest";
import { inferenceKey } from "./prompt";
import { importPromptFiles } from "./promptImport";
import type { Dataset, Inference, Prompt, Run } from "./types";

/**
 * Import of a whole experiment folder or zip: one or more datasets, a prompt, and (from this tool's own experiment
 * export) the model's answers, so results show without scoring again.
 *
 * Recognised layouts:
 *   - an experiment export: experiment.json, prompt/prompt.json, datasets/{train,test}/, results/{train,test}/
 *   - any folder holding prompt.json and ImageFolder datasets (folders with metadata.jsonl or metadata.csv);
 *     a folder named like train / test / holdout / val gets that role.
 */

export type BundleRole = "train" | "test" | "skip";

export type BundleDataset = {
  root: string;
  /** The folder, relative to the bundle, for display. */
  folder: string;
  files: FileEntry[];
  name: string;
  role: BundleRole;
  rows: number;
  imagesFound: number;
  /** From an experiment export: the dataset hash the results were scored on. */
  exportedHash?: string;
};

type Prediction = {
  file_name: string;
  image_sha256: string;
  raw_probabilities: Record<string, number> | null;
  raw_answer: unknown;
  error: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  latency_ms: number | null;
  requested_at: string | null;
  generation_id: string | null;
  served_model: string | null;
  cache_key: string | null;
};

type ExportedRun = { id: string; status: string; started_at: string; finished_at?: string; model: string; prompt_hash: string; dataset_hash: string; cost_usd: number };

export type BundleResults = { role: "train" | "test"; run: ExportedRun; predictions: Prediction[] };

export type BundlePlan = {
  kind: "experiment" | "folder";
  files: FileEntry[];
  datasets: BundleDataset[];
  prompt: { path: string; name: string; examples: number } | null;
  results: BundleResults[];
  warnings: string[];
};

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const stripSha = (h: string) => h.replace(/^sha256:/, "");

function guessRole(root: string): BundleRole | null {
  const parts = root.toLowerCase().split("/").filter(Boolean);
  if (parts.some((p) => /(^|[^a-z])(train|training)([^a-z]|$)/.test(p))) return "train";
  if (parts.some((p) => /(^|[^a-z])(test|holdout|val|validation|eval)([^a-z]|$)/.test(p))) return "test";
  return null;
}

async function readJson<T>(f: FileEntry | undefined): Promise<T | null> {
  if (!f) return null;
  try {
    return JSON.parse(await f.file.text()) as T;
  } catch {
    return null;
  }
}

/** Looks through the dropped files and says what can be imported, without importing anything yet. */
export async function scanBundle(input: FileEntry[], onProgress?: (p: ImportProgress) => void): Promise<BundlePlan> {
  const files = (await expandZips(input, onProgress)).filter((f) => !f.path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX"));
  const warnings: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const experiment = files.filter((f) => f.path.endsWith("experiment.json")).sort((a, b) => a.path.length - b.path.length)[0];
  const base = experiment ? dirname(experiment.path) : "";

  // Datasets: every folder with a manifest, except the results folders of an experiment export.
  const manifests = files
    .filter((f) => MANIFEST_NAMES.some((m) => f.path === m || f.path.endsWith(`/${m}`)))
    .filter((f) => !f.path.startsWith(`${base}results/`))
    // one manifest per folder, preferring metadata.jsonl
    .sort((a, b) => (a.path.endsWith(".jsonl") ? -1 : 1) - (b.path.endsWith(".jsonl") ? -1 : 1));
  const roots: string[] = [];
  for (const m of manifests) if (!roots.includes(dirname(m.path))) roots.push(dirname(m.path));
  const datasets: BundleDataset[] = [];
  for (const root of roots.sort()) {
    // A dataset owns its folder, minus any nested dataset folders.
    const nested = roots.filter((r) => r !== root && r.startsWith(root));
    const own = files.filter((f) => f.path.startsWith(root) && !nested.some((n) => f.path.startsWith(n)));
    const manifest = own.find((f) => f.path === `${root}metadata.jsonl`) ?? own.find((f) => f.path === `${root}metadata.csv`)!;
    const text = await manifest.file.text();
    const parsed = manifest.path.endsWith(".jsonl") ? parseJsonl(text) : parseCsv(text);
    // Match images the way the importer does: the exact path, else a file name that is unique in the folder.
    const images = own.filter((f) => isImagePath(f.path));
    const present = new Set(images.map((f) => f.path));
    const byBase = new Map<string, number>();
    for (const f of images) {
      const b = f.path.split("/").pop() ?? f.path;
      byBase.set(b, (byBase.get(b) ?? 0) + 1);
    }
    const imagesFound = parsed.rows.filter((r) => present.has(root + normalizePath(r.fileName)) || byBase.get(normalizePath(r.fileName).split("/").pop() ?? "") === 1).length;
    const card = await readJson<{ name?: string; hash?: string }>(byPath.get(`${root}dataset.json`));
    const folder = root.replace(/\/$/, "").split("/").pop() || "dataset";
    const role = guessRole(root.slice(base.length)) ?? "skip";
    datasets.push({ root, folder: root.slice(base.length) || "./", files: own, name: card?.name ?? folder, role, rows: parsed.rows.length, imagesFound, exportedHash: card?.hash ? stripSha(card.hash) : undefined });
  }
  // Unnamed single dataset: use it as the training set. Two unnamed: first train, second test.
  const unassigned = datasets.filter((d) => d.role === "skip");
  if (!datasets.some((d) => d.role === "train") && unassigned[0]) unassigned[0].role = "train";
  if (!datasets.some((d) => d.role === "test") && unassigned[1]) unassigned[1].role = "test";
  const order = { train: 0, test: 1, skip: 2 };
  datasets.sort((a, b) => order[a.role] - order[b.role]);
  for (const d of datasets) {
    if (d.imagesFound === 0) warnings.push(`“${d.name}” has a manifest but none of its images${experiment ? ": export the experiment again with “Include dataset images”." : "."}`);
    else if (d.imagesFound < d.rows) warnings.push(`“${d.name}”: ${d.rows - d.imagesFound} of ${d.rows} images named in its manifest are missing.`);
  }

  // Prompt: the experiment's own, else the shallowest prompt.json.
  const promptFile = (experiment ? byPath.get(`${base}prompt/prompt.json`) : undefined) ?? files.filter((f) => f.path.endsWith("prompt.json")).sort((a, b) => a.path.length - b.path.length)[0];
  let prompt: BundlePlan["prompt"] = null;
  if (promptFile) {
    const data = await readJson<{ name?: string; restore?: Prompt; examples?: unknown[] }>(promptFile);
    if (data) prompt = { path: promptFile.path, name: data.restore?.name ?? data.name ?? "Imported prompt", examples: (data.restore?.examples ?? data.examples ?? []).length };
    else warnings.push(`${promptFile.path} is not valid JSON and was ignored.`);
  }

  // Answers from an experiment export.
  const results: BundleResults[] = [];
  if (experiment) {
    for (const role of ["train", "test"] as const) {
      const metrics = await readJson<{ run?: ExportedRun }>(byPath.get(`${base}results/${role}/metrics.json`));
      const preds = byPath.get(`${base}results/${role}/predictions.jsonl`);
      if (!metrics?.run || !preds) continue;
      const predictions = (await preds.file.text())
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Prediction);
      results.push({ role, run: metrics.run, predictions });
    }
  }
  if (!datasets.length && !prompt) throw new Error("Nothing to import: no dataset (metadata.jsonl or metadata.csv) and no prompt.json found.");
  return { kind: experiment ? "experiment" : "folder", files, datasets, prompt, results, warnings };
}

export type BundleImportResult = {
  datasets: { role: BundleRole; dataset: Dataset }[];
  prompt: Prompt | null;
  restoredRuns: number;
  restoredAnswers: number;
  /** The model the restored answers came from, so it can be selected and the results show as current. */
  restoredModel: string | null;
  warnings: string[];
};

/** Imports what the plan describes. Answers are restored only onto the exact dataset version they were scored on. */
export async function importBundle(plan: BundlePlan, opts: { restoreAnswers: boolean; existingPromptNames: string[]; onProgress?: (p: ImportProgress) => void }): Promise<BundleImportResult> {
  // All or nothing: if any step fails, the datasets, prompt and runs written so far are removed again, so a retry
  // never leaves duplicates. Images and cached answers are content-addressed, so leftovers of those are harmless.
  const written = { datasets: [] as string[], prompts: [] as string[], runs: [] as string[] };
  try {
    return await importAll(plan, opts, written);
  } catch (err) {
    await Promise.all([...written.datasets.map((id) => db.deleteDataset(id)), ...written.prompts.map((id) => db.deletePrompt(id)), ...written.runs.map((id) => db.deleteRun(id))]);
    throw err;
  }
}

async function importAll(
  plan: BundlePlan,
  opts: { restoreAnswers: boolean; existingPromptNames: string[]; onProgress?: (p: ImportProgress) => void },
  written: { datasets: string[]; prompts: string[]; runs: string[] },
): Promise<BundleImportResult> {
  const warnings: string[] = [];
  const imported: BundleImportResult["datasets"] = [];
  for (const d of plan.datasets.filter((x) => x.role !== "skip" && x.imagesFound > 0)) {
    const { dataset, warnings: w } = await importDataset(d.files, { name: d.name, source: "bundle", onProgress: opts.onProgress });
    warnings.push(...w.map((x) => `${d.name}: ${x}`));
    written.datasets.push(dataset.id);
    imported.push({ role: d.role, dataset });
  }
  let prompt: Prompt | null = null;
  let restoredModel: string | null = null;
  if (plan.prompt) {
    const r = await importPromptFiles(plan.files, opts.existingPromptNames, plan.prompt.path);
    prompt = r.prompt;
    warnings.push(...r.warnings);
    await db.putPrompt(prompt);
    written.prompts.push(prompt.id);
  }

  let restoredRuns = 0;
  let restoredAnswers = 0;
  if (opts.restoreAnswers && prompt) {
    for (const res of plan.results) {
      const target = imported.find((x) => x.role === res.role);
      if (!target) continue;
      if (stripSha(res.run.dataset_hash) !== target.dataset.hash) {
        warnings.push(`The ${res.role} answers were scored on a different version of “${target.dataset.name}”, so they were not restored.`);
        continue;
      }
      const promptHash = stripSha(res.run.prompt_hash);
      const model = res.run.model;
      const items = new Set(target.dataset.items.map((i) => i.id));
      const inferences: Inference[] = [];
      const results: Record<string, string> = {};
      for (const p of res.predictions) {
        if (!items.has(p.file_name) || !p.raw_probabilities || p.error) continue;
        const cacheKey = await inferenceKey(promptHash, model, p.image_sha256);
        if (p.cache_key && p.cache_key !== cacheKey) continue; // not this prompt, model and image
        results[p.file_name] = cacheKey;
        inferences.push({
          cacheKey,
          imageHash: p.image_sha256,
          promptHash,
          model,
          ok: true,
          probabilities: p.raw_probabilities,
          raw: p.raw_answer,
          usage: { inputTokens: p.input_tokens ?? 0, outputTokens: 0, costUsd: p.cost_usd ?? 0 },
          latencyMs: p.latency_ms ?? 0,
          requestedAt: p.requested_at ?? res.run.started_at,
          generationId: p.generation_id ?? undefined,
          servedModel: p.served_model ?? undefined,
        });
      }
      if (!inferences.length) continue;
      await db.putInferences(inferences);
      const complete = inferences.length === target.dataset.items.length;
      const run: Run = {
        id: uid("run"),
        role: res.role,
        datasetId: target.dataset.id,
        datasetHash: target.dataset.hash,
        datasetName: target.dataset.name,
        promptId: prompt.id,
        promptHash,
        promptName: prompt.name,
        model,
        targetKey: prompt.targetKey,
        startedAt: res.run.started_at,
        finishedAt: res.run.finished_at,
        status: complete && res.run.status === "done" ? "done" : "cancelled",
        results,
        promptSnapshot: prompt,
        cachedCount: inferences.length,
        errorCount: 0,
        costUsd: inferences.reduce((s, i) => s + i.usage.costUsd, 0),
      };
      await db.putRun(run);
      written.runs.push(run.id);
      restoredModel = model;
      restoredRuns++;
      restoredAnswers += inferences.length;
    }
  }
  return { datasets: imported, prompt, restoredRuns, restoredAnswers, restoredModel, warnings };
}
