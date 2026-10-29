// Records the demo video (docs/demo.mp4, docs/demo.gif) through the real app: import a dataset, score it, find
// weak outputs, tune the prompt, re-score. Makes about 55 live model calls (well under a cent).
//
//   npm run build && npx next start -p 3100
//   OPENROUTER_API_KEY=sk-or-... node scripts/record-demo.mjs        # prints the recorded .webm
//   ffmpeg -i <webm> -c:v libx264 -crf 24 -pix_fmt yuv420p -movflags +faststart -an docs/demo.mp4
//   ffmpeg -i <webm> -vf "fps=8,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" docs/demo.gif
import { chromium } from "@playwright/test";
import JSZip from "jszip";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SP = mkdtempSync(path.join(tmpdir(), "demo-recording-"));
const BASE = process.env.BASE_URL ?? "http://localhost:3100/";
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("Set OPENROUTER_API_KEY.");
const W = 1440, H = 900;

// the training set as a user would have it on disk
const dir = path.join(process.cwd(), "public/demo/train");
const zip = new JSZip();
const manifest = readFileSync(path.join(dir, "metadata.jsonl"), "utf8");
zip.file("bench-tubes/metadata.jsonl", manifest);
zip.file("bench-tubes/dataset.json", readFileSync(path.join(dir, "dataset.json")));
for (const l of manifest.trim().split("\n").map((x) => JSON.parse(x))) zip.file(`bench-tubes/${l.file_name}`, readFileSync(path.join(dir, l.file_name)));
const zipPath = path.join(SP, "bench-tubes.zip");
writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
const tuned = JSON.parse(readFileSync("public/demo/seed.json", "utf8")).prompts.find((p) => p.id === "pr_demo_50ml_v2");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: SP, size: { width: W, height: H } }, colorScheme: "light" });
const page = await ctx.newPage();
// a clean workspace: no bundled demo
await page.route("**/demo/seed.json", (r) => r.fulfill({ status: 404, body: "" }));
// never show any part of the real key: the key check answers with a placeholder label
await page.route("**/api/v1/key", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { label: "demo key", limit: 20, limit_remaining: 19.5, usage: 0.5 } }) }));
await page.addInitScript((k) => {
  localStorage.setItem("harness-studio.settings", JSON.stringify({ apiKey: k, model: "perplexity/pplx-decider-v1.2", concurrency: 8 }));
  localStorage.setItem("harness-studio.theme", "light");
  // overlay: caption bar, title cards and a visible cursor
  addEventListener("DOMContentLoaded", () => {
    const css = document.createElement("style");
    css.textContent = `
      #demo-cursor{position:fixed;z-index:99999;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;transition:transform .12s}
      #demo-cursor.down{transform:scale(.8)}
      #demo-cap{position:fixed;z-index:99998;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);opacity:0;transition:all .35s cubic-bezier(.2,.8,.2,1);
        background:#0b0b0b;color:#fff;font:600 19px/1.2 Inter,system-ui,sans-serif;padding:12px 20px 12px 14px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;pointer-events:none;white-space:nowrap}
      #demo-cap.on{opacity:1;transform:translateX(-50%)}
      #demo-cap b{background:#2a78d6;border-radius:8px;min-width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-size:15px}
      #demo-cap span{font-weight:400;color:#c3c2b7;font-size:15px}
      #demo-card{position:fixed;inset:0;z-index:99997;background:#0b0b0b;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;opacity:0;transition:opacity .45s;pointer-events:none;font-family:Inter,system-ui,sans-serif}
      #demo-card.on{opacity:1}
      #demo-card h1{font-size:54px;font-weight:700;letter-spacing:-.02em;margin:0}
      #demo-card p{font-size:21px;color:#c3c2b7;margin:0}
      #demo-card .loop{margin-top:18px;display:flex;gap:10px;font-size:17px}
      #demo-card .loop i{font-style:normal;background:#1d1d1c;border:1px solid #333;border-radius:999px;padding:7px 15px}
      #demo-ring{position:fixed;z-index:99996;border:3px solid #2a78d6;border-radius:12px;pointer-events:none;opacity:0;transition:all .3s;box-shadow:0 0 0 6px rgba(42,120,214,.18)}
      #demo-ring.on{opacity:1}`;
    document.head.appendChild(css);
    const cur = document.createElement("div");
    cur.id = "demo-cursor";
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-6.8L4 20z" fill="#0b0b0b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
    for (const id of ["demo-cap", "demo-card", "demo-ring"]) { const d = document.createElement("div"); d.id = id; document.body.appendChild(d); }
  });
}, KEY);

const wait = (ms) => page.waitForTimeout(ms);
async function caption(n, text, sub = "") {
  await page.evaluate(([n, t, s]) => {
    const c = document.getElementById("demo-cap");
    c.classList.remove("on");
    setTimeout(() => { c.innerHTML = `${n ? `<b>${n}</b>` : ""}${t}${s ? ` <span>${s}</span>` : ""}`; c.classList.add("on"); }, 180);
  }, [n, text, sub]);
  await wait(450);
}
async function card(title, sub, loop) {
  await page.evaluate(([t, s, l]) => {
    const c = document.getElementById("demo-card");
    c.innerHTML = `<h1>${t}</h1><p>${s}</p>${l ? `<div class="loop">${l.map((x) => `<i>${x}</i>`).join("<span>→</span>")}</div>` : ""}`;
    c.classList.add("on");
  }, [title, sub, loop]);
}
const hideCard = () => page.evaluate(() => document.getElementById("demo-card").classList.remove("on"));
async function ring(locator) {
  const b = await locator.boundingBox();
  await page.evaluate((b) => { const r = document.getElementById("demo-ring"); Object.assign(r.style, { left: b.x - 6 + "px", top: b.y - 6 + "px", width: b.width + 12 + "px", height: b.height + 12 + "px" }); r.classList.add("on"); }, b);
}
const unring = () => page.evaluate(() => document.getElementById("demo-ring").classList.remove("on"));
let mouse = { x: W / 2, y: H / 2 };
async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(to.x, to.y, { steps: 22 });
  mouse = to;
  await wait(120);
}
async function click(locator) { await moveTo(locator); await page.mouse.down(); await wait(70); await page.mouse.up(); await wait(250); }
async function scrollTo(y) { await page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), y); await wait(700); }
async function typeInto(locator, text, delay = 14) { await click(locator); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type(text, { delay }); }

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("text=Add a training dataset");
await page.mouse.move(mouse.x, mouse.y);
await card("Harness Studio", "Tune an image classifier on a decision model, in your browser.", ["Import", "Score", "Inspect", "Tune", "Re-score"]);
await wait(2600);
await hideCard();
await wait(500);

// 1 · import
const train = page.locator('[data-panel="train"]');
await caption(1, "Import a labelled dataset", "folder or zip · Hugging Face ImageFolder");
await click(train.getByRole("button", { name: "New dataset" }));
const dialog = page.getByRole("dialog");
await typeInto(dialog.getByPlaceholder("e.g. Bench photos, March"), "Bench tubes", 45);
await moveTo(dialog.getByText("Drop a dataset folder or a .zip here"));
await dialog.locator('input[type=file][accept*="zip"]').setInputFiles(zipPath);
await wait(700);
await click(dialog.getByRole("button", { name: /^Import/ }));
await dialog.getByText("Dataset ready").waitFor();
await wait(1500);
await click(dialog.getByRole("button", { name: "Done" }));
await wait(400);

// 2 · prompt
await caption(2, "Ask a question", "the model answers with a probability per class");
await click(page.getByRole("button", { name: "New prompt" }));
await wait(300);
const question = page.getByLabel("Question");
await typeInto(question, "How many 50 ml tubes are in the photo?", 28);
await wait(500);

// 3 · score
await caption(3, "Score it", "every answer cached by prompt hash, model and image");
await click(train.getByRole("button", { name: "Score training set" }));
await train.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 120000 });
await wait(600);
const tiles = train.locator("text=Balanced accuracy").first().locator("..").locator("..");
await moveTo(tiles);
await ring(tiles);
await wait(1800);
await unring();

// 4 · find weak outputs
await caption(4, "Find the weak outputs", "click a confusion-matrix cell to filter");
const cells = train.locator('svg[data-chart="confusion_matrix"] g.cursor-pointer');
const n = Math.round(Math.sqrt(await cells.count()));
const counts = await cells.evaluateAll((els) => els.map((e) => Number(e.querySelector("text")?.textContent ?? 0)));
let worst = -1, best = 0;
counts.forEach((c, i) => { if (Math.floor(i / n) !== i % n && c > best) { best = c; worst = i; } });
await click(cells.nth(worst));
await wait(900);
const grid = train.locator("[data-grid-scroll]");
await grid.scrollIntoViewIfNeeded();
await wait(600);
const firstWrong = grid.locator("button:has(img)").first();
await click(firstWrong);
await page.getByRole("dialog").getByText("Model answer").waitFor();
await wait(1400);
const add = page.getByRole("dialog").getByRole("button", { name: /Add to prompt as/ });
await caption(4, "Turn a miss into a reference example");
await click(add);
await wait(900);
await page.keyboard.press("Escape");
await wait(300);

// 5 · tune
await caption(5, "Tune the prompt", "the hash changes, so results are marked stale");
await scrollTo(0);
const sys = page.locator('[data-panel="prompt"] textarea').first();
await moveTo(sys);
await sys.fill(tuned.systemPrompt);
await wait(600);
await moveTo(question);
await question.fill(tuned.instructions);
await wait(500);
for (const [k, v] of Object.entries(tuned.criteria)) await page.getByLabel(`Criterion for ${k}`).fill(v);
await wait(600);
const nav = page.locator("nav[aria-label=Experiment]");
await moveTo(nav);
await ring(nav);
await wait(1500);
await unring();

// 6 · re-score
await caption(6, "Re-score and compare");
await click(train.getByRole("button", { name: "Score training set" }));
await train.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 120000 });
await wait(500);
await moveTo(tiles);
await ring(tiles);
await wait(1800);
await unring();
await click(train.getByRole("button", { name: /^History/ }));
await wait(2800);
await page.keyboard.press("Escape");
await page.evaluate(() => document.getElementById("demo-cap").classList.remove("on"));

await card("Harness Studio", "Every dataset, prompt and answer is hashed and exportable.", ["Import", "Score", "Inspect", "Tune", "Re-score"]);
await wait(2600);
const video = page.video();
await ctx.close();
await browser.close();
console.log(await video.path());
