import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { worktreePath } from "../../src/git/git.js";
import { pickRepoDir, repoNameOf } from "../../src/fleet/paths.js";

const cfg = defaultConfig();

describe("machines:A paths", () => {
  it("repoNameOf takes the last segment of a win32 or posix path, ignoring trailing separators", () => {
    expect(repoNameOf("C:\\dev\\vlad")).toBe("vlad");
    expect(repoNameOf("C:\\dev\\vlad\\")).toBe("vlad");
    expect(repoNameOf("/Users/x/dev/vlad/")).toBe("vlad");
  });
  it("K15: worktreePath default (no os) is byte-identical to the legacy win32 form", () => {
    expect(worktreePath(cfg, "C:\\dev\\vlad", "T1")).toBe("C:\\dev\\vlad-wt\\T1");
    expect(worktreePath(cfg, "C:\\dev\\vlad", "T1", "win32")).toBe("C:\\dev\\vlad-wt\\T1");
    expect(worktreePath({ ...cfg, worktreeDir: "D:\\wt\\{repo}\\" }, "vlad", "T1")).toBe("D:\\wt\\vlad\\T1");
  });
  it("K15: posix target uses / (win-style repo -> posix)", () => {
    expect(worktreePath(cfg, "/Users/x/dev/vlad", "T1", "darwin")).toBe("/Users/x/dev/vlad-wt/T1");
    expect(worktreePath({ ...cfg, worktreeDir: "/Users/x/wt/{repo}/" }, "vlad", "T1", "linux")).toBe("/Users/x/wt/vlad/T1");
  });
  it("K15: win32 target keeps backslash even when asked from a posix machine", () => {
    expect(worktreePath({ ...cfg, worktreeDir: "C:\\wt\\{repo}" }, "vlad", "T9", "win32")).toBe("C:\\wt\\vlad\\T9");
  });
  it("K15: pickRepoDir: 0 -> not_found, 1 -> ok, >1 distinct -> conflict listing them", () => {
    expect(pickRepoDir([])).toEqual({ ok: false, code: "not_found" });
    expect(pickRepoDir(["/a/vlad"])).toEqual({ ok: true, dir: "/a/vlad" });
    expect(pickRepoDir(["/a/vlad", "/b/vlad"])).toEqual({ ok: false, code: "conflict", candidates: ["/a/vlad", "/b/vlad"] });
    expect(pickRepoDir(["/a/vlad", "/a/vlad"])).toEqual({ ok: true, dir: "/a/vlad" });
  });
});
