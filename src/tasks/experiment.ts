import { readDoc } from "../kb/index.js";
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

export const withoutPonytail = <R extends { skills?: string[] }>(role: R): R & { ponytailOff: true } => ({ ...role, skills: (role.skills ?? []).filter((s) => s !== "ponytail"), ponytailOff: true });

/** Added to the prompt of an off-arm task whose worker still reads the role file (local/remote): the role's ponytail bullet must not apply. */
export const PONYTAIL_OFF_NOTE = "ponytail KAPALI (A/B deney kolu): rol dosyasındaki `**ponytail (deneme):**` maddesini tamamen yok say; ponytail'i yükleme ve uygulama.";

/** Role body without the ponytail rule bullet (cloud prompts embed the body, so the off arm never sees it). */
export const stripPonytailParagraph = (body: string): string => body.split("\n").filter((l) => !l.includes("**ponytail (deneme):**")).join("\n");

/**
 * The single filter for the off arm (F-vlad-161): the role file's body without the ponytail bullet. Local, `--external`, remote
 * and cloud (inline) prompts embed this instead of pointing the worker at the role file, so no ponytail text or vendored path reaches it.
 */
export const ponytailOffRoleBody = (roleFile: string): string => stripPonytailParagraph(readDoc<unknown>(roleFile).body.trim());

/**
 * ponytail A/B validity (T20261103-26): launch/resume prompts were cut at the first `"` before this fix (Windows PowerShell
 * 5.1 native-argument quoting), so the off arm never got its skill list and standard blocks. Arm tasks created before this
 * instant are left out of `audit setup`'s `by_ponytail` split. If the experiment is reopened, nothing to change; if the
 * fix is reverted, move this forward.
 */
export const PONYTAIL_AB_VALID_FROM = "2026-11-03T12:00:00+03:00";
