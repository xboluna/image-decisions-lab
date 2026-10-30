"use client";
import { db } from "./db";
import { blobToDataUrl, decodeRgb, encodeRgb } from "./image";
import { modelInfo } from "./models";
import { answerProbabilities, decide } from "./openrouter";
import { applyOps, type ImageView, type Rgb } from "./ops";
import { buildQuestion, buildState, exampleViews, imagesPerRequest, inferenceKey, JPEG_QUALITY, promptViews, questionId } from "./prompt";
import type { Dataset, Inference, LabelSchema, Prompt } from "./types";

export type RunProgress = { done: number; total: number; cached: number; errors: number; costUsd: number };

export function imageCount(prompt: Prompt): number {
  return imagesPerRequest(prompt);
}

export function imageLimitProblem(prompt: Prompt, model: string): string | null {
  const max = modelInfo(model)?.maxImages;
  if (max && imageCount(prompt) > max) {
    return `${model} accepts at most ${max} images per request; this prompt sends ${imageCount(prompt)}. Remove examples or views, or pick another model.`;
  }
  return null;
}

/** Decoded source images, kept for one run so several views of one image decode it once. */
type Decoded = Map<string, Promise<Rgb>>;

function source(hash: string, cache: Decoded): Promise<Rgb> {
  let p = cache.get(hash);
  if (!p) {
    p = db.getImage(hash).then((blob) => {
      if (!blob) throw new Error("An image is missing from this browser's storage. Re-import the dataset.");
      return decodeRgb(blob);
    });
    cache.set(hash, p);
  }
  return p;
}

/** One view of an image, as the JPEG data URL sent to the model. */
export async function encodeView(hash: string, view: ImageView, prompt: Prompt, cache: Decoded = new Map()): Promise<string> {
  const { image } = applyOps(await source(hash, cache), view.ops, prompt.regions ?? []);
  return blobToDataUrl(await encodeRgb(image, prompt.imageMaxSide, JPEG_QUALITY, view.enlarge));
}

/**
 * Runs the prompt over every item, reusing cached answers for the same (prompt hash, model, image). Failed answers
 * are retried on the next run. onResult fires per item so the UI fills in as answers arrive.
 */
export async function runInference(opts: {
  dataset: Dataset;
  prompt: Prompt;
  promptHash: string;
  model: string;
  apiKey: string;
  concurrency: number;
  signal: AbortSignal;
  onResult: (itemId: string, inference: Inference, cached: boolean) => void;
  onProgress: (p: RunProgress) => void;
}): Promise<RunProgress> {
  const { dataset, prompt, promptHash, model } = opts;
  const schema = dataset.schema.find((s) => s.key === prompt.targetKey) as LabelSchema;
  const classes = schema.type === "categorical" ? schema.classes : ["true", "false"];
  const question = buildQuestion(prompt);
  const qid = questionId(prompt);
  const progress: RunProgress = { done: 0, total: dataset.items.length, cached: 0, errors: 0, costUsd: 0 };
  opts.onProgress({ ...progress });

  const keys = await Promise.all(dataset.items.map((item) => inferenceKey(promptHash, model, item.imageHash)));
  const existing = await db.getInferences(keys);
  const todo: number[] = [];
  dataset.items.forEach((item, i) => {
    const hit = existing[i];
    if (hit?.ok) {
      progress.done++;
      progress.cached++;
      opts.onResult(item.id, hit, true);
    } else todo.push(i);
  });
  opts.onProgress({ ...progress });
  if (!todo.length) return progress;
  if (!opts.apiKey) throw new Error("Add an OpenRouter API key in Settings to score images that are not cached yet.");

  const decoded: Decoded = new Map();
  let exampleUrls: string[][] | null = null;
  const examples = async () =>
    (exampleUrls ??= await Promise.all(prompt.examples.map((e) => Promise.all(exampleViews(e).map((v) => encodeView(e.imageHash, v, prompt, decoded))))));
  await examples();

  let next = 0;
  async function worker() {
    while (next < todo.length) {
      if (opts.signal.aborted) return;
      const i = todo[next++];
      const item = dataset.items[i];
      let inference: Inference;
      try {
        // A per-image cache, so one image's views share a decode without holding every image in memory.
        const targetDecoded: Decoded = new Map();
        const target = await Promise.all(promptViews(prompt).map((v) => encodeView(item.imageHash, v, prompt, targetDecoded)));
        const state = buildState(prompt, await examples(), target);
        const result = await decide({ apiKey: opts.apiKey, model, state, questionId: qid, question, signal: opts.signal });
        const probabilities = result.ok && result.answer ? answerProbabilities(result.answer, prompt.targetType, classes) : null;
        inference = {
          cacheKey: keys[i],
          imageHash: item.imageHash,
          promptHash,
          model,
          ok: !!probabilities,
          error: probabilities ? undefined : (result.error ?? "The answer had no probabilities."),
          probabilities: probabilities ?? {},
          raw: result.answer ?? result.body,
          usage: result.usage,
          latencyMs: result.latencyMs,
          requestedAt: new Date().toISOString(),
          generationId: typeof result.body.id === "string" ? result.body.id : undefined,
          servedModel: typeof result.body.model === "string" ? result.body.model : undefined,
        };
      } catch (err) {
        if (opts.signal.aborted) return;
        inference = {
          cacheKey: keys[i],
          imageHash: item.imageHash,
          promptHash,
          model,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          probabilities: {},
          raw: null,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          latencyMs: 0,
          requestedAt: new Date().toISOString(),
        };
      }
      await db.putInference(inference);
      progress.done++;
      progress.costUsd += inference.usage.costUsd;
      if (!inference.ok) progress.errors++;
      opts.onResult(item.id, inference, false);
      opts.onProgress({ ...progress });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, todo.length)) }, worker));
  return progress;
}
