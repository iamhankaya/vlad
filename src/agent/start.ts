import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../kb/config.js";
import { nowMs } from "../machines/clock.js";
import { RemoteError } from "../machines/types.js";
import { AgentClient } from "./client.js";
import { Journal } from "./journal.js";
import { setAgentEnv } from "./ops/env.js";
import { reconcileApplyWrite } from "./ops/apply-write.js";
import { execIsWrite } from "./ops/exec.js";
import { flushQueue } from "./ops/forward-write.js";
import { OP_TABLE } from "./ops/index.js";
import { AgentQueue } from "./queue.js";
import { reconcile } from "./reconcile.js";
import { startServer } from "./server.js";
import { addressOf, agentDir, assertPrivateBind, buildId, localFile, readLocal, roleOf, selfName, writeLocal } from "./state.js";

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
  await assertPrivateBind(bind);
  const port = o.port ?? def.agent.port;

  const test = process.env.VLAD_AGENT_TEST === "1";
  const dir = agentDir();
  mkdirSync(dir, { recursive: true });
  const journal = new Journal(join(dir, "journal.jsonl"), nowMs);
  reconcile(journal, { "apply-write": reconcileApplyWrite });
  const queue = kind === "worker-agent" ? new AgentQueue(join(dir, "queue"), nowMs) : undefined;
  const build = buildId();
  setAgentEnv({ self, kind, cfg, startedAt: nowMs(), build, journal, queue, now: nowMs, transport: new AgentClient({ self, keys, config: () => loadConfig() }) });

  let srv;
  try {
    srv = await startServer({
      self, kind, cfg: () => loadConfig(), keys, ops: OP_TABLE, journal, build, bind, port,
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
  const stop = () => { void srv.close().finally(() => { rmSync(pidFile(), { force: true }); process.exit(0); }); };
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

/** Kimlik için yeni 32 bayt anahtar üretir ve yerel dosyaya yazar (varsa değiştirir = döndürme). */
export function agentKeygen(identity: string): { identity: string; key: string; file: string } {
  const cfg = loadConfig();
  if (cfg.machines && !roleOf(cfg, identity)) throw new Error(`agent keygen: kimlik config'te tanımlı değil: ${identity}`);
  const local = readLocal();
  const key = randomBytes(32).toString("hex");
  writeLocal({ ...local, keys: { ...local.keys, [identity]: key } });
  return { identity, key, file: localFile() };
}
