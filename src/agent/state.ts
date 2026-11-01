import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { dirname, join } from "node:path";
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
export function writeLocal(s: LocalSettings): void {
  const f = localFile();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* Windows: kullanıcıya özel dizinde ACL */ }
}

/** Bu makinenin kimliği: VLAD_MACHINE > vlad.local.json self. */
export function selfName(): string {
  const s = process.env.VLAD_MACHINE || readLocal().self;
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
