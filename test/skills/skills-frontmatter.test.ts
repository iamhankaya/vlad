import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const frontmatter = (md: string) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
const field = (md: string, key: string) => new RegExp(`^${key}:\s*(.+)$`, "m").exec(frontmatter(md))?.[1].trim() ?? "";

const NEW_VLAD_SKILLS = ["second-opinion", "integrate", "art-prompt"];
const WORKER_SKILLS = ["vlad-worker", "ci-triage"];

describe("skills/ frontmatter", () => {
  for (const [dir, names] of [[".claude/skills", NEW_VLAD_SKILLS], ["global/skills", WORKER_SKILLS]] as const) {
    for (const n of names) {
      it(`${dir}/${n} has name == dir and a trigger description`, () => {
        const md = read(`${dir}/${n}/SKILL.md`);
        expect(field(md, "name")).toBe(n);
        expect(field(md, "description").length, "description").toBeGreaterThan(40);
        if (n !== "vlad-worker") expect(field(md, "description"), "trigger sentence").toMatch(/Kullan/);
      });
    }
  }

  it("every role skill resolves to a skill dir, a vendored file, or a superpowers: alias", () => {
    const have = new Set([...readdirSync(resolve(root, ".claude/skills")), ...readdirSync(resolve(root, "global/skills"))]);
    for (const f of readdirSync(resolve(root, "roles")).filter((n) => n.endsWith(".md"))) {
      const skills = [...(/^skills:\r?\n((?:\s+- .+\r?\n?)+)/m.exec(frontmatter(read(`roles/${f}`)) + "\n")?.[1] ?? "").matchAll(/- (\S+)/g)].map((m) => m[1]);
      for (const s of skills) {
        if (/^(?!superpowers:)S+:/.test(s)) continue; // other plugins ship their own skills
        if (/^(?!superpowers:)\S+:/.test(s)) continue; // other plugins ship their own skills
        const bare = s.replace(/^superpowers:/, "");
        expect(have.has(bare) || existsSync(resolve(root, "vendor/skills", bare, "SKILL.md")), `${f}: ${s}`).toBe(true);
      }
    }
  });
});

describe("skills/ references and de-duplication", () => {
  it("CLAUDE.md skill table lists the new skills and matches the skill dirs", () => {
    const c = read("CLAUDE.md");
    for (const n of [...NEW_VLAD_SKILLS, "ci-triage"]) expect(c, n).toContain(n);
    expect(c).toContain("security-reviewer");
    expect(c).toMatch(/task new\|launch[^\n]*deps/);
  });

  it("second-opinion owns the Codex commands; delegate and status only point to it", () => {
    const so = read(".claude/skills/second-opinion/SKILL.md");
    expect(so).toContain("codex exec");
    expect(so).toContain("codex review");
    expect(so).toContain("gpt-6-astra");
    for (const f of [".claude/skills/delegate/SKILL.md", ".claude/skills/status/SKILL.md"]) {
      const t = read(f);
      expect(t, f).not.toContain("codex exec");
      expect(t, f).not.toContain("codex review");
      expect(t, f).toContain("`second-opinion`");
    }
  });

  it("integrate owns the gate/merge procedure; status points to it and keeps explicit approval", () => {
    const i = read(".claude/skills/integrate/SKILL.md");
    for (const w of ["merge --no-ff", "merge --abort", "merge-tree", "ReparsePoint", "gate", "açık onay"]) expect(i, w).toContain(w);
    const s = read(".claude/skills/status/SKILL.md");
    expect(s).toContain("`integrate`");
    expect(s).not.toContain("merge --no-ff");
  });

  it("the tiered security rule lives only in status; delegate and the security-reviewer role refer to it", () => {
    expect(read(".claude/skills/status/SKILL.md")).toContain("Kademeli güvenlik kuralı");
    expect(read(".claude/skills/delegate/SKILL.md")).not.toContain("**Kademeli güvenlik kuralı:**");
    expect(read(".claude/skills/delegate/SKILL.md")).toContain("security-reviewer");
  });

  it("art-prompt routes character concepts to ChatGPT and keeps Codex for icons/effects/code", () => {
    const a = read(".claude/skills/art-prompt/SKILL.md");
    for (const w of ["ChatGPT", "art/source/", "-gpt-"]) expect(a, w).toContain(w);
    for (const r of ["game-developer", "game-director"]) {
      const b = read(`roles/${r}.md`);
      expect(b, r).toContain("art-prompt");
      expect(b, r).toMatch(/karakter konsept/);
    }
  });

  it("ci-triage and vlad-worker carry the CI round rule, idle-wait rule, visual-proof, permission patterns", () => {
    const w = read("global/skills/vlad-worker/SKILL.md");
    for (const x of ["ci-triage", "Boşta bekleme", "visual-proof", "İzin kalıpları", "Ölçüm:"]) expect(w, x).toContain(x);
    const c = read("global/skills/ci-triage/SKILL.md");
    for (const x of ["gh run watch", "--log-failed", "ikinci kez", "entegrasyon", "100755"]) expect(c, x).toContain(x);
  });
});
