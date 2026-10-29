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
