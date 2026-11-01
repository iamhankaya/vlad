import { KbLockTimeout } from "../kb/lock.js";
import { RemoteError } from "./types.js";

/** CLI çıkış kodu: geçici uzak hata ve kb kilidi zaman aşımı → 75 (EX_TEMPFAIL); diğerleri 1. */
export function exitCodeFor(e: unknown): number {
  return (e instanceof RemoteError && e.transient) || e instanceof KbLockTimeout ? 75 : 1;
}

/** `--json` hatasının `details` satırları. */
export function remoteErrorDetails(e: unknown): string[] {
  return e instanceof RemoteError ? [`code: ${e.code}`, `machine: ${e.machine}`] : [];
}
