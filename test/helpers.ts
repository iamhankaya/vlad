import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Creates a throwaway VLAD home (temp dir) with kb/* subfolders and a copy of
 * the repo's schemas/, and points process.env.VLAD_HOME at it.
 * Returns the home path. Shared by all tests; never touches the real kb/.
 */
export function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "vlad-test-"));
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
  return realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-t-")));
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
