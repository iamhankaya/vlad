import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, parseDoc, readDoc, validate, writeDoc, type ProjectCard } from "../kb/index.js";

export function writeProject(slug: string, md: string): ProjectCard {
  const { data, body } = parseDoc<ProjectCard>(md);
  if (data.slug !== slug) {
    throw new Error(`slug uyuşmuyor: dosya "${slug}", kart "${data.slug}"`);
  }
  validate("project", data);
  writeDoc(join(kbPaths().projects, `${slug}.md`), data, body);
  return data;
}

export function listProjects(): { slug: string; path: string; status: string; last_activity: string | null }[] {
  const dir = kbPaths().projects;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const { data } = readDoc<ProjectCard>(join(dir, f));
      return { slug: data.slug, path: data.path, status: data.status, last_activity: data.last_activity };
    });
}
