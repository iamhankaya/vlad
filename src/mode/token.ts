import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * F-vlad-287: imzalı mod belirteci. Anahtar kb/repo/worktree dışında bir gizli dizindedir; korunan CLI işlemleri
 * (mode night|watch|off, setup, install) ortamdaki `VLAD_MODE_TOKEN`'ı doğrular, mode.json'daki gece penceresi imzalıdır.
 * Karar komut metnine değil anahtara dayanır. Tasarım: docs/superpowers/specs/2026-11-13-vlad-mode-token-design.md
 */
const MAX_TTL = 72 * 3_600_000;
const PREFIX = "VLAD-MODE1|";

export const secretDir = (): string => process.env.VLAD_SECRET_DIR?.trim() || join(homedir(), ".vlad-secret");
const keyFile = (): string => join(secretDir(), "mode.key");

/** Anahtarı üretir (yoksa); dizin 0700, dosya 0600; var olan anahtar ezilmez. true = bu çağrı üretti. */
export function initKey(): boolean {
  const dir = secretDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* shortcut: Windows ACL (icacls) ayrı iş; chmod yok sayılır */ }
  if (existsSync(keyFile())) return false;
  writeFileSync(keyFile(), randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  return true;
}

/** null = mekanizma etkin değil (gizli dizin yok). Dizin var ama anahtar yok/bozuk = fail-closed (throw). */
export function readKey(): string | null {
  if (!existsSync(secretDir())) return null;
  let k: string;
  try { k = readFileSync(keyFile(), "utf8").trim(); } catch { throw new Error("mod anahtarı okunamadı (gizli dizin var, anahtar yok): fail-closed; `vlad mode token` terminalde yeniden üretir"); }
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
/** true = anahtar yok (kontrol yok) ya da imza geçerli; bozuk anahtar fail-closed (false). */
export function nightSigOk(n: SignableNight, sig: unknown): boolean {
  try { const k = readKey(); if (!k) return true; return typeof sig === "string" && same(sig, mac(k, "VLAD-NIGHT1|" + canon(n))); } catch { return false; }
}
