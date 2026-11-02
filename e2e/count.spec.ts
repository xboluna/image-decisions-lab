import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Count labels: the demo's 50 ml tube label declared as a count, scored with a mocked Decisions API.
const train = (page: Page) => page.locator('[data-panel="train"]');
const testPanel = (page: Page) => page.locator('[data-panel="test"]');

/** One demo split as a dataset zip whose dataset.json declares the tube label as a count over 0, 1, 2. */
async function countZip(split: "train" | "test", name: string): Promise<string> {
  const dir = path.join(process.cwd(), `public/demo/${split}`);
  const zip = new JSZip();
  const lines = readFileSync(path.join(dir, "metadata.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  // whole numbers are read as bucket positions
  zip.file("tubes/metadata.jsonl", lines.map((l) => JSON.stringify({ ...l, fifty_ml_tubes: Number(l.fifty_ml_tubes) })).join("\n"));
  zip.file("tubes/dataset.json", JSON.stringify({ name, schema: [{ key: "fifty_ml_tubes", type: "count", classes: ["0", "1", "2"] }] }));
  for (const l of lines) zip.file(`tubes/${l.file_name}`, readFileSync(path.join(dir, l.file_name)));
  const out = path.join(mkdtempSync(path.join(tmpdir(), "hs-")), `${split}.zip`);
  writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}

async function newDataset(page: Page, panel: ReturnType<typeof train>, file: string) {
  await panel.getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type=file][accept*="zip"]').setInputFiles(file);
  await dialog.getByRole("button", { name: /^Import/ }).click();
  await expect(dialog.getByText("Dataset ready")).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Done" }).click();
}

test("a count label is asked as a score question and scored by exact match, within one and MAE", async ({ page }) => {
  const asked: { type: string; criteria: unknown }[] = [];
  await page.addInitScript(() => localStorage.setItem("harness-studio.settings", JSON.stringify({ apiKey: "sk-or-v1-count-test", model: "perplexity/pplx-decider-v1.2", concurrency: 6 })));
  await page.route("https://openrouter.ai/api/alpha/decisions", async (route) => {
    const body = route.request().postDataJSON() as { questions: Record<string, { type: string; criteria: unknown }> };
    const [id, q] = Object.entries(body.questions)[0];
    asked.push(q);
    // always "one tube", a little unsure: expected position 0.2 × 0 + 0.7 × 1 + 0.1 × 2 = 0.9
    await route.fulfill({ json: { id: "gen-count", answers: { [id]: { type: "score", score: 0.9, probabilities: { "0": 0.2, "1": 0.7, "2": 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } } });
  });
  await page.goto("/");
  await expect(train(page).getByText("Balanced accuracy").first()).toBeVisible({ timeout: 60_000 });

  await newDataset(page, train(page), await countZip("train", "Tube counts · train"));
  await newDataset(page, testPanel(page), await countZip("test", "Tube counts · test"));
  await expect(train(page).getByRole("button", { name: /Choose training dataset/ })).toContainText("Tube counts · train");

  // the demo prompt asks a multiple-choice question; pointing it at the count label makes it a count question
  await expect(page.getByRole("combobox", { name: "Label to classify" })).toContainText("count, 3 buckets");
  await page.getByRole("combobox", { name: "Label to classify" }).selectOption("fifty_ml_tubes");
  await expect(page.getByLabel("Criterion for 0")).toHaveValue("0.");
  await page.getByLabel("Criterion for 0").fill("None.");
  await page.getByLabel("Criterion for 1").fill("One.");
  await page.getByLabel("Criterion for 2").fill("Two or more.");

  await testPanel(page).getByRole("button", { name: "Score test set" }).click();
  await expect(testPanel(page).getByText(/All \d+ answers already cached/)).toBeVisible({ timeout: 120_000 });
  const tiles = testPanel(page).locator("[data-count-metrics]");
  expect(asked[0]).toEqual({ type: "score", instructions: expect.any(String), criteria: ["None.", "One.", "Two or more."] });

  // every answer is bucket 1, expected 0.9: exact on the 1s, one off everywhere, |truth − 0.9| on average
  const truth = readFileSync(path.join(process.cwd(), "public/demo/test/metadata.jsonl"), "utf8").trim().split("\n").map((l) => Number(JSON.parse(l).fifty_ml_tubes));
  const exact = truth.filter((t) => t === 1).length / truth.length;
  const mae = truth.reduce((s, t) => s + Math.abs(t - 0.9), 0) / truth.length;
  await expect(tiles).toContainText("Exact match");
  await expect(tiles).toContainText(`${(exact * 100).toFixed(1)}%`);
  await expect(tiles).toContainText("Within one100.0%");
  await expect(tiles).toContainText(`Mean absolute error${mae.toFixed(2)}`);
  await expect(tiles).toContainText("Recall per bucket");
  await expect(testPanel(page).getByRole("combobox", { name: "Results view" })).toContainText("All buckets (most likely)");
});
