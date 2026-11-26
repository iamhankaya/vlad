import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT_FILES, extractCalls, find, flagsOf, prog, root, type Call } from "../skill-contract-lib.js";

// T20261126-15: skill/doc text <-> CLI contract. Text that names a command or a flag that does not exist
// (typically after a CLI change that was not carried into the texts) turns this red in the gate.
// JSON field references: test/cli/skill-json-contract.test.ts.

/** Documented exceptions (gerekçeli): key `<dosya>|<komut yolu> <bayrak>` ya da `<dosya>|<kod aralığı metni>`. */
export const CALL_ALLOW: Record<string, string> = {};
const allow = (c: Call, what: string) => what in CALL_ALLOW || `${c.file}|${what}` in CALL_ALLOW;

describe("skill/doc text ↔ CLI: komut ve bayrak sözleşmesi", () => {
  const all = TEXT_FILES.flatMap((f) => extractCalls(f, readFileSync(f, "utf8")));
  it("metin dosyaları ve çağrılar bulundu (boş tarama yeşil sayılmaz)", () => {
    expect(TEXT_FILES.length).toBeGreaterThan(15);
    expect(all.length).toBeGreaterThan(100);
  });
  it("her `vlad <komut>` çağrısının komutu gerçek CLI'da var", () => {
    const bad = all.filter((c) => (c.path.length === 0 || c.path.at(-1)!.startsWith("?")) && !allow(c, c.text)).map((c) => `${c.file}:${c.line} \`${c.text.slice(0, 80)}\``);
    expect(bad).toEqual([]);
  });
  it("her çağrıdaki --bayrak o komutta (ya da üst komutta) tanımlı", () => {
    const bad: string[] = [];
    for (const c of all) {
      if (c.path.length === 0 || c.path.at(-1)!.startsWith("?")) continue;
      const known = flagsOf(find(prog, ...c.path)!);
      for (const f of c.flags) if (!known.has(f) && !allow(c, `${c.path.join(" ")} ${f}`)) bad.push(`${c.file}:${c.line} vlad ${c.path.join(" ")} ${f}`);
    }
    expect(bad).toEqual([]);
  });
  it("yakalama: var olmayan komut ve bayrak yazılınca kırmızı çıkar", () => {
    const calls = extractCalls("CLAUDE.md", "`vlad project status x --yok-bayrak` ve `vlad olmayan komut`");
    const real = find(prog, ...calls[0].path)!;
    expect(calls[0].path).toEqual(["project", "status"]);
    expect(flagsOf(real).has(calls[0].flags[0])).toBe(false);
    expect(calls.some((c) => c.path.at(-1) === "?olmayan")).toBe(true);
  });
  it("yakalama: yanlış alt komut, rakamlı/büyük harfli bayrak, `\\` devamı ve ~~~ çiti", () => {
    expect(extractCalls("x.md", "`vlad task lst --full`").some((c) => c.path.at(-1) === "?lst")).toBe(true);
    expect(extractCalls("x.md", "`vlad task list --json2x --Full`")[0].flags).toEqual(["--json2x", "--Full"]);
    expect(extractCalls("x.md", "```sh\nvlad task list \\\n  --yok-bayrak\n```")[0].flags).toEqual(["--yok-bayrak"]);
    expect(extractCalls("x.md", "~~~\nvlad task list --yok\n~~~")[0].flags).toEqual(["--yok"]);
  });
});

describe("CLAUDE.md boyutu", () => {
  it("8,5 KB (8500 B) altında kalır; ayrıntı docs/claude-ayrinti.md'ye taşınır", () => {
    expect(statSync(join(root, "CLAUDE.md")).size).toBeLessThanOrEqual(8500);
  });
});
