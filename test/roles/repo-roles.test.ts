import { readdirSync, readFileSync } from "node:fs";
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

describe("test hygiene rules", () => {
  for (const slug of ["tester", "developer"]) {
    it(`${slug} carries the four hygiene rules`, () => {
      const body = readFileSync(resolve(dir, `${slug}.md`), "utf8");
      expect(body).toContain("Test hijyeni");
      expect(body).toMatch(/duvar saati/i);
      expect(body).toMatch(/FakeClock/);
      expect(body).toMatch(/önbellek/);
      expect(body).toMatch(/flake/);
    });
  }
});

describe("work notes (## Çalışma notları) wiring", () => {
  const root = resolve(dir, "..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");
  it("every role's Kaynaklar and vlad-worker tell workers to read the card's Çalışma notları", () => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
      expect(read(`roles/${f}`), f).toContain("`## Çalışma notları`");
    }
    expect(read("global/skills/vlad-worker/SKILL.md")).toContain("## Çalışma notları");
  });
  it("digest records findings and keeps the notes; status runs the retro", () => {
    const digest = read(".claude/skills/digest/SKILL.md");
    expect(digest).toContain("vlad finding add");
    expect(digest).toContain("Açık noktalar");
    expect(digest).toContain("`## Çalışma notları`'na **dokunma**");
    const status = read(".claude/skills/status/SKILL.md");
    for (const w of ["### Retro", "vlad project note", "Ne iyi gitti", "Ne sürtündü", "Ders", "roles/"]) expect(status, w).toContain(w);
  });
  it("CLAUDE.md, README and specs document the finding and note commands", () => {
    for (const p of ["CLAUDE.md", "README.md", "docs/superpowers/specs/2026-10-15-vlad-core-design.md"]) {
      expect(read(p), p).toContain("vlad finding");
      expect(read(p), p).toContain("Çalışma notları");
    }
    expect(read("CLAUDE.md")).toContain("vlad project write|set|note|list");
    expect(read("docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md")).toContain("## 15. Bulgu kaydı ve retro");
  });
});
