import { RemoteError } from "./types.js";

/** CLI çıkış kodu: geçici uzak hata → 75 (EX_TEMPFAIL); diğerleri 1. KbLockTimeout bilerek 1 kalır (mevcut testler 1'i bekler). */
export function exitCodeFor(e: unknown): number {
  return e instanceof RemoteError && e.transient ? 75 : 1;
}

/** `--json` hatasının `details` satırları. */
export function remoteErrorDetails(e: unknown): string[] {
  return e instanceof RemoteError ? [`code: ${e.code}`, `machine: ${e.machine}`] : [];
}
