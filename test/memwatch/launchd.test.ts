import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMWATCH_LABEL, createMemwatchInstaller, memwatchPlist } from "../../src/memwatch/launchd.js";
import type { Launchctl } from "../../src/approver/launchd.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vlad-mw-ld-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const fakeLc = (fail?: string): { lc: Launchctl; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, lc: async (a) => { calls.push(a); return a[0] === fail ? { code: 5, stdout: "", stderr: "olmadı" } : { code: 0, stdout: a[0] === "print" ? "state = running" : "", stderr: "" }; } };
};
const c = { binary: "/opt/vlad/dist/bin/memwatch", path: "/usr/bin:/bin" };

describe("memwatch launchd", () => {
  it("plist runs `memwatch daemon` kept alive, background, logs to ~/.vlad-monitor/memwatch.log, no secrets in env", () => {
    const p = memwatchPlist(c, "/h/.vlad-monitor/memwatch.log");
    expect(p).toContain(`<key>Label</key><string>${MEMWATCH_LABEL}</string>`);
    expect(p).toContain("<array><string>/opt/vlad/dist/bin/memwatch</string><string>daemon</string></array>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>ProcessType</key><string>Background</string>");
    expect(p).toContain("<key>StandardErrorPath</key><string>/h/.vlad-monitor/memwatch.log</string>");
    expect(p).toMatch(/<key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>\/usr\/bin:\/bin<\/string><\/dict>/);
    expect(p).not.toMatch(/topic|token|secret/i);
  });

  it("escapes XML in paths", () => {
    expect(memwatchPlist({ binary: "/a&b/<m>", path: "" }, "/l")).toContain("<string>/a&amp;b/&lt;m&gt;</string>");
  });

  it("install writes 0600 plist + log under the injected home and bootstraps; status reads launchctl", async () => {
    const { lc, calls } = fakeLc();
    const inst = createMemwatchInstaller({ launchctl: lc, homeDir: tmp });
    const steps = await inst.install(c);
    const plist = join(tmp, "Library", "LaunchAgents", `${MEMWATCH_LABEL}.plist`);
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, ".vlad-monitor", "memwatch.log")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, ".vlad-monitor")).mode & 0o777).toBe(0o700);
    const uid = process.getuid?.() ?? 501;
    expect(calls).toEqual([["bootout", `gui/${uid}/${MEMWATCH_LABEL}`], ["bootstrap", `gui/${uid}`, plist]]);
    expect(steps.length).toBe(2);
    expect(await inst.status()).toEqual({ installed: true, running: true, detail: "çalışıyor" });
  });

  it("failed bootstrap removes the plist and throws", async () => {
    const { lc } = fakeLc("bootstrap");
    const inst = createMemwatchInstaller({ launchctl: lc, homeDir: tmp });
    await expect(inst.install(c)).rejects.toThrow(/bootstrap başarısız/);
    expect(existsSync(join(tmp, "Library", "LaunchAgents", `${MEMWATCH_LABEL}.plist`))).toBe(false);
  });

  it("uninstall boots out and deletes the plist but keeps the state dir; not-loaded is success", async () => {
    const { lc } = fakeLc();
    const inst = createMemwatchInstaller({ launchctl: lc, homeDir: tmp });
    await inst.install(c);
    await inst.uninstall();
    expect(existsSync(join(tmp, "Library", "LaunchAgents", `${MEMWATCH_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(tmp, ".vlad-monitor", "memwatch.log"))).toBe(true);
    const notLoaded: Launchctl = async () => ({ code: 3, stdout: "", stderr: "No such process" });
    await expect(createMemwatchInstaller({ launchctl: notLoaded, homeDir: tmp }).uninstall()).resolves.toBeDefined();
    expect(await createMemwatchInstaller({ launchctl: notLoaded, homeDir: tmp }).status()).toMatchObject({ installed: false });
  });

  it("refuses the real LaunchAgents dir and real launchctl under tests", async () => {
    await expect(createMemwatchInstaller().install(c)).rejects.toThrow();
  });

  it("plist file content matches memwatchPlist", async () => {
    const { lc } = fakeLc();
    await createMemwatchInstaller({ launchctl: lc, homeDir: tmp }).install(c);
    const body = readFileSync(join(tmp, "Library", "LaunchAgents", `${MEMWATCH_LABEL}.plist`), "utf8");
    expect(body).toBe(memwatchPlist(c, join(tmp, ".vlad-monitor", "memwatch.log")));
  });
});
