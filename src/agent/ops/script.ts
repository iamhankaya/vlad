import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getVladHome } from "../../kb/home.js";
import { agentDir } from "../../fleet/state.js";
import {
  RemoteError, SCRIPT_NAME_RE, type Os, type ScriptEntry, type ScriptInfo, type ScriptListResult, type ScriptRunArgs, type ScriptRunResult,
} from "../../fleet/types.js";
import type { JournalRecord } from "../journal.js";
import type { Verdict } from "../reconcile.js";
import { checkEntry, checkPushed, loadRepoState, scriptFail } from "../scripts/integrity.js";
import { normalizeParams, scriptPlanId, validateScriptManifest } from "../scripts/manifest.js";
import { runScript, scriptEnv } from "../scripts/run.js";
import { argObject, bad, workerCtx } from "./worker.js";

// Kayıtlı bakım betikleri (T20261109-03): `script-list` salt okuma, `script-run` günlüklü. Betik yalnız HEAD manifestinde kayıtlı,
// itilmiş HEAD'de, hash'i tutan bir blob olabilir; istekten yol/komut alınmaz. Başladıktan sonra hiçbir yol fırlatmaz.

export interface ScriptDeps {
  /** VLAD_HOME: işçideki vlad klonu (git deposunun kökü) */
  home: string;
  platform: Os;
  machine: string;
  /** işçi config'indeki `machines[].roots`; `root` tipli parametre bunlardan biri olmalı */
  roots: string[];
  /** geçici betik dizininin üstü (`<agentDir>`) */
  stateDir: string;
  env: NodeJS.ProcessEnv;
  /** itilmemiş HEAD reddi (varsayılan açık; spec açık soru 3) */
  requirePushed?: boolean;
}
export const defaultScriptDeps = (): ScriptDeps => {
  const w = workerCtx();
  return { home: getVladHome(), platform: process.platform as Os, machine: w.self, roots: w.def.roots ?? [], stateDir: agentDir(), env: process.env };
};

/** Tek seferde tek betik: ikinci çağrı `busy` (geçici; CLI çıkış kodu 75). shortcut: bakım (maintenance) bayrağı (b) fazında bu kilide bağlanır. */
let active: string | null = null;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function scriptList(args: unknown, d: ScriptDeps = defaultScriptDeps()): Promise<ScriptListResult> {
  argObject(args, []);
  const st = await loadRepoState(d.home);
  const scripts: ScriptInfo[] = [];
  for (const e of st.manifest.scripts.filter((x) => x.platform === d.platform)) {
    scripts.push({ ...e, integrity: st.dirty ? "dirty" : (await checkEntry(st.repo, e)).integrity });
  }
  return { head: st.head, platform: d.platform, scripts };
}

export async function scriptRun(args: unknown, d: ScriptDeps = defaultScriptDeps(), ctx: { opId: string } = { opId: "op" }): Promise<ScriptRunResult> {
  const a = argObject(args, ["name", "params", "approval"]) as unknown as Partial<ScriptRunArgs> & Record<string, unknown>;
  if (typeof a.name !== "string" || !SCRIPT_NAME_RE.test(a.name)) throw scriptFail("bad_request", "bad_name", "betik adı geçersiz");
  const given = a.params ?? {};
  if (!isObj(given)) throw bad("params nesne olmalı");
  if (a.approval !== undefined && (!isObj(a.approval) || typeof a.approval.planId !== "string" || Object.keys(a.approval).length !== 1)) throw bad("approval {planId} olmalı");

  const st = await loadRepoState(d.home);
  if (st.dirty) throw scriptFail("forbidden", "dirty", "agent-scripts/ altında yerel değişiklik var");
  const same = st.manifest.scripts.filter((e) => e.name === a.name);
  if (!same.length) throw scriptFail("not_found", "unregistered", `kayıtlı betik değil: ${a.name}`);
  const entry: ScriptEntry | undefined = same.find((e) => e.platform === d.platform);
  if (!entry) throw scriptFail("not_found", "no_variant", `${a.name} için ${d.platform} varyantı yok`);
  if (entry.selfUpdate) throw new RemoteError("forbidden", "forbidden: selfUpdate betikleri bu Agent sürümünde desteklenmiyor");

  const params = normalizeParams(entry, given as Record<string, string>);
  for (const p of entry.params) {
    if (p.type === "root" && params[p.name] !== undefined && !d.roots.includes(params[p.name]!)) throw scriptFail("bad_request", `bad_param:${p.name}`, "root işçinin roots listesinde değil");
  }
  const chk = await checkEntry(st.repo, entry);
  if (chk.integrity !== "ok") throw scriptFail("forbidden", chk.integrity, `${entry.file} bütünlük denetimini geçemedi`);
  if (d.requirePushed !== false) await checkPushed(st.repo);
  if (entry.class === "write") {
    const want = scriptPlanId({ machine: d.machine, name: entry.name, platform: entry.platform, sha256: entry.sha256, params });
    if (a.approval?.planId !== want) throw scriptFail("forbidden", "approval", "write betiği için geçerli plan-id gerekli (önce --plan, kullanıcı onayından sonra --confirmed)");
  }

  if (active) throw new RemoteError("busy", `busy: başka bir betik sürüyor: ${active}`);
  active = entry.name;
  try {
    const out = await runScript({
      bytes: chk.bytes!, name: entry.name, ext: entry.file.endsWith(".ps1") ? "ps1" : "sh", opId: ctx.opId, cwd: st.repo, dir: join(d.stateDir, "scripts-run"),
      env: scriptEnv(d.env, { home: d.home, repo: st.repo, machine: d.machine, opId: ctx.opId, script: entry.name, params, roots: d.roots }),
      timeoutMs: entry.timeoutSec * 1000, stdoutCapKb: entry.outputMaxKb, platform: d.platform,
    });
    return { name: entry.name, platform: entry.platform, head: st.head, sha256: entry.sha256, ...out };
  } finally { active = null; }
}

/**
 * Çökme sonrası uzlaştırma: read sınıfı betik yeniden koşabilir (`not-applied`); write ya da çözülemeyen (HEAD değişmiş, manifest
 * bozuk) → `unknown` (done+uncertain; insan karar verir).
 */
export function reconcileScriptRun(rec: JournalRecord, d: Pick<ScriptDeps, "home" | "platform"> = { home: getVladHome(), platform: process.platform as Os }): Verdict {
  const name = (rec.args as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string") return "unknown";
  try {
    const raw = execFileSync("git", ["show", "HEAD:agent-scripts/manifest.json"], { cwd: d.home, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const e = validateScriptManifest(JSON.parse(raw)).scripts.find((x) => x.name === name && x.platform === d.platform);
    return e?.class === "read" ? "not-applied" : "unknown";
  } catch { return "unknown"; }
}
