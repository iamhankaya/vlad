import { execFileSync, spawn } from "node:child_process";
import { dirname, posix, win32 } from "node:path";
import { worktreePath } from "../git/git.js";
import type { VladConfig } from "../kb/index.js";
import { trustScreenShown, tmuxPane } from "./nudge.js";
import { winPane } from "./nudge-win.js";
import { trustRecorded, trustWorktree } from "./trust.js";

/**
 * F-vlad-335: çalışan güven ekranında takılmasın. Canlı Claude süreçleri ~/.claude.json'u kilitsiz, eski kopyayla yeniden yazıp
 * VLAD'ın güven kaydını silebilir; (1) launch sonrası kısa bir pencerede kayıt yoklanıp yeniden yazılır, (2) ekran yine de çıkarsa
 * VLAD'ın kendi penceresine tek Enter gönderilir ("Yes, I trust this folder" varsayılan seçenek). Yalnız VLAD'ın kendi worktree'si için.
 */

/** Eşzamanlı pencere: tmux oturumu ya da Windows konsolu (ikisi de yapısı gereği eşzamanlı çalışır). */
export interface SyncPane {
  /** pencere yoksa fırlatır */
  exists(): void;
  capture(): string;
  enter(): void;
}

/** Pencere güven ekranını gösteriyorsa tek Enter yollar (metin yazılmaz); ekran kalktıysa true. Kalkmadıysa tekrar basılmaz. */
export function approveTrustSync(pane: SyncPane, sleepSync: (ms: number) => void): boolean {
  try {
    pane.exists();
    if (!trustScreenShown(pane.capture())) return false;
    pane.enter();
    sleepSync(1500);
    return !trustScreenShown(pane.capture());
  } catch { return false; }
}

// test guard (same rule as launcher/mode.ts realLauncherBlocked; not imported: tasks must not depend on the launcher layer)
const guardReal = (): void => {
  if (process.env.VLAD_LAUNCHER === "noop" && process.env.VLAD_ALLOW_REAL_LAUNCHER !== "1") throw new Error("VLAD_LAUNCHER=noop: gerçek çalışan penceresine dokunmak yasak");
};
const realWinRun = (file: string, args: string[], env: Record<string, string>): string => {
  guardReal();
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
};
const realTmux = (args: string[]): string => guardReal() ?? execFileSync("tmux", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

/** Görevin gerçek penceresi: win32 → konsol (`\vlad\<id>.ps1` süreci), diğerleri → tmux `vlad-<id>`. */
export function platformPane(taskId: string, platform: NodeJS.Platform = process.platform): SyncPane {
  // winPane/tmuxPane yöntemleri eşzamanlıdır (execFileSync); NudgePane türü yalnız async dürtmeyi de kapsadığı için geniş
  return (platform === "win32" ? winPane(taskId, realWinRun) : tmuxPane(taskId, realTmux)) as unknown as SyncPane;
}

const norm = (p: string, os: "win32" | "posix"): string => (os === "win32" ? win32.normalize(p).replaceAll("\\", "/").toLowerCase() : posix.normalize(p)).replace(/\/+$/, "");

/**
 * Bu worktree VLAD'ın bu görev için açtığı yol mu? `worktreeDir` kalıbından türeyen beklenen yolla aynı olmalı (başka bir klasör
 * ya da başka görevin yolu için tuş gönderilmez). Kart yolu yoksa (repoPath null) sahiplenilmez.
 */
export function ownsWorktree(t: { id: string; worktree: string; repoPath: string | null }, cfg: VladConfig, platform: NodeJS.Platform = process.platform): boolean {
  if (!t.repoPath || !t.worktree || /(^|[\\/])\.\.([\\/]|$)/.test(t.worktree)) return false;
  const os = platform === "win32" ? "win32" : "posix";
  const expected = worktreePath(cfg, t.repoPath, t.id, platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux");
  return norm(t.worktree, os) === norm(expected, os) && norm(dirname(t.worktree.replaceAll("\\", "/")), os) === norm(dirname(expected.replaceAll("\\", "/")), os);
}

export interface GuardDeps {
  recorded(dir: string): boolean;
  /** kaydı yeniden yazar; uyarı ya da null */
  rewrite(dir: string): string | null;
  /** yoksa güven ekranı onayı denenmez */
  pane?: SyncPane;
  sleep(ms: number): Promise<void>;
  now(): number;
  sleepSync(ms: number): void;
  log(msg: string): void;
}

export interface GuardResult { rewrites: number; approved: boolean }

/**
 * Pencere (`windowMs`, varsayılan 45 sn) boyunca her `intervalMs`'de: kayıt yoksa yeniden yaz; pane güven ekranındaysa bir kez onayla.
 * Pencere sonuna kadar izler (kayıt, çalışan başladıktan sonra da silinebilir).
 */
export async function guardTrust(o: { dir: string; taskId: string; windowMs?: number; intervalMs?: number }, d: GuardDeps): Promise<GuardResult> {
  const deadline = d.now() + (o.windowMs ?? 45_000);
  const interval = o.intervalMs ?? 3_000;
  const res: GuardResult = { rewrites: 0, approved: false };
  for (;;) {
    if (!d.recorded(o.dir)) {
      res.rewrites++;
      const w = d.rewrite(o.dir);
      d.log(`güven kaydı kayboldu, yeniden yazıldı (F-vlad-335)${w ? `; uyarı: ${w}` : ""}`);
    }
    if (!res.approved && d.pane && approveTrustSync(d.pane, d.sleepSync)) {
      res.approved = true;
      d.log("güven ekranı otomatik onaylandı (D-vlad-087, F-vlad-335; çalışan penceresine Enter gönderildi)");
    }
    if (d.now() >= deadline) return res;
    await d.sleep(interval);
  }
}

/** `node -e` tek satırı (argv[1] = bu modülün file URL'si, argv[2] = görev id): launch sonrası ayrık gözetçi. Çift tırnak yok (PowerShell 5.1). */
export const TRUST_GUARD_JS = `import(process.argv[1]).then(m=>m.runTrustGuardCli(process.argv[2])).catch(()=>{})`;

/**
 * Launch/resume sonrası ayrık gözetçiyi başlatır (CLI beklemez, çıkışı etkilemez); süreç açılamazsa sessizce atlanır.
 * Çağıran yalnız gerçek pencere açtığında çağırır (dry-run, external, kuyruk ve noop değil).
 */
export function startTrustGuard(taskId: string): boolean {
  try {
    const url = new URL("./trust-guard.js", import.meta.url).href;
    const child = spawn(process.execPath, ["-e", TRUST_GUARD_JS, url, taskId], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}

/** Ayrık gözetçinin gövdesi: görevi kb'den okur, sahipliği doğrular, pencere boyunca korur. Hiç fırlatmaz. */
export async function runTrustGuardCli(taskId: string, o: { windowMs?: number; intervalMs?: number } = {}): Promise<void> {
  try {
    const { loadConfig, readDoc, kbPaths } = await import("../kb/index.js");
    const { getTask, logTask } = await import("./store.js");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const t = getTask(taskId);
    const wt = t.data.worktree;
    if (!wt || t.data.state !== "running") return;
    const card = join(kbPaths().projects, `${t.data.project}.md`);
    const repoPath = existsSync(card) ? (readDoc<{ path?: string }>(card).data.path ?? null) : null;
    if (!ownsWorktree({ id: taskId, worktree: wt, repoPath }, loadConfig())) return;
    await guardTrust({ dir: wt, taskId, ...o }, {
      recorded: (dir) => trustRecorded(dir),
      rewrite: (dir) => trustWorktree(dir),
      pane: platformPane(taskId),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      sleepSync: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
      log: (m) => { try { logTask(taskId, m); } catch { /* kb meşgul: kayıt bırakılır, koruma yine de çalıştı */ } },
    });
  } catch { /* gözetçi en iyi çabadır */ }
}
