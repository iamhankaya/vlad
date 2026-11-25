import { describe, expect, it } from "vitest";
import { BLOCKS_HEADING, standardBlocks, type BlockCtx } from "../../src/tasks/blocks.js";
import { buildPrompt } from "../../src/tasks/launch.js";

const ID = "T20261028-14";
const text = (c: Partial<BlockCtx>) =>
  standardBlocks({ taskId: ID, autonomy: "pr", parent: null, mode: "local", ...c }).join("\n");
const AUT = ["plan", "commit", "pr"] as const;

describe("blocks/ standardBlocks matrix", () => {
  for (const autonomy of AUT) for (const parent of [null, "T20261028-12"]) for (const mode of ["local", "cloud"] as const) {
    it(`${autonomy} / parent=${parent ?? "yok"} / ${mode}`, () => {
      const t = text({ autonomy, parent, mode });
      expect(t).toContain("Gerçek kaynak koruması"); // every prompt, plan included
      expect(t).not.toContain("'@"); // PowerShell here-string terminator
      if (mode === "cloud") {
        expect(t).not.toContain("~/.claude");
        expect(t).not.toContain("gh run watch");
        expect(t).not.toContain("vlad task log");
        expect(t.length).toBeLessThan(3500);
      }
      if (autonomy === "plan") {
        expect(t).not.toMatch(/git push|git merge|merge vlad\//);
        expect(t).not.toContain("Pipeline fazı");
      } else {
        expect(t).toContain(`vlad/${ID}`);
        expect(t.includes("Pipeline fazı") || t.includes("Entegrasyon öncesi")).toBe(parent !== null);
      }
      if (autonomy === "pr" && mode === "local") {
        expect(t).toContain(`git push -u origin vlad/${ID}`);
        expect(t).toContain("gh run watch");
        expect(t).toContain("--interval 60"); // F-vlad-087: the 3 s default polling exhausts the GitHub API quota
        expect(t).toMatch(/aynı neden ikinci kez/);
        expect(t).toMatch(/entegrasyon dalından gelen/);
      }
      if (autonomy === "commit") expect(t).not.toContain("gh run watch");
    });
  }

  it("cloud pipeline block merges FETCH_HEAD of a fetched branch, never the local integration branch", () => {
    const t = text({ autonomy: "commit", parent: "T20261028-12", mode: "cloud" });
    expect(t).toContain("git fetch origin vlad/T20261028-12");
    expect(t).toContain("git merge FETCH_HEAD");
    expect(t).not.toMatch(/git merge vlad\//);
  });

  it("F-vlad-340: pipeline block spells out the exact Test sonuçları line with the parent id, local and cloud", () => {
    for (const mode of ["local", "cloud"] as const) {
      const t = text({ autonomy: "commit", parent: "T20261028-12", mode });
      expect(t).toContain("Entegrasyon öncesi kontrol: vlad/T20261028-12 merge (<sha>) + lint + gate yeşil");
      expect(t).toContain("`### Test sonuçları`");
    }
  });

  it("local pipeline block allows pulling the integration branch into the own branch, not the reverse", () => {
    const t = text({ autonomy: "commit", parent: "T20261028-12" });
    expect(t).toContain("git merge vlad/T20261028-12");
    expect(t).toContain("Entegrasyon dalına merge/PR/push yok");
  });
});

describe("blocks/ buildPrompt", () => {
  const role = { title: "Senior Developer", file: "C:\r\developer.md", skills: ["superpowers:test-driven-development"] };
  it("without ctx the output is exactly the old 3-argument output", () => {
    const old = buildPrompt("f.md", "commit", role);
    expect(buildPrompt("f.md", "commit", role, undefined)).toBe(old);
    expect(old).not.toContain(BLOCKS_HEADING);
  });
  it("with ctx appends the blocks on every return path, also without a role", () => {
    for (const r of [role, undefined]) {
      const p = buildPrompt("f.md", "pr", r, { taskId: ID, parent: "T20261028-12" });
      expect(p).toContain(BLOCKS_HEADING);
      expect(p.indexOf(BLOCKS_HEADING)).toBeGreaterThan(p.indexOf("vlad-worker"));
      expect(p).toContain(`git push -u origin vlad/${ID}`);
      expect(p).not.toContain("\n'@");
      expect(p.length).toBeLessThan(32_000);
    }
  });
});

describe("blocks/ project repo skills", () => {
  it("lists the card's skills by name for local non-plan workers, nothing without them", () => {
    const t = text({ autonomy: "commit", projectSkills: ["ab-test-ve-kapi", "godot-ui"] });
    expect(t).toContain("`ab-test-ve-kapi`, `godot-ui`");
    expect(t).toMatch(/İşe başlamadan .*Skill aracıyla yükle/); // F-vlad-093: mandatory, not "the ones that fit"
    expect(t).not.toContain("Göreve uyanları");
    expect(text({ autonomy: "commit" })).not.toContain("Projenin repo skill");
    expect(text({ autonomy: "commit", projectSkills: [] })).not.toContain("Projenin repo skill");
    expect(text({ autonomy: "plan", projectSkills: ["x"] })).not.toContain("Projenin repo skill");
    expect(text({ autonomy: "commit", mode: "cloud", projectSkills: ["x"] })).not.toContain("Projenin repo skill");
  });
  it("buildPrompt carries them through ctx", () => {
    expect(buildPrompt("f.md", "commit", undefined, { taskId: ID, parent: null, projectSkills: ["ab-test-ve-kapi"] })).toContain("`ab-test-ve-kapi`");
  });
});

describe("blocks/ related open findings", () => {
  const rel = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `F-alpha-${String(i + 1).padStart(3, "0")}`, severity: "orta", title: `bulgu ${i + 1} ${"x".repeat(300)}` }));
  it("lists them with full ids, asks for a `### Kapatılan bulgular` entry, truncates titles", () => {
    const t = text({ autonomy: "commit", relatedFindings: rel(3) });
    expect(t).toContain("F-alpha-001");
    expect(t).toContain("F-alpha-003");
    expect(t).toContain("### Kapatılan bulgular");
    expect(t).toMatch(/[Dd]okunduğun alanda düzelttiğin bulgu/);
    expect(t).not.toContain("x".repeat(200)); // title cut
  });
  it("caps the list (prompt must not bloat)", () => {
    const t = text({ autonomy: "commit", relatedFindings: rel(40) });
    expect(t).toContain("F-alpha-015");
    expect(t).not.toContain("F-alpha-016");
  });
  it("absent/empty → no block; plan and cloud never get it", () => {
    expect(text({ autonomy: "commit" })).not.toContain("Kapatılan bulgular");
    expect(text({ autonomy: "commit", relatedFindings: [] })).not.toContain("Kapatılan bulgular");
    expect(text({ autonomy: "plan", relatedFindings: rel(2) })).not.toContain("F-alpha-001");
    expect(text({ autonomy: "commit", mode: "cloud", relatedFindings: rel(2) })).not.toContain("F-alpha-001");
  });
  it("buildPrompt carries them through ctx", () => {
    expect(buildPrompt("f.md", "commit", undefined, { taskId: ID, parent: null, relatedFindings: rel(1) })).toContain("F-alpha-001");
  });
});

describe("blocks/ çok makine işçisi bloğu (T20261125-52)", () => {
  const MARK = "Çok makine işçisi";
  it("yalnız remote=true yerel dev prompt'unda var; beyin, plan ve bulutta yok", () => {
    const t = text({ autonomy: "commit", remote: true });
    expect(t).toContain(MARK);
    expect(t).toContain("salt okunur");
    expect(t).toContain("task set");
    expect(t).toContain("vlad queue flush");
    expect(t).toContain("çıkış 75");
    for (const c of [{}, { remote: false }, { mode: "cloud" as const, remote: true }, { autonomy: "plan" as const, remote: true }]) {
      expect(text({ autonomy: "commit", ...c }), JSON.stringify(c)).not.toContain(MARK);
    }
  });
  it("buildPrompt: remote ctx bloğu taşır, ctx'siz/beyin taşımaz", () => {
    const base = { taskId: ID, parent: null };
    expect(buildPrompt("f.md", "commit", undefined, { ...base, remote: true })).toContain(MARK);
    expect(buildPrompt("f.md", "commit", undefined, base)).not.toContain(MARK);
  });
});
