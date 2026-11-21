// F-vlad-355 kök neden: test ortamında gerçek ~/Library/LaunchAgents'a yazma/silme ve gerçek launchctl değişikliği imkânsız olmalı.
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLaunchdInstaller } from "../../src/approver/launchd.js";
import { createMonitorInstaller } from "../../src/monitor/launchd.js";
import { assertTestSafeLaunchd, guardLaunchctl, inTestEnv, realLaunchAgentsDir } from "../../src/launchd-guard.js";
import { installPlan } from "../../src/agent/install.js";

const ctx = { node: "/usr/bin/node", cli: "/x/cli.js", home: "/x", path: "/usr/bin" };
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vlad-lg-")));
const spyLc = () => {
  const calls: string[][] = [];
  return { calls, lc: async (a: string[]) => { calls.push(a); return { code: 0, stdout: "", stderr: "" }; } };
};
const MUTATING = "bootstrap bootout kickstart load unload remove enable disable".split(" ");

describe("launchd koruması (test ortamı)", () => {
  it("vitest altında test ortamı algılanır", () => {
    expect(inTestEnv()).toBe(true);
    expect(inTestEnv({})).toBe(false);
    expect(inTestEnv({ NODE_ENV: "test" })).toBe(true);
  });

  it("approver: plistDir/homeDir verilmeden install ve uninstall reddedilir, launchctl çağrılmaz", async () => {
    const { calls, lc } = spyLc();
    const inst = createLaunchdInstaller({ launchctl: lc });
    await expect(inst.install(ctx)).rejects.toThrow(/gerçek.*LaunchAgents|test ortamı/i);
    await expect(inst.uninstall()).rejects.toThrow(/gerçek.*LaunchAgents|test ortamı/i);
    expect(calls).toEqual([]);
  });
  it("approver: açıkça verilen plistDir gerçek LaunchAgents ise (sembolik bağ dahil) reddedilir", async () => {
    const { calls, lc } = spyLc();
    await expect(createLaunchdInstaller({ launchctl: lc, plistDir: realLaunchAgentsDir() }).uninstall()).rejects.toThrow(/gerçek/);
    const link = join(tmp(), "LA");
    symlinkSync(realLaunchAgentsDir(), link);
    await expect(createLaunchdInstaller({ launchctl: lc, plistDir: link }).uninstall()).rejects.toThrow(/gerçek/);
    expect(calls).toEqual([]);
  });
  it("approver: sahte launchctl verilmeden (gerçek launchctl) kurulum test ortamında reddedilir", async () => {
    await expect(createLaunchdInstaller({ plistDir: join(tmp(), "LA") }).install(ctx)).rejects.toThrow(/launchctl/);
  });
  it("approver: geçici plistDir + sahte launchctl ile çalışmaya devam eder", async () => {
    const { calls, lc } = spyLc();
    await createLaunchdInstaller({ launchctl: lc, plistDir: join(tmp(), "LA") }).uninstall();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("monitor: dizin verilmeden, gerçek LaunchAgents ile ve gerçek launchctl ile reddedilir", async () => {
    const { calls, lc } = spyLc();
    await expect(createMonitorInstaller({ launchctl: lc }).install(ctx)).rejects.toThrow(/gerçek|test ortamı/i);
    await expect(createMonitorInstaller({ launchctl: lc }).uninstall()).rejects.toThrow(/gerçek|test ortamı/i);
    await expect(createMonitorInstaller({ launchctl: lc, plistDir: realLaunchAgentsDir() }).uninstall()).rejects.toThrow(/gerçek/);
    await expect(createMonitorInstaller({ plistDir: join(tmp(), "LA"), stateDir: tmp() }).install(ctx)).rejects.toThrow(/launchctl/);
    expect(calls).toEqual([]);
  });

  it("agent: darwin installPlan.apply gerçek LaunchAgents'a test ortamında yazmaz", () => {
    const p = installPlan("darwin", { ...ctx, port: 7777 } as never);
    expect(p.file.startsWith(realLaunchAgentsDir())).toBe(true);
    expect(() => p.apply()).toThrow(/gerçek|test ortamı/i);
  });

  it("guardLaunchctl: test ortamında değiştiren fiiller reddedilir, print geçer", async () => {
    const { calls, lc } = spyLc();
    const g = guardLaunchctl(lc);
    for (const v of MUTATING) await expect(g([v, "x"]), v).rejects.toThrow(/launchctl/);
    expect(calls).toEqual([]);
    await g(["print", "gui/501/x"]);
    expect(calls).toEqual([["print", "gui/501/x"]]);
  });
  it("assertTestSafeLaunchd: test dışı ortamda (env boş) geçirir", () => {
    const plistDir = join(userInfo().homedir, "Library", "LaunchAgents");
    expect(() => assertTestSafeLaunchd({ plistDir, injected: false, env: {} })).not.toThrow();
  });
});
