import type { VladConfig } from "../kb/types.js";
import type { ConsolePolicy } from "./types.js";
import { COMMANDS } from "./manifest.js";
import type { WriteCmd } from "../machines/types.js";

/** In S the manifest is an empty stub; answering from it would silently change policy (e.g. lock-free writes), so fail loudly. */
function filled(): typeof COMMANDS {
  if (COMMANDS.length === 0) throw new Error("manifest henüz doldurulmadı (U1)");
  return COMMANDS;
}
export const kbWriteKeys = (): ReadonlySet<string> => (filled(), new Set<string>());
export const refreshKeys = (): ReadonlySet<string> => (filled(), new Set<string>());
export const workerLocalKeys = (): ReadonlySet<string> => (filled(), new Set<string>());
export const forwardMap = (): Readonly<Record<string, WriteCmd>> => (filled(), {});
export const consoleCatalog = (): Readonly<Record<string, ConsolePolicy>> => (filled(), {});
export const lockPolicyFor = (_key: string, _getCfg: () => Pick<VladConfig, "machines">): "outer" | "inner" | "none" => (filled(), "none");
