import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { git } from "./commit.js";
import { isSeparateKb, kbPaths } from "./home.js";

export interface ForeignCommit {
  sha: string;
  author: string;
  subject: string;
}

export interface SuspiciousCommit extends ForeignCommit {
  files: string[];
}

export interface KbCheckResult {
  /** false when the check could not run (no network, no upstream, kb not a separate repo): "nothing foreign" is then unknown */
  checked: boolean;
  foreign: ForeignCommit[];
  /** commits (any prefix) that touch `CLAUDE.md`/`CLAUDE.local.md`/`AGENTS.md`/`.mcp.json` or `.claude/`/`.github/` at any depth: files that load into sessions or CI */
  suspicious: SuspiciousCommit[];
  /** remote head the check covered; pass it to `--ack <sha>` so commits that landed since are not acknowledged unseen */
  head?: string;
  warnings?: string[];
}

/** Without a verified point only the newest commits are inspected: older history predates the `kb:` rule. */
const FALLBACK_COMMITS = 50;
const SENSITIVE = /(^|\/)(CLAUDE(\.local)?\.md|AGENTS\.md|\.mcp\.json)$|(^|\/)\.(claude|github)\//;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const UNCHECKED = "KONTROL YAPILAMADI";

/** `--strict`: a foreign/suspicious commit or an unchecked run fails the command (default exit stays 0). */
export function kbCheckExitCode(r: KbCheckResult, strict: boolean): number {
  return strict && (!r.checked || r.foreign.length || r.suspicious.length) ? 1 : 0;
}

const unchecked = (why: string): KbCheckResult => ({ checked: false, foreign: [], suspicious: [], warnings: [`${UNCHECKED}: ${why}`] });

/**
 * Cloud workers get the kb read-only by protocol only (the platform does not stop their pushes), and
 * only VLAD writes through `vlad kb commit`, whose subject always starts with `kb:`. Any commit on the
 * remote branch since the last verified point without that prefix is foreign.
 * The verified point lives in `.git/vlad-kb-verified` (never committed). It advances only when nothing
 * foreign was found, or with `ack` (a sha, the `head` of a check the user saw) once the user has seen the lists, so a foreign commit is reported until acknowledged.
 * Merge commits are not judged foreign (the commits they bring are in the range), but files a merge itself changed (`--cc`) are checked for sensitive paths. Only the upstream branch is checked and the
 * prefix is a convention, so this is good-faith protection, not enforcement.
 * Author is reported but not judged: VLAD itself commits as several identities, and a worker can fake the prefix
 * (shortcut: prefix-only, upgrade to signed commits if that matters).
 */
export function checkKb(o: { ack?: boolean | string } = {}): KbCheckResult {
  if (o.ack !== undefined && (typeof o.ack !== "string" || !SHA_RE.test(o.ack))) {
    throw new Error("--ack bir commit sha'sı ister (7-40 hex); `vlad kb check --json` çıktısındaki head değerini ver");
  }
  const paths = kbPaths();
  if (!isSeparateKb(paths.home)) return unchecked("kb ayrı depoda değil; yabancı commit kontrolü atlandı");
  const cwd = paths.kb;
  const warnings: string[] = [];
  try {
    git(cwd, ["fetch", "-q"]);
  } catch (e) {
    return unchecked(`fetch başarısız, kontrol atlandı: ${(e as Error).message}`);
  }
  let ref: string;
  try {
    ref = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
  } catch {
    return unchecked("kb dalının upstream'i yok; kontrol atlandı");
  }
  const head = git(cwd, ["rev-parse", ref]).trim();
  let gitDir = git(cwd, ["rev-parse", "--git-dir"]).trim();
  if (!isAbsolute(gitDir)) gitDir = resolve(cwd, gitDir);
  const markerFile = join(gitDir, "vlad-kb-verified");
  let range = ["-n", String(FALLBACK_COMMITS), head];
  if (existsSync(markerFile)) {
    const marker = readFileSync(markerFile, "utf8").trim();
    try {
      git(cwd, ["merge-base", "--is-ancestor", marker, ref]);
      range = [`${marker}..${head}`];
    } catch {
      warnings.push(`doğrulanan nokta (${marker.slice(0, 7)}) uzak dalın atası değil (force push / geçmiş yeniden yazılmış olabilir); son ${FALLBACK_COMMITS} commit incelendi`);
    }
  }
  // evil merge: --cc lists only files a merge itself changed vs all parents (what its side branches brought is in the normal commits)
  const parse = (extra: string[]) => git(cwd, ["log", ...extra, "--no-renames", "--name-only", "--format=%x01%h%x00%s%x00%an", ...range])
    .split("\x01").filter(Boolean)
    .map((chunk) => {
      const [head1, ...files] = chunk.split(/\r?\n/).filter(Boolean);
      // fields split on NUL (git forbids it in names and subjects), so an author name cannot fake the subject prefix
      const [sha, subject, author] = head1.split("\0");
      return { sha, author, subject, files };
    });
  const commits = parse(["--no-merges"]);
  const merges = parse(["--merges", "--cc"]);
  const foreign: ForeignCommit[] = commits.filter((c) => !c.subject.startsWith("kb:")).map(({ files: _f, ...c }) => c);
  const suspicious: SuspiciousCommit[] = [...commits, ...merges].filter((c) => c.files.some((f) => SENSITIVE.test(f)))
    .map((c) => ({ ...c, files: c.files.filter((f) => SENSITIVE.test(f)) }));
  const verified = git(cwd, ["rev-parse", "--verify", `${o.ack ?? head}^{commit}`]).trim();
  if (o.ack) git(cwd, ["merge-base", "--is-ancestor", verified, head]);
  if ((!foreign.length && !suspicious.length) || o.ack) writeFileAtomic(markerFile, `${verified}\n`);
  return { checked: true, foreign, suspicious, head, ...(warnings.length ? { warnings } : {}) };
}
