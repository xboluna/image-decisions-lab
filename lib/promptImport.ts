"use client";
import { db } from "./db";
import { sha256Bytes, uid } from "./hash";
import { imageSize, mimeFor, resizeJpeg } from "./image";
import { expandZips, type FileEntry } from "./importer";
import type { Prompt, PromptExample } from "./types";

type PromptFile = {
  name?: string;
  hash?: string;
  restore?: Prompt;
  system_prompt?: string;
  target?: { key: string; type: "boolean" | "categorical" };
  question?: { instructions: string; criteria: Record<string, string> };
  image?: { max_side?: number };
  examples?: { file: string; source_file?: string; sha256: string; label: boolean | string; caption: string }[];
};

/** Reads a prompt zip made by "Download prompt": prompt.json plus its reference images. Returns a new prompt. */
export async function importPromptZip(file: Blob, existingNames: string[]): Promise<{ prompt: Prompt; warnings: string[] }> {
  const files = await expandZips([{ path: "prompt.zip", file }]);
  if (!files.some((f) => f.path === "prompt.json" || f.path.endsWith("/prompt.json"))) {
    throw new Error("This zip has no prompt.json. Use a file made by “Download prompt”.");
  }
  return importPromptFiles(files, existingNames);
}

/** Reads prompt.json and its reference images from a set of files (a prompt zip, a folder, or part of a bundle). */
export async function importPromptFiles(files: FileEntry[], existingNames: string[], jsonPath?: string): Promise<{ prompt: Prompt; warnings: string[] }> {
  const json = jsonPath ? files.find((f) => f.path === jsonPath) : files.filter((f) => f.path === "prompt.json" || f.path.endsWith("/prompt.json")).sort((x, y) => x.path.length - y.path.length)[0];
  if (!json) throw new Error("No prompt.json found.");
  const root = json.path.slice(0, json.path.length - "prompt.json".length);
  const byPath = new Map(files.map((f) => [f.path, f.file]));
  let data: PromptFile;
  try {
    data = JSON.parse(await json.file.text()) as PromptFile;
  } catch {
    throw new Error(`${json.path} is not valid JSON.`);
  }
  const warnings: string[] = [];
  const examples: PromptExample[] = [];
  for (const [i, e] of (data.examples ?? []).entries()) {
    const entry = byPath.get(root + e.file);
    if (!entry) {
      warnings.push(`Example ${i + 1} (${e.file}) is missing and was skipped.`);
      continue;
    }
    const bytes = new Uint8Array(await entry.arrayBuffer());
    const imageHash = await sha256Bytes(bytes);
    if (e.sha256 && e.sha256 !== imageHash) warnings.push(`Example ${i + 1} does not match its recorded hash; the image in the zip was used.`);
    const blob = new Blob([bytes as BlobPart], { type: mimeFor(e.file) });
    await imageSize(blob);
    if (!(await db.hasImage(imageHash))) await db.putImage(imageHash, blob, (await resizeJpeg(blob, 384, 0.8)).blob);
    examples.push({ id: uid("ex"), imageHash, fileName: e.source_file ?? e.file.split("/").pop() ?? e.file, label: e.label, caption: e.caption ?? "" });
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
    examples,
  };
  return { prompt, warnings };
}
