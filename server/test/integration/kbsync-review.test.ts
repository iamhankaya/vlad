// S13c security review (T20261025-91): one describe per finding. Names carry the finding number.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, REPO_TOO_LARGE, RUN_TIMEOUT, spawnRunner } from "../../src/kbsync/gitexec.ts";
import { promoteKb, type PromoteDeps } from "../../src/kbsync/promote.ts";
import { readSmallFile, writeFileAtomicNoFollow } from "../../src/kbsync/safefile.ts";
import { acquireLock, StateStore } from "../../src/kbsync/state.ts";
import { createTakeover, readSyncStatus, requestSync, settlePendingTakeover, type TakeoverDeps } from "../../src/kbsync/takeover.ts";
import { makeWorld, SEED_CARD, type World } from "../helpers/kbRepos.ts";
import { makePromoteEnv, pushToServerBranch, type Change, type PromoteEnv } from "../helpers/kbPromote.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-rev-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ok1 = (path: string, text = "# x\n"): Change => ({ path, text });
const ACTIVE = (o: { machine?: string; since?: string; heartbeat?: string } = {}) =>
  `---\nmachine: ${o.machine ?? "srvbox"}\nsince: ${o.since ?? "2026-10-25T10:00:00Z"}\nheartbeat: ${o.heartbeat ?? "2026-10-25T10:00:00Z"}\n---\n`;
const setTakeover = (e: PromoteEnv, t: { state: "active" | "pending" | "lost"; reason?: string; ageMs?: number }) =>
  new StateStore(e.stateDir).update((s) => { s.takeover = { state: t.state, ...(t.reason ? { reason: t.reason } : {}), at: new Date(Date.now() - (t.ageMs ?? 0)).toISOString() }; });

async function refused(e: PromoteEnv, w: World, rule: string, path: string, detail?: RegExp) {
  const main = w.remoteHead("main");
  const r = await e.run();
  expect(r, JSON.stringify(r)).toMatchObject({ promoted: false, reason: "rejected" });
  const v = (r.violations ?? []).find((x) => x.rule === rule && x.path === path);
  expect(v, JSON.stringify(r.violations)).toBeDefined();
  if (detail) expect(v!.detail).toMatch(detail);
  expect(w.remoteHead("main")).toBe(main);
  expect(e.writes).toEqual([]);
}

describe("finding 1 (high): no write through a symlink the agent planted", () => {
  it("F1: requestSync replaces a symlinked kbsync.request instead of writing through it, and ignores planted temp names", () => {
    const kb = tmp(), victim = join(tmp(), "victim.txt");
    writeFileSync(victim, "KORUNMALI\n");
    mkdirSync(join(kb, "logs"));
    symlinkSync(victim, join(kb, "logs", "kbsync.request"));
    for (const n of ["kbsync.request.tmp", `kbsync.request.${process.pid}.tmp`, `.kbsync.request.${process.pid}.tmp`]) symlinkSync(victim, join(kb, "logs", n));
    const seq = requestSync(kb, "takeover");
    expect(seq).toBe(1);
    expect(readFileSync(victim, "utf8")).toBe("KORUNMALI\n");
    expect(lstatSync(join(kb, "logs", "kbsync.request")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(kb, "logs", "kbsync.request"), "utf8"))).toMatchObject({ seq: 1, reason: "takeover" });
    // no stray temp file of ours next to the planted ones
    expect(readdirSync(join(kb, "logs")).filter((n) => /^\.kbsync\.request\.[0-9a-f]{16}\.tmp$/.test(n))).toEqual([]);
  });

  it("F1: a symlinked logs directory is refused outright", () => {
    const kb = tmp(), outside = tmp();
    symlinkSync(outside, join(kb, "logs"));
    expect(() => requestSync(kb, "takeover")).toThrow(/symlink üst klasör/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("F1: `vlad active claim --takeover` over a symlinked active.md leaves the target alone (the CLI vladapi runs)", () => {
    const w = makeWorld();
    const srv = w.machines.srvbox!;
    const victim = join(tmp(), "victim.txt");
    writeFileSync(victim, "KORUNMALI\n");
    symlinkSync(victim, join(srv.kb, "active.md"));
    const r = srv.run(["active", "claim", "--takeover", "--json"]);
    // either it refuses or it replaced the link: in both cases the victim is untouched
    expect(readFileSync(victim, "utf8")).toBe("KORUNMALI\n");
    expect(r.code === 0 ? lstatSync(join(srv.kb, "active.md")).isSymbolicLink() : true).toBe(false);
    if (r.code === 0) expect(readFileSync(join(srv.kb, "active.md"), "utf8")).toMatch(/machine: srvbox/);
  });
});

describe("finding 2: the gate reads front matter the way the CLI does, and refuses what it could read differently", () => {
  const worldWithGate = () => makeWorld({ seed: { "projects/alpha.md": SEED_CARD("gate: npm test\n") } });
  const edit = (f: (t: string) => string) => ok1("projects/alpha.md", f(SEED_CARD("gate: npm test\n")));

  it("F2: a %YAML 1.1 directive, anchors/aliases, tags and << merge keys are refused", async () => {
    const attacks: [string, (t: string) => string][] = [
      ["%YAML directive", (t) => "%YAML 1.1\n" + t.replace("---\n", "---\n")],
      ["%YAML inside the front matter", (t) => t.replace("slug: alpha", "%YAML 1.1\nslug: alpha")],
      ["anchor and alias", (t) => t.replace("gate: npm test", "g: &x npm test\ngate: *x")],
      ["explicit tag", (t) => t.replace("gate: npm test", "gate: !!str npm test")],
      ["merge key", (t) => t.replace("gate: npm test\n", "base: &b\n  gate: npm test\n<<: *b\n")],
      ["duplicate key", (t) => t.replace("gate: npm test", "gate: npm test\ngate: other")],
    ];
    for (const [name, f] of attacks) {
      const w = worldWithGate(), e = makePromoteEnv(w);
      pushToServerBranch(w, [[edit(f)]]);
      await refused(e, w, "sensitive_field", "projects/alpha.md", /frontmatter/);
      expect(name).toBeTruthy();
    }
  });

  it("F2: a card the project schema rejects (local_only: yes, wrong status) is refused with the schema's reason", async () => {
    for (const bad of [(t: string) => t.replace("---\n\n", "local_only: yes\n---\n\n"), (t: string) => t.replace("status: active", "status: nope")]) {
      const w = worldWithGate(), e = makePromoteEnv(w);
      pushToServerBranch(w, [[edit(bad)]]);
      const r = await e.run();
      expect(r.reason).toBe("rejected");
      expect(r.violations!.some((v) => v.rule === "sensitive_field" && /schema|local_only/.test(v.detail ?? ""))).toBe(true);
    }
  });

  it("F2: an ordinary edit (body, BOM, CRLF) still passes", async () => {
    const w = worldWithGate(), e = makePromoteEnv(w);
    const body = SEED_CARD("gate: npm test\n").replace("## Özet\nx", "## Özet\nx\n\n## Çalışma notları\n- ders");
    pushToServerBranch(w, [[ok1("projects/alpha.md", "\uFEFF" + body.replace(/\n/g, "\r\n"))]]);
    expect(await e.run(), "BOM + CRLF").toMatchObject({ promoted: true });
  });
});

describe("finding 3: active.md changes on main only for a pending takeover or a heartbeat", () => {
  it("F3: without a pending takeover a new active.md is refused", async () => {
    const w = makeWorld(), e = makePromoteEnv(w);
    pushToServerBranch(w, [[ok1("active.md", ACTIVE())]]);
    await refused(e, w, "sensitive_field", "active.md", /devralma beklemiyor/);
  });

  it("F3: a pending takeover lets the server's own record through; another machine's record, an old or failed takeover, and a bad record do not", async () => {
    for (const [label, t, text, detail] of [
      ["ok", { state: "pending" as const, reason: "in_progress" }, ACTIVE(), null],
      ["names another machine", { state: "pending" as const }, ACTIVE({ machine: "winbox" }), /başka makineyi/],
      ["stale takeover", { state: "pending" as const, ageMs: 31 * 60_000 }, ACTIVE(), /devralma beklemiyor/],
      ["failed takeover", { state: "lost" as const, reason: "failed" }, ACTIVE(), /devralma beklemiyor/],
      ["schema", { state: "pending" as const }, ACTIVE({ heartbeat: "yesterday" }), /schema/],
      ["not a record", { state: "pending" as const }, "# merhaba\n", /frontmatter/],
    ] as const) {
      const w = makeWorld(), e = makePromoteEnv(w);
      setTakeover(e, t);
      pushToServerBranch(w, [[ok1("active.md", text)]]);
      if (detail === null) expect(await e.run(), label).toMatchObject({ promoted: true });
      else await refused(e, w, "sensitive_field", "active.md", detail);
    }
  });

  it("F3: once main names the server, only the heartbeat may move (forward); since, takeover_from, machine and deletion may not", async () => {
    const w = makeWorld(), e = makePromoteEnv(w);
    setTakeover(e, { state: "pending" });
    pushToServerBranch(w, [[ok1("active.md", ACTIVE())]]);
    expect((await e.run()).promoted).toBe(true);
    setTakeover(e, { state: "active" });
    pushToServerBranch(w, [[ok1("active.md", ACTIVE({ heartbeat: "2026-10-25T10:30:00Z" }))]]);
    expect(await e.run()).toMatchObject({ promoted: true });
    // each of these, one at a time, from the landed state
    const base = w.remoteHead("main")!;
    for (const [label, change, rule, detail] of [
      ["heartbeat backwards", ok1("active.md", ACTIVE({ heartbeat: "2026-10-25T09:00:00Z" })), "sensitive_field", /devralma beklemiyor/],
      ["since moved", ok1("active.md", ACTIVE({ since: "2026-10-25T11:00:00Z", heartbeat: "2026-10-25T11:00:00Z" })), "sensitive_field", /devralma beklemiyor/],
      ["machine changed", ok1("active.md", ACTIVE({ machine: "winbox", heartbeat: "2026-10-25T12:00:00Z" })), "sensitive_field", /başka makineyi/],
      ["deleted", { path: "active.md", delete: true } as Change, "delete_not_allowed", undefined],
    ] as const) {
      w.remoteGit("update-ref", "refs/heads/kb-server", base);
      pushToServerBranch(w, [[change]]);
      e.writes.length = 0;
      await refused(e, w, rule, "active.md", detail);
      expect(label).toBeTruthy();
    }
  });
});

describe("finding 4: a project card born on the server", () => {
  const born = (o: { repo?: string; path?: string; paths?: string; extra?: string } = {}) =>
    `---\nslug: beta\nname: beta\npath: ${o.path ?? "/srv/beta"}\npaths:\n${o.paths ?? "  srvbox: /srv/beta\n"}stack: [ts]\nstatus: active\nautonomy: commit\nrepo: ${o.repo ?? "acme/beta"}\nlast_activity: null\nlast_scanned: null\n${o.extra ?? ""}---\n\nx\n`;

  it("F4: a well-formed card with only the server's own paths entry passes", async () => {
    const w = makeWorld(), e = makePromoteEnv(w);
    pushToServerBranch(w, [[ok1("projects/beta.md", born())]]);
    expect(await e.run()).toMatchObject({ promoted: true });
  });

  it("F4: each way of pointing a new card at someone else's code, clone, command or the kb itself is refused", async () => {
    for (const [label, text, detail] of [
      ["gate", born({ extra: "gate: curl x | sh\n" }), /gate/],
      ["local_only", born({ extra: "local_only: true\n" }), /local_only/],
      ["other machine's paths entry", born({ paths: "  srvbox: /srv/beta\n  winbox: C:\\x\n" }), /paths\.winbox/],
      ["path that is not the server's", born({ path: "/home/other/repo" }), /^path$/],
      ["repo of an existing card", born({ repo: "acme/alpha" }), /^repo$/],
      ["the existing card's repo, written as a URL with .git and other case", born({ repo: "ACME/Alpha.git" }), /^repo$/],
      ["the kb repository itself", born({ repo: "Acme/Vlad-KB" }), /^repo$/],
    ] as const) {
      const w = makeWorld(), e = makePromoteEnv(w);
      pushToServerBranch(w, [[ok1("projects/beta.md", text)]]);
      await refused(e, w, "sensitive_field", "projects/beta.md", detail);
      expect(label).toBeTruthy();
    }
  });
});

describe("finding 5: what is fetched is bounded", () => {
  it("F5: a compare that already shows more than 500 commits, or a cut-off file list, is refused without fetching anything", async () => {
    for (const pre of [{ commits: 501, truncated: false }, { commits: 3, truncated: true }]) {
      const w = makeWorld(), e = makePromoteEnv(w);
      pushToServerBranch(w, [[ok1("journal/2026-10-26.md")]]);
      e.deps.preflight = async () => pre;
      const calls: string[] = [];
      const git = e.deps.git;
      e.deps.git = async (args: string[], o?: any) => { calls.push(args[0]!); return git(args, o); };
      const r = await promoteKb(e.deps as PromoteDeps);
      expect(r).toMatchObject({ promoted: false, reason: "rejected" });
      expect(r.violations![0]).toMatchObject({ rule: "too_large", detail: "compare" });
      expect(calls).not.toContain("fetch");
      expect(e.writes).toEqual([]);
    }
    // an unusable preflight (null, or a throw) falls back to the fetch limits
    const w = makeWorld(), e = makePromoteEnv(w);
    pushToServerBranch(w, [[ok1("journal/2026-10-26.md")]]);
    e.deps.preflight = async () => { throw new Error("rate limited"); };
    expect(await promoteKb(e.deps as PromoteDeps)).toMatchObject({ promoted: true });
  });

  it("F5: a refused branch head is fetched once; its objects are dropped; a new head is looked at again", async () => {
    const w = makeWorld(), e = makePromoteEnv(w);
    pushToServerBranch(w, [[ok1("logs/bad.md")]]);
    const fetches: string[][] = [];
    const git = e.deps.git;
    e.deps.git = async (args: string[], o?: any) => { if (args[0] === "fetch") fetches.push(args); return git(args, o); };
    for (let i = 0; i < 4; i++) expect(await promoteKb(e.deps as PromoteDeps)).toMatchObject({ reason: "rejected", violations: [{ rule: "path_not_allowed", path: "logs/bad.md" }] });
    expect(fetches).toHaveLength(1);
    expect(e.cards).toHaveLength(1);
    // the refused tip is not kept: no tracking ref, and nothing unreachable is left lying around
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "refs/remotes/origin/kb-server"], { cwd: e.repoGit }).status).not.toBe(0);
    expect(spawnSync("git", ["count-objects", "-v"], { cwd: e.repoGit, encoding: "utf8" }).stdout).toMatch(/^garbage: 0$/m);
    // a different head is a new question
    pushToServerBranch(w, [[ok1("logs/bad2.md")]]);
    expect((await promoteKb(e.deps as PromoteDeps)).violations!.map((v) => v.path).sort()).toEqual(["logs/bad.md", "logs/bad2.md"]);
    expect(fetches).toHaveLength(2);
  });

  it("F5: a cached refusal is dropped when main or the takeover state changes (the content rules depend on both)", async () => {
    const w = makeWorld(), e = makePromoteEnv(w);
    pushToServerBranch(w, [[ok1("active.md", ACTIVE())]]);
    expect(await e.run()).toMatchObject({ reason: "rejected" });
    setTakeover(e, { state: "pending", reason: "in_progress" });
    expect(await e.run()).toMatchObject({ promoted: true });
  });

  it("F5: a run is killed after its timeout, and a fetch that grows the clone past its cap is killed", async () => {
    const dir = tmp();
    const env = { PATH: process.env.PATH! };
    const slow = await spawnRunner("sh", ["-c", "sleep 5; echo late"], { cwd: dir, env, limits: { timeoutMs: 150 } });
    expect(slow.code).not.toBe(0);
    expect(slow.stdout).toBe("");
    expect(slow.stderr).toContain(RUN_TIMEOUT);
    const big = await spawnRunner("sh", ["-c", "head -c 3000000 /dev/zero > blob; sleep 5"], { cwd: dir, env, limits: { timeoutMs: 10_000, watch: { dir, maxBytes: 1_000_000 } } });
    expect(big.stderr).toContain(REPO_TOO_LARGE);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  }, 20_000);

  it("F5: the unit is limited (timeout, memory, tasks) and sandboxed", () => {
    const unit = readFileSync(join(import.meta.dirname, "..", "..", "..", "deploy", "systemd", "vlad-kbpromote.service"), "utf8");
    for (const line of ["TimeoutStartSec=300", "MemoryMax=512M", "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/var/lib/vladapi @KB_DIR@", "PrivateTmp=yes"]) expect(unit).toContain(line);
    // the same template the kbsync units use, so one installer substitution covers both (review Y2)
    const sync = readFileSync(join(import.meta.dirname, "..", "..", "..", "deploy", "systemd", "vlad-kbsync.service"), "utf8");
    expect(sync).toContain("@KB_DIR@");
    expect(unit).toMatch(/installer replaces @KB_DIR@/);
  });
});

describe("finding 6: files the agent writes are read with care", () => {
  it("F6: a symlink, a FIFO, a directory and an oversized file are never read; a small regular file is", () => {
    const d = tmp(), victim = join(tmp(), "secret.json");
    writeFileSync(victim, JSON.stringify({ v: 1, seq: 9, ok: true }));
    symlinkSync(victim, join(d, "link.json"));
    spawnSync("mkfifo", [join(d, "fifo.json")]);
    mkdirSync(join(d, "dir.json"));
    writeFileSync(join(d, "big.json"), "x".repeat(64 * 1024 + 1));
    writeFileSync(join(d, "ok.json"), "{\"a\":1}");
    expect(readSmallFile(join(d, "link.json"))).toBeNull();
    expect(readSmallFile(join(d, "fifo.json"))).toBeNull(); // returns instead of hanging on the FIFO
    expect(readSmallFile(join(d, "dir.json"))).toBeNull();
    expect(readSmallFile(join(d, "big.json"))).toBeNull();
    expect(readSmallFile(join(d, "missing.json"))).toBeNull();
    expect(readSmallFile(join(d, "ok.json"))).toBe("{\"a\":1}");
    mkdirSync(join(d, "logs"));
    symlinkSync(victim, join(d, "logs", "kbsync.status.json"));
    expect(readSyncStatus(d)).toBeNull();
  });
});

describe("finding 7: state.json is updated under a lock", () => {
  it("F7: several processes updating at once lose nothing", () => {
    const dir = tmp();
    const script = join(tmp(), "w.ts");
    writeFileSync(script, `import { StateStore } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "src", "kbsync", "state.ts"))};
const [dir, who] = process.argv.slice(2);
const s = new StateStore(dir);
for (let i = 0; i < 25; i++) s.update((st) => { st.seen[who + "-" + i] = "C-" + i; });
`);
    const procs = ["a", "b", "c", "d"].map((w) => new Promise<number>((res) => {
      const c = spawnSync("node", [script, dir, w], { encoding: "utf8" });
      res(c.status ?? -1);
    }));
    return Promise.all(procs).then((codes) => {
      expect(codes).toEqual([0, 0, 0, 0]);
      expect(Object.keys(new StateStore(dir).read().seen)).toHaveLength(100);
    });
  });

  it("F7: a stale lock is taken over, a fresh one is waited for, and a lock is released only by its owner", () => {
    const dir = tmp();
    const store = new StateStore(dir);
    store.update((s) => { s.lastOk = "x"; });
    const lock = join(dir, "state.json.lock");
    writeFileSync(lock, "999999.dead");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    store.update((s) => { s.lastOk = "y"; });
    expect(store.read().lastOk).toBe("y");
    expect(existsSync(lock)).toBe(false);
    // an update whose callback replaces the lock file (someone judged ours stale) does not delete the other's lock
    store.update(() => { writeFileSync(lock, "someone-else"); });
    expect(readFileSync(lock, "utf8")).toBe("someone-else");
    rmSync(lock);
  });

  it("F7: a takeover that is still in progress is not settled by the timer; a failed one leaves nothing pending", async () => {
    const stateDir = tmp(), kb = tmp();
    const base: Omit<TakeoverDeps, "claim"> = {
      serverMachine: "srvbox", stateDir, now: () => Date.now(), requestSync: (r) => requestSync(kb, r),
      waitSync: async (seq) => ({ v: 1, seq, at: new Date().toISOString(), ok: true, phase: "done" }),
      promote: async () => ({ promoted: true, main: "m" }), mainActive: async () => "winbox",
    };
    let during: unknown;
    const t = createTakeover({ ...base, claim: async () => {
      during = await settlePendingTakeover({ ...base, mainActive: async () => "winbox" }, { promoted: false, reason: "up_to_date", main: "m" });
      throw new Error("claim failed");
    } });
    await expect(t()).rejects.toThrow("claim failed");
    expect(during).toBeNull(); // not settled to "lost" while running
    expect(new StateStore(stateDir).read().takeover).toMatchObject({ state: "lost", reason: "failed" });
    // a crashed run (in_progress, old) is settled by the next promote
    new StateStore(stateDir).update((s) => { s.takeover = { state: "pending", reason: "in_progress", at: new Date(Date.now() - 10 * 60_000).toISOString() }; });
    expect(await settlePendingTakeover({ ...base, mainActive: async () => "winbox" }, { promoted: false, reason: "up_to_date", main: "m" })).toBe("lost");
  });
});

describe("finding 9: one open promote card, clean text", () => {
  it("F9: a new refusal closes the previous open promote card before it opens its own; bidi and invisible characters are cleaned from card paths", async () => {
    const w = makeWorld(), e = makePromoteEnv(w);
    const order: string[] = [];
    e.deps.cards = {
      open: async (i: any) => { order.push("open"); e.cards.push(i); return { id: `C-20261025-0${e.cards.length}`, created: true }; },
      resolveOpen: async () => { order.push("resolve"); return 0; },
    };
    pushToServerBranch(w, [[ok1("logs/one.md")]]);
    await e.run();
    pushToServerBranch(w, [[ok1("tasks/a\u202Eb\u200Bc\u2028d.md")]]);
    await e.run();
    expect(order.slice(0, 4)).toEqual(["resolve", "open", "resolve", "open"]);
    expect(e.cards[1].paths).toContain("tasks/a?b?c?d.md");
    expect(JSON.stringify(e.cards)).not.toMatch(/[\u202e\u200b\u2028]/);
    // the same refusal again does not touch cards
    const n = order.length;
    await e.run();
    expect(order).toHaveLength(n);
  });
});

describe("re-review round (Y1, Y3, Y4, Y5, card cap)", () => {
  it("Y1: a card must be named after its slug; renaming a card's slug is refused", async () => {
    // new card in the wrong file: projects/a-alpha.md claiming slug alpha would shadow the real alpha
    const w = makeWorld(), e = makePromoteEnv(w);
    const born = SEED_CARD().replace("slug: alpha", "slug: alpha").replace("repo: acme/alpha", "repo: acme/shadow").replace("path: /nonexistent/alpha", "path: /srv/s").replace("  winbox: C:\\dev\\alpha", "  srvbox: /srv/s");
    pushToServerBranch(w, [[ok1("projects/a-alpha.md", born)]]);
    await refused(e, w, "sensitive_field", "projects/a-alpha.md", /^slug$/);
    // an existing card whose slug changes
    const w2 = makeWorld(), e2 = makePromoteEnv(w2);
    pushToServerBranch(w2, [[ok1("projects/alpha.md", SEED_CARD().replace("slug: alpha", "slug: other"))]]);
    await refused(e2, w2, "sensitive_field", "projects/alpha.md", /^slug$/);
    // the honest case still passes
    const w3 = makeWorld(), e3 = makePromoteEnv(w3);
    pushToServerBranch(w3, [[ok1("projects/gamma.md", born.replace("slug: alpha", "slug: gamma").replace("name: alpha", "name: gamma").replace("repo: acme/shadow", "repo: acme/gamma"))]]);
    expect(await e3.run()).toMatchObject({ promoted: true });
  });

  it("Y3: the request file is created relative to the opened directory; a symlink swapped in after the check redirects nothing", () => {
    if (process.platform !== "linux") return;
    const kb = tmp(), outside = tmp();
    mkdirSync(join(kb, "logs"));
    writeFileAtomicNoFollow(join(kb, "logs", "kbsync.request"), "{\"seq\":1}\n", kb, () => {
      renameSync(join(kb, "logs"), join(kb, "logs.moved"));
      symlinkSync(outside, join(kb, "logs"));
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(kb, "logs.moved", "kbsync.request"), "utf8")).toBe("{\"seq\":1}\n");
  });

  it("Y3: a symlink anywhere between the kb root and the request file is refused", () => {
    const kb = tmp(), outside = tmp();
    mkdirSync(join(outside, "logs"));
    symlinkSync(outside, join(kb, "state"));
    expect(() => writeFileAtomicNoFollow(join(kb, "state", "logs", "kbsync.request"), "x", kb)).toThrow(/symlink üst klasör/);
    expect(readdirSync(join(outside, "logs"))).toEqual([]);
    expect(() => writeFileAtomicNoFollow(join(outside, "logs", "kbsync.request"), "x", kb)).toThrow(/kb dışında/);
  });

  it("Y4: the leased push is a fast-forward only because the first parent is the expected main; a stale expectation is refused by the remote", async () => {
    const w = makeWorld();
    const stateDir = tmp();
    // the real port over a runner that only adds permission for the local file:// remote
    const { createGitExec, createKbGitPort, ensureBareRepo } = await import("../../src/kbsync/gitexec.ts");
    const { GithubWriter } = await import("../../src/github/writer.ts");
    const run = (file: string, args: string[], o: { cwd: string; env: Record<string, string>; input?: string }) => {
      const r = spawnSync(file, ["-c", "protocol.file.allow=always", ...args], { cwd: o.cwd, env: { ...o.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv, input: o.input, encoding: "utf8" });
      return Promise.resolve({ code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
    };
    await ensureBareRepo(stateDir, run);
    const git = createGitExec({ stateDir, run });
    const out = async (...a: string[]) => (await git(a)).stdout.trim();
    await out("fetch", "-q", w.url, "+refs/heads/main:refs/remotes/origin/main");
    const m0 = await out("rev-parse", "refs/remotes/origin/main");
    const tree = await out("rev-parse", `${m0}^{tree}`);
    const mk = async (parent: string, msg: string) => out("commit-tree", tree, "-p", parent, "-m", msg);
    const writer = new GithubWriter({ request: async () => { throw new Error("no"); } }, { repo: "acme/vlad-kb", main: "main", tokens: { token: async () => "t" }, git: createKbGitPort(git, w.url) });

    const c1 = await mk(m0, "one");
    expect(await writer.pushKbMain(c1, m0)).toEqual({ kind: "pushed" });
    expect(w.remoteHead("main")).toBe(c1);
    // a fast-forward of the old main that is NOT of the current main: the remote moved on, the lease refuses, main is untouched
    const stale = await mk(m0, "stale");
    expect(await writer.pushKbMain(stale, m0)).toEqual({ kind: "main_moved" });
    expect(w.remoteHead("main")).toBe(c1);
    // the property the writer itself guarantees: a commit that does not descend from the expected main never reaches the remote
    const unrelated = await mk(c1, "other parent");
    await expect(writer.pushKbMain(unrelated, m0)).rejects.toThrow(/ilk ebeveyni/);
    expect(w.remoteHead("main")).toBe(c1);
    // and the push is not a plain force: a non-descendant under a MATCHING lease would rewrite history, which firstParent forbids
    const orphan = await out("commit-tree", tree, "-m", "orphan");
    await expect(writer.pushKbMain(orphan, c1)).rejects.toThrow(/ilk ebeveyni|ebeveyni okunamadı/);
    expect(w.remoteHead("main")).toBe(c1);
  });

  it("Y5: promote.lock is released only by its owner, and a stale one is taken over", async () => {
    const dir = tmp();
    const lock = join(dir, "promote.lock");
    const sleep = async () => {};
    const a = (await acquireLock(dir, { waitMs: 0, now: Date.now, sleep }))!;
    expect(a).toBeTypeOf("function");
    expect(await acquireLock(dir, { waitMs: 0, now: Date.now, sleep })).toBeNull(); // held
    // someone judged ours stale and took the file over: our release must leave their lock alone
    writeFileSync(lock, "9999.someone-else");
    a();
    expect(readFileSync(lock, "utf8")).toBe("9999.someone-else");
    // a stale lock (older than 10 minutes) is taken over, and the new owner's release removes it
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, old, old);
    const b = (await acquireLock(dir, { waitMs: 0, now: Date.now, sleep }))!;
    expect(b).toBeTypeOf("function");
    b();
    expect(existsSync(lock)).toBe(false);
  });

  it("card cap: at most 5 promote cards an hour; beyond that the open card stays and no new one is raised, until the hour has passed", async () => {
    const w = makeWorld();
    let t = Date.parse("2026-10-25T12:00:00Z");
    const e = makePromoteEnv(w, { now: () => t });
    for (let i = 1; i <= 8; i++) {
      pushToServerBranch(w, [[ok1(`logs/bad-${i}.md`)]]);
      t += 60_000;
      const r = await e.run();
      expect(r.reason).toBe("rejected");
      if (i > 5) expect(r.card).toBe("C-005"); // the fifth card is still the one shown
    }
    expect(e.cards).toHaveLength(5);
    expect(new StateStore(e.stateDir).read().blocked).toMatchObject({ card: "C-005" });
    // an hour after the first card the cap has room again
    t += 60 * 60_000;
    pushToServerBranch(w, [[ok1("logs/bad-9.md")]]);
    expect((await e.run()).reason).toBe("rejected");
    expect(e.cards).toHaveLength(6);
  });
});
