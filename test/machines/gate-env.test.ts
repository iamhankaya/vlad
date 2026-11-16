import { execFileSync } from "node:child_process";
import { spawnGuarded } from "../support/spawn-vlad.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGate } from "../../src/agent/ops/gate.js";
import { defaultConfig } from "../../src/kb/config.js";
import { validate } from "../../src/kb/schema.js";
import { gateEnvOf, rawGateEnv } from "../../src/fleet/gate-env.js";
import { standardBlocks } from "../../src/tasks/blocks.js";
import { buildPrompt } from "../../src/tasks/launch.js";

const cfgWith = (gateEnv: Record<string, Record<string, string>> | undefined) => ({
  ...defaultConfig(),
  brain: "mac",
  machines: [{ name: "mac", os: "darwin" as const, agent: { port: 7437 }, ...(gateEnv ? { gateEnv } : {}) }, { name: "win", os: "win32" as const, agent: { host: "1.2.3.4", port: 7437 } }],
});

describe("gateEnvOf", () => {
  const cfg = cfgWith({ medialog: { DATABASE_URL: "postgres://x", PATH: "/opt/pg/bin:$PATH", B: "${FOO}-$NOPE-x" } });
  it("$VAR / ${VAR} base ortamından açılır; tanımsız boş olur", () => {
    expect(gateEnvOf(cfg, "mac", "medialog", { PATH: "/usr/bin", FOO: "f" })).toEqual({ DATABASE_URL: "postgres://x", PATH: "/opt/pg/bin:/usr/bin", B: "f--x" });
  });
  it("başka makine / başka proje / makine yok → boş", () => {
    expect(gateEnvOf(cfg, "win", "medialog")).toEqual({});
    expect(gateEnvOf(cfg, "mac", "baska")).toEqual({});
    expect(gateEnvOf(cfg, null, "medialog")).toEqual({});
    expect(gateEnvOf({ ...cfg, machines: undefined }, "mac", "medialog")).toEqual({});
  });
  it("rawGateEnv açılmamış değeri verir", () => {
    expect(rawGateEnv(cfg, "mac", "medialog").PATH).toBe("/opt/pg/bin:$PATH");
  });
  it("şema: geçerli gateEnv geçer; geçersiz değişken adı ve metin olmayan değer reddedilir", () => {
    expect(() => validate("config", cfg, process.cwd())).not.toThrow();
    expect(() => validate("config", cfgWith({ p: { "1BAD": "x" } }), process.cwd())).toThrow();
    expect(() => validate("config", cfgWith({ p: { OK: 5 as unknown as string } }), process.cwd())).toThrow();
  });
});

describe("runGate env", () => {
  it("verilen ortam gate sürecine geçer; verilmezse geçmez", async () => {
    const d = mkdtempSync(join(tmpdir(), "vlad-genv-"));
    try {
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "init", "-b", "main"], { cwd: d, stdio: "pipe" });
      writeFileSync(join(d, "a"), "1");
      execFileSync("git", ["add", "."], { cwd: d, stdio: "pipe" });
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "i"], { cwd: d, stdio: "pipe" });
      const cmd = `node -e "console.log('v='+(process.env.GATE_ENV_PROBE||'yok'))"`;
      expect((await runGate(cmd, d, undefined, { GATE_ENV_PROBE: "var" })).stdout).toContain("v=var");
      expect((await runGate(cmd, d)).stdout).toContain("v=yok");
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 20_000);
});

describe("worker prompt gate ortamı", () => {
  const env = { DATABASE_URL: "postgres://m:m@127.0.0.1:5432/m", PATH: "/opt/pg/bin:$PATH" };
  it("yerel commit/pr prompt'u ortamı satır içi gösterir", () => {
    const t = standardBlocks({ taskId: "T20261117-04", autonomy: "commit", parent: null, mode: "local", gateEnv: env }).join("\n");
    expect(t).toContain("Gate ortamı");
    expect(t).toContain('export DATABASE_URL="postgres://m:m@127.0.0.1:5432/m"');
    expect(t).toContain('export PATH="/opt/pg/bin:$PATH"');
  });
  it("F-vlad-352: $(...), $1, ${VAR:-x}, backtick kabukta açılmaz; prompt ile gateEnvOf aynı değeri verir", () => {
    const tricky = { A: "$(echo PWNED)", B: "x$1y", C: "${NOPE_VAR:-dflt}", D: "`echo PWNED`", E: "a\\b\"c", F: "/opt/bin:$PATH:${HOME}" };
    const cfg = cfgWith({ p: tricky });
    const want = gateEnvOf(cfg, "mac", "p", { PATH: "/usr/bin", HOME: "/h" });
    const block = standardBlocks({ taskId: "T20261117-06", autonomy: "commit", parent: null, mode: "local", gateEnv: tricky }).join("\n");
    const exports = block.split("\n").filter((l) => l.startsWith("export "));
    const script = `${exports.join("\n")}\nprintf '%s\\0' "$A" "$B" "$C" "$D" "$E" "$F"`;
    const r = spawnGuarded("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin", HOME: "/h" } });
    expect(r.stdout.split("\0").slice(0, 6)).toEqual(["A", "B", "C", "D", "E", "F"].map((k) => want[k]));
  });
  it("ortam yoksa, plan'da ve bulutta blok çıkmaz", () => {
    const has = (c: object) => standardBlocks({ taskId: "T20261117-04", parent: null, ...({ autonomy: "commit", mode: "local" } as const), ...c }).join("\n").includes("Gate ortamı");
    expect(has({})).toBe(false);
    expect(has({ gateEnv: {} })).toBe(false);
    expect(has({ gateEnv: env, autonomy: "plan" })).toBe(false);
    expect(has({ gateEnv: env, mode: "cloud" })).toBe(false);
  });
  it("buildPrompt ortamı standart bloklara taşır", () => {
    const p = buildPrompt("/x/T.md", "commit", undefined, { taskId: "T20261117-04", parent: null, gateEnv: env });
    expect(p).toContain("VLAD standart blokları:");
    expect(p).toContain('export DATABASE_URL="');
  });
});
