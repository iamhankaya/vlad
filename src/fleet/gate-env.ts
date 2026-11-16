import type { VladConfig } from "../kb/types.js";

/**
 * Makine başına gate ortamı (T20261117-04): config'te makine girişinin `gateEnv` alanı, proje slug'ı → değişken adı → değer.
 * Değerde `$VAR` / `${VAR}` `base` ortamından açılır (`$PATH` genişletmesi); tanımsız değişken boş olur.
 * shortcut: tek geçişli açılım, kaçış/iç içe yok; karmaşık gerekirse gate komutunu betiğe taşı.
 */
export const rawGateEnv = (cfg: VladConfig, machine: string | null | undefined, project: string): Record<string, string> =>
  (machine ? cfg.machines?.find((m) => m.name === machine)?.gateEnv?.[project] : undefined) ?? {};

export function gateEnvOf(cfg: VladConfig, machine: string | null | undefined, project: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = rawGateEnv(cfg, machine, project);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, a: string | undefined, b: string | undefined) => base[(a ?? b)!] ?? "");
  }
  return out;
}

/** `{...process.env, ...gateEnv}`; gateEnv boşsa undefined (spawn varsayılanı: süreç ortamı). */
export const withGateEnv = (env: Record<string, string>): NodeJS.ProcessEnv | undefined => (Object.keys(env).length ? { ...process.env, ...env } : undefined);
