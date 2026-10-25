import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDoc } from "../../src/kb/doc.js";
import { safeAppendFile, safeWriteFile } from "../../src/kb/safefs.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-safefs-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("records: kb writes do not follow planted symlinks (S13c security finding 1)", () => {
  it("records: writeDoc over a symlinked active.md replaces the link and leaves the target alone", () => {
    const d = tmp();
    const victim = join(d, "victim.txt");
    writeFileSync(victim, "KORUNMALI\n");
    symlinkSync(victim, join(d, "active.md"));
    writeDoc(join(d, "active.md"), { machine: "srvbox" }, "");
    expect(readFileSync(victim, "utf8")).toBe("KORUNMALI\n");
    expect(lstatSync(join(d, "active.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(d, "active.md"), "utf8")).toMatch(/machine: srvbox/);
    expect(readdirSync(d).sort()).toEqual(["active.md", "victim.txt"]); // no temp file left behind
  });

  it("records: a planted temp name is useless (random, O_EXCL), and a symlinked parent directory is refused", () => {
    const d = tmp();
    const victim = join(d, "victim.txt");
    writeFileSync(victim, "KORUNMALI\n");
    for (const n of ["active.md.tmp", `.active.md.${process.pid}.tmp`, "active.md.1.tmp"]) symlinkSync(victim, join(d, n));
    safeWriteFile(join(d, "active.md"), "yeni\n");
    expect(readFileSync(victim, "utf8")).toBe("KORUNMALI\n");
    const outside = tmp();
    mkdirSync(join(outside, "real"));
    symlinkSync(join(outside, "real"), join(d, "cards"));
    expect(() => safeWriteFile(join(d, "cards", "C-1.md"), "x")).toThrow(/symlink üst klasör/);
    expect(existsSync(join(outside, "real", "C-1.md"))).toBe(false);
  });

  it("records: appends refuse a symlinked file and a symlinked parent", () => {
    const d = tmp();
    const victim = join(d, "victim.txt");
    writeFileSync(victim, "KORUNMALI\n");
    symlinkSync(victim, join(d, "2026-10.jsonl"));
    expect(() => safeAppendFile(join(d, "2026-10.jsonl"), "{}\n")).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("KORUNMALI\n");
    safeAppendFile(join(d, "ok.jsonl"), "a\n");
    safeAppendFile(join(d, "ok.jsonl"), "b\n");
    expect(readFileSync(join(d, "ok.jsonl"), "utf8")).toBe("a\nb\n");
  });
});
