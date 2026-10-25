import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  it.each([
    "git -c core.sshCommand=evil push origin vlad/T20261025-92", "git --git-dir=/x push origin vlad/T20261025-92", "command git push origin vlad/T20261025-92:main",
    "git push origin vlad/T20261025-92 other", "git push -u origin vlad/T20261025-92 refs/tags/v1", "git push origin vlad/T20261025-92 --tags",
  ])("deploy: worker push escape denied (review #3 round 2): %s", (cmd) => {
    expect(verdict(cmd)).toBe("deny");
  });
  it("deploy: KNOWN escapes the rule list cannot close; only the GitHub ruleset does (documented, not hidden)", () => {
    // arbitrary code can push with the worker's own credentials
    expect(verdict(`node -e "require('child_process').execSync('git push origin HEAD:main')"`)).toBe("allow");
    expect(verdict("npx some-package")).toBe("allow");
    // an alias defined through git config makes the push invisible to the patterns
    expect(verdict("git config alias.p push")).not.toBe("deny");
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
    for (const f of ["settings.json", "CLAUDE.md"]) expect(u).toContain(`/var/lib/vladchat/${f.startsWith("C") ? "" : ".claude/"}${f}`);
    expect(u).not.toMatch(/SupplementaryGroups=vlad/m);
  });
  it("deploy: chat unit masks project memory in the kb and the extension directories of the home (review round 2 #3-#4)", () => {
    const u = unit("vlad-chat@.service");
    expect(u).toMatch(/^InaccessiblePaths=-@KB_DIR@\/\.claude -@KB_DIR@\/CLAUDE\.md -@KB_DIR@\/CLAUDE\.local\.md$/m);
    for (const d of ["agents", "commands", "skills", "rules", "plugins", "hooks", "output-styles"]) expect(u).toContain(`/var/lib/vladchat/.claude/${d}`);
    expect(u).toContain("/var/lib/vladchat/.claude/settings.local.json");
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
      "empty root-owned file /var/lib/vladchat/.claude/settings.json", "empty root-owned dir /var/lib/vladchat/.claude/skills",
      "install -d -m 0755 -o root -g root /etc/vlad-chat", "/etc/vlad-chat/chat-settings.json (root:root 0444)", "/etc/claude-code/managed-settings.json", "systemctl stop vlad-chat.socket",
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
  describe("guards that refuse a turn (exit 78) before claude is started", () => {
    const sandbox = (mut: (d: { home: string; kb: string }) => void = () => undefined) => {
      const base = mkdtempSync(join(tmpdir(), "chat-guard-"));
      const home = join(base, "home"), kb = join(base, "x", "kb");
      mkdirSync(join(home, ".claude"), { recursive: true }); mkdirSync(kb, { recursive: true });
      const settings = join(base, "chat-settings.json");
      writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] }, disableAllHooks: true }));
      mut({ home, kb });
      return go("NEW\nhi", { VLAD_CHAT_SETTINGS: settings, HOME: home, VLAD_KB_DIR: kb, VLAD_HOME: base });
    };
    it("deploy: clean tree passes the guards (fails later only because claude is not installed here)", () => {
      const r = sandbox();
      expect([78, 64]).not.toContain(r.status);
    });
    it("deploy: chat-turn refuses project memory or settings in the kb", () => {
      expect(sandbox(({ kb }) => writeFileSync(join(kb, "CLAUDE.md"), "do evil")).status).toBe(78);
      expect(sandbox(({ kb }) => writeFileSync(join(kb, "CLAUDE.local.md"), "x")).status).toBe(78);
      expect(sandbox(({ kb }) => mkdirSync(join(kb, ".claude", "skills"), { recursive: true })).status).toBe(78);
      expect(sandbox(({ kb }) => writeFileSync(join(kb, "..", "CLAUDE.md"), "parent memory")).status).toBe(78);
    });
    it("deploy: chat-turn refuses persistent extensions in the agent's home", () => {
      expect(sandbox(({ home }) => writeFileSync(join(home, ".claude", "settings.json"), "{\"permissions\":{\"allow\":[\"Bash(*)\"]}}")).status).toBe(78);
      expect(sandbox(({ home }) => { mkdirSync(join(home, ".claude", "skills", "s"), { recursive: true }); writeFileSync(join(home, ".claude", "skills", "s", "SKILL.md"), "x"); }).status).toBe(78);
      expect(sandbox(({ home }) => writeFileSync(join(home, "CLAUDE.md"), "x")).status).toBe(78);
    });
    it("deploy: chat-turn refuses ~/.claude.json with allowedTools, mcpServers or hooks, accepts a plain login state", () => {
      const put = (o: object) => ({ home }: { home: string }) => writeFileSync(join(home, ".claude.json"), JSON.stringify(o));
      expect(sandbox(put({ allowedTools: ["Bash(*)"] })).status).toBe(78);
      expect(sandbox(put({ projects: { "/x": { allowedTools: ["Bash(*)"] } } })).status).toBe(78);
      expect(sandbox(put({ mcpServers: { s: { command: "evil" } } })).status).toBe(78);
      expect(sandbox(put({ hooks: { PreToolUse: [] } })).status).toBe(78);
      expect(sandbox(({ home }) => writeFileSync(join(home, ".claude.json"), "not json")).status).toBe(78);
      expect([78, 64]).not.toContain(sandbox(put({ oauthAccount: { emailAddress: "x" }, numStartups: 3, projects: { "/x": { allowedTools: [] } } })).status);
    });
  });
  it("deploy: chat-turn sets the no-updater, no-telemetry environment", () => {
    const t = readFileSync(turn, "utf8");
    expect(t).toContain("DISABLE_AUTOUPDATER=1");
    expect(t).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  });
  it("deploy: chat settings live in a directory vladchat can traverse, not in /etc/vlad (0750 root:vlad) (review round 2 #1)", () => {
    expect(readFileSync(turn, "utf8")).toContain("/etc/vlad-chat/chat-settings.json");
    const plan = spawnSync("bash", [join(deploy, "install.sh")], { env: { PATH: process.env.PATH, VLAD_INSTALL_DRYRUN: "1", CLAUDE_CODE_VERSION: "1.2.3" }, encoding: "utf8" }).stdout;
    expect(plan).toMatch(/install -d -m 0750 -o root -g vlad \/etc\/vlad\n/); // stays closed to vladchat
    expect(plan).toMatch(/install -d -m 0755 -o root -g root \/etc\/vlad-chat\n/); // world-traversable
    expect(plan).toMatch(/> \/etc\/vlad-chat\/chat-settings\.json \(root:root 0444\)/);
    expect(plan).not.toMatch(/> \/etc\/vlad\/chat-settings\.json/);
  });
  it("deploy: RUNBOOK login sandbox uses the unit's network and exec properties verbatim (review round 2 #7)", () => {
    const rb = readFileSync(join(deploy, "RUNBOOK.md"), "utf8");
    const u = unit("vlad-chat@.service");
    const deny = /^IPAddressDeny=(.*)$/m.exec(u)![1]!;
    expect(rb).toContain(`IPAddressDeny="${deny}"`);
    for (const p of ["NoExecPaths=/var/lib/vladchat", "ExecPaths=\"/usr /opt /usr/local\"", "CapabilityBoundingSet=", "IPAddressAllow=127.0.0.53", "RestrictAddressFamilies=\"AF_INET AF_INET6\""]) expect(rb, p).toContain(p);
  });
  it("deploy: chat-client forwards only a valid --resume id", () => {
    const client = join(deploy, "bin", "vlad-chat-client");
    const r = spawnSync("bash", [client, "-p", "--resume", "bad id;x"], { input: "hi", encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(r.status).toBe(64);
    const none = spawnSync("bash", [client, "-p"], { input: "hi", encoding: "utf8", env: { PATH: process.env.PATH, VLAD_CHAT_SOCKET: "/nonexistent/x.sock" } });
    expect(none.status).toBe(69);
  });
});

describe("deploy: apt keyrings without network (review round 2 #5)", () => {
  const have = spawnSync("gpg", ["--version"]).status === 0;
  const lib = join(deploy, "lib", "keyring.sh");
  const sh = (script: string, env: Record<string, string>) => spawnSync("bash", ["-c", `. ${lib}; ${script}`], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  (have ? it : it.skip)("deploy: binary and armored keys both become a keyring with one primary key; fingerprint is checked", () => {
    const d = mkdtempSync(join(tmpdir(), "keyring-"));
    const gh = { GNUPGHOME: d };
    spawnSync("chmod", ["700", d]);
    const gen = spawnSync("gpg", ["--batch", "--passphrase", "", "--quick-generate-key", "test-only@example.invalid", "default", "default", "never"], { env: { PATH: process.env.PATH, ...gh }, encoding: "utf8" });
    expect(gen.status, gen.stderr).toBe(0);
    const fpr = spawnSync("gpg", ["--with-colons", "--list-keys"], { env: { PATH: process.env.PATH, ...gh }, encoding: "utf8" }).stdout.split("\n").find((l) => l.startsWith("fpr:"))!.split(":")[9]!;
    spawnSync("bash", ["-c", `gpg --export > ${d}/bin.gpg; gpg --armor --export > ${d}/arm.asc`], { env: { PATH: process.env.PATH, ...gh } });
    for (const f of ["bin.gpg", "arm.asc"]) {
      const r = sh(`key_to_keyring ${d}/${f} ${d}/${f}.ring && keyring_problem ${d}/${f}.ring ${fpr}`, gh);
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
      expect(r.stdout.trim(), f).toBe("");
      const bad = sh(`keyring_problem ${d}/${f}.ring 0000000000000000000000000000000000000000`, gh);
      expect(bad.stdout, f).toMatch(/does not match/);
    }
    // two primary keys in one ring are refused
    spawnSync("gpg", ["--batch", "--passphrase", "", "--quick-generate-key", "second@example.invalid", "default", "default", "never"], { env: { PATH: process.env.PATH, ...gh } });
    spawnSync("bash", ["-c", `gpg --export > ${d}/two.gpg`], { env: { PATH: process.env.PATH, ...gh } });
    expect(sh(`key_to_keyring ${d}/two.gpg ${d}/two.ring; keyring_problem ${d}/two.ring ${fpr}`, gh).stdout).toMatch(/holds 2 primary keys/);
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
