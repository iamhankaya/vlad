import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const memorySection = (t: string) => t.slice(t.indexOf("**Proje hafızası:**"), t.indexOf("**İş devri:**"));

describe("docs teach the new memory reading order", () => {
  it("CLAUDE.md: status summary -> valid decisions -> kb search -> kb get, with the commands listed", () => {
    const t = read("CLAUDE.md");
    const m = memorySection(t);
    const at = (s: string) => m.indexOf(s);
    expect(at("vlad project status")).toBeGreaterThan(-1);
    expect(at("vlad decision list")).toBeGreaterThan(at("vlad project status"));
    expect(at("vlad kb search")).toBeGreaterThan(at("vlad decision list"));
    expect(at("vlad kb get")).toBeGreaterThan(at("vlad kb search"));
    for (const cmd of ["decision add|list|set|migrate", "project write|set|note|summary|status|list", "kb commit|check|maintain|get|search"]) {
      expect(t, cmd).toContain(cmd);
    }
    expect(t).toMatch(/bayat/); // a stale summary is never presented as current
  });
  it("the old 'read card + whole decision file + journal + tasks' instruction is gone", () => {
    expect(memorySection(read("CLAUDE.md"))).not.toMatch(/dosyalarından cevapla/);
  });
  it("delegate step 1 reads status and valid decisions, not the whole decision file", () => {
    const t = read(".claude/skills/delegate/SKILL.md");
    expect(t).toContain("vlad project status");
    expect(t).toContain("vlad decision list");
    expect(t).not.toMatch(/dosyasındaki ilgili kararları oku/);
  });
  it("digest writes the status summary and uses decision ids/lifecycle", () => {
    const t = read(".claude/skills/digest/SKILL.md");
    expect(t).toContain("vlad project summary");
    expect(t).toContain("--supersedes");
    expect(t).toContain("vlad decision set");
    expect(t).toContain("vlad kb search");
  });
  it("status skill points the retro and gate questions at project status / kb search", () => {
    const t = read(".claude/skills/status/SKILL.md");
    expect(t).toContain("vlad project status");
  });
});
