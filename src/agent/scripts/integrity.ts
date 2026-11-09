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

/** `git ls-tree <commit> -- <yol>`: tek düzenli blob → oid; yoksa "missing"; symlink/gömülü repo/dizin → "irregular". */
async function treeEntry(repo: string, rev: string, path: string): Promise<{ oid: string } | "missing" | "irregular"> {
  const r = await runGit(repo, ["ls-tree", rev, "--", path]);
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
  const t = await treeEntry(repo, head, MANIFEST_PATH);
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
export async function checkEntry(repo: string, entry: ScriptEntry, head: string): Promise<{ integrity: ScriptIntegrity; bytes?: Buffer }> {
  const t = await treeEntry(repo, head, entry.file);
  if (t === "missing") return { integrity: "not_in_head" };
  if (t === "irregular") return { integrity: "not_regular" };
  const bytes = await catBlob(repo, t.oid, SCRIPT_MAX_BYTES);
  if (!bytes || bytes === "too_large") return { integrity: "not_regular" };
  return createHash("sha256").update(bytes).digest("hex") === entry.sha256 ? { integrity: "ok", bytes } : { integrity: "hash_mismatch" };
}

/** Varsayılan dalın uzak izleme ref'i: `refs/remotes/origin/HEAD`, yoksa origin/main, yoksa origin/master. */
async function defaultRemoteRef(repo: string): Promise<string | null> {
  const sym = await runGit(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && /^refs\/remotes\/origin\/\S+$/.test(sym.stdout.trim())) return sym.stdout.trim();
  for (const b of ["main", "master"]) if ((await runGit(repo, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${b}`])).code === 0) return `refs/remotes/origin/${b}`;
  return null;
}

/**
 * Çalışan commit (`head`, tek seferde okunmuş oid) origin'in VARSAYILAN dalında olmalı: itilmemiş commit da, özellik dalına itilmiş
 * kod da çalışmaz. Repo push yetkisi = işçide kod çalıştırma yetkisi; bu kontrol yetkiyi varsayılan dala (inceleme/koruma) çeker.
 */
export async function checkPushed(repo: string, head: string): Promise<void> {
  const ref = await defaultRemoteRef(repo);
  if (!ref) throw scriptFail("forbidden", "no_upstream", "origin'in varsayılan dalı (origin/HEAD, origin/main|master) bulunamadı; betikler yalnız varsayılan dala itilmiş commit'ten çalışır");
  const r = await runGit(repo, ["merge-base", "--is-ancestor", head, ref]);
  if (r.code !== 0) throw scriptFail("forbidden", "unpushed", `commit ${head.slice(0, 8)} ${ref.replace("refs/remotes/", "")} içinde değil; önce varsayılan dala it/merge et`);
}
