import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getVladHome } from "./home.js";
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

/** Defaults overlaid with <home>/vlad.config.json (shallow), then validated. */
export function loadConfig(home: string = getVladHome()): VladConfig {
  const file = join(home, "vlad.config.json");
  const user = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const cfg = { ...defaultConfig(), ...user } as VladConfig;
  validate("config", cfg);
  return cfg;
}

export function autonomyFor(cfg: VladConfig, slug: string): Autonomy {
  return cfg.projects[slug]?.autonomy ?? cfg.defaultAutonomy;
}
