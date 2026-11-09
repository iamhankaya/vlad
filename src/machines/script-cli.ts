import { randomUUID } from "node:crypto";
import { normalizeParams, scriptPlanId } from "../agent/scripts/manifest.js";
import {
  RemoteError, type RemoteTransport, type ScriptClass, type ScriptIntegrity, type ScriptListResult, type ScriptPlatform, type ScriptRunResult,
} from "../fleet/types.js";

// `vlad machine scripts|run` mantığı (beyin tarafı). Taşıma enjekte edilir; komut kaydı cli/groups/machine.ts'tedir.

const PLAN_ID_RE = /^[0-9a-f]{16}$/;
const TIMEOUT_MARGIN_MS = 30_000; // betiğin kendi zaman aşımından sonra Agent'ın yanıtı için pay (varsayılan 70 sn istemci süresi yetmez)

/** `--param k=v` listesi: ilk '=' böler, kopya anahtar ve '=' içermeyen değer reddedilir. */
export function parseParamFlags(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const kv of list ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new Error(`--param k=v biçiminde olmalı: ${kv}`);
    const k = kv.slice(0, i);
    if (k in out) throw new Error(`kopya --param anahtarı: ${k}`);
    out[k] = kv.slice(i + 1);
  }
  return { ...out };
}

export type RunOutcome =
  | { kind: "plan"; machine: string; name: string; platform: ScriptPlatform; head: string; sha256: string; class: ScriptClass; integrity: ScriptIntegrity; timeoutSec: number; params: Record<string, string>; planId: string }
  | { kind: "result"; opId: string; result: ScriptRunResult; replayed: boolean; uncertain: boolean };

export interface RunOpts { params: Record<string, string>; plan?: boolean; confirmed?: string; opId?: string }

export async function listScripts(t: RemoteTransport, machine: string): Promise<ScriptListResult> {
  return (await t.call<ScriptListResult>(machine, "script-list", {})).result;
}

/** `script-list` ile girişi okur; `--plan` çağrı yapmadan planı verir; write sınıfı `--confirmed <plan-id>` ister; sonra `script-run`. */
export async function runRemoteScript(t: RemoteTransport, machine: string, name: string, o: RunOpts): Promise<RunOutcome> {
  const list = await listScripts(t, machine);
  const entry = list.scripts.find((s) => s.name === name);
  if (!entry) throw new Error(`kayıtlı betik değil: ${name} (${machine}, ${list.platform}); \`vlad machine scripts ${machine}\` ile bak`);
  const params = normalizeParams(entry, o.params);
  const planId = scriptPlanId({ machine, name, platform: list.platform, sha256: entry.sha256, params });
  if (o.plan) return { kind: "plan", machine, name, platform: list.platform, head: list.head, sha256: entry.sha256, class: entry.class, integrity: entry.integrity, timeoutSec: entry.timeoutSec, params, planId };
  if (entry.integrity !== "ok") throw new Error(`${name} bütünlük denetimini geçemiyor (${entry.integrity}); çalıştırılmaz`);
  if (entry.class === "write") {
    if (!o.confirmed) throw new Error(`${name} write sınıfı: önce --plan ile planı göster, kullanıcının açık onayından sonra --confirmed <plan-id> ile çalıştır`);
    if (!PLAN_ID_RE.test(o.confirmed)) throw new Error("--confirmed 16 küçük hex karakterlik plan-id olmalı");
  }
  const opId = o.opId ?? randomUUID();
  const args = { name, params: o.params, ...(entry.class === "write" ? { approval: { planId: o.confirmed } } : {}) };
  try {
    const r = await t.call<ScriptRunResult>(machine, "script-run", args, { opId, timeoutMs: entry.timeoutSec * 1000 + TIMEOUT_MARGIN_MS });
    return { kind: "result", opId, result: r.result, replayed: !!r.meta?.replayed, uncertain: !!r.meta?.uncertain };
  } catch (e) {
    // yanıt gelmediyse betik koşmuş olabilir: aynı opId ile tekrar çağrı ikinci kez koşmaz, kayıtlı sonucu döner
    if (e instanceof RemoteError && e.code === "timeout") throw new RemoteError("timeout", `${e.message}; betik koşmuş olabilir, aynı --op-id ${opId} ile tekrar çağır (ikinci kez koşmaz)`, e.machine);
    throw e;
  }
}

const shortSha = (s: string) => s.slice(0, 8);
export function formatScripts(l: ScriptListResult): string {
  if (!l.scripts.length) return `kayıtlı betik yok (${l.platform}, HEAD ${shortSha(l.head)})`;
  const rows = l.scripts.map((s) => {
    const ps = s.params.map((p) => (p.required ? p.name : p.default !== undefined ? `${p.name}=${p.default}` : `${p.name}?`)).join(",");
    return `${s.name}  ${s.class}  [${ps}]  ${s.timeoutSec}s  ${shortSha(s.sha256)}  ${s.integrity}${s.integrity === "ok" ? "" : "  UYARI: çalıştırılamaz"}`;
  });
  return [`${l.platform}  HEAD ${shortSha(l.head)}`, ...rows].join("\n");
}

export function formatPlan(p: Extract<RunOutcome, { kind: "plan" }>): string {
  const ps = Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join(" ") || "(yok)";
  return [
    `plan: ${p.name} @ ${p.machine} (${p.platform}, HEAD ${shortSha(p.head)}, sha ${shortSha(p.sha256)})`,
    `sınıf: ${p.class}${p.class === "write" ? " (kullanıcı onayı gerekir)" : ""}  zaman aşımı: ${p.timeoutSec}s  bütünlük: ${p.integrity}`,
    `parametreler: ${ps}`,
    `plan-id: ${p.planId}`,
    ...(p.class === "write" ? [`onaydan sonra: vlad machine run ${p.machine} ${p.name} ${Object.entries(p.params).map(([k, v]) => `--param ${k}=${v}`).join(" ")} --confirmed ${p.planId}`.replace(/ {2,}/g, " ")] : []),
  ].join("\n");
}

export function formatRun(r: Extract<RunOutcome, { kind: "result" }>): string {
  const x = r.result;
  const head = `${x.name} exit=${x.exit}${x.timedOut ? " (zaman aşımı)" : ""} ${x.durationMs}ms${r.replayed ? " [önceki sonuç, tekrar koşmadı]" : ""}${r.uncertain ? " [belirsiz]" : ""}`;
  const summary = typeof x.data?.summary === "string" ? x.data.summary : x.dataError ? `(sonuç satırı yok/bozuk: ${x.dataError})` : "";
  const tail = !summary && x.stdout.trim() ? x.stdout.trim() : "";
  return [head, summary, tail].filter(Boolean).join("\n");
}
