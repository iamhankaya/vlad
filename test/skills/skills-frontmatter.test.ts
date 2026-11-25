import { readText } from "../skill-text.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readText(resolve(root, p));
const frontmatter = (md: string) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
const field = (md: string, key: string) => new RegExp(`^${key}:\s*(.+)$`, "m").exec(frontmatter(md))?.[1].trim() ?? "";

const NEW_VLAD_SKILLS = ["second-opinion", "integrate", "setup-audit", "release"];
const WORKER_SKILLS = ["vlad-worker"];

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
        expect(have.has(bare), `${f}: ${s}`).toBe(true);
      }
    }
  });
});

describe("skills/ references and de-duplication", () => {
  it("CLAUDE.md skill table lists the new skills and matches the skill dirs", () => {
    const c = read("CLAUDE.md");
    for (const n of NEW_VLAD_SKILLS) expect(c, n).toContain(n);
    expect(c).toContain("security-reviewer");
    expect(c).toContain("docs/commands.md"); // full command list is the generated reference (T20261110-09)
    expect(read("docs/commands.md")).toContain("`vlad task deps`");
  });

  it("setup-audit keeps its verification contract: optional items, mandatory check against later fixes, time coherence, doğrulandı column", () => {
    const t = read(".claude/skills/setup-audit/SKILL.md");
    for (const w of ["Madde zorunlu değil", "## 5. Doğrulama (zorunlu)", "decision list --project <slug> --all", "Zaman uyumu", "| doğrulandı", "plugin:skill", "vlad audit setup"]) expect(t, w).toContain(w);
    expect(t).not.toMatch(/en az \d+ öneri yaz/i);
  });

  it("setup-audit separates Claude mod candidates from vlad mode (yetki) candidates and reads installed mods", () => {
    const t = read(".claude/skills/setup-audit/SKILL.md");
    for (const w of ["| **Claude mod adayı**", "| **Yetki modu adayı (`vlad mode`)**", "enabledPlugins", "@claude-mods", "claude-mods/mods", "panel/band/status line/toast/hook/komut", "mod türü"]) expect(t, w).toContain(w);
    expect(t).not.toMatch(/\| \*\*Mod adayı\*\*/);
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

  it("integration-branch merge precondition applies only to pipeline dev phases (parent set), not single tasks", () => {
    for (const f of [".claude/skills/integrate/SKILL.md", ".claude/skills/status/SKILL.md"]) {
      const t = read(f);
      const line = t.split(/\r?\n/).find((l) => l.includes("entegrasyon branch'i merge + lint + gate"));
      expect(line, f).toBeDefined();
      expect(line, f).toMatch(/parent/);
      expect(line, f).toMatch(/tek görev/i);
    }
  });

  it("the tiered security rule lives only in integrate K1; status, delegate and the security-reviewer role refer to it", () => {
    expect(read(".claude/skills/integrate/SKILL.md")).toContain("Güvenlik incelemesi (kademeli)");
    for (const f of ["status", "delegate"]) expect(read(`.claude/skills/${f}/SKILL.md`), f).not.toContain("Kademeli güvenlik kuralı");
    expect(read(".claude/skills/delegate/SKILL.md")).toContain("security-reviewer");
  });

  it("game roles carry the ChatGPT art-prompt procedure (art-prompt skill folded in, T20261125-50) and keep Codex for icons/effects/code", () => {
    for (const r of ["game-developer", "game-director"]) {
      const b = read(`roles/${r}.md`);
      expect(b, r).toMatch(/karakter konsept/);
      expect(b, r).not.toContain("`art-prompt` skill'iyle");
    }
    const d = read("roles/game-director.md");
    for (const w of ["ChatGPT", "art/source/", "-gpt-", "PROMPT.md", "Stil bloğu"]) expect(d, w).toContain(w);
    expect(existsSync(resolve(root, ".claude/skills/art-prompt"))).toBe(false);
  });

  it("vlad-worker carries the CI round rule, idle-wait rule, CI triage (folded from ci-triage), visual-proof, permission patterns", () => {
    const w = read("global/skills/vlad-worker/SKILL.md");
    for (const x of ["CI izleme", "Boşta bekleme", "visual-proof", "İzin kalıpları", "Ölçüm:"]) expect(w, x).toContain(x);
    for (const x of ["gh run watch <run-id> --exit-status --interval 60", "--log-failed", "ikinci kez", "entegrasyon", "100755"]) expect(w, x).toContain(x);
    expect(existsSync(resolve(root, "global/skills/ci-triage"))).toBe(false);
  });
});

describe("kb lint cache refresh (F-vlad-182)", () => {
  it("/digest §5c and the /status morning report both run `vlad kb lint` (the cache `status --summary` reads)", () => {
    expect(read(".claude/skills/digest/SKILL.md")).toMatch(/### 5c[\s\S]*vlad kb lint --json/);
    const integrate = read(".claude/skills/integrate/SKILL.md");
    expect(integrate.slice(integrate.indexOf("**K8 — ")), "morning report step (integrate K8)").toMatch(/Sabah raporu[\s\S]*vlad kb lint --json/);
    expect(read(".claude/skills/status/SKILL.md")).toMatch(/\*\*sabah raporu\*\* `integrate` K7–K8/);
  });
});

describe("bulgu hijyeni (T20261109-24)", () => {
  it("bulgu-tarama has name == dir, trigger, 4 steps and the never-auto-close list", () => {
    const t = read(".claude/skills/bulgu-tarama/SKILL.md");
    expect(field(t, "name")).toBe("bulgu-tarama");
    expect(field(t, "description")).toMatch(/Kullan/);
    for (const w of ["## Adım 1", "## Adım 2", "## Adım 3", "## Adım 4", "kör", "kapat-fixed", "kapat-wontfix", "birleştir", "kalsın", "Asla otomatik kapatılmaz", "kritik", "güvenlik etkili", "D-…", "kullanıcının açtığı", "vlad finding set <id...>", "vlad kb commit", "vlad finding set <id> open"]) expect(t, w).toContain(w);
  });
  it("D-genel-008 and the finding-resolving-task rule are in digest, status and vlad-worker", () => {
    // T20261117-07: digest §4b is the single source; status keeps a one-line pointer.
    const t = read(".claude/skills/digest/SKILL.md");
    for (const w of ["D-genel-008", "yalnız kritik/yüksek", "[regresyon]", "[kalan F-…]"]) expect(t, `digest: ${w}`).toContain(w);
    const st = read(".claude/skills/status/SKILL.md");
    for (const w of ["D-genel-008", "`digest` §4b"]) expect(st, `status: ${w}`).toContain(w);
    expect(st, "status must not copy the finding-resolving-task rule").not.toContain("[kalan F-…]");
    const w = read("global/skills/vlad-worker/SKILL.md");
    for (const x of ["[regresyon]", "[kalan F-…]", "bulgu çözmekse"]) expect(w, x).toContain(x);
  });
});

