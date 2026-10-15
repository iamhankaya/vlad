import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { getSection, kbPaths, nowIso, readDoc, validate, writeDoc } from "../../src/kb/index.js";
import type { TaskData } from "../../src/kb/index.js";
import {
  TransitionError, answerTask, askTask, createTask, getTask, listTasks, listTasksWithWarnings,
  logTask, markStale, nextTaskId, reportTask, setState,
} from "../../src/tasks/index.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
const mk = (title = "t") => createTask({ project: "p", title, kind: "dev", body: "## Tanım\nx\n" }, D);

beforeEach(() => {
  makeHome();
});

describe("task store", () => {
  it("assigns sequential ids", () => {
    expect(mk().data.id).toBe("T20261015-01");
    expect(mk().data.id).toBe("T20261015-02");
  });
  it("createTask retries on EEXIST and leaves the existing file untouched", () => {
    const dir = kbPaths().tasks;
    writeFileSync(join(dir, "T20261015-01.md"), "junk", "utf8");
    // stale id source: claims -01 is free even though the file exists
    const t = createTask({ project: "p", title: "t", kind: "dev", body: "" }, D, () => "T20261015-01");
    expect(t.data.id).toBe("T20261015-02");
    expect(readFileSync(join(dir, "T20261015-01.md"), "utf8")).toBe("junk");
  });
  it("createTask creates a missing tasks dir", () => {
    rmSync(kbPaths().tasks, { recursive: true, force: true });
    expect(mk().data.id).toBe("T20261015-01");
  });
  it("creates a valid file with 6 headings and defaults", () => {
    const t = mk();
    const { data, body } = readDoc<TaskData>(t.file);
    validate("task", data);
    expect(data.state).toBe("queued");
    expect(data.autonomy).toBe("commit");
    expect(data.branch).toBeNull();
    for (const h of ["## Tanım", "## Kabul kriterleri", "## Bağlam", "## İlerleme", "## Sorular", "## Kapanış raporu"]) {
      expect(body).toContain(h);
    }
    expect(getSection(body, "## Tanım")).toBe("x");
  });
  it("getTask throws for unknown id", () => {
    expect(() => getTask("T1")).toThrow("görev bulunamadı: T1");
  });
  it("logTask appends under İlerleme", () => {
    const t = mk();
    logTask(t.data.id, "merhaba");
    const sec = getSection(getTask(t.data.id).body, "## İlerleme")!;
    expect(sec.split("\n")[0].startsWith("- 20")).toBe(true);
    expect(sec).toContain("merhaba");
  });
  it("ask/answer toggle blocked/running", () => {
    const t = mk();
    setState(t.data.id, "running");
    expect(askTask(t.data.id, "ne?").data.state).toBe("blocked");
    expect(getSection(getTask(t.data.id).body, "## Sorular")).toContain("**Soru:** ne?");
    expect(answerTask(t.data.id, "bu").data.state).toBe("running");
    expect(getSection(getTask(t.data.id).body, "## Sorular")).toContain("**Cevap:** bu");
  });
  it("reportTask writes report and awaits approval", () => {
    const t = mk();
    setState(t.data.id, "running");
    expect(reportTask(t.data.id, "bitti").data.state).toBe("awaiting_approval");
    expect(getSection(getTask(t.data.id).body, "## Kapanış raporu")).toBe("bitti");
  });
  it("setState rejects invalid transition", () => {
    const t = mk();
    expect(() => setState(t.data.id, "done")).toThrow(TransitionError);
  });
  it("setState applies patch", () => {
    const t = mk();
    const r = setState(t.data.id, "running", { branch: "vlad/" + t.data.id });
    expect(r.data.branch).toBe("vlad/" + t.data.id);
  });
  it("markStale only stalls old running tasks", () => {
    const a = mk("a");
    const b = mk("b");
    for (const [t, h] of [[a, 7], [b, 1]] as const) {
      const data = { ...t.data, state: "running" as const, updated: nowIso(new Date(Date.now() - h * 3600_000)) };
      writeDoc(t.file, data, t.body);
    }
    const res = markStale(new Date(), 6);
    expect(res.map((x) => x.data.id)).toEqual([a.data.id]);
    expect(getTask(a.data.id).data.state).toBe("stalled");
    expect(getTask(b.data.id).data.state).toBe("running");
  });
  it("listTasks filters; corrupt files become warnings", () => {
    mk();
    const t2 = mk();
    setState(t2.data.id, "running");
    writeFileSync(join(kbPaths().tasks, "bad.md"), "no frontmatter", "utf8");
    const r = listTasksWithWarnings();
    expect(r.tasks).toHaveLength(2);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("bad.md");
    expect(listTasks({ state: ["running"] }).map((x) => x.data.id)).toEqual([t2.data.id]);
    expect(listTasks({ project: "zzz" })).toEqual([]);
  });
  it("tasks dir missing yields empty list", () => {
    rmSync(kbPaths().tasks, { recursive: true, force: true });
    expect(listTasks()).toEqual([]);
  });
});
