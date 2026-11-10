import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// T20261110-16: gate rules (F-vlad-165 drift guard) live ONLY in integrate K1–K8. Other docs point to them; a number or definition copied elsewhere is a regression.
const root = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const TEXT = {
  claude: read("CLAUDE.md"),
  status: read(".claude/skills/status/SKILL.md"),
  second: read(".claude/skills/second-opinion/SKILL.md"),
  integrate: read(".claude/skills/integrate/SKILL.md"),
  delegate: read(".claude/skills/delegate/SKILL.md"),
  digest: read(".claude/skills/digest/SKILL.md"),
};
const COPIES = ["claude", "status", "second", "delegate"] as const;
const K = (n: number) => new RegExp(`\\*\\*K${n} — `);

describe("gate rules: integrate is the single source", () => {
  it("integrate defines K1–K8", () => {
    for (let n = 1; n <= 8; n++) expect(TEXT.integrate, `K${n}`).toMatch(K(n));
  });
  it("round limits are defined once, in integrate", () => {
    expect(TEXT.integrate).toMatch(/faz başına en çok 2 tur/); // K2 interim gate
    expect(TEXT.integrate).toMatch(/500\+ satırlık uygulama dilimi/);
    expect(TEXT.integrate).toMatch(/Son kapıda en çok 2 düzeltme turu/); // K3
    expect(TEXT.integrate).toMatch(/Faz başına en çok 1 güvenlik değişiklik turu/); // K1
    for (const d of COPIES) {
      expect(TEXT[d], `${d} copies a round limit`).not.toMatch(/en çok \d+ (düzeltme|değişiklik|güvenlik|ara|tur)|faz başına en çok \d+|\d+\+ satırlık/);
    }
  });
  it("the interim-gate trigger and the remote-machine skip have one definition (integrate K2)", () => {
    expect(TEXT.integrate).toMatch(/Ara Codex kapısı \(tetikleyicinin tek tanımı\)/);
    expect(TEXT.integrate).toMatch(/başka makinede \*koşuyorsa\* ara kapı atlanır/); // F-vlad-166
    for (const d of ["status", "second", "delegate"] as const) expect(TEXT[d], d).toMatch(/integrate` K2/);
    expect(TEXT.status).not.toMatch(/başka makinede \*koşuyorsa\*/);
  });
  it("night mode, morning report and staleSummaries are defined once (K7–K8)", () => {
    expect(TEXT.integrate).toMatch(/staleSummaries/);
    expect(TEXT.integrate).toMatch(/night\.push/);
    expect(TEXT.integrate).toMatch(/Sabah raporu/);
    for (const d of COPIES) expect(TEXT[d], `${d} copies night.push`).not.toMatch(/night\.push/);
    for (const d of ["status", "second", "delegate"] as const) expect(TEXT[d], `${d} copies staleSummaries`).not.toMatch(/staleSummaries/); // CLAUDE.md only names the session-start hook field
    expect(TEXT.status).toMatch(/integrate` K7–K8/);
  });
  it("security tiering and Codex fallback are defined once (K1, K4)", () => {
    expect(TEXT.integrate).toMatch(/`exposure`'ı `internet`/);
    expect(TEXT.integrate).toMatch(/model `fable` \(yoksa `sonnet`\)/);
    for (const d of COPIES) {
      expect(TEXT[d], `${d} copies exposure rule`).not.toMatch(/`exposure`'ı `internet`/);
      expect(TEXT[d], `${d} copies fallback model rule`).not.toMatch(/model `fable`/);
    }
    expect(TEXT.status).toMatch(/integrate` K1/);
    expect(TEXT.second).toMatch(/integrate` K4/);
  });
  it("the Codex round-count line format and the multi-machine gate rule are in integrate only (K5, K6)", () => {
    expect(TEXT.integrate).toMatch(/"Codex turları: ara=<n> son=<n>"/);
    expect(TEXT.integrate).toMatch(/Gate <makine>: yeşil <sha>/);
    for (const d of ["claude", "second", "delegate"] as const) expect(TEXT[d], d).not.toMatch(/Codex turları: ara=/);
    for (const d of ["claude", "status"] as const) expect(TEXT[d], d).not.toMatch(/Gate <makine>: yeşil/);
  });
});

describe("cloud kb sync (§0) is defined once, in CLAUDE.md", () => {
  it("CLAUDE.md holds the pull --ff-only rule; the three skills point to it", () => {
    expect(TEXT.claude).toMatch(/## Bulutta kb senkronu[\s\S]*git -C <kbDir> pull --ff-only/);
    for (const d of ["status", "delegate", "digest"] as const) {
      expect(TEXT[d], d).toMatch(/## 0\. Bulutta kb senkronu[\s\S]{0,200}"Bulutta kb senkronu" bölümü/);
      expect(TEXT[d], `${d} copies the pull command`).not.toMatch(/pull --ff-only/);
    }
  });
});
