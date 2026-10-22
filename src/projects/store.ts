import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendToSection, kbPaths, parseDoc, readDoc, validate, writeDoc, type Exposure, type ProjectCard } from "../kb/index.js";

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
  gate?: string;
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
        ...(data.gate ? { gate: data.gate } : {}),
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

export const SETTABLE_FIELDS = ["exposure", "repo", "default_branch", "local_only", "local_only_reason", "gate"] as const;
export type SettableField = (typeof SETTABLE_FIELDS)[number];

/** Sets (or, with an empty value, removes) one optional card field; the rest of the card and its body stay as they are. */
export function setProjectField(slug: string, field: string, value: string): ProjectCard {
  if (!(SETTABLE_FIELDS as readonly string[]).includes(field)) {
    throw new Error(`bilinmeyen alan: "${field}" (geçerli: ${SETTABLE_FIELDS.join(", ")})`);
  }
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  const { data, body } = readDoc<ProjectCard>(file);
  const next: Record<string, unknown> = { ...data };
  if (value === "") {
    delete next[field];
  } else if (field === "local_only") {
    if (value !== "true" && value !== "false") throw new Error(`local_only için true|false bekleniyor: "${value}"`);
    next[field] = value === "true";
  } else {
    next[field] = value;
  }
  validate("project", next);
  writeDoc(file, next, body);
  return next as unknown as ProjectCard;
}

const NOTES = "## Çalışma notları";

/** Appends a dated bullet to the card's `## Çalışma notları` section (created if missing); frontmatter and other sections stay as they are. */
export function addProjectNote(slug: string, note: string, now: Date = new Date()): string {
  const text = note.trim().replace(/\s*\n\s*/g, " ");
  if (!text) throw new Error("not boş olamaz");
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  const { data, body } = readDoc<ProjectCard>(file);
  validate("project", data);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const line = `- ${date}: ${text}`;
  writeDoc(file, data, appendToSection(body, NOTES, line));
  return line;
}
