import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Os, ScriptEntry } from "../../src/fleet/types.js";

// Bakım betikleri testlerinin ortak yardımcıları: geçici git deposu (isteğe bağlı sahte upstream) ve manifest üretimi.
// Hiçbiri gerçek dizine/ortama dokunmaz; her depo os.tmpdir() altında yeni bir dizindir.

export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];

export interface Fixture {
  /** realpath'li depo kökü (VLAD_HOME rolünde) */
  dir: string;
  git(...args: string[]): string;
  write(rel: string, content: string | Buffer): void;
  commit(msg?: string): string;
  /** sahte upstream (bare depo) kurar ve mevcut dalı push eder */
  withUpstream(): void;
}

export function makeRepo(files: Record<string, string | Buffer> = {}): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vlad-scr-")));
  const git = (...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  const write = (rel: string, content: string | Buffer) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), content); };
  for (const [k, v] of Object.entries(files)) write(k, v);
  const commit = (msg = "c") => { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", msg); return git("rev-parse", "HEAD").trim(); };
  if (Object.keys(files).length) commit("init");
  const withUpstream = () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "vlad-scr-up-")));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git("remote", "add", "origin", bare);
    git("push", "-q", "-u", "origin", "main");
  };
  return { dir, git, write, commit, withUpstream };
}

export function symlinkIn(f: Fixture, rel: string, target: string): void {
  mkdirSync(dirname(join(f.dir, rel)), { recursive: true });
  symlinkSync(target, join(f.dir, rel));
}

export const entryOf = (platform: Os, name: string, content: string, o: Partial<ScriptEntry> = {}): ScriptEntry => ({
  name, title: name, platform, file: `agent-scripts/${name}.${platform === "win32" ? "ps1" : "sh"}`, sha256: sha256(content),
  class: "read", timeoutSec: 20, outputMaxKb: 32, selfUpdate: false, params: [], ...o,
});
export const manifestJson = (...entries: ScriptEntry[]): string => JSON.stringify({ version: 1, scripts: entries }, null, 2) + "\n";

/** Tek betikli depo: manifest + betik commit'li, upstream'li. */
export function scriptRepo(platform: Os, name: string, content: string, o: Partial<ScriptEntry> = {}): Fixture & { entry: ScriptEntry; head: string } {
  const entry = entryOf(platform, name, content, o);
  const f = makeRepo({ "agent-scripts/manifest.json": manifestJson(entry), [entry.file]: content });
  f.withUpstream();
  return { ...f, entry, head: f.git("rev-parse", "HEAD").trim() };
}
