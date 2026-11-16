import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaunchdInstaller, approverPlist, type Launchctl } from "../../src/approver/launchd.js";

const ctx = { node: "/usr/bin/node", cli: "/v/dist/cli.js", home: "/v", path: "/usr/bin:/bin" };
const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), "vlad-lc-"));
  const calls: string[][] = [];
  const results: Record<string, { code: number; stdout?: string; stderr?: string }> = {};
  const launchctl: Launchctl = async (a) => { calls.push(a); const r = results[a[0]!] ?? { code: 0 }; return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
  const cleanup = () => { if (realpathSync(dir).startsWith(realpathSync(tmpdir()))) rmSync(dir, { recursive: true, force: true }); };
  return { dir, calls, results, launchctl, cleanup };
};

describe("approver: launchd plist", () => {
  const p = approverPlist(ctx);
  it("label, RunAtLoad, KeepAlive, ThrottleInterval 10; AbandonProcessGroup yok", () => {
    expect(p).toContain("<key>Label</key><string>com.vlad.approver</string>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(p).not.toContain("AbandonProcessGroup");
  });
  it("argümanlar: node cli approver run; env yalnız PATH ve VLAD_HOME; XML kaçışı", () => {
    expect(approverPlist({ ...ctx, path: "/a&b" })).toContain("/a&amp;b");
    expect(p).toContain("<string>approver</string><string>run</string>");
    expect(p).not.toContain("VLAD_MODE_TOKEN");
  });
});

describe("approver: launchd installer", () => {
  it("install: plist yazar (0600), bootout sonra bootstrap; idempotent", async () => {
    const t = mk();
    try {
      const inst = createLaunchdInstaller({ launchctl: t.launchctl, plistDir: t.dir });
      await inst.install(ctx); await inst.install(ctx);
      expect(existsSync(join(t.dir, "com.vlad.approver.plist"))).toBe(true);
      expect(t.calls.map((c) => c[0])).toEqual(["bootout", "bootstrap", "bootout", "bootstrap"]);
      expect(t.calls[1]![2]).toBe(join(t.dir, "com.vlad.approver.plist"));
    } finally { t.cleanup(); }
  });
  it("bootstrap başarısız: plist geri alınır ve hata fırlar", async () => {
    const t = mk();
    try {
      t.results.bootstrap = { code: 5, stderr: "boom" };
      const inst = createLaunchdInstaller({ launchctl: t.launchctl, plistDir: t.dir });
      await expect(inst.install(ctx)).rejects.toThrow(/boom/);
      expect(existsSync(join(t.dir, "com.vlad.approver.plist"))).toBe(false);
    } finally { t.cleanup(); }
  });
  it("uninstall: bootout + plist silinir; yokken de hata vermez", async () => {
    const t = mk();
    try {
      const inst = createLaunchdInstaller({ launchctl: t.launchctl, plistDir: t.dir });
      await inst.install(ctx); t.calls.length = 0;
      await inst.uninstall();
      expect(t.calls[0]![0]).toBe("bootout");
      expect(existsSync(join(t.dir, "com.vlad.approver.plist"))).toBe(false);
      await inst.uninstall();
    } finally { t.cleanup(); }
  });
  it("status: kurulu/çalışıyor ayrımı", async () => {
    const t = mk();
    try {
      const inst = createLaunchdInstaller({ launchctl: t.launchctl, plistDir: t.dir });
      expect((await inst.status()).installed).toBe(false);
      await inst.install(ctx);
      t.results.print = { code: 0, stdout: "state = running\n" };
      expect(await inst.status()).toMatchObject({ installed: true, running: true });
      t.results.print = { code: 113 };
      expect(await inst.status()).toMatchObject({ installed: true, running: false });
      expect(readFileSync(join(t.dir, "com.vlad.approver.plist"), "utf8")).toContain("com.vlad.approver");
    } finally { t.cleanup(); }
  });
});
