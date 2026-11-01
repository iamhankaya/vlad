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

/** Claude Code accepts 100000–1000000 tokens; `k`/`M` suffix allowed. */
export function autoCompactTokens(v: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(v);
  return m ? Number(m[1]) * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1) : NaN;
}

/** Defaults overlaid with <home>/vlad.config.json (shallow), then validated. */
export function loadConfig(home: string = getVladHome()): VladConfig {
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
  if (cfg.workerAutoCompact) {
    const n = autoCompactTokens(cfg.workerAutoCompact);
    if (!(n >= 100000 && n <= 1000000)) throw new Error(`config: workerAutoCompact 100000–1000000 aralığında olmalı: ${cfg.workerAutoCompact}`);
  }
  return cfg;
}

export function autonomyFor(cfg: VladConfig, slug: string): Autonomy {
  return cfg.projects[slug]?.autonomy ?? cfg.defaultAutonomy;
}
