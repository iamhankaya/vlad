import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { setSecretDirForTests } from "../../src/mode/token.js";

// T20261116-18: okuma araçları (Read/Grep/Glob) gizli dizine (anahtar, approver spool) erişemez. Yalnız geçici dizin kullanır.
let root: string, secret: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-readguard-")));
  secret = join(root, ".vlad-secret"); cwd = join(root, "wt");
  mkdirSync(join(secret, "approver"), { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(secret, "mode.key"), "k");
  setSecretDirForTests(secret);
});
afterEach(() => setSecretDirForTests(null));
const ctx = () => ({ vladHome: "/home/u/vlad", cwd });
const run = (tool: string, input: Record<string, unknown>) => checkWorkerMode(tool, input, null, ctx());

describe("okuma araçları gizli dizin koruması", () => {
  it("Read: mutlak, ~ ve .. ile gizli dizine çözülen yollar reddedilir; sembolik bağ da", () => {
    symlinkSync(secret, join(cwd, "link"));
    for (const p of [join(secret, "mode.key"), join(secret, "approver", "pending.json"), `${cwd}/../.vlad-secret/mode.key`, "link/mode.key", join(cwd, "link"), "~/.vlad-secret/mode.key"])
      expect(run("Read", { file_path: p }), p).toMatch(/okuma|anahtar/);
  });
  it("Grep ve Glob: path/glob/pattern kökü gizli dizine çözülüyorsa reddedilir", () => {
    expect(run("Grep", { pattern: "x", path: secret })).not.toBeNull();
    expect(run("Grep", { pattern: "x", glob: `${secret}/**` })).not.toBeNull();
    expect(run("Glob", { pattern: `${secret}/approver/*.json` })).not.toBeNull();
    expect(run("Glob", { pattern: "*", path: join(secret, "approver") })).not.toBeNull();
  });
  it("ata dizinden özyinelemeli arama, süslü parantez, `*` ad jokeri ve joker ortasında symlink reddedilir", () => {
    symlinkSync(secret, join(cwd, "s"));
    expect(run("Grep", { pattern: ".", path: root })).not.toBeNull();
    expect(run("Grep", { pattern: ".", path: "/" })).not.toBeNull();
    expect(run("Glob", { pattern: "**/mode.key", path: root })).not.toBeNull();
    expect(run("Glob", { pattern: `${root}/*/mode.key` })).not.toBeNull();
    expect(run("Glob", { pattern: `${root}/.vlad-{secret,x}/*` })).not.toBeNull();
    expect(run("Glob", { pattern: "s/*/channel.json" })).not.toBeNull();
  });
  it("başka dosyalar, Grep regex'i ve kendi worktree okuması serbest", () => {
    writeFileSync(join(cwd, "a.ts"), "x");
    expect(run("Read", { file_path: join(cwd, "a.ts") })).toBeNull();
    expect(run("Read", { file_path: "a.ts" })).toBeNull();
    expect(run("Grep", { pattern: "mode\\.key", path: cwd })).toBeNull();
    expect(run("Glob", { pattern: `${cwd}/**/*.ts` })).toBeNull();
  });
});
