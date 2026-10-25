import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getVladHome } from "./home.js";
import { currentMachine } from "./machine.js";
import { validate } from "./schema.js";
import type { Autonomy, VladConfig } from "./types.js";

export function defaultConfig(): VladConfig {
  return {
    roots: ["C:\\dev"],
    ignore: ["*-wt", "node_modules", "vlad"],
    defaultAutonomy: "commit",
    staleAfterHours: 6,
    launcher: "auto",
    worktreeDir: "{repo}-wt",
    projects: {},
  };
}

/** `cfg` with `machines.<machine>` laid over the top-level keys; unlisted machines get `cfg` unchanged. */
export function machineOverlay(cfg: VladConfig, machine: string): VladConfig {
  return { ...cfg, ...cfg.machines?.[machine] };
}

/** Defaults overlaid with <home>/vlad.config.json (shallow), validated, then overlaid with this machine's entry. */
export function loadConfig(home: string = getVladHome(), machine: string = currentMachine()): VladConfig {
  const file = join(home, "vlad.config.json");
  let user: object = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`config okunamadı (${file}): ${(e as Error).message}`);
    }
  }
  const cfg = { ...defaultConfig(), ...user } as VladConfig;
  validate("config", cfg, home);
  return machineOverlay(cfg, machine);
}

export function autonomyFor(cfg: VladConfig, slug: string): Autonomy {
  return cfg.projects[slug]?.autonomy ?? cfg.defaultAutonomy;
}
