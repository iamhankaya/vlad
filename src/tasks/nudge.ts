import { execFileSync } from "node:child_process";

/** F-vlad-361: tmux ile çalışana metin dürtme; Enter meşgul çalışanda yutulabilir, teslim doğrulanır. */
export interface NudgeDeps {
  /** tmux çalıştırır, stdout döner; hata fırlatır */
  tmux(args: string[]): string;
  sleep(ms: number): Promise<void>;
}

export interface NudgeResult { delivered: boolean; enters: number }

const TAIL = 40;
const BOX_LINES = 8; // istem kutusu pane'in sonundadır; eski çıktıda geçen metin kutu sayılmaz
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Pane'in son satırlarında gönderilen metnin kuyruğu hâlâ istem kutusunda mı? */
export function inputBoxHolds(pane: string, text: string): boolean {
  const tail = norm(text).slice(-TAIL);
  if (!tail) return false;
  const last = pane.replace(/\s+$/, "").split("\n").slice(-BOX_LINES).join(" ");
  return norm(last).includes(tail);
}

const defaultDeps: NudgeDeps = {
  tmux: (args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Metni (tek satır) çalışanın tmux penceresine yazar, Enter yollar ve istem kutusu boşalana kadar Enter'ı tekrarlar.
 * Metin yalnız bir kez yazılır (tekrar yazmak çoğaltırdı). `delivered: false` = sınırda hâlâ kutuda; çağıran SendMessage'a düşer.
 */
export async function nudgeWorker(taskId: string, text: string, deps: NudgeDeps = defaultDeps, o: { maxEnters?: number; settleMs?: number } = {}): Promise<NudgeResult> {
  if (/[\r\n]/.test(text)) throw new Error("dürtme metni tek satır olmalı (satır sonu istemi bölerdi)");
  const target = `vlad-${taskId}`;
  try { deps.tmux(["has-session", "-t", target]); } catch { throw new Error(`tmux oturumu yok: ${target} (çalışan penceresi kapalı ya da tmux dışı)`); }
  deps.tmux(["send-keys", "-t", target, "-l", text]);
  const max = o.maxEnters ?? 5;
  for (let enters = 1; enters <= max; enters++) {
    deps.tmux(["send-keys", "-t", target, "Enter"]);
    await deps.sleep(o.settleMs ?? 1500);
    if (!inputBoxHolds(deps.tmux(["capture-pane", "-p", "-t", target]), text)) return { delivered: true, enters };
  }
  return { delivered: false, enters: max };
}
