import { readFileSync } from "node:fs";

/** Enjekte edilebilir saat: VLAD_NOW_FILE (içinde epoch ms) varsa her çağrıda okunur, yoksa Date.now. */
export function nowMs(): number {
  const f = process.env.VLAD_NOW_FILE;
  if (f) {
    try {
      const n = Number(readFileSync(f, "utf8").trim());
      if (Number.isFinite(n)) return n;
    } catch { /* dosya yok: gerçek saate düş */ }
  }
  return Date.now();
}
