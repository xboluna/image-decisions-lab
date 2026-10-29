// Scores the demo prompts on both demo sets through the real UI, then stores the runs and cached answers in
// public/demo/seed.json so first-time visitors see results without an API key.
// Usage: OPENROUTER_API_KEY=sk-or-... node scripts/capture-demo-runs.mjs   (needs `npm run dev` on :3000)
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("Set OPENROUTER_API_KEY.");
const base = process.env.BASE_URL ?? "http://localhost:3000";
const DEMO_MODEL = "perplexity/pplx-decider-v1.2";
const seedPath = new URL("../public/demo/seed.json", import.meta.url);
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
seed.runs = [];
seed.inferences = [];
writeFileSync(seedPath, JSON.stringify(seed));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.addInitScript(([k, m]) => localStorage.setItem("harness-studio.settings", JSON.stringify({ apiKey: k, model: m, concurrency: 6 })), [key, DEMO_MODEL]);
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector('[data-panel="train"]', { timeout: 120000 });

for (const name of ["50 ml tubes v1", "50 ml tubes v2"]) {
  await page.getByRole("button", { name: "Choose prompt" }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
  for (const role of ["train", "test"]) {
    const panel = page.locator(`[data-panel="${role}"]`);
    await panel.getByRole("button", { name: /^Score (training|test) set$/ }).click();
    await panel.getByRole("button", { name: "Stop" }).waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    await panel.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 600000 });
    await page.waitForTimeout(500);
    const text = await panel.locator("text=Balanced accuracy").first().locator("..").locator("..").innerText().catch(() => "?");
    console.log(name, role, text.replace(/\s+/g, " "));
  }
}

const dump = await page.evaluate(async () => {
  const all = (dbName, store) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction(store, "readonly").objectStore(store).getAll();
        tx.onsuccess = () => resolve(tx.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  return { runs: await all("harness-studio-runs", "runs"), inferences: await all("harness-studio-inference", "inference") };
});
seed.runs = dump.runs.filter((r) => r.status === "done").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
seed.inferences = dump.inferences.filter((i) => i.ok);
seed.selection = { train: "ds_demo_train", test: "ds_demo_test", prompt: "pr_demo_50ml_v2" };
seed.model = DEMO_MODEL;
writeFileSync(seedPath, JSON.stringify(seed));
const cost = seed.inferences.reduce((s, i) => s + i.usage.costUsd, 0);
console.log(`Captured ${seed.runs.length} runs, ${seed.inferences.length} answers ($${cost.toFixed(4)}). Failed: ${dump.inferences.length - seed.inferences.length}`);
await browser.close();
