import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { getVladHome } from "../kb/home.js";
import type { VladConfig } from "../kb/types.js";
import { RemoteError, type IdentityRole, type LocalSettings } from "../machines/types.js";

/** Agent'ın yerel durum dizini: <VLAD_HOME>/.vlad-agent (günlük, kuyruk, pid; .gitignore'da). */
export const agentDir = (): string => join(getVladHome(), ".vlad-agent");

export const localFile = (): string => process.env.VLAD_LOCAL_FILE || join(getVladHome(), "vlad.local.json");

export function readLocal(): LocalSettings {
  const f = localFile();
  if (!existsSync(f)) return { keys: {} };
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Partial<LocalSettings>;
    return { ...(j.self ? { self: j.self } : {}), keys: j.keys ?? {} };
  } catch (e) {
    throw new Error(`yerel ayar okunamadı (${f}): ${(e as Error).message}`);
  }
}
export function writeLocal(s: LocalSettings, o: { lock?: (f: string) => void } = {}): void {
  const f = localFile();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  // önce boş geçici dosya kilitlenir, anahtar kilitli dosyaya yazılır, sonra rename: okuyucu boş/yarım dosya görmez, çökme anahtarları silmez (F-vlad-151)
  const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`; // eşzamanlı yazanlar aynı geçici dosyayı paylaşmaz
  try {
    writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
    (o.lock ?? lockDownFile)(tmp);
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, f);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Durum dizini yalnız sahibine açık: yeni dizinler 0700, var olanın modu da çekilir (Windows'ta chmod etkisiz, yok sayılır). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* shortcut: chmod başarısız, dizin yine oluştu; Windows ACL'i dosya düzeyinde (lockDownFile) */ }
}

/**
 * Anahtar dosyası yalnız sahibine açık: POSIX'te 0600, Windows'ta icacls ile miras kesilir ve yalnız geçerli kullanıcıya (SID ile) tam yetki
 * verilir. Araçlar PATH'ten değil `%SystemRoot%\System32`'den çağrılır. Kilitlenemezse yazma düşmez ama uyarı stderr'e basılır (F-vlad-151).
 */
export function lockDownFile(f: string, o: { platform?: NodeJS.Platform; systemRoot?: string; exec?: (file: string, args: string[]) => string | void; warn?: (m: string) => void } = {}): void {
  try {
    if ((o.platform ?? process.platform) !== "win32") { chmodSync(f, 0o600); return; }
    const sys32 = win32.join(o.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows", "System32");
    const run = o.exec ?? ((file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    const csv = String(run(win32.join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]) ?? "").trim();
    const sid = /^"(?:[^"]*)","(S-1-\d+(?:-\d+)+)"$/.exec(csv.split(/\r?\n/)[0] ?? "")?.[1]; // SID yalnız 2. alan ve tam eşleşme (ad alanına düşülmez)
    if (!sid) throw new Error("kullanıcı SID'i alınamadı");
    run(win32.join(sys32, "icacls.exe"), [f, "/inheritance:r", "/grant:r", `*${sid}:F`]);
  } catch (e) {
    (o.warn ?? ((m) => process.stderr.write(m + "\n")))(`uyarı: ${f} erişim izni kısıtlanamadı (${(e as Error).message}); anahtar dosyası başka yerel kullanıcılara açık olabilir, ACL'i elle sıkılaştır`);
  }
}

/** Bu makinenin kimliği: VLAD_MACHINE > vlad.local.json self. */
export function selfName(): string {
  const s = process.env.VLAD_MACHINE || readLocal().self; // tek kimlik çözümleyici: registry.resolveSelf de bunu çağırır
  if (!s) throw new Error("bu makinenin kimliği belirsiz: VLAD_MACHINE ya da vlad.local.json self");
  return s;
}

export function roleOf(cfg: VladConfig, name: string): IdentityRole | null {
  if (cfg.brain === name) return "brain";
  if (cfg.machines?.some((m) => m.name === name)) return "worker";
  if (cfg.consoles?.some((c) => c.name === name)) return "console";
  return null;
}

/** Hedef makinenin Agent adresi (config'ten her çağrıda okunur). Kendi adresi için `bind` öncelikli. */
export function addressOf(cfg: VladConfig, name: string, self?: string): { host: string; port: number } {
  const m = cfg.machines?.find((x) => x.name === name);
  if (!m) throw new RemoteError("not_found", `makine config'te tanımlı değil: ${name}`, name);
  const host = name === self ? m.agent.bind ?? m.agent.host : m.agent.host ?? m.agent.bind;
  return { host: host ?? "127.0.0.1", port: m.agent.port };
}

export function buildId(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0");
  } catch { return "0"; }
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];
/** Agent yalnız loopback / RFC1918 / link-local adrese bağlanır (0.0.0.0, ::, genel adres ve çözümlenemeyen ad reddedilir). */
export async function assertPrivateBind(addr: string): Promise<string> {
  let ip = addr;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    try { ip = (await lookup(addr, { family: 4 })).address; } catch { throw new Error(`agent: genel adrese bağlanılamaz: ${addr}`); }
  }
  if (!PRIVATE_V4.some((r) => r.test(ip))) throw new Error(`agent: genel adrese bağlanılamaz: ${addr}`);
  return ip;
}
