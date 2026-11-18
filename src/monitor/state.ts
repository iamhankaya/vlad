import { homedir } from "node:os";
import { join } from "node:path";
import type { MonitorState } from "./types.js";

export const MONITOR_DIRNAME = ".vlad-monitor";
export const monitorStateDir = (home: string = homedir()): string => join(home, MONITOR_DIRNAME);
export const monitorStatePath = (dir: string = monitorStateDir()): string => join(dir, "state.json");

export interface StateStore {
  /** Dosya yok → EMPTY_STATE. Bozuk/yanlış sürüm → hata (sessizce sıfırlama yok). */
  load(): MonitorState;
  /** Atomik (tmp + rename), dizin 0700, dosya 0600. */
  save(s: MonitorState): void;
}
/** Gövde uygulama fazında. */
export function createStateStore(_dir: string): StateStore {
  throw new Error("not implemented: createStateStore");
}
