import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getVladHome, parseDoc, validate, type RoleData } from "../kb/index.js";
import { ParseCache } from "../kb/parse-cache.js";

export type Role = Omit<RoleData, "model"> & { file: string; skills: string[]; model: string | null };

/**
 * Uzak istem şablonundaki `{{ROLE_FILE:<slug>}}` yer tutucusunu verilen VLAD_HOME'a göre doldurur
 * (işçi kendi yoluyla çözer). Bilinmeyen slug dokunulmadan kalır: yol dışarı kaçamaz.
 */
export function fillRolePlaceholders(s: string, home: string): string {
  return s.replace(/\{\{ROLE_FILE:([a-z0-9][a-z0-9-]{0,63})\}\}/g, (_m, slug: string) => join(home, "roles", `${slug}.md`));
}

/**
 * Retired advisor slugs. They stay valid role names (old tasks keep `role: finans`; `--role finans` still works) and
 * resolve to `roles/advisor.md` with the old slug as the focus, which is appended to the title the worker prompt shows.
 */
export const ADVISOR_ALIASES: readonly string[] = ["finans", "pazarlama", "growth"];

/** Parsed role files (`ParseCache`, symlinks refused like `readDoc`): `task list --json` resolves the role of every task (T20261126-25). */
const parsedRoles = new ParseCache<Role>((text, file) => {
  const { data } = parseDoc<RoleData>(text);
  validate("role", data);
  const slug = basename(file).replace(/\.md$/, "");
  if (data.slug !== slug) throw new Error(`slug uyuşmuyor: dosya "${slug}", rol "${data.slug}"`);
  return { slug: data.slug, title: data.title, kind: data.kind, summary: data.summary, skills: data.skills ?? [], model: data.model ?? null, file };
}, true);
/** Entries held by the parse cache (test seam). */
export const parsedRoleCacheSize = (): number => parsedRoles.size;

function readRole(file: string): Role {
  const r = parsedRoles.get(file);
  return { ...r, skills: [...r.skills] };
}

/** Valid roles in name order; unreadable or invalid files are skipped and reported as warnings. */
export function listRolesWithWarnings(dir: string = join(getVladHome(), "roles")): { roles: Role[]; warnings: string[] } {
  const roles: Role[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { roles, warnings };
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    try {
      roles.push(readRole(join(dir, name)));
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { roles, warnings };
}

export function getRole(slug: string): Role {
  const dir = join(getVladHome(), "roles");
  const file = join(dir, `${slug}.md`);
  // a real roles/<slug>.md always wins; the alias only fills in once the old file is gone
  if (ADVISOR_ALIASES.includes(slug) && !existsSync(file) && existsSync(join(dir, "advisor.md"))) {
    const advisor = readRole(join(dir, "advisor.md"));
    return { ...advisor, title: `${advisor.title} — odak: ${slug}` };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(slug) || !existsSync(file)) {
    const known = listRolesWithWarnings(dir).roles.map((r) => r.slug);
    throw new Error(`rol bulunamadı: ${slug}; mevcut: ${known.join(", ") || "(yok)"}`);
  }
  return readRole(file);
}
