import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { Command } from "commander";
import type { Kit } from "../kit.js";
import { SilentExit, type Opts } from "../ctx.js";
import { assertNotWorker } from "../../mode/guard.js";
import { requireTtyOrApprovedOp } from "../../mode/token.js";
import { defaultMemwatchStatePath, memwatchBinaryFor, readMemoryState, summarize } from "../../memwatch/gate.js";
import type { MemwatchInstaller } from "../../memwatch/launchd.js";

/**
 * Bellek bekçisi CLI'ı (T20261128-06). `top`: Rust ikilisini (`dist/bin/memwatch`, `npm run build:native -- memwatch`) aynı
 * terminalde çalıştırır. `memwatch install|uninstall`: launchd `com.vlad.memwatch` (TTY + mod yetkisi; `monitor install` deseni);
 * `memwatch status`: salt okuma. Test enjeksiyonu yalnız `registerMemwatch(…, deps)` ile.
 */
export interface MemwatchCliDeps {
  binary?: string;
  spawn?: (bin: string, args: string[]) => number;
  installer?: MemwatchInstaller;
  platform?: NodeJS.Platform;
  isTTY?: () => boolean;
  statePath?: string;
}

const realSpawn = (bin: string, args: string[]): number => {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.error) throw new Error(`memwatch çalıştırılamadı: ${r.error.message}`);
  return r.status ?? (r.signal === "SIGINT" ? 0 : 1); // Ctrl-C ile çıkış normaldir
};

const mib = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MiB`;

export function registerMemwatch(program: Command, k: Kit, deps: MemwatchCliDeps = {}): void {
  const { def, out, ctx } = k;
  const binary = (): string => deps.binary ?? memwatchBinaryFor(ctx.cliPath);
  const requireBinary = (): string => {
    const b = binary();
    if (!existsSync(b)) throw new Error(`memwatch ikilisi yok: ${b} (derlemek için: npm run build:native -- memwatch)`);
    return b;
  };
  const platform = (): NodeJS.Platform => deps.platform ?? process.platform;
  const installer = async (): Promise<MemwatchInstaller> => deps.installer ?? (await import("../../memwatch/launchd.js")).createMemwatchInstaller();
  const guardPrivileged = (what: string): void => {
    assertNotWorker();
    if (platform() !== "darwin") throw new Error(`memwatch ${what} yalnız macOS'ta çalışır`);
    const tty = (deps.isTTY ?? (() => process.stdin.isTTY === true))();
    try { requireTtyOrApprovedOp(tty); } catch (e) {
      throw new Error((e as Error).message.startsWith("yalnız etkileşimli") ? `memwatch ${what} ${(e as Error).message}` : (e as Error).message);
    }
  };

  def(program, "top", "Canlı bellek tablosu: vlad-<görev> tmux ağaçlarının footprint'i, VM, Terminal, sistem baskısı/swap (memwatch)", (o: Opts) => {
    const args = ["top", ...(o.json ? ["--json"] : []), ...(o.once ? ["--once"] : []), ...(o.interval !== undefined ? ["--interval", String(o.interval)] : [])];
    const code = (deps.spawn ?? realSpawn)(requireBinary(), args);
    if (code !== 0) throw new SilentExit(code);
  }).option("--once", "tabloyu bir kez bas ve çık").option("--interval <sn>", "yenileme aralığı (varsayılan 2)");

  const mw = program.command("memwatch").description("Bellek bekçisi daemon'u (launchd com.vlad.memwatch; yalnız macOS)");

  def(mw, "install", "memwatch daemon'unu launchd'ye kurar (terminalde, mod yetkisiyle)", async (o: Opts) => {
    guardPrivileged("install");
    let b = requireBinary();
    try { b = realpathSync(b); } catch { /* olduğu gibi */ }
    const steps = await (await installer()).install({ binary: b, path: process.env.PATH ?? "" });
    out(o, { installed: true, steps }, ["memwatch servisi kuruldu:", ...steps.map((s) => `  ${s}`)].join("\n"));
  });
  def(mw, "uninstall", "memwatch daemon'unu launchd'den kaldırır (terminalde, mod yetkisiyle)", async (o: Opts) => {
    guardPrivileged("uninstall");
    const steps = await (await installer()).uninstall();
    out(o, { uninstalled: true, steps }, ["memwatch servisi kaldırıldı:", ...steps.map((s) => `  ${s}`)].join("\n"));
  });
  def(mw, "status", "Servis durumu ve daemon'un son örneği (salt okuma)", async (o: Opts) => {
    let service: Awaited<ReturnType<MemwatchInstaller["status"]>> | null = null;
    try { service = platform() === "darwin" ? await (await installer()).status() : null; } catch { service = null; }
    const st = readMemoryState(deps.statePath ?? defaultMemwatchStatePath());
    const state = st
      ? { fresh: true, updated: st.updated, level: st.last.level, summary: summarize(st.last), rss_bytes: st.rss_bytes, pid: st.pid }
      : { fresh: false };
    const lines = [
      `servis: ${service ? (service.installed ? service.detail : "kurulu değil") : "bilinmiyor"}`,
      st ? `son örnek: ${summarize(st.last)} (daemon RSS ${mib(st.rss_bytes)}, pid ${st.pid})` : "son örnek: durum dosyası yok ya da bayat (daemon çalışmıyor olabilir)",
    ];
    out(o, { service, state }, lines.join("\n"));
  });
}
