import { describe, expect, it } from "vitest";
import { coerceLabel, compareSchemas, datasetHash, inferSchema, type ManifestRow } from "@/lib/manifest";
import { ALL, computeMetrics, confusionMatrix, scoreRows, viewFor, type ScoreInput, type Target } from "@/lib/metrics";
import { answerProbabilities } from "@/lib/openrouter";
import { buildQuestion, contentHash, countBuckets, defaultQuestion, promptProblems } from "@/lib/prompt";
import { importPromptFiles } from "@/lib/promptImport";
import type { LabelSchema, Prompt } from "@/lib/types";

const BUCKETS = ["0", "1", "2+"];
const schema: LabelSchema = { key: "tubes", type: "count", classes: BUCKETS };
const target: Target = { type: "count", classes: BUCKETS };

const prompt: Prompt = {
  id: "p",
  name: "Tubes",
  createdAt: "",
  updatedAt: "",
  systemPrompt: "System.",
  targetKey: "tubes",
  targetType: "count",
  instructions: "How many tubes stand in the rack?",
  criteria: { "0": "None.", "1": "One.", "2+": "Two or more." },
  buckets: BUCKETS,
  examples: [],
  imageMaxSide: 1024,
};

describe("count questions", () => {
  it("are sent as a score question listing the bucket descriptions lowest first", () => {
    expect(buildQuestion(prompt)).toEqual({ type: "score", instructions: "How many tubes stand in the rack?", criteria: ["None.", "One.", "Two or more."] });
    // the order comes from the buckets, not the criteria object
    const shuffled = { ...prompt, criteria: { "2+": "Two or more.", "1": "One.", "0": "None." } };
    expect(buildQuestion(shuffled)).toEqual(buildQuestion(prompt));
  });

  it("put the bucket order in the content hash", async () => {
    const renamed = { ...prompt, buckets: ["none", "one", "two_plus"], criteria: { none: "None.", one: "One.", two_plus: "Two or more." } };
    // same question text, different names to map answers back to: a different version
    expect(buildQuestion(renamed)).toEqual(buildQuestion(prompt));
    expect(await contentHash(renamed)).not.toBe(await contentHash(prompt));
  });

  it("map answers, keyed by bucket position, back to bucket names", () => {
    const answer = { type: "score", score: 1.3, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 } };
    expect(answerProbabilities(answer, "count", BUCKETS)).toEqual({ "0": 0.2, "1": 0.3, "2+": 0.5 });
    expect(answerProbabilities({ type: "score", score: 1 }, "count", BUCKETS)).toBeNull();
  });

  it("get a default question per bucket and must use the dataset's buckets in order", () => {
    const q = defaultQuestion(schema);
    expect(q.targetType).toBe("count");
    expect(q.buckets).toEqual(BUCKETS);
    expect(countBuckets({ ...prompt, buckets: undefined })).toEqual(BUCKETS);
    expect(promptProblems(prompt, [schema])).toEqual([]);
    expect(promptProblems({ ...prompt, buckets: ["1", "0", "2+"] }, [schema]).join(" ")).toMatch(/not the dataset's, in order/);
    expect(promptProblems({ ...prompt, targetType: "categorical" }, [schema]).join(" ")).toMatch(/is count in the dataset/);
  });
});

describe("count labels", () => {
  const rows: ManifestRow[] = [
    { fileName: "a.jpg", values: { tubes: 0, open: true } },
    { fileName: "b.jpg", values: { tubes: 1, open: false } },
    { fileName: "c.jpg", values: { tubes: 7, open: true } },
    { fileName: "d.jpg", values: { tubes: "2+", open: false } },
  ];

  it("are declared, never inferred, even when the values look boolean", () => {
    const declared = inferSchema(rows.slice(0, 2), { schema: [schema] }).schema;
    expect(declared.find((s) => s.key === "tubes")).toEqual({ key: "tubes", type: "count", classes: BUCKETS, description: undefined });
    // undeclared, the 0/1 column is still read as yes/no
    expect(inferSchema(rows.slice(0, 2)).schema.find((s) => s.key === "tubes")?.type).toBe("boolean");
  });

  it("take bucket names or whole numbers, with anything past the last bucket in it", () => {
    expect([0, 1, 2, 7, "1", "2+", "two", -1, 1.5].map((v) => coerceLabel(schema, v))).toEqual(["0", "1", "2+", "2+", "1", "2+", null, null, null]);
    expect(inferSchema([...rows, { fileName: "e.jpg", values: { tubes: "lots" } }], { schema: [schema] }).warnings.join(" ")).toMatch(/1 value of count "tubes" fit no bucket/);
  });

  it("leave the hash of every existing dataset as it was", async () => {
    const items = [{ fileName: "a.jpg", imageHash: "h1", labels: { open: true, kind: "pcr" } }];
    const old: LabelSchema[] = [
      { key: "open", type: "boolean" },
      { key: "kind", type: "categorical", classes: ["pcr", "other"] },
    ];
    // datasetHash for this schema and item on main before count labels existed
    expect(await datasetHash(old, items)).toBe("55eb5618a402a8a1c17d300ca86587461cc4ab52c18104f719a0bf52e6650bff");
    expect(await datasetHash([...old, schema], items)).not.toBe(await datasetHash(old, items));
  });

  it("differ between datasets when their buckets differ, even only in order", () => {
    expect(compareSchemas([schema], [{ ...schema, classes: ["0", "2+", "1"] }])[0].problem).toMatch(/buckets differ/);
    expect(compareSchemas([schema], [schema])).toEqual([]);
  });
});

describe("count metrics", () => {
  // hand-checked: positions 0, 1, 2; expected position = Σ position × probability
  const inputs: ScoreInput[] = [
    { id: "a", gt: "0", probabilities: { "0": 0.9, "1": 0.1, "2+": 0 } }, // top 0: exact; expected 0.1, off by 0.1
    { id: "b", gt: "1", probabilities: { "0": 0.2, "1": 0.3, "2+": 0.5 } }, // top 2+: one off; expected 1.3, off by 0.3
    { id: "c", gt: "2+", probabilities: { "0": 0.6, "1": 0.4, "2+": 0 } }, // top 0: two off; expected 0.4, off by 1.6
  ];
  const view = viewFor(target, ALL);
  const rows = scoreRows(inputs, target, {}, view, 0);
  const m = computeMetrics(rows, target, {}, view);

  it("are exact match, within one and the mean absolute error to the expected bucket", () => {
    expect(m.count?.exact).toBeCloseTo(1 / 3);
    expect(m.accuracy).toBeCloseTo(1 / 3);
    expect(m.count?.withinOne).toBeCloseTo(2 / 3);
    expect(m.count?.mae).toBeCloseTo((0.1 + 0.3 + 1.6) / 3);
  });

  it("break ties toward the lower bucket", () => {
    const tie = scoreRows([{ id: "t", gt: "1", probabilities: { "0": 0.5, "1": 0.5, "2+": 0 } }], target, {}, view, 0);
    expect(tie[0].pred).toBe("0");
  });

  it("keep bucket order in the confusion matrix and when neighbours are merged", () => {
    expect(confusionMatrix(rows, target, {}, view).labels).toEqual(BUCKETS);
    const merged = { "1": "1+", "2+": "1+" };
    const mv = viewFor(target, ALL);
    const mm = computeMetrics(scoreRows(inputs, target, merged, mv, 0), target, merged, mv);
    // groups 0 and 1+: b and c become 1+; c's top is 0 (one off now), its expected position 0.4
    expect(mm.count?.exact).toBeCloseTo(2 / 3);
    expect(mm.count?.withinOne).toBeCloseTo(1);
    expect(mm.count?.mae).toBeCloseTo((0.1 + 0.2 + 0.6) / 3);
  });

  it("are not reported for categorical labels", () => {
    const cat: Target = { type: "categorical", classes: BUCKETS };
    expect(computeMetrics(scoreRows(inputs, cat, {}, view, 0), cat, {}, view).count).toBeUndefined();
  });
});

describe("prompt.json with a count question", () => {
  const read = async (json: object) => (await importPromptFiles([{ path: "p/prompt.json", file: new Blob([JSON.stringify(json)]) }], [])).prompt;

  it("reads the question as exported: the description list and the bucket names", async () => {
    const p = await read({
      name: "Tubes",
      model: "vendor/a",
      system_prompt: "System.",
      target: { key: "tubes", type: "count" },
      question: { ...buildQuestion(prompt), buckets: BUCKETS },
    });
    expect(p.targetType).toBe("count");
    expect(p.buckets).toEqual(BUCKETS);
    expect(p.criteria).toEqual(prompt.criteria);
    expect(await contentHash(p)).toBe(await contentHash({ ...prompt, model: "vendor/a" }));
  });

  it("round-trips through restore", async () => {
    const p = await read({ name: "Tubes", restore: prompt });
    expect(p.buckets).toEqual(BUCKETS);
    expect(await contentHash(p)).toBe(await contentHash(prompt));
  });
});
