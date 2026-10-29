import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { getSection, kbPaths, nowIso, readDoc, validate, writeDoc } from "../../src/kb/index.js";
import type { TaskData } from "../../src/kb/index.js";
import {
  TransitionError, answerTask, askTask, createTask, getTask, listTasks, listTasksWithWarnings,
  logTask, markDigested, markStale, nextTaskId, readyTasks, readyWithLimit, reportTask, setState, undigestedTasks,
} from "../../src/tasks/index.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
const mk = (title = "t") => createTask({ project: "p", title, kind: "dev", body: "## Tanım\nx\n" }, D);

beforeEach(() => {
  makeHome();
});

describe("task model", () => {
  it("stores a valid model and the opus reason; absent model stays absent", () => {
    const a = createTask({ project: "p", title: "t", kind: "dev", body: "", model: "haiku" }, D);
    expect(readDoc<TaskData>(a.file).data).toMatchObject({ model: "haiku" });
    const b = createTask({ project: "p", title: "t", kind: "dev", body: "", model: "opus", modelReason: "kritik" }, D);
    expect(readDoc<TaskData>(b.file).data).toMatchObject({ model: "opus", model_reason: "kritik" });
    expect(readDoc<TaskData>(mk().file).data.model ?? null).toBeNull();
  });
  it("rejects opus without a reason and an unknown model", () => {
    expect(() => createTask({ project: "p", title: "t", kind: "dev", body: "", model: "opus" }, D)).toThrow(/model-reason|gerekçe/);
    expect(() => createTask({ project: "p", title: "t", kind: "dev", body: "", model: "gpt" }, D)).toThrow(/model/);
    expect(listTasks()).toEqual([]);
  });
  it("rejects an empty model and a reason without a model", () => {
    expect(() => createTask({ project: "p", title: "t", kind: "dev", body: "", model: "" }, D)).toThrow(/model/);
    expect(() => createTask({ project: "p", title: "t", kind: "dev", body: "", modelReason: "x" }, D)).toThrow(/model-reason/);
  });
  it("schema accepts legacy task files without model and rejects a bad model", () => {
    const d = readDoc<TaskData>(mk().file).data;
    expect(() => validate("task", d)).not.toThrow();
    expect(() => validate("task", { ...d, model: "gpt" })).toThrow();
  });
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
  it("markStale: bulut ortamında yalnızca bulut session'lı görevleri stalled yapar", () => {
    const local = mk("local");
    const cloud = mk("cloud");
    const old = nowIso(new Date(Date.now() - 7 * 3600_000));
    writeDoc(local.file, { ...local.data, state: "running" as const, updated: old, session_id: null }, local.body);
    writeDoc(cloud.file, { ...cloud.data, state: "running" as const, updated: old, session_id: "session_01abc" }, cloud.body);
    const prev = process.env.CLAUDE_CODE_REMOTE;
    process.env.CLAUDE_CODE_REMOTE = "true";
    try {
      expect(markStale(new Date(), 6).map((x) => x.data.id)).toEqual([cloud.data.id]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_REMOTE;
      else process.env.CLAUDE_CODE_REMOTE = prev;
    }
    expect(getTask(local.data.id).data.state).toBe("running");
    expect(getTask(cloud.data.id).data.state).toBe("stalled");
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

describe("task role", () => {
  const writeRole = (slug: string, kind: string) => {
    mkdirSync(kbPaths().roles, { recursive: true });
    writeFileSync(join(kbPaths().roles, `${slug}.md`), `---\nslug: ${slug}\ntitle: T\nkind: ${kind}\nsummary: s\n---\n`);
  };
  const mkRole = (role: string | undefined, kind: "dev" | "research" = "dev") =>
    createTask({ project: "p", title: "t", kind, body: "", role }, D);

  it("stores a valid role, and null without one", () => {
    writeRole("tester", "executor");
    expect(mkRole("tester").data.role).toBe("tester");
    expect(getTask(mkRole("tester").data.id).data.role).toBe("tester");
    expect(mk().data.role).toBeNull();
  });
  it("an empty role is stored as null", () => {
    expect(mkRole("").data.role).toBeNull();
  });
  it("an invalid kind is reported as such even with a role", () => {
    writeRole("tester", "executor");
    expect(() => createTask({ project: "p", title: "t", kind: "foo" as "dev", body: "", role: "tester" }, D))
      .toThrow(/geçersiz görev türü: foo/);
  });
  it("rejects an unknown role", () => {
    expect(() => mkRole("yok")).toThrow(/rol bulunamadı: yok/);
  });
  it("rejects an advisory role on a dev task and an executor role on a research task", () => {
    writeRole("finans", "advisory");
    writeRole("tester", "executor");
    expect(() => mkRole("finans", "dev")).toThrow(/rol finans \(advisory\) dev görevinde kullanılamaz/);
    expect(() => mkRole("tester", "research")).toThrow(/rol tester \(executor\) research görevinde kullanılamaz/);
    expect(listTasks()).toEqual([]);
  });
});

describe("pipeline", () => {
  const pipe = () => createTask({ project: "p", title: "çatı", kind: "pipeline", body: "" }, D);
  const phase = (parent: string, dependsOn: string[] = [], ph = "spec") =>
    createTask({ project: "p", title: ph, kind: "research", body: "", parent, dependsOn, phase: ph }, D);
  const finish = (id: string) => { setState(id, "running"); setState(id, "awaiting_approval"); setState(id, "done"); };

  it("creates a pipeline and phases with parent/depends_on/phase", () => {
    const p = pipe();
    const a = phase(p.data.id);
    const b = phase(p.data.id, [a.data.id], "plan");
    expect(p.data).toMatchObject({ kind: "pipeline", parent: null, depends_on: [], phase: null });
    expect(getTask(b.data.id).data).toMatchObject({ parent: p.data.id, depends_on: [a.data.id], phase: "plan" });
    expect(listTasks({ parent: p.data.id }).map((t) => t.data.id)).toEqual([a.data.id, b.data.id]);
  });

  it("readyTasks returns queued phases whose dependencies are done", () => {
    const p = pipe();
    const a = phase(p.data.id);
    const b = phase(p.data.id, [a.data.id]);
    const c = phase(p.data.id, [b.data.id]);
    expect(readyTasks({ parent: p.data.id }).map((t) => t.data.id)).toEqual([a.data.id]);
    finish(a.data.id);
    expect(readyTasks().map((t) => t.data.id)).toEqual([b.data.id]);
    expect(readyTasks().map((t) => t.data.id)).not.toContain(c.data.id);
    expect(readyTasks().map((t) => t.data.id)).not.toContain(p.data.id);
  });

  describe("readyWithLimit (maxParallel)", () => {
    const dev = (parent: string, ph: string) =>
      createTask({ project: "p", title: ph, kind: "dev", body: "", parent, phase: ph }, D);
    const ids = (ts: { data: { id: string } }[]) => ts.map((t) => t.data.id);

    it("no limit: everything ready, nothing held", () => {
      const p = pipe();
      const a = dev(p.data.id, "a");
      const b = dev(p.data.id, "b");
      const r = readyWithLimit({ parent: p.data.id });
      expect(ids(r.tasks)).toEqual([a.data.id, b.data.id]);
      expect(r.held_by_limit).toEqual([]);
      expect(r.maxParallel).toBeNull();
    });
    it("limit full: all ready tasks are held", () => {
      const p = pipe();
      const run = dev(p.data.id, "run");
      setState(run.data.id, "running");
      const a = dev(p.data.id, "a");
      const r = readyWithLimit({ parent: p.data.id }, 1);
      expect(r.tasks).toEqual([]);
      expect(ids(r.held_by_limit)).toEqual([a.data.id]);
      expect(r.running).toBe(1);
    });
    it("partly full: free slots start, the rest is held", () => {
      const p = pipe();
      const run = dev(p.data.id, "run");
      setState(run.data.id, "running");
      const a = dev(p.data.id, "a");
      const b = dev(p.data.id, "b");
      const r = readyWithLimit({ parent: p.data.id }, 2);
      expect(ids(r.tasks)).toEqual([a.data.id]);
      expect(ids(r.held_by_limit)).toEqual([b.data.id]);
    });
    it("counts running dev tasks of other projects; research and blocked-free states do not use slots", () => {
      const other = createTask({ project: "q", title: "o", kind: "dev", body: "" }, D);
      setState(other.data.id, "running");
      const res = createTask({ project: "p", title: "r", kind: "research", body: "" }, D);
      setState(res.data.id, "running");
      const p = pipe();
      const a = dev(p.data.id, "a");
      const r = readyWithLimit({ parent: p.data.id }, 2);
      expect(r.running).toBe(1);
      expect(ids(r.tasks)).toEqual([a.data.id]);
    });
  });

  it("a phase going to running also starts a queued pipeline (research-only start)", () => {
    const p = pipe();
    const a = phase(p.data.id);
    setState(a.data.id, "running");
    expect(getTask(p.data.id).data.state).toBe("running");
    setState(a.data.id, "awaiting_approval");
    setState(a.data.id, "done");
    setState(p.data.id, "awaiting_approval");
    expect(getTask(p.data.id).data.state).toBe("awaiting_approval");
  });

  it("markStale never stalls a pipeline task", () => {
    const p = pipe();
    setState(p.data.id, "running");
    const stalled = markStale(new Date(Date.now() + 100 * 3600_000), 6).map((t) => t.data.id);
    expect(stalled).not.toContain(p.data.id);
    expect(getTask(p.data.id).data.state).toBe("running");
  });

  it("rejects a dependency outside the pipeline", () => {
    const p = pipe();
    const q = pipe();
    const a = phase(q.data.id);
    expect(() => phase(p.data.id, [a.data.id])).toThrow(/bağımlılık .* aynı pipeline'da değil/);
    expect(() => phase(p.data.id, ["T20000101-01"])).toThrow(/görev bulunamadı/);
  });

  it("rejects depends_on without parent and a parent that is not a pipeline", () => {
    const a = mk();
    expect(() => createTask({ project: "p", title: "x", kind: "dev", body: "", dependsOn: [a.data.id] }, D))
      .toThrow(/bağımlılık için --parent gerekli/);
    expect(() => phase(a.data.id)).toThrow(/pipeline görevi değil/);
  });

  it("rejects a role, parent or dependency on a pipeline task", () => {
    const p = pipe();
    expect(() => createTask({ project: "p", title: "x", kind: "pipeline", body: "", parent: p.data.id }, D))
      .toThrow(/pipeline görevi rol\/parent\/bağımlılık alamaz/);
    expect(() => createTask({ project: "p", title: "x", kind: "pipeline", body: "", role: "tester" }, D))
      .toThrow(/pipeline görevi rol\/parent\/bağımlılık alamaz/);
  });

  it("rejects a new phase under a cancelled pipeline", () => {
    const p = pipe();
    setState(p.data.id, "cancelled");
    expect(() => phase(p.data.id)).toThrow(/çatı görev .* cancelled; yeni faz eklenemez/);
  });

  it("old task files without the new fields still read and are never ready by dependency", () => {
    const t = mk();
    const raw = readFileSync(t.file, "utf8").replace(/^(parent|depends_on|phase):.*\r?\n/gm, "");
    writeFileSync(t.file, raw);
    expect(getTask(t.data.id).data.parent ?? null).toBeNull();
    expect(listTasks().map((x) => x.data.id)).toEqual([t.data.id]);
    expect(readyTasks().map((x) => x.data.id)).toEqual([t.data.id]);
  });
});

describe("digested", () => {
  const finish = (id: string) => { setState(id, "running"); setState(id, "awaiting_approval"); setState(id, "done"); };

  it("lists done tasks whose closing report has not been digested yet", () => {
    const a = mk("a");
    const b = mk("b");
    mk("c"); // queued
    finish(a.data.id);
    finish(b.data.id);
    expect(undigestedTasks().map((t) => t.data.id)).toEqual([a.data.id, b.data.id]);
    markDigested([a.data.id]);
    expect(getTask(a.data.id).data.digested).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getTask(a.data.id).data.state).toBe("done");
    expect(undigestedTasks().map((t) => t.data.id)).toEqual([b.data.id]);
  });

  it("refuses to mark a task that is not done, and marks nothing then", () => {
    const a = mk("a");
    const b = mk("b");
    finish(a.data.id);
    expect(() => markDigested([a.data.id, b.data.id])).toThrow(/done değil/);
    expect(getTask(a.data.id).data.digested ?? null).toBeNull();
  });
});

describe("listTasks ayrıştırma önbelleği (F-vlad-094)", () => {
  it("döndürülen görevi değiştirmek sonraki okumayı etkilemez", () => {
    const t = mk();
    const body = listTasks()[0].body;
    listTasks()[0].data.title = "bozuk";
    listTasks()[0].body = "bozuk";
    expect(listTasks()).toMatchObject([{ data: { id: t.data.id, title: "t" }, body }]);
  });
  it("dosya aynı boyutta yeniden yazılsa da yeni içerik görülür", () => {
    const t = mk("aaa");
    expect(listTasks()[0].data.title).toBe("aaa");
    writeFileSync(t.file, readFileSync(t.file, "utf8").replace("title: aaa", "title: bbb"));
    expect(listTasks()[0].data.title).toBe("bbb");
  });
  it("silinen dosya listeden düşer, bozulan dosya uyarı verir", () => {
    const a = mk("a");
    const b = mk("b");
    expect(listTasks()).toHaveLength(2);
    rmSync(a.file);
    expect(listTasks().map((x) => x.data.id)).toEqual([b.data.id]);
    writeFileSync(b.file, "bozuk");
    const r = listTasksWithWarnings();
    expect(r.tasks).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});
