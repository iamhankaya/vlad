// Kabul fazı (T20261109-06): kayıtlı bakım betikleri testlerinin ortak sahte kaynağı. Yalnız geçici dizin: bare origin + işçi klonu
// (işçinin VLAD_HOME'u), `agent-scripts/manifest.json` ve betikler. Gerçek repoya/dizine dokunmaz.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptEntry, ScriptParamSpec, ScriptPlatform } from "../../src/fleet/types.js";

export const PLAT = process.platform as ScriptPlatform;
export const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

export interface FxScript {
  name: string;
  /** varsayılan: bu makinenin platformu */
  platform?: ScriptPlatform;
  /** bash gövdesi (`#!/bin/bash` başlığı eklenir); platform win32 ise ham içerik (.ps1) */
  body: string;
  class?: "read" | "write";
  timeoutSec?: number;
  outputMaxKb?: number;
  selfUpdate?: boolean;
  params?: ScriptParamSpec[];
  /** manifestteki sha256'yı ez (hash_mismatch denemesi) */
  sha256?: string;
  /** dosya yolunu ez */
  file?: string;
}

export const fileOf = (s: Pick<FxScript, "name" | "platform" | "file">): string =>
  s.file ?? `agent-scripts/${s.name}.${(s.platform ?? PLAT) === "win32" ? "ps1" : "sh"}`;
const contentOf = (s: FxScript): string => ((s.platform ?? PLAT) === "win32" ? s.body : `#!/bin/bash\n${s.body}\n`);

export interface ScriptRepo {
  /** işçinin VLAD_HOME'u (git deposunun kökü; realpath) */
  repo: string;
  origin: string;
  git(...a: string[]): string;
  head(): string;
  /** betik dosyasını yazar (commit etmez) */
  write(rel: string, content: string | Buffer): void;
  read(rel: string): string;
  /** manifesti yeniden yazar (commit etmez); `entries` ham nesneler olabilir (bozuk manifest denemesi için) */
  writeManifest(entries: unknown[] | string): void;
  entry(s: FxScript): ScriptEntry;
  /** bütün değişiklikleri commit eder; `push` true ise upstream'e iter */
  commit(msg: string, push?: boolean): void;
  /** iş dosyası: betiğin `$VLAD_REPO`'ya yazdığı işaretin satırları */
  lines(name: string): string[];
  has(rel: string): boolean;
}

/** `dir` boş bir klasör (işçi home'u); içine git deposu + origin kurar ve `scripts` ile ilk commit'i atar. */
export function makeScriptRepo(dir: string, originDir: string, scripts: FxScript[]): ScriptRepo {
  mkdirSync(originDir, { recursive: true });
  git(originDir, "init", "-q", "--bare", "-b", "main");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", originDir);
  const repo = realpathSync.native(dir);
  // betiklerin yan çıktıları ve Agent durumu izlenmez (agent-scripts dışı; bütünlük denetimi yalnız agent-scripts'e bakar)
  writeFileSync(join(repo, ".gitignore"), ".vlad-agent/\n.ran-*\n.childpid\n.release\n.started-*\nvlad.local.json\nvlad.config.json\nkb/\nschemas/\nnoop.jsonl\nclaude.json\n");
  mkdirSync(join(repo, "agent-scripts"), { recursive: true });
  const r: ScriptRepo = {
    repo, origin: originDir,
    git: (...a) => git(repo, ...a),
    head: () => git(repo, "rev-parse", "HEAD"),
    write(rel, content) { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), content); },
    read: (rel) => readFileSync(join(repo, rel), "utf8"),
    writeManifest(entries) {
      writeFileSync(join(repo, "agent-scripts", "manifest.json"), typeof entries === "string" ? entries : JSON.stringify({ version: 1, scripts: entries }, null, 2));
    },
    entry(s) {
      return {
        name: s.name, title: s.name, platform: s.platform ?? PLAT, file: fileOf(s), sha256: s.sha256 ?? sha256(contentOf(s)),
        class: s.class ?? "read", timeoutSec: s.timeoutSec ?? 30, outputMaxKb: s.outputMaxKb ?? 32, selfUpdate: s.selfUpdate ?? false, params: s.params ?? [],
      };
    },
    commit(msg, push = true) {
      git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", msg);
      if (push) git(repo, "push", "-q", "-u", "origin", "main");
    },
    lines(name) {
      try { return readFileSync(join(repo, `.ran-${name}`), "utf8").split("\n").filter(Boolean); } catch { return []; }
    },
    has(rel) { try { readFileSync(join(repo, rel)); return true; } catch { return false; } },
  };
  for (const s of scripts) r.write(fileOf(s), contentOf(s));
  r.writeManifest(scripts.map((s) => r.entry(s)));
  r.commit("scripts");
  return r;
}

/** Betik gövdesi yardımcıları (bash). `$VLAD_REPO` işaret dosyalarının yeridir. */
export const sh = {
  mark: (name: string) => `echo "$VLAD_OP_ID" >> "$VLAD_REPO/.ran-${name}"`,
  result: (json: string) => `echo '@@VLAD-RESULT@@ ${json}'`,
};
