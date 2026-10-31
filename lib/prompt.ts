import { sha256Json } from "./hash";
import { describeOps, type ImageView } from "./ops";
import type { ContentPart, LabelSchema, Prompt, PromptExample, Run } from "./types";

/** Bumped whenever the way a prompt becomes a request changes, so old cached answers are never reused. */
export const STATE_TEMPLATE_VERSION = 2;
/** Pillow's quality scale (1-100). */
export const JPEG_QUALITY = 85;
/**
 * Names the image pipeline (lib/modelImage.ts, scripts/reference_pipeline.py) in prompt hashes and exports. Change it
 * whenever the bytes sent for the same image could change.
 */
export const IMAGE_PIPELINE = "pillow-thumbnail-bicubic/libjpeg-turbo-q85-420";

export type DecisionQuestion = { type: "noul" | "choice"; instructions: string; criteria: Record<string, string> };

/** The decision question id: the label key, reduced to the characters the API accepts. */
export function questionId(prompt: Pick<Prompt, "targetKey">): string {
  return prompt.targetKey.replace(/[^A-Za-z0-9_]/g, "_") || "label";
}

export function buildQuestion(prompt: Prompt): DecisionQuestion {
  if (prompt.targetType === "boolean") {
    return { type: "noul", instructions: prompt.instructions, criteria: { true: prompt.criteria.true ?? "Yes.", false: prompt.criteria.false ?? "No." } };
  }
  return { type: "choice", instructions: prompt.instructions, criteria: { ...prompt.criteria } };
}

export function exampleText(prompt: Prompt, example: PromptExample, index: number): string {
  const head =
    prompt.targetType === "boolean"
      ? `Reference example ${index + 1} — ${example.label === true ? "POSITIVE (the answer is yes)" : "NEGATIVE (the answer is no)"}.`
      : `Reference example ${index + 1} — the answer is "${String(example.label)}".`;
  return example.caption.trim() ? `${head} ${example.caption.trim()}` : head;
}

export const WHOLE_IMAGE: ImageView = { id: "whole", caption: "", ops: [], enlarge: false };

/** The images sent for each image under evaluation. A prompt without views sends the whole image once. */
export function promptViews(prompt: Pick<Prompt, "views">): ImageView[] {
  return prompt.views?.length ? prompt.views : [WHOLE_IMAGE];
}

/** How a reference example is sent: with its own edits, if it has any, else whole. Views apply only to the image under evaluation. */
export function exampleViews(example: Pick<PromptExample, "ops">): ImageView[] {
  return example.ops?.length ? [{ id: "example", caption: "", ops: example.ops, enlarge: false }] : [WHOLE_IMAGE];
}

/** True when the prompt uses any image operation; plain prompts keep the request layout (and hashes) they always had. */
export function usesImageViews(prompt: Prompt): boolean {
  const views = promptViews(prompt);
  return views.length > 1 || views.some((v) => v.ops.length || v.caption.trim() || v.enlarge) || !!prompt.regions?.length || prompt.examples.some((e) => e.ops?.length);
}

export function imagesPerRequest(prompt: Prompt): number {
  return promptViews(prompt).length + prompt.examples.length;
}

/** Text introducing one view's image when an image is sent as several views. */
export function viewCaption(view: ImageView, index: number, prompt: Pick<Prompt, "regions">): string {
  return view.caption.trim() || `View ${index + 1}: ${describeOps(view.ops, prompt.regions ?? []).toLowerCase()}.`;
}

/**
 * The request's state: system prompt, then each reference example (caption, image), then the image to classify as
 * one image per view. Images are given as data URLs (a one-image list per example, one per target view) by the
 * caller, so the same function builds the real request and the export preview.
 */
export function buildState(prompt: Prompt, exampleImages: string[][], targetImages: string[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (prompt.systemPrompt.trim()) parts.push({ type: "text", text: prompt.systemPrompt.trim() });
  prompt.examples.forEach((example, i) => {
    parts.push({ type: "text", text: exampleText(prompt, example, i) });
    parts.push({ type: "image_url", image_url: { url: exampleImages[i][0] } });
  });
  parts.push({ type: "text", text: prompt.examples.length ? "Now the image to evaluate. It is not one of the reference examples." : "The image to evaluate:" });
  const views = promptViews(prompt);
  views.forEach((view, k) => {
    if (views.length > 1 || view.caption.trim()) parts.push({ type: "text", text: viewCaption(view, k, prompt) });
    parts.push({ type: "image_url", image_url: { url: targetImages[k] } });
  });
  return parts;
}

/**
 * What the model is sent, without the model: every input that changes the request's state and question. The prompt's
 * name never changes it. Cached answers are keyed by this and the model (inferenceKey), so answers stored before
 * prompts carried their model stay valid.
 */
export function contentHash(prompt: Prompt): Promise<string> {
  const views = usesImageViews(prompt);
  return sha256Json({
    template: STATE_TEMPLATE_VERSION,
    jpegQuality: JPEG_QUALITY,
    imagePipeline: IMAGE_PIPELINE,
    imageMaxSide: prompt.imageMaxSide,
    systemPrompt: prompt.systemPrompt.trim(),
    targetKey: prompt.targetKey,
    questionId: questionId(prompt),
    question: buildQuestion(prompt),
    examples: prompt.examples.map((e, i) => ({ image: e.imageHash, text: exampleText(prompt, e, i), ...(views && e.ops?.length ? { ops: e.ops } : {}) })),
    // Only prompts that use views hash them, so every earlier prompt keeps its hash and cached answers.
    ...(views
      ? {
          // exactly the caption text sent: buildState sends one only for several views or a custom caption
          views: promptViews(prompt).map((v, k, all) => ({ caption: all.length > 1 || v.caption.trim() ? viewCaption(v, k, prompt) : null, ops: v.ops, enlarge: v.enlarge })),
          regions: (prompt.regions ?? []).map((r) => ({ id: r.id, box: r.box })),
        }
      : {}),
  });
}

/** The model a prompt is sent to: its own, or `fallback` for a prompt saved before prompts carried one. */
export function promptModel(prompt: Pick<Prompt, "model">, fallback: string): string {
  return prompt.model?.trim() || fallback;
}

/** The prompt version from its content hash and model: a model change is a prompt change. */
export function versionHash(content: string, model: string): Promise<string> {
  return sha256Json({ content, model });
}

/** The prompt version: its content and the model it is sent to (`fallbackModel` when the prompt names none). */
export async function promptHash(prompt: Prompt, fallbackModel: string): Promise<string> {
  return versionHash(await contentHash(prompt), promptModel(prompt, fallbackModel));
}

/**
 * Runs stored before prompts carried their model recorded the content hash as their prompt hash. Returns the run with
 * its version hash and content hash (and its snapshot given the run's model), or null when it is already current.
 */
export async function upgradeRun(run: Run): Promise<Run | null> {
  if (run.contentHash) return null;
  const content = run.promptHash;
  const snapshot = run.promptSnapshot && !run.promptSnapshot.model ? { ...run.promptSnapshot, model: run.model } : run.promptSnapshot;
  return { ...run, contentHash: content, promptHash: await versionHash(content, run.model), ...(snapshot ? { promptSnapshot: snapshot } : {}) };
}

/** The key of one cached answer: the prompt's content hash, the model and the image. */
export function inferenceKey(content: string, model: string, imageHash: string): Promise<string> {
  return sha256Json({ prompt: content, model, image: imageHash });
}

/** Default question text for a label, used when a prompt is pointed at a new target. */
export function defaultQuestion(schema: LabelSchema): Pick<Prompt, "targetKey" | "targetType" | "instructions" | "criteria"> {
  const words = schema.key.replace(/[_-]+/g, " ").trim();
  if (schema.type === "boolean") {
    return {
      targetKey: schema.key,
      targetType: "boolean",
      instructions: schema.description || `In this image, is it true that: ${words}?`,
      criteria: { true: `Yes: ${words}.`, false: `No: not ${words}.` },
    };
  }
  return {
    targetKey: schema.key,
    targetType: "categorical",
    instructions: schema.description || `Which ${words} does this image show?`,
    criteria: Object.fromEntries(schema.classes.map((c) => [c, c.replace(/[_-]+/g, " ")])),
  };
}

/** Problems that make a prompt unusable against a dataset schema. Empty when it can run. */
export function promptProblems(prompt: Prompt, schema: LabelSchema[] | undefined): string[] {
  const problems: string[] = [];
  if (!prompt.targetKey) return ["Pick the label this prompt classifies."];
  if (!prompt.instructions.trim()) problems.push("The question is empty.");
  if (!schema) return problems;
  const s = schema.find((x) => x.key === prompt.targetKey);
  if (!s) return [...problems, `The dataset has no "${prompt.targetKey}" label.`];
  if (s.type !== prompt.targetType) problems.push(`"${prompt.targetKey}" is ${s.type} in the dataset but the prompt treats it as ${prompt.targetType}.`);
  if (s.type === "categorical") {
    const missing = s.classes.filter((c) => !(c in prompt.criteria));
    const extra = Object.keys(prompt.criteria).filter((c) => !s.classes.includes(c));
    if (missing.length) problems.push(`The question has no option for ${missing.map((c) => `"${c}"`).join(", ")}.`);
    if (extra.length) problems.push(`The question offers ${extra.map((c) => `"${c}"`).join(", ")}, which the dataset never uses.`);
    const badExamples = prompt.examples.filter((e) => typeof e.label !== "string" || !s.classes.includes(e.label));
    if (badExamples.length) problems.push(`${badExamples.length} reference example${badExamples.length === 1 ? " has" : "s have"} a class the dataset does not use.`);
  }
  return problems;
}
