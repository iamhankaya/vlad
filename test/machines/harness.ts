import { isolatedEnv } from "../isolate-env.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Çoklu makine testlerinin ortak yardımcıları (sözleşme fazı S; sonra yalnız fonksiyon ekleme).
// Hiçbiri process.env'e dokunmaz: her "makine" kendi home'u, kb'si ve env'i ile bir `Side`'dır.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
export const CLI = join(root, "dist", "cli.js");
export const RECORD_CLI = join(here, "fixtures", "record-cli.mjs");

export interface Side {
  name: string;
  home: string;
  kb: string;
  local: string; // vlad.local.json yolu (VLAD_LOCAL_FILE)
  env: Record<string, string>;
}
export interface HomePair {
  brain: Side;
  worker: Side;
  /**
   * Çift anahtarlar (D-vlad-057): `keys[brain]` = beynin kendi anahtarı, `keys[worker]` = beyin↔işçi çifti,
   * `keys[konsol]` = beyin↔konsol çifti. Beyin hepsini tutar; işçi/konsol yalnız beyinle paylaştığı anahtarı (beyin adıyla) bilir.
   */
  keys: Record<string, string>;
  /** İşçinin kendi (yerel çağrı) anahtarı; çiftlerden ayrı. */
  workerSelfKey: string;
  /** Konsol kimliği için ayrı yerel ayar dosyası (yalnız beyinle paylaştığı anahtar) döndürür; env olarak VLAD_LOCAL_FILE verilir. */
  consoleLocal(name: string): string;
  /** İki home'u ve geçici dizini siler. */
  cleanup(): void;
}

const SUBDIRS = ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal"];

function makeSide(base: string, name: string, self: string, keys: Record<string, string>, config?: object): Side {
  const home = join(base, name);
  for (const d of SUBDIRS) mkdirSync(join(home, "kb", d), { recursive: true });
  cpSync(resolve(root, "schemas"), join(home, "schemas"), { recursive: true });
  if (config) writeFileSync(join(home, "vlad.config.json"), JSON.stringify(config));
  const local = join(home, "vlad.local.json");
  writeFileSync(local, JSON.stringify({ self, keys }));
  const env = {
    VLAD_HOME: home, VLAD_LOCAL_FILE: local, VLAD_MACHINE: self,
    VLAD_CLAUDE_JSON: join(home, "claude.json"), // her home'un kendi dosyası; ortak test dosyasını paylaşmaz
    VLAD_LAUNCHER: "noop", VLAD_NOOP_LOG: join(home, "noop.jsonl"), CLAUDE_CODE_REMOTE: "",
  };
  return { name, home, kb: join(home, "kb"), local, env };
}

/**
 * İki bağımsız VLAD home'u (beyin + işçi). `config` iki home'a da aynen yazılır. Beyin tüm anahtarları, işçi yalnız
 * yalnız beyinle paylaştığı çift anahtarı ve kendi anahtarını tutar. Yalnız yol/dosya üretir; hiçbir süreç başlatmaz.
 */
export function makeHomePair(o: { config?: object; brain?: string; worker?: string; consoles?: string[] } = {}): HomePair {
  const base = mkdtempSync(join(tmpdir(), "vlad-mp-"));
  const [bn, wn] = [o.brain ?? "mac", o.worker ?? "windows"];
  const keys: Record<string, string> = {};
  for (const n of [bn, wn, ...(o.consoles ?? [])]) keys[n] = randomBytes(32).toString("hex");
  const brain = makeSide(base, "brain", bn, keys, o.config);
  const workerSelfKey = randomBytes(32).toString("hex");
  const worker = makeSide(base, "worker", wn, { [wn]: workerSelfKey, [bn]: keys[wn] }, o.config);
  return {
    brain, worker, keys, workerSelfKey,
    cleanup: () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* OS temizler */ } },
    consoleLocal(name) {
      const f = join(base, `console-${name}.json`);
      writeFileSync(f, JSON.stringify({ self: name, keys: { [bn]: keys[name] } }));
      return f;
    },
  };
}

export interface SpawnResult { code: number | null; out: string; err: string }
export function spawnVlad(side: Side, argv: string[], o: { stdin?: string; env?: Record<string, string> } = {}): SpawnResult {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", input: o.stdin, env: { ...isolatedEnv(), ...side.env, ...o.env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export interface RunningAgent { port: number; host: string; proc: ChildProcess; stop(): Promise<void> }
/** Gerçek alt süreç: `vlad agent start --port 0 --print-port`; ilk stdout satırı `{"listening":{"host","port"}}` (B gerçekler). */
export async function startAgent(side: Side, o: { nowFile?: string; test?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunningAgent> {
  const env = { ...isolatedEnv(), ...side.env, ...(o.nowFile ? { VLAD_NOW_FILE: o.nowFile } : {}), ...(o.test ? { VLAD_AGENT_TEST: "1", ...o.test } : {}) };
  const proc = spawn(process.execPath, [CLI, "agent", "start", "--port", "0", "--print-port"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let errBuf = "";
  proc.stderr!.on("data", (d: Buffer) => { if (errBuf.length < 4000) errBuf += d; }); // dolu boru Agent'ı asmasın; hata mesajı için ilk 4 KB tutulur
  const first = await new Promise<{ host: string; port: number }>((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error("agent başlamadı: ilk satır gelmedi")), o.timeoutMs ?? 10_000);
    proc.stdout!.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf(String.fromCharCode(10));
      if (nl < 0) return;
      clearTimeout(t);
      try { res(JSON.parse(buf.slice(0, nl)).listening); } catch (e) { rej(e as Error); }
    });
    proc.on("exit", (c) => { clearTimeout(t); rej(new Error(`agent çıktı (${c}) başlamadan: ${errBuf}`)); });
  });
  return {
    ...first, proc,
    stop: () => new Promise<void>((res) => { if (proc.exitCode !== null) return res(); proc.once("exit", () => res()); proc.kill(); }),
  };
}

export interface Proxy {
  port: number;
  /** kabul edilen bağlantı sayısı */
  count: number;
  down(): void;
  up(): void;
  /** n. bağlantının (1 tabanlı, sayacın o anki değerinden sonrası) yanıtını istemciye ulaştırma, bağlantıyı kes. */
  dropResponse(n: number): void;
  delayMs: number;
  stop(): Promise<void>;
}
/** Test aracı TCP vekili: bağlantı sayar, kapatılabilir, yanıt düşürür, gecikme ekler. */
export async function startProxy(target: { host?: string; port: number }): Promise<Proxy> {
  let isDown = false;
  const drops = new Set<number>();
  const socks = new Set<net.Socket>();
  const p: Proxy = {
    port: 0, count: 0, delayMs: 0,
    down() { isDown = true; for (const s of socks) s.destroy(); },
    up() { isDown = false; },
    dropResponse(n) { drops.add(p.count + n); },
    stop: () => new Promise((res) => { for (const s of socks) s.destroy(); server.close(() => res()); }),
  };
  const server = net.createServer((c) => {
    if (isDown) return void c.destroy();
    const n = ++p.count;
    socks.add(c);
    const up = net.connect(target.port, target.host ?? "127.0.0.1");
    socks.add(up);
    const wait = () => (p.delayMs > 0 ? new Promise((r) => setTimeout(r, p.delayMs)) : Promise.resolve());
    c.on("data", async (d) => { await wait(); up.write(d); });
    up.on("data", async (d) => { await wait(); if (drops.has(n)) { c.destroy(); up.destroy(); } else c.write(d); });
    for (const s of [c, up]) { s.on("error", () => s.destroy()); s.on("close", () => { socks.delete(s); (s === c ? up : c).destroy(); }); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  p.port = (server.address() as net.AddressInfo).port;
  return p;
}

// ---- FakeTransport: RemoteTransport'un bellek-içi test gerçeklemesi (C1/C2/C3 ve kabul testleri kullanır) ----
import { randomUUID } from "node:crypto";
import type { AgentOp, OpMeta, RemoteTransport } from "../../src/machines/types.js";

export interface FakeCall { to: string; op: AgentOp; args: unknown; opId: string; as?: string }
/** `handler` sonucu döner ya da RemoteError fırlatır; her çağrı `calls`'a yazılır. */
export class FakeTransport implements RemoteTransport {
  calls: FakeCall[] = [];
  constructor(private handler: (c: FakeCall) => unknown | Promise<unknown> = () => ({})) {}
  async call<T = unknown>(to: string, op: AgentOp, args: unknown, o: { opId?: string; timeoutMs?: number; as?: string } = {}): Promise<{ opId: string; result: T; meta?: OpMeta }> {
    const c: FakeCall = { to, op, args, opId: o.opId ?? randomUUID(), as: o.as };
    this.calls.push(c);
    return { opId: c.opId, result: (await this.handler(c)) as T };
  }
}
