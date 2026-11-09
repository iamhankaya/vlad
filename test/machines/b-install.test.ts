import { describe, expect, it } from "vitest";
import { installPlan, launchdPlist, schtasksArgs, stableNodePath } from "../../src/agent/install.js";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLog } from "../../src/agent/start.js";

describe("machines:B agent install (print-only)", () => {
  it("launchd plist keeps the Agent alive and does not kill tmux workers when it restarts", () => {
    const x = launchdPlist({ node: "/usr/local/bin/node", cli: "/Users/me/vlad/dist/cli.js", home: "/Users/me/vlad", path: "/usr/local/bin:/opt/homebrew/bin:/usr/bin" });
    expect(x).toContain("<key>Label</key><string>com.vlad.agent</string>");
    expect(x).toContain("<key>RunAtLoad</key><true/>");
    expect(x).toContain("<key>KeepAlive</key><true/>");
    expect(x).toContain("<key>AbandonProcessGroup</key><true/>");
    expect(x).toContain("<string>/usr/local/bin/node</string><string>/Users/me/vlad/dist/cli.js</string><string>agent</string><string>start</string>");
    expect(x).toContain("<key>VLAD_HOME</key><string>/Users/me/vlad</string>");
    expect(x).toContain("<key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin</string>");
  });
  it("plist escapes XML metacharacters in paths", () => {
    expect(launchdPlist({ node: "/n", cli: "/a&b/<c>.js", home: "/h", path: "/p" })).toContain("/a&amp;b/&lt;c&gt;.js");
  });
  it("Windows task runs at logon in the interactive session (/it) with limited rights", () => {
    const a = schtasksArgs({ node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\dev\\vlad\\dist\\cli.js", home: "C:\\dev\\vlad" });
    expect(a.slice(0, 2)).toEqual(["/create", "/tn"]);
    expect(a).toEqual(expect.arrayContaining(["VladAgent", "/sc", "onlogon", "/it", "/rl", "limited", "/f"]));
    expect(a[a.indexOf("/tr") + 1]).toBe('"C:\\dev\\vlad\\.vlad-agent\\agent-start.cmd"'); // VLAD_HOME'u betik sabitler (e3-codex3)
  });
  it("installPlan prints by the machine's os and never applies by itself", () => {
    const w = installPlan("win32", { node: "n.exe", cli: "c.js", home: "h", path: "p" });
    expect(w.command).toMatch(/^schtasks \/create /);
    expect(typeof w.apply).toBe("function"); // yalnız --apply çağırır; planı üretmek hiçbir şeyi çalıştırmaz
    const m = installPlan("darwin", { node: "n", cli: "c.js", home: "/h", path: "p" });
    expect(m.file).toMatch(/Library[\\/]LaunchAgents[\\/]com\.vlad\.agent\.plist$/);
    expect(m.content).toContain("AbandonProcessGroup");
    expect(() => installPlan("linux", { node: "n", cli: "c", home: "h", path: "p" })).toThrow(/desteklenmiyor/);
  });
});

describe("install girdi doğrulaması ve log rotasyonu (F-vlad-153)", () => {
  it.each(['a"b', "a\nb", "a\rb"])("win32: %j içeren yolu reddeder", (bad) => {
    for (const k of ["home", "node", "cli"] as const) {
      expect(() => installPlan("win32", { node: "n.exe", cli: "c.js", home: "h", path: "p", [k]: bad })).toThrow(/çift tırnak ya da satır sonu/);
    }
  });
  it("rotateLog büyük günlüğü .1'e kopyalayıp keser, küçüğe dokunmaz", () => {
    const d = mkdtempSync(join(tmpdir(), "vlad-rot-"));
    const f = join(d, "agent.log");
    writeFileSync(f, "x".repeat(50));
    rotateLog(f, 100);
    expect(readFileSync(f, "utf8")).toHaveLength(50);
    rotateLog(f, 10);
    expect(readFileSync(f, "utf8")).toBe("");
    expect(readFileSync(`${f}.1`, "utf8")).toHaveLength(50);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("agent install sertleştirme (T20261109-26)", () => {
  it("F-vlad-158: win32 agent-start.cmd node/cli yollarındaki % karakterini kaçırır", () => {
    const p = installPlan("win32", { node: "C:\\a%PATH%\\node.exe", cli: "C:\\b%X%\\cli.js", home: "C:\\h", path: "p" });
    expect(p.content).toContain('"C:\\a%%PATH%%\\node.exe" "C:\\b%%X%%\\cli.js"');
  });
  it("F-vlad-194: Homebrew Cellar sürümlü yolu kararlı opt yoluna çevrilir (yoksa dokunmaz)", () => {
    const cellar = "/opt/homebrew/Cellar/node@22/22.23.4_2/bin/node";
    expect(stableNodePath(cellar, () => true)).toBe("/opt/homebrew/opt/node@22/bin/node");
    expect(stableNodePath(cellar, () => false)).toBe(cellar);
    expect(stableNodePath("/usr/local/bin/node", () => true)).toBe("/usr/local/bin/node");
  });
  it("F-vlad-159: rotateLog .1 symlink'ini izlemez ve yedeği 0600 yapar", () => {
    const d = mkdtempSync(join(tmpdir(), "vlad-rot-"));
    const f = join(d, "agent.log"), victim = join(d, "victim.txt");
    writeFileSync(f, "x".repeat(50)); writeFileSync(victim, "KEEP");
    symlinkSync(victim, `${f}.1`);
    rotateLog(f, 10);
    expect(readFileSync(victim, "utf8")).toBe("KEEP");
    expect(lstatSync(`${f}.1`).isSymbolicLink()).toBe(false);
    expect(readFileSync(`${f}.1`, "utf8")).toHaveLength(50);
    if (process.platform !== "win32") expect(lstatSync(`${f}.1`).mode & 0o777).toBe(0o600);
    rmSync(d, { recursive: true, force: true });
  });
});
