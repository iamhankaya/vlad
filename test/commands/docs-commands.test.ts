import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { COMMAND_DOCS } from "../../src/commands/docs-data.js";
import { renderCommandsDoc, validateDocs } from "../../src/commands/docs.js";

const file = resolve(import.meta.dirname, "../../docs/commands.md");

describe("docs/commands.md (generated from the manifest)", () => {
  it("every manifest command has a description and no description is orphaned", () => {
    expect(validateDocs()).toEqual([]);
  });
  it("validateDocs flags a missing and an orphaned entry", () => {
    const errs = validateDocs(COMMANDS.slice(0, 2), { "scan": "x", "nope": "y" });
    expect(errs.some((e) => e.includes("açıklama yok: project write"))).toBe(true);
    expect(errs.some((e) => e.includes("nope"))).toBe(true);
  });
  it("is up to date (run: npm run build && npm run docs:commands)", () => {
    expect(readFileSync(file, "utf8")).toBe(renderCommandsDoc());
  });
  it("lists every manifest command", () => {
    const text = readFileSync(file, "utf8");
    for (const s of COMMANDS) expect(text).toContain(`\`vlad ${s.path.join(" ")}\``);
  });
  it("keeps the behaviour notes that used to live in CLAUDE.md", () => {
    const text = renderCommandsDoc();
    for (const n of ["`cancelled` için `--reason", "hepsi-ya-hiç", "`--no-mark`", "<1 sn", "benzer açık bulgu"]) expect(text).toContain(n);
    expect(Object.keys(COMMAND_DOCS).length).toBe(COMMANDS.length);
  });
  it("does not carry stale behaviour text (maintain default 14 days, hook lint, short task list, report guidance)", () => {
    const text = renderCommandsDoc();
    expect(text).not.toContain("--days 30");
    expect(text).toContain("--days 14");
    expect(text).not.toContain("hook lint çalıştırmaz");
    expect(text).toMatch(/hook[^.]*lint[^.]*(eski|10 sn)/);
    expect(COMMAND_DOCS["task list"]).toMatch(/effective_model[^.]*kısa/);
    for (const f of ["roles/developer.md", "global/skills/vlad-worker/SKILL.md", "CLAUDE.md"]) {
      const t = readFileSync(resolve(import.meta.dirname, "../..", f), "utf8");
      expect(t, f).not.toContain("CLAUDE.md komut satırı önerisi");
    }
    for (const f of ["roles/developer.md", "global/skills/vlad-worker/SKILL.md"]) {
      expect(readFileSync(resolve(import.meta.dirname, "../..", f), "utf8"), f).toContain("docs-data.ts");
    }
  });
});
