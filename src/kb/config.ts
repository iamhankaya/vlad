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
  checkMachines(cfg);
  return cfg;
}

/** machines çapraz doğrulaması (şemanın ifade edemediği kurallar); `machines` yoksa hiçbir şey denetlenmez. */
function checkMachines(cfg: VladConfig): void {
  const { machines, brain, consoles } = cfg;
  if (!machines) {
    if (brain || consoles?.length) throw new Error("config: brain/consoles yalnız machines tanımlıyken kullanılır");
    return;
  }
  const names = machines.map((m) => m.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`config: makine adı birden fazla tanımlı: ${dup}`);
  if (!brain) throw new Error("config: machines varsa brain zorunlu");
  if (!names.includes(brain)) throw new Error(`config: brain machines içinde değil: ${brain}`);
  const clash = consoles?.find((c) => names.includes(c.name));
  if (clash) throw new Error(`config: konsol adı makine adıyla çakışıyor: ${clash.name}`);
  const cn = (consoles ?? []).map((c) => c.name);
  const cdup = cn.find((n, i) => cn.indexOf(n) !== i);
  if (cdup) throw new Error(`config: konsol adı birden fazla tanımlı: ${cdup}`);
  const noHost = machines.find((m) => m.name !== brain && !m.agent.host);
  if (noHost) throw new Error(`config: ${noHost.name}: brain dışındaki makinede agent.host zorunlu`);
}

export function autonomyFor(cfg: VladConfig, slug: string): Autonomy {
  return cfg.projects[slug]?.autonomy ?? cfg.defaultAutonomy;
}
