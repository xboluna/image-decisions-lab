import { describe, expect, it } from "vitest";
import { contentHash, inferenceKey, promptHash, promptModel, upgradeRun, versionHash } from "@/lib/prompt";
import { importPromptFiles } from "@/lib/promptImport";
import type { Prompt, Run } from "@/lib/types";

const base: Prompt = {
  id: "p",
  name: "Tubes",
  createdAt: "",
  updatedAt: "",
  systemPrompt: "System.",
  targetKey: "k",
  targetType: "boolean",
  instructions: "Is it there?",
  criteria: { true: "Yes.", false: "No." },
  examples: [],
  imageMaxSide: 1024,
};

describe("the model is part of the prompt", () => {
  it("changes the prompt hash, not the content hash", async () => {
    const a = { ...base, model: "vendor/a" };
    const b = { ...base, model: "vendor/b" };
    expect(await promptHash(a, "vendor/x")).not.toBe(await promptHash(b, "vendor/x"));
    expect(await contentHash(a)).toBe(await contentHash(b));
    expect(await contentHash(a)).toBe(await contentHash(base));
  });

  it("keeps the content hash prompts had before they carried a model, so cached answers stay valid", async () => {
    // promptHash(base) on main before this change
    expect(await contentHash(base)).toBe("ba23ffe48a6dea8f75aba58e30c0bd4655dc211358b1e86150fa3d2aae7a2b6d");
  });

  it("uses the default model for a prompt without one", async () => {
    expect(promptModel(base, "vendor/x")).toBe("vendor/x");
    expect(promptModel({ model: " " }, "vendor/x")).toBe("vendor/x");
    expect(await promptHash(base, "vendor/x")).toBe(await promptHash({ ...base, model: "vendor/x" }, "vendor/other"));
    expect(await promptHash(base, "vendor/x")).toBe(await versionHash(await contentHash(base), "vendor/x"));
  });

  it("upgrades runs stored before prompts carried a model, keeping their answers' keys", async () => {
    const content = await contentHash(base);
    const old = { id: "r", promptHash: content, model: "vendor/a", promptSnapshot: base, results: { i: await inferenceKey(content, "vendor/a", "img") } } as unknown as Run;
    const up = (await upgradeRun(old)) as Run;
    expect(up.contentHash).toBe(content);
    expect(up.promptHash).toBe(await promptHash({ ...base, model: "vendor/a" }, "vendor/x"));
    expect(up.promptSnapshot?.model).toBe("vendor/a");
    expect(up.results).toEqual(old.results);
    expect(await upgradeRun(up)).toBeNull();
  });
});

describe("prompt.json carries the model", () => {
  const read = async (json: object) => (await importPromptFiles([{ path: "p/prompt.json", file: new Blob([JSON.stringify(json)]) }], [])).prompt;

  it("round-trips through restore", async () => {
    const prompt = await read({ name: "Tubes", model: "vendor/a", restore: { ...base, model: "vendor/a" } });
    expect(prompt.model).toBe("vendor/a");
    expect(await promptHash(prompt, "vendor/x")).toBe(await promptHash({ ...base, model: "vendor/a" }, "vendor/x"));
  });

  it("reads the top-level model of a hand-written prompt.json", async () => {
    const prompt = await read({ name: "Tubes", model: "vendor/b", system_prompt: "System.", target: { key: "k", type: "boolean" }, question: { instructions: "Is it there?", criteria: { true: "Yes.", false: "No." } } });
    expect(prompt.model).toBe("vendor/b");
  });

  it("leaves the model unset when the file names none, for the caller to fill in", async () => {
    expect((await read({ name: "Tubes", restore: base })).model).toBeUndefined();
    expect((await read({ name: "Tubes", model: null, system_prompt: "S" })).model).toBeUndefined();
  });
});
