"use client";
import JSZip from "jszip";
import { db } from "./db";
import { sha256Bytes, uid } from "./hash";
import { imageSize, mimeFor, resizeJpeg } from "./image";
import type { ImageOp, ImageView, Region } from "./ops";
import type { Prompt, PromptExample } from "./types";

type PromptFile = {
  name?: string;
  hash?: string;
  restore?: Prompt;
  system_prompt?: string;
  target?: { key: string; type: "boolean" | "categorical" };
  question?: { instructions: string; criteria: Record<string, string> };
  image?: { max_side?: number };
  examples?: { file: string; source_file?: string; sha256: string; label: boolean | string; caption: string; ops?: ImageOp[] }[];
  regions?: Region[];
  views?: ImageView[];
};

/** Reads a prompt zip made by "Download prompt": prompt.json plus its reference images. Returns a new prompt. */
export async function importPromptZip(file: Blob, existingNames: string[]): Promise<{ prompt: Prompt; warnings: string[] }> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const jsonPath = Object.keys(zip.files).find((n) => n === "prompt.json" || n.endsWith("/prompt.json"));
  if (!jsonPath) throw new Error("This zip has no prompt.json. Use a file made by “Download prompt”.");
  const root = jsonPath.slice(0, jsonPath.length - "prompt.json".length);
  let data: PromptFile;
  try {
    data = JSON.parse(await zip.files[jsonPath].async("string")) as PromptFile;
  } catch {
    throw new Error("prompt.json is not valid JSON.");
  }
  const warnings: string[] = [];
  const examples: PromptExample[] = [];
  for (const [i, e] of (data.examples ?? []).entries()) {
    const entry = zip.files[root + e.file];
    if (!entry) {
      warnings.push(`Example ${i + 1} (${e.file}) is missing from the zip and was skipped.`);
      continue;
    }
    const bytes = await entry.async("uint8array");
    const imageHash = await sha256Bytes(bytes);
    if (e.sha256 && e.sha256 !== imageHash) warnings.push(`Example ${i + 1} does not match its recorded hash; the image in the zip was used.`);
    const blob = new Blob([bytes as BlobPart], { type: mimeFor(e.file) });
    await imageSize(blob);
    if (!(await db.hasImage(imageHash))) await db.putImage(imageHash, blob, (await resizeJpeg(blob, 384, 0.8)).blob);
    examples.push({ id: uid("ex"), imageHash, fileName: e.source_file ?? e.file.split("/").pop() ?? e.file, label: e.label, caption: e.caption ?? "", ...(e.ops?.length ? { ops: e.ops } : {}) });
  }
  const r = data.restore;
  const base = r ?? {
    systemPrompt: data.system_prompt ?? "",
    targetKey: data.target?.key ?? "",
    targetType: data.target?.type ?? "boolean",
    instructions: data.question?.instructions ?? "",
    criteria: data.question?.criteria ?? {},
    imageMaxSide: data.image?.max_side ?? 1024,
  };
  let name = (r?.name ?? data.name ?? "Imported prompt").trim();
  if (existingNames.includes(name)) name = `${name} (imported)`;
  const now = new Date().toISOString();
  const prompt: Prompt = {
    id: uid("pr"),
    name,
    createdAt: now,
    updatedAt: now,
    systemPrompt: base.systemPrompt,
    targetKey: base.targetKey,
    targetType: base.targetType,
    instructions: base.instructions,
    criteria: base.criteria,
    imageMaxSide: base.imageMaxSide ?? 1024,
    regions: r?.regions ?? data.regions ?? [],
    views: r?.views ?? data.views ?? [],
    examples,
  };
  return { prompt, warnings };
}
