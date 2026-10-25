import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendDurable, ensureDir, fsyncDir } from "./files.ts";

export const REPLAY_TTL_MS = 5 * 60_000;

/**
 * Single-use keys (envelope nonces, revoke `(signer, ts)`), kept 5 minutes. Persisted to an append-only log
 * (`replay.log`, 0600) so a restart does not reopen the replay window. Callers `claim` only after the signature is valid,
 * so an attacker cannot fill the cache with garbage.
 */
export class ReplayCache {
  private readonly file: string;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();
  private appended = 0;

  constructor(stateDir: string, now: () => number) {
    this.now = now;
    ensureDir(stateDir);
    this.file = join(stateDir, "replay.log");
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const tab = line.lastIndexOf("\t");
      const exp = Number(line.slice(tab + 1));
      if (tab > 0 && Number.isFinite(exp) && exp > now()) this.seen.set(line.slice(0, tab), exp);
    }
    this.compact();
  }

  /** True the first time a key is claimed within its TTL; false for a replay. */
  claim(key: string): boolean {
    const t = this.now();
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > t) return false;
    const until = t + REPLAY_TTL_MS;
    this.seen.set(key, until);
    appendDurable(this.file, `${key}\t${until}\n`);
    if (++this.appended > 2000) this.compact();
    return true;
  }

  private compact(): void {
    const t = this.now();
    for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, [...this.seen].map(([k, e]) => `${k}\t${e}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.file);
    fsyncDir(dirname(this.file));
    this.appended = 0;
  }
}
