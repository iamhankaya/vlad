import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { createTask, getTask, setDependencies, setState, unmetDependencies } from "../../src/tasks/index.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
let pipe: string;
const phase = (title: string, dependsOn: string[] = [], parent = pipe) =>
  createTask({ project: "p", title, kind: "dev", body: "## Tanım\nx\n", parent, dependsOn }, D).data.id;

beforeEach(() => {
  makeHome();
  pipe = createTask({ project: "p", title: "çatı", kind: "pipeline", body: "" }, D).data.id;
});

const raw = (id: string) => readFileSync(getTask(id).file);

describe("deps/ setDependencies", () => {
  it("set / add / remove / clear compute from the previous list, keeping order and dropping duplicates", () => {
    const a = phase("a"), b = phase("b"), c = phase("c"), x = phase("x", [a]);
    expect(setDependencies(x, { set: [b, c] })).toMatchObject({ previous: [a], changed: true });
    expect(getTask(x).data.depends_on).toEqual([b, c]);
    expect(setDependencies(x, { add: [a, b] }).task.data.depends_on).toEqual([b, c, a]);
    const r = setDependencies(x, { remove: [c, "T20260101-99"] });
    expect(r.task.data.depends_on).toEqual([b, a]);
    expect(r.warnings).toContain("bağımlılıkta yoktu: T20260101-99");
    const cl = setDependencies(x, { clear: true });
    expect(cl.task.data.depends_on).toEqual([]);
    expect(cl.warnings).toContain(`faz bağımlılıksız kaldı: ${x}`);
  });

  it("is idempotent: no write, no progress line when nothing changes", () => {
    const a = phase("a"), x = phase("x", [a]);
    const before = raw(x);
    expect(setDependencies(x, { set: [a] }).changed).toBe(false);
    expect(raw(x).equals(before)).toBe(true);
  });

  it("logs the change under ## İlerleme", () => {
    const a = phase("a"), b = phase("b"), x = phase("x", [a]);
    setDependencies(x, { set: [b] });
    expect(getTask(x).body).toContain(`bağımlılık: [${a}] -> [${b}]`);
  });

  it("exactly one mode is required", () => {
    const x = phase("x");
    expect(() => setDependencies(x, {})).toThrow(/tam olarak biri gerekli/);
    expect(() => setDependencies(x, { clear: true, set: [x] })).toThrow(/tam olarak biri gerekli/);
    expect(() => setDependencies(x, { set: [] })).toThrow(/--set boş olamaz.*--clear/);
  });

  it("rejects bad targets and leaves the file byte-for-byte unchanged", () => {
    const a = phase("a"), x = phase("x");
    const other = createTask({ project: "p", title: "ç2", kind: "pipeline", body: "" }, D).data.id;
    const foreign = phase("f", [], other);
    const cancelled = phase("c"); setState(cancelled, "cancelled");
    const running = phase("r"); setState(running, "running");
    const cases: [string, object, RegExp][] = [
      ["T20260101-99", { set: [a] }, /görev bulunamadı/],
      ["bozuk", { set: [a] }, /task|ID|pattern|id/i],
      [pipe, { set: [a] }, /pipeline görevinin bağımlılığı olmaz/],
      [running, { set: [a] }, /yalnızca queued/],
      [x, { set: [x] }, /kendine bağlanamaz/],
      [x, { set: ["T20260101-99"] }, /bağımlılık bulunamadı/],
      [x, { set: [foreign] }, /aynı pipeline'da değil/],
      [x, { set: [pipe] }, /aynı pipeline'da değil|pipeline görevi olamaz/],
      [x, { set: [cancelled] }, /iptal edilmiş/],
    ];
    for (const [id, mode, re] of cases) {
      let before: Buffer | null = null;
      try { before = raw(id); } catch { /* missing task */ }
      expect(() => setDependencies(id, mode), `${id} ${JSON.stringify(mode)}`).toThrow(re);
      if (before) expect(raw(id).equals(before)).toBe(true);
    }
  });

  it("rejects a standalone task (no parent) and a closed pipeline", () => {
    const solo = createTask({ project: "p", title: "s", kind: "dev", body: "" }, D).data.id;
    expect(() => setDependencies(solo, { set: [solo] })).toThrow(/--parent gerekli/);
    const a = phase("a"), x = phase("x");
    setState(pipe, "cancelled");
    expect(() => setDependencies(x, { set: [a] })).toThrow(/çatı görev/);
  });

  it("detects direct and indirect cycles", () => {
    const a = phase("a"), b = phase("b", [a]), c = phase("c", [b]);
    expect(() => setDependencies(a, { set: [c] })).toThrow(new RegExp(`döngü: ${a} -> ${c}.*-> ${a}`));
    expect(() => setDependencies(a, { set: [b] })).toThrow(/döngü/);
  });

  it("warns about a failed dependency but allows it", () => {
    const a = phase("a"), x = phase("x");
    setState(a, "running"); setState(a, "failed");
    const r = setDependencies(x, { set: [a] });
    expect(r.warnings).toContain(`bağımlılık failed: ${a}; yeniden queued/done olana kadar faz hazır olmaz`);
  });

  it("fails when another task of the pipeline is unreadable (graph incomplete)", async () => {
    const a = phase("a"), x = phase("x");
    const bad = phase("bad");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(getTask(bad).file, "---\nid: [\n---\n");
    expect(() => setDependencies(x, { set: [a] })).toThrow(/bağımlılık grafı eksik okundu/);
  });
});

describe("deps/ unmetDependencies", () => {
  it("lists dependencies that are not done", () => {
    const a = phase("a"), b = phase("b"), x = phase("x", [a, b]);
    setState(a, "running"); setState(a, "awaiting_approval"); setState(a, "done");
    expect(unmetDependencies(getTask(x))).toEqual([b]);
  });
});
