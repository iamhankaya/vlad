import { existsSync } from "node:fs";
import { getSection, loadConfig } from "../kb/index.js";
import { currentBranch, runGitRaw } from "../git/git.js";
import { standardBlocks } from "./blocks.js";
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

/** The "uncommitted changes" sentence of a resume prompt; a worker Agent fills it for its own worktree. */
export const dirtyLine = (dirty: string[]): string => dirty.length
  ? `Kaydedilmemiş değişiklikler var (${dirty.join(", ")}): incele, anlamlıysa WIP commit'le.`
  : "Kaydedilmemiş değişiklik yok.";

export function dirtyPaths(cwd: string): string[] {
  const status = runGitRaw(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]) ?? "";
  return status.split("\n").filter((l) => l.length >= 4).map((l) => l.slice(3));
}

/** Everything `task resume` needs from the kb; no worktree access (a remote worker checks its own, machines C1). */
export interface ResumePlan {
  id: string;
  branch: string;
  worktree: string | null;
  sessionId: string | null;
  tail: string[];
  /** "Yetki seviyen: …" line (plus the changed-authority block) */
  authority: string;
}

/**
 * kb half of a resume (writes: syncAutonomy; callers hold the kb lock). `running`/`stalled` only.
 * A task with a recorded worktree is local/worker-side; otherwise a session id means a cloud worker.
 */
export function resumePrepare(id: string): ResumePlan {
  const t = getTask(id);
  if (t.data.state !== "running" && t.data.state !== "stalled") {
    throw new Error(`yalnızca running/stalled görev sürdürülür (${t.data.state}): ${id}`);
  }
  const stale = syncAutonomy(t, loadConfig());
  const authority = `Yetki seviyen: \`${t.data.autonomy}\`` +
    (stale
      ? ` (config'ten güncellendi; önceki: ${stale}; bu satır en son gelen yetkidir). ` +
        standardBlocks({ taskId: id, autonomy: t.data.autonomy, parent: t.data.parent ?? null, mode: "local" })[0]
      : ".");
  return {
    id, branch: `vlad/${id}`, worktree: t.data.worktree ?? null, sessionId: t.data.session_id?.trim() || null,
    tail: logTail(t.body), authority,
  };
}

const tailTextOf = (plan: ResumePlan): string => (plan.tail.length ? plan.tail.join("\n") : "(ilerleme kaydı yok)");

/** The local resume prompt for a checked worktree; shared with a worker Agent that checks its own worktree. */
export function localResumePrompt(plan: ResumePlan, wt: string, dirty: string[]): string {
  const { id, branch, authority } = plan;
  return [
    `VLAD görev ${id} kaldığı yerden sürdürülüyor.`,
    authority,
    `Çalışma dizinin: ${wt} (branch ${branch}). Ana dizinde veya başka bir worktree'de ÇALIŞMA; önce bu dizine geç.`,
    "Önce `git status` ve `git branch --show-current` ile branch'i ve kaydedilmemiş değişiklikleri doğrula.",
    dirtyLine(dirty),
    `Son ilerleme kayıtları:\n${tailTextOf(plan)}`,
    "Kaldığın yerden devam et; her anlamlı adımda WIP commit + `vlad task log` \"kaldığım yer\" satırı yaz.",
  ].join("\n");
}

/** Worktree-reading half: the worktree must exist and sit on `vlad/<id>`; no worktree but a session id -> cloud. */
export function resumeLocalCheck(plan: ResumePlan): LocalResume | CloudResume {
  const { id, branch, authority } = plan;
  const wt = plan.worktree;
  if (wt) {
    if (!existsSync(wt)) throw new Error(`worktree yok: ${wt}; görev ${id} yerelde sürdürülemez`);
    const cur = currentBranch(wt);
    if (cur !== branch) throw new Error(`worktree yanlış branch'te (${cur ?? "bilinmiyor"}, beklenen ${branch}): ${wt}`);
    const dirty = dirtyPaths(wt);
    return { id, mode: "local", worktree: wt, branch, dirty, log_tail: plan.tail, prompt: localResumePrompt(plan, wt, dirty) };
  }

  const sid = plan.sessionId;
  if (sid) {
    const message = [
      `VLAD görev ${id} kaldığı yerden sürdürülüyor.`,
      authority,
      `Önce \`git status\` ve \`git branch --show-current\` ile \`${branch}\` üzerinde olduğunu ve kaydedilmemiş değişiklikleri doğrula; yanlış dizindeysen doğru checkout'a geç.`,
      `Son ilerleme kayıtları:\n${tailTextOf(plan)}`,
      "Kaldığın yerden devam et; protokol işaretlerini ([VLAD:LOG #n] …) kaldığın numaradan sürdür.",
    ].join("\n");
    return { id, mode: "cloud", action: "send_message", session_id: sid, message, args: { session_id: sid, message } };
  }
  throw new Error(`görev ${id} sürdürülemez: ne worktree ne session_id kayıtlı`);
}

/** Resume info for an interrupted task (pipeline spec §9a): prepare + local check in one go (the pre-machines behavior). */
export const resumeInfo = (id: string): LocalResume | CloudResume => resumeLocalCheck(resumePrepare(id));
