import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { EMPTY_STATE, type MonitorState } from "./types.js";

export const MONITOR_DIRNAME = ".vlad-monitor";
export const monitorStateDir = (home: string = homedir()): string => join(home, MONITOR_DIRNAME);
export const monitorStatePath = (dir: string = monitorStateDir()): string => join(dir, "state.json");

export interface StateStore {
  /** Dosya yok → EMPTY_STATE. Bozuk/yanlış sürüm → hata (sessizce sıfırlama yok). */
  load(): MonitorState;
  /** Atomik (tmp + rename), dizin 0700, dosya 0600. */
  save(s: MonitorState): void;
}

export function createStateStore(dir: string): StateStore {
  const file = monitorStatePath(dir);
  return {
    load() {
      let raw: string;
      try { raw = readFileSync(file, "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
        throw e;
      }
      let s: unknown;
      try { s = JSON.parse(raw); } catch { throw new Error(`monitor durum dosyası bozuk: ${file} (elle silmeden önce inceleyin)`); }
      const o = s as { v?: unknown; servers?: unknown } | null;
      if (!o || typeof o !== "object" || o.v !== 1 || typeof o.servers !== "object" || o.servers === null) {
        throw new Error(`monitor durum dosyası geçersiz sürüm/şekil: ${file}`);
      }
      return s as MonitorState;
    },
    save(s) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    },
  };
}
