import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "../isolate-env.js";
import { makeHome, rmTemp } from "../helpers.js";

// `vlad install` sağ tık entegrasyonu (dist/cli.js, gerçek süreç). VLAD_NO_NATIVE=1: gerçek ~/Library/Services ve kayıt defteri hiç kullanılmaz.
const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmTemp(t); });

function run(args: string[], env: Record<string, string> = {}, machines = true) {
  const home = makeHome(); temps.push(home); cpSync(join(root, "global"), join(home, "global"), { recursive: true });
  const base = mkdtempSync(join(tmpdir(), "vlad-cinst-")); temps.push(base);
  if (machines) writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: ["/x"], brain: "mac", machines: [
    { name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.2", port: 7437 } }] }));
  const services = join(base, "Services");
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...isolatedEnv(), VLAD_HOME: home, VLAD_CLAUDE_DIR: join(base, ".claude"), VLAD_SERVICES_DIR: services, VLAD_MACHINE: "mac", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, services, base };
}

describe("aktarim:C vlad install sağ tık", () => {
  it("--dry-run Mac'te Hızlı Eylem yolunu listeler, diske dokunmaz", () => {
    const r = run(["install", "--dry-run", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).actions.join("\n")).toContain(join(r.services, "windows makinesine gönder.workflow"));
    expect(existsSync(r.services)).toBe(false);
  });
  it("VLAD_NO_NATIVE=1 iken gerçek kurulum menüyü atlar ve söyler; servicesDir'e yazmaz", () => {
    const r = run(["install", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).actions.join("\n")).toMatch(/sağ tık menüsü atlandı: native devre dışı/);
    expect(existsSync(r.services)).toBe(false);
  });
  it("machines yok / kimlik belirsiz: install kırılmaz, atlandı der", () => {
    expect(run(["install", "--dry-run", "--json"], {}, false).out).toMatch(/machines yok/);
    const home = makeHome(); temps.push(home); cpSync(join(root, "global"), join(home, "global"), { recursive: true });
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: ["/x"], brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { host: "h", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "h2", port: 7437 } }] }));
    const r = spawnSync("node", [cli, "install", "--dry-run", "--json"], { encoding: "utf8", env: { ...isolatedEnv(), VLAD_HOME: home, VLAD_CLAUDE_DIR: join(home, ".c"), VLAD_LOCAL_FILE: join(home, "yok.json") } });
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toMatch(/kimliği belirsiz/);
  });
  it("--remove-menu --dry-run: yalnız menü kaldırma eylemi, SessionEnd/skill eylemi yok", () => {
    const r = run(["install", "--remove-menu", "--dry-run", "--json"]);
    const a: string[] = JSON.parse(r.out).actions;
    expect(a).toHaveLength(1); expect(a[0]).toMatch(/kaldırılacak/); expect(a[0]).not.toMatch(/SessionEnd/);
  });
});
