import { KbLockTimeout } from "../kb/lock.js";
import { RemoteError } from "../fleet/types.js";
import { MemoryGateError } from "../memwatch/gate.js";

/** CLI çıkış kodu: geçici uzak hata, kb kilidi zaman aşımı ve bellek kapısı reddi → 75 (EX_TEMPFAIL); diğerleri 1. */
export function exitCodeFor(e: unknown): number {
  return (e instanceof RemoteError && e.transient) || e instanceof KbLockTimeout || e instanceof MemoryGateError ? 75 : 1;
}

/** `--json` hatasının `details` satırları. */
export function remoteErrorDetails(e: unknown): string[] {
  if (!(e instanceof RemoteError)) return [];
  const paths = (e as { paths?: unknown }).paths; // XferNameError: sorunlu yollar
  return [`code: ${e.code}`, `machine: ${e.machine}`, ...(Array.isArray(paths) ? paths.map((p) => `path: ${p}`) : [])];
}
