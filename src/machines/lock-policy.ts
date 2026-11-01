import type { VladConfig } from "../kb/types.js";

/** Commands whose handler locks the kb itself, in phases, once workers can be remote (no network inside the lock). */
export const INNER_LOCK = new Set(["task resume", "task cleanup"]);

/**
 * "outer": the whole callback runs under the kb lock (today's KB_WRITES); "inner": the handler locks its own
 * kb regions; "none": lock-free. Without `machines` nothing changes: resume/cleanup stay "outer".
 */
export function lockPolicyOf(key: string, kbWrites: ReadonlySet<string>, cfg: Pick<VladConfig, "machines">): "outer" | "inner" | "none" {
  if (!kbWrites.has(key)) return "none";
  return cfg.machines && INNER_LOCK.has(key) ? "inner" : "outer";
}
