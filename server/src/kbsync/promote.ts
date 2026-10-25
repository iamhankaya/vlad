// promoteKb (kb topology note K4-K6, K9, K10): lands the server's `kb-server` branch on `vlad-kb` main as a `--no-ff` merge, but only after
// two checks, both in `vladapi`'s own bare clone on objects it fetched itself:
//   R1 net diff   `merge-tree(main, kb-server)` against main: exactly what a main checkout (Windows) would receive.
//   R2 history    every commit in main..kb-server (a merge commit only for content that did not come from the main side).
// Nothing here runs git in the agent-writable kb clone, and the single write is `GithubWriter.pushKbMain`.
import type { GithubWriter } from "../github/writer.ts";
import type { GitExec } from "./gitexec.ts";
import { discardFetched, GATE_IDENTITY, REPO_TOO_LARGE } from "./gitexec.ts";
import { schemaProblems } from "./schemas.ts";
import { acquireLock, StateStore } from "./state.ts";
import {
  checkActiveChange, checkChanges, checkSensitiveFields, conflictKey, normalizeRepo, parseRawZ, PROMOTE_LIMITS, strictFrontmatter,
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
  /**
   * Cheap look at the server branch before anything is fetched (GitHub's compare API): commits ahead and whether the file list was cut off.
   * Null = could not tell (the fetch limits still apply). Finding 5.
   */
  preflight?: () => Promise<{ commits: number; truncated: boolean } | null>;
}

/** A takeover started this recently (and has not failed) is what lets a new `active.md` through. */
const TAKEOVER_WINDOW_MS = 30 * 60_000;
/** At most this many kb_conflict cards from promote per hour (finding 9). */
export const MAX_CARDS_PER_HOUR = 5;
const takeoverIsPending = (t: { state: string; at: string } | undefined, now: number): boolean => t?.state === "pending" && now - Date.parse(t.at) < TAKEOVER_WINDOW_MS;

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
  const tip = new Map<string, string>();
  for (const l of ls.stdout.split("\n")) {
    const [sha, ref] = l.split("\t");
    if (sha && ref && SHA.test(sha)) tip.set(ref, sha);
  }
  const remoteMain = tip.get(`refs/heads/${c.main}`);
  const remoteHead = tip.get(`refs/heads/${c.serverBranch}`);
  if (!remoteMain) return { promoted: false, reason: "github_unavailable" };
  if (!remoteHead) return { promoted: false, reason: "no_server_branch" };

  // the same refused branch head is not downloaded again every cycle (it would be the same objects, the same answer)
  // (valid only while main and the takeover state are what the verdict was reached with: both feed the content rules)
  const cur = store.read();
  const pendingNow = takeoverIsPending(cur.takeover, d.now());
  const was = cur.blocked;
  if (was?.head === remoteHead && was.main === remoteMain && was.pending === pendingNow && was.violations?.length) {
    return rejected(d, store, was.violations, new Map(), { main: remoteMain, head: remoteHead }, was.key);
  }

  const pre = await d.preflight?.().catch(() => null);
  if (pre && (pre.commits > PROMOTE_LIMITS.commits || pre.truncated)) {
    const v: Violation = { rule: "too_large", path: pre.commits > PROMOTE_LIMITS.commits ? "(commits)" : "(changes)", detail: "compare" };
    return rejected(d, store, [v], new Map(), { main: remoteMain, head: remoteHead });
  }

  const fetch = await git(
    ["fetch", "-q", "--no-tags", url, `+refs/heads/${c.main}:${trackingRef(c, c.main)}`, `+refs/heads/${c.serverBranch}:${trackingRef(c, c.serverBranch)}`],
    { token },
  );
  if (fetch.code !== 0) {
    if ((fetch.stderr ?? "").includes(REPO_TOO_LARGE)) {
      await discardFetched(git, c.stateDir, trackingRef(c, c.serverBranch));
      return rejected(d, store, [{ rule: "too_large", path: "(fetch)", detail: "clone cap" }], new Map(), { main: remoteMain, head: remoteHead });
    }
    return { promoted: false, reason: "github_unavailable" };
  }

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
  // content rules, judged on the net diff only (what main would end up with); blobs are already known to be small
  const blob = async (oid: string) => (await git(["cat-file", "blob", oid])).stdout;
  let taken: Set<string> | undefined;
  const takenRepos = async (): Promise<Set<string>> => {
    if (taken) return taken;
    taken = new Set([normalizeRepo(c.repo)]);
    const names = (await git(["ls-tree", "-r", "--name-only", "-z", main, "--", "projects/"])).stdout.split("\0").filter((n) => /^projects\/[^/]+\.md$/.test(n)).slice(0, 1000);
    for (const n of names) {
      const repo = strictFrontmatter((await git(["cat-file", "blob", `${main}:${n}`])).stdout)?.repo;
      if (repo !== undefined) taken.add(normalizeRepo(repo));
    }
    return taken;
  };
  const takeoverPending = takeoverIsPending(store.read().takeover, d.now());
  for (const e of r1) {
    if (e.status === "D" || e.newMode !== "100644" || violations.some((v) => v.path === e.path)) continue;
    if (e.path === "active.md") {
      violations.push(...checkActiveChange(e.path, e.status === "A" ? null : await blob(e.oldOid), await blob(e.newOid), { serverMachine: c.serverMachine, takeoverPending, validate: (x) => schemaProblems("active", x) }));
    } else if (/^projects\/[^/]+\.md$/.test(e.path)) {
      const isNew = e.status === "A";
      violations.push(...checkSensitiveFields(e.path, isNew ? null : await blob(e.oldOid), await blob(e.newOid), c.serverMachine, {
        validate: (x) => schemaProblems("project", x), ...(isNew ? { takenRepos: await takenRepos() } : {}),
      }));
    }
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

const clean = (p: string) => p.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?").slice(0, 200);

async function rejected(
  d: PromoteDeps, store: StateStore, found: Violation[], entries: Map<string, RawChange>, base: { main: string; head: string }, cachedKey?: string,
): Promise<PromoteResult> {
  const lines = found.map((v) => {
    const e = entries.get(v.path);
    return e ? `${v.rule}\t${e.status}\t${e.newMode}\t${e.newOid}\t${v.path}` : `${v.rule}\t-\t-\t-\t${v.path}`;
  });
  const key = cachedKey ?? conflictKey("rejected", lines);
  let card: string | undefined = store.read().seen[key];
  const hourAgo = d.now() - 3_600_000;
  const recent = (store.read().cardLog ?? []).filter((t) => t > hourAgo);
  if (!card && recent.length >= MAX_CARDS_PER_HOUR) {
    // over the cap: no new card; the card that is already open stays the one the phone shows (kb_sync.state is `blocked` regardless)
    card = store.read().blocked?.card;
  } else if (!card) {
    try {
      // one open promote card at a time: a new refusal replaces the old one
      await d.cards.resolveOpen("promote").catch(() => 0);
      const opened = await d.cards.open({
        key, reason: "rejected", source: "promote", head: base.head, base: base.main,
        paths: [...new Set(found.map((v) => clean(v.path)))].slice(0, 50), rules: [...new Set(found.map((v) => v.rule))],
        title: `kb promote reddedildi: ${found.length} ihlal`,
      });
      card = opened.id;
      store.update((s) => { s.seen[key] = opened.id; s.cardLog = [...recent, d.now()]; });
    } catch { /* card could not be written (e.g. this machine is not the active VLAD): the next cycle retries; the block is visible regardless */ }
  }
  store.update((s) => {
    s.blocked = { key, ...(card ? { card } : {}), at: iso(d.now()), head: base.head, main: base.main, pending: takeoverIsPending(s.takeover, d.now()), violations: found.slice(0, 50).map((v) => ({ rule: v.rule, path: v.path.slice(0, 200), ...(v.detail ? { detail: v.detail.slice(0, 200) } : {}) })) };
  });
  // the objects of a refused branch are not kept
  if (!cachedKey) await discardFetched(d.git, d.config.stateDir, `refs/remotes/origin/${d.config.serverBranch}`);
  return { promoted: false, reason: "rejected", ...base, ...(card ? { card } : {}), violations: found };
}
