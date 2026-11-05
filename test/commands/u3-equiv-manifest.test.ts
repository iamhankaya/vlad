import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { keyOf } from "../../src/commands/types.js";

const read = (f: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../scripts", f), "utf8"));
const cases = (read("equiv.cases.json").cases as { key: string; argv: string[] }[]);
const exempt = Object.entries(read("equiv.exempt.json").exempt as Record<string, string>);

describe("u3-equiv: scripts/equiv.cases.json + equiv.exempt.json cover the manifest exactly", () => {
  const manifest = COMMANDS.map(keyOf).sort();
  it("union of case keys and exempt keys equals the manifest keys", () => {
    expect([...cases.map((c) => c.key), ...exempt.map(([k]) => k)].sort()).toEqual(manifest);
  });
  it("a key is either a case or exempt, never both, and appears once", () => {
    const all = [...cases.map((c) => c.key), ...exempt.map(([k]) => k)];
    expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([]);
  });
  it("every exemption states a reason", () => {
    expect(exempt.filter(([, why]) => !why.trim())).toEqual([]);
  });
  it("every case argv starts with the command path of its manifest key", () => {
    const bad = cases.filter((c) => {
      const spec = COMMANDS.find((s) => keyOf(s) === c.key)!;
      const path = spec.path[0] === "vlad" ? spec.path.slice(1) : spec.path;
      return !c.argv.includes(path[path.length - 1]!);
    });
    expect(bad.map((c) => c.key)).toEqual([]);
  });
});
