import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const train = (page: Page) => page.locator('[data-panel="train"]');
const testPanel = (page: Page) => page.locator('[data-panel="test"]');

async function open(page: Page) {
  await page.goto("/");
  await expect(train(page).getByText("Balanced accuracy").first()).toBeVisible({ timeout: 60_000 });
}

async function choosePrompt(page: Page, name: string) {
  await page.getByRole("button", { name: "Choose prompt" }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
}

async function demoZip(mutate?: (line: Record<string, unknown>) => Record<string, unknown>, limit = Infinity): Promise<string> {
  const dir = path.join(process.cwd(), "public/demo/test");
  const zip = new JSZip();
  const lines = readFileSync(path.join(dir, "metadata.jsonl"), "utf8").trim().split("\n").slice(0, limit).map((l) => JSON.parse(l));
  zip.file("custom/metadata.jsonl", lines.map((l) => JSON.stringify(mutate ? mutate(l) : l)).join("\n"));
  for (const l of lines) zip.file(`custom/${l.file_name}`, readFileSync(path.join(dir, l.file_name)));
  if (!mutate) zip.file("custom/dataset.json", readFileSync(path.join(dir, "dataset.json")));
  const out = path.join(mkdtempSync(path.join(tmpdir(), "hs-")), "dataset.zip");
  writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}

async function focusClass(page: Page, cls: string) {
  await train(page).getByRole("combobox", { name: "Results view" }).selectOption(cls);
}

test("demo loads with results on both sets", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(train(page).getByText("27 images").first()).toBeVisible();
  await expect(testPanel(page).getByText("Balanced accuracy").first()).toBeVisible();
  await expect(train(page).getByText("All 27 answers already cached")).toBeVisible();
  await expect(train(page).getByRole("button", { name: "Score training set" })).toBeDisabled();
  await expect(page.locator('svg[data-chart="score_histogram"]')).toHaveCount(2);
  await expect(page.locator('svg[data-chart="confusion_matrix"]')).toHaveCount(2);
  await expect(page.locator('svg[data-chart="precision_recall"]')).toHaveCount(2);
  // both panels show every image (one page) in a scrolling grid
  await expect(train(page).locator("[data-grid-scroll] button:has(img)")).toHaveCount(27);
  await expect(testPanel(page).locator("[data-grid-scroll] button:has(img)")).toHaveCount(21);
  await expect(page.getByRole("navigation", { name: "Image pages" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("one-vs-rest threshold: fitted on train, moved by hand, locked on test", async ({ page }) => {
  await open(page);
  await focusClass(page, "1");
  await expect(train(page).getByText("fitted for best balanced accuracy")).toBeVisible();
  await expect(testPanel(page).getByText("fixed by the training set")).toBeVisible();
  const slider = train(page).getByRole("slider", { name: "Decision threshold" });
  const before = Number(await slider.getAttribute("aria-valuenow"));
  await slider.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(train(page).getByText(/set by hand/)).toBeVisible();
  const after = Number(await slider.getAttribute("aria-valuenow"));
  expect(after).toBeCloseTo(Math.min(1, before + 0.1), 2);
  await expect(testPanel(page).getByRole("slider", { name: "Decision threshold" })).toHaveAttribute("aria-valuenow", String(after));
  await expect(testPanel(page).getByRole("slider", { name: "Decision threshold" })).toHaveAttribute("aria-readonly", "true");
  await train(page).getByRole("button", { name: "Reset to fitted" }).click();
  await expect(slider).toHaveAttribute("aria-valuenow", String(before));
});

test("histogram brush, confusion cell and outcome filters narrow the images", async ({ page }) => {
  await open(page);
  await focusClass(page, "1");
  const panel = train(page);
  const hist = panel.locator('svg[data-chart="score_histogram"]');
  const box = (await hist.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40 + (box.width - 54) * 0.5, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(panel.getByText(/^score 0\.0\d–0\.\d\d$/)).toBeVisible();
  await expect(panel.getByText(/of 27 images/)).toBeVisible();
  await panel.getByRole("button", { name: "Clear all" }).click();
  await expect(panel.locator("div").filter({ hasText: /^27 images$/ })).toBeVisible();

  // row "1", column "not 1": the false negatives
  await panel.locator('svg[data-chart="confusion_matrix"] g.cursor-pointer').nth(1).click();
  await expect(panel.getByText(/actual 1 → predicted not 1/)).toBeVisible();
  await expect(panel.locator("text=✕ FN")).toHaveCount(await panel.locator("[data-grid-scroll] button:has(img)").count());
  await panel.getByRole("button", { name: "Clear all" }).click();

  await panel.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: /^True positive/ }).click();
  await page.keyboard.press("Escape");
  await expect(panel.getByText(/^TP$/)).toBeVisible();
  await expect(panel.locator("text=✓ TP").first()).toBeVisible();
  for (const other of ["✓ TN", "✕ FP", "✕ FN"]) await expect(panel.locator(`text=${other}`)).toHaveCount(0);
});

test("image detail shows the raw answer and can add a training image as an example", async ({ page }) => {
  await open(page);
  await train(page).locator("[data-grid-scroll] button:has(img)").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Model answer")).toBeVisible();
  await dialog.getByRole("button", { name: /Show raw response/ }).click();
  await expect(dialog.getByText('"choice"')).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByText("2 of 27")).toBeVisible();
  await dialog.getByRole("button", { name: /Add to prompt as/ }).click();
  await expect(dialog.getByRole("button", { name: "Already in the prompt" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(train(page).getByText(/Showing results from an earlier version/)).toBeVisible();
  await page.getByRole("button", { name: "Remove example 4" }).click();
  await expect(train(page).getByText("All 27 answers already cached")).toBeVisible();
});

test("class groups merge classes without new model calls", async ({ page }) => {
  await open(page);
  const panel = train(page);
  await expect(panel.locator('svg[data-chart="confusion_matrix"] g.cursor-pointer')).toHaveCount(9);
  await panel.getByRole("button", { name: /^Class groups/ }).click();
  await page.getByPlaceholder("New group name, e.g. one_or_more").fill("one_or_more");
  await page.getByRole("button", { name: "Add" }).click();
  for (const c of ["1", "2"]) await page.getByRole("combobox", { name: `Group for ${c}` }).selectOption("one_or_more");
  await expect(page.getByText("2 groups scored")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Class groups · 2" })).toBeVisible();
  await expect(testPanel(page).getByText("Grouped as on the training set")).toBeVisible();
  await expect(panel.locator('svg[data-chart="confusion_matrix"] g.cursor-pointer')).toHaveCount(4);
  await panel.getByRole("button", { name: /^Class groups/ }).click();
  await page.getByRole("button", { name: "Reset" }).click();
  await page.keyboard.press("Escape");
  await expect(panel.locator('svg[data-chart="confusion_matrix"] g.cursor-pointer')).toHaveCount(9);
});

test("dataset pickers never offer the other panel's dataset", async ({ page }) => {
  await open(page);
  await testPanel(page).getByRole("button", { name: /Choose test dataset/ }).click();
  await expect(page.getByRole("button", { name: /^50 ml tubes · holdout/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^50 ml tubes · train/ })).toHaveCount(0);
});

test("upload a dataset; mismatched classes block scoring", async ({ page }) => {
  await open(page);
  const zipPath = await demoZip((l) => ({ ...l, fifty_ml_tubes: l.fifty_ml_tubes === "1" ? "one" : l.fifty_ml_tubes }), 8);
  await testPanel(page).getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("e.g. Bench photos, March").fill("Renamed classes");
  await dialog.locator('input[type=file][accept*="zip"]').setInputFiles(zipPath);
  await dialog.getByRole("button", { name: /^Import/ }).click();
  await expect(dialog.getByText("Dataset ready")).toBeVisible();
  await expect(dialog.getByText("8 images · 1 label")).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(testPanel(page).getByText(/Datasets do not match/)).toBeVisible();
  await expect(testPanel(page).getByRole("button", { name: "Score test set" })).toBeDisabled();
  await testPanel(page).getByRole("button", { name: /Choose test dataset/ }).click();
  await page.getByRole("button", { name: /^50 ml tubes · holdout/ }).click();
  await expect(testPanel(page).getByText(/Datasets do not match/)).toHaveCount(0);
});

test("prompt editing: duplicate, reorder examples, stale results and a flashing header", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Choose prompt" }).click();
  await page.getByRole("button", { name: "Duplicate 50 ml tubes v2" }).click();
  await expect(page.getByRole("button", { name: "Choose prompt" })).toContainText("50 ml tubes v3");
  await expect(train(page).getByText("All 27 answers already cached")).toBeVisible();
  const step = page.locator("nav[aria-label=Experiment] > div").nth(1);
  await expect(step).not.toHaveClass(/value-flash/);
  const first = page.locator('[data-panel="prompt"] ol > li').first();
  await expect(first).toContainText("scene5_frame016");
  await page.waitForTimeout(2100); // changes while the page is still loading never flash
  await page.getByRole("button", { name: "Reorder example 1" }).focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  await page.keyboard.press("Space");
  await expect(page.locator('[data-panel="prompt"] ol > li').first()).toContainText("scene2_frame017");
  await expect(train(page).getByText(/Showing results from an earlier version/)).toBeVisible();
  await expect(train(page).getByText(/27 of 27 images need a model call/)).toBeVisible();
  await expect(page.locator("nav[aria-label=Experiment] > div").nth(1)).toHaveClass(/value-flash/);
  await expect(page.locator("nav[aria-label=Experiment] > div").first()).toHaveClass(/border-warning/);
});

test("prompts: download, import and delete with confirmation", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Choose prompt" }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Download “50 ml tubes v2”/ }).click();
  const file = await (await dl).path();
  await page.getByLabel("Import prompt zip").setInputFiles({ name: "prompt.zip", mimeType: "application/zip", buffer: readFileSync(file) });
  await expect(page.getByRole("button", { name: "Choose prompt" })).toContainText("50 ml tubes v2 (imported)");
  // same content, same hash: the cached results apply
  await expect(train(page).getByText("All 27 answers already cached")).toBeVisible();
  await expect(page.locator('[data-panel="prompt"] ol > li')).toHaveCount(3);
  await page.getByRole("button", { name: "Choose prompt" }).click();
  await page.getByRole("button", { name: "Delete 50 ml tubes v2 (imported)" }).click();
  await expect(page.getByRole("dialog").getByText(/Delete “50 ml tubes v2 \(imported\)”/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Delete prompt" }).click();
  await expect(page.getByRole("button", { name: "Choose prompt" })).toContainText("50 ml tubes");
  await page.getByRole("button", { name: "Choose prompt" }).click();
  await expect(page.getByRole("button", { name: /^50 ml tubes v2 \(imported\)/ })).toHaveCount(0);
});

test("exports: dataset and experiment bundles", async ({ page }) => {
  await open(page);
  let dl = page.waitForEvent("download");
  await train(page).getByRole("button", { name: "Download" }).click();
  let zip = await JSZip.loadAsync(readFileSync(await (await dl).path()));
  const names = Object.keys(zip.files);
  expect(names.some((n) => n.endsWith("metadata.jsonl"))).toBe(true);
  expect(names.filter((n) => n.endsWith(".jpg"))).toHaveLength(27);
  const card = JSON.parse(await zip.file(names.find((n) => n.endsWith("dataset.json"))!)!.async("string"));
  expect(card.hash).toMatch(/^sha256:[0-9a-f]{64}$/);

  await page.getByRole("button", { name: "Export experiment" }).click();
  dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download zip" }).click();
  zip = await JSZip.loadAsync(readFileSync(await (await dl).path()));
  const all = Object.keys(zip.files);
  const find = (s: string) => all.find((n) => n.endsWith(s))!;
  const experiment = JSON.parse(await zip.file(find("experiment.json"))!.async("string"));
  expect(experiment.prompt.hash).toMatch(/^sha256:/);
  expect(experiment.results.train.balanced_accuracy).toBeGreaterThan(0.4);
  const preds = (await zip.file(find("results/test/predictions.jsonl"))!.async("string")).trim().split("\n").map((l) => JSON.parse(l));
  expect(preds).toHaveLength(21);
  expect(preds[0].raw_answer).toBeTruthy();
  const prompt = JSON.parse(await zip.file(find("prompt/prompt.json"))!.async("string"));
  expect(prompt.examples).toHaveLength(3);
  expect(all.some((n) => n.endsWith("results/train/charts/confusion_matrix.svg"))).toBe(true);
  const svg = await zip.file(find("results/train/charts/score_histogram.svg"))!.async("string");
  expect(svg).not.toContain("var(--");
  expect(svg.match(/<svg[^>]*>/)![0].match(/style=/g)).toBeNull();
});

test("settings: a bad key is rejected", async ({ page }) => {
  await open(page);
  await page.getByLabel("OpenRouter API key").fill("sk-or-v1-not-a-real-key");
  await page.getByRole("button", { name: "Save & check" }).click();
  await expect(page.locator('[data-panel="settings"]').getByText(/rejected|User not found|No auth|invalid/i)).toBeVisible({ timeout: 20_000 });
});

test("live: check a real key and score a small new dataset", async ({ page }) => {
  const key = process.env.OPENROUTER_API_KEY;
  test.skip(!key, "set OPENROUTER_API_KEY to run live calls");
  await open(page);
  await page.getByLabel("OpenRouter API key").fill(key!);
  await page.getByRole("button", { name: "Save & check" }).click();
  await expect(page.locator('[data-panel="settings"]').getByText(/Connected · key/)).toBeVisible({ timeout: 20_000 });
  // a 4-image subset: a new dataset hash, but answers are cached per image, so no calls are needed
  const zipPath = await demoZip(undefined, 4);
  await testPanel(page).getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("dialog").locator('input[type=file][accept*="zip"]').setInputFiles(zipPath);
  await page.getByRole("dialog").getByRole("button", { name: /^Import/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(testPanel(page).getByText(/All 4 answers already cached/)).toBeVisible();
  // a prompt edit makes the answers uncached; scoring calls the API for real
  await page.getByLabel("Question").fill("How many wide 50 ml tubes with blue or red caps are visible?");
  await expect(testPanel(page).getByText(/4 of 4 images need a model call/)).toBeVisible();
  await testPanel(page).getByRole("button", { name: "Score test set" }).click();
  await expect(testPanel(page).getByText("4 scored")).toBeVisible({ timeout: 90_000 });
  await expect(testPanel(page).getByText(/All 4 answers already cached/)).toBeVisible();
});

test("metric tiles explain themselves on hover and keyboard focus", async ({ page }) => {
  await open(page);
  await train(page).getByRole("button", { name: "About balanced accuracy" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("mean of per-class recall");
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await testPanel(page).getByRole("button", { name: "About accuracy above cutoff" }).focus();
  await expect(page.getByRole("tooltip")).toContainText("review cutoff");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("test-set images cannot become reference examples", async ({ page }) => {
  await open(page);
  await testPanel(page).locator("[data-grid-scroll] button:has(img)").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Model answer")).toBeVisible();
  await expect(dialog.getByText("Use as a reference example")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Add to prompt/ })).toHaveCount(0);
});

test("clear demo removes it for good until it is reloaded", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Clear demo" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear demo" }).click();
  await expect(train(page).getByText("Add a training dataset")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No prompt yet")).toBeVisible();
  await page.reload();
  await expect(train(page).getByText("Add a training dataset")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Reload demo data" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reload demo" }).click();
  await expect(train(page).getByText("Balanced accuracy").first()).toBeVisible({ timeout: 60_000 });
});

test("demo images missing from storage are restored on reload", async ({ page }) => {
  await open(page);
  await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open("harness-studio-thumbs");
        r.onsuccess = () => {
          const st = r.result.transaction("thumbs", "readwrite").objectStore("thumbs");
          st.clear();
          st.transaction.oncomplete = () => res(null);
        };
      }),
  );
  await page.reload();
  await expect(train(page).getByText("Balanced accuracy").first()).toBeVisible({ timeout: 60_000 });
  await expect(train(page).locator("button img").first()).toBeVisible();
  await expect(page.getByText("Image not stored")).toHaveCount(0);
});

test("a short prompt column never squeezes the training images below two rows or into the test panel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await page.getByRole("button", { name: "Choose prompt" }).click();
  await page.getByRole("button", { name: /^50 ml tubes v1/ }).first().click();
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => {
    const train = document.querySelector('[data-panel="train"]')!.getBoundingClientRect();
    const test = document.querySelector('[data-panel="test"]')!.getBoundingClientRect();
    const sc = document.querySelector('[data-panel="train"] [data-grid-scroll]')!;
    const box = sc.getBoundingClientRect();
    const cards = [...sc.querySelectorAll("button")].map((c) => c.getBoundingClientRect());
    const rows = new Set(cards.filter((c) => c.top >= box.top - 1 && c.bottom <= box.bottom + 1).map((c) => Math.round(c.top))).size;
    return { gap: test.top - train.bottom, rows, cardH: cards[0].height, cardW: cards[0].width };
  });
  expect(m.gap).toBeGreaterThan(0);
  expect(m.rows).toBeGreaterThanOrEqual(2);
  // cards keep their 16:10 image plus caption instead of being squashed
  expect(m.cardH).toBeGreaterThan(m.cardW * 0.6);
});

test("large datasets page inside the scrolling grid", async ({ page }) => {
  await open(page);
  // 130 copies of the holdout images under new names, with the same labels
  const dir = path.join(process.cwd(), "public/demo/test");
  const lines = readFileSync(path.join(dir, "metadata.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const zip = new JSZip();
  const rows: string[] = [];
  for (let i = 0; i < 130; i++) {
    const l = lines[i % lines.length];
    const name = `images/copy${String(i).padStart(3, "0")}.jpg`;
    zip.file(`big/${name}`, readFileSync(path.join(dir, l.file_name)));
    rows.push(JSON.stringify({ ...l, file_name: name }));
  }
  zip.file("big/metadata.jsonl", rows.join("\n"));
  zip.file("big/dataset.json", readFileSync(path.join(dir, "dataset.json")));
  const out = path.join(mkdtempSync(path.join(tmpdir(), "hs-")), "big.zip");
  writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));

  await testPanel(page).getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("dialog").locator('input[type=file][accept*="zip"]').setInputFiles(out);
  await page.getByRole("dialog").getByRole("button", { name: /^Import/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click({ timeout: 60_000 });

  const panel = testPanel(page);
  const pager = panel.getByRole("navigation", { name: "Image pages" });
  await expect(pager).toContainText("1–40 of 130");
  await expect(panel.locator("[data-grid-scroll] button:has(img), [data-grid-scroll] button:has(.shimmer)")).toHaveCount(40);
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("41–80 of 130");
  await expect(pager).toContainText("Page 2 of 4");
  await pager.getByRole("combobox", { name: "Images per page" }).selectOption("80");
  await expect(pager).toContainText("1–80 of 130");
  await expect(pager).toContainText("Page 1 of 2");
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("81–130 of 130");
  // a filter starts again at the first page: copy000–copy099 are 100 images
  await pager.getByRole("combobox", { name: "Images per page" }).selectOption("40");
  await pager.getByRole("button", { name: "Next page" }).click();
  await expect(pager).toContainText("Page 2 of 4");
  await panel.getByPlaceholder("Search file names").fill("copy0");
  await expect(pager).toContainText("1–40 of 100");
  await expect(pager).toContainText("Page 1 of 3");
  // the grid scrolls inside the panel instead of growing the page
  const box = await panel.locator("[data-grid-scroll]").evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, h: el.clientHeight }));
  expect(box.scrolls).toBe(true);
  expect(box.h).toBeLessThanOrEqual(page.viewportSize()!.height * 0.7 + 1);
});

/** Edits the stored runs in the page's IndexedDB (keys are stored separately from the records). */
async function editRuns(page: Page, edit: "plantPartial" | "dropCompleteV1") {
  await page.evaluate(
    (edit) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("harness-studio-runs");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("runs", "readwrite");
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error);
          const store = tx.objectStore("runs");
          const all = store.getAll();
          all.onsuccess = () => {
            type R = { id: string; role: string; promptId: string; startedAt: string; status: string; results: Record<string, string> };
            const runs = all.result as R[];
            const v1 = runs.filter((r) => r.promptId === "pr_demo_50ml_v1" && r.role === "train");
            if (edit === "plantPartial") {
              // A cancelled re-run of v1, newer than its complete run, that finished only 13 images.
              const base = v1[0];
              const half = Object.fromEntries(Object.entries(base.results).slice(0, 13));
              const run = { ...base, id: "run_partial", status: "cancelled", startedAt: new Date(Date.parse(base.startedAt) + 1000).toISOString(), results: half };
              store.put(run, run.id);
            } else {
              for (const r of v1) if (r.id !== "run_partial") store.delete(r.id);
            }
          };
        };
      }),
    edit,
  );
}

test("what changed lists images that flipped since the previous prompt version", async ({ page }) => {
  await open(page);
  const card = train(page).locator("[data-changes]");
  await expect(card).toContainText("Balanced accuracy");
  await expect(train(page).getByText(/^vs 50 ml tubes v1 · [0-9a-f]{8}$/)).toBeVisible();
  // the holdout has no regressions, so it opens on the fixes
  await expect(testPanel(page).getByRole("radio", { name: /Fixed \d+/ })).toHaveAttribute("aria-checked", "true");
  const broke = Number((await train(page).getByRole("radio", { name: /Broke \d+/ }).innerText()).match(/\d+/)![0]);
  expect(broke).toBeGreaterThan(0);
  await card.getByRole("button", { name: "Show in grid" }).click();
  await expect(train(page).getByText(new RegExp(`broke since [0-9a-f]{8} \\(${broke}\\)`))).toBeVisible();
  await expect(train(page).locator("[data-grid-scroll] button:has(img)")).toHaveCount(broke);
  await card.locator("ul button").first().click();
  await expect(page.getByRole("dialog").getByText(`1 of ${broke} broke`)).toBeVisible();
});

test("what changed ignores a newer partial run and compares on the same images", async ({ page }) => {
  await open(page);
  const bar = train(page).locator("[data-comparison]");
  const card = train(page).locator("[data-changes]");
  const headline = () => card.locator("div").first().innerText();
  const before = await headline();

  await editRuns(page, "plantPartial");
  await page.reload();
  await expect(card).toContainText("Balanced accuracy");
  expect(await headline()).toBe(before);
  await expect(bar).not.toContainText("partial run");
  await expect(bar).not.toContainText("scored in both");

  // With the complete run gone, the partial one is offered, labelled, and compared on the shared images only.
  await editRuns(page, "dropCompleteV1");
  await page.reload();
  await expect(train(page).getByText(/^vs 50 ml tubes v1 · [0-9a-f]{8} · partial run$/)).toBeVisible();
  await expect(card).toContainText("on the 13 of 27 images scored in both");
  await expect(bar).toContainText("Deltas use the 13 of 27 images scored in both versions.");
});

test("the comparison bar names the baseline, and peeking shows that version until switching back", async ({ page }) => {
  await open(page);
  const bar = train(page).locator("[data-comparison]");
  await expect(bar).toContainText("Comparing against");
  await expect(bar.getByRole("combobox", { name: "Version to compare against" })).toContainText(/50 ml tubes v1 · [0-9a-f]{8}/);
  const workingBa = await train(page).locator("text=Balanced accuracy").first().locator("..").locator("..").innerText();
  await expect(train(page).locator("text=Balanced accuracy").first().locator("..").locator("..")).toContainText("▲");

  await bar.getByRole("button", { name: "See this prompt" }).click();
  await expect(bar).toContainText("Viewing");
  await expect(bar).toContainText("compared against your working version");
  await expect(page.locator("[data-peek-banner]")).toContainText("read-only");
  await expect(page.getByLabel("Question")).toHaveValue("How many 50 ml tubes are in the photo?");
  await expect(page.getByLabel("Question")).toBeDisabled();
  await expect(train(page).getByRole("button", { name: "Score training set" })).toBeDisabled();
  await expect(train(page).locator("text=Balanced accuracy").first().locator("..").locator("..")).toContainText("▼");
  await expect(page.locator("nav[aria-label=Experiment] > div").nth(1)).toContainText("51755a05");

  await page.locator("[data-peek-banner]").getByRole("button", { name: "Switch back" }).click();
  await expect(bar).toContainText("Comparing against");
  await expect(page.getByLabel("Question")).toBeEnabled();
  await expect(page.getByLabel("Question")).toHaveValue(/Count each wide tube/);
  expect(await train(page).locator("text=Balanced accuracy").first().locator("..").locator("..").innerText()).toBe(workingBa);
});

test("peeking shows the same complete run the comparison uses, even after a cancelled re-run", async ({ page }) => {
  await open(page);
  await editRuns(page, "plantPartial");
  await page.reload();
  const card = train(page).locator("[data-changes]");
  await expect(card).toContainText("Balanced accuracy");
  const baselineBa = (await card.innerText()).match(/Balanced accuracy\s+([\d.]+%)/)![1];
  await train(page).locator("[data-comparison]").getByRole("button", { name: "See this prompt" }).click();
  const tiles = train(page).locator("text=Balanced accuracy").first().locator("..").locator("..");
  await expect(tiles).toContainText(baselineBa);
  await expect(tiles).toContainText("27 scored");
  await expect(train(page).locator("[data-comparison]")).not.toContainText("scored in both");
});

test("nothing edits the working prompt while an earlier version is on screen", async ({ page }) => {
  await open(page);
  const promptStep = page.locator("nav[aria-label=Experiment] > div").nth(1);
  const workingHash = (await promptStep.innerText()).match(/[0-9a-f]{8}/)![0];
  const examples = page.locator('[data-panel="prompt"] ol > li');
  await train(page).locator("[data-comparison]").getByRole("button", { name: "See this prompt" }).click();
  await expect(page.locator("[data-peek-banner]")).toBeVisible();

  // dropping an image onto the reference examples does nothing
  const zone = page.locator('[data-panel="prompt"]').getByText("Reference examples").locator("..").locator("..");
  const bytes = readFileSync(path.join(process.cwd(), "public/demo/train/images/scene0_frame112.jpg")).toString("base64");
  const dt = await page.evaluateHandle((b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const t = new DataTransfer();
    t.items.add(new File([data], "dropped.jpg", { type: "image/jpeg" }));
    return t;
  }, bytes);
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await page.waitForTimeout(500);
  await expect(examples).toHaveCount(0);

  // the image viewer does not offer to add examples
  await train(page).locator("[data-grid-scroll] button:has(img)").first().click();
  await expect(page.getByRole("dialog").getByText("Model answer")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Add to prompt/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.locator("[data-peek-banner]").getByRole("button", { name: "Switch back" }).click();
  await expect(promptStep).toContainText(workingHash);
  await expect(examples).toHaveCount(3);
});

test("a file dropped while viewing an earlier version, or outside any drop zone, never leaves the app", async ({ page }) => {
  await open(page);
  await train(page).locator("[data-comparison]").getByRole("button", { name: "See this prompt" }).click();
  await expect(page.locator("[data-peek-banner]")).toBeVisible();
  const zone = page.locator('[data-panel="prompt"]').getByText("Reference examples").locator("..").locator("..");
  // Returns whether the browser's default (opening the file) was cancelled for dragover and drop.
  const dropOn = (target: "zone" | "page") =>
    (target === "zone" ? zone : page.locator("footer")).evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "stray.jpg", { type: "image/jpeg" }));
      const fire = (type: string) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      return [fire("dragover"), fire("drop")];
    });
  expect(await dropOn("zone")).toEqual([true, true]);
  expect(await dropOn("page")).toEqual([true, true]);
  await expect(page.locator("[data-peek-banner]")).toBeVisible();
  await expect(page.locator('[data-panel="prompt"] ol > li')).toHaveCount(0);
});

test("advanced metrics are off by default and toggled from the ⋯ menu", async ({ page }) => {
  await open(page);
  await expect(page.locator("[data-advanced-metrics]")).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  const toggle = page.getByRole("menuitemcheckbox", { name: "Advanced metrics" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  const trainAdv = train(page).locator("[data-advanced-metrics]");
  await expect(trainAdv).toContainText("AUROC");
  await expect(trainAdv).toContainText("Macro balanced accuracy");
  await expect(trainAdv).toContainText(/AUROC\s*\d+\.\d%/);
  // the all-classes view fits no threshold, so cross-validation does not apply there
  await expect(trainAdv).toContainText("binary views only");
  await expect(testPanel(page).locator("[data-advanced-metrics]")).toContainText("training set only");
  // a one-vs-rest view fits a threshold on the training set, so it is cross-validated
  await train(page).getByRole("combobox", { name: "Results view" }).selectOption("2");
  await expect(trainAdv).toContainText(/Cross-validated BA\s*\d+\.\d%/);
  await trainAdv.getByRole("button", { name: "About cross-validated ba" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("fitted on one half");
  // the choice is remembered
  await page.reload();
  await expect(train(page).locator("[data-advanced-metrics]")).toBeVisible({ timeout: 30_000 });
});
