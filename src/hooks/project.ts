import { win32 } from "node:path";

function norm(p: string): string {
  return win32.normalize(p).toLowerCase().replace(/[\\/]+$/, "");
}

function under(cwd: string, base: string): boolean {
  return cwd === base || cwd.startsWith(base + "\\");
}

/** Maps a cwd to a project slug (project path, its `-wt` worktree dir, or VLAD home -> "vlad"). Longest match wins. */
export function inferProject(
  cwd: string,
  projects: { slug: string; path: string }[],
  vladHome: string,
): string | null {
  const c = norm(cwd);
  const candidates = [...projects.map((p) => ({ slug: p.slug, base: norm(p.path) })), { slug: "vlad", base: norm(vladHome) }];
  let slug: string | null = null;
  let len = -1;
  for (const cand of candidates) {
    if (!cand.base) continue;
    if ((under(c, cand.base) || under(c, cand.base + "-wt")) && cand.base.length > len) {
      slug = cand.slug;
      len = cand.base.length;
    }
  }
  return slug;
}
