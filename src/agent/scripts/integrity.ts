import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { RemoteError, SCRIPT_LIMITS, type ScriptEntry, type ScriptIntegrity, type ScriptManifest } from "../../fleet/types.js";
import { runGit } from "../ops/gate.js";
import { validateScriptManifest } from "./manifest.js";

// Bütünlük (spec §Bütünlük algoritması): kimin ne çalıştıracağı çalışma ağacından değil, HEAD'deki git blob'undan gelir.
// Yol istekten alınmaz: dosya yolu yalnız HEAD manifestinden (SCRIPT_FILE_RE ile doğrulanmış) gelir.

const MANIFEST_PATH = "agent-scripts/manifest.json";
const SCRIPT_MAX_BYTES = 1024 * 1024;
const REGULAR = new Set(["100644", "100755"]);

/** Hata mesajında makine okunur neden: `<kod>: [<neden>] <ayrıntı>` (yeni AgentCode yok). */
export const scriptFail = (code: "forbidden" | "failed" | "not_found" | "bad_request", reason: string, detail: string): RemoteError =>
  new RemoteError(code, `${code}: [${reason}] ${detail}`);

/** Filtresiz ham baytlar (git cat-file blob); metin kodlaması karma değerini bozmasın. */
function catBlob(cwd: string, rev: string, maxBytes: number): Promise<Buffer | "too_large" | null> {
  return new Promise((resolve) => {
    execFile("git", ["cat-file", "blob", rev], { cwd, encoding: "buffer", maxBuffer: maxBytes, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      if (!err) return resolve(stdout);
      resolve((err as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "too_large" : null);
    });
  });
}

/** `git ls-tree HEAD -- <yol>`: tek düzenli blob → oid; yoksa "missing"; symlink/gömülü repo/dizin → "irregular". */
async function treeEntry(repo: string, path: string): Promise<{ oid: string } | "missing" | "irregular"> {
  const r = await runGit(repo, ["ls-tree", "HEAD", "--", path]);
  if (r.code !== 0) throw scriptFail("failed", "no_repo", `git ls-tree başarısız: ${(r.stderr || r.stdout).trim()}`);
  const lines = r.stdout.split("\n").filter(Boolean);
  if (!lines.length) return "missing";
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/.exec(lines[0]!);
  if (lines.length !== 1 || !m || m[4] !== path || m[2] !== "blob" || !REGULAR.has(m[1]!)) return "irregular";
  return { oid: m[3]! };
}

export interface RepoState { repo: string; head: string; /** agent-scripts/ altında değişmiş, stage'li ya da izlenmeyen dosya var */ dirty: boolean; manifest: ScriptManifest }

/** Depo (VLAD_HOME) → HEAD → kirlilik → HEAD manifesti. Yerel bir kök başka bir depoya ait değilse `no_repo`. */
export async function loadRepoState(home: string): Promise<RepoState> {
  let repo: string;
  try { repo = realpathSync.native(home); } catch { throw scriptFail("failed", "no_repo", `VLAD_HOME okunamadı: ${home}`); }
  const top = await runGit(repo, ["rev-parse", "--show-toplevel"]);
  let topReal = "";
  try { topReal = top.code === 0 ? realpathSync.native(top.stdout.trim()) : ""; } catch { /* aşağıda no_repo */ }
  if (!topReal || topReal !== repo) throw scriptFail("failed", "no_repo", "VLAD_HOME bir git deposunun kökü değil");
  const head = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw scriptFail("failed", "no_repo", "HEAD çözülemedi (commit yok)");
  const st = await runGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "agent-scripts"]);
  if (st.code !== 0) throw scriptFail("failed", "no_repo", `git status başarısız: ${(st.stderr || st.stdout).trim()}`);
  const t = await treeEntry(repo, MANIFEST_PATH);
  if (t === "missing") throw scriptFail("forbidden", "not_in_head", `${MANIFEST_PATH} HEAD'de yok`);
  if (t === "irregular") throw scriptFail("forbidden", "not_regular", `${MANIFEST_PATH} düzenli bir dosya değil`);
  const raw = await catBlob(repo, t.oid, SCRIPT_LIMITS.manifestMaxBytes);
  if (raw === "too_large") throw scriptFail("failed", "bad_manifest", `manifest ${SCRIPT_LIMITS.manifestMaxBytes} bayttan büyük`);
  if (!raw) throw scriptFail("failed", "no_repo", "manifest blob'u okunamadı");
  let json: unknown;
  try { json = JSON.parse(raw.toString("utf8")); } catch (e) { throw scriptFail("failed", "bad_manifest", `JSON ayrıştırılamadı: ${(e as Error).message}`); }
  return { repo, head, dirty: st.stdout.length > 0, manifest: validateScriptManifest(json) };
}

/** Tek girişin durumu; `ok` ise çalıştırılacak baytlar da döner. Kirlilik çağıranın işidir (`RepoState.dirty`). */
export async function checkEntry(repo: string, entry: ScriptEntry): Promise<{ integrity: ScriptIntegrity; bytes?: Buffer }> {
  const t = await treeEntry(repo, entry.file);
  if (t === "missing") return { integrity: "not_in_head" };
  if (t === "irregular") return { integrity: "not_regular" };
  const bytes = await catBlob(repo, t.oid, SCRIPT_MAX_BYTES);
  if (!bytes || bytes === "too_large") return { integrity: "not_regular" };
  return createHash("sha256").update(bytes).digest("hex") === entry.sha256 ? { integrity: "ok", bytes } : { integrity: "hash_mismatch" };
}

/** HEAD upstream'in atası olmalı (itilmemiş yerel commit çalıştırılmaz; kb-sync ile aynı gerekçe). */
export async function checkPushed(repo: string): Promise<void> {
  const up = await runGit(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.code !== 0) throw scriptFail("forbidden", "no_upstream", "depoda upstream yok; betikler yalnız itilmiş HEAD'den çalışır");
  const r = await runGit(repo, ["merge-base", "--is-ancestor", "HEAD", "@{u}"]);
  if (r.code !== 0) throw scriptFail("forbidden", "unpushed", "HEAD upstream'e itilmemiş; önce push et");
}
