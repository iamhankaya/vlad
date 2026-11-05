import { notImplemented } from "../platform/not-implemented.js";
import type { ApplyResult, ClipContent, ClipDeps, ClipKind, ClipSyncLike, OrderKey } from "./types.js";

// Sözleşme (S) → gövde B. Anlamsal özet: metin CRLF/CR→LF normalize + UTF-8 → sha256("text:"+bytes); resim sha256("image:"+bytes).
export class ClipSync implements ClipSyncLike {
  constructor(_d: ClipDeps) {}
  tick(): Promise<void> { return notImplemented("ClipSync.tick"); }
  applyRemote(_m: { kind: ClipKind; bytes: Buffer; key: OrderKey; from: string }): Promise<ApplyResult> { return notImplemented("ClipSync.applyRemote"); }
  start(): void { notImplemented("ClipSync.start"); }
  stop(): Promise<void> { return notImplemented("ClipSync.stop"); }
}
export function semanticHash(_c: ClipContent): string { return notImplemented("semanticHash"); }
