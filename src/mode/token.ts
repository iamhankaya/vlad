import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * F-vlad-287: imzalı mod belirteci. Anahtar kb/repo/worktree dışında bir gizli dizindedir; korunan CLI işlemleri
 * (mode night|watch|off, setup, install) ortamdaki `VLAD_MODE_TOKEN`'ı doğrular, mode.json'daki gece penceresi imzalıdır.
 * Karar komut metnine değil anahtara dayanır. Tasarım: docs/superpowers/specs/2026-11-13-vlad-mode-token-design.md
 */
const MAX_TTL = 72 * 3_600_000;
const PREFIX = "VLAD-MODE1|";

// Ortam değişkeniyle değiştirilemez (çalışan `VLAD_SECRET_DIR=/yok` ile mekanizmayı kapatırdı); HOME da kullanılmaz, passwd kaydındaki ev dizini.
let testDir: string | null = null;
/** Yalnız süreç içi testler için (çalışan başka sürece bu yolla dokunamaz). */
export const setSecretDirForTests = (d: string | null): void => { testDir = d; };
export const secretDir = (): string => testDir ?? join(userInfo().homedir, ".vlad-secret");
const keyFile = (): string => join(secretDir(), "mode.key");
/** F-vlad-336: etkinleştirme işareti anahtar dizininin DIŞINDA (kardeş dosya `<gizli-dizin>.active`). Dizin silinse bile işaret kalır = düşürme tespit edilir. */
const markerFile = (): string => `${secretDir()}.active`;

/** Anahtarı üretir (yoksa); dizin 0700, dosya 0600; var olan anahtar ezilmez. `reset`: bozuk/kayıp anahtarı yeniden üretir (eski belirteçler ve imzalı pencere geçersiz olur). true = bu çağrı üretti. */
export function initKey(reset = false): boolean {
  const dir = secretDir();
  if (!reset && !existsSync(dir) && existsSync(markerFile())) throw new Error(DROPPED);
  writeFileSync(markerFile(), "VLAD-MODE-ACTIVE1\n", { mode: 0o600 }); // önce işaret: yarıda kalırsa fail-closed (düşmüş sayılır), `--reset` toparlar
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* shortcut: Windows ACL (icacls) ayrı iş; chmod yok sayılır */ }
  if (existsSync(keyFile())) { if (!reset) return false; rmSync(keyFile(), { force: true }); }
  writeFileSync(keyFile(), randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  return true;
}

const DROPPED = "mod belirteci düşürülmüş: etkinleştirme işareti var ama gizli dizin/anahtar yok (silinmiş olabilir): fail-closed; kasıtlıysa terminalde `vlad mode token --reset` (SIFIRLA onayı) ya da `--disable`";

/** off = hiç etkinleştirilmedi; ok = anahtar okunabilir; dropped = işaret var, gizli dizin yok; broken = dizin var ama anahtar sorunlu. Asla fırlatmaz. */
export function keyState(): "off" | "ok" | "dropped" | "broken" {
  try { return readKey() === null ? "off" : "ok"; } catch (e) { return (e as Error).message === DROPPED ? "dropped" : "broken"; }
}

/** `--disable`: mekanizmayı tamamen kapatır (gizli dizin + işaret). Yetki çağıran CLI'da `authorizeReset` ile alınır. */
export function disableKey(): void {
  rmSync(secretDir(), { recursive: true, force: true });
  rmSync(markerFile(), { force: true });
}

/** null = mekanizma etkin değil: gizli dizin yok (ENOENT) VE etkinleştirme işareti yok. Başka her hata (EACCES, EMFILE, sembolik bağ, geniş izin), dizin var ama anahtar yok/bozuk = fail-closed (throw). */
export function readKey(): string | null {
  let st;
  try { st = lstatSync(secretDir()); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") { if (existsSync(markerFile())) throw new Error(DROPPED); return null; }
    throw new Error(`gizli dizin denetlenemedi (${code ?? "hata"}): fail-closed; \`vlad mode token --reset\` terminalde onayla`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("gizli dizin sembolik bağ ya da dizin değil: fail-closed");
  // POSIX izin denetimi: fail-closed seçildi (uyarı değil); grup/diğer biti açık dizin ya da anahtar güvenilmez. Windows'ta ACL ayrı iş.
  if (process.platform !== "win32" && (st.mode & 0o077)) throw new Error("gizli dizin izinleri fazla geniş (0700 olmalı): fail-closed");
  let k: string;
  try { const ks = lstatSync(keyFile()); if (process.platform !== "win32" && (ks.mode & 0o077)) throw new Error("mod anahtarı izinleri fazla geniş (0600 olmalı): fail-closed"); } catch (e) { if ((e as Error).message.includes("fazla geniş")) throw e; /* yok: aşağıda okunamadı */ }
  try { k = readFileSync(keyFile(), "utf8").trim(); } catch { throw new Error("mod anahtarı okunamadı (gizli dizin var, anahtar yok): fail-closed; `vlad mode token --reset` terminalde yeniden üretir"); }
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error("mod anahtarı bozuk: fail-closed");
  return k;
}

const mac = (key: string, s: string): string => createHmac("sha256", Buffer.from(key, "hex")).update(s, "utf8").digest("hex");
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function mintToken(ttlMs: number, now: Date = new Date()): string {
  if (ttlMs > MAX_TTL) throw new Error("belirteç ömrü en çok 72 saat");
  if (!(ttlMs > 0)) throw new Error("belirteç ömrü pozitif olmalı");
  const key = readKey();
  if (!key) throw new Error("gizli dizin yok; önce anahtarı üret (initKey)");
  const exp = String(now.getTime() + ttlMs);
  return `VMT1.${exp}.${mac(key, PREFIX + exp)}`;
}

/** Belirteç biçimi + imza (süre ayrı denetlenir: requireModeAuthority). */
function parse(token: string): { exp: number; ok: boolean } | null {
  const m = /^VMT1\.(\d{1,15})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const key = readKey();
  return key ? { exp: Number(m[1]), ok: same(m[2]!, mac(key, PREFIX + m[1]!)) } : null;
}
export const verifyToken = (token: string, now: Date): boolean => { try { const p = parse(token); return !!p && p.ok && p.exp > now.getTime(); } catch { return false; } };

/** Korunan işlem kapısı. Mekanizma etkin değilse (gizli dizin yok) geçer; etkinse geçerli VLAD_MODE_TOKEN şart. */
export function requireModeAuthority(env: Record<string, string | undefined> = process.env, now: Date = new Date()): void {
  if (readKey() === null) return;
  const t = env.VLAD_MODE_TOKEN?.trim();
  const how = "korunan işlem için geçerli VLAD_MODE_TOKEN gerekli (VLAD oturumunu `export VLAD_MODE_TOKEN=$(vlad mode token)` ile terminalde başlat; çalışan oturumu bunu alamaz)";
  if (!t) throw new Error(how);
  const p = parse(t);
  if (!p || !p.ok) throw new Error(`VLAD_MODE_TOKEN geçersiz: ${how}`);
  if (p.exp <= now.getTime()) throw new Error(`VLAD_MODE_TOKEN süresi doldu: ${how}`);
}

/** Gece penceresi imzası: alan sırası sabit (kanonik), `sig` hariç. */
export interface SignableNight { until: string; started: string; projects: string[]; note: string | null; push: boolean; except: string[]; untilTasks: string[] }
const canon = (n: SignableNight): string => JSON.stringify([n.until, n.started, n.projects, n.note, n.push, n.except, n.untilTasks]);
/** Anahtar yoksa null (imzasız mod: eski davranış). */
export function signNight(n: SignableNight): string | null { const k = readKey(); return k ? mac(k, "VLAD-NIGHT1|" + canon(n)) : null; }
/** true = anahtar yok ve pencere imzasız (eski davranış) ya da imza geçerli. Bozuk anahtar ve "imzalı pencere var ama anahtar kayıp" (gizli dizin silindi) fail-closed (false). */
export function nightSigOk(n: SignableNight, sig: unknown): boolean {
  try { const k = readKey(); if (!k) return sig === undefined; return typeof sig === "string" && same(sig, mac(k, "VLAD-NIGHT1|" + canon(n))); } catch { return false; }
}

/**
 * `mode token --reset` yetkisi (anahtarı yeniden üretmek eski belirteçleri ve imzalı pencereyi geçersiz kılar):
 * gizli dizin yoksa gerekmez (ilk kurulum); geçerli anahtar varken geçerli VLAD_MODE_TOKEN şart; anahtar bozuk/okunamaz/izni geniş
 * ise belirteç doğrulanamayacağından yalnız elle yazılan `SIFIRLA` onayı kabul edilir.
 */
export async function authorizeReset(env: Record<string, string | undefined>, now: Date, ask: (prompt: string) => Promise<string>): Promise<void> {
  let broken = false;
  try { if (readKey() === null) return; } catch { broken = true; }
  if (!broken) { requireModeAuthority(env, now); return; }
  const ans = (await ask("Mod anahtarı bozuk/okunamıyor; sıfırlamak eski belirteçleri ve imzalı gece penceresini geçersiz kılar. Onay için SIFIRLA yazın: ")).trim();
  if (ans !== "SIFIRLA") throw new Error("sıfırlama onaylanmadı (SIFIRLA yazılmadı)");
}
