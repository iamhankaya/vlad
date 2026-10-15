import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  return home;
}
