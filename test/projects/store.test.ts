import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import { addProjectNote, listProjects, listProjectsWithWarnings, setProjectField, writeProject } from "../../src/projects/store.js";
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

describe("gate", () => {
  beforeEach(() => {
    makeHome();
  });
  it("is listed when the card has it and omitted when it does not", () => {
    writeProject("alpha", card("alpha").replace("autonomy: commit\n", "autonomy: commit\ngate: scripts/gate.sh\n"));
    writeProject("beta", card("beta"));
    const [a, b] = listProjects();
    expect(a.gate).toBe("scripts/gate.sh");
    expect("gate" in b).toBe(false);
  });
  it("is set and removed with setProjectField", () => {
    writeProject("alpha", card("alpha"));
    expect(setProjectField("alpha", "gate", "npm run gate").gate).toBe("npm run gate");
    expect(listProjects()[0].gate).toBe("npm run gate");
    expect("gate" in setProjectField("alpha", "gate", "")).toBe(false);
  });
  it("rejects a non-string gate on write", () => {
    expect(() => writeProject("alpha", card("alpha").replace("autonomy: commit\n", "autonomy: commit\ngate: 5\n"))).toThrow();
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

describe("addProjectNote", () => {
  const file = () => join(kbPaths().projects, "alpha.md");
  beforeEach(() => { makeHome(); });
  it("creates ## Çalışma notları and appends dated bullets, keeping frontmatter and other sections", () => {
    writeProject("alpha", card("alpha"));
    const d = new Date(2026, 9, 22);
    expect(addProjectNote("alpha", "vitest önbelleğini temizle", d)).toBe("- 2026-10-22: vitest önbelleğini temizle");
    addProjectNote("alpha", "ikinci\nnot", d);
    const text = readFileSync(file(), "utf8");
    expect(text).toContain("## Özet\nx\n\n## Çalışma notları\n- 2026-10-22: vitest önbelleğini temizle\n- 2026-10-22: ikinci not\n");
    expect(text).toContain("slug: alpha");
    expect(listProjects()).toHaveLength(1);
  });
  it("appends into an existing section without touching the next one", () => {
    writeProject("alpha", card("alpha") + "\n## Çalışma notları\n- eski\n\n## Son aktivite\n- y\n");
    addProjectNote("alpha", "yeni", new Date(2026, 9, 22));
    expect(readFileSync(file(), "utf8")).toContain("## Çalışma notları\n- eski\n- 2026-10-22: yeni\n\n## Son aktivite\n- y\n");
  });
  it("rejects an empty note, unknown card and bad slug", () => {
    writeProject("alpha", card("alpha"));
    expect(() => addProjectNote("alpha", "  ")).toThrow(/boş/);
    expect(() => addProjectNote("nope", "x")).toThrow(/bulunamadı/);
    expect(() => addProjectNote("../x", "x")).toThrow(/bulunamadı/);
  });
});
