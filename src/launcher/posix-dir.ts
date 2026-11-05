import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Why `dir` is not a private folder of the current user (symlink, foreign owner, loose mode, or an ancestor someone else
 * could swap it through), or null when it is. Ancestors are checked on the resolved path: each must belong to the
 * current user or root and must not be group/other-writable unless sticky (like /tmp). `ignoreMode`: skip the leaf's
 * mode check (the caller is about to chmod its own folder).
 */
export function posixDirProblem(dir: string, ignoreMode: boolean): string | null {
  const uid = process.getuid?.();
  let st;
  try { st = lstatSync(dir); } catch (e) { return (e as Error).message; }
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "klasör değil";
  if (uid !== undefined && st.uid !== uid) return "sahibi başka kullanıcı";
  if (!ignoreMode && (st.mode & 0o077) !== 0) return `izinler gevşek: ${(st.mode & 0o777).toString(8)}`;
  let p: string;
  try { p = realpathSync(dir); } catch (e) { return (e as Error).message; }
  for (let a = dirname(p); ; a = dirname(a)) {
    let s;
    try { s = lstatSync(a); } catch (e) { return (e as Error).message; }
    if (uid !== undefined && s.uid !== uid && s.uid !== 0) return `ata klasörün sahibi başka kullanıcı: ${a}`;
    if ((s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0) return `ata klasör başkasınca yazılabilir (sticky yok): ${a} (${(s.mode & 0o777).toString(8)})`;
    if (dirname(a) === a) return null;
  }
}

/** Creates `dir` (0700) and tightens an existing own folder to 0700; throws if it is unsafe (single check shared by the queue and `--external`). */
export function securePosixDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bad = posixDirProblem(dir, true);
  if (bad) throw new Error(`${dir}: ${bad}`);
  chmodSync(dir, 0o700);
}
