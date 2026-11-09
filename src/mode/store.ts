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
const TERMINAL = ["done", "cancelled"];
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
  const d = new Date(s);
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
  for (const id of untilTasks) getTask(id); // throws "görev bulunamadı"
  const until = o.until ? parseUntil(o.until, now) : new Date(now.getTime() + 24 * 3_600_000); // task-bound window keeps the 24 h ceiling
  const except = [...new Set([...DEFAULT_EXCEPT, ...(o.except ?? []).map((x) => x.trim()).filter(Boolean)])];
  const night: NightMode = { until: nowIso(until), started: nowIso(now), projects: o.projects ?? [], note: o.note ?? null, push: o.push === true, except, untilTasks };
  write({ ...read(), night });
  return night;
}

export function setWatch(on: boolean, now: Date = new Date()): void {
  write({ night: modeStatus(now).night, watch: on }); // an elapsed window is dropped here, not announced a second time
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
    const push = n.push ? `push yetkisi açık (yalnız gate/CI yeşil, açık P1 yok; istisna: ${n.except.join(",")})` : "push yok";
    return `gece modu etkin (${bound}${n.projects.length ? `; ${n.projects.join(", ")}` : ""}${n.note ? `; ${n.note}` : ""}; ${push}), bekçi açık`;
  }
  if (s.expired) {
    if (s.timedOut && s.remaining.length) return `gece modu bitti: süre doldu, açık görev: ${s.remaining.join(", ")}; devam için kullanıcı yenilemeli, sormadan merge yok`;
    return `gece modu bitti: ${s.timedOut ? "yetki penceresi doldu" : "görevler bitti"}, sormadan merge yok`;
  }
  return s.watch ? "bekçi modu açık" : null;
}
