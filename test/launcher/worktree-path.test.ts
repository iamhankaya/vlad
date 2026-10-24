import { describe, expect, it } from "vitest";
import { worktreePath } from "../../src/git/git.js";
import type { VladConfig } from "../../src/kb/index.js";

const cfg = (worktreeDir: string) => ({ worktreeDir }) as VladConfig;

describe("launcher: worktreePath", () => {
  it("launcher: worktreePath windows platform characterization", () => {
    expect(worktreePath(cfg("{repo}-wt"), "C:\\dev\\watchparty", "T20261015-01", "win32")).toBe("C:\\dev\\watchparty-wt\\T20261015-01");
    // trailing separators of the template collapse; a fixed dir keeps its drive letter
    expect(worktreePath(cfg("D:\\wt\\"), "C:\\dev\\x", "T20261015-01", "win32")).toBe("D:\\wt\\T20261015-01");
    expect(worktreePath(cfg("D:/wt/"), "C:\\dev\\x", "T20261015-01", "win32")).toBe("D:/wt\\T20261015-01");
  });

  it("launcher: worktreePath linux uses forward slashes", () => {
    const p = worktreePath(cfg("{repo}-wt"), "/srv/vlad/repos/watchparty", "T20261015-01", "linux");
    expect(p).toBe("/srv/vlad/repos/watchparty-wt/T20261015-01");
    expect(p).not.toContain("\\");
    expect(worktreePath(cfg("/var/wt/"), "/srv/x", "T20261015-01", "linux")).toBe("/var/wt/T20261015-01");
    expect(worktreePath(cfg("{repo}-wt"), "/srv/x", "T20261015-01", "darwin")).toBe("/srv/x-wt/T20261015-01");
  });

  it("launcher: windows-style worktreeDir rejected on linux with explicit error", () => {
    for (const dir of ["C:\\dev\\{repo}-wt", "D:/wt", "\\\\nas\\wt", "{repo}\\wt"]) {
      expect(() => worktreePath(cfg(dir), "/srv/x", "T20261015-01", "linux")).toThrow(/worktreeDir Windows biçimli/);
    }
  });

  it("launcher: worktreePath defaults to the running platform", () => {
    if (process.platform === "win32") expect(worktreePath(cfg("{repo}-wt"), "C:\\r", "T20261015-01")).toBe("C:\\r-wt\\T20261015-01");
    else expect(worktreePath(cfg("{repo}-wt"), "/r", "T20261015-01")).toBe("/r-wt/T20261015-01");
  });
});
