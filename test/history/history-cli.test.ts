// `vlad history search|show` uçtan uca (dist/cli.js): hunter geçici dizindeki sahte betiktir, PATH yalnız geçici dizin (T20261127-21).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeFixtureRoot, makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

let home: string, root: string, argsFile: string;
const SEARCH = (age: number) => ({
  schema: 1, query: "adb", took_ms: 3, total_hits: 1, returned: 1, last_indexed: "2026-11-27T20:05:11.000Z", index_age_s: age, warnings: [],
  results: [{ id: "-Users-u-dev-app/s.jsonl:412", score: 11.8, ts: "2026-11-26T14:03:22.120Z", project: "app", task: "T20261126-29", session: "s",
    role: "assistant", kind: "text", tool: null, sidechain: false, source_deleted: false, path: "-Users-u-dev-app/s.jsonl", line: 412, cwd: "/x", snippet: "… «adb» -s emulator-5556 …" }],
});

/** Fake hunter: records argv to argsFile, prints `stdout`, writes `stderr`, exits `code`. */
function fakeHunter(dir: string, o: { stdout?: unknown; stderr?: string; code?: number }): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "hunter");
  const body = [
    `const fs = process.getBuiltinModule("node:fs");`,
    `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    o.stdout !== undefined ? `process.stdout.write(${JSON.stringify(JSON.stringify(o.stdout))});` : "",
    o.stderr ? `process.stderr.write(${JSON.stringify(o.stderr)});` : "",
    `process.exitCode = ${o.code ?? 0};`,
  ].join("\n");
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const cfg = (extra: Record<string, unknown> = {}) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: [root], worktreeDir: "{repo}-wt", ...extra }));
const run = (pathDirs: string[], ...args: string[]) => spawnVlad({ args, env: { VLAD_HOME: home, PATH: pathDirs.join(":") } });
const posix = process.platform !== "win32";

beforeEach(() => {
  home = makeHome();
  root = makeFixtureRoot();
  argsFile = join(root, "args.json");
  cfg();
});

describe.runIf(posix)("vlad history search", () => {
  it("PATH'teki hunter'ı süzgeçlerle çağırır, --json çıktısı hunter şeması + warnings", () => {
    fakeHunter(join(root, "bin"), { stdout: SEARCH(60) });
    const r = run([join(root, "bin")], "history", "search", "adb", "port", "--project", "app", "--task", "T20261126-29", "--since", "2026-11-01", "--until", "2026-11-27", "--limit", "5", "--all", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["search", "--json", "--project=app", "--task=T20261126-29", "--since=2026-11-01", "--until=2026-11-27", "--limit=5", "--all", "--", "adb port"]);
    const out = JSON.parse(r.stdout);
    expect(out.schema).toBe(1);
    expect(out.results[0].id).toBe("-Users-u-dev-app/s.jsonl:412");
    expect(out.warnings).toEqual([]);
  });
  it("PATH'te yoksa vlad.config.json hunterPath kullanılır", () => {
    const p = fakeHunter(join(root, "cfg"), { stdout: SEARCH(60) });
    cfg({ hunterPath: p });
    const r = run([join(root, "bos")], "history", "search", "adb", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).returned).toBe(1);
  });
  it("dizin 24 saatten eskiyse warnings'te uyarı (json) / stderr'de uyarı (metin)", () => {
    fakeHunter(join(root, "bin"), { stdout: SEARCH(2 * 86400) });
    const j = run([join(root, "bin")], "history", "search", "adb", "--json");
    expect(j.status, j.stderr).toBe(0);
    expect(JSON.parse(j.stdout).warnings.join()).toMatch(/24 saatten eski/);
    const t = run([join(root, "bin")], "history", "search", "adb");
    expect(t.status, t.stderr).toBe(0);
    expect(t.stderr).toMatch(/uyarı: dizin 24 saatten eski/);
    expect(t.stdout).toContain("-Users-u-dev-app/s.jsonl:412");
    expect(t.stdout).toContain("«adb»");
  });
  it("hunter hiçbir yerde yoksa çıkış 1, {error, details} + kurulum ipucu", () => {
    const r = run([join(root, "bos")], "history", "search", "adb", "--json");
    expect(r.status).toBe(1);
    const e = JSON.parse(r.stderr.trim());
    expect(e.error).toMatch(/hunter bulunamadı/);
    expect(e.details.join("\n")).toMatch(/cargo install --path/);
    expect(e.details.join("\n")).toMatch(/hunterPath/);
  });
  it("dizin yoksa (hunter no_index) çıkış 1 + `hunter index` ipucu", () => {
    fakeHunter(join(root, "bin"), { code: 1, stderr: JSON.stringify({ error: "dizin yok: /c (önce `hunter index`)", code: "no_index", details: [] }) + "\n" });
    const r = run([join(root, "bin")], "history", "search", "adb", "--json");
    expect(r.status).toBe(1);
    const e = JSON.parse(r.stderr.trim());
    expect(e.error).toMatch(/dizin yok/);
    expect(e.details).toContain("code: no_index");
  });
});

describe.runIf(posix)("tire ile başlayan işlenenler (review K1/Ö2)", () => {
  const REAL_ID = "-Users-u-dev-app/5b1e0000-0000-4000-8000-0000000000c2.jsonl:412"; // sözleşme örneği: proje klasörü '-' ile başlar
  it("show: gerçek kimlik (-Users-…) seçenek sanılmaz, --json yine işlenir", () => {
    fakeHunter(join(root, "bin"), { stdout: { schema: 1, id: REAL_ID, path: "p", session: "s", project: "app", task: null, sidechain: false, source_deleted: false, messages: [] } });
    const r = run([join(root, "bin")], "history", "show", REAL_ID, "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["show", "--json", "--", REAL_ID]);
    expect(JSON.parse(r.stdout).id).toBe(REAL_ID);
  });
  it("search: hariç tutma terimi (-bar) sorguya girer, --json yine işlenir", () => {
    fakeHunter(join(root, "bin"), { stdout: SEARCH(60) });
    const r = run([join(root, "bin")], "history", "search", "foo", "-bar", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["search", "--json", "--", "foo -bar"]);
    expect(JSON.parse(r.stdout).schema).toBe(1);
  });
  it("search: bilinmeyen uzun seçenek (--limt) sorguya karışmaz, hata verir", () => {
    fakeHunter(join(root, "bin"), { stdout: SEARCH(60) });
    const r = run([join(root, "bin")], "history", "search", "foo", "--limt", "5", "--json");
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr.trim()).error).toMatch(/--limt/);
  });
  it("seçenek değeri '-' ile başlasa da hunter'a bayrak olarak geçmez (--opt=değer)", () => {
    fakeHunter(join(root, "bin"), { stdout: SEARCH(60) });
    const r = run([join(root, "bin")], "history", "search", "foo", "--project=-x", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["search", "--json", "--project=-x", "--", "foo"]);
  });
});

describe.runIf(posix)("vlad history show", () => {
  const SHOW = { schema: 1, id: "a.jsonl:3", path: "a.jsonl", session: "s", project: "app", task: null, sidechain: false, source_deleted: false,
    messages: [{ line: 3, ts: "2026-11-26T14:03:22.120Z", target: true, blocks: [{ block: 0, role: "user", kind: "text", tool: null, text: "merhaba dünya" }] }] };
  it("show <id> --context N --json hunter'a geçer, çıktı aynen", () => {
    fakeHunter(join(root, "bin"), { stdout: SHOW });
    const r = run([join(root, "bin")], "history", "show", "a.jsonl:3", "--context", "2", "--json");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["show", "--json", "--context=2", "--", "a.jsonl:3"]);
    expect(JSON.parse(r.stdout)).toEqual(SHOW);
  });
  it("metin çıktısı hedef satırı işaretler", () => {
    fakeHunter(join(root, "bin"), { stdout: SHOW });
    const r = run([join(root, "bin")], "history", "show", "a.jsonl:3");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/> 3 .*2026-11-26/);
    expect(r.stdout).toContain("merhaba dünya");
  });
  it("hunter yoksa çıkış 1 + kurulum ipucu", () => {
    const r = run([join(root, "bos")], "history", "show", "a.jsonl:3", "--json");
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr.trim()).details.join("\n")).toMatch(/cargo install/);
  });
});
