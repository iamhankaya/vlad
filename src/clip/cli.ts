import { notImplemented } from "../platform/not-implemented.js";

// Sözleşme (S) → gövde B. `clip status` yalnız dosya durumunu (enabled) ve agentRunning'i verir.
// `clip get`: metin stdout; resim varsa --out <png> ister, yoksa çıkış 1. `clip set [text]|--file <yol|->|--image <png>`.
export interface ClipCommandOpts { json?: boolean; file?: string; text?: string; image?: string; out?: string }
export function runClip(_sub: "on" | "off" | "status" | "get" | "set", _o: ClipCommandOpts): Promise<void> { return notImplemented("runClip"); }
