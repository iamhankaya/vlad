// promoteKb (kb topology note K4-K6, K9, K10): lands the server's `kb-server` branch on `vlad-kb` main as a `--no-ff` merge, but only after
// two checks, both in `vladapi`'s own bare clone on objects it fetched itself:
//   R1 net diff   `merge-tree(main, kb-server)` against main: exactly what a main checkout (Windows) would receive.
//   R2 history    every commit in main..kb-server (a merge commit only for content that did not come from the main side).
// Nothing here runs git in the agent-writable kb clone, and the single write is `GithubWriter.pushKbMain`.
import type { GithubWriter } from "../github/writer.ts";
import type { GitExec } from "./gitexec.ts";
import { GATE_IDENTITY } from "./gitexec.ts";
import { acquireLock, StateStore } from "./state.ts";
import {
  checkChanges, checkSensitiveFields, conflictKey, parseRawZ, PROMOTE_LIMITS,
  type RawChange, type RuleId, type Violation,
} from "./rules.ts";

export type PromoteReason = "up_to_date" | "no_server_branch" | "merge_conflict" | "rejected" | "main_moved" | "github_unavailable" | "busy" | "not_configured" | "git_error";
export interface PromoteResult { promoted: boolean; reason?: PromoteReason; main?: string; head?: string; merge?: string; card?: string; violations?: Violation[] }
export interface KbSyncConfig { repo: string; main: string; serverBranch: string; serverMachine: string; stateDir: string; remoteUrl?: string /* only tests */ }
export interface KbConflictInput { key: string; reason: "rejected"; source: "promote"; head: string; base: string; paths: string[]; rules: RuleId[]; title: string }
export interface PromoteDeps {
  config: KbSyncConfig;
  git: GitExec;
  tokens: { token(repo: string, perms: { contents: "write" }): Promise<string> };
  writer: Pick<GithubWriter, "pushKbMain">;
  cards: { open(i: KbConflictInput): Promise<{ id: string; created: boolean }>; resolveOpen(source: "promote"): Promise<number> };
  now(): number;
  sleep?: (ms: number) => Promise<void>;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

const iso = (ms: number) => new Date(ms).toISOString();
const remoteUrl = (c: KbSyncConfig) => c.remoteUrl ?? `https://github.com/${c.repo}.git`;
const trackingRef = (c: KbSyncConfig, branch: string) => `refs/remotes/origin/${branch}`;

/** Result of `fetch`: the two tips, both read from the bare clone after the fetch. */
async function resolveRef(git: GitExec, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

/** Machine named in `active.md` of the main this clone last fetched; null when there is no record. */
export async function mainActiveMachine(d: Pick<PromoteDeps, "git" | "config">): Promise<string | null> {
  const r = await d.git(["cat-file", "blob", `${trackingRef(d.config, d.config.main)}:active.md`]);
  if (r.code !== 0) return null;
  return /^machine:\s*(\S+)\s*$/m.exec(r.stdout)?.[1] ?? null;
}

export async function promoteKb(d: PromoteDeps, o: { trigger?: "timer" | "takeover"; waitLockMs?: number } = {}): Promise<PromoteResult> {
  const c = d.config;
  if (!REPO.test(c.repo) || !BRANCH.test(c.main) || !BRANCH.test(c.serverBranch) || c.main === c.serverBranch || !c.stateDir) return { promoted: false, reason: "not_configured" };
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const release = await acquireLock(c.stateDir, { waitMs: o.waitLockMs ?? 0, now: d.now, sleep });
  if (!release) return { promoted: false, reason: "busy" };
  try {
    return await run(d);
  } finally {
    release();
  }
}

async function run(d: PromoteDeps): Promise<PromoteResult> {
  const c = d.config;
  const { git } = d;
  const store = new StateStore(c.stateDir);
  const url = remoteUrl(c);

  let token: string;
  try {
    token = await d.tokens.token(c.repo, { contents: "write" });
  } catch {
    return { promoted: false, reason: "github_unavailable" };
  }

  const ls = await git(["ls-remote", url, `refs/heads/${c.main}`, `refs/heads/${c.serverBranch}`], { token });
  if (ls.code !== 0) return { promoted: false, reason: "github_unavailable" };
  const refs = new Set(ls.stdout.split("\n").map((l) => l.split("\t")[1]).filter(Boolean));
  const remoteHas = (branch: string) => refs.has(`refs/heads/${branch}`);
  if (!remoteHas(c.main)) return { promoted: false, reason: "github_unavailable" };
  if (!remoteHas(c.serverBranch)) return { promoted: false, reason: "no_server_branch" };

  const fetch = await git(
    ["fetch", "-q", "--no-tags", url, `+refs/heads/${c.main}:${trackingRef(c, c.main)}`, `+refs/heads/${c.serverBranch}:${trackingRef(c, c.serverBranch)}`],
    { token },
  );
  if (fetch.code !== 0) return { promoted: false, reason: "github_unavailable" };

  const main = await resolveRef(git, trackingRef(c, c.main));
  const head = await resolveRef(git, trackingRef(c, c.serverBranch));
  if (!main || !head) return { promoted: false, reason: "git_error" };

  const base = { main, head };
  const upToDate = (await git(["merge-base", "--is-ancestor", head, main])).code === 0;
  if (upToDate) {
    await d.cards.resolveOpen("promote").catch(() => 0);
    store.update((s) => { s.blocked = null; s.lastOk = iso(d.now()); });
    return { promoted: false, reason: "up_to_date", ...base };
  }

  // ---- R2: history of main..kb-server
  const entries = new Map<string, RawChange>(); // first entry seen per path, for the conflict key lines
  const groups: { changes: RawChange[]; extra: Violation[] }[] = [];
  const violations: Violation[] = [];
  const count = await git(["rev-list", "--count", `${main}..${head}`]);
  const n = Number(count.stdout.trim());
  if (count.code !== 0 || !Number.isSafeInteger(n)) return { promoted: false, reason: "git_error", ...base };
  if (n > PROMOTE_LIMITS.commits) violations.push({ rule: "too_large", path: "(commits)", detail: `${n} > ${PROMOTE_LIMITS.commits}` });
  else {
    // oldest first: the conflict key reads each path's entry from the commit that introduced it, so a later cleanup commit does not change it
    const list = await git(["rev-list", "--reverse", "--parents", `${main}..${head}`]);
    if (list.code !== 0) return { promoted: false, reason: "git_error", ...base };
    const diff = async (...args: string[]): Promise<RawChange[] | null> => {
      const r = await git(["diff-tree", "-r", "-z", "--raw", "--no-renames", ...args]);
      return r.code === 0 ? parseRawZ(r.stdout) : null;
    };
    for (const line of list.stdout.split("\n").filter(Boolean)) {
      const [commit, ...parents] = line.split(" ") as [string, ...string[]];
      if (parents.length > 2) { violations.push({ rule: "too_many_parents", path: `commit:${commit}` }); continue; }
      let ch: RawChange[] | null;
      if (parents.length === 0) ch = await diff("--root", "--no-commit-id", commit);
      else if (parents.length === 1) ch = await diff(parents[0]!, commit);
      else {
        // merge commit: only what differs from BOTH parents is the merge's own content; the main side was (or will be) checked as main's own history
        const [p1, p2] = parents as [string, string];
        const [a, b] = [await diff(p1, commit), await diff(p2, commit)];
        const differs = new Set(b?.map((x) => x.path));
        ch = a && b ? a.filter((e) => differs.has(e.path)) : null;
      }
      if (!ch) return { promoted: false, reason: "git_error", ...base };
      groups.push({ changes: ch, extra: [] });
    }
  }

  // ---- R1: net diff of the merge result against main
  let tree: string | null = null;
  let conflicted = false;
  let r1: RawChange[] = [];
  const mt = await git(["merge-tree", "--write-tree", "--no-messages", main, head]);
  if (mt.code === 0 && /^[0-9a-f]{40}/.test(mt.stdout)) tree = mt.stdout.slice(0, 40);
  else if (mt.code === 1) conflicted = true;
  else return { promoted: false, reason: "git_error", ...base };
  let candidatePaths: string[] = [];
  if (tree) {
    const r = await git(["diff-tree", "-r", "-z", "--raw", "--no-renames", main, tree]);
    if (r.code !== 0) return { promoted: false, reason: "git_error", ...base };
    r1 = parseRawZ(r.stdout);
    const lt = await git(["ls-tree", "-r", "--name-only", "-z", tree]);
    if (lt.code !== 0) return { promoted: false, reason: "git_error", ...base };
    candidatePaths = lt.stdout.split("\0").filter(Boolean);
    groups.push({ changes: r1, extra: [] });
  }

  // blob sizes in one call (a gitlink has no object here)
  const oids = new Set<string>();
  for (const g of groups) for (const e of g.changes) if (e.status !== "D" && ["100644", "100755", "120000"].includes(e.newMode)) oids.add(e.newOid);
  const sizes = new Map<string, number>();
  if (oids.size) {
    const r = await git(["cat-file", "--batch-check"], { input: [...oids].join("\n") + "\n" });
    if (r.code !== 0) return { promoted: false, reason: "git_error", ...base };
    for (const l of r.stdout.split("\n")) {
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(l);
      if (m) sizes.set(m[1]!, Number(m[2]));
    }
  }
  const sizeOf = (oid: string) => sizes.get(oid) ?? Number.MAX_SAFE_INTEGER; // unknown object: refuse
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  if (total > PROMOTE_LIMITS.totalBytes) violations.push({ rule: "too_large", path: "(bytes)", detail: `${total} > ${PROMOTE_LIMITS.totalBytes}` });
  for (const g of groups) {
    for (const e of g.changes) if (!entries.has(e.path)) entries.set(e.path, e);
    violations.push(...checkChanges(g.changes, { sizeOf, candidatePaths: g.changes === r1 ? candidatePaths : g.changes.map((e) => e.path) }));
  }
  // sensitive project-card fields: judged on the net diff only (what main would end up with), blobs already known to be small
  for (const e of r1) {
    if (!/^projects\/[^/]+\.md$/.test(e.path) || e.status === "D" || e.newMode !== "100644" || violations.some((v) => v.path === e.path)) continue;
    const blob = async (oid: string) => (await git(["cat-file", "blob", oid])).stdout;
    violations.push(...checkSensitiveFields(e.path, e.status === "A" ? null : await blob(e.oldOid), await blob(e.newOid), c.serverMachine));
  }

  const uniq = new Map<string, Violation>();
  for (const v of violations) uniq.set(`${v.rule}\0${v.path}`, v);
  const found = [...uniq.values()];

  if (found.length) return rejected(d, store, found, entries, base);
  if (conflicted) {
    store.update((s) => { s.blocked = null; });
    return { promoted: false, reason: "merge_conflict", ...base };
  }

  // ---- land it: parents [main, kb-server], the validated tree
  const msg = `kb: promote ${c.serverBranch} -> ${c.main}`;
  const ct = await git(["commit-tree", tree!, "-p", main, "-p", head, "-m", msg], { env: { ...GATE_IDENTITY } });
  const commit = ct.stdout.trim();
  if (ct.code !== 0 || !SHA.test(commit)) return { promoted: false, reason: "git_error", ...base };
  const [t2, pp] = [await git(["rev-parse", `${commit}^{tree}`]), await git(["rev-list", "--parents", "-n1", commit])];
  if (t2.stdout.trim() !== tree || pp.stdout.trim() !== `${commit} ${main} ${head}`) return { promoted: false, reason: "git_error", ...base };

  let out: { kind: "pushed" } | { kind: "main_moved" };
  try {
    out = await d.writer.pushKbMain(commit, main);
  } catch {
    return { promoted: false, reason: "github_unavailable", ...base };
  }
  if (out.kind === "main_moved") return { promoted: false, reason: "main_moved", ...base };
  await git(["update-ref", trackingRef(c, c.main), commit, main]);
  await d.cards.resolveOpen("promote").catch(() => 0);
  store.update((s) => { s.blocked = null; s.lastOk = iso(d.now()); });
  return { promoted: true, main: commit, head, merge: commit };
}

async function rejected(
  d: PromoteDeps, store: StateStore, found: Violation[], entries: Map<string, RawChange>, base: { main: string; head: string },
): Promise<PromoteResult> {
  const lines = found.map((v) => {
    const e = entries.get(v.path);
    return e ? `${v.rule}\t${e.status}\t${e.newMode}\t${e.newOid}\t${v.path}` : `${v.rule}\t-\t-\t-\t${v.path}`;
  });
  const key = conflictKey("rejected", lines);
  let card = store.read().seen[key];
  if (!card) {
    try {
      const clean = (p: string) => p.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
      const opened = await d.cards.open({
        key, reason: "rejected", source: "promote", head: base.head, base: base.main,
        paths: [...new Set(found.map((v) => clean(v.path)))].slice(0, 50), rules: [...new Set(found.map((v) => v.rule))],
        title: `kb promote reddedildi: ${found.length} ihlal`,
      });
      card = opened.id;
      store.update((s) => { s.seen[key] = opened.id; });
    } catch { /* card could not be written (e.g. this machine is not the active VLAD): the next cycle retries; the block is visible regardless */ }
  }
  store.update((s) => { s.blocked = { key, ...(card ? { card } : {}), at: iso(d.now()) }; });
  return { promoted: false, reason: "rejected", ...base, ...(card ? { card } : {}), violations: found };
}
