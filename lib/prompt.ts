import { sha256Json } from "./hash";
import type { ContentPart, LabelSchema, Prompt, PromptExample } from "./types";

/** Bumped whenever the way a prompt becomes a request changes, so old cached answers are never reused. */
export const STATE_TEMPLATE_VERSION = 1;
export const JPEG_QUALITY = 0.85;

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

/**
 * The request's state: system prompt, then each reference example (caption, image), then the image to classify.
 * Images are given as data URLs by the caller, so the same function builds the real request and the export preview.
 */
export function buildState(prompt: Prompt, exampleUrls: string[], targetUrl: string): ContentPart[] {
  const parts: ContentPart[] = [];
  if (prompt.systemPrompt.trim()) parts.push({ type: "text", text: prompt.systemPrompt.trim() });
  prompt.examples.forEach((example, i) => {
    parts.push({ type: "text", text: exampleText(prompt, example, i) });
    parts.push({ type: "image_url", image_url: { url: exampleUrls[i] } });
  });
  parts.push({ type: "text", text: prompt.examples.length ? "Now the image to evaluate. It is not one of the reference examples." : "The image to evaluate:" });
  parts.push({ type: "image_url", image_url: { url: targetUrl } });
  return parts;
}

/** The prompt version: every input that changes what the model is sent. The prompt's name never changes it. */
export function promptHash(prompt: Prompt): Promise<string> {
  return sha256Json({
    template: STATE_TEMPLATE_VERSION,
    jpegQuality: JPEG_QUALITY,
    imageMaxSide: prompt.imageMaxSide,
    systemPrompt: prompt.systemPrompt.trim(),
    targetKey: prompt.targetKey,
    questionId: questionId(prompt),
    question: buildQuestion(prompt),
    examples: prompt.examples.map((e, i) => ({ image: e.imageHash, text: exampleText(prompt, e, i) })),
  });
}

export function inferenceKey(promptHashValue: string, model: string, imageHash: string): Promise<string> {
  return sha256Json({ prompt: promptHashValue, model, image: imageHash });
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
