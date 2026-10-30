"use client";
import JSZip from "jszip";
import type { Analysis, ThresholdInfo } from "./analysis";
import { db } from "./db";
import { sha256Bytes, shortHash } from "./hash";
import { manifestJsonl } from "./manifest";
import { ALL } from "./metrics";
import { buildQuestion, buildState, exampleViews, IMAGE_PIPELINE, JPEG_QUALITY, promptViews, questionId, STATE_TEMPLATE_VERSION } from "./prompt";
import { modelJpeg } from "./runner";
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

/** The exact JPEG sent for an example, so another pipeline can check it sends the same bytes. */
function sentPath(i: number, fileName: string) {
  return `sent/${String(i + 1).padStart(2, "0")}-${(fileName.split("/").pop() ?? "image").replace(/\.[^.]+$/, "")}.jpg`;
}

export function promptRecord(prompt: Prompt, hash: string) {
  return {
    name: prompt.name,
    hash: `sha256:${hash}`,
    state_template_version: STATE_TEMPLATE_VERSION,
    image: {
      max_side: prompt.imageMaxSide,
      format: "jpeg",
      quality: JPEG_QUALITY,
      pipeline: IMAGE_PIPELINE,
      pillow_equivalent: `img = Image.open(f).convert("RGB"); img.thumbnail((${prompt.imageMaxSide}, ${prompt.imageMaxSide})); img.save(out, "JPEG", quality=${JPEG_QUALITY})`,
    },
    system_prompt: prompt.systemPrompt,
    target: { key: prompt.targetKey, type: prompt.targetType },
    question_id: questionId(prompt),
    question: buildQuestion(prompt),
    examples: prompt.examples.map((e, i) => ({ file: examplePath(i, e.fileName), source_file: e.fileName, sha256: e.imageHash, label: e.label, caption: e.caption, ...(e.ops?.length ? { ops: e.ops } : {}) })),
    // Image operations, in the order they run; areas are fractions of the original image (x0, y0, x1, y1).
    regions: prompt.regions ?? [],
    views: promptViews(prompt),
    /** The exact request body sent per image, with images written as references. */
    request_preview: {
      model: "<model>",
      state: buildState(
        prompt,
        prompt.examples.map((e, i) => exampleViews(e).map((v, k, all) => `<${examplePath(i, e.fileName)}${all.length > 1 || v.ops.length ? ` view ${k + 1}` : ""} as JPEG data URL>`)),
        promptViews(prompt).map((v, k, all) => `<image under evaluation${all.length > 1 || v.ops.length ? `, view ${k + 1}` : ""} as JPEG data URL>`),
      ),
      questions: { [questionId(prompt)]: buildQuestion(prompt) },
    },
    updated_at: prompt.updatedAt,
  };
}

async function addPrompt(zip: JSZip, prompt: Prompt, hash: string) {
  const sent: { file: string; source_file: string; sha256: string; width: number; height: number; pixel_exact: boolean }[] = [];
  for (const [i, e] of prompt.examples.entries()) {
    const blob = await db.getImage(e.imageHash);
    if (!blob) continue;
    zip.file(examplePath(i, e.fileName), blob);
    // The example as sent: with its own edits, if any.
    const out = await modelJpeg(e.imageHash, exampleViews(e)[0], prompt);
    zip.file(sentPath(i, e.fileName), out.jpeg);
    sent.push({ file: sentPath(i, e.fileName), source_file: examplePath(i, e.fileName), sha256: await sha256Bytes(out.jpeg), width: out.width, height: out.height, pixel_exact: out.exact });
  }
  zip.file("prompt.json", JSON.stringify({ ...promptRecord(prompt, hash), sent_examples: sent, restore: prompt }, null, 2));
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

function metricsRecord(a: Analysis, threshold: ThresholdInfo) {
  return {
    run: { id: a.run.id, status: a.run.status, started_at: a.run.startedAt, finished_at: a.run.finishedAt, model: a.run.model, prompt_hash: `sha256:${a.run.promptHash}`, dataset_hash: `sha256:${a.run.datasetHash}`, cost_usd: a.run.costUsd, cached: a.run.cachedCount },
    stale: a.stale,
    view: a.view.mode === "binary" ? { mode: "binary", positive_class: a.view.positive } : { mode: "multiclass" },
    threshold: { value: threshold.value, fitted_on_training_set: threshold.fitted, source: threshold.source, meaning: a.view.mode === "binary" ? "score >= threshold is called positive" : "answers below this top-class probability are flagged for review" },
    metrics: a.metrics,
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
    const m = metricsRecord(a, opts.threshold);
    folder.file("metrics.json", JSON.stringify(m, null, 2));
    summary[role] = { dataset: a.dataset.name, dataset_hash: `sha256:${a.dataset.hash}`, run_id: a.run.id, prompt_hash: `sha256:${a.run.promptHash}`, model: a.run.model, stale: a.stale, accuracy: a.metrics.accuracy, balanced_accuracy: a.metrics.balancedAccuracy, n: a.metrics.n };
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
- \`results/{train,test}/metrics.json\`: accuracy, balanced accuracy, per-class precision and recall, confusion matrix, precision-recall curves and the score histogram.
- \`results/{train,test}/charts/*.svg\`: the charts as shown.

Model: ${e.model}. Prompt hash: ${e.prompt.hash}.
`;
}
