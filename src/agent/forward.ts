import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readInput } from "../kb/input.js";
import { getVladHome } from "../kb/home.js";
import { loadConfig } from "../kb/config.js";
import type { VladConfig } from "../kb/types.js";
import { RemoteError, type AgentOp, type ExecResult, type WriteArgs } from "../machines/types.js";
import { readStdinSync } from "../kb/input.js";
import { AgentClient } from "./client.js";
import { readLocal, roleOf, selfName } from "./state.js";

/** Bu makinede çoklu makine etkin ve ben beyin değilim (ve iletilmiş bir çağrı değilim) → {cfg, self}. */
export function workerContext(): { cfg: VladConfig; self: string } | null {
  if (process.env.VLAD_FORWARDED) return null; // iletilmiş çağrı yeniden iletilmez
  const f = join(getVladHome(), "vlad.config.json");
  if (!existsSync(f) || !readFileSync(f, "utf8").includes('"machines"')) return null; // ucuz hızlı yol: machines yok → bugünkü davranış
  let cfg: VladConfig;
  try { cfg = loadConfig(); } catch { return null; } // config hatasını komutun kendisi raporlar
  if (!cfg.machines) return null;
  const self = selfName();
  return self === cfg.brain ? null : { cfg, self };
}

const FORWARD: Record<string, WriteArgs["cmd"]> = { "task log": "task.log", "task ask": "task.ask", "task report": "task.report", "task session": "task.session" };

const localClient = (cfg: VladConfig, self: string) => new AgentClient({ self, keys: readLocal().keys, config: () => cfg, defaultTimeoutMs: 70_000 });

/** Yerel Agent'a çağrı; Agent yoksa açıklayıcı geçici hata (75). */
export async function callLocal<T>(cfg: VladConfig, self: string, op: AgentOp, args: unknown): Promise<T> {
  try { return (await localClient(cfg, self).call<T>(self, op, args)).result; } catch (e) {
    if (e instanceof RemoteError && e.code === "unreachable") throw new RemoteError("unreachable", "yerel VLAD Agent çalışmıyor (vlad agent status)", self);
    throw e;
  }
}

/**
 * def() kancası: beyin olmayan makinede `task log|ask|report|session` yerel Agent'a iletilir; diğer kb yazmaları reddedilir.
 * true → komut iletildi (çıktı yazıldı), yerel handler çalışmaz.
 */
export async function forwardIfWorker(key: string, args: any[], kbWrites: ReadonlySet<string>): Promise<boolean> {
  if (!kbWrites.has(key)) return false;
  const ctx = workerContext();
  if (!ctx) return false;
  const cmd = FORWARD[key];
  if (!cmd) throw new Error("bu makine beyin değil; komut beyinde/konsolda çalıştırılmalı");
  const o = args[args.length - 2] as { json?: boolean; file?: string };
  const [id, val] = args as [string, string];
  const w: WriteArgs = cmd === "task.report" ? { cmd, id, text: readInput(o.file!) } : cmd === "task.session" ? { cmd, id, sessionId: val } : { cmd, id, text: val };
  if (o.json) w.json = true;
  const r = await callLocal<ExecResult | { queued: true; seq: number; opId: string; reason?: string }>(ctx.cfg, ctx.self, "forward-write", w);
  if ("queued" in r) {
    process.stderr.write(`uyarı: yazma kuyruğa alındı (seq ${r.seq}); beyne ulaşılınca sırayla gönderilir${r.reason ? ` (${r.reason})` : ""}\n`);
    process.stdout.write((o.json ? JSON.stringify({ queued: true, seq: r.seq, opId: r.opId }) : `kuyruğa alındı (seq ${r.seq})`) + "\n");
    return true;
  }
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.exit;
  return true;
}

/** `vlad remote [--op-id] [--stdin] -- <argv…>`: konsol kimliğiyle beyin Agent'ında çalıştırır; çıktı/çıkış kodu aynen yansır. */
export async function runRemote(argv: string[], o: { opId?: string; stdin?: boolean }): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.machines || !cfg.brain) throw new Error("remote: config'te machines tanımlı değil");
  const self = selfName();
  if (roleOf(cfg, self) !== "console") throw new Error(`remote: ${self} bir konsol kimliği değil (config consoles)`);
  if (!argv.length) throw new Error("remote: komut verilmedi (vlad remote -- <vlad argv…>)");
  const client = new AgentClient({ self, keys: readLocal().keys, config: () => cfg });
  const stdin = o.stdin ? readStdinSync() : undefined;
  const r = await client.call<ExecResult>(cfg.brain, "exec", { argv, ...(stdin !== undefined ? { stdin } : {}) }, { opId: o.opId ?? randomUUID(), timeoutMs: 120_000 });
  process.stdout.write(r.result.stdout);
  process.stderr.write(r.result.stderr);
  process.exitCode = r.result.exit;
}
