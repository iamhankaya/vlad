import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { recentCommits } from "../git/git.js";
import { kbPaths, type VladConfig } from "../kb/index.js";

export type RepoInfo = {
  slug: string;
  path: string;
  readme: string | null;
  manifest: Record<string, unknown> | null;
  commits: { sha: string; subject: string; date: string }[];
  hasCard: boolean;
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function globToRegex(glob: string): RegExp {
  const src = glob.replace(/[\^$.+()|{}\[\]]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
}

function readReadme(dir: string): string | null {
  const name = readdirSync(dir).find((f) => /^readme(\.[a-z]+)?$/i.test(f));
  if (!name) return null;
  return readFileSync(join(dir, name), "utf8").slice(0, 4096);
}

function readManifest(dir: string): Record<string, unknown> | null {
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8"));
      return {
        name: j.name,
        description: j.description,
        dependencies: Object.keys(j.dependencies ?? {}),
        scripts: Object.keys(j.scripts ?? {}),
      };
    } catch {
      return { file: "package.json" };
    }
  }
  const other = readdirSync(dir).find((f) => f === "pyproject.toml" || f.endsWith(".csproj"));
  return other ? { file: other } : null;
}

function readCommits(dir: string): RepoInfo["commits"] {
  return recentCommits(dir, null, 20);
}

export function scanRoots(cfg: VladConfig): RepoInfo[] {
  const ignores = cfg.ignore.map(globToRegex);
  const projectsDir = kbPaths().projects;
  const repos: RepoInfo[] = [];
  for (const root of cfg.roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (ignores.some((r) => r.test(name))) continue;
      const path = join(root, name);
      try {
        if (!statSync(path).isDirectory() || !existsSync(join(path, ".git"))) continue;
      } catch {
        continue;
      }
      const slug = slugify(name);
      repos.push({
        slug,
        path,
        readme: readReadme(path),
        manifest: readManifest(path),
        commits: readCommits(path),
        hasCard: existsSync(join(projectsDir, `${slug}.md`)),
      });
    }
  }
  return repos;
}
