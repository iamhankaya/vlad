import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync, existsSync, readFileSync, statSync, copyFileSync, truncateSync, chmodSync, constants } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../kb/config.js";
import { getVladHome } from "../kb/home.js";
import { defaultExec } from "../launcher/terminal.js";
import { nowMs } from "../fleet/clock.js";
import { RemoteError } from "../fleet/types.js";
import { AgentClient } from "./client.js";
import { Journal } from "./journal.js";
import { winStartCmd } from "./install.js";
import { maint } from "./maintenance.js";
import { gracefulStop, scheduleRestart, winRestartHelper, type RestartDeps } from "./restart.js";
import { WATCHDOG_JS } from "./watchdog.js";
import { spawn } from "node:child_process";
import { agentEnv, setAgentEnv } from "./ops/env.js";
import { reconcileApplyWrite } from "./ops/apply-write.js";
import { execIsWrite } from "./ops/exec.js";
import { flushQueue } from "./ops/forward-write.js";
import { reconcileScriptRun, startupRecover } from "./ops/script.js";
import { buildAktarim } from "./ops/index.js";
import { createProdDeps } from "../transfer/deps.js";
import { startClipSync } from "../clip/index.js";
import { reconcileLaunch } from "./ops/launch.js";
import { reconcileMerge } from "./ops/merge-reconcile.js";
import { reconcileBranchPush } from "./ops/branch-push.js";
import { sweepScriptDir } from "./scripts/run.js";
import { AgentQueue } from "./queue.js";
import { reconcile } from "./reconcile.js";
import { startServer } from "./server.js";
import { addressOf, agentDir, ensurePrivateDir, assertPrivateBind, buildId, localFile, readLocal, roleOf, selfName, writeLocal } from "../fleet/state.js";

const pidFile = () => join(agentDir(), "agent.pid");

/** Yerel Agent canlı mı? İmzalı herhangi bir yanıt (forbidden dahil) = canlı; bağlanamama/imza hatası = değil. */
export async function probeLocal(): Promise<{ alive: boolean; host: string; port: number; machine: string }> {
  const cfg = loadConfig();
  const self = selfName();
  const { host, port } = addressOf(cfg, self, self);
  const client = new AgentClient({ self, keys: readLocal().keys, config: () => cfg, defaultTimeoutMs: 3000 });
  try { await client.call(self, "ping", {}); return { alive: true, host, port, machine: self }; } catch (e) {
    return { alive: e instanceof RemoteError && ["forbidden", "proto_mismatch", "clock_skew"].includes(e.code), host, port, machine: self };
  }
}

/** agent.log `max` baytı aşarsa `.1`e kopyalanıp kesilir (yeniden adlandırma değil: süreç dosyayı açık tutar). shortcut: tek yedek, çok eski günlük kaybolur. */
export function rotateLog(file: string, max = 1_000_000): void {
  try {
    if (statSync(file).size <= max) return;
    rmSync(`${file}.1`, { force: true }); // symlink'i izleme: bağlantının kendisi silinir
    copyFileSync(file, `${file}.1`, constants.COPYFILE_EXCL);
    chmodSync(`${file}.1`, 0o600);
    truncateSync(file, 0);
  } catch { /* günlük yoksa ya da kilitliyse sessiz geç */ }
}

/** Adres başkasında mı? Journal/kuyruğa dokunmadan ÖNCE sorulur: canlı Agent'ın uçuştaki işlemlerini ikinci süreç bozmasın. */
function portTaken(host: string, port: number): Promise<boolean> {
  if (port === 0) return Promise.resolve(false);
  return new Promise((res) => {
    const s = createServer();
    s.once("error", (e) => res((e as NodeJS.ErrnoException).code === "EADDRINUSE"));
    s.listen({ host, port, exclusive: true }, () => s.close(() => res(false)));
  });
}

/** Adres doluysa: VLAD Agent canlıysa "zaten çalışıyor" yazar, değilse hata. */
async function reportTaken(bind: string, port: number): Promise<void> {
  const p = await probeLocal();
  if (!p.alive) throw new Error(`agent: ${bind}:${port} başka bir süreç tarafından kullanılıyor (VLAD Agent yanıt vermiyor)`);
  process.stdout.write(`VLAD Agent zaten çalışıyor (${p.host}:${p.port})
`);
}

/** `vlad agent start`: tek örnek; sürecin ömrü boyunca dinler. */
export async function agentStart(o: { port?: number; printPort?: boolean }): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.machines || !cfg.brain) throw new Error("agent: config'te machines tanımlı değil");
  const self = selfName();
  const def = cfg.machines.find((m) => m.name === self);
  if (!def) throw new Error(`agent: ${self} machines içinde değil (konsol kimlikleri Agent çalıştırmaz)`);
  const keys = readLocal().keys;
  if (!keys[self]) throw new Error(`agent: ${self} için anahtar yok (vlad agent keygen ${self})`);
  const kind = self === cfg.brain ? "brain-agent" : "worker-agent";
  const bind = def.agent.bind ?? def.agent.host ?? "127.0.0.1";
  const bindIp = await assertPrivateBind(bind); // doğrulanan IP ile dinle (yeniden çözümleme yok)
  const port = o.port ?? def.agent.port;

  if (await portTaken(bindIp, port)) return reportTaken(bind, port);

  const test = process.env.VLAD_AGENT_TEST === "1";
  const dir = agentDir();
  ensurePrivateDir(dir);
  rotateLog(join(dir, "agent.log"));
  const journal = new Journal(join(dir, "journal.jsonl"), nowMs);
  const queue = kind === "worker-agent" ? new AgentQueue(join(dir, "queue"), nowMs) : undefined;
  const build = buildId();
  setAgentEnv({ self, kind, cfg, startedAt: nowMs(), build, journal, queue, now: nowMs, transport: new AgentClient({ self, keys, config: () => loadConfig() }) });
  reconcile(journal, { "apply-write": reconcileApplyWrite, launch: reconcileLaunch, merge: reconcileMerge, "branch-push": reconcileBranchPush, "script-run": reconcileScriptRun }); // merge uzlaştırıcısı işçi bağlamını (ortam) ister, bu yüzden setAgentEnv'den sonra

  startupRecover(getVladHome()); // F-vlad-274: önceki süreç selfUpdate ortasında öldüyse yarım node_modules/dist geri alınır, bitene dek bakım (op kabul yok)
  sweepScriptDir(join(dir, "scripts-run")); // çökmüş çalışmadan kalan geçici betikler

  const deps = createProdDeps();
  const aktarim = buildAktarim(deps);
  await aktarim.sweep().catch((e) => process.stderr.write(`aktarım süpürme atlandı: ${(e as Error).message}\n`));

  let srv;
  try {
    srv = await startServer({
      self, kind, cfg: () => loadConfig(), keys, ops: aktarim.ops, journal, build, bind: bindIp, port,
      journaled: (op, args) => (op === "exec" ? execIsWrite(args) : undefined),
      ...(test ? { crashAt: process.env.VLAD_TEST_CRASH_AT, readTimeoutMs: Number(process.env.VLAD_AGENT_READ_TIMEOUT_MS) || undefined } : {}),
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    const p = await probeLocal();
    if (!p.alive) throw new Error(`agent: ${bind}:${port} başka bir süreç tarafından kullanılıyor (VLAD Agent yanıt vermiyor)`);
    process.stdout.write(`VLAD Agent zaten çalışıyor (${p.host}:${p.port})\n`);
    return;
  }
  writeFileSync(pidFile(), String(process.pid));
  const clip = startClipSync(deps);
  try { agentEnv().runningBuildHead = readFileSync(join(getVladHome(), "dist", ".build-head"), "utf8").trim() || undefined; } catch { /* damga yok: bilinmiyor */ }
  // takılan clip/aktarım kapanışı bakım bayrağını sonsuza açık tutmasın: 10 sn sonra yine çıkılır
  const stop = () => gracefulStop({
    close: async () => { await Promise.allSettled([clip.stop(), aktarim.close()]); await srv.close(); },
    cleanup: () => rmSync(pidFile(), { force: true }), exit: (c) => process.exit(c), timeoutMs: 10_000,
  });
  // selfUpdate başarısında yeniden başlatma (spec S23/S24): Mac'te çıkış (launchd KeepAlive), Windows'ta WMI yardımcısı agent-start.cmd'yi açar
  const wdHost = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const restartDeps: RestartDeps = {
    platform: process.platform, delayMs: 2000, pollMs: 250, maxWaitMs: 5 * 60_000, inflight: () => maint.inflight(), stop,
    helper: async () => {
      if (process.platform !== "win32") {
        // Mac: yalnız launchd KeepAlive geri getirir; elle başlatılmış Agent çıkarsa kimse başlatmaz
        const plist = join(homedir(), "Library", "LaunchAgents", "com.vlad.agent.plist");
        if (process.platform === "darwin" && !existsSync(plist)) throw new Error(`${plist} yok (launchd kurulu değil); Agent'ı elle yeniden başlat`);
        // sağlık bekçisi: yeni dist dinlemezse dist/node_modules yedekten geri yüklenir ve launchd yeniden tetiklenir
        const kick = process.platform === "darwin" && process.getuid ? JSON.stringify(["launchctl", "kickstart", "-k", `gui/${process.getuid()}/com.vlad.agent`]) : "";
        spawn(process.execPath, ["-e", WATCHDOG_JS], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "", WD_HOST: wdHost, WD_PORT: String(port), WD_REPO: getVladHome(), WD_PID: String(process.pid), ...(kick ? { WD_KICK: kick } : {}) } }).unref();
        return;
      }
      const startCmd = winStartCmd(getVladHome());
      if (!existsSync(startCmd)) throw new Error(`${startCmd} yok (vlad agent install --apply ile kurulmamış); Agent'ı elle yeniden başlat`);
      const h = winRestartHelper({ pidFile: pidFile(), startCmd, systemRoot: process.env.SystemRoot, watch: { host: wdHost, port, repo: getVladHome() } });
      await defaultExec(h.file, h.args);
    },
    onFail: (m) => { maint.leave(); process.stderr.write(`yeniden başlatma yapılamadı, Agent eski süreçle sürüyor: ${m}\n`); },
  };
  agentEnv().requestRestart = () => scheduleRestart(restartDeps);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (queue) {
    const every = (test && Number(process.env.VLAD_AGENT_FLUSH_MS)) || 10_000;
    const tick = () => { if (!queue.isEmpty()) flushQueue().catch(() => { /* bir sonraki turda */ }); };
    setInterval(tick, every).unref();
    tick();
  }
  process.stdout.write((o.printPort ? JSON.stringify({ listening: { host: srv.host, port: srv.port } }) : `VLAD Agent dinliyor: ${srv.host}:${srv.port} (${self}, ${kind})`) + "\n");
}

export async function agentStatus(): Promise<{ running: boolean; machine: string; host: string; port: number; pid: number | null }> {
  const p = await probeLocal();
  const pid = existsSync(pidFile()) ? Number(readFileSync(pidFile(), "utf8")) || null : null;
  return { running: p.alive, machine: p.machine, host: p.host, port: p.port, pid };
}

export interface KeygenResult {
  /** anahtarın tutulduğu ad: karşı taraf (çift anahtar) ya da kendi adın (yerel çağrı anahtarı) */
  identity: string;
  /** yalnız `show` ile döner: varsayılan çıktı anahtarı basmaz (F-vlad-132) */
  key?: string;
  file: string;
  /** karşı uca elle uygulanacak komut (yalnız çift anahtarda); anahtar stdin'den verilir, argv'de değil (F-vlad-132) */
  copy?: string;
}

/**
 * Anahtar üretir ve yerel dosyaya yazar (varsa değiştirir = döndürme). Çift anahtar (D-vlad-057): `keygen <karşı-taraf>` bu makine ile
 * karşı taraf arasında YALNIZ o ikisinin bildiği bir anahtardır; `keys.<karşı-taraf>` olarak tutulur. Karşı uçta aynı değer
 * `keys.<bu-makine>` olmalı: `copy` o ucun çalıştıracağı komutu verir. `keygen <kendi-adın>` yerel çağrı anahtarıdır, kopyalanmaz.
 */
export function agentKeygen(identity: string, show = false): KeygenResult {
  const cfg = loadConfig();
  if (cfg.machines && !roleOf(cfg, identity)) throw new Error(`agent keygen: kimlik config'te tanımlı değil: ${identity}`);
  const key = randomBytes(32).toString("hex");
  const self = selfName();
  const local = readLocal();
  writeLocal({ ...local, keys: { ...local.keys, [identity]: key } });
  return { identity, ...(show ? { key } : {}), file: localFile(), ...(identity !== self ? { copy: `vlad agent setkey ${self} -` } : {}) };
}

/** Karşı uçta üretilmiş çift anahtarı bu makineye yazar: `keys.<karşı-taraf>`. */
export function agentSetKey(peer: string, key: string): { peer: string; file: string } {
  const cfg = loadConfig();
  if (cfg.machines && !roleOf(cfg, peer)) throw new Error(`agent setkey: kimlik config'te tanımlı değil: ${peer}`);
  if (peer === selfName()) throw new Error("agent setkey: kendi adın için çift anahtar olmaz (keygen <kendi-adın>)");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("agent setkey: anahtar 64 hex olmalı");
  const local = readLocal();
  writeLocal({ ...local, keys: { ...local.keys, [peer]: key } });
  return { peer, file: localFile() };
}
