import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { git } from "./commit.js";
import { isSeparateKb, kbPaths } from "./home.js";

export interface ForeignCommit {
  sha: string;
  author: string;
  subject: string;
}

export interface KbCheckResult {
  foreign: ForeignCommit[];
  warnings?: string[];
}

/** Without a verified point only the newest commits are inspected: older history predates the `kb:` rule. */
const FALLBACK_COMMITS = 50;

/**
 * Cloud workers get the kb read-only by protocol only (the platform does not stop their pushes), and
 * only VLAD writes through `vlad kb commit`, whose subject always starts with `kb:`. Any commit on the
 * remote branch since the last verified point without that prefix is foreign.
 * The verified point lives in `.git/vlad-kb-verified` (never committed). It advances only when nothing
 * foreign was found, or with `ack` once the user has seen the list, so a foreign commit is reported until acknowledged.
 * Author is reported but not judged: VLAD itself commits as several identities, and a worker can fake the prefix
 * (shortcut: prefix-only, upgrade to signed commits if that matters).
 */
export function checkKb(o: { ack?: boolean } = {}): KbCheckResult {
  const paths = kbPaths();
  if (!isSeparateKb(paths.home)) return { foreign: [], warnings: ["kb ayrı depoda değil; yabancı commit kontrolü atlandı"] };
  const cwd = paths.kb;
  const warnings: string[] = [];
  try {
    git(cwd, ["fetch", "-q"]);
  } catch (e) {
    return { foreign: [], warnings: [`fetch başarısız, kontrol atlandı: ${(e as Error).message}`] };
  }
  let ref: string;
  try {
    ref = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
  } catch {
    return { foreign: [], warnings: ["kb dalının upstream'i yok; kontrol atlandı"] };
  }
  const head = git(cwd, ["rev-parse", ref]).trim();
  let gitDir = git(cwd, ["rev-parse", "--git-dir"]).trim();
  if (!isAbsolute(gitDir)) gitDir = resolve(cwd, gitDir);
  const markerFile = join(gitDir, "vlad-kb-verified");
  let range = ["-n", String(FALLBACK_COMMITS), ref];
  if (existsSync(markerFile)) {
    const marker = readFileSync(markerFile, "utf8").trim();
    try {
      git(cwd, ["merge-base", "--is-ancestor", marker, ref]);
      range = [`${marker}..${ref}`];
    } catch {
      warnings.push(`doğrulanan nokta (${marker.slice(0, 7)}) uzak dalın atası değil (force push / geçmiş yeniden yazılmış olabilir); son ${FALLBACK_COMMITS} commit incelendi`);
    }
  }
  const foreign: ForeignCommit[] = git(cwd, ["log", "--format=%h%x09%an%x09%s", ...range])
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { const [sha, author, ...s] = l.split("\t"); return { sha, author, subject: s.join("\t") }; })
    .filter((c) => !c.subject.startsWith("kb:"));
  if (!foreign.length || o.ack) writeFileSync(markerFile, `${head}\n`);
  return warnings.length ? { foreign, warnings } : { foreign };
}
