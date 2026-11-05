import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { RemoteError } from "../fleet/types.js";
import type { Ledger, LedgerRecord } from "./types.js";

// Teslim kaydı: <stateDir>/xfer/delivered/<sha256(anahtar)>.json; atomik temp+rename yazma (çökme yarım kayıt bırakmaz).
export type { Ledger, LedgerRecord } from "./types.js";

export function createLedger(stateDir: string): Ledger {
  const dir = join(stateDir, "xfer", "delivered");
  const file = (key: string) => join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
  return {
    async get(key) {
      let text: string;
      try { text = await readFile(file(key), "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
      try { return JSON.parse(text) as LedgerRecord; } catch { throw new RemoteError("failed", "failed: teslim kaydı okunamadı (bozuk)"); }
    },
    async put(key, r) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = file(key), tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        const fh = await open(tmp, "wx", 0o600);
        try { await fh.writeFile(JSON.stringify(r)); await fh.sync(); } finally { await fh.close(); }
        await rename(tmp, target);
      } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
    },
  };
}
