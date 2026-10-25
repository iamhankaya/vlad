import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./files.ts";

export const PAIR_TTL_MS = 10 * 60_000;
export const PAIR_MAX_FAILURES = 5;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U

type CodeFile = { expires: number; failures: number };

export function normalizeCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(c) ? c : null;
}

const hashOf = (code: string) => createHash("sha256").update(`vlad-pair/v1\n${code}`).digest("hex");

/**
 * Pairing codes: 8 Crockford base32 characters (40 bits), 10 minutes, single use, burned after 5 wrong attempts.
 * One file per code (`pairing/<sha256>.json`, only the hash is stored) so the CLI (`vlad-server pair`) and the API
 * process never rewrite the same file.
 */
export class PairingCodes {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(stateDir: string, now: () => number) {
    this.now = now;
    this.dir = join(stateDir, "pairing");
    ensureDir(this.dir);
  }

  issue(): { code: string; expires: number } {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => ALPHABET[b & 31]).join(""); // 256 % 32 == 0: no modulo bias
    const expires = this.now() + PAIR_TTL_MS;
    writeJsonAtomic(join(this.dir, `${hashOf(code)}.json`), { expires, failures: 0 } satisfies CodeFile);
    return { code, expires };
  }

  /**
   * True and the code is consumed if it is valid. A wrong code counts as a failure against every live code
   * (the attacker does not know which one exists); a code with 5 failures is deleted.
   */
  redeem(raw: string): boolean {
    const t = this.now();
    const live = this.live(t);
    const code = normalizeCode(raw);
    const want = code ? Buffer.from(hashOf(code), "hex") : null;
    let hit: string | undefined;
    for (const [name] of live) {
      if (want && timingSafeEqual(want, Buffer.from(name.slice(0, -5), "hex"))) hit = name;
    }
    if (hit) {
      unlinkSync(join(this.dir, hit));
      return true;
    }
    for (const [name, f] of live) {
      if (++f.failures >= PAIR_MAX_FAILURES) unlinkSync(join(this.dir, name));
      else writeJsonAtomic(join(this.dir, name), f);
    }
    return false;
  }

  /** Live codes (unexpired, under the failure limit); expired or burned files are removed on the way. */
  private live(t: number): Map<string, CodeFile> {
    const out = new Map<string, CodeFile>();
    for (const name of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const f = readJsonFile<CodeFile>(join(this.dir, name));
      if (!f || f.expires <= t || f.failures >= PAIR_MAX_FAILURES) {
        try { unlinkSync(join(this.dir, name)); } catch { /* raced with another process */ }
        continue;
      }
      out.set(name, f);
    }
    return out;
  }
}
