// S10a security review findings (VLAD gate review): one block per finding number.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrantStore, MAX_GRANTS, vladFindingsClear, vladGrantKb, type GrantRecord } from "../../src/actions/grants.ts";
import { ActionStore } from "../../src/actions/state.ts";
import { signedCall } from "../helpers/client.ts";
import { FakeKb, mkWorld, PARENT, REPO, REPO2, T1, T2, type GrantWorld } from "../helpers/grant-world.ts";

const worlds: GrantWorld[] = [];
const world = async (o?: Parameters<typeof mkWorld>[0]) => {
  const w = await mkWorld(o);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  while (worlds.length) await worlds.pop()!.close();
});
const untouched = (w: GrantWorld, id: string) => {
  expect(w.writes(id)).toEqual([]);
  expect(w.merges(id)).toEqual([]);
};
const grantRecords = (w: GrantWorld) => new ActionStore(join(w.r.dir, "challenges")).list().filter((r) => r.grant);

describe("server: review finding 1 (a merged PR never gets its use back)", () => {
  it("server: finding 1: merge done, then bookkeeping and botLogin fail -> the use stays, the sweep finishes it, no other card takes the use", async () => {
    let login: string | undefined;
    const w = await world({ mergerLogin: async () => login });
    const a = await w.phone("A");
    await w.create(a, { scope: { type: "pipeline", ref: PARENT }, max_uses: 1 });
    w.ops.failAudit = 1;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "bookkeeping_failed" } });
    expect(w.merges(T1)).toHaveLength(1);
    // the resume cannot tell who merged (login unknown): a temporary failure, the record and the use stay
    await w.engine().sweep();
    const rec = grantRecords(w)[0]!;
    expect(rec.state).toBe("checked");
    expect(w.store().get("G-001")!.uses).toEqual([rec.action_id]);
    expect(w.merges(T2)).toEqual([]); // the one use is not up for grabs
    // the login becomes known: the very same action is finished, no second merge, audit or notification
    login = "vlad-gate[bot]";
    await w.engine().sweep();
    expect(w.merges(T1)).toHaveLength(1);
    expect(w.ops.audits.size).toBe(1);
    expect(w.events("grant.used")).toHaveLength(1);
    expect(grantRecords(w)[0]!.state).toBe("merged");
    expect(w.merges(T2)).toEqual([]);
    expect(w.store().get("G-001")!.uses).toEqual([rec.action_id]);
  });

  it("server: finding 1: a final refusal after the merge (head differs) ends the action but the use stays counted", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { scope: { type: "pipeline", ref: PARENT }, max_uses: 1 });
    w.ops.failAudit = 1;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "bookkeeping_failed" } });
    const g = w.gh.get(T1)!;
    g.pull = { ...g.pull, head: { ...g.pull.head, sha: "f".repeat(40) } }; // merged PR, but not the approved head any more
    await w.engine().sweep();
    expect(grantRecords(w)[0]!.state).toBe("failed");
    expect(w.store().get("G-001")!.uses).toHaveLength(1);
    expect(w.merges(T2)).toEqual([]);
  });

  it("server: finding 1: a refusal with the PR still open gives the use back (unchanged)", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 1 });
    w.gh.get(T1)!.blockedForever = true;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "blocked" } });
    expect(w.store().get("G-001")!.uses).toEqual([]);
  });
});

describe("server: review finding 2 (project and repo are signed and compared at every use)", () => {
  it("server: finding 2: the task's project or the card's repo changed in the kb -> no merge", async () => {
    // card re-registered to another repo, task and PR follow: the grant was given for the old one
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.cards.vlad!.repo = "iamhankaya/moved";
    w.tasks.get(T1)!.pr!.repo = "iamhankaya/moved";
    w.gh.get(T1)!.pull.head.repo.full_name = "iamhankaya/moved";
    w.gh.get(T1)!.pull.base.repo.full_name = "iamhankaya/moved";
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    // the task moved to another project (its card, repo and PR consistent): same grant, still nothing
    const w2 = await world();
    const a2 = await w2.phone("A");
    await w2.create(a2, { scope: { type: "pipeline", ref: PARENT } });
    w2.tasks.get(T1)!.project = "other";
    w2.tasks.get(T1)!.pr!.repo = REPO2;
    w2.gh.get(T1)!.pull.head.repo.full_name = REPO2;
    w2.gh.get(T1)!.pull.base.repo.full_name = REPO2;
    expect(await w2.engine().tryTask(T1)).toBeNull();
    untouched(w2, T1);
    // control: unchanged, the grant acts
    const w3 = await world();
    const a3 = await w3.phone("A");
    await w3.create(a3);
    expect(await w3.engine().tryTask(T1)).not.toBeNull();
  });

  it("server: finding 2: the card's repo changes while the merge is being prepared -> the guard stops it before the PUT", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.gh.get(T1)!.onRequest = (c) => {
      if (c.method === "POST" && /check-runs$/.test(c.path)) w.cards.vlad!.repo = "iamhankaya/moved";
    };
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ code: "grant_invalid", details: { reason: "repo_mismatch" } });
    expect(w.merges(T1)).toEqual([]);
  });

  it("server: finding 2: project and repo are inside the signature; v1 requests are refused", async () => {
    const w = await world();
    const a = await w.phone("A");
    const good = w.grantBody(a);
    for (const over of [{ project: "other" }, { repo: REPO2 }]) {
      const res = await w.post(a, { ...good, ...over });
      expect([res.statusCode, res.json().error.details.reason]).toEqual([422, "bad_signature"]);
    }
    const v1 = await w.post(a, { ...good, payload_version: "v1" });
    expect(v1.statusCode).toBe(400);
    const noRepo = { ...good } as Record<string, unknown>;
    delete noRepo.repo;
    expect((await w.post(a, noRepo)).statusCode).toBe(400);
    expect(w.store().entries()).toEqual([]);
  });
});

describe("server: review finding 3 (a kb revocation survives a damaged or missing file)", () => {
  it("server: finding 3: tombstoned id in the kb list revokes although the file is gone", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.kb.files = []; // file damaged/deleted: not listed any more
    w.kb.revokedIds = ["G-001"];
    w.kb.warnings = ["G-001.md: bozuk"];
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    expect((await w.get("/v1/grants", a)).json().grants[0].status).toBe("revoked");
  });

  it("server: finding 3: a grant the kb no longer lists while it complains is fail-closed; without complaints it stays usable", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { id: "G-001" });
    w.kb.files = [];
    w.kb.warnings = ["G-001.md: okunamadı"];
    expect(await w.engine().tryTask(T1)).toBeNull();
    untouched(w, T1);
    w.kb.warnings = [];
    expect(await w.engine().tryTask(T1)).not.toBeNull(); // the books are the authority; the kb is silent
  });

  it("server: finding 3: the same holds right before the write (revoked in the kb mid-flight)", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a);
    w.gh.get(T1)!.onRequest = (c) => {
      if (c.method === "POST" && /check-runs$/.test(c.path)) {
        w.kb.files = [];
        w.kb.revokedIds = ["G-001"];
        w.kb.warnings = ["G-001.md: bozuk"];
      }
    };
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "grant_revoked" } });
    expect(w.merges(T1)).toEqual([]);
  });

  it("server: finding 3: a CLI that reports no tombstones is refused (kb unreadable -> nothing done)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-grantcli-"));
    const saved = { ...process.env };
    try {
      writeFileSync(join(dir, "old-cli.cjs"), `process.stdout.write(JSON.stringify({ grants: [], warnings: [] }));`);
      process.env.VLAD_HOME = dir;
      process.env.VLAD_CLI = join(dir, "old-cli.cjs");
      await expect(vladGrantKb.list()).rejects.toThrow(/revoked_ids/);
      writeFileSync(join(dir, "old-cli.cjs"), `process.stdout.write(JSON.stringify({ grants: [{ id: "G-001", revoked: true }], warnings: ["w"], revoked_ids: ["G-001", "G-002"] }));`);
      expect(await vladGrantKb.list()).toEqual({ grants: [{ id: "G-001", revoked: true }], revoked_ids: ["G-001", "G-002"], warnings: ["w"] });
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server: review finding 4 (one unfinished action per task, finished under the task lock)", () => {
  it("server: finding 4: concurrent event + sweeps finish a checked record once: one audit, one grant.used, one advance", async () => {
    const w = await world();
    const a = await w.phone("A");
    w.ops.readyIds = ["T20261025-70"];
    await w.create(a, { scope: { type: "pipeline", ref: PARENT }, max_uses: 3 });
    w.tasks.get(T2)!.state = "running";
    w.ops.failAudit = 1;
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "bookkeeping_failed" } });
    expect(w.ops.launched).toEqual([]);
    w.ledger().append("task.state", { task_id: T1, project: "vlad", state: "awaiting_approval" }, "ev1");
    await Promise.all([w.engine().sweep(), w.engine().sweep(), w.engine().settled()]);
    await w.engine().sweep();
    expect(w.merges(T1)).toHaveLength(1);
    expect(w.ops.audits.size).toBe(1);
    expect(w.ops.auditCalls).toBe(2); // the failed one and the one that went through
    expect(w.events("grant.used")).toHaveLength(1);
    expect(w.ops.launched).toEqual(["T20261025-70"]);
    expect(grantRecords(w)).toHaveLength(1);
  });

  it("server: finding 4: an `approved` record (GitHub out of reach) blocks a second action and is resumed", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { max_uses: 5 });
    w.tasks.get(T2)!.state = "running"; // the grant would cover it too
    const g = w.gh.get(T1)!;
    let pulls = 0;
    g.onRequest = (c) => {
      if (c.method === "GET" && /pulls\/42$/.test(c.path) && ++pulls === 2) throw new Error("socket hang up"); // the live checks of the exit
    };
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ status: 503 });
    expect(grantRecords(w).map((r) => r.state)).toEqual(["approved"]);
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ details: { reason: "action_in_flight" } });
    expect(grantRecords(w)).toHaveLength(1);
    expect(w.store().get("G-001")!.uses).toHaveLength(1);
    await w.engine().sweep();
    expect(grantRecords(w).map((r) => r.state)).toEqual(["merged"]);
    expect(w.merges(T1)).toHaveLength(1);
    expect(w.store().get("G-001")!.uses).toHaveLength(1);
    expect(w.ops.audits.size).toBe(1);
  });
});

describe("server: review finding 5 (last synchronous look before the guard says yes)", () => {
  it("server: finding 5: a revoke landing during the guard's own awaits still stops the write", async () => {
    const w = await world();
    const a = await w.phone("A");
    await w.create(a, { conditions: ["ci_green", "no_severe_findings"] });
    // findings are asked at selection (1), by the first guard (2) and by the second guard (3): the revoke lands inside the last condition check
    w.onFindings = (n) => {
      if (n === 3) w.engine().store.revoke("G-001", new Date().toISOString());
    };
    await expect(w.engine().tryTask(T1)).rejects.toMatchObject({ code: "grant_invalid", details: { reason: "grant_revoked" } });
    expect(w.merges(T1)).toEqual([]);
    expect(w.writes(T1)).toHaveLength(1); // the check-run only
  });
});

describe("server: review finding 6 (findings that cannot be read are not clear)", () => {
  const withCli = async (script: string, kbDir: string | undefined, fn: (log: string[]) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-findcli-"));
    const saved = { ...process.env };
    const logs: string[] = [];
    try {
      writeFileSync(join(dir, "cli.cjs"), script);
      process.env.VLAD_HOME = dir;
      process.env.VLAD_CLI = join(dir, "cli.cjs");
      if (kbDir) process.env.VLAD_KB_DIR = kbDir;
      else delete process.env.VLAD_KB_DIR;
      await fn(logs);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const out = (o: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(o))});`;

  it("server: finding 6: warnings -> not clear; empty and silent -> clear; a finding -> not clear; a bad slug -> not clear", async () => {
    await withCli(out({ findings: [], warnings: ["F-vlad-003.md: bozuk"] }), undefined, async () => {
      const logs: string[] = [];
      expect(await vladFindingsClear((m) => logs.push(m))("vlad")).toBe(false);
      expect(logs.join("\n")).toMatch(/F-vlad-003/);
    });
    await withCli(out({ findings: [], warnings: [] }), undefined, async () => expect(await vladFindingsClear(() => {})("vlad")).toBe(true));
    await withCli(out({ findings: [{ id: "F-vlad-001" }], warnings: [] }), undefined, async () => expect(await vladFindingsClear(() => {})("vlad")).toBe(false));
    await withCli(out({ findings: [], warnings: [] }), undefined, async () => expect(await vladFindingsClear(() => {})("--evil")).toBe(false));
  });

  it("server: finding 6: a missing findings folder is logged", async () => {
    const kb = mkdtempSync(join(tmpdir(), "vlad-kb-"));
    try {
      await withCli(out({ findings: [], warnings: [] }), kb, async () => {
        const logs: string[] = [];
        expect(await vladFindingsClear((m) => logs.push(m))("vlad")).toBe(true);
        expect(logs.join("\n")).toMatch(/findings klasörü yok/);
        mkdirSync(join(kb, "findings"));
        const again: string[] = [];
        await vladFindingsClear((m) => again.push(m))("vlad");
        expect(again).toEqual([]);
      });
    } finally {
      rmSync(kb, { recursive: true, force: true });
    }
  });
});

describe("server: review finding 7 (only live grants count against the limit; dead ones shrink to tombstones)", () => {
  const rec = (n: number, over: Partial<GrantRecord> = {}): GrantRecord => ({
    id: `G-${String(n).padStart(3, "0")}`, scope: { type: "project", ref: "vlad" }, project: "vlad", repo: REPO, action: "merge_phase", conditions: ["ci_green"],
    created: new Date(1_761_350_000_000).toISOString(), expires: new Date(1_761_350_000_000 + 86_400_000).toISOString(), max_uses: 1, signature: `sig-${n}`, payload_version: "v2", device_id: "d-x", ...over,
  });
  const NOW = 1_761_350_400_000;

  it("server: finding 7: store: dead grants shrink to tombstones, which keep refusing the same id and signature", () => {
    const dir = mkdtempSync(join(tmpdir(), "vlad-store-"));
    try {
      const s = new GrantStore(dir);
      for (let i = 1; i <= MAX_GRANTS; i++) s.add(rec(i, i % 2 ? { expires: new Date(NOW - 1000).toISOString() } : {}), NOW); // odd ones are expired
      for (let i = 2; i <= MAX_GRANTS; i += 4) s.revoke(rec(i).id, "x"); // some live ones revoked
      s.reserve("G-004", "A-1"); // G-004 is live and used: stays whatever happens
      expect(s.size).toBe(MAX_GRANTS);
      s.add(rec(MAX_GRANTS + 1), NOW);
      expect(s.size).toBeLessThan(MAX_GRANTS);
      expect(s.tombstones).toBeGreaterThan(MAX_GRANTS / 2 - 1);
      // a compacted id and a compacted signature are still refused; a stranger is not
      expect(s.has("G-001", "other-sig")).toBe(true);
      expect(s.has("G-999", "sig-1")).toBe(true);
      expect(s.has("G-999", "sig-new")).toBe(false);
      expect(s.get("G-001")).toBeUndefined();
      expect(s.get("G-004")).toBeDefined();
      // survives a restart
      const again = new GrantStore(dir);
      expect(again.tombstones).toBe(s.tombstones);
      expect(again.has("G-001", "x")).toBe(true);
      expect(again.has("G-999", "sig-3")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("server: finding 7: POST: 200 live grants refuse the 201st (409), dead ones do not count", async () => {
    const w = await world();
    const a = await w.phone("A");
    const store = w.engine().store;
    const now = w.r.clock.t;
    for (let i = 100; i < 100 + MAX_GRANTS; i++) store.add(rec(i, { expires: new Date(now + 86_400_000).toISOString(), created: new Date(now).toISOString() }), now);
    const full = await w.post(a, w.grantBody(a, { id: "G-001" }));
    expect([full.statusCode, full.json().error.details.reason]).toEqual([409, "too_many_grants"]);
    for (let i = 100; i < 150; i++) store.revoke(rec(i).id, new Date(now).toISOString());
    const ok = await w.post(a, w.grantBody(a, { id: "G-001" }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(store.size).toBeLessThan(MAX_GRANTS + 1); // the revoked ones were shrunk on the way
    // a shrunk id is still taken
    const taken = await w.post(a, w.grantBody(a, { id: "G-100" }));
    expect([taken.statusCode, taken.json().error.details.reason]).toEqual([409, "id_taken"]);
  });
});

describe("server: review finding 8 (the sweep's cheap test looks at live grants only)", () => {
  it("server: finding 8: dead grants (revoked, expired, device revoked, exhausted) cost no GitHub read", async () => {
    const w = await world();
    const a = await w.phone("A");
    const b = await w.phone("B");
    await w.create(a, { id: "G-001" });
    await w.create(a, { id: "G-002", expires: w.iso(w.r.clock.t + 3600_000) });
    await w.create(b, { id: "G-003" });
    await w.create(a, { id: "G-004", max_uses: 1 });
    await w.del(a, "G-001");
    w.engine().store.reserve("G-004", "A-used");
    w.r.clock.t += 2 * 3600_000;
    const rv = await signedCall(w.r, a, "POST", `/v1/devices/${b.id}/revoke`, a.revokeBody(b.id, w.r.clock.t));
    expect(rv.statusCode, rv.body).toBe(200);
    await w.engine().sweep();
    expect(await w.engine().tryTask(T1)).toBeNull();
    expect(w.gh.get(T1)!.calls).toEqual([]);
    expect(w.gh.get(T2)!.calls).toEqual([]);
  });
});
