import { beforeEach, describe, expect, it } from "vitest";
import { listProjects, writeProject } from "../../src/projects/store.js";
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

describe("slug validation", () => {
  it("rejects slugs with path characters or uppercase", () => {
    makeHome();
    for (const bad of ["..\\x","a/b", "A", "a b", ""]) {
      expect(() => writeProject(bad, card(bad))).toThrow(/slug/);
    }
  });
});
