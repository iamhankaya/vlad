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
import { forwardMap, workerLocalKeys } from "../commands/accessors.js";
import { consoleExecTimeoutMs } from "./console-catalog.js";
import { resolveSelf } from "../machines/registry.js";
import { readLocal, roleOf, selfName } from "./state.js";

type WorkerState = { kind: "off" } | { kind: "brain" } | { kind: "worker"; ctx: { cfg: VladConfig; self: string } } | { kind: "unknown"; reason: string };

/** machines tanımlıyken kimlik/config okunamıyorsa "unknown" (fail-closed, F-vlad-144); machines yoksa "off". */
export function workerState(): WorkerState {
  if (process.env.VLAD_FORWARDED) return { kind: "off" }; // iletilmiş çağrı yeniden iletilmez
  const f = join(getVladHome(), "vlad.config.json");
  if (!existsSync(f)) return { kind: "off" };
  let raw: string;
  try { raw = readFileSync(f, "utf8"); } catch (e) { return { kind: "unknown", reason: `config okunamadı: ${(e as Error).message}` }; }
  if (!raw.includes('"machines"')) return { kind: "off" }; // ucuz hızlı yol: machines yok → tek makine davranışı
  let cfg: VladConfig;
  try { cfg = loadConfig(); } catch (e) { return { kind: "unknown", reason: `config okunamadı: ${(e as Error).message}` }; }
  if (!cfg.machines) return { kind: "off" };
  let self: string;
  try { self = resolveSelf(cfg)!; } catch (e) { return { kind: "unknown", reason: (e as Error).message }; }
  return self === cfg.brain ? { kind: "brain" } : { kind: "worker", ctx: { cfg, self } };
}

/** Bu makinede çoklu makine etkin ve ben beyin değilim (ve iletilmiş bir çağrı değilim) → {cfg, self}. */
export function workerContext(): { cfg: VladConfig; self: string } | null {
  const s = workerState();
  return s.kind === "worker" ? s.ctx : null;
}

export const FORWARD: Record<string, WriteArgs["cmd"]> = { ...forwardMap() }; // manifestten türer (worker: forward)

const localClient = (cfg: VladConfig, self: string) => new AgentClient({ self, keys: readLocal().keys, config: () => cfg, defaultTimeoutMs: 70_000 });

/** Yerel Agent'a çağrı; Agent yoksa açıklayıcı geçici hata (75). */
export async function callLocal<T>(cfg: VladConfig, self: string, op: AgentOp, args: unknown): Promise<T> {
  try { return (await localClient(cfg, self).call<T>(self, op, args)).result; } catch (e) {
    if (e instanceof RemoteError && e.code === "unreachable") throw new RemoteError("unreachable", "yerel VLAD Agent çalışmıyor (vlad agent status)", self);
    throw e;
  }
}

/**
 * İşçide yerelde çalışabilen komutlar (açık izin listesi; manifestte `worker: local`): kb klonunu okur ya da kb'ye hiç dokunmaz.
 * Liste dışı her komut ya iletilir (FORWARD) ya reddedilir; yeni komut varsayılan olarak reddedilir (fail-closed).
 * `task launch`/`kb commit` gibi iç kilitli yazıcılar KB_WRITES'ta olmadığı için burada olmamaları gerekir.
 */
export const WORKER_LOCAL: ReadonlySet<string> = workerLocalKeys();

/**
 * def() kancası: beyin olmayan makinede `task log|ask|report|session` yerel Agent'a iletilir; WORKER_LOCAL dışındaki
 * her komut reddedilir (kb klonu yalnız kb-sync ile değişir).
 * true → komut iletildi (çıktı yazıldı), yerel handler çalışmaz.
 */
export async function forwardIfWorker(key: string, args: any[]): Promise<boolean> {
  if (WORKER_LOCAL.has(key)) return false;
  const st = workerState();
  if (st.kind === "unknown") throw new Error(`çok makine kimliği doğrulanamadı, kb yazıcı komut reddedildi (${key}): ${st.reason}`);
  if (st.kind !== "worker") return false;
  const ctx = st.ctx;
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
  if (o.opId !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(o.opId)) throw new Error("remote: --op-id yalnız harf, rakam ve . _ : - (en çok 64)");
  const client = new AgentClient({ self, keys: readLocal().keys, config: () => cfg });
  const stdin = o.stdin ? readStdinSync() : undefined;
  const r = await client.call<ExecResult>(cfg.brain, "exec", { argv, ...(stdin !== undefined ? { stdin } : {}) }, { opId: o.opId ?? randomUUID(), timeoutMs: consoleExecTimeoutMs(argv) + 10_000 });
  if (!r.result) throw new Error("remote: sonuç belirsiz (Agent yeniden başlamış olabilir); tekrar denemeden önce `vlad remote -- task list` ile durumu kontrol et");
  process.stdout.write(r.result.stdout);
  process.stderr.write(r.result.stderr);
  process.exitCode = r.result.exit;
}
