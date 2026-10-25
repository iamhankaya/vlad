import { isCloudEnv } from "../kb/env.js";
import type { Launcher } from "../kb/types.js";

export type LaunchMode = "cloud" | "wt" | "powershell" | "auto-terminal" | "noop";

/** F-vlad-064: VLAD_LAUNCHER=noop (set by vitest) forbids real terminals/processes unless VLAD_ALLOW_REAL_LAUNCHER=1. */
export const realLauncherBlocked = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.VLAD_LAUNCHER === "noop" && !env.VLAD_ALLOW_REAL_LAUNCHER;

export function assertRealLauncherAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (realLauncherBlocked(env)) {
    throw new Error("VLAD_LAUNCHER=noop: gerçek terminal/süreç başlatmak yasak (gerekiyorsa VLAD_ALLOW_REAL_LAUNCHER=1)");
  }
}

/**
 * Picks how `vlad task launch` starts a worker (`noop` under the test guard, except for cloud). `auto` keeps the Windows terminal behavior on
 * Windows; elsewhere it selects the cloud launcher when a cloud session is detected and fails otherwise.
 */
export function resolveLaunchMode(
  launcher: Launcher, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
): LaunchMode {
  if (launcher === "cloud") return "cloud";
  const noop = realLauncherBlocked(env);
  if (launcher !== "auto") return noop ? "noop" : launcher;
  if (platform === "win32") return noop ? "noop" : "auto-terminal";
  if (isCloudEnv(env)) return "cloud";
  throw new Error(
    "launcher=auto: Windows dışında yalnızca bulut ortamı desteklenir ve bulut algılanmadı " +
      "(CLAUDE_CODE_REMOTE=true yok); vlad.config.json'da launcher'ı açıkça ayarla",
  );
}
