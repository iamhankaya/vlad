import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/** Output lines of `git log` in `home` for `path`; empty when `home` is no repo, git is missing/slow, or the path has no commit. */
function gitLog(home: string, args: string[], path: string): string[] {
  try {
    const out = execFileSync("git", ["-C", home, "log", "--format=%cI", ...args, "--", path], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 8 << 20,
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

/** Committer date (ISO) of the latest commit touching `path`; null if never committed. */
export const lastChanged = (home: string, path: string): string | null => gitLog(home, ["-1"], path)[0] ?? null;

/** Committer date of the commit that added `path`; null if unknown. */
export const firstAdded = (home: string, path: string): string | null => gitLog(home, ["--reverse", "--diff-filter=A"], path)[0] ?? null;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Date the skill entered the role file for good: walks the file's commits newest to oldest and returns the
 * date of the oldest commit of the unbroken run in which the frontmatter lists the skill (a removed and
 * re-added skill counts from the re-adding). Null when HEAD's version lacks it (uncommitted) or git has no history.
 */
export function roleSkillSince(home: string, path: string, skill: string): string | null {
  const commits = gitLog(home, ["--format=%H %cI"], path).map((l) => l.split(" "));
  const line = new RegExp(`^\\s*-\\s+${esc(skill)}\\s*$`, "m");
  let since: string | null = null;
  for (const [sha, date] of commits) {
    let text: string;
    try { text = execFileSync("git", ["-C", home, "show", `${sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }); } catch { break; }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    if (!line.test(front)) break;
    since = date;
  }
  return since;
}

/** A directory entry that is, or links to, a directory (symlinks and Windows junctions included). */
function isDir(parent: string, e: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try { return statSync(join(parent, e.name)).isDirectory(); } catch { return false; }
}

/** Directory names under `dir` that hold a SKILL.md. */
export function skillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => isDir(dir, e) && existsSync(join(dir, e.name, "SKILL.md"))).map((e) => e.name);
}

/**
 * Skills installed for the user: `<claude config>/skills/<name>` (name as is) and plugin caches
 * `<claude config>/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>` (named `plugin:name`, one entry across versions).
 */
export function installedSkills(configDir: string): { name: string; source: "user" | "plugin" }[] {
  const found = new Map<string, "user" | "plugin">();
  for (const n of skillDirs(join(configDir, "skills"))) found.set(n, "user");
  const seen = new Set<string>(); // real paths: a link back into the tree cannot loop
  // shortcut: bounded walk (depth 7), plugin = the segment two below `cache`, `skills` must sit below the version
  // folder; a plugin without that layout is missed — upgrade here if one shows up
  const walk = (dir: string, parts: string[]) => {
    if (parts.length > 7 || !existsSync(dir)) return;
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!isDir(dir, e) || e.name === "node_modules" || e.name === ".git") continue;
      if (e.name === "skills" && parts.length >= 3) {
        for (const n of skillDirs(join(dir, e.name))) found.set(`${parts[1]}:${n}`, "plugin");
      } else walk(join(dir, e.name), [...parts, e.name]);
    }
  };
  walk(join(configDir, "plugins", "cache"), []);
  return [...found].map(([name, source]) => ({ name, source }));
}
