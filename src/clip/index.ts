import type { AktarimDeps } from "../transfer/types.js";

// Sözleşme (S) → gövde B. 2'den çok makinede no-op + uyarı; nativeAllowed() false → no-op.
export function startClipSync(_d: AktarimDeps): { stop(): Promise<void> } {
  return { stop: async () => {} };
}
