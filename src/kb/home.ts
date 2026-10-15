import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** VLAD root: $VLAD_HOME if set, otherwise the repo root (dist/kb/home.js -> two levels up). */
export function getVladHome(): string {
  const env = process.env.VLAD_HOME;
  if (env) return env;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export interface KbPaths {
  home: string;
  kb: string;
  projects: string;
  tasks: string;
  inbox: string;
  processed: string;
  logs: string;
  journal: string;
  decisions: string;
  schemas: string;
  roles: string;
}

export function kbPaths(home: string = getVladHome()): KbPaths {
  const kb = join(home, "kb");
  const inbox = join(kb, "inbox");
  return {
    home,
    kb,
    projects: join(kb, "projects"),
    tasks: join(kb, "tasks"),
    inbox,
    processed: join(inbox, "processed"),
    logs: join(kb, "logs"),
    journal: join(kb, "journal"),
    decisions: join(kb, "decisions.md"),
    schemas: join(home, "schemas"),
    roles: join(home, "roles"),
  };
}
