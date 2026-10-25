import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_SKEW_WARN_MS, activeFile, activeStatus, claimActive } from "../../src/active/index.js";
import { addCard, answerCard, getCard, listCardsWithWarnings, resolveCard } from "../../src/cards/store.js";
import { commitKb } from "../../src/kb/commit.js";
import { serializeDoc } from "../../src/kb/doc.js";
import { KB_GITIGNORE } from "../../src/kb/commit.js";
import { nowIso } from "../../src/kb/time.js";
import { KbConflictError, kbMainBranch, pullKb, resolveKb, syncKb } from "../../src/kb/sync.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
const ident = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...ident } }).trim();

let home: string;
let remote: string;
let kb: string;
let other: string;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const put = (dir: string, file: string, content: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const remoteRev = (ref: string) => sh(remote, "rev-parse", ref);
const commitAll = (dir: string, msg: string) => {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", msg);
};
/** `other` = the Windows VLAD: writes and pushes to main directly. */
const otherPush = (file: string, content: string) => {
  sh(other, "pull", "-q", "--no-rebase", "origin", "main");
  put(other, file, content);
  commitAll(other, `other ${file}`);
  sh(other, "push", "-q", "origin", "main");
};
const activeDoc = (machine: string, heartbeat: string) => serializeDoc({ machine, since: heartbeat, heartbeat }, "");

/** Bare remote + a server kb clone + a second clone; `launcher`/`pushBranch` go to vlad.config.json for machine server1. */
function setup(o: { launcher?: string; pushBranch?: string | null } = {}): void {
  home = makeHome();
  Object.assign(process.env, ident);
  remote = tmp("vlad-s13b-remote-");
  sh(remote, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("vlad-s13b-seed-");
  sh(seed, "clone", "-q", remote, ".");
  put(seed, ".gitignore", KB_GITIGNORE.join("\n") + "\n");
  put(seed, "tasks/seed.md", "seed\n");
  put(seed, "projects/vlad.md", "---\nslug: vlad\n---\n");
  commitAll(seed, "seed");
  sh(seed, "push", "-q", "origin", "main");
  kb = tmp("vlad-s13b-kb-");
  sh(kb, "clone", "-q", remote, ".");
  other = tmp("vlad-s13b-other-");
  sh(other, "clone", "-q", remote, ".");
  process.env.VLAD_KB_DIR = kb;
  process.env.VLAD_MACHINE = "server1";
  const cfg: Record<string, unknown> = { launcher: o.launcher ?? "process" };
  if (o.pushBranch !== null) cfg.machines = { server1: { kbPushBranch: o.pushBranch ?? "kb-server" } };
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify(cfg));
}

/** Both sides change tasks/seed.md: kb locally (committed), main remotely. */
const makeConflict = (file = "tasks/seed.md") => {
  put(kb, file, "local side\n");
  commitAll(kb, "kb: local");
  otherPush(file, "main side\n");
};

const parents = (dir: string, rev = "HEAD") => sh(dir, "rev-list", "--parents", "-n1", rev).split(" ").length - 1;

/** pre-push hook of the kb clone that lets `other` push to `target` first (every time, or only on the first push). */
function racingHook(target: string, always: boolean): string {
  const dir = tmp("vlad-s13b-hook-");
  const script = `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
echo $((n+1)) > "${dir}/count"
if [ "${always ? "1" : "$n"}" = "${always ? "1" : "0"}" ]; then
  cd "${other}" && git pull -q --no-rebase origin ${target} >/dev/null 2>&1
  echo "race $n" > "race-$n.md" && git add -A && git -c user.name=T -c user.email=t@t commit -q -m "race $n" && git push -q origin HEAD:${target} >/dev/null 2>&1
fi
exit 0
`;
  const hook = join(kb, ".git", "hooks", "pre-push");
  writeFileSync(hook, script);
  chmodSync(hook, 0o755);
  return dir;
}

beforeEach(() => setup());
afterEach(() => {
  delete process.env.VLAD_KB_DIR;
  delete process.env.VLAD_MACHINE;
  vi.restoreAllMocks();
});

describe("records: kb push target", () => {
  it("records: commitKb --push without kbPushBranch rejected on server machine", () => {
    setup({ pushBranch: null });
    const before = remoteRev("main");
    put(kb, "tasks/T1.md", "x");
    expect(() => commitKb("sunucu", { push: true })).toThrow(/^kb_push_branch_required/);
    expect(sh(kb, "log", "-1", "--format=%s")).toBe("kb: sunucu");
    expect(remoteRev("main")).toBe(before);
    expect(sh(remote, "branch", "--list", "kb-server")).toBe("");
  });

  it("records: push goes to HEAD:refs/heads/kb-server", () => {
    const before = remoteRev("main");
    put(kb, "tasks/T1.md", "x");
    const r = commitKb("sunucu", { push: true });
    expect(r).toMatchObject({ committed: true, pushed: true, branch: "kb-server", merged: false });
    expect(remoteRev("refs/heads/kb-server")).toBe(sh(kb, "rev-parse", "HEAD"));
    expect(remoteRev("main")).toBe(before);
  });

  it("records: kbPushBranch equal to main or invalid name rejected", () => {
    for (const bad of ["main", "bad name", "-x", "a..b", "x/", "y.lock"]) {
      writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "process", machines: { server1: { kbPushBranch: bad } } }));
      put(kb, "tasks/T1.md", bad);
      expect(() => commitKb("x", { push: true }), bad).toThrow(/^kb_push_branch_invalid/);
    }
    expect(sh(remote, "branch", "--list", "kb-server")).toBe("");
  });

  it("records: server machine requires separate kb layout", () => {
    // legacy layout: the kb lives inside the VLAD repo
    delete process.env.VLAD_KB_DIR;
    sh(home, "init", "-q", "-b", "main");
    put(home, ".gitignore", "kb/inbox/\nkb/logs/\nschemas/\nvlad.config.json\n");
    sh(home, "add", ".gitignore");
    sh(home, "commit", "-q", "-m", "init");
    sh(home, "remote", "add", "origin", remote);
    put(home, "kb/tasks/T1.md", "x");
    expect(() => commitKb("x", { push: true })).toThrow(/^kb_separate_required/);
  });

  it("records: non-kb files in unpushed commits still block push (legacy layout)", () => {
    delete process.env.VLAD_KB_DIR;
    // launcher `process` and no kbPushBranch: a server-like machine, yet the legacy layout keeps its old behavior
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ launcher: "process" }));
    sh(home, "init", "-q", "-b", "main");
    put(home, ".gitignore", "kb/inbox/\nkb/logs/\nschemas/\nvlad.config.json\n");
    put(home, "code.ts", "1");
    sh(home, "add", ".gitignore", "code.ts");
    sh(home, "commit", "-q", "-m", "init");
    const legacyRemote = tmp("vlad-s13b-legacy-");
    sh(legacyRemote, "init", "-q", "--bare", "-b", "main");
    sh(home, "remote", "add", "origin", legacyRemote);
    sh(home, "push", "-q", "-u", "origin", "main");
    put(home, "code.ts", "2");
    sh(home, "commit", "-q", "-am", "kod");
    put(home, "kb/tasks/T1.md", "x");
    const r = commitKb("kb", { push: true });
    expect(r).toMatchObject({ committed: true, pushed: false });
    expect(r.warning).toMatch(/kb dışı/);
    expect(r.branch).toBeUndefined();
  });

  it("records: windows and cloud modes without kbPushBranch push upstream main unchanged", () => {
    for (const launcher of ["wt", "cloud"]) {
      setup({ launcher, pushBranch: null });
      put(kb, "tasks/T1.md", launcher);
      const r = commitKb("yaz", { push: true });
      expect(r, launcher).toMatchObject({ pushed: true, branch: "main" });
      expect(remoteRev("main"), launcher).toBe(sh(kb, "rev-parse", "HEAD"));
      expect(sh(remote, "branch", "--list", "kb-server")).toBe("");
    }
  });
});

describe("records: kb merge on push", () => {
  it("records: push rejected non-fast-forward -> fetch, merge (two parents, no rebase), push once", () => {
    setup({ launcher: "wt", pushBranch: null });
    const counter = racingHook("main", false);
    put(kb, "tasks/mine.md", "mine\n");
    const r = commitKb("mine", { push: true });
    expect(r.merged).toBe(true);
    // two push attempts: the raced one and the single retry
    expect(read(counter, "count").trim()).toBe("2");
    expect(parents(kb)).toBe(2);
    // not rebased: the original commit is still an ancestor under its own sha
    expect(sh(kb, "merge-base", "--is-ancestor", r.sha!, "HEAD")).toBe("");
    expect(existsSync(join(kb, "race-0.md"))).toBe(true);
    expect(remoteRev("main")).toBe(sh(kb, "rev-parse", "HEAD"));
  });

  it("records: second non-fast-forward -> kb_push_rejected, local commits kept", () => {
    setup({ launcher: "wt", pushBranch: null });
    const counter = racingHook("main", true);
    put(kb, "tasks/mine.md", "mine\n");
    expect(() => commitKb("mine", { push: true })).toThrow(/^kb_push_rejected/);
    expect(read(counter, "count").trim()).toBe("2");
    expect(sh(kb, "log", "--format=%s", "--no-merges", "-3")).toContain("kb: mine");
    expect(read(kb, "tasks/mine.md")).toBe("mine\n");
    expect(remoteRev("main")).not.toBe(sh(kb, "rev-parse", "HEAD"));
  });

  it("records: active.md-only conflict resolved main wins", () => {
    setup({ launcher: "wt", pushBranch: null });
    const hb = nowIso();
    put(other, "active.md", activeDoc("winbox", hb));
    commitAll(other, "claim");
    sh(other, "push", "-q", "origin", "main");
    claimActive({ machine: "server1" });
    const r = commitKb("claim", { push: true });
    expect(r.merged).toBe(true);
    expect(read(kb, "active.md")).toBe(activeDoc("winbox", hb));
    expect(r.warning).toMatch(/active_elsewhere/);
    expect(parents(kb)).toBe(2);
    expect(remoteRev("main")).toBe(sh(kb, "rev-parse", "HEAD"));
  });

  it("records: other conflict -> kb_conflict with paths, merged aborted, worktree clean", () => {
    setup({ launcher: "wt", pushBranch: null });
    makeConflict();
    put(kb, "active.md", activeDoc("server1", nowIso()));
    let err: unknown;
    try {
      commitKb("again", { push: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KbConflictError);
    expect((err as Error).message).toMatch(/^kb_conflict/);
    expect((err as KbConflictError).paths).toEqual(["tasks/seed.md"]);
    expect((err as KbConflictError).details).toEqual(["tasks/seed.md"]);
    expect(sh(kb, "status", "--porcelain")).toBe("");
    expect(() => sh(kb, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(read(kb, "tasks/seed.md")).toBe("local side\n");
    expect(sh(kb, "log", "-1", "--format=%s")).toBe("kb: again");
  });
});

describe("records: kb pull and sync", () => {
  it("records: kb pull commits pending changes then merges origin/main", () => {
    setup({ launcher: "wt", pushBranch: null });
    put(kb, "tasks/pending.md", "p\n");
    otherPush("tasks/theirs.md", "t\n");
    const r = pullKb();
    expect(r).toMatchObject({ committed: true, merged: true, fastForward: false, activeMachine: null, warnings: [] });
    expect(sh(kb, "log", "-2", "--format=%s", "--no-merges")).toContain("kb: pull öncesi otomatik");
    expect(existsSync(join(kb, "tasks/theirs.md"))).toBe(true);
    expect(parents(kb)).toBe(2);
    // nothing new: no-op
    expect(pullKb()).toMatchObject({ committed: false, merged: false });
    // fast-forward when nothing is pending and we are behind only
    sh(kb, "push", "-q", "origin", "HEAD:main");
    otherPush("tasks/theirs2.md", "t\n");
    expect(pullKb()).toMatchObject({ committed: false, merged: true, fastForward: true });
  });

  it("records: kb sync runs on non-active server and pushes running worker writes", () => {
    // a fresh record of another machine: write commands would stop with active_elsewhere, sync must not
    put(kb, "active.md", activeDoc("winbox", nowIso()));
    commitAll(kb, "kb: claim");
    sh(kb, "push", "-q", "origin", "HEAD:main");
    put(kb, "tasks/T20261025-90.md", "worker log\n");
    const r = syncKb();
    expect(r).toMatchObject({ committed: true, heartbeat: false, pushed: true });
    expect(remoteRev("refs/heads/kb-server")).toBe(sh(kb, "rev-parse", "HEAD"));
    expect(sh(remote, "show", "kb-server:tasks/T20261025-90.md")).toBe("worker log");
    expect(remoteRev("main")).not.toBe(remoteRev("refs/heads/kb-server"));
  });

  it("records: kb sync heartbeats only when this machine is active", () => {
    const old = nowIso(new Date(Date.now() - 31 * 60_000));
    put(kb, "active.md", activeDoc("server1", old));
    const mine = syncKb();
    expect(mine.heartbeat).toBe(true);
    expect(Date.parse(activeStatus().record!.heartbeat)).toBeGreaterThan(Date.parse(old));
    expect(sh(remote, "show", "kb-server:active.md")).toContain(activeStatus().record!.heartbeat);

    const theirs = activeDoc("winbox", old);
    put(kb, "active.md", theirs);
    const r = syncKb();
    expect(r.heartbeat).toBe(false);
    expect(read(kb, "active.md")).toBe(theirs);
  });

  it("records: kb sync conflict opens one kb_conflict card per key, not reopened after resolve or dismiss", () => {
    makeConflict();
    const cards = () => listCardsWithWarnings({ kind: ["kb_conflict"] }).cards;
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    expect(cards()).toHaveLength(1);
    const c1 = cards()[0].data;
    expect(c1).toMatchObject({ state: "open", project: "vlad" });
    expect(c1.kb_conflict).toMatchObject({ reason: "merge_conflict", source: "kbsync", paths: ["tasks/seed.md"] });
    expect(c1.options.map((o) => o.id)).toEqual(["take_main", "manual"]);
    expect(c1.kb_conflict!.key).toMatch(/^[0-9a-f]{64}$/);
    expect(sh(kb, "status", "--porcelain")).toBe("?? cards/"); // merge aborted; only the new card is untracked

    expect(() => syncKb()).toThrow(/^kb_conflict/); // same conflict, card still open
    expect(cards()).toHaveLength(1);
    resolveCard(c1.id, "resolved");
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    expect(cards()).toHaveLength(1); // not reopened after resolve

    // a different conflict set is a new key
    makeConflict("tasks/b.md");
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    expect(cards()).toHaveLength(2);
    const c2 = cards()[1].data;
    resolveCard(c2.id, "dismissed");
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    expect(cards()).toHaveLength(2); // not reopened after dismiss
  });

  it("records: kb sync clean cycle resolves its open kb_conflict cards", () => {
    makeConflict();
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    const id = listCardsWithWarnings({ kind: ["kb_conflict"] }).cards[0].data.id;
    expect(getCard(id).data.state).toBe("open");
    resolveKb({ take: "main" });
    const r = syncKb();
    expect(r.pushed).toBe(true);
    expect(getCard(id).data.state).toBe("resolved");
  });

  it("records: kb sync applies an answered take_main card", () => {
    makeConflict();
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    const id = listCardsWithWarnings({ kind: ["kb_conflict"] }).cards[0].data.id;
    answerCard(id, { option: "take_main", by_device: "phone" });
    const r = syncKb();
    expect(r.applied).toEqual([`take_main:${id}`]);
    expect(read(kb, "tasks/seed.md")).toBe("main side\n");
    expect(getCard(id).data.state).toBe("resolved");
  });

  it("records: kb sync status file carries handled request seq", () => {
    const statusFile = join(kb, "logs", "kbsync.status.json");
    mkdirSync(join(kb, "logs"), { recursive: true });
    writeFileSync(join(kb, "logs", "kbsync.request"), JSON.stringify({ seq: 7, at: nowIso(), reason: "takeover" }));
    put(kb, "tasks/T1.md", "x");
    syncKb();
    const s = JSON.parse(readFileSync(statusFile, "utf8"));
    expect(s).toMatchObject({ v: 1, seq: 7, ok: true, phase: "done", head: sh(kb, "rev-parse", "HEAD") });
    expect(Number.isNaN(Date.parse(s.at))).toBe(false);

    writeFileSync(join(kb, "logs", "kbsync.request"), JSON.stringify({ seq: 8, at: nowIso(), reason: "takeover" }));
    makeConflict();
    expect(() => syncKb()).toThrow(/^kb_conflict/);
    expect(JSON.parse(readFileSync(statusFile, "utf8"))).toMatchObject({ seq: 8, ok: false, phase: "merge", error: "kb_conflict" });
  });

  it("records: kb sync refuses without kbPushBranch", () => {
    setup({ pushBranch: null });
    expect(() => syncKb()).toThrow(/^kb_push_branch_required/);
  });
});

describe("records: kb_conflict card", () => {
  const vlad = (args: string[]) => {
    const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home, VLAD_KB_DIR: kb } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const key = "a".repeat(64);
  const sha = "b".repeat(40);
  const base = ["card", "new", "--kind", "kb_conflict", "--project", "vlad", "--title", "t", "--json"];
  const flags = ["--conflict-key", key, "--conflict-reason", "merge_conflict", "--conflict-source", "kbsync", "--conflict-head", sha, "--conflict-base", sha];

  it("records: card new kb_conflict rejects --option and requires conflict fields", () => {
    expect(vlad([...base, ...flags, "--option", "x=Y"])).toMatchObject({ code: 1 });
    expect(vlad([...base, ...flags, "--option", "x=Y"]).err).toMatch(/kb_conflict seçenekleri sabittir/);
    const missing = vlad(base);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/--conflict-key/);
    // flags on another kind
    const wrong = vlad(["card", "new", "--kind", "vlad_question", "--project", "vlad", "--title", "t", "--conflict-key", key]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/yalnız --kind kb_conflict/);
    // bad values go through the schema
    expect(vlad([...base, ...flags.map((f) => (f === key ? "xyz" : f))]).code).toBe(1);

    const first = vlad([...base, ...flags, "--conflict-path", "tasks/a.md", "--conflict-path", "tasks/b.md"]);
    expect(first.code).toBe(0);
    const { id, created } = JSON.parse(first.out);
    expect(created).toBe(true);
    expect(getCard(id).data.kb_conflict).toMatchObject({ key, paths: ["tasks/a.md", "tasks/b.md"] });
    expect(getCard(id).data.options.map((o) => o.id)).toEqual(["take_main", "manual"]);
    // same key, any state: same id, nothing new
    resolveCard(id, "dismissed");
    expect(JSON.parse(vlad([...base, ...flags]).out)).toEqual({ id, created: false });
    expect(listCardsWithWarnings({ kind: ["kb_conflict"] }).cards).toHaveLength(1);
  });

  it("records: kb_conflict card of another kind keeps no kb_conflict field", () => {
    expect(() => addCard({ kind: "vlad_question", project: "vlad", title: "q", kbConflict: { key, reason: "rejected", source: "promote", head: sha, base: sha, paths: [] } })).toThrow(/yalnız kb_conflict/);
    expect(() => addCard({ kind: "kb_conflict", project: "vlad", title: "q" })).toThrow(/gerekli/);
  });
});

describe("records: kb resolve and discard", () => {
  it("records: kb resolve --take main backs up local side under logs/kb-conflicts", () => {
    makeConflict();
    expect(() => pullKb()).toThrow(/^kb_conflict/);
    const r = resolveKb({ take: "main" });
    expect(r).toMatchObject({ merged: true, resolved: ["tasks/seed.md"] });
    expect(read(kb, "tasks/seed.md")).toBe("main side\n");
    expect(r.backupDir).toMatch(/logs[\\/]kb-conflicts[\\/][0-9a-f]{8}$/);
    expect(read(r.backupDir!, "tasks/seed.md")).toBe("local side\n");
    expect(parents(kb)).toBe(2);
    expect(sh(kb, "status", "--porcelain")).toBe("");
  });

  it("records: kb resolve --take local keeps ours and backs up main, --path limits the selection", () => {
    makeConflict();
    put(kb, "tasks/two.md", "local two\n");
    commitAll(kb, "kb: two");
    otherPush("tasks/two.md", "main two\n");
    // only one of two conflicts selected: the other still conflicts
    let err: unknown;
    try {
      resolveKb({ take: "local", paths: ["tasks/seed.md"] });
    } catch (e) {
      err = e;
    }
    expect((err as KbConflictError).paths).toEqual(["tasks/seed.md", "tasks/two.md"]);
    expect(sh(kb, "status", "--porcelain")).toBe("");
    const r = resolveKb({ take: "local" });
    expect(r.resolved).toEqual(["tasks/seed.md", "tasks/two.md"]);
    expect(read(kb, "tasks/seed.md")).toBe("local side\n");
    expect(read(r.backupDir!, "tasks/seed.md")).toBe("main side\n");
    expect(() => resolveKb({ take: "main", paths: ["../x"] })).toThrow(/geçersiz --path/);
  });

  it("records: discard answer rebuilds kb-server on origin/main with force-with-lease", () => {
    put(kb, "tasks/good.md", "good\n");
    put(kb, "tasks/bad.md", "bad\n");
    syncKb();
    otherPush("tasks/main-new.md", "m\n");
    const card = addCard({
      kind: "kb_conflict", project: "vlad", title: "rejected",
      kbConflict: { key: "c".repeat(64), reason: "rejected", source: "promote", head: sh(kb, "rev-parse", "HEAD"), base: remoteRev("main"), paths: ["tasks/bad.md", "../escape.md"], rules: ["path_not_allowed"] },
    });
    expect(card.data.options.map((o) => o.id)).toEqual(["discard", "manual"]);
    answerCard(card.data.id, { option: "discard", by_device: "phone" });

    const r = syncKb();
    expect(r.applied).toEqual([`discard:${card.data.id}`]);
    const main = remoteRev("main");
    expect(sh(kb, "rev-parse", "HEAD^")).toBe(main);
    expect(parents(kb)).toBe(1);
    expect(existsSync(join(kb, "tasks/bad.md"))).toBe(false);
    expect(read(kb, "tasks/good.md")).toBe("good\n");
    expect(existsSync(join(kb, "tasks/main-new.md"))).toBe(true);
    expect(read(join(kb, "logs", "kb-conflicts", "cccccccc"), "tasks/bad.md")).toBe("bad\n");
    expect(remoteRev("refs/heads/kb-server")).toBe(sh(kb, "rev-parse", "HEAD"));
    // the promote card stays open (promote closes it); a later cycle must not rebuild again
    expect(getCard(card.data.id).data.state).toBe("open");
    const head = sh(kb, "rev-parse", "HEAD");
    expect(syncKb().applied).toBeUndefined();
    expect(sh(kb, "rev-parse", "HEAD")).toBe(head);
  });

  it("records: discard push is a lease: a concurrent kb-server push makes it fail", () => {
    put(kb, "tasks/bad.md", "bad\n");
    syncKb();
    otherPush("tasks/main-new.md", "m\n");
    const card = addCard({
      kind: "kb_conflict", project: "vlad", title: "rejected",
      kbConflict: { key: "d".repeat(64), reason: "rejected", source: "promote", head: sh(kb, "rev-parse", "HEAD"), base: remoteRev("main"), paths: ["tasks/bad.md"] },
    });
    answerCard(card.data.id, { option: "discard", by_device: "phone" });
    racingHook("kb-server", false);
    const raced = remoteRev("refs/heads/kb-server");
    expect(() => syncKb()).toThrow(/^kb_push_rejected/);
    expect(remoteRev("refs/heads/kb-server")).not.toBe(raced);
    expect(sh(remote, "show", "kb-server:tasks/bad.md")).toBe("bad"); // the foreign push was not overwritten
  });
});

describe("records: kb helpers", () => {
  it.skipIf(process.platform === "win32")("records: git-running kb commands refuse foreign .git owner (git_owner_mismatch)", () => {
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    put(kb, "tasks/T1.md", "x");
    expect(() => commitKb("x")).toThrow(/^git_owner_mismatch/);
    expect(() => pullKb()).toThrow(/^git_owner_mismatch/);
    expect(() => syncKb()).toThrow(/^git_owner_mismatch/);
    expect(() => resolveKb({ take: "main" })).toThrow(/^git_owner_mismatch/);
    expect(sh(kb, "status", "--porcelain")).toContain("tasks/T1.md"); // nothing was committed
  });

  it("records: kbMainBranch from origin/HEAD, fallback main", () => {
    expect(kbMainBranch(kb)).toBe("main");
    otherPush("tasks/x.md", "x");
    sh(other, "push", "-q", "origin", "HEAD:refs/heads/trunk");
    sh(kb, "fetch", "-q", "origin");
    sh(kb, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(kbMainBranch(kb)).toBe("trunk");
    sh(kb, "remote", "set-head", "origin", "-d");
    expect(kbMainBranch(kb)).toBe("main");
  });

  it("records: future heartbeat beyond 5 min adds clock_skew warning", () => {
    const NOW = 1_800_000_000_000;
    claimActive({ machine: "winbox", now: NOW + ACTIVE_SKEW_WARN_MS });
    expect(existsSync(activeFile())).toBe(true);
    expect(activeStatus({ now: NOW, machine: "server1" }).warnings).toEqual([]); // exactly 5 min: no warning
    claimActive({ machine: "winbox", now: NOW + ACTIVE_SKEW_WARN_MS + 1000 });
    const st = activeStatus({ now: NOW, machine: "server1" });
    expect(st.warnings.join(" ")).toMatch(/^clock_skew/);
    expect(st.stale).toBe(false); // still fresh: the safe side
  });
});
