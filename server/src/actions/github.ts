/**
 * Read side of GitHub as the approval path needs it. S9a only reads; the real client and every write (`GithubWriter`:
 * check-run, merge) come with S9b. The shapes follow the recorded responses in `contract/fixtures/external/github-rest/`.
 */
export type PullFacts = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** `null`: GitHub has not computed it yet (first call after a push). */
  mergeable: boolean | null;
  mergeable_state: string;
  head: { sha: string; ref: string };
  base: { ref: string };
};

export type CheckRun = { name: string; status: string; conclusion: string | null };
export type CombinedStatus = { state: string; total_count: number };

export interface GithubReader {
  /** `null` when the PR does not exist (404). Any other failure throws. */
  getPull(repo: string, pr: number): Promise<PullFacts | null>;
  getCheckRuns(repo: string, sha: string): Promise<CheckRun[]>;
  getCombinedStatus(repo: string, sha: string): Promise<CombinedStatus>;
}

/** Maps a `GET /repos/{o}/{r}/pulls/{n}` body; throws on a shape it does not know rather than guessing. */
export function toPullFacts(body: any): PullFacts {
  const ok =
    body && typeof body === "object" && Number.isInteger(body.number) && (body.state === "open" || body.state === "closed") &&
    typeof body.head?.sha === "string" && typeof body.head?.ref === "string" && typeof body.base?.ref === "string" &&
    (body.mergeable === null || typeof body.mergeable === "boolean") && typeof body.mergeable_state === "string";
  if (!ok) throw new Error("GitHub PR yanıtı beklenen biçimde değil");
  return {
    number: body.number, state: body.state, merged: body.merged === true, draft: body.draft === true,
    mergeable: body.mergeable, mergeable_state: body.mergeable_state, head: { sha: body.head.sha, ref: body.head.ref }, base: { ref: body.base.ref },
  };
}

export type CiState = "green" | "red" | "pending" | "none";

/** The check-run `vlad-gate` writes itself (S9b); it is the result of an approval, never an input to CI health. */
export const APPROVED_CHECK = "vlad/approved";

const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const PASS = new Set(["success", "neutral", "skipped"]);

/**
 * CI health of a commit from its check-runs and combined status. Any failing signal is `red`; anything unfinished
 * is `pending`; no signal at all is `none` (an unconfigured CI is not "green").
 */
export function ciState(runs: CheckRun[], status: CombinedStatus): CiState {
  const relevant = runs.filter((r) => r.name !== APPROVED_CHECK);
  const hasStatus = status.total_count > 0;
  if (!relevant.length && !hasStatus) return "none";
  if (relevant.some((r) => r.status === "completed" && r.conclusion !== null && FAIL.has(r.conclusion))) return "red";
  if (hasStatus && (status.state === "failure" || status.state === "error")) return "red";
  if (relevant.some((r) => r.status !== "completed" || r.conclusion === null || !PASS.has(r.conclusion))) return "pending";
  if (hasStatus && status.state !== "success") return "pending";
  return "green";
}
