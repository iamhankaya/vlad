import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeStatus, heartbeatActive } from "../active/index.js";
import { addCard, listCardsWithWarnings, resolveCard } from "../cards/store.js";
import type { Card } from "../cards/store.js";
import { loadConfig } from "./config.js";
import { git, gitTry } from "./git.js";
import { isSeparateKb, kbPaths } from "./home.js";
import { nowIso } from "./time.js";

/** Card project of kbsync's own `kb_conflict` cards (the server's kb always carries this card). */
export const KB_CONFLICT_PROJECT = "vlad";

const PUSH_BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
/** What git prints when the remote moved under a push. */
const NON_FF = /non-fast-forward|fetch first|\brejected\b|stale info/i;

/** Branch name of the kb remote's main: `origin/HEAD`, else `main` (kb topology note, K3). */
export function kbMainBranch(cwd: string): string {
  const r = gitTry(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = r.code === 0 ? r.out.trim().replace(/^origin\//, "") : "";
  return name || "main";
}

/**
 * POSIX: refuses to run git in a kb whose `.git` belongs to another user (`git_owner_mismatch`). The agent controls
 * that `.git/config`; a process of another identity (the API server) must never run git there (K9). Skipped on Windows.
 */
export function assertGitOwner(cwd: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  let owner: number;
  try {
    owner = statSync(join(cwd, ".git")).uid;
  } catch {
    return; // no .git: git itself reports the missing repo
  }
  if (owner !== process.getuid()) throw new Error(`git_owner_mismatch: ${cwd}/.git başka bir kullanıcıya ait (uid ${owner}); bu komut orada git çalıştırmaz`);
}

/** Error key `kb_conflict`; `details` (the conflicting paths) reach the CLI's JSON error. */
export class KbConflictError extends Error {
  readonly code = "kb_conflict";
  constructor(public paths: string[], public key: string, public head: string, public base: string) {
    super(`kb_conflict: ${paths.length} dosya çakıştı: ${paths.join(", ")}; \`vlad kb resolve --take main|local\` ile çöz`);
    this.name = "KbConflictError";
  }
  get details(): string[] {
    return this.paths;
  }
}

/** Dedupe key of a conflict: the same set of lines always gives the same key (K6). */
export function conflictKey(reason: "merge_conflict" | "rejected", lines: string[]): string {
  return createHash("sha256").update(`vlad-kbconflict/v1\n${reason}\n${[...lines].sort().join("\n")}`).digest("hex");
}

/** A kb-relative path that stays inside the kb: no absolute, `..`, dot or backslash segments. Card paths are untrusted. */
function safeRel(p: string): boolean {
  return p.length > 0 && p.length <= 200 && !/[\\\0:]/.test(p) && !p.startsWith("/") && p.split("/").every((s) => s !== "" && !s.startsWith("."));
}

export function commitPending(cwd: string, message: string): boolean {
  git(cwd, ["add", "--", "."]);
  if (!git(cwd, ["diff", "--cached", "--name-only"]).trim()) return false;
  git(cwd, ["commit", "-q", "-m", `kb: ${message}`]);
  return true;
}

export function fetchOrigin(cwd: string): void {
  const r = gitTry(cwd, ["fetch", "-q", "origin"]);
  if (r.code !== 0) throw new Error(`kb_fetch_failed: ${r.err.trim()}`);
}

const blobAt = (cwd: string, rev: string, path: string): string => {
  const r = gitTry(cwd, ["rev-parse", "-q", "--verify", `${rev}:${path}`]);
  return r.code === 0 ? r.out.trim() : "";
};

export interface MergeResult {
  merged: boolean;
  fastForward: boolean;
  /** active.md conflicted and the main side was taken */
  activeMainWon: boolean;
  /** `take` paths resolved from the chosen side, local side backed up under `backupDir` */
  resolved: string[];
  backupDir?: string;
}

/**
 * Merges `origin/<main>` into HEAD (merge commit, never a rebase; fast-forward when possible).
 * Conflicts: only active.md → main wins; anything else → `git merge --abort` (worktree clean, local commits kept)
 * and `KbConflictError`. With `take` the named `paths` (default: every conflicting file) are taken from that side
 * instead, and the other side is saved under `logs/kb-conflicts/<key8>/`. Call after `fetchOrigin` and with no dirty files.
 */
export function mergeMain(cwd: string, main: string, o: { take?: "main" | "local"; paths?: string[] } = {}): MergeResult {
  const ref = `origin/${main}`;
  const none: MergeResult = { merged: false, fastForward: false, activeMainWon: false, resolved: [] };
  if (gitTry(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).code !== 0) return none;
  if (gitTry(cwd, ["merge-base", "--is-ancestor", ref, "HEAD"]).code === 0) return none;
  const fastForward = gitTry(cwd, ["merge-base", "--is-ancestor", "HEAD", ref]).code === 0;
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const base = git(cwd, ["rev-parse", ref]).trim();
  const r = gitTry(cwd, ["merge", "--no-edit", "-q", ref]);
  if (r.code === 0) return { ...none, merged: true, fastForward };
  if (gitTry(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code !== 0) throw new Error(`git merge başarısız: ${(r.err || r.out).trim()}`);

  // stage 2 = ours (HEAD), stage 3 = theirs (origin/main); "" = absent on that side
  const stages = new Map<string, { ours: string; theirs: string }>();
  for (const line of git(cwd, ["ls-files", "-u", "-z"]).split("\0").filter(Boolean)) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t(.*)$/s.exec(line);
    if (!m) continue;
    const e = stages.get(m[3]) ?? { ours: "", theirs: "" };
    if (m[2] === "2") e.ours = m[1];
    if (m[2] === "3") e.theirs = m[1];
    stages.set(m[3], e);
  }
  const unmerged = [...stages.keys()].sort();
  const key = conflictKey("merge_conflict", unmerged.map((p) => `${p}\t${stages.get(p)!.ours}\t${stages.get(p)!.theirs}`));
  const chosen = o.take ? unmerged.filter((p) => !o.paths?.length || o.paths.includes(p)) : [];
  const rest = unmerged.filter((p) => !chosen.includes(p));
  const bad = rest.filter((p) => p !== "active.md");
  if (bad.length) {
    git(cwd, ["merge", "--abort"]);
    throw new KbConflictError(unmerged, key, head, base);
  }
  const backupDir = join(cwd, "logs", "kb-conflicts", key.slice(0, 8));
  const take = (p: string, side: "main" | "local", backup: boolean) => {
    const mine = side === "local";
    if (backup) {
      const other = stages.get(p)![mine ? "theirs" : "ours"];
      if (other) {
        const dest = join(backupDir, p);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, git(cwd, ["cat-file", "blob", other]));
      }
    }
    if (stages.get(p)![mine ? "ours" : "theirs"]) {
      git(cwd, ["checkout", mine ? "--ours" : "--theirs", "--", p]);
      git(cwd, ["add", "--", p]);
    } else git(cwd, ["rm", "-q", "-f", "--", p]);
  };
  for (const p of chosen) take(p, o.take!, true);
  const activeMainWon = rest.includes("active.md");
  if (activeMainWon) take("active.md", "main", false);
  git(cwd, ["commit", "-q", "--no-edit"]);
  return { merged: true, fastForward: false, activeMainWon, resolved: chosen, ...(chosen.length ? { backupDir } : {}) };
}

/** The "this machine lost the active role" warning when a main-wins active.md names someone else. */
function activeLostWarning(): string | null {
  const st = activeStatus();
  return st.record && !st.mine ? `active_elsewhere: etkin VLAD artık ${st.record.machine}; bu makine salt okunur` : null;
}

function validatePushBranch(branch: string, main: string): void {
  if (branch === main || !PUSH_BRANCH.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new Error(`kb_push_branch_invalid: "${branch}" (kb main dalı "${main}" olamaz; yalnızca harf, rakam, . _ - /)`);
  }
}

export interface KbPushTarget {
  /** args after `git push -q` */
  args: string[];
  /** branch the commits end up on */
  branch: string;
}

/**
 * Where `kb commit --push` goes for a separate-layout kb (K2). `kbPushBranch` set → `HEAD:refs/heads/<it>`.
 * Unset on a `process`-launcher machine (a server) → refused (`kb_push_branch_required`). Unset elsewhere
 * (Windows, cloud) → the upstream, unchanged.
 */
export function resolvePushTarget(cwd: string, main: string, o: { pushBranch?: string; serverMode: boolean }): KbPushTarget {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (o.pushBranch) {
    validatePushBranch(o.pushBranch, main);
    return { args: ["origin", `HEAD:refs/heads/${o.pushBranch}`], branch: o.pushBranch };
  }
  if (o.serverMode) throw new Error("kb_push_branch_required: bu makinede (process launcher) kb push'u için machines.<makine>.kbPushBranch gerekli");
  const hasUpstream = gitTry(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).code === 0;
  return { args: hasUpstream ? [] : ["-u", "origin", branch], branch };
}

/**
 * Fetch + merge origin/<main>, then push; one non-fast-forward rejection → fetch + merge + push once more,
 * a second one → `kb_push_rejected` (local commits stay). Returns whether any merge happened.
 */
export function pushWithMerge(cwd: string, main: string, args: string[]): { merged: boolean; activeLost?: string } {
  fetchOrigin(cwd);
  let m = mergeMain(cwd, main);
  let merged = m.merged;
  let activeMainWon = m.activeMainWon;
  const push = () => gitTry(cwd, ["push", "-q", ...args]);
  let r = push();
  if (r.code !== 0) {
    if (!NON_FF.test(r.err)) throw new Error(`git push başarısız: ${r.err.trim()}`);
    fetchOrigin(cwd);
    m = mergeMain(cwd, main);
    merged ||= m.merged;
    activeMainWon ||= m.activeMainWon;
    r = push();
    if (r.code !== 0) {
      if (!NON_FF.test(r.err)) throw new Error(`git push başarısız: ${r.err.trim()}`);
      throw new Error(`kb_push_rejected: push iki kez reddedildi; yerel commit'ler korundu, tekrar dene (${r.err.trim()})`);
    }
  }
  return { merged, ...(activeMainWon ? { activeLost: activeLostWarning() ?? undefined } : {}) };
}

function requireSeparate(): { cwd: string; home: string } {
  const p = kbPaths();
  if (!isSeparateKb(p.home)) throw new Error("kb_separate_required: bu komut yalnız ayrı kb deposunda (kbDir) çalışır");
  return { cwd: p.kb, home: p.home };
}

export interface KbPullResult {
  committed: boolean;
  merged: boolean;
  fastForward: boolean;
  activeMachine: string | null;
  warnings: string[];
}

/** `vlad kb pull`: commits pending changes, fetches, merges origin/<main>. Call inside withKbLock. */
export function pullKb(): KbPullResult {
  const { cwd } = requireSeparate();
  assertGitOwner(cwd);
  const committed = commitPending(cwd, "pull öncesi otomatik");
  fetchOrigin(cwd);
  const m = mergeMain(cwd, kbMainBranch(cwd));
  const st = activeStatus();
  const warnings = [...st.warnings];
  if (m.activeMainWon) {
    const w = activeLostWarning();
    if (w) warnings.push(w);
  }
  return { committed, merged: m.merged, fastForward: m.fastForward, activeMachine: st.record?.machine ?? null, warnings };
}

export interface KbResolveResult {
  merged: boolean;
  resolved: string[];
  backupDir?: string;
}

/**
 * `vlad kb resolve --take main|local [--path P…] [--card id]`: redoes the merge of origin/<main> and takes the
 * named (default all) conflicting files from the chosen side; the other side is backed up under
 * `logs/kb-conflicts/<key8>/`. Conflicts left outside the selection stay `kb_conflict`.
 */
export function resolveKb(o: { take: "main" | "local"; paths?: string[]; card?: string }): KbResolveResult {
  if (o.take !== "main" && o.take !== "local") throw new Error(`geçersiz --take: "${o.take}" (main | local)`);
  for (const p of o.paths ?? []) if (!safeRel(p)) throw new Error(`geçersiz --path: "${p}"`);
  const { cwd } = requireSeparate();
  assertGitOwner(cwd);
  commitPending(cwd, "resolve öncesi otomatik");
  fetchOrigin(cwd);
  const m = mergeMain(cwd, kbMainBranch(cwd), { take: o.take, paths: o.paths });
  if (o.card) resolveCard(o.card, "resolved");
  return { merged: m.merged, resolved: m.resolved, ...(m.backupDir ? { backupDir: m.backupDir } : {}) };
}

export interface KbSyncStatus {
  v: 1;
  /** `seq` of the last `logs/kbsync.request` this cycle saw (0: none) */
  seq: number;
  at: string;
  ok: boolean;
  phase: "commit" | "fetch" | "merge" | "push" | "done";
  error?: string;
  head?: string;
  main?: string;
}

export interface KbSyncResult {
  committed: boolean;
  heartbeat: boolean;
  merged: boolean;
  pushed: boolean;
  head: string;
  main: string | null;
  card?: string;
  applied?: string[];
  warnings: string[];
}

const requestFile = (logs: string) => join(logs, "kbsync.request");
export const kbSyncStatusFile = (logs: string) => join(logs, "kbsync.status.json");

function readRequestSeq(logs: string): number {
  try {
    const seq = (JSON.parse(readFileSync(requestFile(logs), "utf8")) as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
  } catch {
    return 0;
  }
}

function writeStatus(logs: string, s: KbSyncStatus): void {
  mkdirSync(logs, { recursive: true });
  const file = kbSyncStatusFile(logs);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Rebuilds HEAD as one cleaning commit on origin/<main>: the card's paths go back to main's version. */
function applyDiscard(cwd: string, main: string, card: Card): boolean {
  const c = card.data.kb_conflict!;
  const ref = `origin/${main}`;
  const dirty = c.paths.filter((p) => safeRel(p) && blobAt(cwd, "HEAD", p) !== blobAt(cwd, ref, p));
  if (!dirty.length) return false; // already clean: re-applying every cycle must be a no-op
  const backup = join(cwd, "logs", "kb-conflicts", c.key.slice(0, 8));
  for (const p of dirty) {
    const oid = blobAt(cwd, "HEAD", p);
    if (!oid) continue;
    const dest = join(backup, p);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, git(cwd, ["cat-file", "blob", oid]));
  }
  git(cwd, ["reset", "-q", "--soft", ref]);
  for (const p of dirty) {
    if (blobAt(cwd, ref, p)) git(cwd, ["checkout", ref, "--", p]);
    else {
      git(cwd, ["rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", p]);
      rmSync(join(cwd, p), { force: true });
    }
  }
  if (git(cwd, ["diff", "--cached", "--name-only"]).trim()) git(cwd, ["commit", "-q", "-m", `kb: discard ${c.key.slice(0, 8)} — reddedilen girdiler atıldı`]);
  return true;
}

function openConflictCard(e: KbConflictError): { id?: string; warning?: string } {
  try {
    const c = addCard({
      kind: "kb_conflict", project: KB_CONFLICT_PROJECT, title: `kb çakışması: ${e.paths.length} dosya`,
      kbConflict: { key: e.key, reason: "merge_conflict", source: "kbsync", head: e.head, base: e.base, paths: e.paths.slice(0, 50) },
    });
    return { id: c.data.id };
  } catch (err) {
    return { warning: `kb_conflict kartı açılamadı: ${(err as Error).message}` };
  }
}

/**
 * `vlad kb sync` (server, one cycle; call inside withKbLock with guard off): heartbeat if this machine is the
 * active VLAD, commit pending files, fetch, apply answered kb_conflict cards, merge origin/<main>, push to
 * `kbPushBranch`, close this machine's own kb_conflict cards on a clean run. The outcome always lands in
 * `logs/kbsync.status.json`, together with the `seq` of the last `logs/kbsync.request`.
 */
export function syncKb(): KbSyncResult {
  const { cwd } = requireSeparate();
  assertGitOwner(cwd);
  const logs = kbPaths().logs;
  const pushBranch = loadConfig().kbPushBranch;
  if (!pushBranch) throw new Error("kb_push_branch_required: kb sync yalnız machines.<makine>.kbPushBranch tanımlı makinede çalışır");
  const main = kbMainBranch(cwd);
  validatePushBranch(pushBranch, main);
  const seq = readRequestSeq(logs);
  const res: KbSyncResult = { committed: false, heartbeat: false, merged: false, pushed: false, head: "", main: null, warnings: [] };
  let phase: KbSyncStatus["phase"] = "commit";
  const status = (ok: boolean, error?: string): void => {
    const rev = (r: string) => gitTry(cwd, ["rev-parse", "-q", "--verify", r]).out.trim() || undefined;
    writeStatus(logs, { v: 1, seq, at: nowIso(), ok, phase: ok ? "done" : phase, ...(error ? { error } : {}), head: rev("HEAD"), main: rev(`origin/${main}`) });
  };
  try {
    const st = activeStatus();
    if (st.record && st.mine) res.heartbeat = heartbeatActive().written;
    res.committed = commitPending(cwd, "sunucu: otomatik");
    phase = "fetch";
    fetchOrigin(cwd);
    phase = "merge";
    const open = listCardsWithWarnings({ state: ["open"], kind: ["kb_conflict"] }).cards;
    const answered = (reason: string, option: string) =>
      open.filter((c) => c.data.kb_conflict!.reason === reason && c.data.answer?.option === option);
    const takeMain = answered("merge_conflict", "take_main");
    res.applied = [];
    try {
      const m = mergeMain(cwd, main, takeMain.length ? { take: "main" } : {});
      res.merged = m.merged;
      if (m.resolved.length) res.applied.push(...takeMain.map((c) => `take_main:${c.data.id}`));
      if (m.activeMainWon) {
        const w = activeLostWarning();
        if (w) res.warnings.push(w);
      }
    } catch (e) {
      if (e instanceof KbConflictError) {
        const card = openConflictCard(e);
        if (card.id) res.card = card.id;
        if (card.warning) res.warnings.push(card.warning);
      }
      throw e;
    }
    let discarded = false;
    for (const c of answered("rejected", "discard")) {
      if (applyDiscard(cwd, main, c)) {
        discarded = true;
        res.applied.push(`discard:${c.data.id}`);
      }
    }
    phase = "push";
    const dest = `refs/heads/${pushBranch}`;
    if (discarded) {
      // the rebuilt branch is not a descendant of what the remote has: replace it, but only if nobody pushed meanwhile
      const old = gitTry(cwd, ["rev-parse", "-q", "--verify", `origin/${pushBranch}`]).out.trim();
      const lease = old ? `--force-with-lease=${dest}:${old}` : "--force-with-lease";
      const r = gitTry(cwd, ["push", "-q", lease, "origin", `HEAD:${dest}`]);
      if (r.code !== 0) throw new Error(`kb_push_rejected: discard sonrası force-with-lease push reddedildi: ${r.err.trim()}`);
      res.merged = true;
    } else {
      const p = pushWithMerge(cwd, main, ["origin", `HEAD:${dest}`]);
      res.merged ||= p.merged;
    }
    res.pushed = true;
    for (const c of listCardsWithWarnings({ state: ["open"], kind: ["kb_conflict"] }).cards) {
      if (c.data.kb_conflict!.source === "kbsync") resolveCard(c.data.id, "resolved");
    }
    res.head = git(cwd, ["rev-parse", "HEAD"]).trim();
    res.main = gitTry(cwd, ["rev-parse", "-q", "--verify", `origin/${main}`]).out.trim() || null;
    if (!res.applied.length) delete res.applied;
    status(true);
    return res;
  } catch (e) {
    const msg = (e as Error).message;
    status(false, /^[a-z_]+(?=:)/.exec(msg)?.[0] ?? "kb_sync_failed");
    throw e;
  }
}
