import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, sandbox, stub, type Sandbox } from "./helpers.js";

/** launchctl: bootstrap durum dosyasına yazar, list ona göre yanıtlar. */
function fake(s: Sandbox) {
  const state = join(s.root, "loaded-main");
  stub(s, "launchctl", `case "$1" in bootstrap) case "$*" in *com.vlad.main*) touch "${state}";; esac;; list) [ -f "${state}" ] && echo "1 0 com.vlad.main"; true;; esac`);
  stub(s, "tmux"); stub(s, "vlad"); stub(s, "claude"); stub(s, "sudo"); stub(s, "pmset", 'echo " sleep 1"');
  mkdirSync(join(s.home, "dev", "vlad", "dist"), { recursive: true });
  return { env: { VLAD_REPO_DIR: join(s.home, "dev", "vlad") } };
}
const calls = (s: Sandbox) => readFileSync(s.log, "utf8");

describe("mac/setup.sh", () => {
  it("varsayılan --dry-run: planı basar, hiçbir şey yazmaz ya da çağırmaz", () => {
    const s = sandbox(); const { env } = fake(s);
    const r = run("setup.sh", [], s, env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[dry-run]");
    expect(r.stdout).toContain("com.vlad.main.plist");
    expect(existsSync(join(s.home, "Library", "LaunchAgents", "com.vlad.main.plist"))).toBe(false);
    expect(calls(s)).not.toMatch(/bootstrap|agent install|sudo/);
  });
  it("--apply: sarmalayıcı betik + plist yazar, launchctl bootstrap eder, agent plist yoksa vlad agent install --apply çağırır", () => {
    const s = sandbox(); const { env } = fake(s);
    const r = run("setup.sh", ["--apply"], s, env);
    expect(r.status).toBe(0);
    const wrap = join(s.home, ".vlad-agent", "main-session.sh");
    expect(statSync(wrap).mode & 0o111).not.toBe(0);
    expect(readFileSync(wrap, "utf8")).toMatch(/tmux has-session -t vlad .*\|\| .*tmux new-session -d -s vlad/s);
    const plist = readFileSync(join(s.home, "Library", "LaunchAgents", "com.vlad.main.plist"), "utf8");
    expect(plist).toContain("<key>Label</key><string>com.vlad.main</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).not.toContain("<key>KeepAlive</key>"); // tmux -d hemen döner; KeepAlive sonsuz yeniden başlatır
    expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
    expect(calls(s)).toMatch(/launchctl bootstrap gui\/\d+ .*com\.vlad\.main\.plist/);
    expect(calls(s)).toContain("vlad agent install --apply");
  });
  it("idempotent: ikinci --apply değişiklik yapmaz, tekrar bootstrap etmez", () => {
    const s = sandbox(); const { env } = fake(s);
    run("setup.sh", ["--apply"], s, env);
    writeFileSync(s.log, ""); // sayaç sıfırla
    mkdirSync(join(s.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(s.home, "Library", "LaunchAgents", "com.vlad.agent.plist"), "x"); // agent kurulu
    const r2 = run("setup.sh", ["--apply"], s, env);
    expect(r2.status).toBe(0);
    expect(calls(s)).not.toMatch(/bootstrap|agent install/);
    expect(r2.stdout).toContain("zaten güncel");
  });
  it("sudo gerektiren adımları (pmset) yalnız kullanıcı adımı olarak basar, kendisi çalıştırmaz", () => {
    const s = sandbox(); const { env } = fake(s);
    const r = run("setup.sh", ["--apply"], s, env);
    expect(r.stdout).toContain("KULLANICI ADIMI");
    expect(r.stdout).toContain("sudo pmset -a sleep 0");
    expect(calls(s)).not.toMatch(/^(sudo|pmset .*-a)/m);
  });
  it("macOS değilse reddeder; bilinmeyen bayrak 2 ile biter", () => {
    const s = sandbox(); const { env } = fake(s);
    const r = run("setup.sh", ["--apply"], s, { ...env, VLAD_UNAME: "Linux" });
    expect(r.status).toBe(1); expect(r.stderr).toContain("macOS");
    expect(run("setup.sh", ["--x"], s, env).status).toBe(2);
  });
  it("VLAD_MAIN_CMD satır sonu içeremez", () => {
    const s = sandbox(); const { env } = fake(s);
    const r = run("setup.sh", ["--apply"], s, { ...env, VLAD_MAIN_CMD: "claude\nrm -rf x" });
    expect(r.status).toBe(1);
    expect(existsSync(join(s.home, ".vlad-agent", "main-session.sh"))).toBe(false);
  });
});
