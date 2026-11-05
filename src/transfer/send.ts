import { RemoteError, type RemoteTransport } from "../machines/types.js";
import { notImplemented } from "../platform/not-implemented.js";
import type { XferCommitResult, XferItem, XferPurpose } from "./types.js";

// Sözleşme (S) → gövde A2. Gönderici id'yi bir kez üretir (randomBytes(16).toString("hex")) ve ömrü boyunca sabit tutar.
// Akış: ping caps → xfer-begin → xfer-chunk… → xfer-commit. Chunk not_found ise aynı id ile begin tekrarı (en çok bir kez).
// Commit yanıtı kayıp/zaman aşımı ise aynı commit tekrarı, ardından uncertain ya da unreachable.
export class XferUncertainError extends RemoteError {
  constructor(message: string, public details: { planned?: string[]; published?: string[] } = {}) { super("uncertain", message); this.name = "XferUncertainError"; }
}
export interface SendOptions {
  to: string; paths: string[];
  onProgress?(p: { sentBytes: number; totalBytes: number; file: string }): void;
  chunkBytes?: number; concurrency?: 1 | 2; sleep?(ms: number): Promise<void>; newId?(): string;
}
export interface SendResult { to: string; items: XferItem[]; failed?: { name: string; error: string }; skipped: { path: string; reason: "symlink" | "special" }[]; totalBytes: number }
export function sendPaths(_t: RemoteTransport, _o: SendOptions): Promise<SendResult> { return notImplemented("sendPaths"); }
export function uploadBuffer(_t: RemoteTransport, _to: string, _data: Buffer, _o: { purpose: XferPurpose; name: string; meta?: Record<string, string | number> }): Promise<XferCommitResult> { return notImplemented("uploadBuffer"); }
