import { describe, expect, it } from "vitest";
import { buildState, exampleViews, imagesPerRequest, contentHash, promptViews, usesImageViews } from "@/lib/prompt";
import type { Prompt } from "@/lib/types";

const base: Prompt = {
  id: "p",
  name: "n",
  createdAt: "",
  updatedAt: "",
  systemPrompt: "System.",
  targetKey: "k",
  targetType: "boolean",
  instructions: "Is it there?",
  criteria: { true: "Yes.", false: "No." },
  examples: [{ id: "e", imageHash: "h1", fileName: "a.jpg", caption: "", label: true }],
  imageMaxSide: 1024,
};
const views: Prompt["views"] = [
  { id: "v1", caption: "Whole image, region framed.", ops: [{ kind: "outline", area: { region: "r" }, color: "#ff00ff", width: 0 }], enlarge: false },
  { id: "v2", caption: "", ops: [{ kind: "crop", area: { region: "r" }, margin: 0.5 }], enlarge: true },
];
const withViews: Prompt = { ...base, regions: [{ id: "r", name: "rack", box: [0.1, 0.1, 0.4, 0.4] }], views };

describe("image views in the request", () => {
  it("leaves prompts without views exactly as before", async () => {
    expect(usesImageViews(base)).toBe(false);
    expect(usesImageViews({ ...base, views: [], regions: [] })).toBe(false);
    expect(await contentHash({ ...base, views: [], regions: [] })).toBe(await contentHash(base));
    expect(buildState(base, [["E"]], ["T"])).toEqual([
      { type: "text", text: "System." },
      { type: "text", text: "Reference example 1 — POSITIVE (the answer is yes)." },
      { type: "image_url", image_url: { url: "E" } },
      { type: "text", text: "Now the image to evaluate. It is not one of the reference examples." },
      { type: "image_url", image_url: { url: "T" } },
    ]);
  });
  it("sends one captioned image per view, in order", () => {
    const parts = buildState(withViews, [["E"]], ["T1", "T2"]);
    const tail = parts.slice(-4);
    expect(tail).toEqual([
      { type: "text", text: "Whole image, region framed." },
      { type: "image_url", image_url: { url: "T1" } },
      { type: "text", text: "View 2: crop to rack +50%." },
      { type: "image_url", image_url: { url: "T2" } },
    ]);
    expect(imagesPerRequest(withViews)).toBe(3);
  });
  it("sends reference examples whole, or with their own edits, never through the views", () => {
    expect(exampleViews(withViews.examples[0])).toEqual([{ id: "whole", caption: "", ops: [], enlarge: false }]);
    const edited = { ...withViews.examples[0], ops: [{ kind: "rotate" as const, degrees: 90 as const }] };
    expect(exampleViews(edited)).toEqual([{ id: "example", caption: "", ops: edited.ops, enlarge: false }]);
    expect(imagesPerRequest({ ...withViews, examples: [edited] })).toBe(3);
  });
  it("changes the prompt hash whenever what is sent changes", async () => {
    const h = await contentHash(withViews);
    expect(h).not.toBe(await contentHash(base));
    const moved = { ...withViews, regions: [{ id: "r", name: "rack", box: [0.1, 0.1, 0.5, 0.4] as [number, number, number, number] }] };
    expect(await contentHash(moved)).not.toBe(h);
    // a region's name is sent in the automatic caption of a view without its own caption, so renaming it counts
    expect(await contentHash({ ...withViews, regions: [{ ...withViews.regions![0], name: "tube rack" }] })).not.toBe(h);
    const reordered = { ...withViews, views: [views[1], views[0]] };
    expect(await contentHash(reordered)).not.toBe(h);
    expect(promptViews(withViews)).toHaveLength(2);
  });
  it("hashes only caption text that is sent", async () => {
    const single: Prompt = { ...base, regions: [{ id: "r", name: "rack", box: [0.1, 0.1, 0.4, 0.4] }], views: [views![1]] };
    const renamed = { ...single, regions: [{ ...single.regions![0], name: "tube rack" }] };
    // one untitled view: no caption is sent, so renaming its region changes nothing
    expect(buildState(renamed, [["E"]], ["T"])).toEqual(buildState(single, [["E"]], ["T"]));
    expect(await contentHash(renamed)).toBe(await contentHash(single));
    // with a caption of its own, the caption is sent and hashed
    const captioned = { ...single, views: [{ ...views![1], caption: "Close-up." }] };
    expect(await contentHash(captioned)).not.toBe(await contentHash(single));
  });
});
