import { describe, expect, it } from "vitest";
import { compareSchemas, datasetHash, inferSchema, parseCsv, parseJsonl } from "@/lib/manifest";

describe("manifest parsing", () => {
  it("reads metadata.jsonl and infers boolean and categorical labels", () => {
    const { rows, warnings } = parseJsonl(
      ['{"file_name":"images/a.jpg","open":true,"kind":"pcr"}', '{"file_name":"images/b.jpg","open":false,"kind":"other"}', "not json"].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    const { schema } = inferSchema(rows);
    expect(schema).toEqual([
      { key: "open", type: "boolean", description: undefined },
      { key: "kind", type: "categorical", classes: ["other", "pcr"], description: undefined },
    ]);
  });
  it("reads metadata.csv with quoted fields and 0/1 booleans", () => {
    const { rows } = parseCsv('file_name,has_lid,kind\n"a, b.jpg",1,"x"\nc.jpg,0,y\n');
    expect(rows[0].fileName).toBe("a, b.jpg");
    const { schema } = inferSchema(rows);
    expect(schema[0].type).toBe("boolean");
    expect(schema[1]).toMatchObject({ type: "categorical", classes: ["x", "y"] });
  });
  it("keeps the class order a sidecar declares", () => {
    const { rows } = parseJsonl('{"file_name":"a.jpg","pos":"right"}\n{"file_name":"b.jpg","pos":"left"}');
    const { schema } = inferSchema(rows, { schema: [{ key: "pos", type: "categorical", classes: ["left", "center", "right"] }] });
    expect(schema[0]).toMatchObject({ classes: ["left", "center", "right"] });
  });
});

describe("dataset hash", () => {
  const schema = [{ key: "open", type: "boolean" as const }];
  it("ignores item order and changes with labels", async () => {
    const a = { fileName: "a.jpg", imageHash: "1", labels: { open: true } };
    const b = { fileName: "b.jpg", imageHash: "2", labels: { open: false } };
    const h1 = await datasetHash(schema, [a, b]);
    expect(await datasetHash(schema, [b, a])).toBe(h1);
    expect(await datasetHash(schema, [a, { ...b, labels: { open: true } }])).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("schema comparison", () => {
  it("reports class and type mismatches", () => {
    const diffs = compareSchemas(
      [
        { key: "kind", type: "categorical", classes: ["a", "b"] },
        { key: "open", type: "boolean" },
      ],
      [
        { key: "kind", type: "categorical", classes: ["a", "c"] },
        { key: "open", type: "categorical", classes: ["x", "y"] },
      ],
    );
    expect(diffs.map((d) => d.key)).toEqual(["kind", "open"]);
  });
});
