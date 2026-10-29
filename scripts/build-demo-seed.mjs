// Writes public/demo/seed.json (datasets, prompts) and dataset.json sidecars for the bundled demo.
// Runs and cached answers are added by scripts/capture-demo-runs.mjs, which scores the demo in a real browser.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../public/demo/", import.meta.url);
const sha = (path) => createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");

const schema = [
  {
    key: "fifty_ml_tubes",
    type: "categorical",
    classes: ["0", "1", "2"],
    description: "Number of 50 ml conical tubes in view (15 ml tubes, 1.5 ml tubes and pipette tips do not count).",
  },
];
const sets = {
  train: { name: "50 ml tubes · train", description: "Cluttered labware on a bench, 6 scenes. 50 ml tube counts hand-labelled on LabWare_Items photos (MIT); frames where a tube is cut off or mostly hidden were left out." },
  test: { name: "50 ml tubes · holdout", description: "4 different scenes, never used for prompt tuning or threshold fitting." },
};
for (const [dir, meta] of Object.entries(sets)) {
  writeFileSync(new URL(`${dir}/dataset.json`, root), JSON.stringify({ ...meta, schema }, null, 2) + "\n");
}

const ex = (id, file, label, caption) => ({ id, imageHash: sha(`train/images/${file}`), fileName: `images/${file}`, label, caption });
const base = { targetKey: "fifty_ml_tubes", targetType: "categorical", imageMaxSide: 1024 };

const prompts = [
  {
    ...base,
    id: "pr_demo_50ml_v1",
    name: "50 ml tubes v1",
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    systemPrompt: "A photo of a laboratory bench.",
    instructions: "How many 50 ml tubes are in the photo?",
    criteria: { 0: "None.", 1: "One.", 2: "Two." },
    examples: [],
  },
  {
    ...base,
    id: "pr_demo_50ml_v2",
    name: "50 ml tubes v2",
    createdAt: "2026-10-29T00:00:01.000Z",
    updatedAt: "2026-10-29T00:00:01.000Z",
    systemPrompt:
      "You are inspecting photos of a cluttered laboratory bench taken from a handheld camera at varying angles. The bench holds a clear 96-well plate, a bright orange tube rack, cream slide holders, small 1.5 ml tubes, coloured pipette tips, and two kinds of screw-cap conical tubes:\n- 50 ml tubes: wide, with a large blue or red cap. Some are self-standing and may stand on their cap with a clear skirted end on top, which looks like an open cylinder.\n- 15 ml tubes: long and narrow with a small beige or white cap and a sharp conical tip. These are not 50 ml tubes.",
    instructions:
      "How many 50 ml conical tubes are visible? Count each wide tube with a large blue or red cap, whether it lies flat, stands cap-up, stands on its cap, sits in the rack, or is partly hidden behind other labware. Do not count 15 ml tubes, 1.5 ml tubes or pipette tips.",
    criteria: {
      0: "No 50 ml tube is visible.",
      1: "Exactly one 50 ml tube is visible; the other is out of frame or hidden.",
      2: "Two 50 ml tubes are visible.",
    },
    examples: [
      ex("ex_demo_2a", "scene5_frame016.jpg", "2", "One 50 ml tube stands with its red cap up; the other lies flat with a blue cap. The two thin tubes with beige caps are 15 ml and do not count."),
      ex("ex_demo_2b", "scene2_frame017.jpg", "2", "A self-standing 50 ml tube stands on its blue cap (clear end up), and a red-capped 50 ml tube sits in the rack. The two thin tubes standing on beige caps are 15 ml."),
      ex("ex_demo_1", "scene1_frame163.jpg", "1", "Only one 50 ml tube is in view: the wide tube standing on its blue cap at the front. The red-capped one is hidden behind the rack. The crossed thin tubes are 15 ml."),
    ],
  },
];

const seedPath = new URL("seed.json", root);
const old = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : {};
const seed = {
  version: 1,
  datasets: [
    { id: "ds_demo_train", path: "train", ...sets.train },
    { id: "ds_demo_test", path: "test", ...sets.test },
  ],
  prompts,
  runs: old.runs ?? [],
  inferences: old.inferences ?? [],
  selection: { train: "ds_demo_train", test: "ds_demo_test", prompt: "pr_demo_50ml_v2" },
  model: "perplexity/pplx-decider-v1.2",
  mappings: {},
};
writeFileSync(seedPath, JSON.stringify(seed));
console.log(`seed.json: ${prompts.length} prompts, ${seed.runs.length} runs, ${seed.inferences.length} cached answers`);
