import { execFileSync } from "node:child_process";
import { RemoteError } from "../../fleet/types.js";
import { NoWindowError, nudgeVia, tmuxPane, type NudgePane, type NudgeResult } from "../../tasks/nudge.js";
import { assertRealLauncherAllowed } from "../../launcher/mode.js";
import { winPane, type WinRun } from "../../tasks/nudge-win.js";
import { argObject, bad, taskIdArg } from "./worker.js";

/** Dürtme metni üst sınırı: tek satır istem; daha uzunu çalışan penceresinde işe yaramaz. */
export const NUDGE_MAX_TEXT = 4000;

export interface NudgeOpDeps {
  platform?: NodeJS.Platform;
  /** test dikişi: pencere soyutlaması (varsayılan: win32 → konsol, diğerleri → tmux `vlad-<id>`) */
  pane?: (taskId: string) => NudgePane;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/** Gerçek powershell çağrısı; VLAD_LAUNCHER=noop (test/guard) ortamında gerçek pencereye dokunmayı reddeder (closeWorkerWindow ile aynı kapı). */
const realWinRun: WinRun = (file, args, env) => {
  assertRealLauncherAllowed();
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
};

const realTmux = (args: string[]): string => execFileSync("tmux", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

/**
 * `nudge` op'u (beyin → işçi Agent; F-vlad-370): işçi makinedeki çalışanın penceresine tek satır metin yazar, Enter'ı kutu boşalana
 * kadar tekrarlar ve teslimi doğrular (`delivered`). Metin yalnız bu görevin penceresine gider: hedef `taskId` biçimiyle sınırlı,
 * pencere/oturum adı istekten gelmez.
 */
export async function nudgeOp(args: unknown, d: NudgeOpDeps = {}): Promise<NudgeResult> {
  const a = argObject(args, ["taskId", "text"]);
  const taskId = taskIdArg(a);
  if (typeof a.text !== "string" || a.text.length === 0 || a.text.length > NUDGE_MAX_TEXT) throw bad(`text 1-${NUDGE_MAX_TEXT} karakter olmalı`);
  if (/[\r\n]/.test(a.text)) throw bad("text tek satır olmalı");
  const platform = d.platform ?? process.platform;
  const pane = d.pane ? d.pane(taskId) : platform === "win32" ? winPane(taskId, realWinRun) : tmuxPane(taskId, realTmux);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    return await nudgeVia(pane, a.text, sleep, d.settleMs === undefined ? {} : { settleMs: d.settleMs });
  } catch (e) {
    if (e instanceof RemoteError) throw e;
    if (e instanceof NoWindowError) throw new RemoteError("not_found", `not_found: ${e.message}`);
    throw new RemoteError("failed", `failed: ${(e as Error).message}`);
  }
}
