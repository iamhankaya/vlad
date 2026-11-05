import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VladConfig } from "../src/kb/index.js";
import { worktreePath } from "../src/git/git.js";

const here = dirname(fileURLToPath(import.meta.url));
const made: string[] = [];

/** Removes every dir makeHome/makeFixtureRoot created in this worker (best effort; F-vlad-105). */
export function cleanupMadeDirs(): void {
  for (const d of made.splice(0)) rmTemp(d);
}

/**
 * Creates a throwaway VLAD home (temp dir) with kb/* subfolders and a copy of
 * the repo's schemas/, and points process.env.VLAD_HOME at it.
 * Returns the home path. Shared by all tests; never touches the real kb/.
 */
export function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "vlad-test-"));
  made.push(home);
  for (const d of ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal"]) {
    mkdirSync(join(home, "kb", d), { recursive: true });
  }
  cpSync(resolve(here, "..", "schemas"), join(home, "schemas"), { recursive: true });
  process.env.VLAD_HOME = home;
  delete process.env.VLAD_KB_DIR;
  return home;
}

/** Canonical (8.3-expanded) throwaway root; every destructive test step must stay inside it. */
export function makeFixtureRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-t-")));
  made.push(root);
  return root;
}

/** Throws unless `p` (or its nearest existing ancestor) resolves inside `root`. */
export function assertInside(root: string, p: string): void {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(basename(cur)); cur = dirname(cur); }
  const real = join(realpathSync.native(cur), ...tail);
  const rel = relative(realpathSync.native(root), real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`fixture kökü dışında: ${p}`);
}

/** Directory junction (Windows) or dir symlink; both ends must be inside `root`. */
export function makeJunction(link: string, target: string, root: string): void {
  assertInside(root, link);
  assertInside(root, target);
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    throw new Error(`junction oluşturulamadı: ${(e as Error).message}`);
  }
}

/** Best-effort removal of a test's temp dir (a locked file must not fail the test). Links are detached, never followed. */
export function rmTemp(p: string | undefined): void {
  if (!p) return;
  try { rmSync(p, { recursive: true, force: true }); } catch { /* left for the OS temp cleanup */ }
}

/** worktreePath for the host OS, as the product code (launch.ts) derives it; the bare default is win32 (backslash). */
export function wtp(cfg: VladConfig, repoPath: string, taskId: string): string {
  return worktreePath(cfg, repoPath, taskId, process.platform as "win32" | "darwin" | "linux");
}
