// Parça yardımcıları (T20261110-05): dosya/JSON/yedek, komut yürütücü (testte değiştirilebilir), karma, sürüm.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stamp } from "../install.js";
import type { ApplyAction, ApplyResult, ItemCheck, PartCheck, PartId, Requirement, SetupContext } from "./types.js";

// ---- komut yürütücü ----
export interface RunResult { ok: boolean; code: number | null; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], o?: { cwd?: string; input?: string; timeoutMs?: number }) => RunResult;
const realRunner: Runner = (cmd, args, o = {}) => {
  try {
    const stdout = execFileSync(cmd, args, { cwd: o.cwd, input: o.input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: o.timeoutMs ?? 20_000, windowsHide: true, shell: process.platform === "win32" && !/\.exe$/i.test(cmd), env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: true, code: 0, stdout, stderr: "" };
  } catch (e) {
    const x = e as { status?: number | null; stdout?: string; stderr?: string; message: string };
    return { ok: false, code: x.status ?? null, stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message) };
  }
};
let runner: Runner = realRunner;
/** Test: sahte yürütücü (gerçek gh/launchctl/schtasks çağrılmaz). `null` gerçeğine döner. */
export function setRunner(r: Runner | null): void { runner = r ?? realRunner; }
export const run: Runner = (cmd, args, o) => runner(cmd, args, o);

// ---- sürüm ----
export function versionAtLeast(out: string, min: string): boolean {
  const m = /(\d+)\.(\d+)?/.exec(out) ?? /(\d+)/.exec(out);
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2] ?? 0)], want = min.split(".").map(Number);
  return have[0]! > want[0]! || (have[0] === want[0] && have[1]! >= (want[1] ?? 0));
}

// ---- dosya/JSON ----
export const expandHome = (p: string, home: string): string => (p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : p);
export function readJsonFile(path: string): { exists: boolean; data: any } {
  if (!existsSync(path)) return { exists: false, data: {} };
  try { return { exists: true, data: JSON.parse(readFileSync(path, "utf8")) }; } catch (e) { throw new Error(`${path} geçerli JSON değil: ${(e as Error).message}`); }
}
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
/** JSON dosyasını yapısal günceller: değişmediyse yazmaz (idempotens), değiştiyse önce `<dosya>.bak-<stamp>` yedeği alır. */
export function updateJson(ctx: SetupContext, path: string, mutate: (d: any) => any): { changed: boolean; backup?: string } {
  const cur = readJsonFile(path);
  const next = mutate(structuredClone(cur.data));
  if (JSON.stringify(next) === JSON.stringify(cur.data)) return { changed: false };
  let backup: string | undefined;
  if (!ctx.dryRun) {
    if (cur.exists) { backup = `${path}.bak-${stamp(new Date())}`; copyFileSync(path, backup); }
    writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  } else if (cur.exists) backup = `${path}.bak-<zaman>`;
  return { changed: true, backup };
}

/** Dizin içindeki dosyalar (göreli yol → içerik) — karma yerine doğrudan bayt karşılaştırması. */
export function dirFiles(dir: string, rel = ""): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(join(dir, rel))) return out;
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of dirFiles(dir, r)) out.set(k, v);
    else out.set(r, readFileSync(join(dir, r)));
  }
  return out;
}
/** src'deki her dosya dst'de aynıysa "ok"; dst yoksa "eksik"; fark varsa "eski". */
export function compareDirs(src: string, dst: string): "ok" | "eksik" | "eski" {
  if (!existsSync(dst)) return "eksik";
  const d = dirFiles(dst);
  for (const [k, v] of dirFiles(src)) { const o = d.get(k); if (!o) return "eksik"; if (!o.equals(v)) return "eski"; }
  return "ok";
}
export function newestMtime(dir: string): number {
  let m = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return m;
}
export const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b);

// ---- sonuç kurma ----
const ORDER = ["çakışan", "eksik", "eski"] as const;
/** Öğelerden parça sonucu: en kötü durum; zorunlu öğe → error, isteğe bağlı → warn, bilgi → info. */
export function compose(part: PartId, entries: { item: ItemCheck; required: Requirement }[], fix?: string): PartCheck {
  const failing = entries.filter((e) => (ORDER as readonly string[]).includes(e.item.status));
  const items = entries.map((e) => e.item);
  if (failing.length === 0) {
    const real = items.filter((i) => i.status !== "n/a");
    return { part, status: real.length ? "ok" : "n/a", severity: "info", evidence: (real.length ? real : items).map((i) => i.evidence).join("; "), items };
  }
  const worst = ORDER.find((s) => failing.some((f) => f.item.status === s))!;
  const sev = failing.some((f) => f.required === "zorunlu") ? "error" : failing.some((f) => f.required === "isteğe bağlı") ? "warn" : "info";
  const top = failing.filter((f) => f.item.status === worst);
  return { part, status: worst, severity: sev, evidence: failing.map((f) => f.item.evidence).join("; "), fix: fix ?? top.find((f) => f.item.fix)?.item.fix, items };
}
export const result = (part: PartId, actions: ApplyAction[], backups: string[] = [], skipped?: string): ApplyResult => ({ part, changed: actions.some((a) => a.kind !== "skip" && a.kind !== "print"), actions, backups, ...(skipped ? { skipped } : {}) });
export const upToDate = (part: PartId): ApplyResult => ({ part, changed: false, actions: [{ kind: "skip", what: "zaten güncel" }], backups: [] });
