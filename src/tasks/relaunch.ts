import { existsSync } from "node:fs";
import { getSection, currentMachine, kbPaths } from "../kb/index.js";
import { SESSION_ID } from "../launcher/stream.js";
import type { Launcher } from "../launcher/index.js";
import { roleFor, getTask, saveTask, setState } from "./store.js";
import type { Task } from "./store.js";

const ANSWER = /\*\*Cevap:\*\*\s*(.*)$/;

/** Newest `**Cevap:**` line of `## Sorular`, or null. */
export function lastAnswer(body: string): string | null {
  const lines = (getSection(body, "## Sorular") ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ANSWER.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

export function relaunchPrompt(id: string, answer: string | null): string {
  return [
    `VLAD görev ${id} kaldığı yerden sürdürülüyor (oturumun --resume ile geri geldi).`,
    answer !== null ? `Sorduğun soruya cevap geldi: ${answer}` : "Kesilmiş çalışma: son durumdan devam et.",
    "Önce `git status` ve `git branch --show-current` ile `vlad/<id>` branch'inde olduğunu doğrula; kaydedilmemiş değişiklik varsa incele.",
    "Kaldığın yerden devam et; her anlamlı adımda WIP commit + `vlad task log`.",
  ].join("\n");
}

/**
 * Restarts a task's worker with `claude --resume <session_id>` (ask -> process exits -> `answer` -> relaunch).
 * Only a task that is `running` (answered) or `stalled` and was launched on this machine; the session id comes
 * from the stream tap and is validated before it reaches the launch script. A `stalled` task goes back to `running`
 * once the launcher accepted.
 */
export async function relaunchTask(id: string, o: { launcher: Launcher }): Promise<Task> {
  const t = getTask(id);
  if (t.data.kind !== "dev") throw new Error(`yalnızca dev görevleri yeniden başlatılır (kind=${t.data.kind}): ${id}`);
  if (t.data.state === "blocked") throw new Error(`görev ${id} soru bekliyor; önce \`vlad task answer\` ile cevapla`);
  if (t.data.state !== "running" && t.data.state !== "stalled") {
    throw new Error(`yalnızca running/stalled görev yeniden başlatılır (${t.data.state}): ${id}`);
  }
  const here = currentMachine();
  if (!t.data.host) throw new Error(`görev ${id} yeniden başlatılamaz: host kayıtlı değil (bu makinede başlatıldığı bilinmiyor)`);
  if (t.data.host !== here) {
    throw new Error(`görev ${id} başka makinede başlatılmış (${t.data.host}); bu makine: ${here}`);
  }
  const sid = t.data.session_id?.trim();
  if (!sid) throw new Error(`görev ${id} yeniden başlatılamaz: session_id kayıtlı değil (çıktı \`vlad worker tap\` ile süzülmemiş olabilir)`);
  if (!SESSION_ID.test(sid)) throw new Error(`görev ${id}: kayıtlı session_id geçersiz: ${JSON.stringify(sid)}`);
  const wt = t.data.worktree;
  if (!wt || !existsSync(wt)) throw new Error(`worktree yok${wt ? `: ${wt}` : ""}; görev ${id} yeniden başlatılamaz`);

  const role = t.data.role ? roleFor(t.data.role, t.data.kind) : undefined;
  const res = await o.launcher.launch({
    taskId: id, cwd: wt, prompt: relaunchPrompt(id, lastAnswer(t.body)),
    env: { VLAD_TASK_ID: id, VLAD_HOME: kbPaths().home },
    title: `VLAD ${id} — ${t.data.title}`, resumeSessionId: sid, tap: true,
    ...(role?.model ? { model: role.model } : {}),
  });
  if (!res.ok) throw new Error(`launcher başarısız (${res.method}): ${res.detail ?? "bilinmeyen hata"}`);
  if (t.data.state === "stalled") return setState(id, "running", { error: null });
  const cur = getTask(id);
  cur.data.error = null;
  saveTask(cur);
  return cur;
}
