import type { ConsolePolicy } from "./types.js";
import { COMMANDS } from "./manifest.js";

export interface DesktopCatalog {
  /** Additive contract: fields are only ever added, never removed or renamed (vlad-desktop reads this). */
  version: 1;
  commands: Array<{ path: string[]; json: boolean; console: ConsolePolicy }>;
}

/** Plain-JSON command catalog for vlad-desktop, straight from the manifest. */
export function exportCatalog(): DesktopCatalog {
  return { version: 1, commands: COMMANDS.map((s) => ({ path: [...s.path], json: s.json, console: s.console })) };
}
