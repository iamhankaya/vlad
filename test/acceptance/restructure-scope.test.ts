// Seçici koşum haritası kabulü (T20261105-62; plan "Seçici koşum"): bir dosya değişince doğru kovalar seçilir.
// SÖZLEŞME VARSAYIMI (plan çıktı biçimini sabitlemiyor; U2 farklı yaparsa test itirazı ile uyarlanır):
//   `node scripts/test-scope.mjs --since <ref> --json` cwd'deki git deposunda `<ref>..worktree` farkını okur ve stdout'a
//   `{"buckets": ["unit"|"process"|"agent"|"platform", ...], "unmapped": ["<yol>", ...], "warnings": ["..."]}` basar; `--run` verilmedikçe test koşmaz.
// Harita (plan): src/agent/** → agent+process; src/launcher/** → process+platform; src/commands|cli/**, src/kb/types.ts, schemas/**, roles/**,
// global/skills/**, test/support/**, test/machines/harness.ts, test/fixtures/**, vitest.config.ts, test/global-setup.ts, test/isolate-env.ts, package.json → TÜM kovalar.
// Eşlenmeyen yol → TÜM kovalar + unmapped. Yalnız docs → uyarı + unit (sessizce 0 test yok). U2'ye kadar KIRMIZI (betik yok).
// Her vaka kendi geçici git deposunda koşar; gerçek depoya dokunulmaz.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(root, "scripts", "test-scope.mjs");
const ALL = ["agent", "platform", "process", "unit"];
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

let tmp: string;
beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-scope-")));
  git(tmp, "init", "-q", "-b", "main");
  writeFileSync(join(tmp, "README.md"), "x"); git(tmp, "add", "."); git(tmp, "commit", "-qm", "base");
  // betiğin haritayı depodan okuması durumunda gerçek harita + bölme tablosunu kopyala (yalnız okuma kaynağı)
  for (const f of ["test/scope.json", "test/buckets.json"]) if (existsSync(join(root, f))) { mkdirSync(dirname(join(tmp, f)), { recursive: true }); writeFileSync(join(tmp, f), readFileSync(join(root, f))); }
  git(tmp, "add", "."); git(tmp, "commit", "-qm", "scope", "--allow-empty");
});
afterEach(() => rmTemp(tmp));

const scope = (...changed: string[]) => {
  for (const f of changed) { mkdirSync(dirname(join(tmp, f)), { recursive: true }); writeFileSync(join(tmp, f), `// ${Math.random()}\n`); }
  const r = spawnSync(process.execPath, [SCRIPT, "--since", "HEAD", "--json"], { cwd: tmp, encoding: "utf8", timeout: 30_000 });
  expect(existsSync(SCRIPT), "scripts/test-scope.mjs yok (U2)").toBe(true);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { buckets: string[]; unmapped: string[]; warnings: string[] };
};
const sel = (r: { buckets: string[] }) => [...r.buckets].sort();

describe("seçici koşum haritası (kabul)", () => {
  it("src/agent/** ⇒ agent + process", () => { expect(sel(scope("src/agent/server.ts"))).toEqual(expect.arrayContaining(["agent", "process"])); });
  it("src/launcher/** ⇒ process + platform", () => { expect(sel(scope("src/launcher/posix.ts"))).toEqual(expect.arrayContaining(["process", "platform"])); });
  for (const f of ["src/commands/manifest.ts", "src/cli/program.ts", "src/kb/types.ts", "schemas/task.schema.json", "roles/tester.md", "global/skills/x/SKILL.md",
    "test/support/spawn-vlad.ts", "test/machines/harness.ts", "test/fixtures/kb-mini/a.md", "vitest.config.ts", "test/global-setup.ts", "test/isolate-env.ts", "package.json"]) {
    it(`${f} ⇒ TÜM kovalar`, () => { expect(sel(scope(f))).toEqual(ALL); });
  }
  it("eşlenmeyen yol ⇒ TÜM kovalar ve unmapped'da listelenir (sessizce atlanmaz)", () => {
    const r = scope("garip/yeni-dizin/dosya.bin");
    expect(sel(r)).toEqual(ALL);
    expect(r.unmapped).toContain("garip/yeni-dizin/dosya.bin");
  });
  it("yalnız docs değişirse uyarı basar ve unit'i koşar; boş küme dönmez", () => {
    const r = scope("docs/not.md");
    expect(r.buckets).toContain("unit");
    expect(r.buckets.length).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toMatch(/docs|uyarı|yalnız/i);
  });
  it("birleşim: iki ayrı alandaki değişiklik iki kümenin birleşimi", () => {
    const r = scope("src/agent/server.ts", "src/launcher/posix.ts");
    expect(sel(r)).toEqual(expect.arrayContaining(["agent", "process", "platform"]));
  });
  it("hiç değişiklik yoksa sessizce 0 test koşmaz: unit seçili + uyarı", () => {
    const r = scope();
    expect(r.buckets).toContain("unit");
  });
});
