import type { SecretReader } from "./types.js";
import { MONITOR_SERVER_ID_RE } from "./types.js";

/** spc `run-health.sh` ile aynı Keychain kaydı: hizmet `spc_token_<id>` (id küçük harf, `-` → `_`), hesap `$USER`. */
export function keychainService(serverId: string): string {
  if (!MONITOR_SERVER_ID_RE.test(serverId)) throw new Error(`geçersiz sunucu kimliği: ${serverId}`);
  return `spc_token_${serverId.replace(/-/g, "_")}`;
}

/** `security find-generic-password -a "$USER" -s <hizmet> -w` (execFile; kabuk yok, argümanda sır yok). Yalnız macOS; kayıt yoksa null. Gövde uygulama fazında. */
export function createKeychainReader(_exec?: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>): SecretReader {
  throw new Error("not implemented: createKeychainReader");
}
