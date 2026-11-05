/** Yol son bölümü; win32 ve posix ayırıcılarını, sondaki ayırıcıyı tanır. */
export const repoNameOf = (repoPath: string): string => repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

export type RepoPick = { ok: true; dir: string } | { ok: false; code: "not_found" } | { ok: false; code: "conflict"; candidates: string[] };

/** Aynı repo adına uyan kök-altı adaylardan tekini seçer: 0 -> not_found, >1 farklı -> conflict. */
export function pickRepoDir(candidates: string[]): RepoPick {
  const uniq = [...new Set(candidates)];
  if (uniq.length === 0) return { ok: false, code: "not_found" };
  if (uniq.length > 1) return { ok: false, code: "conflict", candidates: uniq };
  return { ok: true, dir: uniq[0] };
}
