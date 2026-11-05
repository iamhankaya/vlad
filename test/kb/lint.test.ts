import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDecision, setDecisionStatus } from "../../src/kb/decisions.js";
import { DERIVED_CLOSE, derivedOpen } from "../../src/kb/derived.js";
import { formatLint, lintExitCode, lintKb } from "../../src/audit/lint.js";
import { makeHome } from "../helpers.js";
import { isolatedEnv } from "../isolate-env.js";

let home: string;
const kb = (...p: string[]) => join(home, "kb", ...p);
const NOW = new Date("2026-11-03T12:00:00+03:00");
const BASE_CFG = { roots: ["/yok/root"], ignore: [], defaultAutonomy: "commit", staleAfterHours: 6, launcher: "auto" };
const writeCfg = (extra: object = {}) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ ...BASE_CFG, ...extra }));

const card = (slug: string, sections: string, status = "active") =>
  `---\nslug: ${slug}\nname: ${slug}\npath: "/yok"\nstack: [ts]\nstatus: ${status}\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n${sections}`;
const writeCard = (slug: string, sections: string, status = "active") => writeFileSync(kb("projects", `${slug}.md`), card(slug, sections, status));
const task = (id: string, state: string, updated = "2026-11-01T10:00:00+03:00", project = "vlad") => {
  writeFileSync(kb("tasks", `${id}.md`), `---\nid: ${id}\nproject: ${project}\ntitle: t\nkind: dev\nstate: ${state}\nautonomy: commit\ncreated: "2026-10-01T10:00:00+03:00"\nupdated: "${updated}"\n---\n\n## Tanım\nx\n`);
};
const finding = (id: string, state: string, project = "vlad") => {
  writeFileSync(kb("findings", `${id}.md`), `---\nid: ${id}\nproject: ${project}\ntitle: f\nseverity: orta\nstate: ${state}\nsource_task: T20261001-01\ncreated: "2026-10-01T10:00:00+03:00"\nupdated: "2026-11-01T10:00:00+03:00"\n---\n\nbody\n`);
};
const codes = (r: ReturnType<typeof lintKb>) => r.flags.map((f) => f.code);
const FRESH = "## Durum özeti\n_Güncel: 2026-11-03T11:00:00+03:00_\n\n";

beforeEach(() => {
  home = makeHome();
  mkdirSync(kb("findings"), { recursive: true });
  mkdirSync(kb("decisions"), { recursive: true });
  writeCfg();
});

describe("closed_finding_listed_open", () => {
  it("flags a fixed finding listed under Açık konular (2026-11-03 real case, synthetic copy)", () => {
    finding("F-vlad-160", "fixed");
    writeCard("vlad", "## Açık konular\n- F-vlad-160 config testi kırmızı\n\n" + FRESH + "x\n");
    const r = lintKb({ now: NOW });
    const f = r.flags.find((x) => x.code === "closed_finding_listed_open")!;
    expect(f).toMatchObject({ id: "F-vlad-160", actual_state: "fixed", file: "projects/vlad.md", line: 13, project: "vlad" });
    expect(f.suggestion).toBeTruthy();
  });
  it("flags wontfix with an open keyword outside Açık konular", () => {
    finding("F-vlad-161", "wontfix");
    writeCard("vlad", FRESH + "F-vlad-161 hâlâ bekliyor.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual(["closed_finding_listed_open"]);
  });
  it("judges the context of the sentence holding the id, not other sentences on the line", () => {
    finding("F-vlad-165", "fixed");
    task("T20261101-07", "done");
    writeCard("vlad", FRESH + "F-vlad-165 düzeltildi. CI hız teyidi bekliyor; aktif iş yok.\nPlan onaylandı (T20261101-07). Sunucu bekliyor.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
    writeCard("vlad", FRESH + "Plan onaylandı. F-vlad-165 hâlâ açık; T20261101-07 şu an çalışıyor.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual(["closed_finding_listed_open", "finished_task_listed_active"]);
  });
  it("sees through dash-separated list items, negations and Turkish capitals", () => {
    finding("F-vlad-166", "fixed");
    task("T20261101-05", "done");
    writeCard("vlad", FRESH + "- T20261101-05 — Başlık — onay bekliyor\n- F-vlad-166 — ERTELENDİ, hâlâ AÇIK\n");
    expect(codes(lintKb({ now: NOW }))).toEqual(["finished_task_listed_active", "closed_finding_listed_open"]);
    writeCard("vlad", FRESH + "F-vlad-166 artık açık değil. Bekleyen iş yok (F-vlad-166).\nT20261101-05 sürüyor değil, bitti.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
  it("does not flag historical narrative or open findings", () => {
    finding("F-vlad-162", "fixed");
    finding("F-vlad-163", "open");
    writeCard("vlad", "## Açık konular\n- F-vlad-163 açık\n\n## Son aktivite\n- 2026-10-29: F-vlad-162 kapandı, bekleyen iş yok\n- 2026-10-30: F-vlad-162 açıktı, sonra düzeltildi\n\n" + FRESH + "x\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
  it("ignores fenced code and the derived block", () => {
    finding("F-vlad-164", "fixed");
    writeCard("vlad", `## Açık konular\n${derivedOpen("open-findings")}\n- F-vlad-164 açık\n${DERIVED_CLOSE}\n\n## Çalışma notları\n\`\`\`\nF-vlad-164 açık\n\`\`\`\n\n${FRESH}x\n`);
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
  it("matches whole ids only (F-vlad-16 is not inside F-vlad-160)", () => {
    finding("F-vlad-16", "fixed");
    finding("F-vlad-160", "open");
    writeCard("vlad", "## Açık konular\n- F-vlad-160 açık\n\n" + FRESH + "x\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
});

describe("finished_task_listed_active", () => {
  it("flags done task under Açık konular and cancelled task with an active keyword", () => {
    task("T20261101-01", "done");
    task("T20261101-02", "cancelled");
    writeCard("vlad", "## Açık konular\n- T20261101-01 bitmedi\n\n" + FRESH + "T20261101-02 şu an çalışıyor.\n");
    const r = lintKb({ now: NOW });
    expect(r.flags.filter((f) => f.code === "finished_task_listed_active").map((f) => [f.id, f.actual_state])).toEqual([["T20261101-01", "done"], ["T20261101-02", "cancelled"]]);
  });
  it("does not flag running tasks or past-tense narrative", () => {
    task("T20261101-01", "done");
    task("T20261101-03", "running");
    writeCard("vlad", "## Açık konular\n- T20261101-03 sürüyor\n\n## Son aktivite\n- 2026-11-01: T20261101-01 devam ediyordu, sonra bitti\n- T20261101-01 tamamlandı, merge edildi\n\n" + FRESH + "x\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
});

describe("inactive_decision_listed_valid", () => {
  it("flags an invalid/superseded decision inside a 'geçerli kararlar' list", () => {
    addDecision({ project: "vlad", title: "A", body: "- **Karar:** a" }, new Date(2026, 9, 1));
    addDecision({ project: "vlad", title: "B", body: "- **Karar:** b" }, new Date(2026, 9, 2));
    addDecision({ project: "vlad", title: "C", body: "- **Karar:** c" }, new Date(2026, 9, 3));
    setDecisionStatus("D-vlad-001", "geçersiz");
    setDecisionStatus("D-vlad-002", "yerine-geçti", "D-vlad-003");
    writeCard("vlad", FRESH + "Geçerli kararlar:\n- D-vlad-001 A\n- D-vlad-002 B\n\nGeçerli kararlar: D-vlad-001.\n");
    const r = lintKb({ now: NOW });
    expect(r.flags.filter((f) => f.code === "inactive_decision_listed_valid").map((f) => [f.id, f.actual_state, f.line])).toEqual([
      ["D-vlad-001", "geçersiz", 16], ["D-vlad-002", "yerine-geçti", 17], ["D-vlad-001", "geçersiz", 19],
    ]);
  });
  it("does not flag valid decisions or an explicit 'geçersiz' mention", () => {
    addDecision({ project: "vlad", title: "A", body: "- **Karar:** a" }, new Date(2026, 9, 1));
    addDecision({ project: "vlad", title: "B", body: "- **Karar:** b" }, new Date(2026, 9, 2));
    setDecisionStatus("D-vlad-002", "geçersiz");
    writeCard("vlad", FRESH + "Geçerli kararlar:\n- D-vlad-001 A\n\nD-vlad-002 geçerli karar değil, geçersiz kılındı.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
});

describe("expired_decision_valid", () => {
  it("flags a valid decision whose 'kadar' deadline has passed (2026-11-03 real case, synthetic copy)", () => {
    addDecision({ project: "vlad", title: "Tam yetki 2026-11-02 08:00'e kadar", body: "- **Karar:** gece boyu tam yetki" }, new Date(2026, 10, 1));
    const r = lintKb({ now: NOW });
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({ code: "expired_decision_valid", id: "D-vlad-001", actual_state: "geçerli", file: "decisions/vlad.md", project: "vlad" });
    expect(r.flags[0].suggestion).toContain("decision set");
  });
  it("flags an expiry in the body; a date-only deadline lasts until the end of that day", () => {
    addDecision({ project: "vlad", title: "K", body: "- **Karar:** izin 2026-11-02'ye kadar geçerli" }, new Date(2026, 10, 1));
    expect(codes(lintKb({ now: NOW }))).toEqual(["expired_decision_valid"]);
    expect(codes(lintKb({ now: new Date("2026-11-02T20:00:00+03:00") }))).toEqual([]);
  });
  it("reports the deadline in the author's local time; impossible dates are ignored", () => {
    addDecision({ project: "vlad", title: "Yetki 2026-11-02 08:00'e kadar", body: "- **Karar:** x" }, new Date(2026, 10, 1));
    addDecision({ project: "vlad", title: "Bozuk 2026-02-31 25:99'a kadar", body: "- **Karar:** y" }, new Date(2026, 10, 1));
    const r = lintKb({ now: NOW });
    expect(r.flags.map((f) => f.id)).toEqual(["D-vlad-001"]);
    expect(r.flags[0].message).toContain("2026-11-02 08:00");
    expect(r.flags[0].message).not.toContain("UTC");
  });
  it("does not flag future deadlines or inactive decisions", () => {
    addDecision({ project: "vlad", title: "Gelecek 2026-11-10 08:00'e kadar", body: "- **Karar:** x" }, new Date(2026, 10, 1));
    addDecision({ project: "vlad", title: "Eski 2026-10-01'e kadar", body: "- **Karar:** y" }, new Date(2026, 9, 1));
    setDecisionStatus("D-vlad-002", "geçersiz");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
});

describe("memory_stale_task", () => {
  const mem = (name: string, text: string) => {
    mkdirSync(join(home, "mem"), { recursive: true });
    writeFileSync(join(home, "mem", name), text);
    writeCfg({ memoryDirs: [join(home, "mem")] });
  };
  it("flags authority/plan notes tied to a finished task (synthetic copy of the 2026-11-03 case)", () => {
    task("T20261102-60", "done");
    task("T20261102-61", "cancelled");
    mem("merge.md", "---\nname: x\n---\n\nFaz merge'leri yalnız T20261102-60 çatısı için sormadan.\n\nGörev T20261102-61 bitince istenecek.\n");
    const r = lintKb({ now: NOW });
    expect(r.flags.filter((f) => f.code === "memory_stale_task").map((f) => [f.id, f.actual_state, f.line])).toEqual([["T20261102-60", "done", 5], ["T20261102-61", "cancelled", 7]]);
    expect(r.flags[0].file).toContain("merge.md");
    expect(r.scanned.memory).toBe(1);
  });
  it("does not flag running tasks or plain references", () => {
    task("T20261102-60", "running");
    task("T20261102-62", "done");
    mem("a.md", "yalnız T20261102-60 çatısı için.\n\nT20261102-62 örnek referans olarak anıldı.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
  it("does not flag a finished-task note that is itself past tense", () => {
    task("T20261102-60", "done");
    mem("past.md", "T20261102-60 tamamlandı, plan onaylandı ve merge edildi.\n");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
  it("is skipped when memoryDirs is unset (default dir absent); a missing dir is skipped silently", () => {
    task("T20261102-60", "done");
    mkdirSync(join(home, "mem"), { recursive: true });
    writeFileSync(join(home, "mem", "a.md"), "yalnız T20261102-60 çatısı için.\n");
    expect(lintKb({ now: NOW }).flags).toEqual([]);
    writeCfg({ memoryDirs: [join(home, "yok")] });
    const r = lintKb({ now: NOW });
    expect(r.flags).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.scanned.memory).toBe(0);
  });
});

describe("summary_stale", () => {
  it("shows the freshness signal: bayat and yok flagged, güncel not", () => {
    writeCard("vlad", "## Durum özeti\n_Güncel: 2026-10-30T10:00:00+03:00_\n\nözet\n");
    task("T20261101-01", "running", "2026-11-01T10:00:00+03:00");
    writeCard("beta", "## Özet\nx\n");
    writeCard("gama", FRESH + "özet\n");
    const r = lintKb({ now: NOW });
    expect(r.warnings).toEqual([]);
    expect(r.flags.filter((f) => f.code === "summary_stale").map((f) => [f.id, f.actual_state]).sort()).toEqual([["beta", "yok"], ["vlad", "bayat"]]);
    expect(r.flags.find((f) => f.id === "vlad")!.message).toContain("T20261101-01");
  });
  it("skips paused projects", () => {
    writeCard("beta", "## Özet\nx\n", "paused");
    expect(codes(lintKb({ now: NOW }))).toEqual([]);
  });
});

describe("options, output, exit code", () => {
  it("--project limits scanning to that project; an unknown project throws", () => {
    finding("F-vlad-160", "fixed");
    finding("F-beta-001", "fixed", "beta");
    writeCard("vlad", "## Açık konular\n- F-vlad-160\n\n" + FRESH + "x\n");
    writeCard("beta", "## Açık konular\n- F-beta-001\n\n" + FRESH + "x\n");
    expect(lintKb({ now: NOW, project: "beta" }).flags.map((f) => f.id)).toEqual(["F-beta-001"]);
    expect(() => lintKb({ now: NOW, project: "yok" })).toThrow(/bulunamadı/);
  });
  it("groups human output by project and exposes the json shape", () => {
    finding("F-vlad-160", "fixed");
    writeCard("vlad", "## Açık konular\n- F-vlad-160\n\n" + FRESH + "x\n");
    const r = lintKb({ now: NOW });
    expect(Object.keys(r).sort()).toEqual(["counts", "flags", "scanned", "warnings"]);
    expect(Object.keys(r.flags[0]).sort()).toEqual(["actual_state", "code", "file", "id", "line", "message", "project", "suggestion"]);
    expect(r.counts).toEqual({ closed_finding_listed_open: 1 });
    const text = formatLint(r);
    expect(text).toMatch(/^vlad \(1\)/m);
    expect(text).toContain("closed_finding_listed_open");
  });
  it("prints a clean message when nothing is found", () => {
    writeCard("vlad", FRESH + "x\n");
    expect(formatLint(lintKb({ now: NOW }))).toContain("çelişki yok");
  });
  it("exit code: flags → 0, --strict + flags → 1", () => {
    finding("F-vlad-160", "fixed");
    writeCard("vlad", "## Açık konular\n- F-vlad-160\n");
    const r = lintKb({ now: NOW });
    expect(r.flags.length).toBeGreaterThan(0);
    expect(lintExitCode(r, false)).toBe(0);
    expect(lintExitCode(r, true)).toBe(1);
    expect(lintExitCode({ ...r, flags: [] }, true)).toBe(0);
  });
});

describe("vlad kb lint (CLI)", () => {
  const cli = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
  const run = (args: string[]) => {
    const env = { ...isolatedEnv(), VLAD_HOME: home } as Record<string, string | undefined>;
    delete env.VLAD_KB_DIR;
    const r = spawnSync("node", [cli, "kb", "lint", ...args], { encoding: "utf8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  it("prints json, exits 0 with flags, 1 with --strict, 1 on unknown project", () => {
    finding("F-vlad-160", "fixed");
    writeCard("vlad", "## Açık konular\n- F-vlad-160\n\n## Durum özeti\n_Güncel: 2999-01-01T00:00:00+03:00_\n\nx\n");
    const a = run(["--json"]);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out).flags[0].code).toBe("closed_finding_listed_open");
    expect(run(["--strict"]).code).toBe(1);
    const b = run(["--project", "yok", "--json"]);
    expect(b.code).toBe(1);
    expect(JSON.parse(b.err).error).toMatch(/bulunamadı/);
  });
});
