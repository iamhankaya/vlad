import { describe, expect, it } from "vitest";
import { installPlan, launchdPlist, schtasksArgs } from "../../src/agent/install.js";

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
    const a = schtasksArgs({ node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\dev\\vlad\\dist\\cli.js" });
    expect(a.slice(0, 2)).toEqual(["/create", "/tn"]);
    expect(a).toEqual(expect.arrayContaining(["VladAgent", "/sc", "onlogon", "/it", "/rl", "limited", "/f"]));
    expect(a[a.indexOf("/tr") + 1]).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\dev\\vlad\\dist\\cli.js" agent start');
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
