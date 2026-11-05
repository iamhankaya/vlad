import { NotImplementedOp, type OpHandler } from "../agent/ops/index.js";
import type { AgentOp } from "../machines/types.js";
import type { XferDeps, XferReceiver } from "./types.js";

// Sözleşme (S) → gövde A1. Stub op'lar NotImplementedOp fırlatır (kabul testleri bu sentinel ile kırmızı başlar).
export type { XferReceiver } from "./types.js";
const ni = (op: AgentOp): OpHandler => async () => { throw new NotImplementedOp(op); };
export function createXferReceiver(_d: XferDeps): XferReceiver {
  return {
    ops: { "xfer-begin": ni("xfer-begin"), "xfer-chunk": ni("xfer-chunk"), "xfer-commit": ni("xfer-commit"), "xfer-abort": ni("xfer-abort") },
    sweep: async () => 0,
    close: async () => {},
  };
}
