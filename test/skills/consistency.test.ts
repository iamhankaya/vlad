import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// F-vlad-165: the same rule (trigger threshold, round limit) is written in CLAUDE.md and several skills; a number edited in one place must not drift from the others.
const root = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const TEXT = {
  claude: read("CLAUDE.md"),
  status: read(".claude/skills/status/SKILL.md"),
  second: read(".claude/skills/second-opinion/SKILL.md"),
  integrate: read(".claude/skills/integrate/SKILL.md"),
  delegate: read(".claude/skills/delegate/SKILL.md"),
};
type Doc = keyof typeof TEXT;

/** Each (doc, regex) must match, and every capture must be the same number. */
function agree(rule: string, sources: [Doc, RegExp][]): number {
  const found = sources.map(([doc, re]) => {
    const m = re.exec(TEXT[doc]);
    expect(m, `${rule}: ${doc} states no value (${re})`).not.toBeNull();
    return { doc, n: Number(m![1]) };
  });
  expect(new Set(found.map((f) => f.n)).size, `${rule}: ${found.map((f) => `${f.doc}=${f.n}`).join(", ")}`).toBe(1);
  return found[0].n;
}

describe("skill / CLAUDE.md consistency", () => {
  it("interim Codex gate: round limit per phase", () => {
    expect(agree("ara kapı tur sınırı", [
      ["claude", /ara Codex kapısı \(faz başına en çok (\d+) tur/],
      ["status", /Ara Codex kapısı[^\n]*faz başına en çok (\d+) tur\b/],
      ["second", /Faz başına en çok (\d+) ara düzeltme turu/],
    ])).toBe(2);
  });
  it("interim Codex gate: diff-size trigger", () => {
    agree("ara kapı eşiği", [
      ["claude", /büyük \((\d+)\+ satır\)/],
      ["status", /Ara Codex kapısı[^\n]*?(\d+)\+ satırlık/],
      ["second", /(\d+)\+ satırlık uygulama dilimi/],
    ]);
  });
  it("final gate: Codex fix rounds", () => {
    agree("son kapı tur sınırı", [
      ["claude", /son kapıda en çok (\d+) düzeltme turu/],
      ["status", /son kapıda en çok (\d+) düzeltme turu/],
      ["integrate", /son kapıda en çok (\d+) düzeltme turu/],
    ]);
  });
  it("security review: change rounds per phase", () => {
    agree("güvenlik tur sınırı", [
      ["claude", /en çok (\d+) değişiklik turu/],
      ["status", /faz başına en çok (\d+) güvenlik değişiklik turu/],
    ]);
  });
  it("the interim-gate trigger has one definition (status); the others point to it", () => {
    expect(TEXT.status).toMatch(/Ara Codex kapısı \(tetikleyicinin tek tanımı\)/);
    expect(TEXT.second).toMatch(/Tetikleyici `\/status`'taki "Ara Codex kapısı" maddesinde tek yerde tanımlıdır/);
    expect(TEXT.delegate).not.toMatch(/\d+\+ satırlık/); // no second copy of the threshold
  });
  it("a phase running on another machine skips the interim gate: both skills say so (F-vlad-166)", () => {
    expect(TEXT.status).toMatch(/başka makinede \*koşuyorsa\* ara kapı atlanır/);
    expect(TEXT.second).toMatch(/Faz başka makinede koşuyorsa[^\n]*ara kapı atlanır/);
  });
});
