import { assertNative } from "../platform/native.js";
import { notImplemented } from "../platform/not-implemented.js";
import type { ClipboardBackend, PersistentRunner } from "./types.js";

// Sözleşme (S) → gövde B (backend-win32 / backend-darwin). Gerçek çalıştırıcı (`run` verilmezse) önce `assertNative` ister.
export function createBackend(_os: NodeJS.Platform, run?: PersistentRunner): ClipboardBackend {
  const guard = (what: string) => { if (!run) assertNative(`pano ${what}`); return notImplemented(`pano ${what}`); };
  return {
    read: async () => guard("okuma"),
    write: async () => guard("yazma"),
    changeCount: async () => guard("changeCount"),
    close: async () => {},
  };
}
