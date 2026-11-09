import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, nowIso, writeFileAtomic } from "../kb/index.js";
import { getTask } from "../tasks/store.js";

/** Night (authority) window and watch flag, kept in the kb (`mode.json`) so every VLAD session sees the same state. */
export interface NightMode {
  until: string; started: string; projects: string[]; note: string | null;
  /** master/main merge+push authority (D-genel-013 successor); false = the old rule: push/PR is never part of the mode */
  push: boolean;
  /** action classes the window never opens; always includes DEFAULT_EXCEPT */
  except: string[];
  /** window also closes once all of these tasks are done/cancelled; `until` stays as the 24 h safety ceiling */
  untilTasks: string[];
}
/** Irreversible classes: always excepted, `--except` can only add to them. */
export const DEFAULT_EXCEPT = ["deploy", "backfill", "keychain"];
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const TERMINAL = ["done", "cancelled", "failed"]; // failed will not finish by itself: it must not hold authority open
/** Unknown/unreadable task counts as finished: a dangling ID must not keep authority open. */
const taskOpen = (id: string): boolean => { try { return !TERMINAL.includes(getTask(id).data.state); } catch { return false; } };
interface ModeFile { night: NightMode | null; watch: boolean }

const file = () => join(kbPaths().kb, "mode.json");

function read(): ModeFile {
  try {
    const o = JSON.parse(readFileSync(file(), "utf8")) as Partial<ModeFile>;
    const n = o.night;
    const night: NightMode | null = n && typeof n.until === "string"
      ? { ...n, projects: list(n.projects), note: n.note ?? null, push: n.push === true, except: [...new Set([...DEFAULT_EXCEPT, ...list(n.except)])], untilTasks: list(n.untilTasks) }
      : null;
    return { night, watch: o.watch === true };
  } catch {
    return { night: null, watch: false }; // missing or corrupt file = mode off
  }
}

function write(m: ModeFile): void {
  if (!m.night && !m.watch) rmSync(file(), { force: true });
  else writeFileAtomic(file(), JSON.stringify(m, null, 2) + "\n");
}

/** A running worker (VLAD_TASK_ID set) must not open or change its own authority window. */
export function assertNotWorker(env: Record<string, string | undefined> = process.env): void {
  if (env.VLAD_TASK_ID?.trim()) throw new Error("çalışan oturumu mod yazamaz (VLAD_TASK_ID tanımlı); yetki penceresini yalnız VLAD/kullanıcı açar");
}

/** `HH:MM` = the next such local time (today if still ahead, else tomorrow); otherwise an ISO date-time in the future. */
export function parseUntil(s: string, now: Date): Date {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (hm) {
    const [h, m] = [Number(hm[1]), Number(hm[2])];
    if (h > 23 || m > 59) throw new Error(`geçersiz saat: ${s}`);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim()); // bare date = local midnight (new Date(s) would read it as UTC)
  const d = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(s);
  if (Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(s.trim())) throw new Error(`geçersiz bitiş: ${s} (HH:MM veya ISO tarih-saat)`);
  if (d <= now) throw new Error(`bitiş geçmişte: ${s}`);
  if (d.getTime() - now.getTime() > 24 * 3_600_000) throw new Error(`bitiş 24 saatten uzak: ${s} (pencere en çok 24 saat)`);
  return d;
}

export function setNight(
  o: { until?: string; untilTasks?: string[]; push?: boolean; except?: string[]; projects?: string[]; note?: string },
  now: Date = new Date(),
): NightMode {
  const untilTasks = o.untilTasks ?? [];
  if (!o.until && !untilTasks.length) throw new Error("--until ya da --until-task ver");
  for (const id of untilTasks) { if (!/^T\d{8}-\d+$/.test(id)) throw new Error(`geçersiz görev ID'si: ${id}`); getTask(id); } // getTask throws "görev bulunamadı"
  const until = o.until ? parseUntil(o.until, now) : new Date(now.getTime() + 24 * 3_600_000); // task-bound window keeps the 24 h ceiling
  const added = (o.except ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const x of added) if (!/^[\p{L}\p{N}_-]+$/u.test(x)) throw new Error(`geçersiz istisna sınıfı: ${x}`);
  const except = [...new Set([...DEFAULT_EXCEPT, ...added])];
  const night: NightMode = { until: nowIso(until), started: nowIso(now), projects: o.projects ?? [], note: o.note ?? null, push: o.push === true, except, untilTasks };
  write({ ...read(), night });
  return night;
}

/** Returns true when an elapsed night window was dropped by this write (caller announces it). */
export function setWatch(on: boolean, now: Date = new Date()): boolean {
  const s = modeStatus(now);
  write({ night: s.night, watch: on });
  return s.expired;
}

export function setOff(): void {
  rmSync(file(), { force: true });
}

export function modeStatus(now: Date): { night: NightMode | null; watch: boolean; watching: boolean; expired: boolean; remaining: string[]; timedOut: boolean } {
  const m = read();
  const remaining = (m.night?.untilTasks ?? []).filter(taskOpen);
  const timedOut = !!m.night && Date.parse(m.night.until) <= now.getTime();
  const tasksDone = !!m.night && m.night.untilTasks.length > 0 && remaining.length === 0;
  const live = !!m.night && !timedOut && !tasksDone;
  return { night: live ? m.night : null, watch: m.watch, watching: live || m.watch, expired: !!m.night && !live, remaining, timedOut };
}

/** Drops an elapsed night window (keeps an explicit watch flag); true if there was one. */
export function expireMode(now: Date): boolean {
  if (!modeStatus(now).expired) return false;
  write({ ...read(), night: null });
  return true;
}

/** One-line state for `vlad status` and the SessionStart summary; null when nothing is on. */
export function modeLine(now: Date): string | null {
  const s = modeStatus(now);
  if (s.night) {
    const n = s.night;
    const until = n.until.slice(5, 16).replace("T", " "); // MM-DD HH:MM: a window that rolled into tomorrow shows
    const bound = s.remaining.length ? `${s.remaining.join(", ")} bitene ya da ${until} tavanına kadar` : `${until}'e kadar`;
    const push = n.push ? `push yetkisi açık${n.projects.length ? "" : " (tüm projeler)"} (yalnız gate/CI yeşil, açık P1 yok; istisna: ${n.except.join(",")})` : "push yok";
    return `gece modu etkin (${bound}${n.projects.length ? `; ${n.projects.join(", ")}` : ""}${n.note ? `; ${n.note}` : ""}; ${push}), bekçi açık`;
  }
  if (s.expired) {
    if (s.timedOut && s.remaining.length) return `gece modu bitti: süre doldu, açık görev: ${s.remaining.join(", ")}; devam için kullanıcı yenilemeli, sormadan merge yok`;
    return `gece modu bitti: ${s.timedOut ? "yetki penceresi doldu" : "görevler bitti"}, sormadan merge yok`;
  }
  return s.watch ? "bekçi modu açık" : null;
}
