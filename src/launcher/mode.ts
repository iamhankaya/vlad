import { isCloudEnv } from "../kb/env.js";
import type { Launcher } from "../kb/types.js";

export type LaunchMode = "cloud" | "process" | "wt" | "powershell" | "auto-terminal";

/**
 * Picks how `vlad task launch` starts a worker. `auto` keeps the Windows terminal behavior on
 * Windows; elsewhere it selects the cloud launcher when a cloud session is detected and the
 * systemd process launcher otherwise.
 */
export function resolveLaunchMode(
  launcher: Launcher, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
): LaunchMode {
  if (launcher === "cloud" || launcher === "process") return launcher;
  if (launcher !== "auto") return launcher;
  if (platform === "win32") return "auto-terminal";
  if (isCloudEnv(env)) return "cloud";
  return "process";
}
