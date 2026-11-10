import { readdirSync } from "node:fs";
import { kbPaths } from "../kb/index.js";
import { getFinding } from "../findings/store.js";
import { kbWriteKeys, refreshKeys } from "../commands/accessors.js";
import { activityListsId } from "../projects/derived.js";
import { launchTask, getTask } from "../tasks/index.js";
import type { Opts } from "./ctx.js";

/**
 * Commands that write the kb run under the cross-process kb lock (F-vlad-096): ID generation and the write
 * share one lock region. Read-only commands, `kb commit` (takes the lock itself around add+commit only, never during the push; F-vlad-103) and
 * `task close-window` (no kb write) stay lock-free. `task launch` locks only its kb write regions inside
 * `launchTask` (F-vlad-102), never the worktree/terminal wait. `status`/`mode status` write only as a side effect
 * (stalled marks, expired mode window), so they lock unless `--no-mark` is given.
 */
export const KB_WRITES: ReadonlySet<string> = kbWriteKeys(); // derived from the manifest (src/commands/manifest.ts)
/** Commands whose kb write also refreshes derived project-card blocks (`runAndRefresh`). */
export const REFRESH_KEYS: ReadonlySet<string> = refreshKeys();

/** Projects whose derived block `which` a command may have changed; each hook refreshes only that block (a task scan costs ~1.7 s on 600+ tasks). */
export function targetsOf(key: string, args: any[]): { slugs: (string | undefined)[]; only: "findings" | "activity"; fast?: boolean } | null {
  const o = args[args.length - 2] as Opts;
  switch (key) {
    case "project write": return { slugs: [String(args[0])], only: "findings" }; // the card was replaced: the findings block is cheap, activity waits for `project refresh`
    case "finding add": return { slugs: [String(o.project)], only: "findings" };
    case "idea from-finding": return { slugs: [...new Set((args[0] as string[]).map((id) => getFinding(id).data.project))], only: "findings" };
    case "finding set": return { slugs: [...new Set((args[0] as string[]).slice(0, -1).map((id) => getFinding(id).data.project))], only: "findings" };
    // an added decision only pushes entries out of the list: no task scan (fast). One that leaves the valid list (`set`, or the superseded one) matters only when the block shows it, and then needs the scan.
    // the superseded decision may belong to another project: that card's block still lists it (F-vlad-190)
    case "decision add": return { slugs: [String(o.project), decisionProject(o.supersedes)], only: "activity", fast: !o.supersedes };
    case "decision set": {
      const id = String(args[0]), p = decisionProject(id);
      if (p && args[1] !== "geçerli" && !activityListsId(p, id)) return null;
      return { slugs: [p], only: "activity" };
    }
    // `task digested` re-stamps `updated` (moves the date in Son aktivite); `decision migrate` / `kb maintain` (decisions.md split) change the decision list. A dry run writes nothing.
    case "task digested": return { slugs: (args[0] as string[]).map((id) => getTask(id).data.project), only: "activity" };
    case "decision migrate":
    case "kb maintain": return o.dryRun ? null : { slugs: allCardSlugs(), only: "activity" };
    case "task set": return String(args[1]) === "done" ? { slugs: [getTask(String(args[0])).data.project], only: "activity" } : null;
  }
  return null;
}
/** `D-<proje>-NNN` → proje slug'ı (kimlik değilse undefined). */
const decisionProject = (id: unknown): string | undefined => /^D-([a-z0-9][a-z0-9-]*)-\d{3,}$/.exec(String(id ?? ""))?.[1];
/** Every project card's slug (the hook skips cards that do not exist or whose block is missing). */
const allCardSlugs = (): string[] => { try { return readdirSync(kbPaths().projects).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)); } catch { return []; } };
