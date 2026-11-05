// F-246 kabulü (T20261105-62; plan "F-246 arayüzü"): `forward.ts` `raw.includes('"machines"')` yerine JSON.parse; ayrıştırma başarısızsa `unknown`
// (fail-closed ⇒ kb yazıcı komut reddedilir). Gerçek CLI, geçici VLAD_HOME, allowlist env. Matris: yorum, dize değeri, bozuk, boş, geçerli.
// Bozuk/boş/yorumlu config: U4b'ye kadar KIRMIZI (bugün "machines" alt dizesi yoksa fail-open "off").
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv, spawnVlad } from "../support/spawn-vlad.js";
import { rmTemp } from "../helpers.js";

let base: string, home: string;
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4f246-")));
  home = join(base, "home");
  for (const d of ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal"]) mkdirSync(join(home, "kb", d), { recursive: true });
  cpSync(resolve(import.meta.dirname, "..", "..", "schemas"), join(home, "schemas"), { recursive: true });
  writeFileSync(join(home, "vlad.local.json"), JSON.stringify({ self: "windows", keys: { mac: "a".repeat(64), windows: "a".repeat(64) } }));
});
afterEach(() => rmTemp(base));

/** Kimlik doğrulanamayan/işçi komutu: `task new` kb yazıcıdır; yerelde çalışsaydı "görev"/"proje" hatası verirdi, reddedilirse kimlik/beyin hatası. */
const taskNew = (config: string) => {
  writeFileSync(join(home, "vlad.config.json"), config);
  const env = isolatedEnv({ VLAD_HOME: home, VLAD_LOCAL_FILE: join(home, "vlad.local.json"), VLAD_MACHINE: "windows", VLAD_CLAUDE_JSON: join(base, "c.json") });
  const r = spawnVlad({ args: ["task", "new", "--project", "ghost", "--title", "x", "--kind", "dev", "--body-file", "-", "--json"], env, input: "## Tanım\nx\n", timeoutMs: 20_000 });
  return { code: r.status, err: r.stderr };
};
const rejected = (e: string) => /kimliği doğrulanamadı|beyin değil/.test(e);

describe("F-246 forward.ts workerState: config ayrıştırma", () => {
  it("geçerli machines + ben işçiyim ⇒ işçi: kb yazıcı reddedilir (beyin değil)", () => {
    const r = taskNew(JSON.stringify({ brain: "mac", machines: [{ name: "mac", os: "darwin", agent: { port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 7438 } }] }));
    expect(rejected(r.err), r.err).toBe(true);
  });
  it("dize değerinde 'machines' geçen ama machines tanımlamayan GEÇERLİ config ⇒ tek makine (off): yerelde çalışır", () => {
    const r = taskNew(JSON.stringify({ note: "\"machines\" burada yalnız metin" }));
    expect(rejected(r.err), r.err).toBe(false);
  });
  it("machines içermeyen geçerli config ⇒ off: yerelde çalışır", () => {
    expect(rejected(taskNew(JSON.stringify({ worktreeDir: "x" })).err)).toBe(false);
  });
  it("bozuk JSON ('machines' alt dizesi YOK) ⇒ unknown, kb yazıcı reddedilir (fail-closed)", () => {
    const r = taskNew('{ "brain": ');
    expect(rejected(r.err), r.err).toBe(true);
    expect(r.code).not.toBe(0);
  });
  it("bozuk JSON ('machines' alt dizesi VAR) ⇒ unknown, reddedilir", () => {
    expect(rejected(taskNew('{ "machines": [ ').err)).toBe(true);
  });
  it("boş dosya ⇒ unknown, reddedilir", () => {
    expect(rejected(taskNew("").err)).toBe(true);
  });
  it("yorum satırı içeren (geçersiz JSON) config ⇒ unknown, reddedilir", () => {
    expect(rejected(taskNew('// "machines" yorumda\n{ "worktreeDir": "x" }').err)).toBe(true);
  });
  it("VLAD_FORWARDED sırası korunur: iletilmiş çağrı bozuk config'te de yeniden iletim/ret yok (off)", () => {
    writeFileSync(join(home, "vlad.config.json"), '{ "brain": ');
    const env = isolatedEnv({ VLAD_HOME: home, VLAD_LOCAL_FILE: join(home, "vlad.local.json"), VLAD_MACHINE: "windows", VLAD_FORWARDED: "1", VLAD_CLAUDE_JSON: join(base, "c.json") });
    const r = spawnVlad({ args: ["task", "list", "--json"], env, timeoutMs: 20_000 });
    expect(rejected(r.stderr)).toBe(false);
  });
});
