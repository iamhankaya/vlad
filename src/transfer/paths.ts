import { homedir } from "node:os";
import path from "node:path";
import { RemoteError, type Os } from "../machines/types.js";
import { XFER_ID_RE, XFER_STAGING_DIR } from "./types.js";

// Alıcı yol güvenliğinin tek yetkilisi: gönderenin yolu asla güvenilir sayılmaz.
export class XferPathError extends RemoteError {
  constructor(message: string) { super("bad_request", message); this.name = "XferPathError"; }
}
const bad = (why: string) => new XferPathError(`bad_request: yol geçersiz: ${why}`);

const MAX_COMPONENT = 255, MAX_TOTAL = 240, MAX_DEPTH = 32;
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** "/" ayraçlı göreli yolu doğrular, NFC bileşenlere böler. Geçersizse XferPathError. */
export function sanitizeEntryPath(raw: string, os: Os): string[] {
  if (typeof raw !== "string" || raw === "") throw bad("boş yol");
  const parts = raw.normalize("NFC").split("/");
  if (parts.length > MAX_DEPTH) throw bad("derinlik sınırı aşıldı");
  const total = parts.join("/");
  if (total.length > MAX_TOTAL) throw bad("yol çok uzun");
  for (const p of parts) {
    if (p === "") throw bad("boş bileşen veya mutlak yol");
    if (p === "." || p === "..") throw bad("nokta bileşeni");
    if (/[\\:]/.test(p)) throw bad("ters eğik çizgi veya iki nokta");
    if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\ufeff‪-‮⁦-⁩]/.test(p)) throw bad("denetim karakteri");
    if (p.length > MAX_COMPONENT || Buffer.byteLength(p, "utf8") > MAX_COMPONENT) throw bad("bileşen çok uzun");
    if (os === "win32") {
      if (/[<>"|?*]/.test(p)) throw bad("Windows'ta yasak karakter");
      if (/[. ]$/.test(p)) throw bad("sondaki nokta veya boşluk");
      if (WIN_RESERVED.test(p.split(".")[0]!.replace(/ +$/, ""))) throw bad("Windows ayrılmış adı");
    }
  }
  if (parts[0]!.toLowerCase() === XFER_STAGING_DIR) throw bad("ayrılmış ad");
  return parts;
}

export function isXferId(s: unknown): s is string { return typeof s === "string" && XFER_ID_RE.test(s); }

const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** Gövdeyi grafem sınırında kısaltır; ek+uzantı ile toplam bileşen ≤ 255 bayt. */
function fit(base: string, tail: string): string {
  const room = MAX_COMPONENT - bytes(tail);
  if (bytes(base) <= room) return base + tail;
  let out = "";
  for (const { segment } of SEG.segment(base)) { if (bytes(out + segment) > room) break; out += segment; }
  if (!out) throw new RemoteError("failed", "failed: ad çok uzun, benzersiz ad üretilemedi");
  return out + tail;
}

/** "ad (1).ext"; ".env" -> ".env (1)"; "a.tar.gz" -> "a.tar (1).gz". Aday ≤ 255 bayt kalır. Harf duyarsız karşılaştırma çağıranın sorumluluğu (küçük harfli küme verir). */
export async function uniqueName(name: string, exists: (candidate: string) => Promise<boolean>, kind: "file" | "dir" = "file"): Promise<string> {
  if (!(await exists(name))) return name;
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const [base, ext] = dot > 0 && dot < name.length - 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n <= 10_000; n++) {
    const c = fit(base, ` (${n})${ext}`);
    if (!(await exists(c))) return c;
  }
  throw new RemoteError("failed", `failed: boş ad bulunamadı: ${name}`);
}

/** VLAD_DOWNLOADS_DIR > win32 %USERPROFILE%\Downloads > ~/Downloads */
export function downloadsDir(os: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.VLAD_DOWNLOADS_DIR) return env.VLAD_DOWNLOADS_DIR;
  if (os === "win32") return path.win32.join(env.USERPROFILE || homedir(), "Downloads");
  return path.join(env.HOME || homedir(), "Downloads");
}
