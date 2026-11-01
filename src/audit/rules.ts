import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Author-time ISO dates from the VLAD repo's git history; null when `home` is no repo or the path has no commit. */
function gitLog(home: string, args: string[], path: string): string[] {
  try {
    const out = execFileSync("git", ["-C", home, "log", "--format=%cI", ...args, "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

/** When `path` was last changed (null if never committed). */
export const lastChanged = (home: string, path: string): string | null => gitLog(home, ["-1"], path)[0] ?? null;

/** When `needle` first appeared in `path` (git pickaxe), e.g. the day a skill name entered a role file; null if unknown. */
export function firstAdded(home: string, path: string, needle?: string): string | null {
  const log = gitLog(home, ["--reverse", ...(needle ? ["-S", needle] : ["--diff-filter=A"])], path);
  return log[0] ?? null;
}

const hasSkill = (dir: string, name: string) => existsSync(join(dir, name, "SKILL.md"));

/** Directory names under `dir` that hold a SKILL.md. */
export function skillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && hasSkill(dir, e.name)).map((e) => e.name);
}

/**
 * Skills installed for the user: `<claude config>/skills/<name>` (name as is) and plugin caches
 * `<claude config>/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>` (named `plugin:name`, one entry across versions).
 */
export function installedSkills(configDir: string): { name: string; source: "user" | "plugin" }[] {
  const found = new Map<string, "user" | "plugin">();
  for (const n of skillDirs(join(configDir, "skills"))) found.set(n, "user");
  const cache = join(configDir, "plugins", "cache");
  // shortcut: bounded walk (depth 7), plugin = the segment two below `cache`; upgrade if a layout needs more
  const walk = (dir: string, parts: string[]) => {
    if (parts.length > 7 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue;
      if (e.name === "skills" && parts.length >= 3) {
        for (const n of skillDirs(join(dir, e.name))) found.set(`${parts[1]}:${n}`, "plugin");
      } else walk(join(dir, e.name), [...parts, e.name]);
    }
  };
  walk(cache, []);
  return [...found].map(([name, source]) => ({ name, source }));
}
