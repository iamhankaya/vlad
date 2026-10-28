import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, nowIso, writeFileAtomic } from "../kb/index.js";

/** Night (authority) window and watch flag, kept in the kb (`mode.json`) so every VLAD session sees the same state. */
export interface NightMode { until: string; started: string; projects: string[]; note: string | null }
interface ModeFile { night: NightMode | null; watch: boolean }

const file = () => join(kbPaths().kb, "mode.json");

function read(): ModeFile {
  try {
    const o = JSON.parse(readFileSync(file(), "utf8")) as Partial<ModeFile>;
    return { night: o.night ?? null, watch: o.watch === true };
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
  return d;
}

export function setNight(o: { until: string; projects?: string[]; note?: string }, now: Date = new Date()): NightMode {
  const night: NightMode = { until: nowIso(parseUntil(o.until, now)), started: nowIso(now), projects: o.projects ?? [], note: o.note ?? null };
  write({ ...read(), night });
  return night;
}

export function setWatch(on: boolean): void {
  write({ ...read(), watch: on });
}

export function setOff(): void {
  rmSync(file(), { force: true });
}

export function modeStatus(now: Date): { night: NightMode | null; watch: boolean; watching: boolean; expired: boolean } {
  const m = read();
  const live = !!m.night && Date.parse(m.night.until) > now.getTime();
  return { night: live ? m.night : null, watch: m.watch, watching: live || m.watch, expired: !!m.night && !live };
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
    const hm = s.night.until.slice(11, 16);
    return `gece modu etkin (${hm}'e kadar${s.night.projects.length ? `; ${s.night.projects.join(", ")}` : ""}${s.night.note ? `; ${s.night.note}` : ""}), bekçi açık`;
  }
  if (s.expired) return "gece modu bitti: yetki penceresi doldu, sormadan merge yok";
  return s.watch ? "bekçi modu açık" : null;
}
