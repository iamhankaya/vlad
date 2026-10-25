import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEMVER = /^\d+\.\d+\.\d+$/;

/** Negative when a < b, 0 when equal, positive when a > b. Both must be `x.y.z`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** Version of this CLI build (package.json two levels above dist/kb/version.js). */
export function cliVersion(): string {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/**
 * Throws when `<home>/vlad.config.json` demands a newer CLI than `current`. Reads the raw file on purpose:
 * an unreadable or invalid config is reported by the command's own loadConfig, not here.
 */
export function checkMinCliVersion(home: string, current: string = cliVersion()): void {
  const file = join(home, "vlad.config.json");
  if (!existsSync(file)) return;
  let min: unknown;
  try {
    min = (JSON.parse(readFileSync(file, "utf8")) as { minCliVersion?: unknown }).minCliVersion;
  } catch {
    return;
  }
  if (min === undefined || min === null) return;
  // fail-closed: bozuk sürüm kapısı sessizce kapanmaz
  if (typeof min !== "string" || !SEMVER.test(min)) {
    throw new Error(`minCliVersion geçersiz: ${typeof min === "string" ? min : JSON.stringify(min)} (x.y.z olmalı)`);
  }
  if (compareVersions(current, min) < 0) throw new Error(`VLAD CLI çok eski: ${min} gerekli (kurulu: ${current})`);
}
