import type { CheckRun, CombinedStatus, GithubReader, PullFacts } from "../../src/actions/github.ts";
import { toPullFacts } from "../../src/actions/github.ts";
import { readJson } from "./contract.ts";

/** Plays back the recorded GitHub REST fixtures (`contract/fixtures/external/github-rest/`); tests override single fields. */
const RECORDED = readJson("fixtures", "external", "github-rest", "pr42-merged.json").body;
const NOT_FOUND = readJson("fixtures", "external", "github-rest", "pr-not-found-404.json");
const NO_RUNS = readJson("fixtures", "external", "github-rest", "check-runs-empty.json").body;
const NO_STATUS = readJson("fixtures", "external", "github-rest", "commit-status-empty.json").body;

export const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The recorded PR 42 made open and mergeable (the recording is a merged PR; its field set is what matters). */
export function openPullBody(over: { sha?: string; ref?: string; base?: string; state?: "open" | "closed"; merged?: boolean; draft?: boolean; mergeable?: boolean | null; mergeable_state?: string } = {}) {
  const b = structuredClone(RECORDED);
  b.state = over.state ?? "open";
  b.merged = over.merged ?? false;
  b.draft = over.draft ?? false;
  b.mergeable = over.mergeable === undefined ? true : over.mergeable;
  b.mergeable_state = over.mergeable_state ?? "clean";
  b.head.sha = over.sha ?? HEAD;
  b.head.ref = over.ref ?? "vlad/T20261025-61";
  b.base.ref = over.base ?? "vlad/T20261024-94";
  return b;
}

const READS = new Set(["getPull", "getCheckRuns", "getCombinedStatus"]);

export class FakeGithub implements GithubReader {
  pull: any = openPullBody();
  /** Consumed first, one per `getPull`; the last one repeats. */
  pullQueue: any[] = [];
  missing = false;
  runs: CheckRun[] = [{ name: "gate", status: "completed", conclusion: "success" }];
  status: CombinedStatus = { state: "success", total_count: 1 };
  fail: Error | null = null;
  /** Awaited inside every `getPull`: lets a test hold one request open while another arrives. */
  hold: Promise<void> | null = null;
  calls: string[] = [];

  /** Calls that were not reads. The reader interface has no write method, so this stays 0 in S9a. */
  get writes() {
    return this.calls.filter((c) => !READS.has(c)).length;
  }
  count(name: string) {
    return this.calls.filter((c) => c === name).length;
  }

  async getPull(_repo: string, _pr: number): Promise<PullFacts | null> {
    this.calls.push("getPull");
    if (this.hold) await this.hold;
    if (this.fail) throw this.fail;
    if (this.missing) return null; // the recorded 404 (NOT_FOUND.status)
    const body = this.pullQueue.length > 1 ? this.pullQueue.shift() : (this.pullQueue[0] ?? this.pull);
    return toPullFacts(body);
  }
  async getCheckRuns(): Promise<CheckRun[]> {
    this.calls.push("getCheckRuns");
    return this.runs;
  }
  async getCombinedStatus(): Promise<CombinedStatus> {
    this.calls.push("getCombinedStatus");
    return this.status;
  }
}

export const RECORDED_404 = NOT_FOUND;
export const RECORDED_EMPTY_RUNS = NO_RUNS;
export const RECORDED_EMPTY_STATUS = NO_STATUS;
export const RECORDED_PR = RECORDED;
