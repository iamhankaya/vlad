import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExec } from "../../src/kbsync/gitexec.ts";
import { promoteKb, type PromoteDeps } from "../../src/kbsync/promote.ts";
import { StateStore } from "../../src/kbsync/state.ts";
import { git, makeWorld, SEED_CARD, type World } from "../helpers/kbRepos.ts";
import { pushToServerBranch, type Change } from "../helpers/kbPromote.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  w: World;
  deps: PromoteDeps;
  stateDir: string;
  repoGit: string;
  calls: { args: string[]; cwd: string; env: Record<string, string | undefined> }[];
  writes: { commit: string; expectedMain: string }[];
  cards: any[];
  resolved: number[];
  /** runs before the n-th git call whose first argument is `name` */
  before: Map<string, () => void>;
  run: (o?: { trigger?: "timer" | "takeover"; waitLockMs?: number }) => ReturnType<typeof promoteKb>;
}

/** Real git against a local bare remote; the exec is the test's own (it merges per-call `env`, as the production runner does). */
function rig(opts: { w?: World; machine?: string; delayMs?: number } = {}): Rig {
  const w = opts.w ?? makeWorld();
  const stateDir = mkdtempSync(join(tmpdir(), "vlad-s13c-"));
  dirs.push(stateDir);
  const repoGit = join(stateDir, "repo.git");
  spawnSync("git", ["init", "--bare", "-q", repoGit]);
  const calls: Rig["calls"] = [];
  const before = new Map<string, () => void>();
  const gitExec: GitExec = async (args, call = {}) => {
    const hook = before.get(args[0]!);
    if (hook) { before.delete(args[0]!); hook(); }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const env = { PATH: process.env.PATH, HOME: stateDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "ambient", GIT_AUTHOR_EMAIL: "a@a.test", GIT_COMMITTER_NAME: "ambient", GIT_COMMITTER_EMAIL: "a@a.test", ...call.env };
    calls.push({ args, cwd: repoGit, env });
    const r = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd: repoGit, encoding: "utf8", input: call.input, env: env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const writes: Rig["writes"] = [];
  const cards: any[] = [];
  const resolved: number[] = [];
  const deps: PromoteDeps = {
    config: { repo: "acme/vlad-kb", main: "main", serverBranch: "kb-server", serverMachine: opts.machine ?? "srvbox", stateDir, remoteUrl: w.url },
    git: gitExec,
    tokens: { token: async () => "tok" },
    writer: {
      pushKbMain: async (commit, expectedMain) => {
        const parent = (await gitExec(["rev-parse", `${commit}^1`])).stdout.trim();
        if (parent !== expectedMain) throw new Error("ilk ebeveyn beklenen main değil");
        if (w.remoteHead("main") !== expectedMain) return { kind: "main_moved" as const };
        const r = await gitExec(["push", "-q", w.url, `${commit}:refs/heads/main`]);
        if (r.code !== 0) return { kind: "main_moved" as const };
        writes.push({ commit, expectedMain });
        return { kind: "pushed" as const };
      },
    },
    cards: {
      open: async (i) => { cards.push(i); return { id: `C-20261025-${String(cards.length).padStart(2, "0")}`, created: true }; },
      resolveOpen: async () => { resolved.push(1); return 1; },
    },
    now: () => Date.now(),
  };
  return { w, deps, stateDir, repoGit, calls, writes, cards, resolved, before, run: (o) => promoteKb(deps, o) };
}

const ok1 = (path: string, text = "# x\n"): Change => ({ path, text });
const bad = (n: number): Change[] => [ok1(`logs/bad-${n}.md`)];

describe("server: promote", () => {
  it("server: promote writes --no-ff commit with parents [main, kb-server] and vlad-gate author", async () => {
    const r = rig();
    const main = r.w.remoteHead("main")!;
    const tip = pushToServerBranch(r.w, [[ok1("tasks/T20261025-01-x.md")]]);
    const res = await r.run();
    expect(res).toMatchObject({ promoted: true, head: tip });
    expect(r.writes).toHaveLength(1);
    const c = r.writes[0]!.commit;
    expect(r.repoGit && git(r.repoGit, ["rev-list", "--parents", "-n1", c]).split(" ").slice(1)).toEqual([main, tip]);
    expect(git(r.repoGit, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", c])).toBe("vlad-gate <vlad-gate@users.noreply.github.com>|vlad-gate <vlad-gate@users.noreply.github.com>");
    expect(res.merge).toBe(c);
  });

  it("server: promote pushes exactly the validated commit, non-force", async () => {
    const r = rig();
    const main = r.w.remoteHead("main")!;
    pushToServerBranch(r.w, [[ok1("journal/2026-10-26.md")]]);
    const res = await r.run();
    expect(res.promoted).toBe(true);
    expect(r.w.remoteHead("main")).toBe(r.writes[0]!.commit);
    // fast-forward of the old main: nothing was rewritten
    expect(r.w.remoteGit("merge-base", "--is-ancestor", main, "main")).toBe("");
    // the tree that landed is the merge-tree result that was checked, i.e. main's tree plus exactly the new file
    expect(r.w.remoteGit("diff-tree", "-r", "--name-status", "--no-renames", main, "main")).toBe("A\tjournal/2026-10-26.md");
    // the one push is the stand-in writer's, of exactly that commit to the fixed ref; promote itself never pushes (the real port is tested in gitexec.test.ts)
    expect(r.calls.filter((c) => c.args[0] === "push").map((c) => c.args)).toEqual([["push", "-q", r.w.url, `${r.writes[0]!.commit}:refs/heads/main`]]);
    for (const c of r.calls) expect(c.args.join(" ")).not.toMatch(/--force|\s-f\b/);
    expect(r.w.remoteGit("for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/kb-server", "refs/heads/main"]);
  });

  it("server: main moved -> main_moved, no write", async () => {
    const r = rig();
    pushToServerBranch(r.w, [[ok1("journal/2026-10-26.md")]]);
    const moved = r.w.machines.winbox!;
    // Windows lands a commit on main between the fetch and the push
    r.before.set("commit-tree", () => {
      moved.write("journal/2026-10-27.md", "# w\n");
      moved.ok(["kb", "commit", "windows", "--push"]);
    });
    const mainBefore = r.w.remoteHead("main")!;
    const res = await r.run();
    expect(res).toMatchObject({ promoted: false, reason: "main_moved" });
    expect(r.writes).toEqual([]);
    expect(r.w.remoteHead("main")).not.toBe(mainBefore); // windows' own commit only
    expect(r.w.remoteGit("log", "-1", "--format=%an", "main")).not.toBe("vlad-gate");
    // the next cycle lands both
    expect(await r.run()).toMatchObject({ promoted: true });
  });

  it("server: up to date -> no write", async () => {
    const r = rig();
    expect(await r.run()).toMatchObject({ promoted: false, reason: "up_to_date" });
    pushToServerBranch(r.w, [[ok1("journal/2026-10-26.md")]]);
    expect((await r.run()).promoted).toBe(true);
    expect(await r.run()).toMatchObject({ promoted: false, reason: "up_to_date" });
    expect(r.writes).toHaveLength(1);
  });

  it("server: promote reports no_server_branch, github_unavailable, not_configured", async () => {
    const r = rig();
    r.w.remoteGit("update-ref", "-d", "refs/heads/kb-server");
    expect(await r.run()).toMatchObject({ promoted: false, reason: "no_server_branch" });
    const down = rig({ w: r.w });
    down.deps.config.remoteUrl = "file:///nonexistent/repo.git";
    expect(await down.run()).toMatchObject({ promoted: false, reason: "github_unavailable" });
    const off = rig();
    off.deps.config.serverBranch = "main";
    expect(await off.run()).toMatchObject({ promoted: false, reason: "not_configured" });
    off.deps.config.serverBranch = "bad branch";
    expect(await off.run()).toMatchObject({ promoted: false, reason: "not_configured" });
  });

  it("server: diverged -> kb_conflict card, not reopened", async () => {
    const r = rig();
    const mainBefore = r.w.remoteHead("main")!;
    pushToServerBranch(r.w, [bad(1)]);
    const first = await r.run();
    expect(first).toMatchObject({ promoted: false, reason: "rejected", card: "C-20261025-01" });
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]).toMatchObject({ reason: "rejected", source: "promote", paths: ["logs/bad-1.md"], rules: ["path_not_allowed"] });
    expect(r.cards[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cards[0].base).toBe(mainBefore);
    // later cycles: same key, even though the kb copy of the card could have been resolved, dismissed or deleted
    for (let i = 0; i < 3; i++) expect(await r.run()).toMatchObject({ reason: "rejected", card: "C-20261025-01" });
    expect(r.cards).toHaveLength(1);
    // an unrelated clean commit on top does not change the key of the same violation
    pushToServerBranch(r.w, [[ok1("journal/2026-10-28.md")]]);
    await r.run();
    expect(r.cards).toHaveLength(1);
    expect(new StateStore(r.stateDir).read().blocked).toMatchObject({ card: "C-20261025-01" });
    expect(r.w.remoteHead("main")).toBe(mainBefore);
  });

  it("server: new violation set -> new card", async () => {
    const r = rig();
    pushToServerBranch(r.w, [bad(1)]);
    await r.run();
    pushToServerBranch(r.w, [bad(2)]);
    const res = await r.run();
    expect(res.violations?.map((v) => v.path).sort()).toEqual(["logs/bad-1.md", "logs/bad-2.md"]);
    expect(r.cards).toHaveLength(2);
    expect(r.cards[1].key).not.toBe(r.cards[0].key);
  });

  it("server: a card that cannot be opened does not stop the rejection and is retried", async () => {
    const r = rig();
    let fail = true;
    const open = r.deps.cards.open;
    r.deps.cards.open = async (i) => { if (fail) throw new Error("active_elsewhere"); return open(i); };
    pushToServerBranch(r.w, [bad(1)]);
    expect(await r.run()).toMatchObject({ promoted: false, reason: "rejected" });
    expect(new StateStore(r.stateDir).read().blocked).not.toBeNull(); // visible as `blocked` regardless of the card
    fail = false;
    expect(await r.run()).toMatchObject({ reason: "rejected", card: "C-20261025-01" });
  });

  it("server: merge-tree conflict -> reason merge_conflict, no card from promote", async () => {
    const r = rig();
    const win = r.w.machines.winbox!;
    win.write("decisions.md", "# Karar günlüğü\n\nwindows kararı\n");
    win.ok(["kb", "commit", "windows", "--push"]);
    pushToServerBranch(r.w, [[ok1("decisions.md", "# Karar günlüğü\n\nsunucu kararı\n")]]);
    const mainBefore = r.w.remoteHead("main");
    const res = await r.run();
    expect(res).toMatchObject({ promoted: false, reason: "merge_conflict" });
    expect(r.cards).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.w.remoteHead("main")).toBe(mainBefore);
  });

  it("server: a violation wins over a merge conflict in the report", async () => {
    const r = rig();
    const win = r.w.machines.winbox!;
    win.write("decisions.md", "# Karar günlüğü\n\nwindows\n");
    win.ok(["kb", "commit", "windows", "--push"]);
    pushToServerBranch(r.w, [[ok1("decisions.md", "# Karar günlüğü\n\nsunucu\n"), ok1("src/evil.md")]]);
    expect(await r.run()).toMatchObject({ promoted: false, reason: "rejected" });
  });

  it("server: promote success resolves open promote cards", async () => {
    const r = rig();
    pushToServerBranch(r.w, [bad(1)]);
    await r.run();
    expect(r.resolved).toHaveLength(0);
    r.w.remoteGit("update-ref", "refs/heads/kb-server", r.w.remoteHead("main")!); // discard: kb-server rebuilt on main
    pushToServerBranch(r.w, [[ok1("journal/2026-10-26.md")]]);
    expect((await r.run()).promoted).toBe(true);
    expect(r.resolved).toHaveLength(1);
    expect(new StateStore(r.stateDir).read().blocked).toBeNull();
  });

  it("server: promote rename shows up as delete + add (--no-renames) and is refused", async () => {
    const r = rig();
    const d = r.w.scratch("kb-server");
    git(d, ["mv", "projects/alpha.md", "projects/beta.md"]);
    git(d, ["commit", "-q", "-m", "rename"]);
    git(d, ["push", "-q", "origin", "HEAD:refs/heads/kb-server"]);
    const res = await r.run();
    expect(res).toMatchObject({ promoted: false, reason: "rejected" });
    expect(res.violations).toEqual(expect.arrayContaining([{ rule: "delete_not_allowed", path: "projects/alpha.md" }]));
    expect(r.calls.some((c) => c.args[0] === "diff-tree" && c.args.includes("--no-renames"))).toBe(true);
  });

  it("server: promote never runs git in the agent kb clone", async () => {
    const r = rig();
    const srv = r.w.machines.srvbox!;
    const marker = join(r.stateDir, "pwned");
    // the agent controls its own clone's config: fsmonitor and hooks would run code in whoever runs git there
    git(srv.kb, ["config", "core.fsmonitor", `touch ${marker}`]);
    git(srv.kb, ["config", "core.hooksPath", join(r.stateDir, "hooks")]);
    writeFileSync(join(r.stateDir, "hooks-marker"), "");
    srv.write("journal/2026-10-26.md", "# s\n");
    // commit through git directly with the traps off, then push; promote must only ever touch its bare clone
    git(srv.kb, ["-c", "core.fsmonitor=false", "add", "-A"]);
    git(srv.kb, ["-c", "core.fsmonitor=false", "commit", "-q", "-m", "s"]);
    git(srv.kb, ["-c", "core.fsmonitor=false", "push", "-q", "origin", "HEAD:refs/heads/kb-server"]);
    const res = await r.run();
    expect(res.promoted).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(r.calls.length).toBeGreaterThan(5);
    for (const c of r.calls) expect(c.cwd).toBe(r.repoGit);
    for (const c of r.calls) expect(JSON.stringify(c.args)).not.toContain(srv.kb);
  });

  it("server: concurrent promote (timer + takeover) -> one runs, other busy", async () => {
    const r = rig({ delayMs: 15 });
    pushToServerBranch(r.w, [[ok1("journal/2026-10-26.md")]]);
    const [a, b] = await Promise.all([r.run(), r.run()]);
    expect([a.reason, b.reason].filter((x) => x === "busy")).toHaveLength(1);
    expect([a.promoted, b.promoted].filter(Boolean)).toHaveLength(1);
    expect(r.writes).toHaveLength(1);
    // a takeover waits for the lock instead of giving up
    pushToServerBranch(r.w, [[ok1("journal/2026-10-27.md")]]);
    const [c, d] = await Promise.all([r.run(), r.run({ trigger: "takeover", waitLockMs: 10_000 })]);
    expect([c.promoted, d.promoted].filter(Boolean)).toHaveLength(1);
    expect([c, d].some((x) => x.reason === "busy")).toBe(false);
    // the lock is released
    expect(existsSync(join(r.stateDir, "promote.lock"))).toBe(false);
  });

  it("server: promote reads the checked blobs, not a moving ref (violation text of a card is clean)", async () => {
    const r = rig();
    pushToServerBranch(r.w, [[ok1("tasks/a\u0001b.md")]]);
    await r.run();
    expect(r.cards[0].paths[0]).toBe("tasks/a?b.md");
    expect(JSON.parse(readFileSync(join(r.stateDir, "state.json"), "utf8")).seen).toHaveProperty(r.cards[0].key);
  });

  it("server: promote project card edits that touch no executing field pass, a gate does not", async () => {
    const r = rig();
    pushToServerBranch(r.w, [[{ path: "projects/alpha.md", text: SEED_CARD().replace("paths:\n", "paths:\n  srvbox: /srv/alpha\n") }]]);
    expect((await r.run()).promoted).toBe(true);
    pushToServerBranch(r.w, [[{ path: "projects/alpha.md", text: SEED_CARD("gate: x\n").replace("paths:\n", "paths:\n  srvbox: /srv/alpha\n") }]]);
    expect(await r.run()).toMatchObject({ reason: "rejected", violations: [{ rule: "sensitive_field", path: "projects/alpha.md", detail: "gate" }] });
  });
});
