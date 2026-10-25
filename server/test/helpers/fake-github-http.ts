import type { FetchLike } from "../../src/github/client.ts";
import { readJson } from "./contract.ts";
import { HEAD, openPullBody } from "./fake-github.ts";

const fx = (name: string) => readJson("fixtures", "external", "github-rest", name);
const CHECK_RUN = fx("check-run-create-201.synthetic.json").body;
const MERGE_200 = fx("merge-200.synthetic.json").body;
const MERGE_405 = fx("merge-405.synthetic.json").body;
const MERGE_409 = fx("merge-409.synthetic.json").body;
const RECORDED_PR = fx("pr42-merged.json").body;

export const MERGE_SHA = MERGE_200.sha as string;
export const APP_ID = CHECK_RUN.app.id as number;

export type HttpCall = { method: string; path: string; body?: any };

/**
 * A GitHub at `fetch` level: plays the recorded/synthetic REST fixtures back, keeps PR and check-run state, and records
 * every call. The real `GithubClient`, `RestGithubReader` and `GithubWriter` run on top of it.
 */
export class FakeGithubHttp {
  pull: any = openPullBody();
  /** Runs other than ours (CI). */
  ci: any[] = [{ id: 1, name: "gate", status: "completed", conclusion: "success", app: { id: 15368 } }];
  status = { state: "success", total_count: 1 };
  approvedRuns: any[] = [];
  calls: HttpCall[] = [];
  /** `blocked` until `vlad/approved` exists (what a protected branch does); false = clean from the start. */
  blockUntilApproved = true;
  /** `blocked` no matter what (a missing review). */
  blockedForever = false;
  mergeableNull = false;
  /** Fails (as a dropped connection) the next N merge requests before GitHub sees them. */
  dropMergeBefore = 0;
  /** Applies the next merge but loses the response. */
  dropMergeAfter = 0;
  /** Invoked on every request (tests change the world mid-flight). */
  onRequest?: (c: HttpCall) => void | Promise<void>;

  get writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }
  get merges() {
    return this.calls.filter((c) => c.method === "PUT" && /\/merge$/.test(c.path));
  }
  get checkRunWrites() {
    return this.calls.filter((c) => c.method === "POST" && /\/check-runs$/.test(c.path));
  }

  private pullBody() {
    const b = structuredClone(this.pull);
    if (b.merged) return b;
    const approved = this.approvedRuns.length > 0;
    if (this.mergeableNull) { b.mergeable = null; b.mergeable_state = "unknown"; }
    else if (this.blockedForever || (this.blockUntilApproved && !approved)) { b.mergeable = true; b.mergeable_state = "blocked"; }
    else { b.mergeable = true; b.mergeable_state = "clean"; }
    return b;
  }

  merge() {
    this.pull = { ...this.pull, merged: true, state: "closed", merge_commit_sha: MERGE_SHA, merged_by: { ...RECORDED_PR.merged_by, login: "vlad-gate[bot]" } };
  }

  fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    const call: HttpCall = { method: init.method, path, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
    this.calls.push(call);
    await this.onRequest?.(call);
    const res = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    let m: RegExpMatchArray | null;
    if (init.method === "GET" && (m = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) return res(200, this.pullBody());
    if (init.method === "GET" && (m = path.match(/\/commits\/[0-9a-f]+\/check-runs\?per_page=(\d+)&page=(\d+)$/))) {
      const all = [...this.ci, ...this.approvedRuns];
      const per = Number(m[1]), page = Number(m[2]);
      return res(200, { total_count: all.length, check_runs: all.slice((page - 1) * per, page * per) });
    }
    if (init.method === "GET" && /\/commits\/[0-9a-f]+\/status$/.test(path)) return res(200, this.status);
    if (init.method === "POST" && /\/check-runs$/.test(path)) {
      const run = { ...CHECK_RUN, id: 5000 + this.approvedRuns.length, head_sha: call.body.head_sha, name: call.body.name, conclusion: call.body.conclusion };
      this.approvedRuns.push(run);
      return res(201, run);
    }
    if (init.method === "PUT" && /\/pulls\/\d+\/merge$/.test(path)) {
      if (this.dropMergeBefore > 0) { this.dropMergeBefore--; throw new Error("socket hang up"); }
      if (call.body?.sha !== this.pull.head.sha || this.pull.merged) return res(409, MERGE_409);
      if (this.pullBody().mergeable_state !== "clean") return res(405, MERGE_405);
      this.merge();
      if (this.dropMergeAfter > 0) { this.dropMergeAfter--; throw new Error("socket hang up"); }
      return res(200, MERGE_200);
    }
    return res(404, { message: "Not Found" });
  };
}

export { HEAD };
