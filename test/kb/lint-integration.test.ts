import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDecision, isDecisionExpired, listDecisions, parseUntil } from "../../src/kb/decisions.js";
import { defaultMemoryDir, lintKb } from "../../src/kb/lint.js";
import { lintAgeNote, readLintCache, writeLintCache } from "../../src/kb/lint-cache.js";
import { projectStatus } from "../../src/projects/status.js";
import { makeHome } from "../helpers.js";

let home: string;
const kb = (...p: string[]) => join(home, "kb", ...p);
const NOW = new Date("2026-11-03T12:00:00+03:00");
const cli = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
const run = (args: string[]) => {
  const env = { ...process.env, VLAD_HOME: home } as Record<string, string | undefined>;
  delete env.VLAD_KB_DIR;
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const FRESH = "## Durum özeti\n_Güncel: 2999-01-01T00:00:00+03:00_\n\nx\n";
const writeCard = (sections: string) => writeFileSync(kb("projects", "vlad.md"), `---\nslug: vlad\nname: vlad\npath: "/yok"\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n${sections}`);
const finding = (id: string, state: string) =>
  writeFileSync(kb("findings", `${id}.md`), `---\nid: ${id}\nproject: vlad\ntitle: f\nseverity: orta\nstate: ${state}\nsource_task: T20261001-01\ncreated: "2026-10-01T10:00:00+03:00"\nupdated: "2026-11-01T10:00:00+03:00"\n---\n\nbody\n`);

beforeEach(() => {
  home = makeHome();
  mkdirSync(kb("findings"), { recursive: true });
  mkdirSync(kb("decisions"), { recursive: true });
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: ["/yok/root"], ignore: [], defaultAutonomy: "commit", staleAfterHours: 6, launcher: "auto" }));
  process.env.VLAD_HOME = home;
  delete process.env.VLAD_KB_DIR;
});

describe("status --summary kbLint", () => {
  it("is empty without a cached lint run: JSON kbLint {count:0, byCode:{}, at:null}, no line text", () => {
    const j = JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out);
    expect(j.kbLint).toEqual({ count: 0, byCode: {}, at: null });
    expect(j.summary).not.toContain("kb çelişkisi");
  });

  it("a whole-kb `kb lint` feeds the line and JSON; summary_stale is not counted (reported separately)", () => {
    finding("F-vlad-160", "fixed");
    writeCard("## Açık konular\n- F-vlad-160 config testi\n\n## Durum özeti\n\nx\n"); // no timestamp -> summary_stale too
    expect(run(["kb", "lint", "--json"]).code).toBe(0);
    const j = JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out);
    expect(j.kbLint.count).toBe(1);
    expect(j.kbLint.byCode).toEqual({ closed_finding_listed_open: 1 });
    expect(typeof j.kbLint.at).toBe("string");
    expect(j.summary).toContain("1 kb çelişkisi");
  });

  it("the hook text carries the count; a project-scoped lint leaves the cache alone", () => {
    finding("F-vlad-160", "fixed");
    writeCard("## Açık konular\n- F-vlad-160\n\n" + FRESH);
    run(["kb", "lint"]);
    const hook = JSON.parse(run(["status", "--summary", "--hook", "--no-mark"]).out);
    expect(hook.systemMessage).toContain("1 kb çelişkisi");
    finding("F-vlad-160", "open"); // now clean
    run(["kb", "lint", "--project", "vlad"]);
    expect(readLintCache().count).toBe(1);
    run(["kb", "lint"]);
    expect(readLintCache().count).toBe(0);
    expect(JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out).summary).not.toContain("kb çelişkisi");
  });

  it("an old cached run is shown with its age and never re-linted", () => {
    mkdirSync(kb("logs"), { recursive: true });
    writeFileSync(kb("logs", "kb-lint.json"), JSON.stringify({ count: 3, byCode: { finished_task_listed_active: 3 }, at: "2026-10-30T10:00:00+03:00" }));
    const line = JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out).summary as string;
    expect(line).toMatch(/3 kb çelişkisi \(lint \d+ gün önce\)/);
    expect(lintAgeNote({ count: 1, byCode: {}, at: "2026-11-03T11:00:00+03:00" }, NOW)).toBe("");
  });

  it("a corrupt cache reads as empty; writing works", () => {
    mkdirSync(kb("logs"), { recursive: true });
    writeFileSync(kb("logs", "kb-lint.json"), "{bozuk");
    expect(readLintCache()).toEqual({ count: 0, byCode: {}, at: null });
    writeLintCache({ flags: [], counts: { memory_stale_task: 2 }, scanned: { projects: 0, decisions: 0, memory: 0 }, warnings: [] }, NOW);
    expect(readLintCache().count).toBe(2);
  });
});

describe("decision add --until", () => {
  it("parses dates: a bare date lasts to the end of that day; impossible dates are rejected", () => {
    expect(parseUntil("2026-11-02")!.getHours()).toBe(23);
    expect(parseUntil("2026-11-02T08:00+03:00")!.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(parseUntil("2026-02-31")).toBeNull();
    expect(parseUntil("2026-11-02T25:00")).toBeNull();
    expect(parseUntil("yarın")).toBeNull();
  });

  it("stores the deadline; lint and project status flag it once it has passed", () => {
    writeCard(FRESH);
    addDecision({ project: "vlad", title: "Gece yetkisi", body: "- **Karar:** x", until: "2026-11-02T08:00:00+03:00" }, new Date(2026, 10, 1));
    addDecision({ project: "vlad", title: "Gelecek", body: "- **Karar:** y", until: "2999-11-10" }, new Date(2026, 10, 1));
    addDecision({ project: "vlad", title: "Süresiz", body: "- **Karar:** z" }, new Date(2026, 10, 1));
    const [a, b, c] = listDecisions({ project: "vlad" });
    expect(a.until).toBe("2026-11-02T08:00:00+03:00");
    expect(c.until).toBeUndefined();
    expect([a, b, c].map((d) => isDecisionExpired(d, NOW))).toEqual([true, false, false]);
    const r = lintKb({ now: NOW });
    expect(r.flags.map((f) => [f.code, f.id])).toEqual([["expired_decision_valid", "D-vlad-001"]]);
    expect(projectStatus("vlad").decisions.expired).toEqual(["D-vlad-001"]);
  });

  it("--until beats a stale date in the text; a non-valid decision is not flagged", () => {
    addDecision({ project: "vlad", title: "Uzatıldı (eski: 2026-10-01'e kadar)", body: "- **Karar:** x", until: "2999-12-01" }, new Date(2026, 10, 1));
    expect(lintKb({ now: NOW }).flags).toEqual([]);
  });

  it("CLI: validates the value and shows the deadline in list and project status", () => {
    writeCard(FRESH);
    const bad = run(["decision", "add", "--project", "vlad", "--title", "t", "--body-file", "-", "--until", "2026-02-31", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toMatch(/--until/);
    const body = join(home, "b.md");
    writeFileSync(body, "- **Karar:** x\n");
    const ok = run(["decision", "add", "--project", "vlad", "--title", "t", "--body-file", body, "--until", "2020-01-01", "--json"]);
    expect(ok.code).toBe(0);
    expect(run(["decision", "list", "--project", "vlad"]).out).toContain("süre: 2020-01-01, doldu");
    expect(run(["project", "status", "vlad"]).out).toContain("süresi dolmuş geçerli karar: D-vlad-001");
  });
});

describe("memory dir default", () => {
  it("derives Claude Code's per-checkout memory dir from VLAD_HOME", () => {
    expect(defaultMemoryDir("C:\\dev\\vlad")).toBe(join(homedir(), ".claude", "projects", resolve("C:\\dev\\vlad").replace(/[^A-Za-z0-9]/g, "-"), "memory"));
    if (process.platform === "win32") expect(defaultMemoryDir("C:\\dev\\vlad")).toMatch(/projects[\\/]C--dev-vlad[\\/]memory$/);
  });
});
