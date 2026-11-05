import { notImplemented } from "../platform/not-implemented.js";

// Sözleşme (S) → gövde B. `.vlad-agent/clip.json`; dosya yoksa enabled:true.
export interface ClipState { enabled: boolean }
export function readClipState(): ClipState { return notImplemented("readClipState"); }
export function writeClipState(_s: ClipState): void { notImplemented("writeClipState"); }
