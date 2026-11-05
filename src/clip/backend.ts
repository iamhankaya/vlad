import { assertNative } from "../platform/native.js";
import { darwinHelperArgs } from "./backend-darwin.js";
import { winHelperArgs } from "./backend-win32.js";
import { spawnLineHelper } from "./helper.js";
import type { ClipboardBackend, ClipContent, PersistentHelper, PersistentRunner } from "./types.js";

// Platform panosu: Windows (STA PowerShell) ve macOS (JXA/NSPasteboard) için aynı satır protokolüyle kalıcı yardımcı süreç.
// İstek (tek satır, sekme ayracı, ASCII): `<id>\tcount` | `<id>\tread` | `<id>\twrite\t<text|image>\t<expect>\t<base64>`
// Yanıt (tek satır JSON): {id,ok:true,n,...} (read: n=okumadan önceki sayaç, after=sonraki, text/png base64|null; write: written,n) | {id,ok:false,err}.
// İçerik yalnız stdin'den base64 gider: komut satırına, kabuk dizesine ya da ortam değişkenine asla girmez.
export interface BackendOptions { sleep?(ms: number): Promise<void>; settleMs?: number; timeoutMs?: number }
interface Resp { id: number; ok: boolean; err?: string; n?: number; after?: number; text?: string | null; png?: string | null; written?: boolean }

const SETTLE_TRIES = 3;
const realRunner = (): PersistentRunner => ({
  run: async () => { throw new Error("pano: tek seferlik komut desteklenmiyor"); },
  spawnHelper: (file, args) => spawnLineHelper(file, args),
});

class HelperBackend implements ClipboardBackend {
  private h: PersistentHelper | null = null;
  private id = 0;
  constructor(private start: () => PersistentHelper, private o: BackendOptions) {}

  private async call(fields: (string | number)[], timeoutMs: number): Promise<Resp> {
    const h = (this.h ??= this.start());
    const id = ++this.id;
    let r: Resp;
    try { r = JSON.parse(await h.send([id, ...fields].join("\t"), timeoutMs)) as Resp; } catch (e) {
      if (e instanceof SyntaxError) { await this.reset(); throw new Error("pano yardımcısı geçersiz yanıt verdi"); }
      throw e;
    }
    if (r.id !== id) { await this.reset(); throw new Error(`pano yardımcısı yanıt kimliği uyuşmuyor (beklenen ${id}, gelen ${r.id})`); }
    if (!r.ok) throw new Error(`pano yardımcısı: ${r.err ?? "bilinmeyen hata"}`);
    return r;
  }
  private async reset(): Promise<void> { const h = this.h; this.h = null; await h?.close().catch(() => {}); }
  private t(ms: number): number { return this.o.timeoutMs ?? ms; }

  async changeCount(): Promise<number> { return (await this.call(["count"], this.t(20_000))).n!; }

  async read(): Promise<{ seq: number; content: ClipContent | null }> {
    let r = await this.call(["read"], this.t(20_000));
    if (r.after !== undefined && r.after !== r.n) r = await this.call(["read"], this.t(20_000)); // okuma sırasında değişti: bir kez tekrar
    const content: ClipContent | null = r.text ? { kind: "text", bytes: Buffer.from(r.text, "base64") } // metin+resim birlikteyse yalnız metin
      : r.png ? { kind: "image", bytes: Buffer.from(r.png, "base64") } : null;
    return { seq: r.n!, content };
  }

  async write(c: ClipContent, expectSeq: number): Promise<{ written: boolean; seqAfter: number; reason?: "local_changed" }> {
    const r = await this.call(["write", c.kind, expectSeq, c.bytes.toString("base64")], this.t(60_000));
    if (!r.written) return { written: false, seqAfter: r.n!, reason: "local_changed" };
    // Ayar süresi: Windows gecikmeli panoda sayaç yanıttan sonra da artabilir; durulana dek (en çok 3 kez) oku.
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    let after = r.n!;
    for (let i = 0; i < SETTLE_TRIES; i++) {
      await sleep(this.o.settleMs ?? 150);
      const now = await this.changeCount();
      if (now === after) break;
      after = now;
    }
    return { written: true, seqAfter: after };
  }

  async close(): Promise<void> { await this.reset(); }
}

export function createBackend(os: NodeJS.Platform, run?: PersistentRunner, o: BackendOptions = {}): ClipboardBackend {
  if (os !== "win32" && os !== "darwin") {
    const no = async (): Promise<never> => { throw new Error(`ortak pano ${os} üzerinde desteklenmiyor (yalnız Windows ve macOS)`); };
    return { read: no, write: no, changeCount: no, close: async () => {} };
  }
  const [file, args] = os === "win32" ? ["powershell.exe", winHelperArgs()] as const : ["osascript", darwinHelperArgs()] as const;
  return new HelperBackend(() => {
    if (!run) assertNative("pano yardımcısı"); // yardımcı süreç ilk kullanımda, yalnız native açıkken başlar
    return (run ?? realRunner()).spawnHelper(file, args);
  }, o);
}
