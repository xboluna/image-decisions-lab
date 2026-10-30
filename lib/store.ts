"use client";
import { create } from "zustand";
import { db } from "./db";
import { shortHash, uid } from "./hash";
import { ALL } from "./metrics";
import { DEFAULT_MODEL } from "./models";
import { defaultQuestion, promptHash, promptProblems } from "./prompt";
import { imageLimitProblem, runInference, type RunProgress } from "./runner";
import type { ClassMapping, Dataset, Inference, LabelSchema, Prompt, PromptExample, Run, Settings } from "./types";
import { compareSchemas } from "./manifest";

export type Role = "train" | "test";

type Selection = { train: string | null; test: string | null; prompt: string | null };
type Live = { progress: RunProgress; controller: AbortController; runId: string };

type State = {
  ready: boolean;
  datasets: Dataset[];
  prompts: Prompt[];
  runs: Run[];
  inferences: Record<string, Inference>;
  promptHashes: Record<string, string>;
  selection: Selection;
  settings: Settings;
  /** Class grouping per target label key. */
  mappings: Record<string, ClassMapping>;
  /** One focus ("all classes" or a class) shared by both panels. */
  focus: string;
  /** The version (prompt hash | model) every comparison is made against; null picks the previous version. */
  baselineKey: string | null;
  /** While set, the app shows this earlier version instead of the working prompt (read-only). */
  peek: { prompt: Prompt; hash: string; model: string } | null;
  /** Threshold overrides, keyed by `${trainRunId}|${focus}`. */
  thresholds: Record<string, number>;
  live: Partial<Record<Role, Live>>;
  runErrors: Partial<Record<Role, string>>;
  toast: { id: number; text: string; tone: "info" | "error" } | null;
  bundleImportOpen: boolean;
  setBundleImportOpen: (open: boolean) => void;

  hydrate: () => Promise<void>;
  notify: (text: string, tone?: "info" | "error") => void;
  addDataset: (d: Dataset, role?: Role) => Promise<void>;
  renameDataset: (id: string, name: string, description?: string) => Promise<void>;
  deleteDataset: (id: string) => Promise<void>;
  selectDataset: (role: Role, id: string | null) => void;
  createPrompt: (base?: Partial<Prompt>) => Promise<Prompt>;
  updatePrompt: (id: string, patch: Partial<Prompt>) => void;
  duplicatePrompt: (id: string) => Promise<void>;
  addPrompt: (prompt: Prompt) => Promise<void>;
  deletePrompt: (id: string) => Promise<void>;
  selectPrompt: (id: string) => void;
  setTarget: (schema: LabelSchema) => void;
  addExample: (example: Omit<PromptExample, "id">) => void;
  updateExample: (exampleId: string, patch: Partial<PromptExample>) => void;
  removeExample: (exampleId: string) => void;
  moveExample: (from: number, to: number) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setMapping: (key: string, mapping: ClassMapping) => void;
  setFocus: (focus: string) => void;
  setBaseline: (key: string | null) => void;
  startPeek: (peek: { prompt: Prompt; hash: string; model: string }) => void;
  endPeek: () => void;
  setThreshold: (trainRunId: string, focus: string, value: number | null) => void;
  startRun: (role: Role) => Promise<void>;
  cancelRun: (role: Role) => void;
  loadInferences: (keys: string[]) => Promise<void>;
  importBundle: (data: { datasets?: Dataset[]; prompts?: Prompt[]; runs?: Run[]; inferences?: Inference[] }) => Promise<void>;
};

const SETTINGS_KEY = "harness-studio.settings";
const defaultSettings: Settings = { apiKey: "", model: DEFAULT_MODEL, concurrency: 4, advancedMetrics: false };

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function debounce(key: string, fn: () => void, ms = 300) {
  clearTimeout(persistTimers.get(key));
  persistTimers.set(key, setTimeout(fn, ms));
}

export const useStore = create<State>((set, get) => {
  const persistUi = () =>
    debounce("ui", () => {
      const { selection, mappings, focus, thresholds, baselineKey } = get();
      void db.setMeta("ui", { selection, mappings, focus, thresholds, baselineKey });
    });

  const rehash = async (prompt: Prompt) => {
    const hash = await promptHash(prompt);
    set((s) => ({ promptHashes: { ...s.promptHashes, [prompt.id]: hash } }));
  };

  const patchPrompt = (id: string, fn: (p: Prompt) => Prompt) => {
    // An earlier version is on screen: it is read-only, and the hidden working prompt must not change either.
    if (get().peek) {
      get().notify("You are viewing an earlier version. Switch back to edit your working prompt.", "error");
      return;
    }
    let updated: Prompt | undefined;
    set((s) => ({
      prompts: s.prompts.map((p) => {
        if (p.id !== id) return p;
        updated = { ...fn(p), updatedAt: new Date().toISOString() };
        return updated;
      }),
    }));
    if (updated) {
      const u = updated;
      void rehash(u);
      debounce(`prompt:${id}`, () => void db.putPrompt(u));
    }
  };

  return {
    ready: false,
    datasets: [],
    prompts: [],
    runs: [],
    inferences: {},
    promptHashes: {},
    selection: { train: null, test: null, prompt: null },
    settings: defaultSettings,
    mappings: {},
    focus: ALL,
    thresholds: {},
    baselineKey: null,
    peek: null,
    live: {},
    runErrors: {},
    toast: null,
    bundleImportOpen: false,
    setBundleImportOpen: (open) => set({ bundleImportOpen: open }),

    async hydrate() {
      const { seedDemoIfEmpty } = await import("./demo");
      await seedDemoIfEmpty();
      const [datasets, prompts, runs, ui] = await Promise.all([
        db.listDatasets(),
        db.listPrompts(),
        db.listRuns(),
        db.getMeta<Pick<State, "selection" | "mappings" | "focus" | "thresholds" | "baselineKey">>("ui"),
      ]);
      datasets.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      prompts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      // A run interrupted by a page reload is kept as cancelled; its cached answers make the next run fast.
      for (const r of runs) if (r.status === "running") r.status = "cancelled";
      const selection = ui?.selection ?? { train: null, test: null, prompt: null };
      const has = (id: string | null, list: { id: string }[]) => (id && list.some((x) => x.id === id) ? id : null);
      set({
        datasets,
        prompts,
        runs,
        settings: loadSettings(),
        selection: {
          train: has(selection.train, datasets) ?? datasets[0]?.id ?? null,
          test: has(selection.test, datasets) ?? datasets[1]?.id ?? null,
          prompt: has(selection.prompt, prompts) ?? prompts[0]?.id ?? null,
        },
        mappings: ui?.mappings ?? {},
        focus: ui?.focus ?? ALL,
        thresholds: ui?.thresholds ?? {},
        baselineKey: ui?.baselineKey ?? null,
        peek: null,
      });
      await Promise.all(prompts.map(rehash));
      await get().loadInferences(runs.flatMap((r) => Object.values(r.results)));
      set({ ready: true });
    },

    notify(text, tone = "info") {
      const id = Date.now();
      set({ toast: { id, text, tone } });
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 4200);
    },

    async addDataset(d, role) {
      set((s) => ({ datasets: [...s.datasets.filter((x) => x.id !== d.id), d] }));
      if (role) get().selectDataset(role, d.id);
    },
    async renameDataset(id, name, description) {
      const d = get().datasets.find((x) => x.id === id);
      if (!d) return;
      const updated = { ...d, name: name.trim() || d.name, description: description ?? d.description };
      set((s) => ({ datasets: s.datasets.map((x) => (x.id === id ? updated : x)) }));
      await db.putDataset(updated);
    },
    async deleteDataset(id) {
      await db.deleteDataset(id);
      set((s) => ({
        datasets: s.datasets.filter((x) => x.id !== id),
        selection: { ...s.selection, train: s.selection.train === id ? null : s.selection.train, test: s.selection.test === id ? null : s.selection.test },
      }));
      persistUi();
    },
    selectDataset(role, id) {
      set((s) => ({ selection: { ...s.selection, [role]: id } }));
      persistUi();
    },

    async createPrompt(base) {
      const train = get().datasets.find((d) => d.id === get().selection.train);
      const schema = train?.schema[0];
      const now = new Date().toISOString();
      const prompt: Prompt = {
        id: uid("pr"),
        name: "Untitled prompt",
        createdAt: now,
        updatedAt: now,
        systemPrompt: "",
        imageMaxSide: 1024,
        examples: [],
        ...(schema ? defaultQuestion(schema) : { targetKey: "", targetType: "boolean", instructions: "", criteria: { true: "", false: "" } }),
        ...base,
      };
      await db.putPrompt(prompt);
      set((s) => ({ prompts: [...s.prompts, prompt], selection: { ...s.selection, prompt: prompt.id } }));
      await rehash(prompt);
      persistUi();
      return prompt;
    },
    updatePrompt(id, patch) {
      patchPrompt(id, (p) => ({ ...p, ...patch }));
    },
    async duplicatePrompt(id) {
      const p = get().prompts.find((x) => x.id === id);
      if (!p) return;
      const match = /^(.*?)(?: v(\d+))?$/.exec(p.name);
      const name = match ? `${match[1]} v${Number(match[2] ?? 1) + 1}` : `${p.name} copy`;
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = p;
      await get().createPrompt({ ...rest, name, examples: p.examples.map((e) => ({ ...e, id: uid("ex") })) });
      get().notify(`Duplicated as "${name}". Edits now go to the copy; the original stays as it was.`);
    },
    async addPrompt(prompt) {
      await db.putPrompt(prompt);
      set((s) => ({ prompts: [...s.prompts, prompt], selection: { ...s.selection, prompt: prompt.id }, focus: ALL }));
      await rehash(prompt);
      persistUi();
    },
    async deletePrompt(id) {
      await db.deletePrompt(id);
      set((s) => {
        const prompts = s.prompts.filter((p) => p.id !== id);
        return { prompts, selection: { ...s.selection, prompt: s.selection.prompt === id ? (prompts[0]?.id ?? null) : s.selection.prompt } };
      });
      persistUi();
    },
    selectPrompt(id) {
      set((s) => ({ selection: { ...s.selection, prompt: id }, focus: ALL, peek: null, baselineKey: null }));
      persistUi();
    },
    setTarget(schema) {
      const id = get().selection.prompt;
      if (!id) return;
      const train = get().datasets.find((d) => d.id === get().selection.train);
      const truth = new Map(train?.items.map((i) => [i.imageHash, i.labels[schema.key]]) ?? []);
      const fallback = schema.type === "boolean" ? true : schema.classes[0];
      patchPrompt(id, (p) => ({ ...p, ...defaultQuestion(schema), examples: p.examples.map((e) => ({ ...e, label: truth.get(e.imageHash) ?? fallback })) }));
      set({ focus: ALL });
    },
    addExample(example) {
      const id = get().selection.prompt;
      if (!id) return;
      patchPrompt(id, (p) => ({ ...p, examples: [...p.examples, { ...example, id: uid("ex") }] }));
    },
    updateExample(exampleId, patch) {
      const id = get().selection.prompt;
      if (!id) return;
      patchPrompt(id, (p) => ({ ...p, examples: p.examples.map((e) => (e.id === exampleId ? { ...e, ...patch } : e)) }));
    },
    removeExample(exampleId) {
      const id = get().selection.prompt;
      if (!id) return;
      patchPrompt(id, (p) => ({ ...p, examples: p.examples.filter((e) => e.id !== exampleId) }));
    },
    moveExample(from, to) {
      const id = get().selection.prompt;
      if (!id) return;
      patchPrompt(id, (p) => {
        const examples = [...p.examples];
        const [moved] = examples.splice(from, 1);
        examples.splice(to, 0, moved);
        return { ...p, examples };
      });
    },

    setSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* storage blocked: settings last for this tab only */
      }
    },
    setMapping(key, mapping) {
      set((s) => ({ mappings: { ...s.mappings, [key]: mapping }, focus: ALL }));
      persistUi();
    },
    setFocus(focus) {
      set({ focus });
      persistUi();
    },
    setBaseline(key) {
      set({ baselineKey: key });
      persistUi();
    },
    startPeek(peek) {
      set({ peek });
    },
    endPeek() {
      set({ peek: null });
    },
    setThreshold(trainRunId, focus, value) {
      set((s) => {
        const thresholds = { ...s.thresholds };
        const key = `${trainRunId}|${focus}`;
        if (value == null) delete thresholds[key];
        else thresholds[key] = Math.round(value * 1000) / 1000;
        return { thresholds };
      });
      persistUi();
    },

    async startRun(role) {
      const s = get();
      if (s.live[role]) return;
      const dataset = s.datasets.find((d) => d.id === s.selection[role]);
      const prompt = s.prompts.find((p) => p.id === s.selection.prompt);
      const blockers = runBlockers(s, role);
      if (!dataset || !prompt || blockers.length) {
        set((st) => ({ runErrors: { ...st.runErrors, [role]: blockers[0] ?? "Pick a dataset and a prompt first." } }));
        return;
      }
      const hash = await promptHash(prompt);
      const controller = new AbortController();
      const run: Run = {
        id: uid("run"),
        role,
        datasetId: dataset.id,
        datasetHash: dataset.hash,
        datasetName: dataset.name,
        promptId: prompt.id,
        promptHash: hash,
        promptName: prompt.name,
        model: s.settings.model,
        targetKey: prompt.targetKey,
        startedAt: new Date().toISOString(),
        status: "running",
        results: {},
        promptSnapshot: structuredClone(prompt),
        cachedCount: 0,
        errorCount: 0,
        costUsd: 0,
      };
      await db.putPrompt(prompt);
      set((st) => ({
        runs: [...st.runs, run],
        live: { ...st.live, [role]: { controller, runId: run.id, progress: { done: 0, total: dataset.items.length, cached: 0, errors: 0, costUsd: 0 } } },
        runErrors: { ...st.runErrors, [role]: undefined },
      }));
      const update = (patch: Partial<Run>) => set((st) => ({ runs: st.runs.map((r) => (r.id === run.id ? { ...r, ...patch } : r)) }));
      const results: Record<string, string> = {};
      let pending: Record<string, Inference> = {};
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        const batch = pending;
        pending = {};
        set((st) => ({
          inferences: { ...st.inferences, ...batch },
          runs: st.runs.map((r) => (r.id === run.id ? { ...r, results: { ...results } } : r)),
        }));
      };
      try {
        const final = await runInference({
          dataset,
          prompt,
          promptHash: hash,
          model: s.settings.model,
          apiKey: s.settings.apiKey,
          concurrency: s.settings.concurrency,
          signal: controller.signal,
          onResult: (itemId, inference) => {
            results[itemId] = inference.cacheKey;
            pending[inference.cacheKey] = inference;
            flushTimer ??= setTimeout(flush, 120);
          },
          onProgress: (progress) => set((st) => ({ live: { ...st.live, [role]: { ...(st.live[role] as Live), progress } } })),
        });
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        const status = controller.signal.aborted ? "cancelled" : "done";
        update({ status, finishedAt: new Date().toISOString(), results, cachedCount: final.cached, errorCount: final.errors, costUsd: final.costUsd });
        const label = role === "train" ? "Training set" : "Test set";
        if (status === "done") {
          get().notify(
            final.errors
              ? `${label}: ${final.done - final.errors} of ${final.total} scored, ${final.errors} failed. Run again to retry the failures.`
              : `${label} scored: ${final.total} images (${final.cached} from cache) for $${final.costUsd.toFixed(4)}.`,
            final.errors ? "error" : "info",
          );
        }
      } catch (err) {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        const message = err instanceof Error ? err.message : String(err);
        update({ status: controller.signal.aborted ? "cancelled" : "failed", finishedAt: new Date().toISOString(), results });
        if (!controller.signal.aborted) set((st) => ({ runErrors: { ...st.runErrors, [role]: message } }));
      } finally {
        set((st) => {
          const live = { ...st.live };
          delete live[role];
          return { live };
        });
        const saved = get().runs.find((r) => r.id === run.id);
        if (saved) await db.putRun(saved);
      }
    },
    cancelRun(role) {
      get().live[role]?.controller.abort();
    },

    async loadInferences(keys) {
      const missing = [...new Set(keys)].filter((k) => !get().inferences[k]);
      if (!missing.length) return;
      const found = await db.getInferences(missing);
      const add: Record<string, Inference> = {};
      found.forEach((inf) => {
        if (inf) add[inf.cacheKey] = inf;
      });
      set((s) => ({ inferences: { ...s.inferences, ...add } }));
    },

    async importBundle(data) {
      for (const d of data.datasets ?? []) await db.putDataset(d);
      for (const p of data.prompts ?? []) await db.putPrompt(p);
      if (data.inferences?.length) await db.putInferences(data.inferences);
      for (const r of data.runs ?? []) await db.putRun(r);
      await get().hydrate();
    },
  };
});

export function promptLabel(prompt: Prompt | undefined, hash: string | undefined): string {
  return prompt ? `${prompt.name}${hash ? ` · ${shortHash(hash, 8)}` : ""}` : "No prompt";
}

/** Reasons a run cannot start: missing pieces, a prompt that does not fit the dataset, or datasets that disagree. */
export function runBlockers(s: Pick<State, "datasets" | "prompts" | "selection" | "settings" | "live" | "peek">, role: Role): string[] {
  if (s.peek) return ["You are viewing an earlier version. Switch back to your working prompt to score."];
  const dataset = s.datasets.find((d) => d.id === s.selection[role]);
  const prompt = s.prompts.find((p) => p.id === s.selection.prompt);
  if (!dataset) return [`Pick or upload a ${role === "train" ? "training" : "test"} dataset.`];
  if (!prompt) return ["Create a prompt first."];
  const problems = promptProblems(prompt, dataset.schema);
  const limit = imageLimitProblem(prompt, s.settings.model);
  if (limit) problems.push(limit);
  const mismatch = datasetMismatch(s);
  if (mismatch.blocking) problems.push(mismatch.message);
  if (!s.settings.model.trim()) problems.push("Pick a model in Settings.");
  return problems;
}

/** Training and test datasets must agree on the label being scored: same key, same type, same classes. */
export function datasetMismatch(s: Pick<State, "datasets" | "prompts" | "selection">): { blocking: boolean; message: string; details: string[] } {
  const train = s.datasets.find((d) => d.id === s.selection.train);
  const test = s.datasets.find((d) => d.id === s.selection.test);
  const prompt = s.prompts.find((p) => p.id === s.selection.prompt);
  if (!train || !test) return { blocking: false, message: "", details: [] };
  const diffs = compareSchemas(train.schema, test.schema);
  if (!diffs.length) return { blocking: false, message: "", details: [] };
  const details = diffs.map((d) => `"${d.key}" ${d.problem}`);
  const targetDiff = prompt ? diffs.find((d) => d.key === prompt.targetKey) : undefined;
  if (targetDiff) {
    return { blocking: true, message: `Training and test sets disagree on "${targetDiff.key}": ${targetDiff.problem}. Fix the datasets before running.`, details };
  }
  return { blocking: false, message: `Training and test sets have different labels (${details.join("; ")}). The scored label matches, so runs are allowed.`, details };
}
