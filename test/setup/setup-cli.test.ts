// vlad setup CLI sözleşmesi (T20261110-05): gerçek süreç (dist/cli.js), geçici HOME/VLAD_HOME; çıkış kodları 0/1/2, --json şeması, sır sızmaz.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnGuarded } from "../support/spawn-vlad.js";
import { isolatedEnv } from "../isolate-env.js";
import { rmTemp } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
let base: string, vh: string, claude: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vlad-setupcli-")); vh = join(base, "vlad"); claude = join(base, "home", ".claude");
  mkdirSync(join(base, "home", "dev"), { recursive: true });
  for (const d of ["schemas", "global"]) cpSync(join(root, d), join(vh, d), { recursive: true });
  mkdirSync(join(vh, "dist", "hooks"), { recursive: true }); writeFileSync(join(vh, "dist", "cli.js"), ""); writeFileSync(join(vh, "dist", "hooks", "session-report.js"), "");
  mkdirSync(join(vh, ".claude", "skills", "delegate"), { recursive: true }); writeFileSync(join(vh, ".claude", "skills", "delegate", "SKILL.md"), "x");
  writeFileSync(join(vh, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "x status --summary --hook" }] }] } }));
});
afterEach(() => rmTemp(base));
const vlad = (args: string[], input?: string) => {
  const r = spawnGuarded("node", [cli, ...args], { encoding: "utf8", input, env: { ...isolatedEnv(), VLAD_HOME: vh, VLAD_CLAUDE_DIR: claude, HOME: join(base, "home"), VLAD_LOCAL_FILE: join(base, "vlad.local.json"), VLAD_NO_NATIVE: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const answers = () => JSON.stringify({ role: "brain", machines: "single", kb: { mode: "local", dir: join(base, "kb") }, roots: [join(base, "home", "dev")] });

describe("vlad setup CLI", () => {
  it("etkileşimsiz ve --answers yok: çıkış 2 (kullanım hatası)", () => {
    const r = vlad(["setup"], "");
    expect(r.code).toBe(2); expect(r.err).toMatch(/--answers/);
  });
  it("bilinmeyen cevap anahtarı: çıkış 2 ve yolu listeler", () => {
    const r = vlad(["setup", "--answers", '{"foo":1}']);
    expect(r.code).toBe(2); expect(r.err).toMatch(/foo: bilinmeyen anahtar/);
  });
  it("geçerli cevaplarla --dry-run çıkış 0", () => {
    expect(vlad(["setup", "--answers", answers(), "--dry-run", "--json"]).code).toBe(0);
  });
  it("--only bilinmeyen parça: hata", () => {
    expect(vlad(["setup", "--check", "--only", "nope"]).code).toBe(1);
  });
  it("kurulum → --check --json şemaya uyar, çıkış 0; yeniden kurulum değişiklik yapmaz", () => {
    const first = vlad(["setup", "--answers", answers(), "--yes", "--json"]);
    expect(first.code, first.err).toBe(0);
    const chk = vlad(["setup", "--check", "--json", "--only", "config,kb,global-skills,hooks,cli,permissions,agent"]);
    expect(chk.code, chk.out + chk.err).toBe(0);
    const schema = JSON.parse(readFileSync(join(root, "schemas", "setup-check.schema.json"), "utf8"));
    const v = new Ajv({ strict: false }).compile(schema);
    expect(v(JSON.parse(chk.out)), JSON.stringify(v.errors)).toBe(true);
    const again = JSON.parse(vlad(["setup", "--answers", answers(), "--yes", "--json", "--only", "config,kb,global-skills,hooks"]).out);
    expect(again.results.filter((r: any) => r.changed)).toEqual([]);
    expect(existsSync(join(base, "kb", ".git"))).toBe(true);
  });
  it("--check eksik kurulumda çıkış 1 ve düzeltme komutu önerir", () => {
    const r = vlad(["setup", "--check", "--only", "global-skills"]);
    expect(r.code).toBe(1); expect(r.out).toMatch(/vlad setup --upgrade/);
  });
  it("--dry-run hiçbir şey yazmaz", () => {
    vlad(["setup", "--answers", answers(), "--dry-run"]);
    expect(existsSync(claude)).toBe(false); expect(existsSync(join(vh, "vlad.config.local.json"))).toBe(false);
  });
});
