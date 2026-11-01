import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../../src/agent/journal.js";
import { reconcile } from "../../src/agent/reconcile.js";
import { rmTemp } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmTemp(d); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-j-")); dirs.push(d); return join(d, "journal.jsonl"); };
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

describe("machines:B journal", () => {
  it("started → done keeps the first result and survives reload", () => {
    const f = tmp();
    const j = new Journal(f, () => NOW);
    j.start("o1", "windows", "apply-write", "h1");
    expect(j.get("o1")?.state).toBe("started");
    j.finish("o1", "done", { stdout: "ilk" });
    const again = new Journal(f, () => NOW);
    expect(again.get("o1")).toMatchObject({ state: "done", from: "windows", op: "apply-write", argsHash: "h1", result: { stdout: "ilk" } });
  });
  it("lists started leftovers after a crash", () => {
    const f = tmp();
    new Journal(f, () => NOW).start("o2", "windows", "launch", "h");
    expect(new Journal(f, () => NOW).startedList().map((r) => r.opId)).toEqual(["o2"]);
  });
  it("aborted can be started again (re-execution)", () => {
    const j = new Journal(tmp(), () => NOW);
    j.start("o3", "w", "close", "h");
    j.finish("o3", "aborted");
    j.start("o3", "w", "close", "h");
    expect(j.get("o3")?.state).toBe("started");
  });
  it("tombstone blocks later execution", () => {
    const j = new Journal(tmp(), () => NOW);
    j.tombstone("o4", "mac");
    expect(j.get("o4")?.state).toBe("aborted-cancelled");
  });
  it("prunes records older than 14 days on load and rewrites the file", () => {
    const f = tmp();
    const old = new Journal(f, () => NOW - 15 * DAY);
    old.start("old", "w", "close", "h");
    old.finish("old", "done", 1);
    const fresh = new Journal(f, () => NOW - 1 * DAY);
    fresh.start("new", "w", "close", "h");
    fresh.finish("new", "done", 2);
    const loaded = new Journal(f, () => NOW);
    expect(loaded.get("old")).toBeUndefined();
    expect(loaded.get("new")?.state).toBe("done");
    expect(readFileSync(f, "utf8")).not.toContain('"old"');
  });
  it("skips a torn last line", () => {
    const f = tmp();
    new Journal(f, () => NOW).start("ok", "w", "close", "h");
    appendFileSync(f, '{"opId":"torn","sta');
    expect(new Journal(f, () => NOW).get("ok")?.state).toBe("started");
  });
  it("waitFor resolves when a concurrent execution finishes", async () => {
    const j = new Journal(tmp(), () => NOW);
    j.start("o5", "w", "close", "h");
    const p = j.waitFor("o5");
    j.finish("o5", "done", "x");
    await expect(p).resolves.toMatchObject({ state: "done", result: "x" });
  });
});

describe("machines:B reconcile", () => {
  it("applied → done+recovered, not-applied → aborted, unknown → done+uncertain, idempotent ops default to aborted", () => {
    const j = new Journal(tmp(), () => NOW);
    j.start("a", "w", "launch", "h"); j.start("b", "w", "launch", "h"); j.start("c", "w", "resume", "h"); j.start("d", "w", "close", "h");
    const results: Record<string, "applied" | "not-applied" | "unknown"> = { a: "applied", b: "not-applied", c: "unknown" };
    reconcile(j, { launch: (r) => results[r.opId], resume: (r) => results[r.opId] });
    expect(j.get("a")).toMatchObject({ state: "done", meta: { recovered: true } });
    expect(j.get("b")?.state).toBe("aborted");
    expect(j.get("c")).toMatchObject({ state: "done", meta: { uncertain: true } });
    expect(j.get("d")?.state).toBe("aborted");
    expect(j.startedList()).toEqual([]);
  });
  it("a throwing reconciler counts as unknown for side-effect ops", () => {
    const j = new Journal(tmp(), () => NOW);
    j.start("e", "w", "apply-write", "h");
    reconcile(j, { "apply-write": () => { throw new Error("boom"); } });
    expect(j.get("e")).toMatchObject({ state: "done", meta: { uncertain: true } });
  });
});
