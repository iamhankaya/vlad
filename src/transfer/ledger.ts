import { notImplemented } from "../platform/not-implemented.js";
import type { Ledger } from "./types.js";

// Sözleşme (S) → gövde A1. Kayıt: <stateDir>/xfer/delivered/<sha256(from+"\0"+id)>.json, atomik temp+rename yazma.
export type { Ledger, LedgerRecord } from "./types.js";
export function createLedger(_dir: string): Ledger { return notImplemented("createLedger"); }
