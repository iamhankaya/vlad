import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChallenge, expiryOf, isExpired, newActionId } from "../../src/actions/challenge.ts";
import { ciState, toPullFacts } from "../../src/actions/github.ts";
import { ActionError, type ActionPolicy } from "../../src/actions/service.ts";
import { ActionStore, StateError, type ActionRecord } from "../../src/actions/state.ts";
import type { DeviceRecord } from "../../src/auth/devices.ts";
import { challengeBytes, parseChallengeBytes } from "../../src/auth/canonical.ts";
import { buildApp } from "../../src/http/app.ts";
import { reject } from "../../src/http/approval.ts";
import { ROUTES } from "../../src/http/routes.generated.ts";
import { pairDevice, rig, signDer, signedCall, tmpState, TestDevice, type Rig } from "../helpers/client.ts";
import { readJson } from "../helpers/contract.ts";
import { FakeGithub, HEAD, openPullBody, RECORDED_404, RECORDED_PR } from "../helpers/fake-github.ts";
import { doc, jsonSchema, validator } from "../helpers/openapi.ts";

const TASK = "T20261025-61";
const PARENT = "T20261024-94";
const REPO = "iamhankaya/vlad";
const MERGE_SHA = "f".repeat(40);

type Tasks = Record<string, { id: string; project: string; state: string; parent?: string | null; pr?: { number: number; repo: string; base: string } | null }>;
const task = (over: Partial<Tasks[string]> = {}) => ({ id: TASK, project: "vlad", state: "awaiting_approval", parent: PARENT, pr: { number: 42, repo: REPO, base: `vlad/${PARENT}` }, ...over });

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.app.close();
});

/** A server with the approval path wired to the recorded-GitHub fake and a counting executor. */
async function setup(over: { tasks?: Tasks; policy?: ActionPolicy; projects?: Record<string, { repo?: string; default_branch?: string }>; execute?: (a: any, p: any) => Promise<any> } = {}) {
  const gh = new FakeGithub();
  const sleeps: number[] = [];
  const execute = vi.fn(over.execute ?? (async () => ({ merge_sha: MERGE_SHA })));
  const tasks: Tasks = over.tasks ?? { [TASK]: task() };
  const projects = over.projects ?? { vlad: { repo: REPO, default_branch: "master" } };
  const r = rig({
    limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] },
    events: { every: () => () => {} },
    actions: {
      reader: gh, tasks: async (id) => tasks[id] ?? null, projects: async (slug) => projects[slug] ?? null, execute,
      sleep: async (ms) => void sleeps.push(ms), policy: { prepareIntervalMs: 0, ...over.policy },
    },
  });
  rigs.push(r);
  const d = await pairDevice(r);
  const prepare = async (body: object = { kind: "merge_phase", task_id: TASK }, dev: TestDevice = d) => signedCall(r, dev, "POST", "/v1/actions/prepare", JSON.stringify(body));
  const prepared = async (body?: object, dev: TestDevice = d) => {
    const res = await prepare(body, dev);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { action_id: string; bytes_b64: string; fields: Record<string, string>; exp: number };
  };
  const sign = (c: { bytes_b64: string }, dev: TestDevice = d) => signDer(dev.approval.priv, Buffer.from(c.bytes_b64, "base64"));
  const approve = async (id: string, signature: string, dev: TestDevice = d) =>
    signedCall(r, dev, "POST", `/v1/actions/${id}/approve`, JSON.stringify({ signature }));
  const store = () => new ActionStore(join(r.dir, "challenges"));
  return { r, d, gh, execute, sleeps, tasks, projects, prepare, prepared, sign, approve, store };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const errOf = (res: { json(): any }) => res.json().error;

describe("challenge builder", () => {
  it("exp is floor(now)+60 and now >= exp is expired (60th second rejected, 59th accepted, any millisecond offset)", () => {
    for (const frac of [0, 1, 500, 999]) {
      const t0 = 1_761_350_400_000 + frac;
      const exp = expiryOf(t0);
      expect(isExpired(t0 + 59_000, exp)).toBe(false);
      expect(isExpired(t0 + 60_000, exp)).toBe(true);
    }
  });

  it("action ids match the contract pattern and do not repeat", () => {
    const ids = new Set(Array.from({ length: 200 }, newActionId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^A-[A-Za-z0-9_-]{1,64}$/);
  });

  it("builds through the canonical encoder: values that cannot be written are refused, not escaped", () => {
    const ok = { actionId: "A-X1", kind: "merge_phase", repo: REPO, pr: 42, base: "vlad/T20261024-94", headSha: HEAD, task: TASK, nonce: "AAECAwQFBgcICQoLDA0ODw", exp: 1761350460 };
    expect(new TextDecoder().decode(buildChallenge(ok).bytes)).toBe(new TextDecoder().decode(challengeBytes(buildChallenge(ok).fields)));
    expect(() => buildChallenge({ ...ok, base: "main\nkind=merge_final" })).toThrow();
    expect(() => buildChallenge({ ...ok, base: "a b" })).toThrow();
  });
});

describe("action store", () => {
  const rec = (id = "A-S1"): Omit<ActionRecord, "v" | "state" | "history"> => ({
    action_id: id, bytes_b64: "x", fields: {} as any, task_id: TASK, prepared_by: "d-1", created_ms: 1000, exp: 61,
  });

  it("only legal edges: prepared -> approved -> checked -> merged|failed; terminal states stay terminal", () => {
    const s = new ActionStore(join(tmpState(), "c"));
    s.create(rec());
    expect(() => s.transition("A-S1", "checked", 1)).toThrow(StateError);
    expect(() => s.transition("A-S1", "merged", 1)).toThrow(StateError);
    s.transition("A-S1", "approved", 2);
    s.transition("A-S1", "checked", 3);
    s.transition("A-S1", "merged", 4, { result: { merge_sha: MERGE_SHA } });
    expect(() => s.transition("A-S1", "failed", 5)).toThrow(StateError);
    expect(s.get("A-S1")!.history.map((h) => h.state)).toEqual(["prepared", "approved", "checked", "merged"]);
  });

  it("persists atomically with 0600 and survives a restart; a bad id never touches the disk", () => {
    const dir = join(tmpState(), "c");
    new ActionStore(dir).create(rec());
    expect(new ActionStore(dir).get("A-S1")!.state).toBe("prepared");
    expect(statSync(join(dir, "A-S1.json")).mode & 0o777).toBe(0o600);
    expect(new ActionStore(dir).get("../../etc/passwd")).toBeUndefined();
    expect(() => new ActionStore(dir).create(rec("A-../x"))).toThrow(StateError);
  });

  it("withLock serialises one id and does not block another", async () => {
    const s = new ActionStore(join(tmpState(), "c"));
    const order: string[] = [];
    const gate = deferred();
    const a1 = s.withLock("A-1", async () => { order.push("a1-start"); await gate.promise; order.push("a1-end"); });
    const a2 = s.withLock("A-1", async () => { order.push("a2"); });
    await s.withLock("A-2", async () => { order.push("b"); });
    expect(order).toEqual(["a1-start", "b"]);
    gate.resolve();
    await Promise.all([a1, a2]);
    expect(order).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });

  it("a throwing holder releases the lock", async () => {
    const s = new ActionStore(join(tmpState(), "c"));
    await expect(s.withLock("A-1", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(s.withLock("A-1", async () => 7)).resolves.toBe(7);
  });

  it("prune drops only old finished actions", () => {
    const s = new ActionStore(join(tmpState(), "c"));
    s.create(rec("A-OLD"));
    s.transition("A-OLD", "failed", 2000);
    s.create(rec("A-LIVE"));
    expect(s.prune(2000 + 1000, 10_000)).toBe(0);
    expect(s.prune(2000 + 20_000, 10_000)).toBe(1);
    expect(s.get("A-OLD")).toBeUndefined();
    expect(s.get("A-LIVE")).toBeDefined();
  });
});

describe("GitHub read mapping (recorded responses)", () => {
  it("maps the recorded PR 42 and the recorded list; unknown shapes throw instead of guessing", () => {
    const f = toPullFacts(RECORDED_PR);
    expect(f).toMatchObject({ number: 42, state: "closed", merged: true, mergeable: null, mergeable_state: "unknown", head: { sha: "76869aea61bb8c7f6ecf794627fe57efc8a74abe" }, base: { ref: "vlad/T20261024-94" } });
    // list items carry no `mergeable` fields (recorded): only the single-PR response is a valid input
    for (const p of readJson("fixtures", "external", "github-rest", "pulls-list.json").body) expect(() => toPullFacts(p)).toThrow();
    expect(() => toPullFacts(RECORDED_404.body)).toThrow();
    expect(() => toPullFacts({ ...RECORDED_PR, mergeable: "yes" })).toThrow();
  });

  it("ciState: empty recordings are `none`, never green; red beats pending; vlad/approved is not an input", () => {
    expect(ciState([], { state: "pending", total_count: 0 })).toBe("none");
    expect(ciState([{ name: "gate", status: "completed", conclusion: "success" }], { state: "pending", total_count: 0 })).toBe("green");
    expect(ciState([{ name: "gate", status: "completed", conclusion: "success" }, { name: "lint", status: "in_progress", conclusion: null }], { state: "pending", total_count: 0 })).toBe("pending");
    expect(ciState([{ name: "gate", status: "completed", conclusion: "failure" }, { name: "lint", status: "queued", conclusion: null }], { state: "pending", total_count: 0 })).toBe("red");
    expect(ciState([], { state: "failure", total_count: 1 })).toBe("red");
    expect(ciState([], { state: "pending", total_count: 1 })).toBe("pending");
    expect(ciState([{ name: "vlad/approved", status: "completed", conclusion: "success" }], { state: "pending", total_count: 0 })).toBe("none");
    expect(ciState([{ name: "a", status: "completed", conclusion: "skipped" }, { name: "b", status: "completed", conclusion: "neutral" }], { state: "pending", total_count: 0 })).toBe("none"); // nothing but skips proves nothing
    expect(ciState([{ name: "a", status: "completed", conclusion: "skipped" }, { name: "b", status: "completed", conclusion: "success" }], { state: "pending", total_count: 0 })).toBe("green");
    expect(ciState([{ name: "gate", status: "completed", conclusion: "weird" }], { state: "success", total_count: 1 })).toBe("pending");
  });
});

describe("prepare", () => {
  it("returns a challenge from the task and the live PR; the contract schema holds; bytes are the canonical string", async () => {
    const s = await setup();
    const res = await s.prepare();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(validator(jsonSchema(doc.paths["/actions/prepare"].post.responses["200"]))(body)).toEqual([]);
    const bytes = Buffer.from(body.bytes_b64, "base64");
    expect(parseChallengeBytes(bytes)).toEqual(body.fields);
    expect(body.fields).toMatchObject({ kind: "merge_phase", repo: REPO, pr: "42", base: `vlad/${PARENT}`, head_sha: HEAD, task: TASK });
    expect(body.exp).toBe(Math.floor(s.r.clock.t / 1000) + 60);
    expect(s.gh.writes).toBe(0);
  });

  it("repo/pr/base/head_sha never come from a card (F-vlad-010): a stored card id is refused, a gate card only names the task", async () => {
    const s = await setup();
    expect((await s.prepare({ kind: "merge_phase", card_id: "C-20261025-01" })).statusCode).toBe(400);
    expect((await s.prepare({ kind: "merge_phase", card_id: `gate-${TASK}` })).statusCode).toBe(200);
    expect((await s.prepare({ kind: "merge_phase", task_id: "T20261025-99", card_id: `gate-${TASK}` })).statusCode).toBe(400);
    expect((await s.prepare({ kind: "merge_phase", task_id: TASK, repo: "evil/x", pr: 1 })).statusCode).toBe(400); // no such field
    expect((await s.prepare({ kind: "merge_phase", task_id: TASK, params: { head_sha: "a".repeat(40) } })).statusCode).toBe(400);
    expect((await s.prepare({ kind: "tag_release", task_id: TASK })).statusCode).toBe(400);
    expect((await s.prepare({ kind: "delete_everything", task_id: TASK })).statusCode).toBe(400);
  });

  it("refuses what the task or the PR does not support", async () => {
    const reasons = async (mut: (s: Awaited<ReturnType<typeof setup>>) => void, body?: object) => {
      const s = await setup();
      mut(s);
      const res = await s.prepare(body);
      return [res.statusCode, errOf(res).code, errOf(res).details?.reason, s.gh.writes] as const;
    };
    expect(await reasons((s) => { s.tasks[TASK] = task({ state: "running" }); })).toEqual([409, "bad_request", "task_not_awaiting_approval", 0]);
    expect(await reasons((s) => { s.tasks[TASK] = task({ pr: null }); })).toEqual([409, "bad_request", "task_has_no_pr", 0]);
    expect(await reasons(() => {}, { kind: "merge_phase", task_id: "T20261025-77" })).toEqual([404, "bad_request", "not_found", 0]);
    expect(await reasons(() => {}, { kind: "merge_final", task_id: TASK })).toEqual([409, "bad_request", "kind_mismatch", 0]); // kind follows the task, not the client
    expect(await reasons((s) => { s.tasks[TASK] = task({ parent: null }); })).toEqual([409, "not_mergeable", "kind_base_mismatch", 0]);
    expect(await reasons((s) => { s.gh.missing = true; })).toEqual([409, "not_mergeable", "pr_not_found", 0]);
    expect(await reasons((s) => { s.gh.pull = openPullBody({ state: "closed" }); })).toEqual([409, "not_mergeable", "pr_closed", 0]);
    expect(await reasons((s) => { s.gh.pull = openPullBody({ merged: true, state: "closed" }); })).toEqual([409, "not_mergeable", "pr_merged", 0]);
    expect(await reasons((s) => { s.gh.pull = openPullBody({ draft: true }); })).toEqual([409, "not_mergeable", "draft", 0]);
    expect(await reasons((s) => { s.gh.pull = openPullBody({ ref: "vlad/T20261025-99" }); })).toEqual([409, "not_mergeable", "head_ref_mismatch", 0]);
    expect(await reasons((s) => { s.gh.pull = openPullBody({ base: "master" }); })).toEqual([409, "not_mergeable", "base_mismatch", 0]);
    expect(await reasons((s) => { s.gh.runs = [{ name: "gate", status: "completed", conclusion: "failure" }]; })).toEqual([422, "ci_not_green", "ci_not_green", 0]);
    expect(await reasons((s) => { s.gh.runs = []; s.gh.status = { state: "pending", total_count: 0 }; })).toEqual([422, "ci_not_green", "ci_not_green", 0]);
    expect(await reasons((s) => { s.gh.fail = new Error("ECONNRESET"); })).toEqual([503, "bad_request", "github_unavailable", 0]);
  });

  it("a branch name that is not a legal challenge value is refused and nothing is stored (line injection through GitHub data)", async () => {
    const s = await setup();
    s.tasks[TASK] = task({ pr: { number: 42, repo: REPO, base: `vlad/${PARENT}\nkind=merge_final` } });
    s.gh.pull = openPullBody({ base: `vlad/${PARENT}\nkind=merge_final` });
    s.tasks[TASK]!.parent = `${PARENT}\nkind=merge_final`;
    const res = await s.prepare();
    expect(res.statusCode).toBe(409);
    expect(errOf(res).details.reason).toBe("unrepresentable_field");
    expect(s.store().list()).toEqual([]);
  });

  it("server: old challenge unusable after new prepare", async () => {
    const s = await setup();
    const a = await s.prepared();
    const b = await s.prepared();
    expect(b.action_id).not.toBe(a.action_id);
    const old = await s.approve(a.action_id, s.sign(a));
    expect(old.statusCode).toBe(410);
    expect(errOf(old).code).toBe("expired");
    expect(errOf(old).details.reason).toBe("superseded");
    expect(s.store().get(a.action_id)!.state).toBe("invalid");
    expect((await s.approve(b.action_id, s.sign(b))).statusCode).toBe(200);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.gh.writes).toBe(0);
  });

  it("a prepare for another task leaves the first challenge alone", async () => {
    const s = await setup({ tasks: { [TASK]: task(), "T20261025-62": task({ id: "T20261025-62" }) } });
    s.gh.pull = openPullBody();
    const a = await s.prepared();
    s.gh.pull = openPullBody({ ref: "vlad/T20261025-62" });
    await s.prepared({ kind: "merge_phase", task_id: "T20261025-62" });
    expect(s.store().get(a.action_id)!.state).toBe("prepared");
  });
});

describe("approve", () => {
  it("happy path: all checks pass, state goes prepared -> approved -> checked -> merged, the executor is called once with the proof, response matches the contract", async () => {
    const s = await setup();
    const c = await s.prepared();
    const sig = s.sign(c);
    const res = await s.approve(c.action_id, sig);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: "executed", result: { kind: "merge_phase", repo: REPO, pr: 42, head_sha: HEAD, merge_sha: MERGE_SHA } });
    expect(validator(jsonSchema(doc.paths["/actions/{id}/approve"].post.responses["200"]))(res.json())).toEqual([]);
    expect(s.execute).toHaveBeenCalledTimes(1);
    const [action, proof] = s.execute.mock.calls[0]!;
    expect(action).toEqual({ action_id: c.action_id, kind: "merge_phase", repo: REPO, pr: 42, base: `vlad/${PARENT}`, head_sha: HEAD, task: TASK });
    expect(proof).toMatchObject({ kind: "device", device_id: s.d.id, signature: sig, signed_bytes_b64: c.bytes_b64 });
    const rec = s.store().get(c.action_id)!;
    expect(rec.history.map((h) => h.state)).toEqual(["prepared", "approved", "checked", "merged"]);
    expect(s.gh.writes).toBe(0);
  });

  it("server: prepare head change then approve -> 409 head_moved", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.pull = openPullBody({ sha: "b".repeat(40) });
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode).toBe(409);
    expect(errOf(res).code).toBe("head_moved");
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.gh.writes).toBe(0);
    // a refused challenge is spent: the same signature cannot be tried again after the PR moves back
    s.gh.pull = openPullBody();
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(409);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("server: signature of challenge A on action B rejected", async () => {
    const s = await setup({ tasks: { [TASK]: task(), "T20261025-62": task({ id: "T20261025-62" }) } });
    const a = await s.prepared();
    s.gh.pull = openPullBody({ ref: "vlad/T20261025-62" });
    const b = await s.prepared({ kind: "merge_phase", task_id: "T20261025-62" });
    const res = await s.approve(b.action_id, s.sign(a));
    expect(res.statusCode).toBe(401);
    expect(errOf(res).code).toBe("unauthorized");
    expect(s.execute).not.toHaveBeenCalled();
    // and B is still approvable with its own signature
    expect((await s.approve(b.action_id, s.sign(b))).statusCode).toBe(200);
  });

  it("server: signature over tampered bytes rejected", async () => {
    const s = await setup();
    const c = await s.prepared();
    const text = Buffer.from(c.bytes_b64, "base64").toString();
    for (const tampered of [text.replace("pr=42", "pr=43"), text.replace(HEAD, "b".repeat(40)), text.replace("merge_phase", "merge_final"), text + "\n", text.slice(0, -1)]) {
      const res = await s.approve(c.action_id, signDer(s.d.approval.priv, Buffer.from(tampered)));
      expect(res.statusCode, tampered).toBe(401);
    }
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.store().get(c.action_id)!.state).toBe("prepared"); // garbage does not burn the user's challenge
  });

  it("server: signature uses stored bytes not client copy", async () => {
    const s = await setup();
    const c = await s.prepared();
    const forged = Buffer.from(Buffer.from(c.bytes_b64, "base64").toString().replace("pr=42", "pr=43"));
    // the client cannot send its own bytes ...
    const withBytes = await signedCall(s.r, s.d, "POST", `/v1/actions/${c.action_id}/approve`, JSON.stringify({ signature: signDer(s.d.approval.priv, forged), bytes_b64: forged.toString("base64") }));
    expect(withBytes.statusCode).toBe(400);
    // ... and a signature over its own copy does not verify against the stored one
    expect((await s.approve(c.action_id, signDer(s.d.approval.priv, forged))).statusCode).toBe(401);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("server: session-key signed approval rejected", async () => {
    const s = await setup();
    const c = await s.prepared();
    const bytes = Buffer.from(c.bytes_b64, "base64");
    const res = await s.approve(c.action_id, signDer(s.d.session.priv, bytes));
    expect(res.statusCode).toBe(401);
    expect(s.execute).not.toHaveBeenCalled();
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
  });

  it("server: challenge line-injection / reordered / missing / extra field rejected", async () => {
    const names = ["reordered", "missing", "extra", "injected", "trailingNewline", "crlf"];
    for (const name of names) {
      const s = await setup();
      const c = await s.prepared();
      const lines = Buffer.from(c.bytes_b64, "base64").toString().split("\n");
      const variants: Record<string, string> = {
        reordered: [lines[0], lines[2], lines[1], ...lines.slice(3)].join("\n"),
        missing: lines.filter((l) => !l.startsWith("task=")).join("\n"),
        extra: [...lines, "extra=1"].join("\n"),
        injected: lines.map((l) => (l.startsWith("base=") ? `${l}\nkind=merge_final` : l)).join("\n"),
        trailingNewline: [...lines, ""].join("\n"),
        crlf: lines.join("\r\n"),
      };
      expect((await s.approve(c.action_id, signDer(s.d.approval.priv, Buffer.from(variants[name]!)))).statusCode, name).toBe(401);
      expect(() => parseChallengeBytes(Buffer.from(variants[name]!)), name).toThrow();
      expect(s.execute).not.toHaveBeenCalled();
    }
  });

  it("a stored challenge that no longer parses (disk tampering) is never signed off", async () => {
    const s = await setup();
    const c = await s.prepared();
    const f = join(s.r.dir, "challenges", `${c.action_id}.json`);
    const rec = JSON.parse(readFileSync(f, "utf8"));
    const evil = Buffer.from(Buffer.from(rec.bytes_b64, "base64").toString().replace("kind=merge_phase", "kind=merge_phase\nkind=merge_final"));
    writeFileSync(f, JSON.stringify({ ...rec, bytes_b64: evil.toString("base64") }));
    const res = await s.approve(c.action_id, signDer(s.d.approval.priv, evil));
    expect(res.statusCode).toBe(500);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("server: exp exactly 60s rejected, 59s accepted, clock skew and server clock rewind", async () => {
    // 59 s and 59.999 s accepted
    for (const ms of [59_000, 59_999]) {
      const s = await setup();
      const c = await s.prepared();
      s.r.clock.t += ms;
      expect((await s.approve(c.action_id, s.sign(c))).statusCode, `${ms}`).toBe(200);
    }
    // exactly 60 s rejected, whatever millisecond the challenge was made in
    for (const frac of [0, 1, 999]) {
      const s = await setup();
      s.r.clock.t += frac;
      const c = await s.prepared();
      s.r.clock.t += 60_000;
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode, `+${frac}`).toBe(410);
      expect(errOf(res)).toMatchObject({ code: "expired", details: { reason: "expired" } });
      expect(s.execute).not.toHaveBeenCalled();
    }
    // the phone's clock is irrelevant: exp is server time, and a phone 100 s off (inside the envelope window) still approves
    {
      const s = await setup();
      const c = await s.prepared();
      const res = await signedCall(s.r, s.d, "POST", `/v1/actions/${c.action_id}/approve`, JSON.stringify({ signature: s.sign(c) }), { ts: s.r.clock.t + 100_000 });
      expect(res.statusCode).toBe(200);
    }
    // the server clock moves back: the challenge is dead, even though now < exp
    {
      const s = await setup();
      const c = await s.prepared();
      s.r.clock.t -= 1000;
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode).toBe(410);
      expect(errOf(res).details.reason).toBe("clock_rewind");
      s.r.clock.t += 1000; // and it stays dead after the clock recovers
      expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(410);
      expect(s.execute).not.toHaveBeenCalled();
    }
    // rewind seen only across a restart (nothing in memory): now < created
    {
      const s = await setup();
      const c = await s.prepared();
      s.r.clock.t -= 5000;
      const again = s.r.restart();
      rigs.push(again);
      const res = await signedCall(again, s.d, "POST", `/v1/actions/${c.action_id}/approve`, JSON.stringify({ signature: s.sign(c) }));
      expect(res.statusCode).toBe(410);
    }
  });

  it("server: expired challenge 410", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.r.clock.t += 61_000;
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode).toBe(410);
    expect(errOf(res).code).toBe("expired");
    expect(s.store().get(c.action_id)!.state).toBe("invalid");
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.gh.writes).toBe(0);
  });

  it("server: pr closed or deleted or base changed or mergeable_state blocked/behind/dirty", async () => {
    const cases: [string, object | "missing", number, string, string][] = [
      ["closed", openPullBody({ state: "closed" }), 409, "not_mergeable", "pr_closed"],
      ["merged", openPullBody({ state: "closed", merged: true }), 409, "not_mergeable", "pr_merged"],
      ["deleted", "missing", 409, "not_mergeable", "pr_not_found"],
      ["draft", openPullBody({ draft: true }), 409, "not_mergeable", "draft"],
      ["base changed", openPullBody({ base: "master" }), 409, "not_mergeable", "base_mismatch"],
      ["blocked", openPullBody({ mergeable_state: "blocked" }), 409, "not_mergeable", "blocked"],
      ["behind", openPullBody({ mergeable_state: "behind" }), 409, "not_mergeable", "behind"],
      ["dirty", openPullBody({ mergeable: false, mergeable_state: "dirty" }), 409, "not_mergeable", "conflict"],
      ["mergeable false", openPullBody({ mergeable: false, mergeable_state: "clean" }), 409, "not_mergeable", "state_clean"],
      ["unstable", openPullBody({ mergeable_state: "unstable" }), 409, "not_mergeable", "state_unstable"],
    ];
    for (const [name, pull, status, code, reason] of cases) {
      const s = await setup();
      const c = await s.prepared();
      if (pull === "missing") s.gh.missing = true;
      else s.gh.pull = pull;
      const res = await s.approve(c.action_id, s.sign(c));
      expect([name, res.statusCode, errOf(res).code, errOf(res).details.reason]).toEqual([name, status, code, reason]);
      expect(s.execute, name).not.toHaveBeenCalled();
      expect(s.gh.writes, name).toBe(0);
      expect(s.store().get(c.action_id)!.state, name).toBe("failed");
    }
  });

  it("mergeable_state blocked is accepted only when the policy says the check-run is still to come (S9b)", async () => {
    const s = await setup({ policy: { allowBlocked: true } });
    const c = await s.prepared();
    s.gh.pull = openPullBody({ mergeable_state: "blocked" });
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
  });

  it("ci not green at approve -> 422 ci_not_green (red, pending and none alike), no write", async () => {
    for (const [runs, status] of [
      [[{ name: "gate", status: "completed", conclusion: "failure" }], { state: "failure", total_count: 1 }],
      [[{ name: "gate", status: "in_progress", conclusion: null }], { state: "pending", total_count: 0 }],
      [[], { state: "pending", total_count: 0 }],
    ] as const) {
      const s = await setup();
      const c = await s.prepared();
      s.gh.runs = runs as any;
      s.gh.status = status;
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode).toBe(422);
      expect(errOf(res).code).toBe("ci_not_green");
      expect(s.execute).not.toHaveBeenCalled();
    }
  });

  it("mergeable null: three tries two seconds apart, then 409 mergeable_unknown; a later answer wins", async () => {
    {
      const s = await setup();
      const c = await s.prepared();
      s.gh.pullQueue = [openPullBody({ mergeable: null, mergeable_state: "unknown" })];
      s.gh.calls = [];
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode).toBe(409);
      expect(errOf(res)).toMatchObject({ code: "not_mergeable", details: { reason: "mergeable_unknown" } });
      expect(s.gh.count("getPull")).toBe(3);
      expect(s.sleeps).toEqual([2000, 2000]);
      expect(s.execute).not.toHaveBeenCalled();
    }
    {
      const s = await setup();
      const c = await s.prepared();
      s.gh.pullQueue = [openPullBody({ mergeable: null, mergeable_state: "unknown" }), openPullBody({ mergeable: null, mergeable_state: "unknown" }), openPullBody()];
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode).toBe(200);
      expect(s.sleeps).toEqual([2000, 2000]);
    }
    {
      // the head can move while we wait for GitHub to compute mergeability
      const s = await setup();
      const c = await s.prepared();
      s.gh.pullQueue = [openPullBody({ mergeable: null, mergeable_state: "unknown" }), openPullBody({ sha: "c".repeat(40) })];
      const res = await s.approve(c.action_id, s.sign(c));
      expect(errOf(res).code).toBe("head_moved");
    }
  });

  it("GitHub unreachable decides nothing: 503, and the challenge still works until exp", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.fail = new Error("ECONNRESET");
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode).toBe(503);
    expect(s.store().get(c.action_id)!.state).toBe("approved");
    s.gh.fail = null;
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("a challenge belongs to the device that asked for it; another paired device sees it as unknown", async () => {
    const s = await setup();
    const other = await pairDevice(s.r, "Tablet");
    const c = await s.prepared();
    const res = await s.approve(c.action_id, s.sign(c, other), other);
    expect(res.statusCode).toBe(404);
    expect(s.execute).not.toHaveBeenCalled();
    expect((await s.approve("A-NOPE", s.sign(c))).statusCode).toBe(404);
    expect((await s.approve("A-nope%2F..", s.sign(c))).statusCode).toBe(404);
  });

  it("body must be exactly {signature}", async () => {
    const s = await setup();
    const c = await s.prepared();
    const post = (body: string) => signedCall(s.r, s.d, "POST", `/v1/actions/${c.action_id}/approve`, body);
    expect((await post("{}")).statusCode).toBe(400);
    expect((await post("not json")).statusCode).toBe(400);
    expect((await post(JSON.stringify({ signature: 5 }))).statusCode).toBe(400);
    expect((await post(JSON.stringify({ signature: s.sign(c), device_id: "d-other" }))).statusCode).toBe(400);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("Ek: two concurrent approvals -> one checked transition, one executeAction call, both answers are the same result", async () => {
    const s = await setup();
    const c = await s.prepared();
    const release = deferred();
    s.gh.hold = release.promise; // first approve is parked inside getPull while the second arrives
    const sig = s.sign(c);
    const both = Promise.all([s.approve(c.action_id, sig), s.approve(c.action_id, sig)]);
    for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
    s.gh.hold = null;
    release.resolve();
    const [x, y] = await both;
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    expect(x.json()).toEqual(y.json());
    expect(s.execute).toHaveBeenCalledTimes(1);
    const rec = s.store().get(c.action_id)!;
    expect(rec.history.filter((h) => h.state === "checked")).toHaveLength(1);
    expect(rec.history.filter((h) => h.state === "approved")).toHaveLength(1);
    expect(rec.state).toBe("merged");
    expect(s.gh.writes).toBe(0);
  });

  it("approving a merged action again returns the stored result without a second execution; a wrong signature does not", async () => {
    const s = await setup();
    const c = await s.prepared();
    const first = await s.approve(c.action_id, s.sign(c));
    s.r.clock.t += 600_000; // long after exp
    const again = await s.approve(c.action_id, s.sign(c));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await s.approve(c.action_id, signDer(s.d.session.priv, Buffer.from(c.bytes_b64, "base64")))).statusCode).toBe(401);
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("an executor refusal is passed through and ends the action; a crash of the executor is a generic 502; neither is retried", async () => {
    {
      const s = await setup({ execute: async () => { throw new ActionError(409, "head_moved", "head_moved"); } });
      const c = await s.prepared();
      const res = await s.approve(c.action_id, s.sign(c));
      expect([res.statusCode, errOf(res).code]).toEqual([409, "head_moved"]);
      expect(s.store().get(c.action_id)!.state).toBe("failed");
      expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(409);
      expect(s.execute).toHaveBeenCalledTimes(1);
    }
    {
      const s = await setup({ execute: async () => { throw new Error("boom: secret details"); } });
      const c = await s.prepared();
      const res = await s.approve(c.action_id, s.sign(c));
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain("secret");
      expect(s.store().get(c.action_id)!.state).toBe("failed");
    }
  });

  it("an interrupted approval (state `checked` on disk) resumes with the stored approval and executes once", async () => {
    const s = await setup();
    const c = await s.prepared();
    const store = s.store();
    store.transition(c.action_id, "approved", s.r.clock.t, { approval: { device_id: s.d.id, signature: s.sign(c), at_ms: s.r.clock.t } });
    store.transition(c.action_id, "checked", s.r.clock.t);
    const res = await s.approve(c.action_id, s.sign(c));
    expect(res.statusCode).toBe(200);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(store.get(c.action_id)!.state).toBe("merged");
  });
});

describe("review findings (S9a güvenlik incelemesi)", () => {
  it("exp limits only prepared -> approved: a second approve during execution, past exp, gets the stored result; executor runs once", async () => {
    const hold = deferred();
    const s = await setup({ execute: async () => { await hold.promise; return { merge_sha: MERGE_SHA }; } });
    const c = await s.prepared();
    s.r.clock.t += 59_000;
    const sig = s.sign(c);
    const first = s.approve(c.action_id, sig);
    for (let i = 0; i < 30 && s.store().get(c.action_id)!.state !== "checked"; i++) await new Promise((res) => setImmediate(res));
    expect(s.store().get(c.action_id)!.state).toBe("checked");
    s.r.clock.t += 5_000; // now past exp while the executor is running
    const second = s.approve(c.action_id, sig);
    for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
    expect(s.store().get(c.action_id)!.state).toBe("checked"); // the guard did not touch it
    hold.resolve();
    const [x, y] = await Promise.all([first, second]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    expect(y.json()).toEqual(x.json());
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.store().get(c.action_id)!.state).toBe("merged");
  });

  it("an approved (signature on record) action is resumable after exp; a merely prepared one is not", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.store().transition(c.action_id, "approved", s.r.clock.t, { approval: { device_id: s.d.id, signature: s.sign(c), at_ms: s.r.clock.t } });
    s.r.clock.t += 120_000;
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
    const p = await s.prepared();
    s.r.clock.t += 120_000;
    expect((await s.approve(p.action_id, s.sign(p))).statusCode).toBe(410);
  });

  it("repo, kind and base come from the task checked against the project card", async () => {
    const refused = async (mut: (s: Awaited<ReturnType<typeof setup>>) => void, body: object = { kind: "merge_phase", task_id: TASK }) => {
      const s = await setup();
      mut(s);
      const res = await s.prepare(body);
      expect(s.gh.writes).toBe(0);
      expect(s.store().list()).toEqual([]);
      return [res.statusCode, errOf(res).details?.reason];
    };
    // another repo than the card's
    expect(await refused((s) => { s.projects.vlad = { repo: "someone/else" }; })).toEqual([409, "repo_not_registered"]);
    expect(await refused((s) => { s.projects.vlad = {}; })).toEqual([409, "project_has_no_repo"]);
    expect(await refused((s) => { s.tasks[TASK] = task({ project: "ghost" }); })).toEqual([409, "project_has_no_repo"]);
    // a fork head (same branch name, other repository), a foreign base repo
    expect(await refused((s) => { const b = openPullBody(); b.head.repo.full_name = "evil/vlad"; s.gh.pull = b; })).toEqual([409, "fork_or_foreign_repo"]);
    expect(await refused((s) => { const b = openPullBody(); b.head.repo = null; s.gh.pull = b; })).toEqual([409, "fork_or_foreign_repo"]);
    expect(await refused((s) => { const b = openPullBody(); b.base.repo.full_name = "evil/vlad"; s.gh.pull = b; })).toEqual([409, "fork_or_foreign_repo"]);
    // merge_final into an arbitrary base: only the card's default branch (here `main`) counts
    const final = { kind: "merge_final", task_id: TASK };
    expect(await refused((s) => { s.tasks[TASK] = task({ parent: null, pr: { number: 42, repo: REPO, base: "release" } }); s.gh.pull = openPullBody({ base: "release" }); }, final)).toEqual([409, "kind_base_mismatch"]);
    expect(await refused((s) => { s.projects.vlad = { repo: REPO, default_branch: "main" }; s.tasks[TASK] = task({ parent: null, pr: { number: 42, repo: REPO, base: "master" } }); s.gh.pull = openPullBody({ base: "master" }); }, final)).toEqual([409, "kind_base_mismatch"]);
    // a phase task cannot ask for merge_final
    expect(await refused(() => {}, final)).toEqual([409, "kind_mismatch"]);
    // ... and a root task cannot ask for merge_phase
    expect(await refused((s) => { s.tasks[TASK] = task({ parent: null, pr: { number: 42, repo: REPO, base: "master" } }); s.gh.pull = openPullBody({ base: "master" }); })).toEqual([409, "kind_mismatch"]);
  });

  it("a root task merges into the card's default branch as merge_final (default master when the card names none)", async () => {
    for (const [branch, card] of [["master", { repo: REPO }], ["main", { repo: REPO, default_branch: "main" }]] as const) {
      const s = await setup({ projects: { vlad: card }, tasks: { [TASK]: task({ parent: null, pr: { number: 42, repo: REPO, base: branch } }) } });
      s.gh.pull = openPullBody({ base: branch });
      const c = await s.prepared({ kind: "merge_final", task_id: TASK });
      expect(c.fields).toMatchObject({ kind: "merge_final", base: branch });
      expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
    }
  });

  it("approve reads the task again: re-pointed PR/repo/base or a task no longer waiting ends the challenge", async () => {
    const after = async (mut: (s: Awaited<ReturnType<typeof setup>>) => void) => {
      const s = await setup();
      const c = await s.prepared();
      mut(s);
      const res = await s.approve(c.action_id, s.sign(c));
      expect(s.execute).not.toHaveBeenCalled();
      expect(s.gh.writes).toBe(0);
      return [res.statusCode, errOf(res).details.reason];
    };
    expect(await after((s) => { s.tasks[TASK] = task({ state: "running" }); })).toEqual([409, "task_changed"]);
    expect(await after((s) => { s.tasks[TASK] = task({ pr: { number: 43, repo: REPO, base: `vlad/${PARENT}` } }); })).toEqual([409, "task_changed"]);
    expect(await after((s) => { s.tasks[TASK] = task({ pr: { number: 42, repo: "evil/x", base: `vlad/${PARENT}` } }); })).toEqual([409, "task_changed"]);
    expect(await after((s) => { s.projects.vlad = { repo: "someone/else" }; })).toEqual([409, "repo_not_registered"]);
  });

  it("prepare is limited per device and task (429), other devices and tasks are not affected, and spam does not accumulate files", async () => {
    const s = await setup({ policy: { prepareIntervalMs: 5000 } });
    const other = await pairDevice(s.r, "Tablet");
    const a = await s.prepare();
    expect(a.statusCode).toBe(200);
    const again = await s.prepare();
    expect(again.statusCode).toBe(429);
    expect(errOf(again)).toMatchObject({ code: "rate_limited", details: { reason: "prepare_too_soon" } });
    expect(s.gh.count("getPull")).toBe(1); // the refused attempt cost no GitHub read
    expect((await s.prepare(undefined, other)).statusCode).toBe(200); // the other device is not blocked ...
    expect(s.store().get(a.json().action_id)!.state).toBe("prepared"); // ... and does not supersede the first device's challenge
    s.r.clock.t += 5_000;
    expect((await s.prepare()).statusCode).toBe(200);
  });

  it("a prepare that is refused does not supersede the challenge in use", async () => {
    const s = await setup();
    const c = await s.prepared();
    s.gh.runs = [{ name: "gate", status: "completed", conclusion: "failure" }];
    expect((await s.prepare()).statusCode).toBe(422);
    s.gh.runs = [{ name: "gate", status: "completed", conclusion: "success" }];
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(200);
  });

  it("five wrong signatures lock the action; even the right one is then refused (429)", async () => {
    const s = await setup();
    const c = await s.prepared();
    for (let i = 0; i < 5; i++) expect((await s.approve(c.action_id, signDer(s.d.session.priv, Buffer.from("x")))).statusCode).toBe(401);
    const res = await s.approve(c.action_id, s.sign(c));
    expect([res.statusCode, errOf(res).code]).toEqual([429, "rate_limited"]);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("a record whose fields disagree with its signed bytes is never executed", async () => {
    const s = await setup();
    const c = await s.prepared();
    const f = join(s.r.dir, "challenges", `${c.action_id}.json`);
    const rec = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...rec, fields: { ...rec.fields, base: "master" } }));
    expect((await s.approve(c.action_id, s.sign(c))).statusCode).toBe(500);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("extra approval guards cannot replace the built-in ones", async () => {
    const s = await setup();
    const r = rig({
      limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [1000, 1000] },
      actions: { reader: s.gh, tasks: async () => task(), projects: async () => ({ repo: REPO }), execute: s.execute },
      approvalGuards: { approveAction: () => ({ ok: true, data: { signature: "x" } }), revokeDevice: () => ({ ok: true }) },
    });
    rigs.push(r);
    const d = await pairDevice(r);
    const victim = await pairDevice(r, "Victim");
    expect((await signedCall(r, d, "POST", "/v1/actions/A-NOPE/approve", JSON.stringify({ signature: "AAAA" }))).statusCode).toBe(404);
    expect((await signedCall(r, d, "POST", `/v1/devices/${victim.id}/revoke`, "{}")).statusCode).toBe(400);
  });
});

describe("revocation", () => {
  it("server: revoke closes open SSE and invalidates pending challenges", async () => {
    const s = await setup();
    const a = s.d;
    const b = await pairDevice(s.r, "Phone B");
    const c2 = await pairDevice(s.r, "Phone C");
    const stream = (dev: TestDevice) => s.r.app.inject({ method: "GET", url: "/v1/stream", headers: dev.headers(s.r.clock, "GET", "/v1/stream") });
    const ofB = stream(b);
    const ofC = stream(c2);
    for (let i = 0; i < 200 && s.r.app.vladEvents.hub.count < 2; i++) await new Promise((res) => setImmediate(res));
    expect(s.r.app.vladEvents.hub.count).toBe(2);

    // B has a prepared challenge and an approved-but-unfinished one; A has its own that must survive
    s.gh.pull = openPullBody();
    const forB = await s.prepared(undefined, b);
    const store = s.store();
    const mine = await s.prepared({ kind: "merge_phase", task_id: TASK }, a); // another device, same task: coexists
    expect([store.get(forB.action_id)!.state, store.get(mine.action_id)!.state]).toEqual(["prepared", "prepared"]);
    const forB2 = await s.prepared(undefined, b); // supersedes only B's own earlier one
    expect([store.get(forB.action_id)!.state, store.get(mine.action_id)!.state]).toEqual(["invalid", "prepared"]);
    store.create({ action_id: "A-APPROVED1", bytes_b64: forB2.bytes_b64, fields: forB2.fields as any, task_id: "T20261025-90", prepared_by: b.id, created_ms: s.r.clock.t, exp: forB2.exp });
    store.transition("A-APPROVED1", "approved", s.r.clock.t);
    store.create({ action_id: "A-OWNEDBYA1", bytes_b64: forB2.bytes_b64, fields: forB2.fields as any, task_id: "T20261025-91", prepared_by: a.id, created_ms: s.r.clock.t, exp: forB2.exp });

    expect((await signedCall(s.r, a, "POST", `/v1/devices/${b.id}/revoke`, a.revokeBody(b.id, s.r.clock.t))).statusCode).toBe(200);
    await s.r.app.vladActions!.settled();
    expect((await ofB).statusCode).toBe(200); // B's stream ended
    expect(s.r.app.vladEvents.hub.countFor(c2.id)).toBe(1); // C's did not
    expect(store.get(forB2.action_id)).toMatchObject({ state: "invalid", reason: "revoked" });
    expect(store.get("A-APPROVED1")).toMatchObject({ state: "invalid", reason: "revoked" });
    expect(store.get("A-OWNEDBYA1")!.state).toBe("prepared"); // another device's challenge is untouched

    // B can no longer approve (its session key is dead), and the service refuses it on its own as well
    s.r.clock.t += 1;
    const res = await s.approve(forB2.action_id, s.sign(forB2, b), b);
    expect(res.statusCode).toBe(401);
    expect(errOf(res).code).toBe("device_revoked");
    // the service refuses on its own too, whatever device record the caller hands it
    expect(() => s.r.app.vladActions!.inspect({ device_id: b.id } as DeviceRecord, forB2.action_id, s.sign(forB2, b))).toThrow(ActionError);
    expect(s.execute).not.toHaveBeenCalled();
    s.r.app.vladEvents.hub.closeAll();
    await ofC;
  });

  it("revocation between the checks and the exit stops the executor", async () => {
    const s = await setup();
    const admin = await pairDevice(s.r, "Admin");
    const c = await s.prepared();
    // the approving device is revoked while GitHub is being read
    const release = deferred();
    s.gh.hold = release.promise;
    const pending = s.approve(c.action_id, s.sign(c));
    for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
    expect((await signedCall(s.r, admin, "POST", `/v1/devices/${s.d.id}/revoke`, admin.revokeBody(s.d.id, s.r.clock.t))).statusCode).toBe(200);
    s.gh.hold = null;
    release.resolve();
    const res = await pending;
    expect([res.statusCode, errOf(res).details.reason]).toEqual([410, "revoked"]);
    await s.r.app.vladActions!.settled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.store().get(c.action_id)!.state).toBe("invalid");
  });
});

describe("central approval enforcement (F-vlad-016)", () => {
  const approvalOps = ROUTES.filter((r) => r.auth === "session+approval");

  it("the contract has exactly these approval routes, and every one with a handler has a guard", async () => {
    expect(approvalOps.map((r) => r.operationId).sort()).toEqual(["approveAction", "createGrant", "revokeDevice"]);
    const s = await setup();
    expect([...s.r.app.vladApprovalGuards].sort()).toEqual(["approveAction", "createGrant", "revokeDevice"]);
    // createGrant has its guard since S10a: an empty body is refused by the guard (400), never reaches the handler
    const res = await signedCall(s.r, s.d, "POST", "/v1/grants", "{}");
    expect(res.statusCode).toBe(400);
    // without the approval path nothing is wired: guard and handler are both absent, the route stays "not implemented"
    const bare = rig();
    const d = await pairDevice(bare);
    expect([...bare.app.vladApprovalGuards].sort()).toEqual(["revokeDevice"]);
    expect((await signedCall(bare, d, "POST", "/v1/grants", "{}")).statusCode).toBe(501);
  });

  it("buildApp refuses to start when a session+approval route has a handler but no guard", () => {
    expect(() => buildApp({ stateDir: tmpState(), version: "t", extraHandlers: { createGrant: () => ({ ok: true }) } })).toThrow(/approval guard eksik: createGrant/);
    expect(() => buildApp({ stateDir: tmpState(), version: "t", extraHandlers: { createGrant: () => ({ ok: true }) }, approvalGuards: { createGrant: () => ({ ok: true }) } })).not.toThrow();
  });

  it("a handler that never looks at the approval is still behind the guard", async () => {
    const calls: string[] = [];
    const r = rig({
      limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [1000, 1000] },
      extraHandlers: { createGrant: (req) => { calls.push(req.vladApproval!.operationId); return { ok: true }; } },
      approvalGuards: { createGrant: (req) => (JSON.parse(String(req.body)).approved === true ? { ok: true } : reject(401, "unauthorized")) },
    });
    rigs.push(r);
    const d = await pairDevice(r);
    // unsigned: the signature layer answers first, the guard is not even asked
    expect((await r.app.inject({ method: "POST", url: "/v1/grants", headers: { "content-type": "application/json" }, payload: '{"approved":true}' })).statusCode).toBe(401);
    // signed session but no approval: the guard says no, the handler does not run
    const denied = await signedCall(r, d, "POST", "/v1/grants", '{"approved":false}');
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("unauthorized");
    expect(calls).toEqual([]);
    const ok = await signedCall(r, d, "POST", "/v1/grants", '{"approved":true}');
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual(["createGrant"]);
  });

  it("overriding the approve handler does not remove its guard", async () => {
    const s = await setup();
    const hit = vi.fn(() => ({ ok: true }));
    const r = rig({
      limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [1000, 1000] },
      actions: { reader: s.gh, tasks: async () => task(), projects: async () => ({ repo: REPO }), execute: s.execute },
      extraHandlers: { approveAction: hit },
    });
    rigs.push(r);
    const d = await pairDevice(r);
    const res = await signedCall(r, d, "POST", "/v1/actions/A-NOPE/approve", JSON.stringify({ signature: "AAAA" }));
    expect(res.statusCode).toBe(404);
    expect(hit).not.toHaveBeenCalled();
  });

  it("revokeDevice runs through the same guard: no/odd approval -> 400/401 and the device stays active", async () => {
    const s = await setup();
    const victim = await pairDevice(s.r, "Victim");
    const post = (body: string) => signedCall(s.r, s.d, "POST", `/v1/devices/${victim.id}/revoke`, body);
    expect((await post("{}")).statusCode).toBe(400);
    expect((await post(JSON.stringify({ ts_ms: s.r.clock.t, signature: signDer(s.d.session.priv, Buffer.from("x")) }))).statusCode).toBe(401);
    expect(s.r.app.vladApprovalGuards.has("revokeDevice")).toBe(true);
    expect((await signedCall(s.r, victim, "GET", "/v1/findings")).statusCode).not.toBe(401);
  });

  it("without `actions` the approval routes still pass the signature check and answer 501", async () => {
    const r = rig();
    rigs.push(r);
    const d = await pairDevice(r);
    expect((await signedCall(r, d, "POST", "/v1/actions/prepare", "{}")).statusCode).toBe(501);
    expect((await signedCall(r, d, "POST", "/v1/actions/A-X/approve", "{}")).statusCode).toBe(501);
    expect((await r.app.inject({ method: "POST", url: "/v1/actions/A-X/approve", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(401);
  });
});

describe("challenge vectors over HTTP (contract/signing-vectors.json)", () => {
  const V = readJson("signing-vectors.json");
  for (const v of V.challenge) {
    it(`${v.id} -> ${v.expect_valid ? "approved" : "rejected"}`, async () => {
      const dir = tmpState();
      const key = V.keys.find((k: any) => k.id === v.key_id);
      const dev = new TestDevice("Vector Phone");
      dev.id = "d-vector";
      writeFileSync(join(dir, "devices.json"), JSON.stringify({ devices: [{ device_id: dev.id, device_name: "v", session_pub: dev.session.pub, approval_pub: key.spki_b64u, created: "2026-10-25T00:00:00Z" }] }));
      const f = v.fields;
      const nowMs = (Number(f.exp) - 30) * 1000;
      mkdirSync(join(dir, "challenges"), { recursive: true });
      const text = Buffer.from(v.challenge_text);
      const gh = new FakeGithub();
      gh.pull = openPullBody({ sha: f.head_sha, base: f.base, ref: `vlad/${f.task}` });
      const execute = vi.fn(async () => ({ merge_sha: MERGE_SHA }));
      const taskInfo = { id: f.task, project: "vlad", state: "awaiting_approval", parent: "T20261024-94", pr: { number: Number(f.pr), repo: f.repo, base: f.base } };
      const store = new ActionStore(join(dir, "challenges"));
      store.create({ action_id: f.action_id, bytes_b64: text.toString("base64"), fields: f, task_id: f.task, prepared_by: dev.id, created_ms: nowMs - 1000, exp: Number(f.exp) });
      const r = rig({ actions: { reader: gh, tasks: async () => taskInfo, projects: async () => ({ repo: f.repo }), execute, sleep: async () => {} }, limits: { unpaired: [1000, 1000], paired: [1000, 1000], public: [1000, 1000] } }, dir, { t: nowMs, now() { return this.t; } } as any);
      rigs.push(r);
      const res = await signedCall(r, dev, "POST", `/v1/actions/${f.action_id}/approve`, JSON.stringify({ signature: v.signature_b64u }));
      expect(res.statusCode, res.body).toBe(v.expect_valid ? 200 : 401);
      expect(execute).toHaveBeenCalledTimes(v.expect_valid ? 1 : 0);
      expect(gh.writes).toBe(0);
    });
  }
});
