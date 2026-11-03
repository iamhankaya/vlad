import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secureDir } from "../../src/launcher/desktop-queue.js";

const icacls = (...a: string[]) => execFileSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "icacls.exe"), a, { encoding: "utf8" });

describe.skipIf(process.platform !== "win32")("secureDir (Windows ACL)", () => {
  it("replaces a pre-existing open ACE (Everyone full control) with user + SYSTEM only, children included", () => {
    const base = mkdtempSync(join(tmpdir(), "vlad-acl-"));
    try {
      const dir = join(base, "vlad");
      mkdirSync(dir);
      writeFileSync(join(dir, "old.ps1"), "x");
      icacls(dir, "/grant", "*S-1-1-0:(OI)(CI)F"); // Everyone
      expect(icacls(dir)).toMatch(/Everyone/i);
      secureDir(dir);
      for (const p of [dir, join(dir, "old.ps1")]) {
        const out = icacls(p);
        expect(out, p).not.toMatch(/Everyone|BUILTIN.Users|Authenticated Users/i);
        expect(out, p).toMatch(/NT AUTHORITY.SYSTEM/i);
        if (p === dir) expect(out, p).not.toMatch(/\(I\)/); // the folder itself inherits nothing (children inherit from it)
      }
      secureDir(dir); // idempotent
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
