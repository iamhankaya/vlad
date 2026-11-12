import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getVladHome } from "../../kb/home.js";
import { agentDir } from "../../fleet/state.js";
import {
  RemoteError, SCRIPT_NAME_RE, type Os, type ScriptEntry, type ScriptInfo, type ScriptListResult, type ScriptRunArgs, type ScriptRunResult,
} from "../../fleet/types.js";
import { checkEntry, checkPushed, loadRepoState, scriptFail } from "../scripts/integrity.js";
import { normalizeParams, scriptPlanId } from "../scripts/manifest.js";
import { runScript, scriptEnv, type RunSpec } from "../scripts/run.js";
import type { Journal, JournalRecord } from "../journal.js";
import type { Verdict } from "../reconcile.js";
import { machineDef } from "../../fleet/registry.js";
import { agentEnv } from "./env.js";
import { maint } from "../maintenance.js";
import { argObject, bad } from "./worker.js";

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
  /** started kaydına betik sınıfı yazılır (çökme uzlaştırması için) */
  journal?: Journal;
  /** selfUpdate başarısında yeniden başlatmayı zamanlar; yoksa sonuçta `restart` alanı olmaz */
  restart?: () => void;
  /** Çalışan sürecin açılışta okuduğu dist/.build-head; yoksa bilinmiyor (yeniden başlatma uygun sayılır) */
  runningBuildHead?: string;
  /** zaman aşımı öldürmesi (testler için); varsayılan killTreeWait */
  killTree?: RunSpec["killTree"];
  /** süreç ağacı doğrulanamayan selfUpdate zaman aşımında yeniden deneme aralığı (varsayılan 5 sn) */
  retryMs?: number;
  /** geri yükleme rename'i (testler için); varsayılan renameSync */
  rename?: (a: string, b: string) => void;
  /** kurtarma bu kadar denemede başarısız olursa bir kez uyarı + ping `stuck` (varsayılan 120 ≈ 10 dk) */
  recoverMaxTries?: number;
  /** uyarı çıktısı (varsayılan stderr) */
  warn?: (msg: string) => void;
  /** selfUpdate betiği başlayınca pid ile çağrılır (test gözlemi; sidecar yine yazılır) */
  onUpdaterSpawn?: (pid: number) => void;
}

/** selfUpdate güncelleyicisinin pid'i (POSIX: süreç grubu lideri); işaret dosyası güncelleyicinin durduğunu kanıtlamaz, bu kanıtlar (F-vlad-274) */
export const updaterPidFile = (stateDir: string): string => join(stateDir, "self-update.pid");
/** true = ölü, false = canlı, "unknown" = sidecar yok/okunamadı (eski biçim: güvenli tarafta kal) */
function updaterGone(pidFile: string, isAlive: (pid: number) => boolean): boolean | "unknown" {
  let pid: number;
  try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { return "unknown"; }
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  return !isAlive(pid);
}
/** POSIX'te negatif pid = süreç grubu (torunlar dahil); Windows'ta yalnız kök pid (torunlar doğrulanamaz: [kalan F-vlad-272]) */
const procAlive = (pid: number): boolean => { try { process.kill(process.platform === "win32" ? pid : -pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
export const defaultScriptDeps = (): ScriptDeps => {
  // çalışan Agent'ın kendi config'i (diskten/şemadan okumaz: VLAD_HOME yalnız git deposu olarak gerekir)
  const e = agentEnv();
  return { home: getVladHome(), platform: process.platform as Os, machine: e.self, roots: machineDef(e.cfg, e.self)?.roots ?? [], stateDir: agentDir(), env: process.env, journal: e.journal, restart: e.requestRestart, runningBuildHead: e.runningBuildHead };
};

/** Tek seferde tek betik: ikinci çağrı `busy` (geçici; CLI çıkış kodu 75). selfUpdate betiği ayrıca bakım bayrağını açar (maintenance.ts). */
let active: string | null = null;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function scriptList(args: unknown, d: ScriptDeps = defaultScriptDeps()): Promise<ScriptListResult> {
  argObject(args, []);
  const st = await loadRepoState(d.home);
  const scripts: ScriptInfo[] = [];
  for (const e of st.manifest.scripts.filter((x) => x.platform === d.platform)) {
    scripts.push({ ...e, integrity: st.dirty ? "dirty" : (await checkEntry(st.repo, e, st.head)).integrity });
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

  const params = normalizeParams(entry, given as Record<string, string>);
  for (const p of entry.params) {
    if (p.type === "root" && params[p.name] !== undefined && !d.roots.includes(params[p.name]!)) throw scriptFail("bad_request", `bad_param:${p.name}`, "root işçinin roots listesinde değil");
  }
  const chk = await checkEntry(st.repo, entry, st.head);
  if (chk.integrity !== "ok") throw scriptFail("forbidden", chk.integrity, `${entry.file} bütünlük denetimini geçemedi`);
  if (d.requirePushed !== false) await checkPushed(st.repo, st.head);
  if (entry.class === "write") {
    const want = scriptPlanId({ machine: d.machine, name: entry.name, platform: entry.platform, sha256: entry.sha256, params });
    if (a.approval?.planId !== want) throw scriptFail("forbidden", "approval", "write betiği için geçerli plan-id gerekli (önce --plan, kullanıcı onayından sonra --confirmed)");
  }

  d.journal?.annotate(ctx.opId, { cls: entry.class }); // çökme uzlaştırması: sınıf kayıttan okunur
  if (active) throw new RemoteError("busy", `busy: başka bir betik sürüyor: ${active}`);
  // selfUpdate: başlamadan uçuşta başka op varsa busy (npm ci altlarından çekmesin); denetim ile bayrak arasında await yok (tek tur)
  if (entry.selfUpdate) {
    if (maint.others(ctx.opId) > 0) {
      const l = maint.list(ctx.opId).slice(0, 5).map((o) => `${o.op}(${o.opId}, ${Math.round(o.ageMs / 1000)}s)`).join(", "); // F-vlad-278: neyin beklendiği görünsün
      throw new RemoteError("busy", `busy: [maintenance] uçuşta başka işlemler var: ${l}; bitince selfUpdate betiğini tekrar çalıştır`);
    }
    maint.enter();
  }
  active = entry.name;
  let restarting = false, deferred = false;
  try {
    const out = await runScript({
      bytes: chk.bytes!, name: entry.name, ext: entry.file.endsWith(".ps1") ? "ps1" : "sh", opId: ctx.opId, cwd: st.repo, dir: join(d.stateDir, "scripts-run"),
      env: scriptEnv(d.env, { home: d.home, repo: st.repo, machine: d.machine, opId: ctx.opId, script: entry.name, params, roots: d.roots }),
      timeoutMs: entry.timeoutSec * 1000, stdoutCapKb: entry.outputMaxKb, platform: d.platform, killTree: d.killTree,
      ...(entry.selfUpdate ? { onSpawn: (pid: number) => { d.onUpdaterSpawn?.(pid); writeFileSync(updaterPidFile(d.stateDir), String(pid), { mode: 0o600 }); } } : {}),
    });
    const { retryKill, ...res } = out;
    if (res.recovery === "pending" && retryKill) {
      // süreç ağacı hâlâ koşuyor olabilir (npm/tsc node_modules'a yazıyor): geri yükleme, bakım bayrağı ve `active` ertelenir, Agent sınırsız yeniden dener
      deferred = true; holdAndRecover({ repo: st.repo, retryKill, selfUpdate: entry.selfUpdate, pidFile: entry.selfUpdate ? updaterPidFile(d.stateDir) : undefined, ...recoverOpts(d) });
      return { name: entry.name, platform: entry.platform, head: st.head, sha256: entry.sha256, ...res };
    }
    // restart yalnız Agent koyar: selfUpdate ∧ exit 0 ∧ data.ok === true ∧ değişiklik var (changed:false iken yalnız çalışan derleme diskteki dist/.build-head'den farklıysa: önceki yardımcı başarısız olduysa yeniden denenebilsin) ∧ yeniden başlatma yolu var (başarısız bakım betiğinde Agent çalışmaya devam eder)
    if (entry.selfUpdate && out.exit === 0 && out.data?.ok === true && (out.data.changed !== false || diskBuildHead(st.repo) !== d.runningBuildHead || d.runningBuildHead === undefined) && d.restart) {
      d.restart(); restarting = true;
      return { name: entry.name, platform: entry.platform, head: st.head, sha256: entry.sha256, ...res, restart: "scheduled" };
    }
    return { name: entry.name, platform: entry.platform, head: st.head, sha256: entry.sha256, ...res };
  } finally {
    // yeniden başlatma bekleyen Agent yeni op almaz: bayrak yeniden başlayana kadar açık
    if (!deferred) {
      // betik zaman aşımıyla/çökmeyle öldüyse kendi geri yüklemesini yapamadı: bayrak kalkmadan Agent yapar; başarısızsa (EBUSY…) bayrak AÇIK kalır ve yeniden denenir (F-vlad-275)
      // sidecar yalnız geri alma başarılı olunca silinir (P2): başarısızsa kalır, yeniden başlatmada startupRecover ölü pid'i görüp geri almayı dener
      const pidFile = updaterPidFile(d.stateDir);
      if (entry.selfUpdate && !restarting && !recoverSelfUpdate(st.repo, d.rename)) { deferred = true; holdAndRecover({ repo: st.repo, selfUpdate: true, pidFile, ...recoverOpts(d) }); }
      else if (entry.selfUpdate) { if (!restarting) maint.leave(); try { rmSync(pidFile, { force: true }); } catch { /* dizin yok */ } }
    }
    if (!deferred) active = null;
  }
}

const recoverOpts = (d: Pick<ScriptDeps, "retryMs" | "rename" | "recoverMaxTries" | "warn">) => ({ everyMs: d.retryMs ?? 5000, rename: d.rename, maxTries: d.recoverMaxTries ?? 120, warn: d.warn });

interface HoldOpts { onRecovered?: () => void; pidFile?: string; repo: string; retryKill?: () => Promise<boolean>; selfUpdate: boolean; everyMs: number; rename?: (a: string, b: string) => void; maxTries?: number; warn?: (m: string) => void }
/**
 * Öldürme doğrulanana ve (selfUpdate'te) geri yükleme başarılı olana dek aralıkla yeniden dener; bitince bakım bayrağını ve `active`'i kaldırır.
 * Tavan (`maxTries`): aşılınca bir kez uyarı yazılır ve ping `stuck:true` gösterir; bayrak yine kalkmaz (yarım node_modules ile op kabul edilmez), deneme sürer.
 * Zamanlayıcı süreci tutmaz (unref).
 */
function holdAndRecover(o: HoldOpts): void {
  let tries = 0, killed = !o.retryKill;
  const warn = o.warn ?? ((m: string) => { process.stderr.write(`${m}\n`); });
  const tick = async (): Promise<void> => {
    if (!killed) killed = await o.retryKill!().catch(() => false);
    if (killed && (!o.selfUpdate || recoverSelfUpdate(o.repo, o.rename))) { if (o.selfUpdate && !o.onRecovered) maint.leave(); if (o.pidFile) { try { rmSync(o.pidFile, { force: true }); } catch { /* yok */ } } active = null; o.onRecovered?.(); return; }
    tries++; maint.attempt(tries);
    if (o.maxTries !== undefined && tries === o.maxTries) {
      maint.markStuck();
      warn(`vlad agent: bakım kurtarması ${tries} denemede tamamlanamadı (${killed ? "geri yükleme" : "süreç ağacı"}); Agent bakımda kalıyor, yeni op almıyor. node_modules/dist yedeklerini elle denetle ve Agent'ı yeniden başlat.`);
    }
    setTimeout(() => void tick(), o.everyMs).unref();
  };
  setTimeout(() => void tick(), o.everyMs).unref();
}

/**
 * Açılışta (F-vlad-274): önceki süreç selfUpdate ortasında öldüyse (`.vlad-npm-ci-running` kaldı) yarım güncellemeyi geri alır. İşaret güncelleyicinin
 * durduğunu kanıtlamaz (POSIX'te detached npm/tsc Agent çökse de yaşar): önce sidecar pid'indeki süreç grubunun öldüğü doğrulanır; canlıysa ÖLDÜRÜLMEZ
 * (pid yeniden kullanılmış olabilir), bakımda beklenir. Geri alma başarılı olunca `onRecovered` çağrılır (F-vlad-326: süreç yeni kodu yüklemiş olabilir; çağıran yeniden başlatır, bakım o zamana dek açık). Sidecar yoksa (eski biçim) güvenli tarafta kalınır: bakımda + uyarı. Geri alma başarısızsa yeniden dener.
 */
export function startupRecover(repo: string, o: { onRecovered?: () => void; pidFile: string; platform?: NodeJS.Platform; isAlive?: (pid: number) => boolean; rename?: (a: string, b: string) => void; everyMs?: number; maxTries?: number; warn?: (m: string) => void }): void {
  if (!existsSync(join(repo, ".vlad-npm-ci-running"))) return;
  const warn = o.warn ?? ((m: string) => { process.stderr.write(`${m}\n`); });
  const isAlive = o.isAlive ?? procAlive;
  maint.enter("recovery");
  // Windows: yalnız kök pid yoklanabilir, torunlar (npm/tsc) yaşıyor olabilir; kanıtlanamadığından geri alma yapılmaz (bakımda kal + uyarı, stuck görünür)
  const win = (o.platform ?? process.platform) === "win32";
  const gone = win ? "unknown" : updaterGone(o.pidFile, isAlive);
  if (win) warn("vlad agent: açılışta yarım selfUpdate işareti var; Windows'ta güncelleyicinin torun süreçlerinin (npm/tsc) durduğu doğrulanamadığından geri alma yapılmadı, Agent bakımda. Süreçlerin bittiğini denetleyip .vlad-npm-ci-running ve yedek dizinleri (node_modules-old, dist-old) elle çöz, Agent'ı yeniden başlat.");
  else if (gone === "unknown") warn("vlad agent: açılışta yarım selfUpdate işareti var ama güncelleyici pid kaydı yok (eski biçim); durduğu doğrulanamadığından geri alma yapılmadı, Agent bakımda. Güncelleyicinin bittiğini denetleyip .vlad-npm-ci-running ve yedek dizinleri elle çöz, Agent'ı yeniden başlat.");
  // F-vlad-326: geri alma bu süreç yeni dist/node_modules'ı yükledikten sonra oldu (tutarsız); onRecovered verilmişse bakım açık kalır ve çağıran yeniden başlatır
  if (gone === true && recoverSelfUpdate(repo, o.rename)) { if (!o.onRecovered) maint.leave(); rmSync(o.pidFile, { force: true }); o.onRecovered?.(); return; }
  // sidecar yoksa pid bilinmez: retryKill hep false (bakımda kal); canlıysa ölünce true
  holdAndRecover({ repo, selfUpdate: true, pidFile: o.pidFile, onRecovered: o.onRecovered, everyMs: o.everyMs ?? 5000, rename: o.rename, maxTries: o.maxTries ?? 120, warn: o.warn,
    ...(gone === true ? {} : { retryKill: async () => !win && updaterGone(o.pidFile, isAlive) === true }) });
}

/**
 * Çökme sonrası uzlaştırma: yalnız started kaydına yazılmış sınıfa bakılır (mevcut HEAD'deki manifeste güvenilmez; betik/manifest
 * değişmiş olabilir). `read` → `not-applied` (yeniden koşabilir); `write` ya da sınıf yazılmamış (çökme öncesi) → `unknown`.
 */
export function reconcileScriptRun(rec: JournalRecord): Verdict {
  return (rec.args as { cls?: unknown } | undefined)?.cls === "read" ? "not-applied" : "unknown";
}

/** Diskteki dist/.build-head (yoksa undefined). */
export function diskBuildHead(repo: string): string | undefined {
  try { return readFileSync(join(repo, "dist", ".build-head"), "utf8").trim() || undefined; } catch { return undefined; }
}

/**
 * selfUpdate betiği `.vlad-npm-ci-running` işaretini bıraktıysa (başarıyla bitmedi: zaman aşımı/öldürme/çökme) yarım güncellemeyi geri alır:
 * node_modules-old → node_modules, dist yoksa dist-old → dist, dist-next silinir, işaret kalkar. İşaret yoksa (betik kendi temizledi ya da
 * yedek önceki başarılı güncellemeye ait) hiçbir şeye dokunmaz. Dönüş: true = temiz (işaret yoktu ya da geri yüklendi); false = başarısız,
 * işaret kalır (F-vlad-275: çağıran bakım bayrağını KALDIRMAZ, yeniden dener).
 */
export function recoverSelfUpdate(repo: string, rename: (a: string, b: string) => void = renameSync): boolean {
  const mark = join(repo, ".vlad-npm-ci-running");
  if (!existsSync(mark)) return true;
  try {
    const nm = join(repo, "node_modules"), nmOld = join(repo, "node_modules-old");
    // F-vlad-281: eskiyi geri koymadan önce mevcut olanı silme; rename patlarsa mevcut geri konur
    const restore = (cur: string, old: string): void => {
      const trash = `${cur}-recover`;
      rmSync(trash, { recursive: true, force: true });
      if (existsSync(cur)) rename(cur, trash);
      try { rename(old, cur); } catch (e) { if (existsSync(trash)) rename(trash, cur); throw e; }
      rmSync(trash, { recursive: true, force: true });
    };
    // güvenlik: yedek dizin symlink ise (başka yeri gösterebilir) geri yükleme yapılmaz; işaret kalır, elle çözülür
    for (const q of [nmOld, join(repo, "dist-old")]) { try { if (lstatSync(q).isSymbolicLink()) return false; } catch { /* yok */ } }
    if (existsSync(nmOld)) restore(nm, nmOld);
    const dist = join(repo, "dist"), distOld = join(repo, "dist-old");
    // işaret "swap" ise dist değişimi başlamıştı: dist-old ile eş geri yükle (yeni dist + eski node_modules tutarsız); işaretsiz/boş işarette dist-old önceki güncellemeden kalmış olabilir, dokunulmaz
    const swapped = readFileSync(mark, "utf8").trim() === "swap";
    if (existsSync(distOld) && (swapped || !existsSync(dist))) restore(dist, distOld);
    rmSync(join(repo, "dist-next"), { recursive: true, force: true });
    rmSync(mark, { force: true });
    return true;
  } catch { return false; /* işaret kalır; çağıran yeniden dener, vlad-guncelle de koşusu başında dener */ }
}
