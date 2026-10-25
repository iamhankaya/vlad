import { randomBytes } from "node:crypto";
import { challengeBytes, CHALLENGE_FIELDS } from "../auth/canonical.ts";

/** Challenge lifetime. `exp` is `floor(now_s) + 60`, and `now >= exp` is expired: exactly the 60th second is rejected, the 59th accepted. */
export const CHALLENGE_TTL_S = 60;

export type ChallengeFields = Record<(typeof CHALLENGE_FIELDS)[number], string>;

/** `A-` + 10 characters of Crockford base32 (50 random bits); matches `ActionId` and doubles as the state file name. */
export function newActionId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const b = randomBytes(10);
  return "A-" + Array.from(b, (x) => alphabet[x & 31]).join("");
}

export const newNonce = (): string => randomBytes(16).toString("base64url");

export const expiryOf = (nowMs: number): number => Math.floor(nowMs / 1000) + CHALLENGE_TTL_S;

/** `now >= exp` (seconds resolution on the server clock) is expired. */
export const isExpired = (nowMs: number, exp: number): boolean => nowMs >= exp * 1000;

export type BuiltChallenge = { fields: ChallengeFields; bytes: Uint8Array };

/** Builds the challenge byte string through the single canonical encoder; invalid values throw `CanonicalError`. */
export function buildChallenge(f: { actionId: string; kind: string; repo: string; pr: number; base: string; headSha: string; task: string; nonce: string; exp: number }): BuiltChallenge {
  const fields: ChallengeFields = {
    action_id: f.actionId, kind: f.kind, repo: f.repo, pr: String(f.pr), base: f.base, head_sha: f.headSha, task: f.task, nonce: f.nonce, exp: String(f.exp),
  };
  return { fields, bytes: challengeBytes(fields) };
}
