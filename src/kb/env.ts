/** True inside a Claude Code cloud (remote) session; `CLAUDE_CODE_REMOTE=true` is set there. */
export function isCloudEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
}

/** In the cloud the daily task sequence starts here, so ids never collide with the local VLAD's. */
export const CLOUD_ID_FLOOR = 50;
