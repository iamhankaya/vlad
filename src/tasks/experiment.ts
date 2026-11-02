import type { VladConfig } from "../kb/index.js";

export type PonytailArm = "on" | "off";

/**
 * ponytail A/B (T20261102-16): with `experiments.ponytail: "ab"` a task whose role names ponytail runs without it
 * when the last digit of its id is odd. Anything else (flag off, role without ponytail) is outside the experiment.
 */
export function ponytailArm(taskId: string, role: { skills?: string[] } | null | undefined, cfg: Pick<VladConfig, "experiments">): PonytailArm | undefined {
  if (cfg.experiments?.ponytail !== "ab" || !role?.skills?.includes("ponytail")) return undefined;
  const d = /(\d)$/.exec(taskId);
  return d && Number(d[1]) % 2 === 1 ? "off" : "on";
}

export const withoutPonytail = <R extends { skills?: string[] }>(role: R): R => ({ ...role, skills: (role.skills ?? []).filter((s) => s !== "ponytail") });
