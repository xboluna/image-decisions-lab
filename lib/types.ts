/** A label column in a dataset. Boolean labels are yes/no; categorical labels pick one of several classes. */
export type LabelSchema =
  | { key: string; type: "boolean"; description?: string }
  | { key: string; type: "categorical"; classes: string[]; description?: string };

export type LabelValue = boolean | string | null;

export type DatasetItem = {
  /** Stable id within the dataset: the file_name from the manifest. */
  id: string;
  fileName: string;
  /** sha256 of the original image bytes; also the image's key in the image store. */
  imageHash: string;
  width: number;
  height: number;
  labels: Record<string, LabelValue>;
};

export type Dataset = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /** Content hash over schema, image hashes and labels. Renaming a dataset never changes it. */
  hash: string;
  format: "huggingface-imagefolder";
  schema: LabelSchema[];
  items: DatasetItem[];
  source?: string;
};

export type PromptExample = {
  id: string;
  imageHash: string;
  fileName: string;
  caption: string;
  /** For a boolean target: true (positive) or false (negative). For a categorical target: the class. */
  label: boolean | string;
};

export type Prompt = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  systemPrompt: string;
  /** The dataset label this harness classifies. */
  targetKey: string;
  targetType: "boolean" | "categorical";
  instructions: string;
  /** boolean: { true, false }. categorical: one description per class. */
  criteria: Record<string, string>;
  examples: PromptExample[];
  /** Longest image side, in pixels, of every JPEG sent to the model (examples and the evaluated image). */
  imageMaxSide: number;
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type Usage = { inputTokens: number; outputTokens: number; costUsd: number };

/** One model answer for one image, cached by (prompt hash, model, image hash). */
export type Inference = {
  cacheKey: string;
  imageHash: string;
  promptHash: string;
  model: string;
  ok: boolean;
  error?: string;
  /** Probability per class. Boolean targets use the keys "true" and "false". */
  probabilities: Record<string, number>;
  raw: unknown;
  usage: Usage;
  latencyMs: number;
  requestedAt: string;
  generationId?: string;
  servedModel?: string;
};

export type RunStatus = "running" | "done" | "cancelled" | "failed";

export type Run = {
  id: string;
  role: "train" | "test";
  datasetId: string;
  datasetHash: string;
  datasetName: string;
  promptId: string;
  promptHash: string;
  promptName: string;
  model: string;
  targetKey: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  /** Item id -> inference cache key. */
  results: Record<string, string>;
  /** The exact prompt that was scored, so any earlier version can be viewed again. Missing on older runs. */
  promptSnapshot?: Prompt;
  cachedCount: number;
  errorCount: number;
  costUsd: number;
};

/** How dataset classes are scored. Each original class maps to a group name, or null to exclude it. */
export type ClassMapping = Record<string, string | null>;

export type Settings = {
  apiKey: string;
  model: string;
  concurrency: number;
  /** Show AUROC, cross-validated and macro balanced accuracy under the core metrics. */
  advancedMetrics: boolean;
};
