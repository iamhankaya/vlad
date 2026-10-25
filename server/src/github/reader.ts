import type { CheckRun, CombinedStatus, GithubReader, PullFacts } from "../actions/github.ts";
import { toPullFacts } from "../actions/github.ts";
import { GithubHttpError, type GithubClientLike } from "./client.ts";

const PAGE = 100;
/** Hard stop for paging: 1000 runs on one commit is already beyond anything real. */
const MAX_PAGES = 10;

/** `GithubReader` over the REST API; GET only. */
export class RestGithubReader implements GithubReader {
  private readonly c: GithubClientLike;
  constructor(client: GithubClientLike) {
    this.c = client;
  }

  async getPull(repo: string, pr: number): Promise<PullFacts | null> {
    const r = await this.c.request("GET", `/repos/${repo}/pulls/${pr}`, repo);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new GithubHttpError(r.status, `PR okunamadı (HTTP ${r.status})`);
    return toPullFacts(r.body);
  }

  /** All pages: a `vlad/approved` or failing run past the first 100 must not hide. A count that does not add up throws. */
  async getCheckRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const runs: CheckRun[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.c.request("GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=${PAGE}&page=${page}`, repo);
      if (r.status !== 200 || !Array.isArray(r.body?.check_runs) || !Number.isInteger(r.body?.total_count)) throw new GithubHttpError(r.status, `check-runs okunamadı (HTTP ${r.status})`);
      for (const x of r.body.check_runs) {
        if (typeof x?.name !== "string" || typeof x?.status !== "string") throw new Error("GitHub check-run yanıtı beklenen biçimde değil");
        runs.push({ name: x.name, status: x.status, conclusion: typeof x.conclusion === "string" ? x.conclusion : null, ...(Number.isInteger(x.app?.id) ? { app_id: x.app.id } : {}) });
      }
      if (runs.length >= r.body.total_count || r.body.check_runs.length === 0) {
        if (runs.length < r.body.total_count) throw new Error("check-runs eksik döndü");
        return runs;
      }
    }
    throw new Error("check-runs sayfalaması sınırı aşıldı");
  }

  async getCombinedStatus(repo: string, sha: string): Promise<CombinedStatus> {
    const r = await this.c.request("GET", `/repos/${repo}/commits/${sha}/status`, repo);
    if (r.status !== 200 || typeof r.body?.state !== "string" || !Number.isInteger(r.body?.total_count)) throw new GithubHttpError(r.status, `commit durumu okunamadı (HTTP ${r.status})`);
    return { state: r.body.state, total_count: r.body.total_count };
  }
}
