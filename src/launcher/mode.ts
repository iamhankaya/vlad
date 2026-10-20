import { isCloudEnv } from "../kb/env.js";
import type { Launcher } from "../kb/types.js";

export type LaunchMode = "cloud" | "wt" | "powershell" | "auto-terminal";

/**
 * Picks how `vlad task launch` starts a worker. `auto` keeps the Windows terminal behavior on
 * Windows; elsewhere it selects the cloud launcher when a cloud session is detected and fails otherwise.
 */
export function resolveLaunchMode(
  launcher: Launcher, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
): LaunchMode {
  if (launcher === "cloud") return "cloud";
  if (launcher !== "auto") return launcher;
  if (platform === "win32") return "auto-terminal";
  if (isCloudEnv(env)) return "cloud";
  throw new Error(
    "launcher=auto: Windows dışında yalnızca bulut ortamı desteklenir ve bulut algılanmadı " +
      "(CLAUDE_CODE_REMOTE=true yok); vlad.config.json'da launcher'ı açıkça ayarla",
  );
}
