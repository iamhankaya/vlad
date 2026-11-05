import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { Os } from "../machines/types.js";
import { assertNative } from "./native.js";

// Köken işareti (Mark-of-the-Web): VLAD ile gelen dosya "başka makineden" sayılır (SmartScreen/Gatekeeper).
// Windows: Zone.Identifier ADS (ZoneId=3). macOS: com.apple.quarantine xattr. Komut/içerik üretimi saf; çalıştırma enjekte edilebilir.
export interface OriginCommand { file: string; args: string[] }
export type OriginMarker = (file: string, from: string) => Promise<void>;

export const quarantineValue = (nowMs: number): string => `0081;${Math.floor(nowMs / 1000).toString(16)};vlad;`;
/** argv ile (kabuk yok); yol argüman olarak geçer. */
export const quarantineCommand = (file: string, nowMs: number): OriginCommand => ({ file: "xattr", args: ["-w", "com.apple.quarantine", quarantineValue(nowMs), file] });
export const adsPath = (file: string): string => `${file}:Zone.Identifier`;
/** Gönderen adı yalnız [A-Za-z0-9._-] bırakılır: ek satır/anahtar enjekte edilemez. */
export const zoneIdentifier = (from: string): string => `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=vlad://${from.replace(/[^A-Za-z0-9._-]/g, "")}\r\n`;

const run = (c: OriginCommand) => new Promise<void>((resolve, reject) => { execFile(c.file, c.args, { timeout: 10_000, windowsHide: true }, (e) => (e ? reject(e) : resolve())); });

/** `exec`/`write` verilmezse gerçek çağrı yapılır ve önce `assertNative` ister (VLAD_NO_NATIVE=1 → NativeDisabledError). */
export function createOriginMarker(os: Os, o: { exec?: (c: OriginCommand) => Promise<void>; write?: (path: string, content: string) => Promise<void>; now?: () => number } = {}): OriginMarker {
  return async (file, from) => {
    if (os === "win32") {
      if (!o.write) assertNative("köken işareti");
      await (o.write ?? ((p, c) => writeFile(p, c)))(adsPath(file), zoneIdentifier(from));
    } else {
      if (!o.exec) assertNative("köken işareti");
      await (o.exec ?? run)(quarantineCommand(file, (o.now ?? Date.now)()));
    }
  };
}
