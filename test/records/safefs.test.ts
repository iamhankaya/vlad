import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(() => safeWriteFile(join(d, "cards", "C-1.md"), "x")).toThrow(); // O_NOFOLLOW on the directory itself
    expect(existsSync(join(outside, "real", "C-1.md"))).toBe(false);
  });

  it("records: a symlinked ancestor anywhere between the kb root and the file is refused (finding 1 / Y3)", () => {
    const root = tmp(), outside = tmp();
    mkdirSync(join(outside, "deep"));
    symlinkSync(outside, join(root, "cards"));
    expect(() => safeWriteFile(join(root, "cards", "deep", "C-1.md"), "x", { root })).toThrow(/symlink üst klasör/);
    expect(() => safeAppendFile(join(root, "cards", "deep", "a.jsonl"), "x", { root })).toThrow(/symlink üst klasör/);
    expect(readdirSync(join(outside, "deep"))).toEqual([]);
    // a real nested directory is fine
    mkdirSync(join(root, "a", "b"), { recursive: true });
    safeWriteFile(join(root, "a", "b", "f.md"), "ok\n", { root });
    expect(readFileSync(join(root, "a", "b", "f.md"), "utf8")).toBe("ok\n");
  });

  it.runIf(process.platform === "linux")("records: swapping the directory for a symlink after it was opened does not redirect the write (Y3 race)", () => {
    const root = tmp(), outside = tmp();
    mkdirSync(join(root, "cards"));
    safeWriteFile(join(root, "cards", "C-1.md"), "eski\n", {
      root,
      afterOpen: () => { // the attacker's move between the check and the write
        renameSync(join(root, "cards"), join(root, "cards.moved"));
        symlinkSync(outside, join(root, "cards"));
      },
    });
    expect(readdirSync(outside)).toEqual([]); // nothing landed in the symlink's target
    expect(readFileSync(join(root, "cards.moved", "C-1.md"), "utf8")).toBe("eski\n"); // it went where the opened directory is
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
