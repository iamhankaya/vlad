import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, readDoc, validate, type RoleData } from "../kb/index.js";

export type Role = RoleData & { file: string; skills: string[] };

function readRole(file: string, name: string): Role {
  const { data } = readDoc<RoleData>(file);
  validate("role", data);
  const slug = name.replace(/\.md$/, "");
  if (data.slug !== slug) throw new Error(`slug uyuşmuyor: dosya "${slug}", rol "${data.slug}"`);
  return { slug: data.slug, title: data.title, kind: data.kind, summary: data.summary, skills: data.skills ?? [], file };
}

/** Valid roles in name order; unreadable or invalid files are skipped and reported as warnings. */
export function listRolesWithWarnings(dir: string = kbPaths().roles): { roles: Role[]; warnings: string[] } {
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
  const dir = kbPaths().roles;
  const file = join(dir, `${slug}.md`);
  if (!/^[a-z][a-z0-9-]*$/.test(slug) || !existsSync(file)) {
    const known = listRolesWithWarnings(dir).roles.map((r) => r.slug);
    throw new Error(`rol bulunamadı: ${slug}; mevcut: ${known.join(", ") || "(yok)"}`);
  }
  return readRole(file, `${slug}.md`);
}
