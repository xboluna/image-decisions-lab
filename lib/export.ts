"use client";
import JSZip from "jszip";
import type { Analysis, ThresholdInfo } from "./analysis";
import { db } from "./db";
import { shortHash } from "./hash";
import { manifestJsonl } from "./manifest";
import { pairedRows } from "./compare";
import { ALL, computeAdvanced } from "./metrics";
import { buildQuestion, buildState, questionId, STATE_TEMPLATE_VERSION, JPEG_QUALITY } from "./prompt";
import type { ClassMapping, Dataset, Prompt } from "./types";

export const TOOL = { name: "Image Decisions Lab", version: "0.1.0" };

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "untitled";
}

function datasetCard(d: Dataset) {
  return {
    format: "huggingface-imagefolder",
    format_doc: "https://huggingface.co/docs/datasets/image_dataset#imagefolder",
    name: d.name,
    description: d.description,
    hash: `sha256:${d.hash}`,
    created_at: d.createdAt,
    items: d.items.length,
    schema: d.schema,
    label_counts: Object.fromEntries(
      d.schema.map((s) => {
        const counts: Record<string, number> = {};
        for (const item of d.items) {
          const v = item.labels[s.key];
          const k = v == null ? "(missing)" : String(v);
          counts[k] = (counts[k] ?? 0) + 1;
        }
        return [s.key, counts];
      }),
    ),
    exported_by: TOOL,
  };
}

async function addDataset(zip: JSZip, d: Dataset, withImages: boolean) {
  zip.file("metadata.jsonl", manifestJsonl(d.items, d.schema));
  zip.file("dataset.json", JSON.stringify(datasetCard(d), null, 2));
  if (!withImages) return;
  for (const item of d.items) {
    const blob = await db.getImage(item.imageHash);
    if (blob) zip.file(item.fileName, blob);
  }
}

/** The dataset in the same layout it was uploaded in, plus dataset.json with its hash and label counts. */
export async function exportDataset(d: Dataset) {
  const zip = new JSZip();
  const folder = zip.folder(`${slug(d.name)}-${shortHash(d.hash, 8)}`) as JSZip;
  await addDataset(folder, d, true);
  downloadBlob(await zip.generateAsync({ type: "blob" }), `${slug(d.name)}-${shortHash(d.hash, 8)}.zip`);
}

function examplePath(i: number, fileName: string) {
  return `examples/${String(i + 1).padStart(2, "0")}-${fileName.split("/").pop()}`;
}

export function promptRecord(prompt: Prompt, hash: string) {
  return {
    name: prompt.name,
    hash: `sha256:${hash}`,
    state_template_version: STATE_TEMPLATE_VERSION,
    image: { max_side: prompt.imageMaxSide, format: "jpeg", quality: JPEG_QUALITY },
    system_prompt: prompt.systemPrompt,
    target: { key: prompt.targetKey, type: prompt.targetType },
    question_id: questionId(prompt),
    question: buildQuestion(prompt),
    examples: prompt.examples.map((e, i) => ({ file: examplePath(i, e.fileName), source_file: e.fileName, sha256: e.imageHash, label: e.label, caption: e.caption })),
    /** The exact request body sent per image, with images written as references. */
    request_preview: {
      model: "<model>",
      state: buildState(prompt, prompt.examples.map((e, i) => `<${examplePath(i, e.fileName)} as JPEG data URL>`), "<image under evaluation as JPEG data URL>"),
      questions: { [questionId(prompt)]: buildQuestion(prompt) },
    },
    updated_at: prompt.updatedAt,
  };
}

async function addPrompt(zip: JSZip, prompt: Prompt, hash: string) {
  zip.file("prompt.json", JSON.stringify({ ...promptRecord(prompt, hash), restore: prompt }, null, 2));
  for (const [i, e] of prompt.examples.entries()) {
    const blob = await db.getImage(e.imageHash);
    if (blob) zip.file(examplePath(i, e.fileName), blob);
  }
}

export async function exportPrompt(prompt: Prompt, hash: string) {
  const zip = new JSZip();
  await addPrompt(zip, prompt, hash);
  downloadBlob(await zip.generateAsync({ type: "blob" }), `prompt-${slug(prompt.name)}-${shortHash(hash, 8)}.zip`);
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function predictions(a: Analysis, prompt: Prompt) {
  return a.dataset.items.map((item) => {
    const row = a.rowById.get(item.id);
    const inf = a.inferenceById.get(item.id);
    return {
      file_name: item.fileName,
      image_sha256: item.imageHash,
      label: item.labels[prompt.targetKey] ?? null,
      label_scored_as: row?.gt ?? null,
      status: row?.status ?? "pending",
      predicted: row?.pred ?? null,
      predicted_positive: row?.predPositive ?? null,
      score: row?.score ?? null,
      outcome: row?.outcome ?? null,
      low_confidence: row?.lowConfidence ?? false,
      probabilities: row?.probs ?? null,
      raw_probabilities: inf?.probabilities ?? null,
      raw_answer: inf?.raw ?? null,
      error: inf?.error ?? null,
      cost_usd: inf?.usage.costUsd ?? null,
      input_tokens: inf?.usage.inputTokens ?? null,
      latency_ms: inf?.latencyMs ?? null,
      requested_at: inf?.requestedAt ?? null,
      generation_id: inf?.generationId ?? null,
      served_model: inf?.servedModel ?? null,
      cache_key: inf?.cacheKey ?? null,
    };
  });
}

function predictionsCsv(rows: ReturnType<typeof predictions>, groups: string[]): string {
  const head = ["file_name", "image_sha256", "label", "label_scored_as", "status", "predicted", "score", "outcome", "low_confidence", ...groups.map((g) => `p_${g}`), "cost_usd", "latency_ms", "error"];
  const lines = rows.map((r) =>
    [r.file_name, r.image_sha256, r.label, r.label_scored_as, r.status, r.predicted, r.score, r.outcome, r.low_confidence, ...groups.map((g) => r.probabilities?.[g]), r.cost_usd, r.latency_ms, r.error]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

/** Inlines computed colours and fonts so a chart's SVG renders the same outside the page (no CSS variables left). */
export function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const dst = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const paint = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity"];
  const font = ["font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline"];
  src.forEach((el, i) => {
    const out = dst[i] as Element;
    const cs = getComputedStyle(el);
    for (const attr of Array.from(out.attributes)) {
      if (attr.value.includes("var(") || attr.name === "class" || attr.name.startsWith("data-") || attr.name.startsWith("aria-") || attr.name === "role" || attr.name === "tabindex" || attr.name === "style") out.removeAttribute(attr.name);
    }
    if (i === 0) return;
    const props = el.tagName === "text" ? [...paint, ...font] : el.tagName === "g" || el.tagName === "title" ? [] : paint;
    for (const p of props) {
      const v = cs.getPropertyValue(p);
      if (v && v !== "none" && !(p === "opacity" && v === "1") && !(p === "stroke-dasharray" && v === "none")) out.setAttribute(p, v);
      else if (p === "fill" || p === "stroke") out.setAttribute(p, v || "none");
    }
  });
  const box = svg.getBoundingClientRect();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.round(box.width)));
  clone.setAttribute("height", String(Math.round(box.height)));
  clone.setAttribute("viewBox", `0 0 ${Math.round(box.width)} ${Math.round(box.height)}`);
  const bg = getComputedStyle(svg.closest("[data-chart-surface]") ?? document.body).backgroundColor;
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", "100%");
  rect.setAttribute("height", "100%");
  rect.setAttribute("fill", bg);
  clone.insertBefore(rect, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Robust metrics for the export: the same values the Advanced metrics tiles show. */
function advancedRecord(a: Analysis, mapping: ClassMapping) {
  const m = computeAdvanced(a.rows, a.target, mapping, a.view);
  return {
    auroc: m.auroc,
    cross_validated_balanced_accuracy: a.role === "train" ? m.crossValidatedBa : null,
    macro_balanced_accuracy: m.macroBa,
    macro_classes: m.macroClasses,
    notes: {
      auroc: a.view.mode === "binary" ? "Mann-Whitney on the positive score; ties count half" : "one-vs-rest average over classes with both cases",
      cross_validated_balanced_accuracy:
        a.role !== "train" ? "not computed: the test set uses the training threshold" : a.view.mode !== "binary" ? "not computed: the all-classes view fits no threshold" : "threshold fitted on one fixed half, scored on the other, both ways; halves stratified by class, ordered by a mixed hash of the image id",
      macro_balanced_accuracy: "one-vs-rest balanced accuracy per class, averaged over classes with at least 3 images",
    },
  };
}

/** The version every delta is measured against, and both versions' metrics on the images scored in both. */
function comparisonRecord(a: Analysis, mapping: ClassMapping, advanced: boolean) {
  const b = a.baseline;
  if (!b) return null;
  const paired = pairedRows(b.rows, a.rows);
  const delta = (x: number | null | undefined, y: number | null | undefined) => (x != null && y != null ? x - y : null);
  return {
    compared_against: { prompt_name: b.run.promptName, prompt_hash: `sha256:${b.run.promptHash}`, model: b.run.model, run_id: b.run.id, complete_run: b.complete },
    paired_images: b.paired,
    before: b.before,
    after: b.after,
    deltas: { balanced_accuracy: delta(b.after.balancedAccuracy, b.before.balancedAccuracy), accuracy: delta(b.after.accuracy, b.before.accuracy) },
    ...(advanced
      ? (() => {
          const x = computeAdvanced(paired.after, a.target, mapping, a.view);
          const y = computeAdvanced(paired.before, a.target, mapping, a.view);
          return { advanced_deltas: { auroc: delta(x.auroc, y.auroc), macro_balanced_accuracy: delta(x.macroBa, y.macroBa) } };
        })()
      : {}),
  };
}

function metricsRecord(a: Analysis, threshold: ThresholdInfo, mapping: ClassMapping, advanced: boolean) {
  return {
    run: { id: a.run.id, status: a.run.status, started_at: a.run.startedAt, finished_at: a.run.finishedAt, model: a.run.model, prompt_hash: `sha256:${a.run.promptHash}`, dataset_hash: `sha256:${a.run.datasetHash}`, cost_usd: a.run.costUsd, cached: a.run.cachedCount },
    stale: a.stale,
    view: a.view.mode === "binary" ? { mode: "binary", positive_class: a.view.positive } : { mode: "multiclass" },
    threshold: { value: threshold.value, fitted_on_training_set: threshold.fitted, source: threshold.source, meaning: a.view.mode === "binary" ? "score >= threshold is called positive" : "answers below this top-class probability are flagged for review" },
    metrics: a.metrics,
    ...(advanced ? { advanced_metrics: advancedRecord(a, mapping) } : {}),
    comparison: comparisonRecord(a, mapping, advanced),
    confusion_matrix: { rows_are: "actual", columns_are: "predicted", labels: a.confusion.labels, cells: a.confusion.cells },
    pr_curves: a.curves.map((c) => ({ class: c.key === ALL ? "micro-average" : c.key, average_precision: c.ap, positives: c.positives, points: c.points })),
    histogram: { bin_edges: a.hist.edges, series: a.hist.series },
  };
}

/** Everything needed to reproduce and audit the experiment: datasets, prompt, per-image answers, metrics, charts. */
export async function exportExperiment(opts: {
  prompt: Prompt;
  promptHash: string;
  model: string;
  mapping: ClassMapping;
  focus: string;
  threshold: ThresholdInfo;
  train: Analysis | null;
  test: Analysis | null;
  trainDataset?: Dataset;
  testDataset?: Dataset;
  includeImages: boolean;
  /** Add AUROC, cross-validated and macro balanced accuracy to metrics.json and experiment.json. */
  advancedMetrics: boolean;
}) {
  const zip = new JSZip();
  const { prompt, promptHash: hash } = opts;
  const name = `experiment-${slug(prompt.name)}-${shortHash(hash, 8)}`;
  const root = zip.folder(name) as JSZip;
  await addPrompt(root.folder("prompt") as JSZip, prompt, hash);
  const sets: [string, Analysis | null, Dataset | undefined][] = [
    ["train", opts.train, opts.trainDataset],
    ["test", opts.test, opts.testDataset],
  ];
  const summary: Record<string, unknown> = {};
  for (const [role, a, d] of sets) {
    if (d) await addDataset(root.folder(`datasets/${role}`) as JSZip, d, opts.includeImages);
    if (!a) continue;
    const folder = root.folder(`results/${role}`) as JSZip;
    const preds = predictions(a, prompt);
    folder.file("predictions.jsonl", preds.map((p) => JSON.stringify(p)).join("\n") + "\n");
    folder.file("predictions.csv", predictionsCsv(preds, a.groups));
    const m = metricsRecord(a, opts.threshold, opts.mapping, opts.advancedMetrics);
    folder.file("metrics.json", JSON.stringify(m, null, 2));
    summary[role] = {
      dataset: a.dataset.name,
      dataset_hash: `sha256:${a.dataset.hash}`,
      run_id: a.run.id,
      prompt_hash: `sha256:${a.run.promptHash}`,
      model: a.run.model,
      stale: a.stale,
      accuracy: a.metrics.accuracy,
      balanced_accuracy: a.metrics.balancedAccuracy,
      n: a.metrics.n,
      ...(m.advanced_metrics
        ? { auroc: m.advanced_metrics.auroc, cross_validated_balanced_accuracy: m.advanced_metrics.cross_validated_balanced_accuracy, macro_balanced_accuracy: m.advanced_metrics.macro_balanced_accuracy }
        : {}),
      ...(m.comparison ? { compared_against: m.comparison.compared_against.prompt_hash, balanced_accuracy_delta: m.comparison.deltas.balanced_accuracy } : {}),
    };
    for (const svg of Array.from(document.querySelectorAll<SVGSVGElement>(`svg[data-export="${role}"]`))) {
      folder.file(`charts/${svg.dataset.chart}.svg`, serializeSvg(svg));
    }
  }
  const experiment = {
    exported_at: new Date().toISOString(),
    exported_by: TOOL,
    model: opts.model,
    prompt: { name: prompt.name, hash: `sha256:${hash}`, target: prompt.targetKey, type: prompt.targetType },
    class_mapping: opts.mapping,
    view: opts.focus === ALL ? "all classes" : `one-vs-rest: ${opts.focus}`,
    threshold: { ...opts.threshold, note: "Fitted on the training set to maximise balanced accuracy, then applied unchanged to the test set." },
    datasets: {
      train: opts.trainDataset ? { name: opts.trainDataset.name, hash: `sha256:${opts.trainDataset.hash}`, items: opts.trainDataset.items.length } : null,
      test: opts.testDataset ? { name: opts.testDataset.name, hash: `sha256:${opts.testDataset.hash}`, items: opts.testDataset.items.length } : null,
    },
    results: summary,
  };
  root.file("experiment.json", JSON.stringify(experiment, null, 2));
  root.file("README.md", readme(experiment));
  downloadBlob(await zip.generateAsync({ type: "blob" }), `${name}.zip`);
}

function readme(e: { prompt: { name: string; hash: string }; model: string; exported_at: string }): string {
  return `# ${e.prompt.name}

Exported from ${TOOL.name} ${TOOL.version} on ${e.exported_at}.

- \`experiment.json\`: model, prompt hash, dataset hashes, class mapping, threshold, headline metrics.
- \`prompt/prompt.json\`: the full prompt, its hash, the question and a preview of the exact request body; \`prompt/examples/\` holds the reference images.
- \`datasets/{train,test}/\`: \`metadata.jsonl\` + \`dataset.json\` (Hugging Face ImageFolder layout) with each dataset's hash.
- \`results/{train,test}/predictions.jsonl\`: one line per image with the label, the model's raw answer, probabilities, score, prediction, outcome, cost and latency.
- \`results/{train,test}/predictions.csv\`: the same, flattened.
- \`results/{train,test}/metrics.json\`: accuracy, balanced accuracy, per-class precision and recall, confusion matrix, precision-recall curves and the score histogram; the version compared against and both versions' metrics on the images scored in both; and, when chosen, advanced metrics (AUROC, cross-validated and macro balanced accuracy).
- \`results/{train,test}/charts/*.svg\`: the charts as shown.

Model: ${e.model}. Prompt hash: ${e.prompt.hash}.
`;
}
