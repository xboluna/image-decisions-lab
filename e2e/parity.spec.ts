import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// The bytes the browser actually puts in the request must equal Pillow's (scripts/reference_pipeline.py), in every
// engine. The Decisions API is mocked, so this runs without a key.
const expected: Record<string, string> = JSON.parse(readFileSync(path.join(process.cwd(), "e2e/fixtures/pillow-512.json"), "utf8")).sha256;

test("images sent to the model are byte-identical to the Pillow reference", async ({ page }) => {
  const sent = new Set<string>();
  await page.addInitScript(() => localStorage.setItem("harness-studio.settings", JSON.stringify({ apiKey: "sk-or-v1-parity-test", model: "perplexity/pplx-decider-v1.2", concurrency: 6 })));
  await page.route("https://openrouter.ai/api/alpha/decisions", async (route) => {
    const body = route.request().postDataJSON() as { state: { type: string; image_url?: { url: string } }[]; questions: Record<string, unknown> };
    for (const part of body.state) {
      if (part.type !== "image_url") continue;
      const [head, data] = part.image_url!.url.split(",");
      expect(head).toBe("data:image/jpeg;base64");
      sent.add(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
    }
    const id = Object.keys(body.questions)[0];
    await route.fulfill({ json: { id: "gen-test", answers: { [id]: { choice: "1" } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } } });
  });
  await page.goto("/");
  const train = page.locator('[data-panel="train"]');
  await expect(train.getByText("Balanced accuracy").first()).toBeVisible({ timeout: 60_000 });

  // A new image size is a new prompt version, so nothing is cached and every image is encoded and sent.
  await page.getByLabel("Image size sent").selectOption("512");
  await train.getByRole("button", { name: "Score training set" }).click();
  await expect(train.getByText("All 27 answers already cached")).toBeVisible({ timeout: 120_000 });

  const reference = new Set(Object.values(expected));
  const unmatched = [...sent].filter((h) => !reference.has(h));
  expect(unmatched).toEqual([]);
  // 27 training images; the prompt's reference examples are training images too
  expect(sent.size).toBe(27);
});
