import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listRolesWithWarnings } from "../../src/roles/store.js";
import { makeHome } from "../helpers.js";

const dir = resolve(import.meta.dirname, "..", "..", "roles");

describe("repo roles/", () => {
  beforeEach(() => { makeHome(); }); // schemas come from the throwaway home (a copy of the repo's)

  it("the seven roles pass the schema with the spec's kinds, skills, model and all four sections", () => {
    const { roles, warnings } = listRolesWithWarnings(dir);
    expect(warnings).toEqual([]);
    expect(Object.fromEntries(roles.map((r) => [r.slug, r.kind]))).toEqual({
      analyst: "advisory", architect: "advisory", designer: "executor", developer: "executor", finans: "advisory", pazarlama: "advisory",
      tester: "executor",
    });
    for (const r of roles) {
      expect(Array.isArray(r.skills), `${r.slug} skills`).toBe(true);
      expect(r.skills.length, `${r.slug} skills`).toBeGreaterThan(0);
      expect(r.model, `${r.slug} model`).toBe("sonnet");
      const body = readFileSync(r.file, "utf8");
      for (const h of ["## Sorumluluk", "## Yetki", "## Kaynaklar", "## Çıktı"]) expect(body, `${r.slug} ${h}`).toContain(h);
    }
  });

  it("architect carries ### Sistem tasarımı scaled by exposure; analyst carries ### Sistem etkisi", () => {
    const read = (n: string) => readFileSync(resolve(dir, `${n}.md`), "utf8");
    const arch = read("architect");
    expect(arch).toContain("### Sistem tasarımı");
    for (const w of ["exposure", "local", "network", "internet", "açık nokta"]) expect(arch, w).toContain(w);
    const analyst = read("analyst");
    expect(analyst).toContain("### Sistem etkisi");
    expect(analyst).toContain("exposure");
  });

  it("specs and scan skill document exposure and its difference from local_only", () => {
    const root = resolve(dir, "..");
    const read = (p: string) => readFileSync(resolve(root, p), "utf8");
    for (const p of [
      "docs/superpowers/specs/2026-10-15-vlad-roles-design.md",
      "docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md",
    ]) {
      const t = read(p);
      expect(t, p).toContain("exposure");
      expect(t, p).toContain("local_only");
      expect(t, p).toContain("Sistem tasarımı");
    }
    const scan = read(".claude/skills/scan/SKILL.md");
    expect(scan).toContain("exposure");
    expect(scan).toContain("exposure belirsiz");
  });
});
