import { execFileSync } from "node:child_process";
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
import { makeHome, makeJunction } from "../helpers.js";
import { getTask } from "../../src/tasks/index.js";
import { isolatedEnv } from "../isolate-env.js";

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

  it("counts the real worker phrasings of a permission/classifier denial (T20261109-17 lines) but not unrelated lines (F-vlad-279 #1)", () => {
    const real = task({ at: "2026-10-29", progress: [
      "- 2026-11-09T18:13:56+03:00 push reddedildi (auto mode classifier, Bash). HEAD e32997c doğrulandı, ağaç temiz.",
      "- 2026-11-09T18:14:00+03:00 git push origin vlad/x (Bash) auto-mode sınıflayıcısı tarafından engellendi.",
      "- 2026-11-09T18:15:00+03:00 komut sınıflayıcı tarafından reddedildi",
      "- 2026-11-09T18:16:00+03:00 İzin reddi: git push origin vlad/x — auto mode classifier (Bash) reddedildi", // skill's format: one line, counted once
    ] });
    const plain = task({ at: "2026-10-29", progress: [
      "- 2026-10-29T10:00:00+03:00 PR yorumu reddedildi (kullanıcı vazgeçti)",
      "- 2026-10-29T10:01:00+03:00 sınıflandırma testi yazıldı; classifier modülü eklendi",
      "- 2026-10-29T10:02:00+03:00 başvuru engellendi: ağ kesintisi",
      "- 2026-10-29T10:03:00+03:00 classifier testi eklendi; xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx eski test reddedildi",
    ] });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.signals.izin_reddi).toEqual({ tasks: 1, count: 4, examples: [real] });
    expect(plain).not.toBe(real);
  });

  it("counts Codex rounds from the structural İlerleme line only (last line per task, template text ignored)", () => {
    const a = task({ at: "2026-10-28", progress: ["- 2026-10-28T10:00:00+03:00 Codex turları: ara=1 son=1", "- 2026-10-28T12:00:00+03:00 Codex turları: ara=2 son=2"] });
    const b = task({ at: "2026-10-29", progress: ["- 2026-10-29T10:00:00+03:00 Codex turları: ara=0 son=1"] });
    // template/quoted text is not a measure
    task({ at: "2026-10-29", progress: ["- 2026-10-29T10:00:00+03:00 not: `Codex turları: ara=<n> son=<n>` satırı yazılır", "- 2026-10-29T10:01:00+03:00 yorum Codex turları: ara=9 son=9"] });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.signals.codex_turlari).toEqual({ tasks: 2, count: 5, ara: 2, son: 3, examples: [a, b] });
  });

  it("Codex rounds: zero-round line counts the task, trailing space/CRLF accepted, loose lines rejected", () => {
    const z = task({ at: "2026-10-28", progress: ["- 2026-10-28T10:00:00+03:00 Codex turları: ara=0 son=0  \r"] });
    task({ at: "2026-10-29", progress: ["- 2026-10-29T10:00:00+03:00 Codex turları: ara=1 son=2 fazladan metin", "Codex turları: ara=3 son=3"] });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.signals.codex_turlari).toEqual({ tasks: 1, count: 0, ara: 0, son: 0, examples: [z] });
  });

  it("Codex rounds outside --since are not counted", () => {
    task({ at: "2026-09-01", progress: ["- 2026-09-01T10:00:00+03:00 Codex turları: ara=4 son=4"] });
    expect(auditSetup({ since: "2026-10-01", configDir: cfgDir }).signals.codex_turlari.tasks).toBe(0);
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
    expect(byName["superpowers:test-driven-development"].roles).toEqual(["developer"]); // keyed by the name the role uses
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

  it("anchors [KARAR] and Ölçüm to line starts so quoted or template text does not count", () => {
    const id = task({
      at: "2026-10-28",
      progress: ["- 2026-10-28T11:00:00+03:00 [KARAR] gerçek", "- 2026-10-28T11:05:00+03:00 şablon: '[KARAR] ...' yazılır"],
      closing: "### Yapılanlar\nÖlçüm satırı biçimi `Ölçüm: dosya=<n>` ile yazılır\n\nÖlçüm: dosya=2 yeni_test=1\n",
    });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.signals.karar).toEqual({ tasks: 1, count: 1, examples: [id] });
    expect(r.measures.sums).toEqual({ dosya: 2, yeni_test: 1 });
  });

  it("splits measure sums by the ponytail experiment arm (tasks without the field are in neither)", () => {
    const withArm = (arm: "on" | "off", measure: string) => {
      const id = task({ at: "2026-11-04", closing: `### Yapılanlar\n${measure}\n` });
      const t = getTask(id);
      t.data.experiment = { ponytail: arm };
      writeDoc(t.file, t.data, t.body);
    };
    withArm("on", "Ölçüm: dosya=3 yeni_test=2");
    withArm("on", "Ölçüm: dosya=1 yeni_test=1");
    withArm("off", "Ölçüm: dosya=5 yeni_test=4");
    task({ at: "2026-11-04", closing: "### Yapılanlar\nÖlçüm: dosya=9\n" });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.measures.by_ponytail).toEqual({
      on: { tasks: 2, tasks_with_measure: 2, sums: { dosya: 4, yeni_test: 3 } },
      off: { tasks: 1, tasks_with_measure: 1, sums: { dosya: 5, yeni_test: 4 } },
    });
    expect(r.measures.sums.dosya).toBe(18); // totals still include every task
  });

  it("leaves tasks started before the prompt-truncation fix out of the ponytail A/B split (T20261103-26)", () => {
    const arm = (at: string, a: "on" | "off") => {
      const id = task({ at, closing: "### Yapılanlar\nÖlçüm: dosya=2\n" });
      const t = getTask(id); t.data.experiment = { ponytail: a }; writeDoc(t.file, t.data, t.body);
    };
    arm("2026-11-02", "off"); arm("2026-11-02", "on"); // truncated prompts: not comparable
    arm("2026-11-04", "off");
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.measures.by_ponytail).toEqual({
      on: { tasks: 0, tasks_with_measure: 0, sums: {} },
      off: { tasks: 1, tasks_with_measure: 1, sums: { dosya: 2 } },
    });
    expect(r.measures.sums.dosya).toBe(6); // totals still count them
  });

  it("splits cancelled tasks by whether a reason is recorded", () => {
    const a = task({ at: "2026-10-28", state: "cancelled", progress: ["- 2026-10-28T11:00:00+03:00 iptal: kullanıcı vazgeçti"] });
    const b = task({ at: "2026-10-28", state: "cancelled" });
    task({ at: "2026-10-28" });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.cancelled).toEqual({ total: 2, with_reason: 1, without_reason_ids: [b] });
    expect(a).not.toBe(b);
  });

  it("recognises Turkish capital İ: 'İptal: …' reason and 'İzin reddi' signal (JS /i does not fold İ to i)", () => {
    const a = task({ at: "2026-10-28", state: "cancelled", progress: ["- 2026-10-28T11:00:00+03:00 İptal: kullanıcı vazgeçti"] });
    const b = task({ at: "2026-10-28", progress: ["- 2026-10-28T11:00:00+03:00 İzin reddi: git push"] });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.cancelled).toEqual({ total: 1, with_reason: 1, without_reason_ids: [] });
    expect(r.signals.izin_reddi).toEqual({ tasks: 1, count: 1, examples: [b] });
    expect(a).not.toBe(b);
  });

  it("does not take a leftover error value or mid-sentence 'iptal' as a cancellation reason", () => {
    const id = task({ at: "2026-10-28", state: "cancelled", progress: ["- 2026-10-28T11:00:00+03:00 iptal edilen test geçti sanıldı"].map((l) => l.replace("iptal edilen", "test: iptal edilen")) });
    const t = getTask(id);
    t.data.error = "eski failed nedeni"; // left over from failed → cancelled
    writeDoc(t.file, t.data, t.body);
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.cancelled).toEqual({ total: 1, with_reason: 0, without_reason_ids: [id] });
  });

  it("finds a user skill that is a junction/symlink to a directory", () => {
    const real = join(cfgDir, "real", "linked");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "---\nname: linked\n---\n");
    mkdirSync(join(cfgDir, "skills"), { recursive: true });
    makeJunction(join(cfgDir, "skills", "linked"), real, cfgDir);
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.skills.inventory.find((s) => s.name === "linked")?.source).toBe("user");
  });

  it("breaks unresolved findings down by severity, project and source task", () => {
    addFinding({ project: "alpha", severity: "yüksek", source: "T20261001-01", title: "a" });
    addFinding({ project: "alpha", severity: "düşük", source: "T20261001-01", title: "b" });
    addFinding({ project: "alpha", severity: "düşük", source: "T20261002-01", title: "c" });
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    expect(r.findings.by_severity).toEqual({ yüksek: 1, düşük: 2 });
    expect(r.findings.by_project).toEqual({ alpha: 3 });
    expect(r.findings.by_source).toEqual({ "T20261001-01": 2, "T20261002-01": 1 });
  });

  it("lists user and plugin skills as plugin:skill and matches role skills by that name", () => {
    const put = (rel: string) => { mkdirSync(join(cfgDir, rel), { recursive: true }); writeFileSync(join(cfgDir, rel, "SKILL.md"), "---\nname: x\n---\n"); };
    put("skills/my-global");
    put("plugins/cache/mkt/superpowers/6.4.2/skills/test-driven-development");
    put("plugins/cache/mkt/superpowers/6.4.1/skills/test-driven-development"); // older cached version: one entry
    role("developer", ["superpowers:test-driven-development", "frontend-design:frontend-design"]);
    const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
    const byName = Object.fromEntries(r.skills.inventory.map((s) => [s.name, s]));
    expect(byName["my-global"].source).toBe("user");
    expect(r.skills.inventory.filter((s) => s.name === "superpowers:test-driven-development")).toHaveLength(1);
    expect(byName["superpowers:test-driven-development"]).toMatchObject({ source: "plugin", roles: ["developer"] });
    expect(byName["frontend-design:frontend-design"]).toMatchObject({ source: "role", roles: ["developer"] }); // named by a role, installed nowhere
  });

  describe("time coherence (rule dates from the VLAD repo's git history)", () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: home, env: { ...isolatedEnv(), GIT_COMMITTER_DATE: process.env.D, GIT_AUTHOR_DATE: process.env.D } });
    const commitAt = (iso: string, msg: string) => { process.env.D = iso; git("add", "roles"); git("commit", "-q", "-m", msg); };
    const roleFile = (skills: string[]) => role("developer", skills);
    const loadSkill = (id: string, skill: string) => {
      const dir = join(cfgDir, "projects", claudeProjectDir(worktreePath(defaultConfig(), join(tmpdir(), "vlad-setup-repo"), id)));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "s.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] } }) + "\n");
    };
    beforeEach(() => {
      git("init", "-q");
      roleFile(["superpowers:test-driven-development"]);
      commitAt("2026-10-01T10:00:00+03:00", "role: tdd");
      roleFile(["superpowers:test-driven-development", "frontend-design:frontend-design"]);
      commitAt("2026-10-30T10:00:00+03:00", "role: frontend-design");
    });

    it("measures a task only against rules that already existed on its creation date", () => {
      const before = task({ at: "2026-10-20", role: "developer" }); // frontend-design not yet in the role
      const after = task({ at: "2026-10-31", role: "developer" });
      loadSkill(before, "superpowers:test-driven-development");
      loadSkill(after, "superpowers:test-driven-development"); // never loads frontend-design
      const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
      const row = (skill: string) => r.skills.coverage.by_skill.find((c) => c.skill === skill);
      expect(row("superpowers:test-driven-development")).toMatchObject({ role: "developer", expected_tasks: 2, loaded_tasks: 2, rate: 1 });
      expect(row("frontend-design:frontend-design")).toMatchObject({ expected_tasks: 1, loaded_tasks: 0, rate: 0, since: "2026-10-30T10:00:00+03:00" });
      expect(r.skills.coverage.skipped_before_rule).toBe(1);
    });

    it("counts a removed and re-added role skill from the re-adding, and flags an uncommitted one as since_unknown", () => {
      roleFile(["superpowers:test-driven-development"]); // frontend-design removed
      commitAt("2026-10-31T10:00:00+03:00", "role: drop");
      roleFile(["superpowers:test-driven-development", "frontend-design:frontend-design"]);
      commitAt("2026-11-01T10:00:00+03:00", "role: re-add");
      const early = task({ at: "2026-10-31", role: "developer" }); // would count if the first adding (10-30) were used
      loadSkill(early, "superpowers:test-driven-development");
      roleFile(["superpowers:test-driven-development", "frontend-design:frontend-design", "other:fresh"]); // never committed
      const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
      const row = (skill: string) => r.skills.coverage.by_skill.find((c) => c.skill === skill);
      expect(row("frontend-design:frontend-design")).toBeUndefined(); // the only task predates the re-adding
      expect(r.skills.coverage.skipped_before_rule).toBe(1);
      expect(row("other:fresh")).toMatchObject({ since: null, since_unknown: true, expected_tasks: 1 });
      expect(row("superpowers:test-driven-development")).toMatchObject({ since_unknown: false });
    });

    it("does not expect ponytail from a task that ran on the experiment's off arm", () => {
      roleFile(["superpowers:test-driven-development", "ponytail"]);
      const on = task({ at: "2026-10-31", role: "developer" });
      const off = task({ at: "2026-10-31", role: "developer" });
      const t = getTask(off); t.data.experiment = { ponytail: "off" }; writeDoc(t.file, t.data, t.body);
      loadSkill(on, "superpowers:test-driven-development"); loadSkill(on, "ponytail");
      loadSkill(off, "superpowers:test-driven-development");
      const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
      const row = (skill: string) => r.skills.coverage.by_skill.find((c) => c.skill === skill);
      expect(row("ponytail")).toMatchObject({ expected_tasks: 1, loaded_tasks: 1, rate: 1 });
      expect(row("superpowers:test-driven-development")).toMatchObject({ expected_tasks: 2 });
    });

    it("reports when each role file and CLAUDE.md last changed", () => {
      const r = auditSetup({ since: "2026-10-01", configDir: cfgDir });
      expect(r.rules.roles.developer).toBe("2026-10-30T10:00:00+03:00");
      expect(r.rules.claude_md).toBeNull(); // not committed in the fixture repo
    });
  });

  it("rejects an invalid since", () => {
    expect(() => auditSetup({ since: "dün", configDir: cfgDir })).toThrow(/geçersiz --since/);
  });
});
