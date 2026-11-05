import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, importsOf, unitOf, walkTs } from "./imports.js";

const layers = JSON.parse(readFileSync(join(SRC, "layers.json"), "utf8")) as { layers: Record<string, number>; pure: string[] };
const baseline = JSON.parse(readFileSync(join(SRC, "layers.baseline.json"), "utf8")) as { violations: string[] };
const edges = walkTs().flatMap(importsOf);

describe("s-layers: layer rules (skeleton; known violations sit in layers.baseline.json)", () => {
  it("every src/* unit has a layer, and no layer names a missing unit", () => {
    const units = readdirSync(SRC).filter((n) => n !== "layers.json" && n !== "layers.baseline.json");
    expect(units.filter((u) => !(u in layers.layers))).toEqual([]);
    expect(Object.keys(layers.layers).filter((u) => !units.includes(u))).toEqual([]);
  });
  it("runtime imports only go to the same or a lower layer, apart from the baseline", () => {
    const up = edges
      .filter((e) => !e.typeOnly && unitOf(e.from) !== unitOf(e.to) && layers.layers[unitOf(e.to)]! > layers.layers[unitOf(e.from)]!)
      .map((e) => `${e.from} -> ${unitOf(e.to)}`);
    const found = [...new Set(up)].sort();
    expect(found.filter((v) => !baseline.violations.includes(v)), "new upward import").toEqual([]);
    expect(baseline.violations.filter((v) => !found.includes(v)), "stale baseline entry: remove it").toEqual([]);
  });
  it("pure units (policy data) import nothing but themselves at runtime", () => {
    const bad = edges.filter((e) => !e.typeOnly && layers.pure.includes(unitOf(e.from)) && unitOf(e.to) !== unitOf(e.from)).map((e) => `${e.from} -> ${e.to}`);
    expect(bad).toEqual([]);
  });
  it("scanner sees the import forms (static, dynamic, re-export, mixed type)", () => {
    const here = edges.filter((e) => e.from === "cli/program.ts");
    expect(here.some((e) => e.to === "findings/store.ts" && !e.typeOnly)).toBe(true);
    expect(here.some((e) => e.to === "transfer/cli.ts")).toBe(true); // import("../transfer/cli.js")
    expect(edges.some((e) => e.from === "kb/index.ts" && e.to === "kb/home.ts")).toBe(true); // export * from
    expect(edges.some((e) => e.from === "commands/types.ts" && e.to === "machines/types.ts" && e.typeOnly)).toBe(true);
  });
});
