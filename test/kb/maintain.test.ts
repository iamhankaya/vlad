import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { addDecision } from "../../src/kb/decisions.js";
import { getKbRecord } from "../../src/kb/get.js";
import { maintainKb } from "../../src/kb/maintain.js";
import { addFinding, getFinding, listFindingsWithWarnings, nextFindingId, setFindingState } from "../../src/findings/store.js";
import { createTask, getTask, listTasks, nextTaskId, logTask, setState, unknownTaskRefs } from "../../src/tasks/store.js";
import { makeHome } from "../helpers.js";

const NOW = new Date(2026, 9, 29, 12, 0, 0);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000);
const LEGACY = [
  "# Karar Günlüğü",
  "",
  "### 2026-10-16 — vlad — Bir",
  "- **Karar:** a",
  "",
  "### 2026-10-17 — ashen-bastion — İki",
  "- **Karar:** b",
  "ek paragraf",
  "",
  "### 2026-10-18 — vlad — Üç",
  "- **Karar:** c",
  "",
  "### 2026-10-19 — Genel Kural — Dört",
  "- **Karar:** d",
  "",
].join("\n");

let home: string;
beforeEach(() => { home = makeHome(); });

const writeLegacy = (text = LEGACY) => writeFileSync(join(home, "kb", "decisions.md"), text);
const dec = (slug: string) => readFileSync(join(home, "kb", "decisions", `${slug}.md`), "utf8");

/** Sets a task's state and `updated` directly (the store stamps `updated` itself on save). */
function ageTask(id: string, state: string, updated: Date, digested = true) {
  const t = getTask(id);
  let raw = readFileSync(t.file, "utf8")
    .replace(/^state: .*$/m, `state: ${state}`)
    .replace(/^updated: .*$/m, `updated: ${updated.toISOString()}`);
  if (state === "done" && digested) raw = raw.replace(/^updated: .*$/m, (m) => `${m}
digested: ${updated.toISOString()}`);
  writeFileSync(t.file, raw);
}

describe("decisions split", () => {
  it("splits per project, keeps order and text, loses nothing", () => {
    writeLegacy();
    const r = maintainKb({ now: NOW });
    expect(r.decisions.map((d) => d.file).sort()).toEqual(["_genel", "ashen-bastion", "vlad"]);
    expect(existsSync(join(home, "kb", "decisions.md"))).toBe(false);
    const all = ["vlad", "ashen-bastion", "_genel"].map(dec).join("\n");
    const blocks = (s: string) => s.split("\n").filter((l) => l.startsWith("### ")).sort();
    expect(blocks(all)).toEqual(blocks(LEGACY));
    expect(dec("vlad").indexOf("— Bir")).toBeLessThan(dec("vlad").indexOf("— Üç"));
    expect(dec("ashen-bastion")).toContain("- **Karar:** b\nek paragraf");
  });
  it("second run changes nothing", () => {
    writeLegacy();
    maintainKb({ now: NOW });
    const before = dec("vlad");
    const r = maintainKb({ now: NOW });
    expect(r.decisions).toEqual([]);
    expect(dec("vlad")).toBe(before);
  });
  it("puts older legacy blocks before decisions already written to the new layout", () => {
    addDecision({ project: "vlad", title: "Yeni", body: "- **Karar:** y" }, new Date(2026, 9, 29));
    writeLegacy();
    maintainKb({ now: NOW });
    const t = dec("vlad");
    expect(t.indexOf("— Bir")).toBeLessThan(t.indexOf("— Yeni"));
    expect(t.match(/^# Karar Günlüğü/gm)).toHaveLength(1);
  });
  it("a rerun after a crash (decisions.md left behind, files already written) does not duplicate blocks", () => {
    writeLegacy();
    maintainKb({ now: NOW });
    const before = dec("vlad");
    writeLegacy();
    maintainKb({ now: NOW });
    expect(dec("vlad")).toBe(before);
  });
  it("addDecision writes to decisions/<project>.md, other project shapes to _genel", () => {
    addDecision({ project: "vlad", title: "T", body: "x" }, NOW);
    addDecision({ project: "../x", title: "G", body: "y" }, NOW);
    expect(dec("vlad")).toContain(" — vlad — T");
    expect(dec("_genel")).toContain(" — ../x — G");
    expect(readdirSync(kbPaths().decisions).sort()).toEqual(["_genel.md", "vlad.md"]);
  });
});

describe("archive", () => {
  const mk = (title = "t") => createTask({ project: "p", title, kind: "dev", body: "" }, NOW);

  it("archives old done/cancelled tasks, keeps recent, open and failed ones; no deletion", () => {
    const old = mk(); const oldCancel = mk(); const recent = mk(); const oldRunning = mk(); const oldFailed = mk();
    ageTask(old.data.id, "done", daysAgo(40));
    ageTask(oldCancel.data.id, "cancelled", daysAgo(31));
    ageTask(recent.data.id, "done", daysAgo(5));
    ageTask(oldRunning.data.id, "running", daysAgo(90));
    ageTask(oldFailed.data.id, "failed", daysAgo(90));
    const r = maintainKb({ now: NOW });
    expect(r.tasks.map((t) => t.id).sort()).toEqual([old.data.id, oldCancel.data.id].sort());
    expect(existsSync(join(kbPaths().tasks, "archive", "2026-09", `${old.data.id}.md`))).toBe(true);
    expect(existsSync(join(kbPaths().tasks, `${old.data.id}.md`))).toBe(false);
    for (const t of [recent, oldRunning, oldFailed]) expect(existsSync(t.file)).toBe(true);
  });
  it("does not overwrite when the same id already sits in the archive", () => {
    const t = mk(); ageTask(t.data.id, "done", daysAgo(40));
    const dup = join(kbPaths().tasks, "archive", "2026-09");
    mkdirSync(dup, { recursive: true });
    writeFileSync(join(dup, `${t.data.id}.md`), "kopya");
    const r = maintainKb({ now: NOW });
    expect(r.tasks).toEqual([]);
    expect(readFileSync(join(dup, `${t.data.id}.md`), "utf8")).toBe("kopya");
    expect(existsSync(t.file)).toBe(true);
  });
  it("keeps done tasks whose closing report /digest has not processed yet", () => {
    const undigested = mk(); const digested = mk(); const cancelled = mk();
    ageTask(undigested.data.id, "done", daysAgo(90), false);
    ageTask(digested.data.id, "done", daysAgo(90));
    ageTask(cancelled.data.id, "cancelled", daysAgo(90));
    const r = maintainKb({ now: NOW });
    expect(r.tasks.map((t) => t.id).sort()).toEqual([digested.data.id, cancelled.data.id].sort());
    expect(existsSync(undigested.file)).toBe(true);
  });
  it("getKbRecord finds archived tasks and findings, returns the real path and one section", () => {
    const t = mk(); ageTask(t.data.id, "done", daysAgo(40));
    const live = getKbRecord(mk().data.id);
    expect(live).toMatchObject({ kind: "task", archived: false });
    maintainKb({ now: NOW });
    const r = getKbRecord(t.data.id, "## Tanım");
    expect(r).toMatchObject({ id: t.data.id, kind: "task", archived: true, relative: `tasks/archive/2026-09/${t.data.id}.md` });
    expect(r.file).toBe(join(kbPaths().tasks, "archive", "2026-09", `${t.data.id}.md`));
    expect(r.content).not.toContain("## Kapanış raporu");
    expect(() => getKbRecord(t.data.id, "## Yok")).toThrow(/bölüm/);
    expect(() => getKbRecord("T20200101-99")).toThrow(/bulunamadı/);
    expect(() => getKbRecord("../x")).toThrow(/geçersiz/);
  });
  it("--days changes the threshold", () => {
    const t = mk(); ageTask(t.data.id, "done", daysAgo(10));
    expect(maintainKb({ now: NOW }).tasks).toEqual([]);
    expect(maintainKb({ now: NOW, days: 7 }).tasks.map((x) => x.id)).toEqual([t.data.id]);
  });
  it("archived tasks stay visible: get, list, refs, log in place", () => {
    const t = mk(); ageTask(t.data.id, "done", daysAgo(40));
    maintainKb({ now: NOW });
    expect(getTask(t.data.id).data.state).toBe("done");
    expect(listTasks({ state: ["done"] }).map((x) => x.data.id)).toContain(t.data.id);
    expect(unknownTaskRefs(`bkz ${t.data.id}`)).toEqual([]);
    const file = getTask(t.data.id).file;
    logTask(t.data.id, "arşivde not");
    expect(getTask(t.data.id).file).toBe(file);
    expect(readFileSync(file, "utf8")).toContain("arşivde not");
    expect(existsSync(join(kbPaths().tasks, `${t.data.id}.md`))).toBe(false);
  });
  it("new task ids do not collide with archived ones (even when the day's last ones are archived)", () => {
    const a = mk(); const b = mk();
    ageTask(a.data.id, "done", daysAgo(40)); ageTask(b.data.id, "done", daysAgo(40));
    maintainKb({ now: NOW });
    const c = mk();
    expect([a.data.id, b.data.id]).not.toContain(c.data.id);
    expect(nextTaskId(kbPaths().tasks, NOW)).not.toBe(c.data.id);
  });
  it("a dependency archived as done still counts as met", () => {
    const pipe = createTask({ project: "p", title: "c", kind: "pipeline", body: "" }, NOW);
    const dep = createTask({ project: "p", title: "d", kind: "dev", body: "", parent: pipe.data.id }, NOW);
    const next = createTask({ project: "p", title: "n", kind: "dev", body: "", parent: pipe.data.id, dependsOn: [dep.data.id] }, NOW);
    ageTask(dep.data.id, "done", daysAgo(40));
    maintainKb({ now: NOW });
    setState(next.data.id, "running");
    expect(getTask(next.data.id).data.state).toBe("running");
  });

  const mkF = (project = "p") => {
    writeFileSync(join(kbPaths().projects, `${project}.md`), "---\nslug: x\n---\n");
    return addFinding({ project, severity: "orta", source: "T20261022-01", title: "b" }, NOW);
  };
  it("archives old fixed/wontfix findings only; stays findable, settable and id-safe", () => {
    const fixed = mkF(); const open = mkF(); const wont = mkF(); const freshFixed = mkF();
    setFindingState(fixed.data.id, "fixed", undefined, daysAgo(40));
    setFindingState(wont.data.id, "wontfix", undefined, daysAgo(35));
    setFindingState(freshFixed.data.id, "fixed", undefined, daysAgo(2));
    const r = maintainKb({ now: NOW });
    expect(r.findings.map((f) => f.id).sort()).toEqual([fixed.data.id, wont.data.id].sort());
    expect(existsSync(join(kbPaths().findings, "archive", "2026-09", `${fixed.data.id}.md`))).toBe(true);
    expect(existsSync(open.file)).toBe(true);
    expect(getFinding(fixed.data.id).data.state).toBe("fixed");
    expect(listFindingsWithWarnings({ state: ["fixed", "wontfix"] }).findings).toHaveLength(3);
    setFindingState(fixed.data.id, "open", undefined, NOW);
    expect(getFinding(fixed.data.id).file).toContain("archive");
    expect(mkF().data.id).toBe("F-p-005");
    expect(nextFindingId(kbPaths().findings, "p")).toBe("F-p-006");
  });
});

describe("dry-run and obsidian", () => {
  const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

  it("--dry-run lists the moves and touches nothing", () => {
    writeLegacy();
    const t = createTask({ project: "p", title: "t", kind: "dev", body: "" }, NOW);
    ageTask(t.data.id, "done", daysAgo(40));
    const kb = join(home, "kb");
    const before = snapshot(kb);
    const legacyBefore = readFileSync(join(kb, "decisions.md"), "utf8");
    const r = maintainKb({ now: NOW, dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.tasks).toHaveLength(1);
    expect(r.decisions.length).toBeGreaterThan(0);
    expect(snapshot(kb)).toEqual(before);
    expect(readFileSync(join(kb, "decisions.md"), "utf8")).toBe(legacyBefore);
  });
  it("adds .obsidian/ to a separate kb's .gitignore once; dry-run does not", () => {
    const kb = join(home, "kbrepo");
    mkdirSync(kb, { recursive: true });
    writeFileSync(join(kb, ".gitignore"), "inbox/\nlogs/\n");
    process.env.VLAD_KB_DIR = kb;
    try {
      expect(maintainKb({ now: NOW, dryRun: true }).gitignore_added).toEqual([".obsidian/"]);
      expect(readFileSync(join(kb, ".gitignore"), "utf8")).not.toContain(".obsidian/");
      maintainKb({ now: NOW });
      const text = readFileSync(join(kb, ".gitignore"), "utf8");
      expect(text.match(/^\.obsidian\/$/gm)).toHaveLength(1);
      expect(maintainKb({ now: NOW }).gitignore_added).toEqual([]);
    } finally { delete process.env.VLAD_KB_DIR; }
  });
});
