import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const deploy = join(root, "deploy");
const unit = (n: string) => readFileSync(join(deploy, "systemd", n), "utf8");
const settings = JSON.parse(readFileSync(join(deploy, "claude", "worker-settings.json"), "utf8")) as { permissions: { allow: string[]; deny: string[] } };

/** Claude permission rule `Bash(<glob>)`: `*` matches anything. Deny wins over allow. */
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s");
const bashRules = (rules: string[]) => rules.filter((r) => r.startsWith("Bash(")).map((r) => globRe(r.slice(5, -1)));
const verdict = (cmd: string): "deny" | "allow" | "ask" => {
  if (bashRules(settings.permissions.deny).some((r) => r.test(cmd))) return "deny";
  return bashRules(settings.permissions.allow).some((r) => r.test(cmd)) ? "allow" : "ask";
};

describe("deploy: worker push rules (F-vlad-030)", () => {
  it("deploy: worker may push only its vlad/* branch", () => {
    expect(verdict("git push origin vlad/T20261025-92")).toBe("allow");
    expect(verdict("git push -u origin vlad/T20261025-92")).toBe("allow");
  });
  it.each([
    "git push origin main", "git push origin master", "git push origin HEAD:main", "git push origin vlad/T20261025-92:main",
    "git push origin vlad/T20261025-92:refs/heads/main", "git push origin vlad/T20261025-92:refs/heads/master",
    "git push --force origin vlad/T20261025-92", "git push -f origin vlad/T20261025-92", "git push origin +vlad/T20261025-92",
    "git push origin vlad/T20261025-92 main", "git -C /srv/wt push origin main", "git -C /srv/wt push origin vlad/T20261025-92",
    "git push --force-with-lease origin vlad/x", "gh pr merge 5", "gh api repos/o/r/git/refs -X POST",
    // review S14a bulgu 3: suffixes after an allowed prefix
    "git push origin vlad/T20261025-92:main -q", "git push origin vlad/T20261025-92 HEAD:main --no-verify", "git push origin vlad/T20261025-92 --delete main",
    "git push origin vlad/T20261025-92 --delete other", "git push origin vlad/T20261025-92 -d x", "git push origin vlad/T20261025-92 --mirror",
    "git push origin vlad/T20261025-92 --all", "git push origin vlad/T20261025-92 -o ci.skip", "git push origin vlad/T20261025-92 && git push origin HEAD:main",
    "git push origin vlad/T20261025-92; git push origin x:refs/heads/main", "git push origin vlad/T20261025-92 $(echo :main)", "git push -f origin vlad/T20261025-92",
  ])("deploy: worker push/merge denied: %s", (cmd) => {
    expect(verdict(cmd)).toBe("deny");
  });
  it("deploy: nothing allows a bare push, gh, curl or wget", () => {
    for (const r of settings.permissions.allow) expect(r).not.toMatch(/^Bash\((git push\*|gh |curl|wget|\*)/);
    expect(verdict("git push")).not.toBe("allow");
    expect(verdict("curl https://example.invalid")).toBe("deny");
  });
  it("deploy: the enforcer is the ruleset, the runbook says no dev worker before doctor + canary", () => {
    const rb = readFileSync(join(deploy, "RUNBOOK.md"), "utf8");
    expect(rb).toMatch(/doctor.*canary.*dev çalışan|dev çalışan.*doctor.*canary/s);
  });
  it("deploy: no skip-permissions flag anywhere in deploy/", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(deploy)) expect(readFileSync(f, "utf8"), f).not.toMatch(/dangerously-skip-permissions|bypassPermissions/);
  });
});

describe("deploy: systemd units", () => {
  const files = readdirSync(join(deploy, "systemd"));
  it("deploy: every template placeholder is one install.sh fills", () => {
    for (const f of files) for (const m of unit(f).matchAll(/@[A-Z_]+@/g)) expect(["@KB_DIR@", "@VLAD_HOME@"], `${f} ${m[0]}`).toContain(m[0]);
  });
  it("deploy: vlad-kbsync and vlad-kbpromote units carry @KB_DIR@ (F-vlad-037)", () => {
    expect(unit("vlad-kbsync.service")).toContain("@KB_DIR@");
    expect(unit("vlad-kbpromote.service")).toContain("@KB_DIR@");
  });
  it("deploy: chat unit runs as vladchat in a sandbox with a read-only kb and no API state (F-vlad-024)", () => {
    const u = unit("vlad-chat@.service");
    expect(u).toMatch(/^User=vladchat$/m);
    for (const d of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "CapabilityBoundingSet=", "RuntimeMaxSec=", "KillMode=control-group"]) expect(u).toContain(d);
    expect(u).toMatch(/^ReadOnlyPaths=@KB_DIR@ @VLAD_HOME@$/m);
    expect(u).toMatch(/^InaccessiblePaths=.*\/var\/lib\/vladapi/m);
    expect(u).not.toMatch(/^ReadWritePaths=.*@KB_DIR@/m);
    expect(u).not.toMatch(/^User=(vlad|vladapi|root)$/m);
  });
  it("deploy: chat unit limits network and cannot run what the agent writes (review S14a bulgu 1-2)", () => {
    const u = unit("vlad-chat@.service");
    expect(u).toMatch(/^IPAddressDeny=.*localhost.*link-local.*100\.64\.0\.0\/10.*169\.254\.0\.0\/16/m);
    expect(u).toMatch(/^RestrictAddressFamilies=AF_INET AF_INET6$/m);
    expect(u).toMatch(/^InaccessiblePaths=.*-\/run\/tailscale.*-\/run\/dbus/m);
    expect(u).toMatch(/^NoExecPaths=\/var\/lib\/vladchat$/m);
    expect(u).toMatch(/^ExecPaths=\/usr \/opt \/usr\/local$/m);
    expect(u).toMatch(/^ReadOnlyPaths=.*\/var\/lib\/vladchat\/\.claude\/settings\.json.*\/var\/lib\/vladchat\/CLAUDE\.md/m);
    expect(u).not.toMatch(/SupplementaryGroups=vlad/m);
  });
  it("deploy: kbpromote carries the api hardening block and no readable home (review S14a bulgu 8)", () => {
    const u = unit("vlad-kbpromote.service");
    for (const d of ["CapabilityBoundingSet=", "RestrictAddressFamilies=AF_INET AF_INET6", "SystemCallFilter=@system-service", "RestrictNamespaces=yes", "ProtectKernelModules=yes", "LockPersonality=yes", "ProtectHome=yes"]) expect(u).toContain(d);
    expect(u).not.toContain("ProtectHome=read-only");
  });
  it("deploy: only vladapi may connect to the chat socket", () => {
    const s = unit("vlad-chat.socket");
    expect(s).toMatch(/^SocketUser=vladapi$/m);
    expect(s).toMatch(/^SocketMode=0600$/m);
    expect(s).toMatch(/^Accept=yes$/m);
  });
  it("deploy: api unit is loopback-only, sandboxed, and cannot write the code tree (F-vlad-037)", () => {
    const u = unit("vlad-api.service");
    expect(u).toMatch(/^User=vladapi$/m);
    expect(u).toContain("NoNewPrivileges=yes");
    const rw = /^ReadWritePaths=(.*)$/m.exec(u)?.[1] ?? "";
    expect(rw).not.toContain("@VLAD_HOME@");
    expect(rw).toContain("/var/lib/vladapi");
  });
  it("deploy: no unit runs as root", () => {
    for (const f of files.filter((n) => n.endsWith(".service"))) expect(unit(f), f).toMatch(/^User=(vlad|vladapi|vladchat)$/m);
  });
});

describe("deploy: install.sh dry run", () => {
  const run = () => spawnSync("bash", [join(deploy, "install.sh")], {
    env: { PATH: process.env.PATH, VLAD_INSTALL_DRYRUN: "1", CLAUDE_CODE_VERSION: "1.2.3" }, encoding: "utf8",
  });
  it("deploy: dry run changes nothing and plans users, root-owned code, units, linger, audit", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    for (const need of [
      "groupadd --system vladchat", "useradd --system --gid vladchat", "loginctl enable-linger vlad", "chown -h root:root", "go-w",
      "install -d -m 0700 -o vlad -g vlad /opt/vlad/state", "npm audit", "npm ci", "unit vlad-kbpromote.service", "unit vlad-kbsync.service", "unit vlad-chat@.service",
      "gen-chat-settings.ts", "@anthropic-ai/claude-code@1.2.3",
      "npm install -g --ignore-scripts", "npm audit --package-lock-only", "setfacl -R -m u:vladchat:rX", "chmod 0700 /home/vlad",
      "empty root-owned /var/lib/vladchat/.claude/settings.json",
    ]) expect(r.stdout, need).toContain(need);
    expect(r.stdout).not.toMatch(/usermod -aG vlad vladchat/);
    expect(r.stdout).not.toMatch(/chown -R root:root \/opt\/vlad/); // state/ stays vlad's on a second run
    expect(r.stdout).not.toMatch(/usermod -aG vladapi vlad|usermod -aG vladchat vlad/); // the agent user joins no gate group
  });
  it("deploy: refuses without a pinned claude version", () => {
    const r = spawnSync("bash", [join(deploy, "install.sh")], { env: { PATH: process.env.PATH, VLAD_INSTALL_DRYRUN: "1" }, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("CLAUDE_CODE_VERSION");
  });
  it("deploy: scripts are executable", () => {
    for (const f of ["install.sh", "bin/vlad-chat-turn", "bin/vlad-chat-client"]) expect(statSync(join(deploy, f)).mode & 0o111, f).not.toBe(0);
  });
});

describe("deploy: chat-turn wrapper (runs without claude; only the guards)", () => {
  const turn = join(deploy, "bin", "vlad-chat-turn");
  const go = (input: string, env: Record<string, string> = {}) => spawnSync("bash", [turn], { input, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  it("deploy: chat-turn rejects a bad header and a bad session id", () => {
    expect(go("EVIL --dangerously-skip-permissions\nhi").status).toBe(64);
    expect(go("RESUME -x\nhi").status).toBe(64);
    expect(go("RESUME abc;rm -rf /\nhi").status).toBe(64);
  });
  it("deploy: chat-turn refuses to run without the root-owned settings", () => {
    expect(go("NEW\nhi", { VLAD_CHAT_SETTINGS: "/nonexistent/chat-settings.json" }).status).toBe(78);
  });
  it("deploy: chat-turn runs claude in dontAsk mode with hooks off (review S14a bulgu 1-2)", () => {
    const t = readFileSync(turn, "utf8");
    expect(t).toContain("--permission-mode dontAsk");
    expect(t).not.toMatch(/--permission-mode (auto|acceptEdits|bypassPermissions)/);
    expect(t).toContain("disableAllHooks");
  });
  it("deploy: chat-turn refuses settings without disableAllHooks", () => {
    const f = join(mkdtempSync(join(tmpdir(), "chat-set-")), "s.json");
    writeFileSync(f, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));
    expect(go("NEW\nhi", { VLAD_CHAT_SETTINGS: f }).status).toBe(78);
  });
  it("deploy: chat-client forwards only a valid --resume id", () => {
    const client = join(deploy, "bin", "vlad-chat-client");
    const r = spawnSync("bash", [client, "-p", "--resume", "bad id;x"], { input: "hi", encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(r.status).toBe(64);
    const none = spawnSync("bash", [client, "-p"], { input: "hi", encoding: "utf8", env: { PATH: process.env.PATH, VLAD_CHAT_SOCKET: "/nonexistent/x.sock" } });
    expect(none.status).toBe(69);
  });
});

describe("deploy: public repo hygiene", () => {
  it("deploy: no secrets, IPs or real hostnames in deploy/", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of [...walk(deploy), ...(existsSync(join(root, "RUNBOOK.md")) ? [join(root, "RUNBOOK.md")] : [])]) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(t, f).not.toMatch(/\b(ghp_|github_pat_|gho_|ghs_|sk-ant-|AKIA|AIza)[A-Za-z0-9_-]{8,}/);
      expect(t, f).not.toMatch(/\b(?!127\.0\.0\.1|0\.0\.0\.0|127\.0\.0\.53|169\.254\.169\.254)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?!\/\d)/);
      expect(t, f).not.toMatch(/\.ts\.net\b|\.compute\.amazonaws\.com|\.tailscale\.com\/[a-z]+\/[a-z0-9]{10}/);
    }
  });
});
