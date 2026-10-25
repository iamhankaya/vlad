import { readdirSync, readFileSync } from "node:fs";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ciState } from "../../src/actions/github.ts";
import { FIELD_RULES } from "../../src/auth/canonical.ts";
import { createExecutor } from "../../src/actions/executor.ts";
import type { VladOps } from "../../src/actions/ops.ts";
import { ActionError, type ApprovalProof, type TaskInfo } from "../../src/actions/service.ts";
import { ActionStore } from "../../src/actions/state.ts";
import { AppTokenProvider, appJwt, loadAppKey, TOKEN_PERMISSIONS } from "../../src/github/appToken.ts";
import { GithubClient, GithubHttpError, observeWrites, REPO_RE, WRITE_CAP } from "../../src/github/client.ts";
import { RestGithubReader } from "../../src/github/reader.ts";
import { GithubWriter } from "../../src/github/writer.ts";
import { pairDevice, rig, signDer, signedCall, TestDevice, type Rig } from "../helpers/client.ts";
import { APP_ID, FakeGithubHttp, HEAD, MERGE_SHA } from "../helpers/fake-github-http.ts";
import { openPullBody } from "../helpers/fake-github.ts";

const TASK = "T20261025-61";
const PARENT = "T20261024-94";
const REPO = "iamhankaya/vlad";
const BASE = `vlad/${PARENT}`;

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

class FakeOps implements VladOps {
  audits = new Map<string, Record<string, unknown>>();
  auditCalls = 0;
  readyIds: string[] = [];
  launched: string[] = [];
  launchFails = new Set<string>();
  failAudit = 0;
  private readonly tasks: Record<string, TaskInfo>;
  constructor(tasks: Record<string, TaskInfo>) {
    this.tasks = tasks;
  }
  async addAudit(e: Record<string, unknown>) {
    this.auditCalls++;
    if (this.failAudit > 0) { this.failAudit--; throw new Error("kb meşgul"); }
    if (!this.audits.has(String(e.action_id))) this.audits.set(String(e.action_id), e); // like the CLI: an existing id is success
  }
  async setDone(id: string) {
    this.tasks[id]!.state = "done";
  }
  async ready() {
    return this.readyIds;
  }
  async launch(id: string) {
    if (this.launchFails.has(id)) throw new Error("launch failed");
    this.launched.push(id);
  }
}

const mkTask = (over: Partial<TaskInfo> = {}): TaskInfo => ({ id: TASK, project: "vlad", state: "awaiting_approval", parent: PARENT, pr: { number: 42, repo: REPO, base: BASE }, ...over });

/** The full stack: app + ActionService + real executor/writer/reader/client on the fake GitHub. */
async function setup(over: { executor?: Partial<Parameters<typeof createExecutor>[0]>; tasks?: Record<string, TaskInfo> } = {}) {
  const gh = new FakeGithubHttp();
  const proxied: string[] = [];
  const client = observeWrites(new GithubClient({ fetch: gh.fetch, tokens: { token: async () => "tok" } }), (m, p) => proxied.push(`${m} ${p}`));
  const reader = new RestGithubReader(client);
  const tasks = over.tasks ?? { [TASK]: mkTask() };
  const ops = new FakeOps(tasks);
  const events: { type: string; data: any; key: string }[] = [];
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const taskSource = async (id: string) => tasks[id] ?? null;
  const r = rig({
    limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] },
    events: { every: () => () => {} },
    actions: {
      reader, tasks: taskSource, projects: async () => ({ repo: REPO, default_branch: "master" }), sleep, policy: { prepareIntervalMs: 0, allowBlocked: true },
      execute: createExecutor({
        reader, writer: new GithubWriter(client), tasks: taskSource, ops, now: () => r.clock.t, sleep, appId: APP_ID, mergerLogin: "vlad-gate[bot]",
        appendEvent: (type, data, key) => { if (!events.some((e) => e.key === key)) events.push({ type, data, key }); },
        ...over.executor,
      }),
    },
  });
  rigs.push(r);
  const d = await pairDevice(r);
  const body = { kind: "merge_phase", task_id: TASK };
  const prepared = async (dev: TestDevice = d) => {
    const res = await signedCall(r, dev, "POST", "/v1/actions/prepare", JSON.stringify(body));
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { action_id: string; bytes_b64: string; exp: number };
  };
  const sign = (c: { bytes_b64: string }, dev: TestDevice = d) => signDer(dev.approval.priv, Buffer.from(c.bytes_b64, "base64"));
  const approve = (id: string, signature: string, dev: TestDevice = d) => signedCall(r, dev, "POST", `/v1/actions/${id}/approve`, JSON.stringify({ signature }));
  const store = () => new ActionStore(join(r.dir, "challenges"));
  return { r, d, gh, ops, tasks, events, sleeps, proxied, prepared, sign, approve, store, reader, client };
}
const errOf = (res: { json(): any }) => res.json().error;

describe("server: executor", () => {
  it("server: merge call carries sha=head_sha", async () => {
    const s = await setup();
    const c = await s.prepared();
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatchObject({ kind: "merge_phase", repo: REPO, pr: 42, head_sha: HEAD, merge_sha: MERGE_SHA });
    expect(s.gh.merges).toHaveLength(1);
    expect(s.gh.merges[0]!.body).toEqual({ sha: HEAD, merge_method: "merge" });
    expect(s.gh.merges[0]!.path).toBe(`/repos/${REPO}/pulls/42/merge`);
    // the order is check-run, then merge; nothing else writes
    expect(s.gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST /repos/${REPO}/check-runs`, `PUT /repos/${REPO}/pulls/42/merge`]);
    expect(s.gh.checkRunWrites[0]!.body).toMatchObject({ name: "vlad/approved", head_sha: HEAD, conclusion: "success", status: "completed" });
    expect(s.proxied).toEqual(s.gh.writes.map((w) => `${w.method} ${w.path}`));
    expect(s.store().get(c.action_id)!.state).toBe("merged");
  });

  it("server: concurrent two approves (Promise.all) -> exactly one merge", async () => {
    const s = await setup();
    const c = await s.prepared();
    const sig = s.sign(c);
    const [a, b] = await Promise.all([s.approve(c.action_id, sig), s.approve(c.action_id, sig)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(s.gh.merges).toHaveLength(1);
    expect(s.gh.checkRunWrites).toHaveLength(1);
    expect(s.ops.audits.size).toBe(1);
    expect(s.events).toHaveLength(1);
  });

  it("server: check-run written then merge crashes -> retry completes once, no double merge or audit", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.dropMergeBefore = 1; // connection dies before GitHub sees the merge
    const first = await s.approve(c.action_id, s.sign(c));
    expect([first.statusCode, errOf(first).details.reason]).toEqual([502, "github_unavailable"]);
    expect(s.store().get(c.action_id)!.state).toBe("checked"); // not failed: the same approval may retry
    expect(s.ops.audits.size).toBe(0);
    const retry = await s.approve(c.action_id, s.sign(c));
    expect(retry.statusCode, retry.body).toBe(200);
    expect(s.gh.checkRunWrites).toHaveLength(1); // the run on record is not written again
    expect(s.gh.merges).toHaveLength(2); // one failed attempt, one that merged
    expect(s.ops.audits.size).toBe(1);
    expect(s.tasks[TASK]!.state).toBe("done");
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200); // a third send returns the stored result
    expect(s.gh.merges).toHaveLength(2);
    expect(s.ops.audits.size).toBe(1);
  });

  it("server: merge applied but the response lost -> retry adopts the merge, no second PUT, one audit", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.dropMergeAfter = 1;
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(502);
    const retry = await s.approve(c.action_id, s.sign(c));
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().result.merge_sha).toBe(MERGE_SHA);
    expect(s.gh.merges).toHaveLength(1);
    expect(s.ops.audits.size).toBe(1);
    expect(s.tasks[TASK]!.state).toBe("done");
    expect(s.events).toHaveLength(1);
  });

  it("merged-continue: checked + PR already merged at the approved head -> only bookkeeping, no GitHub write", async () => {
    const s = await setup();
    const c = await s.prepared();
    const store = s.store();
    store.transition(c.action_id, "approved", s.r.clock.t, { approval: { device_id: s.d.id, signature: s.sign(c), at_ms: s.r.clock.t } });
    store.transition(c.action_id, "checked", s.r.clock.t);
    s.gh.merge(); // merged earlier, then the server died before audit/done
    s.tasks[TASK]!.state = "done"; // even the task already moved on
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.merge_sha).toBe(MERGE_SHA);
    expect(s.gh.writes).toHaveLength(0);
    expect(s.ops.audits.get(c.action_id)).toMatchObject({ action_id: c.action_id, head_sha: HEAD, merge_sha: MERGE_SHA, approver: { type: "device", id: s.d.id }, result: "merged" });
    expect(store.get(c.action_id)!.state).toBe("merged");
  });

  it("merged-continue: merged at another head (or by someone else) is not adopted", async () => {
    for (const mutate of [(g: FakeGithubHttp) => { g.pull.head.sha = "a".repeat(40); }, (g: FakeGithubHttp) => { g.pull.merged_by = { login: "someone" }; }]) {
      const s = await setup();
      const c = await s.prepared();
      const store = s.store();
      store.transition(c.action_id, "approved", s.r.clock.t, { approval: { device_id: s.d.id, signature: s.sign(c), at_ms: s.r.clock.t } });
      store.transition(c.action_id, "checked", s.r.clock.t);
      s.gh.merge();
      mutate(s.gh);
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode).toBe(409);
      expect(s.gh.writes).toHaveLength(0);
      expect(s.ops.audits.size).toBe(0);
    }
  });

  it("server: ci red -> 422 and no write", async () => {
    const s = await setup();
    s.gh.ci = [{ id: 1, name: "gate", status: "completed", conclusion: "failure", app: { id: 15368 } }];
    const res = await signedCall(s.r, s.d, "POST", "/v1/actions/prepare", JSON.stringify({ kind: "merge_phase", task_id: TASK }));
    expect([res.statusCode, errOf(res).code]).toEqual([422, "ci_not_green"]);
    // red only after prepare: approve refuses and still writes nothing
    s.gh.ci = [{ id: 1, name: "gate", status: "completed", conclusion: "success", app: { id: 15368 } }];
    const c = await s.prepared();
    s.gh.ci = [{ id: 1, name: "gate", status: "completed", conclusion: "failure", app: { id: 15368 } }];
    const r2 = await s.approve(c.action_id, s.sign(c));
    expect([r2.statusCode, errOf(r2).code]).toEqual([422, "ci_not_green"]);
    expect(s.gh.writes).toHaveLength(0);
  });

  it("server: audit written once keyed by action_id", async () => {
    const s = await setup();
    const c = await s.prepared();
    await s.approve(c.action_id, s.sign(c));
    await s.approve(c.action_id, s.sign(c));
    expect(s.ops.audits.size).toBe(1);
    expect(s.ops.auditCalls).toBe(1);
    const a = s.ops.audits.get(c.action_id)!;
    expect(Object.keys(a).sort()).toEqual(["action_id", "approver", "head_sha", "kind", "merge_sha", "pr", "repo", "result", "ts"]);
    expect(a).toMatchObject({ kind: "merge_phase", repo: REPO, pr: 42, head_sha: HEAD, approver: { type: "device", id: s.d.id } });
    // an audit failure after the merge keeps the action retryable, the retry never merges again
    const s2 = await setup();
    s2.ops.failAudit = 1;
    const c2 = await s2.prepared();
    const first = await s2.approve(c2.action_id, s2.sign(c2));
    expect([first.statusCode, errOf(first).details.reason]).toEqual([502, "bookkeeping_failed"]);
    expect((await s2.approve(c2.action_id, s2.sign(c2))).statusCode).toBe(200);
    expect(s2.gh.merges).toHaveLength(1);
    expect(s2.ops.audits.size).toBe(1);
  });

  it("server: mergeable null retries 3x then not_mergeable", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.mergeableNull = true;
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).code, errOf(res).details.reason]).toEqual([409, "not_mergeable", "mergeable_unknown"]);
    expect(s.gh.merges).toHaveLength(0);
    expect(s.sleeps.filter((x) => x === 2000)).toHaveLength(2); // three looks, two waits

    // the executor alone (the service's own pre-check passed): the same three looks
    const gh = new FakeGithubHttp();
    gh.mergeableNull = true;
    const client = new GithubClient({ fetch: gh.fetch, tokens: { token: async () => "t" } });
    const sleeps: number[] = [];
    const exec = createExecutor({ reader: new RestGithubReader(client), writer: new GithubWriter(client), tasks: async () => mkTask(), ops: new FakeOps({ [TASK]: mkTask() }), now: () => 0, sleep: async (ms) => void sleeps.push(ms), appendEvent: () => {} });
    const proof: ApprovalProof = { kind: "device", device_id: "D", signature: "s", signed_bytes_b64: "", approved_at_ms: 0 };
    await expect(exec({ action_id: "A-1", kind: "merge_phase", repo: REPO, pr: 42, base: BASE, head_sha: HEAD, task: TASK }, proof)).rejects.toMatchObject({ status: 409, details: { reason: "mergeable_unknown" } });
    expect(gh.calls.filter((x) => x.method === "GET" && /pulls\/42$/.test(x.path))).toHaveLength(4); // the opening look + three after the check-run
    expect(sleeps).toEqual([2000, 2000]);
    expect(gh.merges).toHaveLength(0);
  });

  it("blocked that never clears: waits at most 10 s in total, then not_mergeable and no merge", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.blockedForever = true;
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).details.reason]).toEqual([409, "blocked"]);
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(s.gh.merges).toHaveLength(0);
  });

  it("merge answered 409 -> head_moved and no further write", async () => {
    const s = await setup();
    const c = await s.prepared();
    // the head moves between the last look and the PUT (GitHub answers 409 to the sha)
    s.gh.onRequest = (call) => { if (call.method === "POST") s.gh.pull = { ...s.gh.pull, head: { ...s.gh.pull.head, sha: "b".repeat(40) } }; };
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).code]).toEqual([409, "head_moved"]);
    expect(s.gh.merges).toHaveLength(0); // the executor's own look caught it first
    // and when only the PUT catches it:
    const s2 = await setup();
    const c2 = await s2.prepared();
    s2.gh.onRequest = (call) => { if (call.method === "PUT") s2.gh.pull = { ...s2.gh.pull, head: { ...s2.gh.pull.head, sha: "c".repeat(40) } }; };
    const r2 = await s2.approve(c2.action_id, s2.sign(c2));
    expect([r2.statusCode, errOf(r2).code]).toEqual([409, "head_moved"]);
    expect(s2.gh.merges).toHaveLength(1); // GitHub itself refused it (409 on the sha); nothing else was written after
    expect(s2.gh.writes.map((w) => w.method)).toEqual(["POST", "PUT"]);
    expect(s2.ops.audits.size).toBe(0);
    expect(s2.tasks[TASK]!.state).toBe("awaiting_approval");
  });

  it("server: advance starts ready phases without LLM turn", async () => {
    const s = await setup();
    s.ops.readyIds = ["T20261025-62", "T20261025-63", "T20261025-64"];
    s.ops.launchFails.add("T20261025-63");
    const c = await s.prepared();
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode, res.body).toBe(200); // a phase that fails to start does not undo the merge
    expect(s.ops.launched).toEqual(["T20261025-62", "T20261025-64"]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ type: "action.executed", key: c.action_id, data: { action_id: c.action_id, task: TASK, merge_sha: MERGE_SHA, started: 2 } });
    // the only things the server runs are the vlad ops: no chat/LLM runner is involved (FakeOps is the whole interface)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(s.ops)).sort()).toEqual(["addAudit", "constructor", "launch", "ready", "setDone"]);
  });

  it("a root task (no parent) merges and starts nothing", async () => {
    const tasks = { [TASK]: mkTask({ parent: null, pr: { number: 42, repo: REPO, base: "master" } }) };
    const s = await setup({ tasks });
    s.gh.pull = openPullBody({ base: "master" });
    s.ops.readyIds = ["T20261025-62"];
    const res = await signedCall(s.r, s.d, "POST", "/v1/actions/prepare", JSON.stringify({ kind: "merge_final", task_id: TASK }));
    const c = res.json();
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
    expect(s.ops.launched).toEqual([]);
  });
});

describe("server: single exit", () => {
  it("every refusal path writes nothing; a valid approval makes exactly one merge with the right sha", async () => {
    const s = await setup();
    const other = await pairDevice(s.r, "Other");
    const c = await s.prepared();
    const sig = s.sign(c);
    const put = (id: string, body: string, dev: TestDevice | null, over?: Parameters<TestDevice["headers"]>[4]) =>
      dev ? signedCall(s.r, dev, "POST", `/v1/actions/${id}/approve`, body, over) : s.r.app.inject({ method: "POST", url: `/v1/actions/${id}/approve`, headers: { "content-type": "application/json" }, payload: body });
    const refused = [
      await put(c.action_id, JSON.stringify({ signature: sig }), null), // unsigned request
      await put("A-NOSUCHID01", JSON.stringify({ signature: sig }), s.d), // unmatched
      await put(c.action_id, JSON.stringify({ signature: sig.slice(0, -4) + "AAAA" }), s.d), // bad signature
      await put(c.action_id, JSON.stringify({ signature: sig }), other), // wrong device
      await put(c.action_id, JSON.stringify({ signature: sign2(other, c) }), other), // wrong device, own valid signature over the same bytes
    ];
    for (const res of refused) expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(s.gh.writes).toHaveLength(0);
    // expired
    s.r.clock.t += 61_000;
    const late = await put(c.action_id, JSON.stringify({ signature: sig }), s.d);
    expect(late.statusCode).toBe(410);
    expect(s.gh.writes).toHaveLength(0);
    // revoked device
    s.r.clock.t -= 61_000;
    const admin = await pairDevice(s.r, "Admin");
    const c2 = await s.prepared();
    expect((await signedCall(s.r, admin, "POST", `/v1/devices/${s.d.id}/revoke`, admin.revokeBody(s.d.id, s.r.clock.t))).statusCode).toBe(200);
    await s.r.app.vladActions!.settled();
    const dead = await put(c2.action_id, JSON.stringify({ signature: s.sign(c2) }), s.d);
    expect(dead.statusCode).toBeGreaterThanOrEqual(401);
    expect(s.gh.writes).toHaveLength(0);
    // valid approval from a still active device: exactly one merge
    const d2 = await pairDevice(s.r, "Second");
    const c3 = await (async () => {
      const res = await signedCall(s.r, d2, "POST", "/v1/actions/prepare", JSON.stringify({ kind: "merge_phase", task_id: TASK }));
      return res.json() as { action_id: string; bytes_b64: string };
    })();
    const ok = await put(c3.action_id, JSON.stringify({ signature: s.sign(c3, d2) }), d2);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(s.gh.merges).toHaveLength(1);
    expect(s.gh.merges[0]!.body.sha).toBe(HEAD);
  });

  it("stillAuthorized: device revoked after the check-run, before the PUT -> no merge", async () => {
    const s = await setup();
    const admin = await pairDevice(s.r, "Admin");
    const c = await s.prepared();
    s.gh.onRequest = async (call) => {
      if (call.method !== "POST") return;
      s.gh.onRequest = undefined;
      const res = await signedCall(s.r, admin, "POST", `/v1/devices/${s.d.id}/revoke`, admin.revokeBody(s.d.id, s.r.clock.t));
      expect(res.statusCode).toBe(200);
    };
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).details.reason]).toEqual([410, "revoked"]);
    await s.r.app.vladActions!.settled();
    expect(s.gh.merges).toHaveLength(0);
    expect(s.store().get(c.action_id)).toMatchObject({ state: "invalid", reason: "revoked" });
    expect(s.ops.audits.size).toBe(0);
  });

  it("stillAuthorized: task no longer awaiting approval right before the PUT -> no merge", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.onRequest = (call) => { if (call.method === "POST") s.tasks[TASK]!.state = "running"; };
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).details.reason]).toEqual([409, "task_changed"]);
    expect(s.gh.merges).toHaveLength(0);
    expect(s.store().get(c.action_id)!.state).toBe("failed");
  });
});

const sign2 = (dev: TestDevice, c: { bytes_b64: string }) => signDer(dev.approval.priv, Buffer.from(c.bytes_b64, "base64"));

describe("server: github client", () => {
  const mk = (gh = new FakeGithubHttp()) => ({ gh, client: new GithubClient({ fetch: gh.fetch, tokens: { token: async () => "SECRET-TOKEN" } }) });

  it("check-runs: every page is read (the approved run on page 2 is found, nothing is written again)", async () => {
    const gh = new FakeGithubHttp();
    gh.ci = Array.from({ length: 150 }, (_, i) => ({ id: i + 10, name: `job-${i}`, status: "completed", conclusion: "success", app: { id: 15368 } }));
    gh.approvedRuns = [{ id: 4242, name: "vlad/approved", status: "completed", conclusion: "success", app: { id: APP_ID } }];
    const { client } = mk(gh);
    const runs = await new RestGithubReader(client).getCheckRuns(REPO, HEAD);
    expect(runs).toHaveLength(151);
    expect(runs.at(-1)).toMatchObject({ name: "vlad/approved", app_id: APP_ID });
    const tasks = { [TASK]: mkTask() };
    const exec = createExecutor({ reader: new RestGithubReader(client), writer: new GithubWriter(client), tasks: async (id) => tasks[id as typeof TASK] ?? null, ops: new FakeOps(tasks), now: () => 0, sleep: async () => {}, appId: APP_ID, appendEvent: () => {} });
    await exec({ action_id: "A-1", kind: "merge_phase", repo: REPO, pr: 42, base: BASE, head_sha: HEAD, task: TASK }, { kind: "device", device_id: "D", signature: "s", signed_bytes_b64: "", approved_at_ms: 0 });
    expect(gh.checkRunWrites).toHaveLength(0);
    expect(gh.merges).toHaveLength(1);
  });

  it("a `vlad/approved` run written by another app does not count", async () => {
    const gh = new FakeGithubHttp();
    gh.approvedRuns = [{ id: 1, name: "vlad/approved", status: "completed", conclusion: "success", app: { id: 999 } }];
    gh.blockUntilApproved = false;
    const { client } = mk(gh);
    const tasks = { [TASK]: mkTask() };
    const exec = createExecutor({ reader: new RestGithubReader(client), writer: new GithubWriter(client), tasks: async () => tasks[TASK]!, ops: new FakeOps(tasks), now: () => 0, sleep: async () => {}, appId: APP_ID, appendEvent: () => {} });
    await exec({ action_id: "A-1", kind: "merge_phase", repo: REPO, pr: 42, base: BASE, head_sha: HEAD, task: TASK }, { kind: "device", device_id: "D", signature: "s", signed_bytes_b64: "", approved_at_ms: 0 });
    expect(gh.checkRunWrites).toHaveLength(1);
  });

  it("a write without the writer's capability is refused before any request", async () => {
    const { gh, client } = mk();
    for (const m of ["PUT", "POST", "PATCH", "DELETE"]) await expect(client.request(m, `/repos/${REPO}/pulls/1/merge`, REPO, { body: {} })).rejects.toBeInstanceOf(GithubHttpError);
    await expect(client.request("PUT", `/repos/${REPO}/pulls/1/merge`, REPO, { body: {}, cap: Symbol("forged") })).rejects.toBeInstanceOf(GithubHttpError);
    await expect(client.request("GET", `/repos/other/x/pulls/1`, REPO)).rejects.toBeInstanceOf(GithubHttpError); // path outside the token's repo
    await expect(client.request("TRACE", `/repos/${REPO}/pulls/1`, REPO)).rejects.toBeInstanceOf(GithubHttpError);
    expect(gh.calls).toHaveLength(0);
  });

  it("the token never appears in an error", async () => {
    const gh = new FakeGithubHttp();
    gh.fetch = async (_u, init) => { throw new Error(`boom ${init.headers.authorization}`); };
    const { client } = mk(gh);
    const err = await client.request("GET", `/repos/${REPO}/pulls/1`, REPO).catch((e) => e);
    expect(String(err.message)).not.toContain("SECRET-TOKEN");
  });

  it("writer: 405/422 -> not_mergeable, 409 -> head_moved, other statuses throw", async () => {
    for (const [status, kind] of [[405, "not_mergeable"], [422, "not_mergeable"], [409, "head_moved"]] as const) {
      const client = new GithubClient({ fetch: async () => ({ status, text: async () => JSON.stringify({ message: "x" }) }), tokens: { token: async () => "t" } });
      expect((await new GithubWriter(client).merge(REPO, 42, HEAD)).kind).toBe(kind);
    }
    const client = new GithubClient({ fetch: async () => ({ status: 403, text: async () => "{}" }), tokens: { token: async () => "t" } });
    await expect(new GithubWriter(client).merge(REPO, 42, HEAD)).rejects.toBeInstanceOf(GithubHttpError);
    await expect(new GithubWriter(client).writeApproved(REPO, HEAD, "x")).rejects.toBeInstanceOf(GithubHttpError);
    await expect(new GithubWriter(client).merge(REPO, 42, "main")).rejects.toBeInstanceOf(GithubHttpError); // only a full sha
  });
});

describe("server: github App token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const NOW = 1_761_350_400_000;

  it("JWT is RS256, iss=app id, short lived, and verifies with the public key", () => {
    const jwt = appJwt("123456", pem, NOW);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims.iss).toBe("123456");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThan(NOW / 1000);
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });

  const provider = (calls: string[], now: () => number, expires = "2026-10-25T13:00:00Z") =>
    new AppTokenProvider({
      appId: "123456", privateKey: pem, now,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push(`${init.method} ${path}`);
        expect(init.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        if (path.endsWith("/installation")) return { status: 200, text: async () => JSON.stringify({ id: 987654 }) };
        return { status: 201, text: async () => JSON.stringify({ token: "ghs_EXAMPLE", expires_at: expires }) };
      },
    });

  it("installation token is cached until 5 minutes before expiry, then renewed", async () => {
    let t = Date.parse("2026-10-25T12:00:00Z");
    const calls: string[] = [];
    const p = provider(calls, () => t);
    expect(await p.token(REPO)).toBe("ghs_EXAMPLE");
    expect(await p.token(REPO)).toBe("ghs_EXAMPLE");
    expect(calls).toEqual([`GET /repos/${REPO}/installation`, "POST /app/installations/987654/access_tokens"]);
    t = Date.parse("2026-10-25T12:54:59Z");
    await p.token(REPO);
    expect(calls).toHaveLength(2);
    t = Date.parse("2026-10-25T12:55:01Z");
    await p.token(REPO);
    expect(calls).toHaveLength(3); // installation id remembered, only the token is minted again
  });

  it("concurrent callers share one refresh; failures do not leak the key or the JWT", async () => {
    const calls: string[] = [];
    const p = provider(calls, () => Date.parse("2026-10-25T12:00:00Z"));
    await Promise.all([p.token(REPO), p.token(REPO), p.token(REPO)]);
    expect(calls).toHaveLength(2);
    const bad = new AppTokenProvider({ appId: "1", privateKey: pem, fetch: async () => ({ status: 401, text: async () => '{"message":"Bad credentials"}' }) });
    const err = (await bad.token(REPO).catch((e) => e)) as Error;
    expect(err.message).not.toMatch(/BEGIN|eyJ/);
    expect(() => new AppTokenProvider({ appId: "abc", privateKey: pem })).toThrow();
  });

  it("key comes from the state dir or env; a group/world readable key file is refused", async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "vlad-key-"));
    expect(loadAppKey({}, dir)).toBeUndefined();
    writeFileSync(join(dir, "github-app.pem"), pem, { mode: 0o600 });
    expect(loadAppKey({}, dir)).toBe(pem);
    chmodSync(join(dir, "github-app.pem"), 0o644);
    expect(() => loadAppKey({}, dir)).toThrow(/chmod 600/);
    expect(loadAppKey({ VLAD_GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }, dir)).toBe(pem);
  });
});

describe("server: github write methods only via GithubWriter", () => {
  const SRC = join(import.meta.dirname, "..", "..", "src");
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  const src = files(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith("routes.generated.ts")).map((f) => ({ f: f.slice(SRC.length + 1).split("\\").join("/"), text: readFileSync(f, "utf8") }));

  it("WRITE_CAP is imported by writer.ts only", () => {
    expect(src.filter((s) => /\bWRITE_CAP\b/.test(s.text)).map((s) => s.f).sort()).toEqual(["github/client.ts", "github/writer.ts"]);
    expect(WRITE_CAP).toBeTypeOf("symbol");
  });

  it("the request calls with a write method exist in writer.ts only (appToken.ts mints tokens, which writes no repository state)", () => {
    const writes = src.filter((s) => /["'`](PUT|POST|PATCH|DELETE)["'`]/.test(s.text)).map((s) => s.f).sort();
    expect(writes).toEqual(["github/appToken.ts", "github/client.ts", "github/writer.ts"]);
    // appToken: the single non-GET is the installation-token exchange
    const tok = src.find((s) => s.f === "github/appToken.ts")!.text;
    expect([...tok.matchAll(/api\("(\w+)", `([^`]+)`/g)].map((m) => `${m[1]} ${m[2].replace(/\$\{[^}]+\}/g, "*")}`).sort()).toEqual(["GET /repos/*/installation", "POST /app/installations/*/access_tokens"]);
    // writer: exactly the check-run and the merge
    const w = src.find((s) => s.f === "github/writer.ts")!.text;
    expect([...w.matchAll(/request\("(\w+)", `([^`]+)`/g)].map((m) => `${m[1]} ${m[2].replace(/\$\{[^}]+\}/g, "*")}`).sort()).toEqual(["POST /repos/*/check-runs", "PUT /repos/*/pulls/*/merge"]);
  });

  it("pushKbMain is the third write method; the git push it relies on lives in kbsync/gitexec.ts alone and only the writer reaches it", () => {
    const w = src.find((s) => s.f === "github/writer.ts")!.text;
    expect([...w.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]).sort()).toEqual(["merge", "pushKbMain", "writeApproved"]);
    // the writer reaches git only through the injected port; it has no process spawning of its own
    expect(w).not.toMatch(/child_process|execFile|spawn\(/);
    // only gitexec.ts names the push command; promote, takeover and the routes never push (the single write is the writer's)
    expect(src.filter((s) => /["'`]push["'`]/.test(s.text)).map((s) => s.f)).toEqual(["kbsync/gitexec.ts"]);
    // the port's push has no force: no `+` refspec, no force flag anywhere in the module
    const gx = src.find((s) => s.f === "kbsync/gitexec.ts")!.text;
    expect(gx).not.toMatch(/--force(?!-with-lease=)|"-f"|\+refs/);
    // and promote.ts is the only caller of pushKbMain
    expect(src.filter((s) => /\.pushKbMain\(/.test(s.text)).map((s) => s.f)).toEqual(["kbsync/promote.ts"]);
    expect(src.filter((s) => /createKbGitPort|firstParent/.test(s.text)).map((s) => s.f).sort()).toEqual(["github/writer.ts", "kbsync/config.ts", "kbsync/gitexec.ts"]);
  });

  it("no code path writes a branch, ref, tag, contents or commit as any identity (no vlad-agent token, no git push, no refs API)", () => {
    for (const s of src) {
      expect(s.text, s.f).not.toMatch(/vlad-agent|VLAD_AGENT|GITHUB_PAT|GH_TOKEN|GITHUB_TOKEN/);
      expect(s.text, s.f).not.toMatch(/\/git\/(refs|commits|trees|tags)|\/contents\/|\/merges\b|\/branches\/|\/rulesets|\/releases/);
      if (s.f.startsWith("github/") || s.f.startsWith("actions/")) expect(s.text, s.f).not.toMatch(/["'`]push["'`]|git push|execFile|spawn\(/);
    }
  });

  it("every GitHub client in the server is the guarded one: no raw fetch to api.github.com outside client.ts/appToken.ts", () => {
    const raw = src.filter((s) => /api\.github\.com/.test(s.text)).map((s) => s.f).sort();
    expect(raw).toEqual(["github/appToken.ts", "github/client.ts"]);
  });
});

const markChecked = (s: Awaited<ReturnType<typeof setup>>, c: { action_id: string; bytes_b64: string }) => {
  const store = s.store();
  store.transition(c.action_id, "approved", s.r.clock.t, { approval: { device_id: s.d.id, signature: s.sign(c), at_ms: s.r.clock.t } });
  store.transition(c.action_id, "checked", s.r.clock.t);
};
const pullGets = (g: FakeGithubHttp) => g.calls.filter((x) => x.method === "GET" && /pulls\/42$/.test(x.path)).length;

describe("server: security review findings (S9b)", () => {
  it("O1: PR re-targeted to the main branch while waiting -> no PUT, 409 (at the wait and at the last look)", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.onRequest = (call) => { if (call.method === "POST") s.gh.pull = { ...s.gh.pull, base: { ...s.gh.pull.base, ref: "master" } }; };
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).details.reason]).toEqual([409, "base_mismatch"]);
    expect(s.gh.merges).toHaveLength(0);

    // only the last look (just before the PUT) sees it: calls are service check, executor's first look, wait, last look
    const s2 = await setup();
    const c2 = await s2.prepared();
    s2.gh.onRequest = (call) => { if (call.method === "GET" && /pulls\/42$/.test(call.path) && pullGets(s2.gh) === 4) s2.gh.pull = { ...s2.gh.pull, base: { ...s2.gh.pull.base, ref: "master" } }; };
    const r2 = await s2.approve(c2.action_id, s2.sign(c2));
    expect([r2.statusCode, errOf(r2).details.reason]).toEqual([409, "base_mismatch"]);
    expect(s2.gh.merges).toHaveLength(0);

    // head repo / head ref are part of the same check
    const s3 = await setup();
    const c3 = await s3.prepared();
    s3.gh.onRequest = (call) => { if (call.method === "POST") s3.gh.pull = { ...s3.gh.pull, head: { ...s3.gh.pull.head, ref: "feature/x" } }; };
    expect(errOf(await s3.approve(c3.action_id, s3.sign(c3))).details.reason).toBe("head_ref_mismatch");
    expect(s3.gh.merges).toHaveLength(0);

    // an already merged PR with another base is not adopted either
    const s4 = await setup();
    const c4 = await s4.prepared();
    markChecked(s4, c4);
    s4.gh.merge();
    s4.gh.pull = { ...s4.gh.pull, base: { ...s4.gh.pull.base, ref: "master" } };
    expect((await s4.approve(c4.action_id, s4.sign(c4))).statusCode).toBe(409);
    expect(s4.ops.audits.size).toBe(0);
  });

  it("O2: without a configured login the merger is learned from the App slug; unknown = never claimed", async () => {
    for (const [resolve, want] of [[undefined, 409], [async () => undefined, 409], [async () => "someone[bot]", 409], [async () => "vlad-gate[bot]", 200]] as const) {
      const s = await setup({ executor: { mergerLogin: undefined, resolveMergerLogin: resolve } });
      const c = await s.prepared();
      markChecked(s, c);
      s.gh.merge();
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode, res.body).toBe(want);
      expect(s.ops.audits.size).toBe(want === 200 ? 1 : 0);
      expect(s.gh.writes).toHaveLength(0);
    }
  });

  it("O2: the App's bot login is `<slug>[bot]` from GET /app; a failed lookup is undefined", async () => {
    const mk = (status: number, body: unknown) => new AppTokenProvider({ appId: "1", privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetch: async () => ({ status, text: async () => JSON.stringify(body) }) });
    expect(await mk(200, { slug: "vlad-gate" }).botLogin()).toBe("vlad-gate[bot]");
    expect(await mk(404, {}).botLogin()).toBeUndefined();
    expect(await mk(200, { slug: "../x" }).botLogin()).toBeUndefined();
  });

  it("O2: merged-continue also needs the task waiting (or done) and the card's repo", async () => {
    const s = await setup();
    const c = await s.prepared();
    markChecked(s, c);
    s.gh.merge();
    s.tasks[TASK]!.state = "running";
    expect(errOf(await s.approve(c.action_id, s.sign(c))).details.reason).toBe("task_changed");
    expect(s.ops.audits.size).toBe(0);
  });

  it("O2: a new prepare is refused while an action of the same task is `checked`", async () => {
    const s = await setup();
    const c = await s.prepared();
    markChecked(s, c);
    const again = await signedCall(s.r, s.d, "POST", "/v1/actions/prepare", JSON.stringify({ kind: "merge_phase", task_id: TASK }));
    expect([again.statusCode, errOf(again).details.reason]).toEqual([409, "action_in_flight"]);
    // finishing the in-flight one frees the task
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
    expect(s.gh.merges).toHaveLength(1);
    expect(s.ops.audits.size).toBe(1);
  });

  it("O3: stillAuthorized is asked before the check-run: a changed task writes nothing at all", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.onRequest = (call) => { if (call.method === "GET" && /pulls\/42$/.test(call.path) && pullGets(s.gh) === 2) s.tasks[TASK]!.state = "running"; };
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).details.reason]).toEqual([409, "task_changed"]);
    expect(s.gh.writes).toHaveLength(0);

    // revoked device: also no check-run
    const s2 = await setup();
    const admin = await pairDevice(s2.r, "Admin");
    const c2 = await s2.prepared();
    s2.gh.onRequest = async (call) => {
      if (!(call.method === "GET" && /pulls\/42$/.test(call.path) && pullGets(s2.gh) === 2)) return;
      s2.gh.onRequest = undefined;
      expect((await signedCall(s2.r, admin, "POST", `/v1/devices/${s2.d.id}/revoke`, admin.revokeBody(s2.d.id, s2.r.clock.t))).statusCode).toBe(200);
    };
    const r2 = await s2.approve(c2.action_id, s2.sign(c2));
    expect([r2.statusCode, errOf(r2).details.reason]).toEqual([410, "revoked"]);
    expect(s2.gh.writes).toHaveLength(0);
  });

  it("D1: a hanging token endpoint times out, clears the in-flight slot and the next call can succeed", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let hang = true;
    const p = new AppTokenProvider({
      appId: "1", privateKey: pem, installationId: "5", timeoutMs: 30,
      fetch: (_u, init) => (hang ? new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))) : Promise.resolve({ status: 201, text: async () => JSON.stringify({ token: "ghs_EXAMPLE", expires_at: "2099-01-01T00:00:00Z" }) })),
    });
    await expect(p.token(REPO)).rejects.toThrow(/zaman aşımı/);
    hang = false;
    expect(await p.token(REPO)).toBe("ghs_EXAMPLE");
    // the client's timer also covers the token lookup
    const client = new GithubClient({ timeoutMs: 30, fetch: async () => ({ status: 200, text: async () => "{}" }), tokens: { token: () => new Promise<string>(() => {}) } });
    await expect(client.request("GET", `/repos/${REPO}/pulls/1`, REPO)).rejects.toBeInstanceOf(GithubHttpError);
  });

  it("D2: with an app id, a vlad/approved run without app_id (or of another app) does not count", async () => {
    for (const app of [undefined, { id: 999 }]) {
      const s = await setup();
      s.gh.approvedRuns = [{ id: 1, name: "vlad/approved", status: "completed", conclusion: "success", ...(app ? { app } : {}) }];
      s.gh.blockUntilApproved = false;
      const c = await s.prepared().catch(() => null);
      // the foreign run is also CI evidence (D3): prepare may refuse; if it did not, the executor must still write our own run
      expect(c).not.toBeNull();
      await s.approve(c!.action_id, s.sign(c!));
      expect(s.gh.checkRunWrites).toHaveLength(1); // our own run is still written
    }
  });

  it("D3: ciState leaves out only OUR vlad/approved run", () => {
    const ok = { name: "gate", status: "completed", conclusion: "success", app_id: 15368 };
    const mine = { name: "vlad/approved", status: "completed", conclusion: "success", app_id: 7 };
    const foreign = { name: "vlad/approved", status: "completed", conclusion: "failure", app_id: 8 };
    const st = { state: "pending", total_count: 0 };
    expect(ciState([ok, mine], st, 7)).toBe("green");
    expect(ciState([ok, foreign], st, 7)).toBe("red");
    expect(ciState([mine], st, 7)).toBe("none");
    expect(ciState([ok, foreign], st)).toBe("green"); // app id unknown: by name, as before
  });

  it("D4: the key is checked on the opened file: foreign owner refused; no getuid (Windows) warns", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "vlad-key-"));
    writeFileSync(join(dir, "github-app.pem"), "KEY", { mode: 0o600 });
    const uid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => loadAppKey({}, dir)).toThrow(/bu kullanıcıya ait/);
    spy.mockRestore();
    expect(loadAppKey({}, dir)).toBe("KEY");
    const warned: string[] = [];
    const orig = process.getuid;
    (process as any).getuid = undefined;
    try {
      expect(loadAppKey({}, dir, (m) => warned.push(m))).toBe("KEY");
    } finally {
      (process as any).getuid = orig;
    }
    expect(warned.join()).toMatch(/denetlenemiyor/);
  });

  it("D5: `.` and `..` segments are not valid repos, in the client and in the challenge rules; paths cannot walk out of the repo", async () => {
    for (const bad of ["../x", "./x", "a/..", "a/.", "..", "a/b/c", "", "a/"]) {
      expect(REPO_RE.test(bad), bad).toBe(false);
      expect(FIELD_RULES.repo.test(bad), bad).toBe(false);
    }
    for (const good of ["iamhankaya/vlad", "a.b/c_d-e", "a/.github", "a/b..c"]) {
      expect(REPO_RE.test(good), good).toBe(true);
      expect(FIELD_RULES.repo.test(good), good).toBe(true);
    }
    const gh = new FakeGithubHttp();
    const client = new GithubClient({ fetch: gh.fetch, tokens: { token: async () => "t" } });
    for (const path of [`/repos/${REPO}/../../orgs/x`, `/repos/${REPO}/%2e%2e/x`, `/repos/${REPO}/a%2fb`, `/repos/${REPO}/./pulls/1`]) await expect(client.request("GET", path, REPO)).rejects.toBeInstanceOf(GithubHttpError);
    expect(gh.calls).toHaveLength(0);
  });

  it("token scope: one repository and the least permissions the approval path uses", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bodies: any[] = [];
    const p = new AppTokenProvider({ appId: "1", privateKey: pem, installationId: "5", fetch: async (_u, init) => { bodies.push(JSON.parse(init.body!)); return { status: 201, text: async () => JSON.stringify({ token: "ghs_EXAMPLE", expires_at: "2099-01-01T00:00:00Z" }) }; } });
    await p.token(REPO);
    expect(bodies[0]).toEqual({ repositories: ["vlad"], permissions: TOKEN_PERMISSIONS });
    expect(TOKEN_PERMISSIONS).toEqual({ checks: "write", contents: "write", pull_requests: "read", statuses: "read" });
    // another repo gets its own token (a cached one is scoped to its repository)
    await p.token("iamhankaya/other");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].repositories).toEqual(["other"]);
  });
});
