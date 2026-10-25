import { describe, expect, it } from "vitest";
import { isCloudEnv } from "../../src/kb/index.js";
import { closeWorkerWindow, defaultExec, resolveLaunchMode } from "../../src/launcher/index.js";
import { validate } from "../../src/kb/index.js";
import { defaultConfig } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

describe("resolveLaunchMode", () => {
  it("explicit cloud is cloud everywhere", () => {
    expect(resolveLaunchMode("cloud", "win32", {})).toBe("cloud");
    expect(resolveLaunchMode("cloud", "linux", {})).toBe("cloud");
  });
  it("auto on Windows keeps the terminal behavior, even when the cloud variable is set", () => {
    expect(resolveLaunchMode("auto", "win32", {})).toBe("auto-terminal");
    expect(resolveLaunchMode("auto", "win32", { CLAUDE_CODE_REMOTE: "true" })).toBe("auto-terminal");
  });
  it("auto on Linux picks cloud when CLAUDE_CODE_REMOTE=true", () => {
    expect(resolveLaunchMode("auto", "linux", { CLAUDE_CODE_REMOTE: "true" })).toBe("cloud");
  });
  it("auto on Linux without the cloud fails clearly", () => {
    expect(() => resolveLaunchMode("auto", "linux", {})).toThrow(/bulut algılanmadı/);
    expect(() => resolveLaunchMode("auto", "linux", { CLAUDE_CODE_REMOTE: "false" })).toThrow(/CLAUDE_CODE_REMOTE/);
  });
  it("wt and powershell are passed through", () => {
    expect(resolveLaunchMode("wt", "linux", {})).toBe("wt");
    expect(resolveLaunchMode("powershell", "win32", {})).toBe("powershell");
  });
  it("isCloudEnv needs exactly 'true'", () => {
    expect(isCloudEnv({ CLAUDE_CODE_REMOTE: "true" })).toBe(true);
    expect(isCloudEnv({ CLAUDE_CODE_REMOTE: "1" })).toBe(false);
    expect(isCloudEnv({})).toBe(false);
  });
});

describe("schemas", () => {
  it("config accepts launcher: cloud, still rejects unknown values", () => {
    const home = makeHome();
    validate("config", { ...defaultConfig(), launcher: "cloud" }, home);
    expect(() => validate("config", { ...defaultConfig(), launcher: "tmux" }, home)).toThrow();
  });
  it("project card: exposure is optional, accepts local|network|internet, rejects other values", () => {
    makeHome();
    const base = {
      slug: "a", name: "A", path: "C:\\dev\\a", stack: [], status: "active", autonomy: "commit",
      last_activity: null, last_scanned: null,
    };
    validate("project", base);
    for (const exposure of ["local", "network", "internet"]) validate("project", { ...base, exposure });
    expect(() => validate("project", { ...base, exposure: "public" })).toThrow();
    expect(() => validate("project", { ...base, exposure: true })).toThrow();
  });
  it("project card: repo/local_only are optional; old cards stay valid; bad repo rejected", () => {
    makeHome();
    const base = {
      slug: "a", name: "A", path: "C:\\dev\\a", stack: [], status: "active", autonomy: "commit",
      last_activity: null, last_scanned: null,
    };
    validate("project", base);
    validate("project", { ...base, repo: "iamhankaya/vlad", local_only: true, local_only_reason: "WPF" });
    expect(() => validate("project", { ...base, repo: "not-a-repo" })).toThrow();
    expect(() => validate("project", { ...base, local_only: "yes" })).toThrow();
  });
});

describe("F-vlad-064: test launcher guard", () => {
  const NOOP = { VLAD_LAUNCHER: "noop" };
  it("VLAD_LAUNCHER=noop beats auto/wt/powershell, but not cloud", () => {
    expect(resolveLaunchMode("auto", "win32", NOOP)).toBe("noop");
    expect(resolveLaunchMode("wt", "win32", NOOP)).toBe("noop");
    expect(resolveLaunchMode("powershell", "linux", NOOP)).toBe("noop");
    expect(resolveLaunchMode("cloud", "win32", NOOP)).toBe("cloud");
  });
  it("VLAD_ALLOW_REAL_LAUNCHER=1 lifts the guard", () => {
    expect(resolveLaunchMode("auto", "win32", { ...NOOP, VLAD_ALLOW_REAL_LAUNCHER: "1" })).toBe("auto-terminal");
  });
  it("a real terminal start or window kill under the guard throws instead of spawning", async () => {
    const saved = { ...process.env };
    process.env.VLAD_LAUNCHER = "noop";
    delete process.env.VLAD_ALLOW_REAL_LAUNCHER;
    try {
      await expect(defaultExec("powershell.exe", ["-Command", "exit 0"])).rejects.toThrow(/VLAD_LAUNCHER=noop/);
      expect(() => closeWorkerWindow("T20260101-01")).toThrow(/VLAD_LAUNCHER=noop/);
    } finally {
      process.env = saved;
    }
  });
});
