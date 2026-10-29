import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDecision, writeDoc, writeFileAtomic } from "../../src/kb/index.js";
import { makeHome, rmTemp } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });
afterEach(() => rmTemp(home));

const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("F-vlad-084/ atomic kb writes", () => {
  it("a write that fails half way keeps the old content and leaves no temp file", () => {
    const f = join(home, "a.md");
    writeFileSync(f, "old");
    expect(() => writeFileAtomic(f, "new content", { write: (p) => { writeFileSync(p, "ne"); throw new Error("ENOSPC"); } })).toThrow(/ENOSPC/);
    expect(readFileSync(f, "utf8")).toBe("old");
    expect(leftovers(home)).toEqual([]);
  });

  it("writes the new content when nothing fails", () => {
    const f = join(home, "a.md");
    writeFileSync(f, "old");
    writeFileAtomic(f, "new");
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(leftovers(home)).toEqual([]);
  });

  it("exclusive mode refuses an existing file (EEXIST) and keeps it", () => {
    const f = join(home, "a.md");
    writeFileSync(f, "old");
    expect(() => writeFileAtomic(f, "new", { exclusive: true })).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(readFileSync(f, "utf8")).toBe("old");
    expect(leftovers(home)).toEqual([]);
  });

  it("writeDoc: a failing final step (target is a directory) throws, cleans up and does not truncate", () => {
    const dir = join(home, "kb", "tasks", "T1.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "k");
    expect(() => writeDoc(dir, { id: "T1" }, "body")).toThrow();
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("k");
    expect(leftovers(join(home, "kb", "tasks"))).toEqual([]);
  });

  it("addDecision still appends through the atomic path", () => {
    addDecision({ project: "p", title: "t", body: "b" });
    expect(existsSync(join(home, "kb", "decisions", "p.md"))).toBe(true);
  });
});
