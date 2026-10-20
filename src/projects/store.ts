import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, parseDoc, readDoc, validate, writeDoc, type Exposure, type ProjectCard } from "../kb/index.js";

export function writeProject(slug: string, md: string): ProjectCard {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`geçersiz slug: "${slug}" (yalnızca a-z, 0-9 ve '-')`);
  }
  const { data, body } = parseDoc<ProjectCard>(md);
  if (data.slug !== slug) {
    throw new Error(`slug uyuşmuyor: dosya "${slug}", kart "${data.slug}"`);
  }
  validate("project", data);
  writeDoc(join(kbPaths().projects, `${slug}.md`), data, body);
  return data;
}

export type ProjectSummary = {
  slug: string;
  path: string;
  status: string;
  last_activity: string | null;
  exposure?: Exposure;
};

/** Valid cards in name order; unreadable or invalid cards are skipped and reported as warnings. */
export function listProjectsWithWarnings(): { projects: ProjectSummary[]; warnings: string[] } {
  const dir = kbPaths().projects;
  const projects: ProjectSummary[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { projects, warnings };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    try {
      const { data } = readDoc<ProjectCard>(join(dir, f));
      validate("project", data);
      projects.push({
        slug: data.slug,
        path: data.path,
        status: data.status,
        last_activity: data.last_activity,
        ...(data.exposure ? { exposure: data.exposure } : {}),
      });
    } catch (e) {
      warnings.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { projects, warnings };
}

export function listProjects(): ProjectSummary[] {
  return listProjectsWithWarnings().projects;
}
