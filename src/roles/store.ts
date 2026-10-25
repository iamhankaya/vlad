import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getVladHome, readDoc, validate, type RoleData } from "../kb/index.js";

export type Role = Omit<RoleData, "model"> & { file: string; skills: string[]; model: string | null };

/**
 * Skills the VLAD repo carries as plain files instead of under `.claude/skills`, where they would be
 * listed in every session of the repo whatever the task. A role naming one gets "read this file and
 * apply it" in the worker prompt instead of "load this skill". Paths are relative to VLAD_HOME.
 */
const VENDORED_SKILLS: Record<string, string> = { ponytail: "vendor/skills/ponytail/SKILL.md" };

/** Splits a role's skills into ones the worker loads by name and vendored ones with the file to read. */
export function splitSkills(skills: string[], roleFile: string): { load: string[]; vendored: { name: string; file: string }[] } {
  const home = resolve(dirname(roleFile), "..");
  return {
    load: skills.filter((s) => !Object.hasOwn(VENDORED_SKILLS, s)),
    vendored: skills.filter((s) => Object.hasOwn(VENDORED_SKILLS, s)).map((name) => ({ name, file: join(home, VENDORED_SKILLS[name]) })),
  };
}

function readRole(file: string, name: string): Role {
  const { data } = readDoc<RoleData>(file);
  validate("role", data);
  const slug = name.replace(/\.md$/, "");
  if (data.slug !== slug) throw new Error(`slug uyuşmuyor: dosya "${slug}", rol "${data.slug}"`);
  return { slug: data.slug, title: data.title, kind: data.kind, summary: data.summary, skills: data.skills ?? [], model: data.model ?? null, file };
}

/** Valid roles in name order; unreadable or invalid files are skipped and reported as warnings. */
export function listRolesWithWarnings(dir: string = join(getVladHome(), "roles")): { roles: Role[]; warnings: string[] } {
  const roles: Role[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { roles, warnings };
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    try {
      roles.push(readRole(join(dir, name), name));
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { roles, warnings };
}

export function getRole(slug: string): Role {
  const dir = join(getVladHome(), "roles");
  const file = join(dir, `${slug}.md`);
  if (!/^[a-z][a-z0-9-]*$/.test(slug) || !existsSync(file)) {
    const known = listRolesWithWarnings(dir).roles.map((r) => r.slug);
    throw new Error(`rol bulunamadı: ${slug}; mevcut: ${known.join(", ") || "(yok)"}`);
  }
  return readRole(file, `${slug}.md`);
}
