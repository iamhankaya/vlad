// F-vlad-355 kök neden: test ortamında gerçek ~/Library/LaunchAgents'a yazma/silme ve gerçek launchctl değişikliği imkânsız olmalı.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSecretDirForTests } from "../../src/mode/token.js";
import { createLaunchdInstaller } from "../../src/approver/launchd.js";
import { createMonitorInstaller } from "../../src/monitor/launchd.js";
import { assertTestSafeLaunchd, guardLaunchctl, inTestEnv, realLaunchAgentsDir } from "../../src/launchd-guard.js";
import { installPlan } from "../../src/agent/install.js";
import { IS_WIN } from "../support/platform.js";

const ctx = { node: "/usr/bin/node", cli: "/x/cli.js", home: "/x", path: "/usr/bin" };
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vlad-lg-")));
const spyLc = () => {
  const calls: string[][] = [];
  return { calls, lc: async (a: string[]) => { calls.push(a); return { code: 0, stdout: "", stderr: "" }; } };
};
// installer yaşam döngüsü günlüğü (approver.log) gizli dizin altına yazar (launchd.ts lifecycleLog); varsayılan test gizli dizini süreçler arası paylaşılır ve orada kalan
// "approver" alt dizini mode.test.ts'yi "gizli dizin var, anahtar yok" ile kırar (Windows tam koşusunda 1/4 gözlendi): bu dosya kendi geçici gizli dizinini kullanır.
beforeEach(() => { setSecretDirForTests(join(tmp(), "secret")); });
afterEach(() => setSecretDirForTests(null));
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
  // Windows'ta atlanır: symlink oluşturma ayrıcalık ister (EPERM); launchd yalnız macOS
  it.skipIf(IS_WIN)("approver: açıkça verilen plistDir gerçek LaunchAgents ise (sembolik bağ dahil) reddedilir", async () => {
    const { calls, lc } = spyLc();
    await expect(createLaunchdInstaller({ launchctl: lc, plistDir: realLaunchAgentsDir() }).uninstall()).rejects.toThrow(/gerçek/);
    expect(calls).toEqual([]);
  });
  // F-vlad-363: sembolik bağ dalı gerçek ev dizinine bağlı olmadan sınanır (sahte "gerçek" dizin geçici HOME'da)
  it.skipIf(IS_WIN)("guard: sahte gerçek LaunchAgents'a giden sembolik bağ (ve altı) reddedilir; ilgisiz geçici dizin geçer", () => {
    const fakeReal = join(tmp(), "Library", "LaunchAgents");
    mkdirSync(fakeReal, { recursive: true });
    const link = join(tmp(), "LA");
    symlinkSync(fakeReal, link);
    expect(() => assertTestSafeLaunchd({ plistDir: link, injected: true, realDir: fakeReal })).toThrow(/gerçek/);
    expect(() => assertTestSafeLaunchd({ plistDir: join(link, "sub"), injected: true, realDir: fakeReal })).toThrow(/gerçek/);
    expect(() => assertTestSafeLaunchd({ plistDir: join(tmp(), "LA2"), injected: true, realDir: fakeReal })).not.toThrow();
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

describe("watchdogKick: selfUpdate yeniden başlatma yolundaki gerçek launchctl kickstart (T20261121-43)", () => {
  it("test ortamında kickstart komutu üretilmez (gerçek servis tetiklenmez)", async () => {
    const { watchdogKick } = await import("../../src/launchd-guard.js");
    expect(watchdogKick("darwin", 501)).toBe("");
    expect(watchdogKick("darwin", 501, { VLAD_TEST_GUARD: "1" })).toBe("");
  });
  it("test dışında Mac'te kickstart -k argv'sini JSON olarak verir; Mac dışı ya da uid yoksa boş", async () => {
    const { watchdogKick } = await import("../../src/launchd-guard.js");
    expect(JSON.parse(watchdogKick("darwin", 501, {}))).toEqual(["launchctl", "kickstart", "-k", "gui/501/com.vlad.agent"]);
    expect(watchdogKick("linux", 501, {})).toBe("");
    expect(watchdogKick("darwin", undefined, {})).toBe("");
  });
  it("start.ts kickstart'ı watchdogKick üzerinden kurar (ham kickstart dizesi yok)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "agent", "start.ts"), "utf8");
    expect(src).toContain("watchdogKick(");
    expect(src).not.toMatch(/"kickstart"/);
  });
  it("home: launchdHome HOME'u izler, yoksa userInfo'ya düşer", async () => {
    const { launchdHome } = await import("../../src/launchd-guard.js");
    expect(launchdHome({ HOME: "/tmp/x" })).toBe("/tmp/x");
    expect(launchdHome({})).toBe(userInfo().homedir);
  });
});
