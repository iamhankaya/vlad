import { RemoteError, type ExecResult, type WriteArgs, type WriteCmd } from "../../machines/types.js";
import { getTask } from "../../tasks/index.js";
import type { JournalRecord } from "../journal.js";
import type { Verdict } from "../reconcile.js";
import { runCli } from "./run-cli.js";

const CMDS: readonly WriteCmd[] = ["task.log", "task.ask", "task.report", "task.session"];
const ID_RE = /^T\d{8}-\d{2,}$/;
const MAX_TEXT = 1024 * 1024;
const bad = (m: string) => new RemoteError("bad_request", `bad_request: ${m}`);

/** Yapısal argümanı doğrular (argv değil). Ham değerlerin hiçbiri kabuğa girmez; alt süreç argv dizisiyle çalışır. */
export function parseWriteArgs(a: unknown): WriteArgs {
  const w = a as Partial<WriteArgs> | null;
  if (!w || typeof w !== "object") throw bad("argüman nesne olmalı");
  if (!CMDS.includes(w.cmd as WriteCmd)) throw bad(`cmd geçersiz: ${String(w.cmd)}`);
  if (typeof w.id !== "string" || !ID_RE.test(w.id)) throw bad("id geçersiz");
  const str = (v: unknown, name: string, max: number) => {
    if (typeof v !== "string" || !v) throw bad(`${name} gerekli`);
    if (v.includes("\0")) throw bad(`${name} NUL içeriyor`);
    if (Buffer.byteLength(v) > max) throw bad(`${name} ${max} bayttan büyük`);
    return v;
  };
  if (w.json !== undefined && typeof w.json !== "boolean") throw bad("json boolean olmalı");
  if (w.cmd === "task.session") return { cmd: w.cmd, id: w.id, sessionId: str(w.sessionId, "sessionId", 256), ...(w.json ? { json: true } : {}) };
  return { cmd: w.cmd!, id: w.id, text: str(w.text, "text", MAX_TEXT), ...(w.json ? { json: true } : {}) };
}

/** Mevcut CLI'ın tam argv'si; rapor metni stdin'den (`--file -`). `-` ile başlayan metin için `--` kullanılır. */
/** Satır başındaki `#`/`##` başlığı görev dosyasının bölümünü bölerdi; başına `\` konur. */
export const escHeads = (t: string): string => t.replace(/^(#{1,2}\s)/gm, "\\$1");

export function writeArgv(w: WriteArgs): { argv: string[]; stdin?: string } {
  const verb = w.cmd.slice(5);
  const json = w.json ? ["--json"] : [];
  if (w.cmd === "task.report") return { argv: ["task", verb, w.id, "--file", "-", ...json], stdin: w.text };
  const val = w.cmd === "task.session" ? w.sessionId! : escHeads(w.text!);
  return { argv: ["task", verb, ...json, ...(val.startsWith("-") ? ["--"] : []), w.id, val] };
}

/** worker → beyin: görev bu kimliğe ait olmalı (diskten okunur, kimlik imzadan gelir); sonra mevcut CLI aynen çalışır. */
export async function applyWrite(args: unknown, ctx: { from: string; opId: string }): Promise<ExecResult> {
  const w = parseWriteArgs(args);
  let owner: string | null | undefined;
  try { owner = getTask(w.id).data.machine; } catch { throw new RemoteError("not_found", `not_found: görev yok: ${w.id}`); }
  if (owner !== ctx.from) throw new RemoteError("forbidden", "forbidden: görev başka makineye ait");
  const { argv, stdin } = writeArgv(w);
  const r = await runCli(argv, { stdin, forwarded: ctx.from, opId: ctx.opId, timeoutMs: 60_000 });
  if (r.exit === 75) throw new RemoteError("busy", `busy: kb kilidi alınamadı (${r.stderr.trim()})`); // beyinde kilit zaman aşımı → kuyrukta kalır, yeniden denenir
  return r;
}

/** Açılış uzlaştırması: `started` kalmış yazmanın etkisi görev dosyasında var mı? */
export function reconcileApplyWrite(rec: JournalRecord): Verdict {
  let w: WriteArgs;
  try { w = parseWriteArgs(rec.args); } catch { return "unknown"; }
  let t;
  try { t = getTask(w.id); } catch { return "unknown"; }
  switch (w.cmd) {
    case "task.session": return t.data.session_id === w.sessionId!.trim() ? "applied" : "not-applied";
    case "task.log": return t.body.split("\n").some((l) => { // `- <iso> <metin>`; başlangıçtan sonra yazılmış satır
      const m = /^- (\S+) (.*)$/.exec(l);
      return !!m && m[2] === escHeads(w.text!) && Date.parse(m[1]!) >= rec.ts - 2000;
    }) ? "applied" : "not-applied";
    case "task.ask": return t.data.state === "blocked" && t.body.includes(escHeads(w.text!)) ? "applied" : "not-applied";
    case "task.report": return t.data.state === "awaiting_approval" && t.body.includes(w.text!.trim()) ? "applied" : "not-applied";
  }
}
