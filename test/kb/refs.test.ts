import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDecision } from "../../src/kb/decisions.js";
import { refsOf } from "../../src/kb/refs.js";
import { makeFixtureRoot, makeHome } from "../helpers.js";

let home: string;
const kb = (...p: string[]) => join(home, "kb", ...p);
const card = (slug: string, path: string) => `---\nslug: ${slug}\nname: ${slug}\npath: ${JSON.stringify(path)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`;
const task = (id: string, updated: string, body: string, state = "done", project = "vlad") => {
  mkdirSync(kb("tasks"), { recursive: true });
  writeFileSync(kb("tasks", `${id}.md`), `---\nid: ${id}\nproject: ${project}\ntitle: t\nstate: ${state}\nupdated: "${updated}"\n---\n\n${body}`);
};
const finding = (id: string, state: string, updated: string) => {
  mkdirSync(kb("findings"), { recursive: true });
  writeFileSync(kb("findings", `${id}.md`), `---\nid: ${id}\nproject: vlad\ntitle: f\nstate: ${state}\nupdated: "${updated}"\n---\n\nbody\n`);
};

beforeEach(() => {
  home = makeHome();
  writeFileSync(kb("projects", "vlad.md"), card("vlad", "/yok/boyle/yer"));
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: ["/yok/root"], ignore: [], defaultAutonomy: "commit", staleAfterHours: 6, launcher: "auto" }));
});

describe("refsOf", () => {
  it("lists task, finding and decision mentions with type, status, date and section; skips the record itself", () => {
    finding("F-vlad-100", "open", "2026-11-01T10:00:00");
    task("T20261101-01", "2026-11-01T12:00:00", "## Kapanış raporu\n### Açık noktalar\n- F-vlad-100 hâlâ açık\n\n### Yapılanlar\n- F-vlad-1000 başka\n");
    addDecision({ project: "vlad", title: "K", body: "- **Karar:** F-vlad-100 ertelendi" }, new Date(2026, 10, 1));
    const r = refsOf("F-vlad-100");
    expect(r.type).toBe("finding");
    expect(r.mentions.map((m) => [m.type, m.id, m.status, m.date, m.section])).toEqual([
      ["decision", "D-vlad-001", "geçerli", "2026-11-01", "### 2026-11-01 — vlad — K"],
      ["task", "T20261101-01", "done", "2026-11-01", "### Açık noktalar"],
    ]);
    expect(r.mentions[1].h2).toBe("## Kapanış raporu");
    expect(r.mentions[1].snippet).toContain("hâlâ açık");
  });
  it("finds a task id and a decision id; unknown ids and bad shapes throw", () => {
    task("T20261101-01", "2026-11-01T12:00:00", "## İlerleme\nbitti\n");
    task("T20261101-02", "2026-11-02T12:00:00", "## İlerleme\n- T20261101-01 sonrası\n", "running");
    expect(refsOf("T20261101-01").mentions.map((m) => [m.id, m.status, m.section])).toEqual([["T20261101-02", "running", "## İlerleme"]]);
    expect(() => refsOf("F-vlad-999")).toThrow(/bulunamadı/);
    expect(() => refsOf("xyz")).toThrow(/geçersiz ID/);
  });
  it("flags fixed finding whose latest report mention is still under Açık noktalar", () => {
    finding("F-vlad-100", "fixed", "2026-11-01T10:00:00");
    task("T20261101-01", "2026-10-30T12:00:00", "## Kapanış raporu\n### Açık noktalar\n- F-vlad-100\n"); // origin, older than the fix
    expect(refsOf("F-vlad-100").flags).toEqual([]);
    task("T20261102-01", "2026-11-02T12:00:00", "## Kapanış raporu\n### Açık noktalar\n- F-vlad-100 sürüyor\n");
    const r = refsOf("F-vlad-100");
    expect(r.flags.map((f) => f.code)).toEqual(["fixed_but_open_in_report"]);
    expect(r.flags[0].evidence[0]).toContain("T20261102-01");
  });
  it("flags open finding named under Yapılanlar; clean record has no flags", () => {
    finding("F-vlad-101", "open", "2026-11-01T10:00:00");
    task("T20261102-01", "2026-11-02T12:00:00", "## Kapanış raporu\n### Yapılanlar\n- F-vlad-101 düzeltildi\n");
    expect(refsOf("F-vlad-101").flags.map((f) => f.code)).toEqual(["open_but_done_in_report"]);
    finding("F-vlad-102", "open", "2026-11-01T10:00:00");
    task("T20261102-02", "2026-11-02T12:00:00", "## Kapanış raporu\n### Açık noktalar\n- F-vlad-102\n");
    expect(refsOf("F-vlad-102").flags).toEqual([]);
  });
  it("does not throw without a clone: warnings carry the reason", () => {
    finding("F-vlad-100", "open", "2026-11-01T10:00:00");
    const r = refsOf("F-vlad-100");
    expect(r.commits).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/yerel klon bulunamadı/);
  });
  it("finds commits in a temp git repo by whole-id match and flags an open finding", () => {
    const repo = makeFixtureRoot();
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(repo, "a"), "1");
    git("add", "a");
    git("commit", "-q", "-m", "fix: F-vlad-100 düzeltildi");
    writeFileSync(join(repo, "a"), "2");
    git("commit", "-q", "-am", "fix: F-vlad-1000 başka");
    writeFileSync(kb("projects", "vlad.md"), card("vlad", repo));
    finding("F-vlad-100", "open", "2026-11-01T10:00:00");
    const r = refsOf("F-vlad-100");
    expect(r.warnings).toEqual([]);
    expect(r.commits.map((c) => c.subject)).toEqual(["fix: F-vlad-100 düzeltildi"]);
    expect(r.flags.map((f) => f.code)).toEqual(["open_but_done_in_report"]);
  });
});
