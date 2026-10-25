import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** VLAD root: $VLAD_HOME if set, otherwise the repo root (dist/kb/home.js -> two levels up). */
export function getVladHome(): string {
  const env = process.env.VLAD_HOME;
  if (env) return env;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Where the kb lives: $VLAD_KB_DIR, then `kbDir` in <home>/vlad.config.json (relative to home or
 * absolute), else the legacy <home>/kb. `explicit` is false only for the legacy default.
 * Read straight from the JSON (not loadConfig) so schema validation can stay out of path lookup.
 */
export function resolveKbDir(home: string = getVladHome()): { dir: string; explicit: boolean } {
  const env = process.env.VLAD_KB_DIR;
  if (env) return { dir: resolve(home, env), explicit: true };
  const file = join(home, "vlad.config.json");
  if (existsSync(file)) {
    try {
      const kbDir = (JSON.parse(readFileSync(file, "utf8")) as { kbDir?: unknown }).kbDir;
      if (typeof kbDir === "string" && kbDir) {
        return { dir: isAbsolute(kbDir) ? kbDir : resolve(home, kbDir), explicit: true };
      }
    } catch {
      /* unreadable config is reported by loadConfig; fall back to the legacy location */
    }
  }
  return { dir: join(home, "kb"), explicit: false };
}

/** True when the kb is its own repo checkout rather than the legacy <home>/kb inside the VLAD repo. */
export function isSeparateKb(home: string = getVladHome()): boolean {
  return resolve(resolveKbDir(home).dir) !== resolve(join(home, "kb"));
}

export interface KbPaths {
  home: string;
  kb: string;
  projects: string;
  tasks: string;
  findings: string;
  cards: string;
  inbox: string;
  processed: string;
  logs: string;
  journal: string;
  decisions: string;
  schemas: string;
  roles: string;
}

export function kbPaths(home: string = getVladHome()): KbPaths {
  const { dir: kb, explicit } = resolveKbDir(home);
  if (explicit && !existsSync(kb)) {
    throw new Error(`kb deposu bulunamadı: ${kb} — \`git clone https://github.com/iamhankaya/vlad-kb ${kb}\``);
  }
  const inbox = join(kb, "inbox");
  return {
    home,
    kb,
    projects: join(kb, "projects"),
    tasks: join(kb, "tasks"),
    findings: join(kb, "findings"),
    cards: join(kb, "cards"),
    inbox,
    processed: join(inbox, "processed"),
    logs: join(kb, "logs"),
    journal: join(kb, "journal"),
    decisions: join(kb, "decisions.md"),
    schemas: join(home, "schemas"),
    roles: join(home, "roles"),
  };
}
