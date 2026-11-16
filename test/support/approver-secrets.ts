// Uzaktan onay (T20261116-04 S5): bildirim gövdesi, approver.log, `approver status --json` ve `requests --json` çıktılarında BULUNMAMASI gereken kalıplar.
// Konu adları (vlad-q-/vlad-r-) yalnız bildirim gövdesinde ve action URL'sinde serbesttir; çağıran bu istisnayı kendi uygular (`SECRET_PATTERNS.topic`).
import { homedir } from "node:os";

export interface SecretPattern { name: string; re: RegExp }

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "mode.key hex (64 hex, tek başına)", re: /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i },
  { name: "mod belirteci VMT1/VMT2", re: /VMT[12]\.\S+/ },
  { name: "VLAD_MODE_TOKEN değeri", re: /VLAD_MODE_TOKEN=\S+/ },
  { name: "--answers / sentinel", re: /--answers|SECRET-SENTINEL-[\w-]+/ },
  { name: "istek/yanıt konusu", re: /vlad-[qr]-[a-z2-7]{26}/ },
];

/** `--note` metninin ilk 60 baytından sonrası bildirimde olmamalı. */
export const noteLeaks = (text: string, note: string): boolean => {
  const bytes = Buffer.from(note, "utf8");
  return bytes.length > 60 && text.includes(bytes.subarray(60).toString("utf8").trim()) && bytes.subarray(60).toString("utf8").trim().length > 0;
};

/** Mutlak $HOME yolu (örn. /Users/ad): bildirimde `~` ile kısaltılır. */
export const absoluteHomeLeaks = (text: string, home: string = homedir()): boolean => text.includes(home);

/** Verilen metinde ihlal eden kalıp adları; `allowTopic` bildirim gövdesi/action URL'si için konu kalıbını yok sayar. */
export function secretHits(text: string, opts: { allowTopic?: boolean } = {}): string[] {
  return SECRET_PATTERNS.filter((p) => !(opts.allowTopic && p.name === "istek/yanıt konusu") && p.re.test(text)).map((p) => p.name);
}
