import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateGrants, grantProblem, grantSigningPayload, GRANT_MAX_MS, NON_DELEGABLE_ACTIONS, type GrantEntry, type GrantRecord, type LiveChecks } from "../../src/actions/grants.ts";
import { ActionStore } from "../../src/actions/state.ts";
import type { TaskInfo } from "../../src/actions/service.ts";
import type { DeviceRecord } from "../../src/auth/devices.ts";
import { signDer, signedCall, TestDevice } from "../helpers/client.ts";
import { CONTRACT_DIR } from "../helpers/contract.ts";
import { FakeKb, mkWorld, PARENT, sha40, T1, T2, T3, T4, type GrantWorld } from "../helpers/grant-world.ts";
import { validator } from "../helpers/openapi.ts";

const worlds: GrantWorld[] = [];
const world = async (o?: Parameters<typeof mkWorld>[0]) => {
  const w = await mkWorld(o);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});

const createdSchema = validator({ $ref: "#/components/schemas/GrantCreated" });
const listSchema = validator({ $ref: "#/components/schemas/GrantList" });
const requestSchema = validator({ $ref: "#/components/schemas/GrantCreateRequest" });
const errorSchema = validator({ $ref: "#/components/schemas/Error" });
const errCode = (res: { json(): any }) => res.json().error?.code as string | undefined;
const reason = (res: { json(): any }) => res.json().error?.details?.reason as string | undefined;

/** Nothing outward happened for this PR: no check-run, no merge. */
const untouched = (w: GrantWorld, id: string) => {
  expect(w.writes(id)).toEqual([]);
  expect(w.merges(id)).toEqual([]);
};
const reasonOf = (e: unknown) => (e as { details?: { reason?: string } }).details?.reason;

describe("server: POST /grants (signed by the phone)", () => {
  it("server: valid grant is stored in the books and mirrored to the kb; device comes from the envelope", async () => {
    const w = await world();
    const a = await w.phone("A");
    const body = w.grantBody(a);
    expect(requestSchema(body)).toEqual([]);
    const res = await w.post(a, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: "G-001" });
    expect(createdSchema(res.json())).toEqual([]);
    expect(w.kb.added).toHaveLength(1);
    expect(w.kb.added[0]).toMatchObject({ id: "G-001", device_id: a.id, signature: body.signature, action: "merge_phase" });
    const list = await w.get("/v1/grants", a);
    expect(list.statusCode).toBe(200);
    expect(listSchema(list.json()), list.body).toEqual([]);
    expect(list.json().grants).toEqual([{ id: "G-001", scope: body.scope, action: "merge_phase", conditions: ["ci_green"], created: body.created, expires: body.expires, max_uses: 5, uses: 0, status: "active", device_id: a.id }]);
    expect(w.store().get("G-001")?.rec.device_id).toBe(a.id);
  });

  it("server: forged signature rejected", async () => {
    const w = await world();
    const a = await w.phone("A");
    const b = await w.phone("B");
    const good = w.grantBody(a);
    const forged: Record<string, string> = {
      "session key": signDer(a.session.priv, Buffer.from(grantSigningPayload(good))),
      "other device's approval key": signDer(b.approval.priv, Buffer.from(grantSigningPayload(good))),
      "garbage": "AAAA",
      "signed fields differ (max_uses raised after signing)": w.grantBody(a, { max_uses: 4 }).signature,
    };
    for (const [why, sig] of Object.entries(forged)) {
      const res = await w.post(a, { ...good, sig: undefined, signature: sig });
      expect([res.statusCode, errCode(res), reason(res)], why).toEqual([422, "grant_invalid", "bad_signature"]);
      expect(errorSchema(res.json()), res.body).toEqual([]);
    }
    // a request signed correctly but with a field the signature does not cover
    expect((await w.post(a, { ...w.grantBody(a), max_uses: 6 })).statusCode).toBe(422);
    expect((await w.post(a, { ...w.grantBody(a), scope: { type: "project", ref: "other" } })).statusCode).toBe(422);
    expect(w.kb.added).toEqual([]);
    expect(w.store().entries()).toEqual([]);
    expect((await w.get("/v1/grants", a)).json().grants).toEqual([]);
  });

  it("server: tag_release grant not_delegable (schema and code separately)", async () => {
    const w = await world();
    const a = await w.phone("A");
    for (const action of NON_DELEGABLE_ACTIONS) {
      // (1) schema: the contract's request schema has no such action
      const body = w.grantBody(a, { action });
      expect(requestSchema(body), `schema ${action}`).not.toEqual([]);
      // (2) code: refused as not_delegable whatever the signature says (even a correct one), before the signature is looked at
      for (const b of [body, { ...body, signature: "AAAA" }]) {
        const res = await w.post(a, b);
        expect([res.statusCode, errCode(res), reason(res)], action).toEqual([422, "not_delegable", "not_delegable"]);
        expect(errorSchema(res.json())).toEqual([]);
      }
    }
    expect(w.kb.added).toEqual([]);
    expect(w.store().entries()).toEqual([]);
    // an action outside both lists is a plain bad request
    expect((await w.post(a, w.grantBody(a, { action: "frobnicate" }))).statusCode).toBe(400);
  });

  it("server: tag_release grant not_delegable (schema and code separately) — a stored record or a task kind never reaches a merge", async () => {
    const w = await world();
    const a = await w.phone("A");
    const dev = w.r.cfg;
    void dev;
    const good = w.grantBody(a);
    const rec = { ...good, device_id: a.id } as GrantRecord;
    // a record that somehow holds a non-delegable action (written into the books or a hand-built list) is not honored by the evaluation
    const entry: GrantEntry = { rec: { ...rec, action: "tag_release" }, uses: [] };
    const live: LiveChecks = { device: () => deviceRecord(a), ci: async () => true, findingsClear: async () => true, codexClear: async () => true, kbRevoked: new Set() };
    const task = w.tasks.get(T1)!;
    const asKind = async (kind: string) => grantProblem(entry, task, kind, live, w.r.clock.t, true);
    expect(await asKind("tag_release")).toBe("not_delegable");
    expect(await asKind("merge_phase")).toBe("not_delegable");
    expect(await evaluateGrants(task, [entry], live, w.r.clock.t)).toBeNull();
    for (const action of NON_DELEGABLE_ACTIONS) expect(await grantProblem({ rec: { ...rec, action }, uses: [] }, task, action, live, w.r.clock.t, true), action).toBe("not_delegable");
    // the executor path has no other kind than merge_phase/merge_final: a card asking for tag_release cannot be prepared
    const prep = await signedCall(w.r, a, "POST", "/v1/actions/prepare", JSON.stringify({ kind: "tag_release", task_id: T1 }));
    expect(prep.statusCode).toBe(400);
    untouched(w, T1);
  });

  it("server: request limits (30 days, created window, conditions, shape)", async () => {
    const w = await world();
    const a = await w.phone("A");
    const now = w.r.clock.t;
    const cases: [string, Parameters<typeof w.grantBody>[1], number, string?][] = [
      ["expires 1 s over 30 days", { expires: w.iso(now + GRANT_MAX_MS + 1000) }, 422, "longer_than_30_days"],
      ["expires = created", { expires: w.iso(now) }, 422, "expires_before_created"],
      ["created 6 min ago (a replayed old request)", { created: w.iso(now - 6 * 60_000), expires: w.iso(now + 3600_000) }, 422, "created_out_of_window"],
      ["created 6 min ahead", { created: w.iso(now + 6 * 60_000), expires: w.iso(now + 3600_000) }, 422, "created_out_of_window"],
      ["already expired", { created: w.iso(now - 2 * 60_000), expires: w.iso(now - 60_000) }, 422, "already_expired"],
      ["no ci_green", { conditions: ["codex_clear"] }, 400],
      ["unknown condition", { conditions: ["ci_green", "yolo"] }, 400],
      ["duplicate condition", { conditions: ["ci_green", "ci_green"] }, 400],
      ["max_uses 0", { max_uses: 0 }, 400],
      ["max_uses 1001", { max_uses: 1001 }, 400],
      ["id G-1", { id: "G-1" }, 400],
      ["scope type other", { scope: { type: "everything" as never, ref: "vlad" } }, 400],
      ["scope ref with a slash", { scope: { type: "project", ref: "a/b" } }, 400],
      ["payload_version v2", { payload_version: "v2" as never }, 400],
      ["expires not iso", { expires: "tomorrow" }, 400],
      ["expires with offset", { expires: "2099-01-01T00:00:00+03:00" }, 400],
      ["extra field device_id", { extra: { device_id: a.id } }, 400],
    ];
    for (const [why, over, status, rs] of cases) {
      const res = await w.post(a, w.grantBody(a, over));
      expect([res.statusCode, rs ? reason(res) : undefined], why).toEqual([status, rs]);
    }
    expect((await w.post(a, "[]")).statusCode).toBe(400);
    expect((await w.post(a, "{}")).statusCode).toBe(400);
    expect(w.store().entries()).toEqual([]);
    // exactly 30 days is fine, and the id is then taken
    const ok = await w.post(a, w.grantBody(a, { id: "G-002", expires: w.iso(now + GRANT_MAX_MS) }));
    expect(ok.statusCode, ok.body).toBe(200);
    const again = await w.post(a, w.grantBody(a, { id: "G-002", expires: w.iso(now + 3600_000) }));
    expect([again.statusCode, reason(again)]).toEqual([409, "id_taken"]);
  });

  it("server: kb unavailable -> nothing is stored (503), the id stays free", async () => {
    const w = await world();
    const a = await w.phone("A");
    w.kb.failAdd = true;
    const res = await w.post(a, w.grantBody(a));
    expect([res.statusCode, reason(res)]).toEqual([503, "kb_unavailable"]);
    expect(w.store().entries()).toEqual([]);
    w.kb.failAdd = false;
    expect((await w.post(a, w.grantBody(a))).statusCode).toBe(200);
  });

  it("server: signature vectors of the contract: payload and verification", () => {
    const V = JSON.parse(readFileSync(join(CONTRACT_DIR, "signing-vectors.json"), "utf8"));
    for (const v of V.grant) expect(grantSigningPayload({ ...v.input }), v.id).toBe(v.payload);
  });
});

describe("server: grants carry out the gate card", () => {
  it("server: a covered phase merges through the single exit; one audit and one notification per use", async () => {
    const w = await world();
    const a = await w.phone("A");
    w.tasks.get(T2)!.state = "running"; // the grant would cover it too; this test is about T1
    await w.create(a, { scope: { type: "pipeline", ref: PARENT } });
    const res = await w.engine().tryTask(T1);
    expect(res).toMatchObject({ status: "executed", result: { kind: "merge_phase", repo: "iamhankaya/vlad", pr: 42, head_sha: sha40("a") } });
    // check-run, then the merge with sha = head_sha; nothing else wrote
    expect(w.writes(T1).map((c) => `${c.method} ${c.path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}`)).toEqual(["POST /check-runs", "PUT /pulls/42/merge"]);
    expect(w.merges(T1)[0]!.body).toEqual({ sha: sha40("a"), merge_method: "merge" });
    expect(w.proxied).toEqual(w.writes(T1).map((c) => `${c.method} ${c.path}`));
    expect(w.tasks.get(T1)!.state).toBe("done");
    // one audit line, naming the grant as approver
    expect(w.ops.auditCalls).toBe(1);
    expect([...w.ops.audits.values()]).toEqual([expect.objectContaining({ kind: "merge_phase", pr: 42, head_sha: sha40("a"), result: "merged", approver: { type: "grant", id: "G-001" } })]);
    // one event = one notification: `grant.used`, and no `action.executed` for the same use
    expect(w.events("grant.used")).toHaveLength(1);
    expect(w.events("grant.used")[0]!.data).toMatchObject({ grant_id: "G-001", task: T1, pr: 42 });
    expect(w.events("action.executed")).toEqual([]);
    expect((await w.get("/v1/grants", a)).json().grants[0].uses).toBe(1);
    // asking again changes nothing
    expect(await w.engine().tryTask(T1)).toBeNull();
    await w.engine().sweep();
    expect(w.merges(T1)).toHaveLength(1);
    expect(w.ops.auditCalls).toBe(1);
    expect(w.events("grant.used")).toHaveLength(1);
  });

  it("server: a task.state event for a waiting gate starts it by itself", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.ledger().append("task.state", { task_id: T1, project: "vlad", state: "awaiting_approval" }, "k1");
    await w.engine().settled();
    expect(w.merges(T1)).toHaveLength(1);
    // other states and other event types do nothing
    w.ledger().append("task.state", { task_id: T2, project: "vlad", state: "running" }, "k2");
    w.ledger().append("card.opened", { card_id: "C-20261025-01", project: "vlad" }, "k3");
    await w.engine().settled();
    untouched(w, T2);
  });

  it("server: merge_final: a root task needs a merge_final grant, a phase grant does not cover it", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { id: "G-001", action: "merge_phase" });
    expect(await w.engine().tryTask(T3)).toBeNull();
    untouched(w, T3);
    await w.create(a, { id: "G-002", action: "merge_final" });
    const res = await w.engine().tryTask(T3);
    expect(res?.result).toMatchObject({ kind: "merge_final", pr: 44 });
    expect([...w.ops.audits.values()][0]!.approver).toEqual({ type: "grant", id: "G-002" });
    // and the phase grant did not move
    expect(w.store().get("G-001")!.uses).toEqual([]);
  });

  it("server: scope other project skipped", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { scope: { type: "project", ref: "other" } });
    expect(await w.engine().tryTask(T1)).toBeNull(); // project vlad
    untouched(w, T1);
    // a pipeline grant of another pipeline does not cover this phase either
    await w.create(a, { id: "G-002", scope: { type: "pipeline", ref: "T20261024-99" } });
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    // while the matching ones do
    expect(await w.engine().tryTask(T4)).not.toBeNull(); // project other
    await w.create(a, { id: "G-003", scope: { type: "pipeline", ref: PARENT } });
    expect(await w.engine().tryTask(T1)).not.toBeNull();
    expect(w.store().get("G-002")!.uses).toEqual([]);
  });

  it("server: grant with ci red skips (and acts once it is green)", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.redCi(T1);
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    expect(w.store().get("G-001")!.uses).toEqual([]);
    w.gh.get(T1)!.ci = [{ id: 1, name: "gate", status: "completed", conclusion: "success", app: { id: 15368 } }];
    await w.engine().sweep(); // the sweep finds it, no event needed
    expect(w.merges(T1)).toHaveLength(1);
  });

  it("server: grant with ci pending or without any CI skips", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.gh.get(T1)!.ci = [{ id: 1, name: "gate", status: "in_progress", conclusion: null, app: { id: 15368 } }];
    expect(await w.engine().tryTask(T1)).toBeNull();
    w.gh.get(T2)!.ci = [];
    w.gh.get(T2)!.status = { state: "pending", total_count: 0 };
    expect(await w.engine().tryTask(T2)).toBeNull();
    untouched(w, T1);
    untouched(w, T2);
  });

  it("server: no_severe_findings: a severe open finding of the project keeps the card for a person", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { conditions: ["ci_green", "no_severe_findings"] });
    w.severe.add("vlad");
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    w.severe.clear();
    expect(await w.engine().tryTask(T1)).not.toBeNull();
  });

  it("server: codex_clear without codex -> card path, not auto", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { conditions: ["ci_green", "codex_clear"] });
    expect(await w.engine().tryTask(T1)).toBeNull();
    await w.engine().sweep();
    untouched(w, T1);
    expect(w.store().get("G-001")!.uses).toEqual([]);
    // the card path is open: a person approves with the biometric signature as always
    const prep = await signedCall(w.r, a, "POST", "/v1/actions/prepare", JSON.stringify({ kind: "merge_phase", task_id: T1 }));
    expect(prep.statusCode, prep.body).toBe(200);
    const sig = signDer(a.approval.priv, Buffer.from(prep.json().bytes_b64, "base64"));
    const ok = await signedCall(w.r, a, "POST", `/v1/actions/${prep.json().action_id}/approve`, JSON.stringify({ signature: sig }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(w.merges(T1)).toHaveLength(1);
    expect([...w.ops.audits.values()][0]!.approver).toEqual({ type: "device", id: a.id });
    expect(w.events("action.executed")).toHaveLength(1);
    expect(w.events("grant.used")).toEqual([]);
    // with a Codex that is clear the same grant acts
    w.codex = true;
    await w.create(a, { id: "G-002", conditions: ["ci_green", "codex_clear"] });
    expect(await w.engine().tryTask(T2)).not.toBeNull();
  });

  it("server: grant expired/revoked/max_uses", async () => {
    // expired
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { expires: w.iso(w.r.clock.t + 3600_000) });
    w.r.clock.t += 2 * 3600_000;
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    expect((await w.get("/v1/grants", a)).json().grants[0].status).toBe("expired");
    // revoked: permanent, the id and the signature cannot be added again
    const body = w.grantBody(a, { id: "G-002" });
    expect((await w.post(a, body)).statusCode).toBe(200);
    expect((await w.del(a, "G-002")).statusCode).toBe(200);
    expect(w.kb.revoked).toEqual(["G-002"]);
    expect(await w.engine().tryTask(T2)).toBeNull();
    untouched(w, T2);
    expect((await w.get("/v1/grants", a)).json().grants.find((g: any) => g.id === "G-002").status).toBe("revoked");
    const re = await w.post(a, body);
    expect([re.statusCode, reason(re)]).toEqual([409, "id_taken"]);
    expect((await w.del(a, "G-002")).statusCode).toBe(200); // idempotent
    expect((await w.del(a, "G-404")).statusCode).toBe(404);
    expect((await w.del(a, "G-1")).statusCode).toBe(400);
    // the kb alone can revoke too (it only reduces)
    await w.create(a, { id: "G-003" });
    w.kb.files.find((f) => f.id === "G-003")!.revoked = true;
    expect(await w.engine().tryTask(T2)).toBeNull();
    untouched(w, T2);
    // revoked in the kb must not be undone by the kb: the books keep their own state
    w.kb.files.find((f) => f.id === "G-003")!.revoked = false;
    expect(await w.engine().tryTask(T2)).not.toBeNull();
  });

  it("server: grant expired/revoked/max_uses — max_uses counts uses, exhausted grant leaves the card for a person", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 1 });
    expect(await w.engine().tryTask(T1)).not.toBeNull();
    expect(await w.engine().tryTask(T2)).toBeNull();
    untouched(w, T2);
    const g = (await w.get("/v1/grants", a)).json().grants[0];
    expect([g.uses, g.status]).toEqual([1, "exhausted"]);
  });

  it("server: max_uses=1 two concurrent cards -> one passes", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { scope: { type: "pipeline", ref: PARENT }, max_uses: 1 });
    const [x, y] = await Promise.all([w.engine().tryTask(T1), w.engine().tryTask(T2)]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(w.merges(T1).length + w.merges(T2).length).toBe(1);
    expect(w.ops.auditCalls).toBe(1);
    expect(w.events("grant.used")).toHaveLength(1);
    expect(w.store().get("G-001")!.uses).toHaveLength(1);
    // the loser's record ended `invalid`, not mergeable later by anyone
    const recs = new ActionStore(join(w.r.dir, "challenges")).list().filter((r) => r.grant);
    expect(recs.map((r) => r.state).sort()).toEqual(["invalid", "merged"]);
    // and the same through the sweep
    await w.engine().sweep();
    expect(w.merges(T1).length + w.merges(T2).length).toBe(1);
  });

  it("server: revoke concurrent with use", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    // the grant is revoked while the check-run is being written: the merge that follows must not happen
    w.gh.get(T1)!.onRequest = async (c) => {
      if (c.method === "POST" && /check-runs$/.test(c.path)) await w.del(a, "G-001");
    };
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ code: "grant_invalid", details: { reason: "grant_revoked" } });
    expect(w.merges(T1)).toEqual([]);
    expect(w.writes(T1)).toHaveLength(1); // the check-run only
    expect(w.tasks.get(T1)!.state).toBe("awaiting_approval");
    expect(w.ops.auditCalls).toBe(0);
    expect(w.events("grant.used")).toEqual([]);
    // revoked before the first look: not even the check-run
    const w2 = await world();
    const a2 = await w2.phone("A");
    await w2.create(a2);
    const first = w2.gh.get(T1)!;
    first.onRequest = async (c) => {
      if (c.method === "GET" && /pulls\/42$/.test(c.path) && first.calls.filter((x) => /pulls\/42$/.test(x.path)).length === 2) await w2.engine().revoke("G-001");
    };
    await expect(w2.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "grant_revoked" } });
    expect(w2.writes(T1)).toEqual([]);
  });

  it("server: grant of revoked device not honored", async () => {
    const w = await world();
    const a = await w.phone("A");
    const b = await w.phone("B");
    await w.create(a);
    const rv = await signedCall(w.r, b, "POST", `/v1/devices/${a.id}/revoke`, b.revokeBody(a.id, w.r.clock.t));
    expect(rv.statusCode, rv.body).toBe(200);
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    expect((await w.get("/v1/grants", b)).json().grants[0].status).toBe("device_revoked");
    // and a grant of a still active device whose device is revoked mid-flight does not finish
    const w2 = await world();
    const c = await w2.phone("A");
    const d = await w2.phone("B");
    await w2.create(c);
    w2.gh.get(T1)!.onRequest = async (call) => {
      if (call.method === "POST" && /check-runs$/.test(call.path)) await signedCall(w2.r, d, "POST", `/v1/devices/${c.id}/revoke`, d.revokeBody(c.id, w2.r.clock.t));
    };
    await expect(w2.engine().tryTask(T1)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(w2.merges(T1)).toEqual([]);
    expect(w2.tasks.get(T1)!.state).toBe("awaiting_approval");
  });

  it("server: unsigned grant file in kb ignored", async () => {
    const kb = new FakeKb();
    // files an agent (or anyone with kb access) dropped: no signature, a made-up signature, valid-looking fields
    kb.files.push({ id: "G-900", revoked: false }, { id: "G-901", revoked: false });
    kb.warnings.push("G-902.md: imza yok");
    const w = await world({ kb });
    const a = await w.phone("A");
    expect(await w.engine().tryTask(T1)).toBeNull();
    await w.engine().sweep();
    untouched(w, T1);
    untouched(w, T2);
    const list = (await w.get("/v1/grants", a)).json();
    expect(list.grants).toEqual([]);
    expect(list.warnings).toEqual(expect.arrayContaining(["G-902.md: imza yok", "kb'de kayıtsız devir yok sayıldı: G-900", "kb'de kayıtsız devir yok sayıldı: G-901"]));
    // a real grant next to them still works, and a kb file with the same id cannot be added over it
    await w.create(a, { id: "G-950" });
    expect(await w.engine().tryTask(T1)).not.toBeNull();
    expect(w.ops.auditCalls).toBe(1);
  });

  it("server: kb that cannot be read -> nothing is done on its authority (fail closed), the sweep tries again later", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.kb.failList = true;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ status: 503 });
    untouched(w, T1);
    w.kb.failList = false;
    await w.engine().sweep();
    expect(w.merges(T1)).toHaveLength(1);
  });

  it("server: ci turns red or head moves after evaluation -> no merge", async () => {
    // CI turns red after the check-run was written (the last look before the PUT sees it)
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.gh.get(T1)!.onRequest = (c) => {
      if (c.method === "POST" && /check-runs$/.test(c.path)) w.redCi(T1);
    };
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ status: 422, code: "ci_not_green" });
    expect(w.merges(T1)).toEqual([]);
    expect(w.tasks.get(T1)!.state).toBe("awaiting_approval");
    expect(w.store().get("G-001")!.uses).toEqual([]); // nothing merged: the use is back
    expect(w.ops.auditCalls).toBe(0);

    // the head moves in the same window
    const w2 = await world();
    const a2 = await w2.phone("A");
    await w2.create(a2);
    const g = w2.gh.get(T1)!;
    g.onRequest = (c) => {
      if (c.method === "POST" && /check-runs$/.test(c.path)) g.pull = { ...g.pull, head: { ...g.pull.head, sha: sha40("f") } };
    };
    await expect(w2.engine().tryTask(T1)).rejects.toMatchObject({ code: "head_moved" });
    expect(w2.merges(T1)).toEqual([]);
    expect(w2.store().get("G-001")!.uses).toEqual([]);

    // re-targeted to another base while waiting: origin check of the single exit
    const w3 = await world();
    const a3 = await w3.phone("A");
    await w3.create(a3);
    const g3 = w3.gh.get(T1)!;
    g3.onRequest = (c) => {
      if (c.method === "POST" && /check-runs$/.test(c.path)) g3.pull = { ...g3.pull, base: { ...g3.pull.base, ref: "master" } };
    };
    await expect(w3.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "base_mismatch" } });
    expect(w3.merges(T1)).toEqual([]);
  });

  it("server: a refused attempt gives the use back, the next sweep may use it", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 1 });
    const g = w.gh.get(T1)!;
    g.blockedForever = true; // a missing review: GitHub keeps the PR `blocked`
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "blocked" } });
    expect(w.store().get("G-001")!.uses).toEqual([]);
    g.blockedForever = false;
    await w.engine().sweep();
    expect(w.merges(T1)).toHaveLength(1);
    expect(w.store().get("G-001")!.uses).toHaveLength(1);
  });

  it("server: bookkeeping failure after the merge keeps the use; the sweep finishes it without a second merge, audit or notification", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 1 });
    w.ops.failAudit = 1;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "bookkeeping_failed" } });
    expect(w.merges(T1)).toHaveLength(1);
    const rec = new ActionStore(join(w.r.dir, "challenges")).list().find((r) => r.grant)!;
    expect(rec.state).toBe("checked");
    expect(w.store().get("G-001")!.uses).toEqual([rec.action_id]);
    // a person cannot finish a grant's record with a signature of their own: it is not theirs to approve
    const sig = signDer(a.approval.priv, Buffer.from(rec.bytes_b64, "base64"));
    const hand = await signedCall(w.r, a, "POST", `/v1/actions/${rec.action_id}/approve`, JSON.stringify({ signature: sig }));
    expect(hand.statusCode).toBe(404);
    // the sweep does
    await w.engine().sweep();
    expect(w.merges(T1)).toHaveLength(1);
    expect(w.ops.audits.size).toBe(1);
    expect([...w.ops.audits.values()][0]!.approver).toEqual({ type: "grant", id: "G-001" });
    expect(w.events("grant.used")).toHaveLength(1);
    expect(w.tasks.get(T1)!.state).toBe("done");
    expect(new ActionStore(join(w.r.dir, "challenges")).get(rec.action_id)!.state).toBe("merged");
    expect(w.store().get("G-001")!.uses).toEqual([rec.action_id]);
  });

  it("server: GitHub unreachable keeps the record and the use; the sweep carries on", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 1 });
    w.gh.get(T1)!.dropMergeBefore = 1;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "github_unavailable" } });
    expect(w.store().get("G-001")!.uses).toHaveLength(1);
    await w.engine().sweep();
    expect(w.merges(T1).filter((c) => c.body)).toHaveLength(2); // one dropped, one applied
    expect(w.gh.get(T1)!.pull.merged).toBe(true);
    expect(w.ops.audits.size).toBe(1);
    expect(w.events("grant.used")).toHaveLength(1);
    expect(w.tasks.get(T1)!.state).toBe("done");
  });

  it("server: books survive a restart (grants, revocations, uses)", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 1 });
    await w.create(a, { id: "G-002" });
    await w.del(a, "G-002");
    await w.engine().tryTask(T1);
    const s = w.store(); // reads the files the running app wrote
    expect(s.get("G-001")!.uses).toHaveLength(1);
    expect(s.get("G-002")!.revoked_at).toBeDefined();
    const w2 = w.r.restart();
    try {
      expect(w2.app.vladGrants!.store.get("G-001")!.uses).toHaveLength(1);
      expect(w2.app.vladGrants!.store.reserve("G-001", "A-OTHER")).toBe(false); // still exhausted
      expect(w2.app.vladGrants!.store.reserve("G-002", "A-OTHER")).toBe(false); // still revoked
    } finally {
      await w2.app.close();
    }
  });

  it("server: no approval path configured -> the three grant routes stay not implemented", async () => {
    const { rig, pairDevice } = await import("../helpers/client.ts");
    const r = rig();
    try {
      const d = await pairDevice(r);
      for (const [m, p] of [["GET", "/v1/grants"], ["POST", "/v1/grants"], ["DELETE", "/v1/grants/G-001"]] as const) {
        expect((await signedCall(r, d, m, p, m === "POST" ? "{}" : undefined)).statusCode, `${m} ${p}`).toBe(501);
      }
      expect(r.app.vladGrants).toBeUndefined();
    } finally {
      await r.app.close();
    }
  });
});

describe("server: evaluateGrants (pure selection)", () => {
  const device = new TestDevice("A");
  device.id = "d-a";
  const now = 1_761_350_400_000;
  const mk = (over: Partial<GrantRecord> = {}): GrantEntry => {
    const g = { id: "G-001", scope: { type: "project" as const, ref: "vlad" }, action: "merge_phase", conditions: ["ci_green"], created: new Date(now).toISOString(), expires: new Date(now + 3600_000).toISOString(), max_uses: 2, payload_version: "v1" as const, ...over };
    return { rec: { ...g, signature: over.signature ?? signDer(device.approval.priv, Buffer.from(grantSigningPayload(g))), device_id: "d-a" }, uses: [] };
  };
  const dev = deviceRecord(device);
  const live = (over: Partial<LiveChecks> = {}): LiveChecks => ({ device: (id) => (id === "d-a" ? dev : undefined), ci: async () => true, findingsClear: async () => true, codexClear: async () => false, kbRevoked: new Set(), ...over });
  const task: TaskInfo = { id: T1, project: "vlad", state: "awaiting_approval", parent: PARENT, pr: { number: 42, repo: "o/r", base: `vlad/${PARENT}` } };

  it("picks the first grant in the list that applies and skips the rest", async () => {
    const expired = mk({ id: "G-001", created: new Date(now - 7200_000).toISOString(), expires: new Date(now - 3600_000).toISOString() });
    const good = mk({ id: "G-002" });
    expect((await evaluateGrants(task, [expired, good], live(), now))?.rec.id).toBe("G-002");
    expect(await evaluateGrants(task, [expired], live(), now)).toBeNull();
    expect(await evaluateGrants(task, [], live(), now)).toBeNull();
  });

  it("server: grant with ci red skips (pure)", async () => {
    expect(await evaluateGrants(task, [mk()], live({ ci: async () => false }), now)).toBeNull();
  });

  it("each reason is named", async () => {
    const why = (g: GrantEntry, l = live(), t = task, kind = "merge_phase") => grantProblem(g, t, kind, l, now, true);
    expect(await why(mk())).toBeNull();
    expect(await why({ ...mk(), revoked_at: "x" })).toBe("grant_revoked");
    expect(await why(mk(), live({ kbRevoked: new Set(["G-001"]) }))).toBe("grant_revoked");
    expect(await why(mk(), live({ device: () => ({ ...dev, revoked_at: "x" }) }))).toBe("device_revoked");
    expect(await why(mk(), live({ device: () => undefined }))).toBe("device_revoked");
    expect(await why(mk({ signature: "MEUCIQDXhRYJxO6hxH3BzQnRPztVYKk2yARJZpca4KS6B84H8gIgRN--_MgHBd5eIlOFYDB_yK5EDdvUI1mGifRPYlKXOqM" }))).toBe("grant_invalid");
    expect(await why({ ...mk(), uses: ["A-1", "A-2"] })).toBe("max_uses");
    expect(await why(mk(), live(), { ...task, project: "x" })).toBe("scope_mismatch");
    expect(await why(mk({ scope: { type: "pipeline", ref: PARENT } }))).toBeNull();
    expect(await why(mk({ scope: { type: "pipeline", ref: T3 } }), live(), { ...task, id: T3, parent: null })).toBeNull(); // a root task is its own pipeline
    expect(await why(mk(), live(), task, "merge_final")).toBe("action_mismatch");
    expect(await why(mk({ conditions: ["ci_green", "no_severe_findings"] }), live({ findingsClear: async () => false }))).toBe("condition_no_severe_findings");
    expect(await why(mk({ conditions: ["ci_green", "codex_clear"] }))).toBe("condition_codex_clear");
    expect(await why(mk({ created: new Date(now - 40 * 86_400_000).toISOString(), expires: new Date(now + 3600_000).toISOString() }))).toBe("grant_invalid"); // longer than 30 days
    expect(await why(mk(), live(), task, "merge_phase")).toBeNull();
    // a check that throws is a no for that grant, never a crash
    expect(await evaluateGrants(task, [mk({ conditions: ["ci_green", "no_severe_findings"] })], live({ findingsClear: async () => { throw new Error("kb"); } }), now)).toBeNull();
  });
});

function deviceRecord(d: TestDevice): DeviceRecord {
  return { device_id: d.id, device_name: d.name, session_pub: d.session.pub, approval_pub: d.approval.pub, created: "2026-01-01T00:00:00Z" };
}
