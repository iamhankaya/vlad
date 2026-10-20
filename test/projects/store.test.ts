import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import { listProjects, listProjectsWithWarnings, writeProject } from "../../src/projects/store.js";
import { makeHome } from "../helpers.js";

const card = (slug: string) => `---
slug: ${slug}
name: Alpha
path: C:\dev\alpha
stack: [ts]
status: active
autonomy: commit
last_activity: 2026-10-15T21:10:00+03:00
last_scanned: null
---

## Özet
x
`;

describe("projects store", () => {
  beforeEach(() => {
    makeHome();
  });
  it("rejects slug mismatch", () => {
    expect(() => writeProject("alpha", card("beta"))).toThrow();
  });
  it("writes and lists", () => {
    const c = writeProject("alpha", card("alpha"));
    expect(c.slug).toBe("alpha");
    expect(listProjects()).toEqual([
      { slug: "alpha", path: "C:\dev\alpha", status: "active", last_activity: "2026-10-15T21:10:00+03:00" },
    ]);
  });
});

describe("exposure", () => {
  beforeEach(() => {
    makeHome();
  });
  it("is listed when the card has it and omitted when it does not", () => {
    writeProject("alpha", card("alpha").replace("autonomy: commit\n", "autonomy: commit\nexposure: internet\n"));
    writeProject("beta", card("beta"));
    const [a, b] = listProjects();
    expect(a.exposure).toBe("internet");
    expect("exposure" in b).toBe(false);
  });
  it("rejects an invalid exposure value", () => {
    expect(() => writeProject("alpha", card("alpha").replace("autonomy: commit\n", "autonomy: commit\nexposure: public\n"))).toThrow();
  });
});

describe("listProjectsWithWarnings", () => {
  it("skips unreadable/invalid cards and reports them; listProjects returns only valid ones", () => {
    makeHome();
    writeProject("alpha", card("alpha"));
    writeFileSync(join(kbPaths().projects, "bad.md"), "---\nslug: [oops\n---\n");
    writeFileSync(join(kbPaths().projects, "invalid.md"), "---\nslug: invalid\n---\n");
    const r = listProjectsWithWarnings();
    expect(r.projects.map((p) => p.slug)).toEqual(["alpha"]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.some((w) => w.startsWith("bad.md:"))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("invalid.md:"))).toBe(true);
    expect(listProjects().map((p) => p.slug)).toEqual(["alpha"]);
  });
});

describe("slug validation", () => {
  it("rejects slugs with path characters or uppercase", () => {
    makeHome();
    for (const bad of ["..\\x","a/b", "A", "a b", ""]) {
      expect(() => writeProject(bad, card(bad))).toThrow(/slug/);
    }
  });
});
