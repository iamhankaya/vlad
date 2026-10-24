import { hostname } from "node:os";
import type { ProjectCard } from "./types.js";

export const MACHINE_NAME = /^[A-Za-z0-9._-]+$/;

/** This machine's name: `VLAD_MACHINE`, else the lower-cased hostname. */
export function currentMachine(env: NodeJS.ProcessEnv = process.env, host: () => string = hostname): string {
  const name = (env.VLAD_MACHINE?.trim() || host()).toLowerCase();
  if (!MACHINE_NAME.test(name)) throw new Error(`geçersiz makine adı: "${name}" (VLAD_MACHINE ile ayarla; yalnızca harf, rakam, . _ -)`);
  return name;
}

/**
 * Local path of a project on `machine`. A card without `paths` is single-machine: `path` applies everywhere.
 * Once `paths` is set it is authoritative, so a machine missing from it has no clone.
 */
export function resolveProjectPath(card: Pick<ProjectCard, "slug" | "path" | "paths">, machine: string = currentMachine()): string {
  const paths = card.paths;
  if (!paths || Object.keys(paths).length === 0) return card.path;
  const p = paths[machine];
  if (!p) throw new Error(`bu makinede klon yok: ${card.slug}; \`vlad project clone ${card.slug}\` çalıştır`);
  return p;
}
