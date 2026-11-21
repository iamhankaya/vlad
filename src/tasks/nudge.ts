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
// Boşluksuz karşılaştırma: terminal sözcük içinde sarabilir (`çalı⏎ştır`); satır birleşimi boşluk eklese de eşleşir.
const norm = (s: string): string => s.replace(/\s+/g, "");

const PROMPT_LINE = /^[\s│|]*>/;

/**
 * Gönderilen metnin kuyruğu hâlâ istem kutusunda mı? Kutu = pane'deki EN ALT istem satırı (`> …`, çerçeveli ya da değil) ve
 * altındakiler (sarılmış devam satırları, alt çerçeve). Dökümde yukarıda kalan `> metin` yankısı (çalışanın kullanıcı mesajı
 * yansıması) en alt istem satırı olmadığı için sayılmaz. Hiç istem satırı yoksa eski kural: son BOX_LINES satır.
 */
export function inputBoxHolds(pane: string, text: string): boolean {
  const tail = norm(text).slice(-TAIL);
  if (!tail) return false;
  const lines = pane.replace(/\s+$/, "").split("\n");
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (PROMPT_LINE.test(lines[i])) { from = i; break; }
  const box = (from >= 0 ? lines.slice(from) : lines.slice(-BOX_LINES)).join(" ").replace(/[│╭╮╰╯─]/g, " ");
  return norm(box).includes(tail);
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
  return nudgeVia(tmuxPane(taskId, deps.tmux), text, deps.sleep, o);
}

// F-vlad-370: pencere soyutlaması; tmux ve Windows konsolu aynı teslim döngüsünü paylaşır.
/** Çalışan penceresinin soyutlaması: tmux oturumu (Mac/Linux) ya da Windows konsolu. */
export interface NudgePane {
  /** pencere yoksa açık hata fırlatır */
  exists(): void | Promise<void>;
  /** metni (tek satır) yazar, Enter yollamaz */
  type(text: string): void | Promise<void>;
  enter(): void | Promise<void>;
  /** görünen ekranın/pane'in metni (sarılmış satırlar birleşik) */
  capture(): string | Promise<string>;
}

/** Metni pencereye yazar, Enter yollar ve istem kutusu boşalana kadar Enter'ı tekrarlar (metin yalnız bir kez yazılır). */
export async function nudgeVia(pane: NudgePane, text: string, sleep: (ms: number) => Promise<void>, o: { maxEnters?: number; settleMs?: number } = {}): Promise<NudgeResult> {
  if (/[\r\n]/.test(text)) throw new Error("dürtme metni tek satır olmalı (satır sonu istemi bölerdi)");
  await pane.exists();
  await pane.type(text);
  const max = o.maxEnters ?? 5;
  for (let enters = 1; enters <= max; enters++) {
    await pane.enter();
    await sleep(o.settleMs ?? 1500);
    if (!inputBoxHolds(await pane.capture(), text)) return { delivered: true, enters };
  }
  return { delivered: false, enters: max };
}

/** Pencere/oturum yok: çağıran bunu `not_found` olarak ayırt eder (uzak op'ta). */
export class NoWindowError extends Error {}

/** tmux oturumunu (`vlad-<id>`) `NudgePane` olarak sarar. */
export function tmuxPane(taskId: string, tmux: (args: string[]) => string): NudgePane {
  const target = `vlad-${taskId}`;
  return {
    exists: () => { try { tmux(["has-session", "-t", target]); } catch { throw new NoWindowError(`tmux oturumu yok: ${target} (çalışan penceresi kapalı ya da tmux dışı)`); } },
    type: (text) => { tmux(["send-keys", "-t", target, "-l", "--", text]); },
    enter: () => { tmux(["send-keys", "-t", target, "Enter"]); },
    capture: () => tmux(["capture-pane", "-p", "-J", "-t", target]),
  };
}

// Claude Code's folder trust prompt ("Quick safety check" / "Do you trust the files in this folder?").
export const trustScreenShown = (pane: string): boolean => /quick safety check|trust (the files in )?this folder/i.test(pane);

export interface TrustDeps {
  tmux(args: string[]): string;
  sleepSync(ms: number): void;
}

const defaultTrustDeps: TrustDeps = {
  tmux: defaultDeps.tmux,
  sleepSync: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

// D-vlad-087 (F-vlad-335): güven ekranında takılan çalışana onay tuşu. Yalnız VLAD'ın açtığı `vlad-<id>` tmux oturumunda ve
// pane gerçekten güven ekranını gösteriyorsa tek bir Enter gönderir ("Yes, I trust this folder" varsayılan seçenektir); metin yazılmaz.
// Enter sonrası ekranın kalktığı doğrulanırsa true. Kalkmadıysa false (çağıran takıldı sayar; tekrar basılmaz).
export function approveTrustScreen(taskId: string, deps: TrustDeps = defaultTrustDeps): boolean {
  const target = `vlad-${taskId}`;
  try {
    deps.tmux(["has-session", "-t", target]);
    if (!trustScreenShown(deps.tmux(["capture-pane", "-p", "-t", target]))) return false;
    deps.tmux(["send-keys", "-t", target, "Enter"]);
    deps.sleepSync(1500);
    return !trustScreenShown(deps.tmux(["capture-pane", "-p", "-t", target]));
  } catch { return false; }
}
