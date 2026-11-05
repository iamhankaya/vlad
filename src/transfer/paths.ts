import { RemoteError, type Os } from "../machines/types.js";
import { notImplemented } from "../platform/not-implemented.js";

// Sözleşme (S) → gövde A1.
export class XferPathError extends RemoteError {
  constructor(message: string) { super("bad_request", message); this.name = "XferPathError"; }
}
/** Geçersizse XferPathError("bad_request: yol geçersiz: <neden>"). */
export function sanitizeEntryPath(_raw: string, _os: Os): string[] { return notImplemented("sanitizeEntryPath"); }
export function isXferId(_s: unknown): _s is string { return notImplemented("isXferId"); }
/** "ad (1).ext"; ".env" -> ".env (1)"; "a.tar.gz" -> "a.tar (1).gz". Harf duyarsız karşılaştırma çağıranın sorumluluğu (küçük harfli küme verir). */
export function uniqueName(_name: string, _exists: (candidate: string) => Promise<boolean>, _kind?: "file" | "dir"): Promise<string> { return notImplemented("uniqueName"); }
/** VLAD_DOWNLOADS_DIR > darwin ~/Downloads > win32 %USERPROFILE%\Downloads */
export function downloadsDir(_os?: NodeJS.Platform, _env?: NodeJS.ProcessEnv): string { return notImplemented("downloadsDir"); }
