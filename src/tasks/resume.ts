import { existsSync } from "node:fs";
import { getSection, loadConfig } from "../kb/index.js";
import { currentBranch, runGitRaw } from "../git/git.js";
import { getTask, syncAutonomy } from "./store.js";

const TAIL = 5;

export interface LocalResume {
  id: string;
  mode: "local";
  worktree: string;
  branch: string;
  /** Uncommitted paths (git status --porcelain); the worker must commit them as WIP first. */
  dirty: string[];
  log_tail: string[];
  prompt: string;
}

export interface CloudResume {
  id: string;
  mode: "cloud";
  action: "send_message";
  session_id: string;
  message: string;
  /** Ready-made arguments for the `send_message` tool. */
  args: { session_id: string; message: string };
}

function logTail(body: string): string[] {
  const lines = (getSection(body, "## İlerleme") ?? "").split("\n").filter((l) => l.trim());
  return lines.slice(-TAIL);
}

function dirtyPaths(cwd: string): string[] {
  const status = runGitRaw(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]) ?? "";
  return status.split("\n").filter((l) => l.length >= 4).map((l) => l.slice(3));
}

/**
 * Resume info for an interrupted (`running`/`stalled`) task (pipeline spec §9a). A task with a
 * recorded worktree is local: the worktree must exist and sit on `vlad/<id>`. Otherwise a session
 * id means a cloud worker. Anything else is an error.
 */
export function resumeInfo(id: string): LocalResume | CloudResume {
  const t = getTask(id);
  if (t.data.state !== "running" && t.data.state !== "stalled") {
    throw new Error(`yalnızca running/stalled görev sürdürülür (${t.data.state}): ${id}`);
  }
  const stale = syncAutonomy(t, loadConfig());
  const authority = `Yetki seviyen: \`${t.data.autonomy}\`` +
    (stale ? ` (config'ten güncellendi; önceki: ${stale}, eskisini unut)` : "") + ".";
  const branch = `vlad/${id}`;
  const tail = logTail(t.body);
  const tailText = tail.length ? tail.join("\n") : "(ilerleme kaydı yok)";

  const wt = t.data.worktree;
  if (wt) {
    if (!existsSync(wt)) throw new Error(`worktree yok: ${wt}; görev ${id} yerelde sürdürülemez`);
    const cur = currentBranch(wt);
    if (cur !== branch) throw new Error(`worktree yanlış branch'te (${cur ?? "bilinmiyor"}, beklenen ${branch}): ${wt}`);
    const dirty = dirtyPaths(wt);
    const prompt = [
      `VLAD görev ${id} kaldığı yerden sürdürülüyor.`,
      authority,
      `Çalışma dizinin: ${wt} (branch ${branch}). Ana dizinde veya başka bir worktree'de ÇALIŞMA; önce bu dizine geç.`,
      "Önce `git status` ve `git branch --show-current` ile branch'i ve kaydedilmemiş değişiklikleri doğrula.",
      dirty.length
        ? `Kaydedilmemiş değişiklikler var (${dirty.join(", ")}): incele, anlamlıysa WIP commit'le.`
        : "Kaydedilmemiş değişiklik yok.",
      `Son ilerleme kayıtları:\n${tailText}`,
      "Kaldığın yerden devam et; her anlamlı adımda WIP commit + `vlad task log` \"kaldığım yer\" satırı yaz.",
    ].join("\n");
    return { id, mode: "local", worktree: wt, branch, dirty, log_tail: tail, prompt };
  }

  const sid = t.data.session_id?.trim();
  if (sid) {
    const message = [
      `VLAD görev ${id} kaldığı yerden sürdürülüyor.`,
      authority,
      `Önce \`git status\` ve \`git branch --show-current\` ile \`${branch}\` üzerinde olduğunu ve kaydedilmemiş değişiklikleri doğrula; yanlış dizindeysen doğru checkout'a geç.`,
      `Son ilerleme kayıtları:\n${tailText}`,
      "Kaldığın yerden devam et; protokol işaretlerini ([VLAD:LOG #n] …) kaldığın numaradan sürdür.",
    ].join("\n");
    return { id, mode: "cloud", action: "send_message", session_id: sid, message, args: { session_id: sid, message } };
  }
  throw new Error(`görev ${id} sürdürülemez: ne worktree ne session_id kayıtlı`);
}
