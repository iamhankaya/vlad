import { APPROVED_CHECK } from "../actions/github.ts";
import { GithubHttpError, REPO_RE, WRITE_CAP, type GithubClientLike } from "./client.ts";

const SHA = /^[0-9a-f]{40}$/;

export type MergeOutcome =
  | { kind: "merged"; sha: string }
  /** 409: the PR head is not the `sha` we sent. Nothing was merged. */
  | { kind: "head_moved" }
  /** 405/422: GitHub refuses (checks, review, conflict, ruleset). Nothing was merged. */
  | { kind: "not_mergeable"; message: string };

/**
 * Every GitHub write of the server is a method of this class, and nothing else imports `WRITE_CAP`. There are exactly
 * two: the `vlad/approved` check-run and the PR merge. No branch, ref, tag or contents endpoint is reachable from here.
 */
export class GithubWriter {
  private readonly c: GithubClientLike;
  constructor(client: GithubClientLike) {
    this.c = client;
  }

  /** `POST /repos/{r}/check-runs`: `vlad/approved` = success on exactly this head SHA. Returns the run id. */
  async writeApproved(repo: string, headSha: string, summary: string): Promise<number> {
    if (!REPO_RE.test(repo) || !SHA.test(headSha)) throw new GithubHttpError(0, "geçersiz repo ya da sha");
    const r = await this.c.request("POST", `/repos/${repo}/check-runs`, repo, {
      cap: WRITE_CAP,
      body: { name: APPROVED_CHECK, head_sha: headSha, status: "completed", conclusion: "success", output: { title: "VLAD onayı", summary: summary.slice(0, 500) } },
    });
    if (r.status !== 201 || !Number.isInteger(r.body?.id)) throw new GithubHttpError(r.status, `check-run yazılamadı (HTTP ${r.status})`);
    return r.body.id;
  }

  /** `PUT /repos/{r}/pulls/{n}/merge` with `sha` in the body: GitHub itself refuses (409) when the head is not that commit. */
  async merge(repo: string, pr: number, headSha: string): Promise<MergeOutcome> {
    if (!REPO_RE.test(repo) || !SHA.test(headSha) || !Number.isInteger(pr) || pr < 1) throw new GithubHttpError(0, "geçersiz repo, PR ya da sha");
    const r = await this.c.request("PUT", `/repos/${repo}/pulls/${pr}/merge`, repo, { cap: WRITE_CAP, body: { sha: headSha, merge_method: "merge" } });
    if (r.status === 200 && r.body?.merged === true && typeof r.body?.sha === "string") return { kind: "merged", sha: r.body.sha };
    if (r.status === 409) return { kind: "head_moved" };
    if (r.status === 405 || r.status === 422) return { kind: "not_mergeable", message: String(r.body?.message ?? "").slice(0, 200) };
    throw new GithubHttpError(r.status, `merge başarısız (HTTP ${r.status})`);
  }
}
