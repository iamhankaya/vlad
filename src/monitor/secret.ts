import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import type { SecretReader } from "./types.js";
import { MONITOR_SERVER_ID_RE } from "./types.js";

/** spc `run-health.sh` ile aynı Keychain kaydı: hizmet `spc_token_<id>` (id küçük harf, `-` → `_`), hesap `$USER`. */
export function keychainService(serverId: string): string {
  if (!MONITOR_SERVER_ID_RE.test(serverId)) throw new Error(`geçersiz sunucu kimliği: ${serverId}`);
  return `spc_token_${serverId.replace(/-/g, "_")}`;
}

/** Keychain okunamadı (kayıt yok dışı). İleti yalnız çıkış kodunu taşır; çıktı/sır içermez. */
export class KeychainError extends Error {
  constructor(readonly exitCode: number) { super(`Keychain okunamadı (kod ${exitCode})`); this.name = "KeychainError"; }
}
const NOT_FOUND = 44; // errSecItemNotFound

type Exec =(file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
const realExec: Exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 10_000 }, (err, stdout) => {
    const c = (err as { code?: unknown } | null)?.code;
    resolve({ code: !err ? 0 : typeof c === "number" ? c : 1, stdout: String(stdout) });
  });
});

/** `security find-generic-password -a "$USER" -s <hizmet> -w` (execFile; kabuk yok, argümanda sır yok). Yalnız macOS; kayıt yoksa null. */
export function createKeychainReader(execIn?: Exec): SecretReader {
  const exec = execIn ?? realExec;
  return {
    async read(service) {
      const account = process.env.USER || userInfo().username;
      const r = await exec("security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
      if (r.code === NOT_FOUND) return null;
      if (r.code !== 0) throw new KeychainError(r.code);
      const v = r.stdout.replace(/\r?\n$/, "");
      return v === "" ? null : v;
    },
  };
}
