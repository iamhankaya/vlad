import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, sandbox, stub, type Sandbox } from "./helpers.js";

const KEY = "a".repeat(64);

/** Tam kurulu sahte Mac. */
function fullMac(s: Sandbox) {
  stub(s, "claude", 'echo "2.1.0 (Claude Code)"');
  stub(s, "node", 'echo "v22.23.4"');
  stub(s, "git", 'case "$*" in *"remote get-url"*) echo "git@github.com:iamhankaya/vlad-kb.git";; *"rev-parse"*) echo true;; esac');
  stub(s, "tmux", 'case "$1" in has-session) exit 0;; esac');
  stub(s, "gh"); stub(s, "vlad");
  stub(s, "launchctl", 'echo "123 0 com.vlad.agent"; echo "- 0 com.vlad.main"');
  stub(s, "pmset", 'echo " sleep                0"; echo " womp                 1"');
  stub(s, "lsof", 'echo "node 1 u IPv4 TCP *:7437 (LISTEN)"');
  stub(s, "id", 'case "$1" in -Gn) echo "staff";; esac');
  mkdirSync(join(s.home, "ci", "actions-runner"), { recursive: true }); writeFileSync(join(s.home, "ci", "actions-runner", ".runner"), "{}");
  s.env.VLAD_CI_HOME = join(s.home, "ci");
  const repo = join(s.home, "dev", "vlad"); mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "dist", "cli.js"), "");
  writeFileSync(join(repo, "vlad.local.json"), JSON.stringify({ self: "mac", keys: { mac: KEY, windows: KEY } }));
  mkdirSync(join(s.home, "dev", "vlad-kb"), { recursive: true });
  const la = join(s.home, "Library", "LaunchAgents"); mkdirSync(la, { recursive: true });
  writeFileSync(join(la, "com.vlad.agent.plist"), "x"); writeFileSync(join(la, "com.vlad.main.plist"), "x");
}

describe("mac/audit.sh", () => {
  it("her madde için durum ve kanıt satırı üretir, tam kurulu Mac'te eksik yok", () => {
    const s = sandbox(); fullMac(s);
    const r = run("audit.sh", ["--json"], s);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ madde: string; durum: string; kanit: string }>;
    const by = Object.fromEntries(rows.map((x) => [x.madde, x]));
    for (const m of ["claude", "node", "git", "tmux", "gh", "vlad-cli", "vlad-repo", "vlad-kb", "agent-keys", "agent-launchd", "agent-port", "main-session", "sleep", "remote-control", "ci-user", "ci-runner"]) expect(by[m], m).toBeDefined();
    expect(rows.filter((x) => x.durum === "eksik")).toEqual([]);
    expect(by["remote-control"].durum).toBe("manuel");
    expect(by["agent-keys"].kanit).toContain("mac");
  });
  it("anahtar değerlerini hiçbir çıktıya yazmaz", () => {
    const s = sandbox(); fullMac(s);
    const r = run("audit.sh", [], s);
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
  it("boş HOME'da eksikleri işaretler; --strict çıkış kodu 1", () => {
    const s = sandbox(); stub(s, "pmset", 'echo " sleep                1"'); stub(s, "launchctl", "exit 0");
    const j = run("audit.sh", ["--json"], s);
    expect(j.status).toBe(0);
    const rows = JSON.parse(j.stdout) as Array<{ madde: string; durum: string }>;
    const by = Object.fromEntries(rows.map((x) => [x.madde, x.durum]));
    expect(by["claude"]).toBe("eksik"); expect(by["vlad-repo"]).toBe("eksik"); expect(by["agent-keys"]).toBe("eksik"); expect(by["sleep"]).toBe("eksik"); expect(by["main-session"]).toBe("eksik");
    expect(run("audit.sh", ["--strict"], s).status).toBe(1);
  });
  it("node 22'den eski ise eksik sayar", () => {
    const s = sandbox(); fullMac(s); stub(s, "node", 'echo "v20.1.0"');
    const rows = JSON.parse(run("audit.sh", ["--json"], s).stdout) as Array<{ madde: string; durum: string }>;
    expect(rows.find((x) => x.madde === "node")?.durum).toBe("eksik");
  });
  it("yalnız okur: sahte komutlara yazma çağrısı yapmaz", () => {
    const s = sandbox(); fullMac(s); run("audit.sh", [], s);
    const calls = readFileSync(s.log, "utf8") as string;
    expect(calls).not.toMatch(/bootstrap|load |kickstart|new-session|install|--apply/);
  });
});
