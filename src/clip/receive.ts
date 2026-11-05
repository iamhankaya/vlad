import { NotImplementedOp } from "../agent/ops/index.js";
import type { ClipDeps, ClipReceiver } from "./types.js";
import { ClipSync } from "./sync.js";

// Sözleşme (S) → gövde B. `clip-push` stub'ı NotImplementedOp fırlatır.
export function createClipReceiver(d: ClipDeps): ClipReceiver {
  return {
    ops: { "clip-push": async () => { throw new NotImplementedOp("clip-push"); } },
    sink: { enabled: () => d.isEnabled(), apply: async () => { throw new NotImplementedOp("clip-push"); } },
    sync: new ClipSync(d),
  };
}
