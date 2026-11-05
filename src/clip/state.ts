import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, ensurePrivateDir } from "../fleet/state.js";

// `.vlad-agent/clip.json`: yalnız {enabled}. Dosya yoksa enabled:true (varsayılan açık). Yoklama her turda okur (açma/kapama anında geçerli).
export interface ClipState { enabled: boolean }
const file = (): string => join(agentDir(), "clip.json");

export function readClipState(): ClipState {
  let raw: string;
  try { raw = readFileSync(file(), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
    throw e;
  }
  try {
    const j = JSON.parse(raw) as { enabled?: unknown };
    if (typeof j?.enabled !== "boolean") throw new Error("enabled boolean değil");
    return { enabled: j.enabled };
  } catch (e) { throw new Error(`clip.json bozuk (${file()}): ${(e as Error).message}`); }
}

export function writeClipState(s: ClipState): void {
  ensurePrivateDir(agentDir());
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ enabled: s.enabled }) + "\n", { mode: 0o600 });
  renameSync(tmp, file());
}
