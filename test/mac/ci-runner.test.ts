import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, sandbox, stub, type Sandbox } from "./helpers.js";

const URL = "https://github.com/iamhankaya/medialog";
const TOKEN = "AAAATESTTOKEN123";

/** Sahte runner tarball'u: config.sh ve svc.sh yalnız çağrıyı kaydeder. */
function fixture(s: Sandbox) {
  const src = join(s.root, "pkg"); mkdirSync(src);
  for (const f of ["config.sh", "svc.sh"]) {
    writeFileSync(join(src, f), `#!/bin/bash\necho "${f} $*" >> "$VLAD_CALL_LOG"\n${f === "config.sh" ? 'echo "{}" > "$(dirname "$0")/.runner"' : '[ "$1" = install ] && touch "$(dirname "$0")/.service"'}\nexit 0\n`);
    chmodSync(join(src, f), 0o755);
  }
  const tgz = join(s.root, "runner.tar.gz");
  execFileSync("tar", ["czf", tgz, "-C", src, "."]);
  const sha = execFileSync("shasum", ["-a", "256", tgz], { encoding: "utf8" }).split(" ")[0];
  stub(s, "curl", `while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; cp "${tgz}" "$out"`);
  stub(s, "xcode-select", 'echo /Applications/Xcode.app/Contents/Developer');
  stub(s, "id", 'case "$1" in -un) echo vlad-ci;; -Gn) echo staff;; -u) echo 502;; *) echo vlad-ci;; esac');
  const dir = join(s.home, "actions-runner");
  const base = ["--repo-url", URL, "--version", "2.329.0", "--sha256", sha, "--dir", dir];
  return { sha, dir, base, env: { VLAD_CI_USER: "vlad-ci", VLAD_UNAME_M: "arm64" } };
}
const calls = (s: Sandbox) => readFileSync(s.log, "utf8");

describe("mac/ci-runner.sh", () => {
  it("varsayılan --dry-run: ağ/kurulum/token yok, adımları ve kullanıcı adımlarını basar", () => {
    const s = sandbox(); const f = fixture(s);
    const r = run("ci-runner.sh", f.base, s, f.env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[dry-run]");
    expect(r.stdout).toContain("actions-runner-osx-arm64-2.329.0.tar.gz");
    expect(r.stdout).toContain("KULLANICI ADIMI");
    expect(r.stdout).toMatch(/fork.*(onay|kapalı)/i);
    expect(calls(s)).not.toMatch(/curl|config\.sh|svc\.sh/);
    expect(existsSync(f.dir)).toBe(false);
  });
  it("--apply: indirir, sha256 doğrular, token'ı stdin'den alıp kaydeder, servisi kurar; çıktıya token yazmaz", () => {
    const s = sandbox(); const f = fixture(s);
    const r = run("ci-runner.sh", [...f.base, "--apply", "--token-stdin"], s, f.env, TOKEN + "\n");
    expect(r.status).toBe(0);
    const c = calls(s);
    expect(c).toMatch(/config\.sh --unattended --url https:\/\/github\.com\/iamhankaya\/medialog --token AAAATESTTOKEN123 .*--labels/);
    expect(c).toContain("svc.sh install");
    expect(c).toContain("svc.sh start");
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });
  it("idempotent: kayıtlı runner'da ikinci --apply indirmez, config.sh/svc.sh install çağırmaz", () => {
    const s = sandbox(); const f = fixture(s);
    run("ci-runner.sh", [...f.base, "--apply", "--token-stdin"], s, f.env, TOKEN + "\n");
    writeFileSync(s.log, "");
    const r2 = run("ci-runner.sh", [...f.base, "--apply"], s, f.env);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("zaten kayıtlı");
    expect(calls(s)).not.toMatch(/curl|config\.sh|svc\.sh install/);
  });
  it("sha256 uyuşmazsa durur, hiçbir şey kurmaz", () => {
    const s = sandbox(); const f = fixture(s);
    const bad = f.base.map((x) => (x === f.sha ? "0".repeat(64) : x));
    const r = run("ci-runner.sh", [...bad, "--apply", "--token-stdin"], s, f.env, TOKEN + "\n");
    expect(r.status).toBe(1); expect(r.stderr).toContain("sha256");
    expect(calls(s)).not.toMatch(/config\.sh|svc\.sh/);
  });
  it("yanlış kullanıcıda (CI hesabı değil) --apply reddeder", () => {
    const s = sandbox(); const f = fixture(s);
    const r = run("ci-runner.sh", [...f.base, "--apply", "--token-stdin"], s, { ...f.env, VLAD_CI_USER: "baska" }, TOKEN + "\n");
    expect(r.status).toBe(1); expect(r.stderr).toContain("baska");
  });
  it("admin grubundaki hesapta reddeder", () => {
    const s = sandbox(); const f = fixture(s);
    stub(s, "id", 'case "$1" in -un) echo vlad-ci;; -Gn) echo "staff admin";; *) echo 502;; esac');
    const r = run("ci-runner.sh", [...f.base, "--apply", "--token-stdin"], s, f.env, TOKEN + "\n");
    expect(r.status).toBe(1); expect(r.stderr).toContain("admin");
  });
  it("root'ta ve geçersiz girdilerde reddeder (repo URL, sürüm, sha), token argv'den kabul edilmez", () => {
    const s = sandbox(); const f = fixture(s);
    stub(s, "id", 'case "$1" in -u) echo 0;; -un) echo root;; *) echo root;; esac');
    expect(run("ci-runner.sh", [...f.base, "--apply", "--token-stdin"], s, { ...f.env, VLAD_CI_USER: "root" }, "t\n").stderr).toContain("root");
    const bad = (k: string, v: string) => { const a = [...f.base]; a[a.indexOf(k) + 1] = v; return run("ci-runner.sh", a, s, f.env); };
    expect(bad("--repo-url", "https://evil.example/x/y").status).toBe(2);
    expect(bad("--repo-url", "https://github.com/a/b;rm -rf").status).toBe(2);
    expect(bad("--version", "latest").status).toBe(2);
    expect(bad("--sha256", "abc").status).toBe(2);
    expect(run("ci-runner.sh", [...f.base, "--token", "x"], s, f.env).status).toBe(2);
  });
  it("--apply token yoksa (stdin boş) kayıt yapmaz", () => {
    const s = sandbox(); const f = fixture(s);
    const r = run("ci-runner.sh", [...f.base, "--apply", "--token-stdin"], s, f.env, "");
    expect(r.status).toBe(1);
    expect(calls(s)).not.toMatch(/config\.sh/);
  });
});
