import { describe, expect, it } from "vitest";
import { isCloudEnv } from "../../src/kb/index.js";
import { resolveLaunchMode } from "../../src/launcher/index.js";
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
