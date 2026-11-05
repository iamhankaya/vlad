import type { VladConfig } from "../kb/types.js";
import type { CommandSpec, ConsolePolicy, ExecKind } from "./types.js";
import { keyOf } from "./types.js";
import { COMMANDS } from "./manifest.js";
import type { WriteCmd } from "../fleet/types.js";

/** Pure views over the manifest; the old hand-kept sets (KB_WRITES, WORKER_LOCAL, FORWARD, INNER_LOCK, console catalog) derive from these. */
const byKey = new Map<string, CommandSpec>(COMMANDS.map((s) => [keyOf(s), s]));
const keysWhere = (f: (s: CommandSpec) => boolean): ReadonlySet<string> => new Set(COMMANDS.filter(f).map(keyOf));

export const kbWriteKeys = (): ReadonlySet<string> => keysWhere((s) => s.lock !== "none");
export const refreshKeys = (): ReadonlySet<string> => keysWhere((s) => s.refresh);
export const workerLocalKeys = (): ReadonlySet<string> => keysWhere((s) => s.worker.kind === "local");
/** Commands whose handler locks the kb in phases once `machines` is set. */
export const innerLockKeys = (): ReadonlySet<string> => keysWhere((s) => s.lock === "phased");
export const forwardMap = (): Readonly<Record<string, WriteCmd>> =>
  Object.fromEntries(COMMANDS.flatMap((s) => (s.worker.kind === "forward" ? [[keyOf(s), s.worker.op] as const] : [])));
export const consoleCatalog = (): Readonly<Record<string, ConsolePolicy>> => Object.fromEntries(COMMANDS.map((s) => [keyOf(s), s.console]));

/** Unknown key (not a command) → "none", as an unlisted key was never a kb write. `getCfg` is read only for phased commands: a broken config must not stop `scan`. */
export function lockPolicyFor(key: string, getCfg: () => Pick<VladConfig, "machines">): "outer" | "inner" | "none" {
  const lock = byKey.get(key)?.lock ?? "none";
  if (lock === "none") return "none";
  return lock === "phased" && getCfg().machines ? "inner" : "outer";
}

export const execKindOf = (key: string): ExecKind => byKey.get(key)?.exec ?? "standard";

/** Console exec sub-process limit for a console argv: the longest catalog path that matches wins; default 110 s. */
export function consoleTimeoutMs(argv: readonly string[]): number {
  let best: CommandSpec | undefined;
  for (const s of COMMANDS) {
    if (s.console.kind === "none" || s.path.length > argv.length || !s.path.every((p, i) => argv[i] === p)) continue;
    if (!best || s.path.length > best.path.length) best = s;
  }
  return (best?.console.kind !== "none" ? best?.console.timeoutMs : undefined) ?? 110_000;
}
