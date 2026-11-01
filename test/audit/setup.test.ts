import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditSetup } from "../../src/audit/setup.js";
import { kbPaths, writeDoc } from "../../src/kb/index.js";
import { addFinding } from "../../src/findings/store.js";
import { defaultConfig } from "../../src/kb/index.js";
import { worktreePath } from "../../src/git/git.js";
import { claudeProjectDir } from "../../src/tasks/liveness.js";
import { createTask } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

let home: string;
let cfgDir: string;
beforeEach(() => {
  home = makeHome();
  cfgDir = mkdtempSync(join(tmpdir(), "vlad-setup-cfg-")); // empty claude config: no transcripts
  writeFileSync(join(kbPaths().projects, "alpha.md"), `---\nslug: alpha\nname: A\npath: ${JSON.stringify(join(tmpdir(), "vlad-setup-repo"))}\nstack: []\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n`);
});

const report = (measure: string, points: string[] = []) =>
  `### Yapılanlar\n- x\n${measure}\n\n### Test sonuçları\n- ok\n\n### Açık noktalar\n${points.join("\n")}\n`;

/** Writes a finished task whose `updated` is `at` (ISO date); body gets the given sections. */
function task(o: { at: string; role?: string; phase?: string; state?: string; progress?: string[]; questions?: string[]; closing?: string; prior?: number; model?: string }) {
  const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "", role: o.role, phase: o.phase, model: o.model, modelReason: o.model === "opus" ? "r" : undefined }, new Date(`${o.at}T10:00:00+03:00`));
  t.data.state = (o.state ?? "done") as never;
  t.data.updated = `${o.at}T12:00:00+03:00`;
  const body = `## Tanım\nd\n\n## Kabul kriterleri\n\n## Bağlam\n\n## İlerleme\n${(o.progress ?? []).join("\n")}\n\n## Sorular\n${(o.questions ?? []).join("\n")}\n\n## Kapanış raporu\n${o.closing ?? ""}\n${o.prior ? `\n## Önceki raporlar\n${Array.from({ length: o.prior }, (_, i) => `### Önceki rapor #${i + 1}\nTest itirazı: eski metin\n`).join("")}` : ""}`;
  writeDoc(t.file, t.data, body);
  return t.data.id;
}

function role(slug: string, skills: string[] = []) {
  mkdirSync(join(home, "roles"), { recursive: true });
  const list = skills.length ? `skills:\n${skills.map((x) => `  - ${x}`).join("\n")}\n` : "";
  writeFileSync(join(home, "roles", `${slug}.md`), `---\nslug: ${slug}\ntitle: T\nkind: executor\nsummary: s\n${list}---\n`);
}

function skillDir(rel: string, name: string) {
  const d = join(home, rel, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

describe("auditSetup", () => {
  it("counts only done/cancelled tasks updated since the date; empty range is all zeros", () => {
    role("developer"); role("tester");
    const old = task({ at: "2026-10-20" });
    const a = task({ at: "2026-10-28", role: "developer" });
    const b = task({ at: "2026-10-29", role: "tester", state: "cancelled" });
    task({ at: "2026-10-29", state: "running" });
    const r = auditSetup({ since: "2026-10-25", configDir: cfgDir, now: new Date("2026-11-01T00:00:00+03:00") });
    expect(r.tasks.total).toBe(2);
    expect(r.tasks.ids).toEqual([a, b].sort());
    expect(r.tasks.ids).not.toContain(old);
    expect(r.tasks.by_role).toEqual({ developer: 1, tester: 1 });

    const empty = auditSetup({ since: "2026-11-02", configDir: cfgDir, now: new Date("2026-11-03T00:00:00+03:00") });
    expect(empty.tasks).toMatchObject({ total: 0, ids: [], by_role: {} });
    expect(empty.measures).toMatchObject({ tasks_with_measure: 0, sums: {} });
    expect(empty.open_points).toEqual({ total: 0, by_severity: {} });
    expect(empty.signals.test_itirazi).toEqual({ tasks: 0, count: 0, examples: [] });
  });

  it("sums Ölçüm lines (last one per task) and counts Açık noktalar by severity", () => {
    task({ at: "2026-10-28", closing: report("Ölçüm: dosya=3 satır=+10/-2 yeni_test=4 ci_tur=1 review_bulgusu=2", ["- [yüksek] a — x", "- [düşük] b — y", "- [düşük] c — z"]) });
    task({ at: "2026-10-29", closing: report("Ölçüm: dosya=1 satır=+1/-0 yeni_test=2 ci_tur=0 review_bulgusu=5", ["- [orta] d — w"]) });
    task({ at: "2026-10-29", closing: report("(ölçüm yok)") });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.measures.tasks_with_measure).toBe(2);
    expect(r.measures.sums).toMatchObject({ yeni_test: 6, ci_tur: 1, review_bulgusu: 7, satir_eklenen: 11, satir_silinen: 2 });
    expect(r.open_points.total).toBe(4);
    expect(r.open_points.by_severity).toEqual({ yüksek: 1, düşük: 2, orta: 1 });
  });

  it("counts test objections, change rounds, [KARAR] and permission denials with example ids", () => {
    // only the **Soru:** line counts: the answer, the report text and earlier reports quote the phrase too
    const a = task({
      at: "2026-10-28",
      questions: ["- 2026-10-28T10:00:00+03:00 **Soru:** Test itirazı: x.test.ts:3 — yanlış", "- 2026-10-28T10:30:00+03:00 **Cevap:** Test itirazı kabul"],
      closing: "### Yapılanlar\nTest itirazı: anlatım\n",
      progress: ["- 2026-10-28T11:00:00+03:00 [KARAR] kabul", "- 2026-10-28T11:05:00+03:00 [KARAR] ikinci"],
      prior: 3,
    });
    const b = task({ at: "2026-10-29", progress: ["- 2026-10-29T11:00:00+03:00 push izin reddi: gh pr create"] });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.signals.test_itirazi).toEqual({ tasks: 1, count: 1, examples: [a] });
    expect(r.signals.degisiklik_istegi).toEqual({ tasks: 1, count: 3, examples: [a] });
    expect(r.signals.karar).toEqual({ tasks: 1, count: 2, examples: [a] });
    expect(r.signals.izin_reddi).toEqual({ tasks: 1, count: 1, examples: [b] });
  });

  it("inventories skills from the four sources and flags the ones never loaded", () => {
    skillDir(".claude/skills", "digest");
    skillDir("global/skills", "vlad-worker");
    skillDir("vendor/skills", "ponytail");
    mkdirSync(join(home, "roles"), { recursive: true });
    writeFileSync(join(home, "roles", "developer.md"), `---\nslug: developer\ntitle: D\nkind: executor\nsummary: s\nskills:\n  - superpowers:test-driven-development\n---\n`);
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    const byName = Object.fromEntries(r.skills.inventory.map((s) => [s.name, s]));
    expect(byName.digest.source).toBe("repo");
    expect(byName["vlad-worker"].source).toBe("global");
    expect(byName.ponytail.source).toBe("vendor");
    expect(byName["test-driven-development"].roles).toEqual(["developer"]);
    expect(r.skills.unused).toEqual(expect.arrayContaining(["digest", "ponytail"]));
  });

  it("counts a skill as loaded even when the worker was not expected to load it", () => {
    const repo = join(tmpdir(), "vlad-setup-repo");
    skillDir(".claude/skills", "digest");
    role("developer");
    const id = task({ at: "2026-10-28", role: "developer" });
    const dir = join(cfgDir, "projects", claudeProjectDir(worktreePath(defaultConfig(), repo, id)));
    mkdirSync(dir, { recursive: true });
    const use = (skill: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] } });
    writeFileSync(join(dir, "s.jsonl"), [use("vlad-worker"), use("digest")].join("\n") + "\n");
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.skills.transcripts).toBe(1);
    expect(r.skills.inventory.find((s) => s.name === "digest")?.loaded).toBe(1);
    expect(r.skills.unused).not.toContain("digest");
  });

  it("lists unresolved findings oldest first with age in days", () => {
    const f1 = addFinding({ project: "alpha", severity: "yüksek", source: "T20261001-01", title: "eski" }, new Date("2026-09-01T10:00:00+03:00"));
    addFinding({ project: "alpha", severity: "düşük", source: "T20261002-01", title: "yeni" }, new Date("2026-10-30T10:00:00+03:00"));
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir, now: new Date("2026-11-01T10:00:00+03:00") });
    expect(r.findings.unresolved.map((f) => f.id)).toEqual([f1.data.id, "F-alpha-002"]);
    expect(r.findings.unresolved[0]).toMatchObject({ severity: "yüksek", age_days: 61 });
    expect(r.findings.stale).toBe(1);
  });

  it("rejects an invalid since", () => {
    expect(() => auditSetup({ since: "dün", configDir: cfgDir })).toThrow(/geçersiz --since/);
  });
});
