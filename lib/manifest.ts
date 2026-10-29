import { sha256Json } from "./hash";
import type { DatasetItem, LabelSchema, LabelValue } from "./types";

/**
 * Dataset format: the Hugging Face "ImageFolder with metadata" layout, the most widely used way to ship an image
 * classification dataset with arbitrary per-image labels.
 *
 *   my-dataset/
 *     metadata.jsonl      one JSON object per image: {"file_name": "images/a.jpg", "is_open": true, "kind": "pcr"}
 *     images/a.jpg ...
 *     dataset.json        optional: name, description and the label schema (class order, descriptions)
 *
 * metadata.csv with a file_name column is accepted too. JSON booleans (or true/false, yes/no, 0/1 in CSV) make a
 * boolean label; strings make a categorical label. Every other column is ignored.
 */
export const MANIFEST_NAMES = ["metadata.jsonl", "metadata.csv"] as const;
export const SIDECAR_NAME = "dataset.json";
export const FORMAT_DOC_URL = "https://huggingface.co/docs/datasets/image_dataset#imagefolder";

export type ManifestRow = { fileName: string; values: Record<string, unknown> };
export type ParsedManifest = { rows: ManifestRow[]; warnings: string[] };

export type Sidecar = {
  name?: string;
  description?: string;
  schema?: LabelSchema[];
};

export function parseJsonl(text: string): ParsedManifest {
  const rows: ManifestRow[] = [];
  const warnings: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      warnings.push(`Line ${index + 1} is not valid JSON and was skipped.`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      warnings.push(`Line ${index + 1} is not a JSON object and was skipped.`);
      return;
    }
    const record = obj as Record<string, unknown>;
    const fileName = record.file_name;
    if (typeof fileName !== "string" || !fileName) {
      warnings.push(`Line ${index + 1} has no file_name and was skipped.`);
      return;
    }
    const values = { ...record };
    delete values.file_name;
    rows.push({ fileName: normalizePath(fileName), values });
  });
  return { rows, warnings };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function parseCsv(text: string): ParsedManifest {
  const table = parseCsvRows(text.replace(/^﻿/, ""));
  const warnings: string[] = [];
  if (!table.length) return { rows: [], warnings: ["metadata.csv is empty."] };
  const header = table[0].map((h) => h.trim());
  const fileCol = header.indexOf("file_name");
  if (fileCol < 0) return { rows: [], warnings: ["metadata.csv has no file_name column."] };
  const rows: ManifestRow[] = [];
  table.slice(1).forEach((cells, index) => {
    const fileName = (cells[fileCol] ?? "").trim();
    if (!fileName) {
      warnings.push(`Row ${index + 2} has no file_name and was skipped.`);
      return;
    }
    const values: Record<string, unknown> = {};
    header.forEach((h, col) => {
      if (col !== fileCol && h) values[h] = cells[col] ?? "";
    });
    rows.push({ fileName: normalizePath(fileName), values });
  });
  return { rows, warnings };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

const TRUE_WORDS = new Set(["true", "yes", "1", "y", "t"]);
const FALSE_WORDS = new Set(["false", "no", "0", "n", "f"]);
const EMPTY_WORDS = new Set(["", "null", "none", "nan", "na", "n/a"]);

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === "string" && EMPTY_WORDS.has(v.trim().toLowerCase()));
}

/** Infers boolean and categorical labels from the manifest values. A sidecar schema wins where it names a column. */
export function inferSchema(rows: ManifestRow[], sidecar?: Sidecar): { schema: LabelSchema[]; warnings: string[] } {
  const warnings: string[] = [];
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row.values)) if (!columns.includes(key)) columns.push(key);
  const declared = new Map((sidecar?.schema ?? []).map((s) => [s.key, s]));
  const schema: LabelSchema[] = [];
  for (const key of columns) {
    const present = rows.map((r) => r.values[key]).filter((v) => !isEmpty(v));
    if (!present.length) {
      warnings.push(`Column "${key}" is empty and was ignored.`);
      continue;
    }
    const decl = declared.get(key);
    const allBool = present.every(
      (v) => typeof v === "boolean" || (typeof v === "string" && (TRUE_WORDS.has(v.trim().toLowerCase()) || FALSE_WORDS.has(v.trim().toLowerCase()))) || v === 0 || v === 1,
    );
    if (decl?.type === "boolean" || (!decl && allBool)) {
      schema.push({ key, type: "boolean", description: decl?.description });
      continue;
    }
    const allText = present.every((v) => typeof v === "string" || typeof v === "number");
    if (!allText) {
      warnings.push(`Column "${key}" holds lists or objects and was ignored. Use one boolean or one class per column.`);
      continue;
    }
    if (!decl && present.every((v) => typeof v === "number")) {
      warnings.push(`Column "${key}" is numeric and was ignored. Use strings for class names.`);
      continue;
    }
    const seen = [...new Set(present.map((v) => String(v).trim()))];
    const declaredClasses = decl?.type === "categorical" ? decl.classes : [];
    const classes = [...declaredClasses, ...seen.filter((c) => !declaredClasses.includes(c)).sort()];
    if (classes.length < 2) warnings.push(`Column "${key}" has a single class ("${classes[0]}"), so it cannot be scored on its own.`);
    if (classes.length > 50) {
      warnings.push(`Column "${key}" has ${classes.length} distinct values and looks like free text; it was ignored.`);
      continue;
    }
    schema.push({ key, type: "categorical", classes, description: decl?.description });
  }
  return { schema, warnings };
}

export function coerceLabel(schema: LabelSchema, raw: unknown): LabelValue {
  if (isEmpty(raw)) return null;
  if (schema.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === 1) return true;
    if (raw === 0) return false;
    const word = String(raw).trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    return null;
  }
  const value = String(raw).trim();
  return schema.classes.includes(value) ? value : null;
}

/** The dataset version. Covers the label schema, every image's bytes (by hash) and every label; never the name. */
export async function datasetHash(schema: LabelSchema[], items: Pick<DatasetItem, "fileName" | "imageHash" | "labels">[]): Promise<string> {
  const sorted = [...items].sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return sha256Json({
    format: "huggingface-imagefolder/v1",
    schema: schema.map((s) => (s.type === "boolean" ? { key: s.key, type: s.type } : { key: s.key, type: s.type, classes: s.classes })),
    items: sorted.map((i) => ({ file: i.fileName, sha256: i.imageHash, labels: i.labels })),
  });
}

export function manifestJsonl(items: DatasetItem[], schema: LabelSchema[]): string {
  return (
    items
      .map((item) => {
        const row: Record<string, unknown> = { file_name: item.fileName };
        for (const s of schema) row[s.key] = item.labels[s.key] ?? null;
        return JSON.stringify(row);
      })
      .join("\n") + "\n"
  );
}

export type SchemaDiff = { key: string; problem: string };

/** Differences between two dataset schemas, for the label a harness is scored on and for every other label. */
export function compareSchemas(a: LabelSchema[], b: LabelSchema[]): SchemaDiff[] {
  const diffs: SchemaDiff[] = [];
  const bMap = new Map(b.map((s) => [s.key, s]));
  const aMap = new Map(a.map((s) => [s.key, s]));
  for (const s of a) {
    const other = bMap.get(s.key);
    if (!other) {
      diffs.push({ key: s.key, problem: `missing from the other dataset` });
      continue;
    }
    if (other.type !== s.type) {
      diffs.push({ key: s.key, problem: `is ${s.type} in one dataset and ${other.type} in the other` });
      continue;
    }
    if (s.type === "categorical" && other.type === "categorical") {
      const onlyA = s.classes.filter((c) => !other.classes.includes(c));
      const onlyB = other.classes.filter((c) => !s.classes.includes(c));
      if (onlyA.length || onlyB.length) {
        const parts = [onlyA.length ? `only in one: ${onlyA.join(", ")}` : "", onlyB.length ? `only in the other: ${onlyB.join(", ")}` : ""].filter(Boolean);
        diffs.push({ key: s.key, problem: `classes differ (${parts.join("; ")})` });
      }
    }
  }
  for (const s of b) if (!aMap.has(s.key)) diffs.push({ key: s.key, problem: `missing from the other dataset` });
  return diffs;
}
