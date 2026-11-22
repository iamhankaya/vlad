import { selfName } from "../fleet/state.js";
import { runGitRaw } from "../git/git.js";
import { kbPaths } from "../kb/home.js";
import type { VladConfig } from "../kb/types.js";

/**
 * F-vlad-357: `monitor pull` writes tasks to the kb but never commits; of the given task ids, those whose `tasks/<id>.md`
 * is new or changed in the kb working tree (the SessionStart line reminds VLAD to `vlad kb commit --push`). Failure → [].
 */
export function uncommittedTaskIds(ids: string[]): string[] {
  if (!ids.length) return [];
  let root: string;
  try { root = kbPaths().kb; } catch { return []; }
  const out = runGitRaw(root, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall", "--", "tasks"], 10000);
  if (!out) return [];
  const dirty = new Set(out.split("\n").map((l) => /(?:^|\/)([^/]+)\.md"?$/.exec(l.slice(3))?.[1]).filter((x): x is string => !!x));
  return ids.filter((id) => dirty.has(id));
}

export interface KbDirty { machine: string; files: string[]; message: string }

/**
 * F-vlad-196: on a machine that is not the brain the kb clone is read-only; uncommitted changes there never reach the brain.
 * Returns the warning, or null (single machine, this is the brain, identity unknown, kb not a repo, or clean).
 */
export function kbDirtyOnWorker(cfg: VladConfig): KbDirty | null {
  if (!cfg.machines || !cfg.brain) return null;
  let machine: string;
  let root: string;
  try { machine = selfName(); root = kbPaths().kb; } catch { return null; }
  if (machine === cfg.brain) return null;
  const out = runGitRaw(root, ["-c", "core.quotepath=false", "status", "--porcelain"], 10000);
  if (!out) return null;
  const files = out.split("\n").map((l) => l.slice(3).replace(/^"|"$/g, "")).filter(Boolean);
  if (!files.length) return null;
  const shown = files.slice(0, 5).join(", ") + (files.length > 5 ? ` (+${files.length - 5})` : "");
  return {
    machine, files,
    message: `kb'de commit'lenmemiş ${files.length} değişiklik (${machine} beyin değil; bunlar beyine ulaşmaz): ${shown}. ` +
      `Kurtarma: ayrı dala commit'le (git -C <kb> switch -c kurtarma-${machine} && git commit -am ...), değişikliği beyinde vlad CLI ile yeniden yaz, sonra bu klonu temizle`,
  };
}
