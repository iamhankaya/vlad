import { execFileSync } from "node:child_process";

/**
 * F-vlad-384: a worker's Android emulator outlived its task (6 orphans, 1-36 h, filled 16 GB RAM).
 * Ownership needs no registration: the emulator process inherits the worker's environment, so `VLAD_TASK_ID=<id>` sits in the
 * qemu process's environment (`ps eww`). An emulator is "owned" by a task only when that variable names it; anything without
 * it (the user's own emulator, an older worker) is never killed, only reported when it has been open for long.
 * Mac/Linux only: on Windows (no emulators there) every function is a silent no-op.
 */
export type EmuProc = { pid: number; port: number; ageSec: number; owner: string | null };
export type EmuAction = { port: number; pid: number; action: "adb" | "sigterm" | "sigkill" | "failed"; error?: string };

export type EmuDeps = {
  platform?: NodeJS.Platform;
  /** `ps eww -axo pid=,etime=,command=` output; null = unreadable */
  ps?: () => string | null;
  /** runs `adb <args>`; true = exit 0, false = adb answered with an error, null = adb is not installed */
  adb?: (args: string[]) => boolean | null;
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => void;
};

/** Short text for a closed emulator: `5700 (adb)`. */
export const emuLabel = (a: EmuAction): string => `${a.port} (${a.action}${a.error ? `: ${a.error}` : ""})`;

/** Default time an emulator may stay open without an active task before `status` warns (2 h). */
export const ORPHAN_AFTER_SEC = 2 * 3600;
const DEFAULT_PORT = 5554;
/** the emulator's main process (the helper processes crashpad_handler/netsimd carry no `-avd`) */
const MAIN = /(?:^|[\\/\s])qemu-system-\S*(?:\s.*)?\s-avd\s/;

/** ps etime `[[dd-]hh:]mm:ss` → seconds. */
function etimeSec(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

export function parseEmulators(psOut: string): EmuProc[] {
  const out: EmuProc[] = [];
  for (const raw of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(raw);
    if (!m || !MAIN.test(m[3]!)) continue;
    const port = /(?:^|\s)-port\s+(\d+)(?=\s|$)/.exec(m[3]!);
    const owner = /(?:^|\s)VLAD_TASK_ID=(T\d{8}-\d{2,})(?=\s|$)/.exec(m[3]!);
    out.push({ pid: Number(m[1]), port: port ? Number(port[1]) : DEFAULT_PORT, ageSec: etimeSec(m[2]!), owner: owner ? owner[1]! : null });
  }
  return out;
}

const defaults = (d: EmuDeps): Required<EmuDeps> => ({
  platform: d.platform ?? process.platform,
  ps: d.ps ?? (() => {
    // VLAD_NO_NATIVE=1 (tests): never look at the real process list, a fake task id could match a live worker's emulator
    if (process.env.VLAD_NO_NATIVE === "1") return null;
    try { return execFileSync("ps", ["eww", "-axo", "pid=,etime=,command="], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
  }),
  adb: d.adb ?? ((args) => {
    try { execFileSync("adb", args, { stdio: "ignore", timeout: 15_000 }); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : false; }
  }),
  kill: d.kill ?? ((pid, sig) => { process.kill(pid, sig); }),
  alive: d.alive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } }),
  sleep: d.sleep ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }),
});

/** Running emulators on this machine; [] on Windows or when the process list cannot be read. */
export function listEmulators(deps: EmuDeps = {}): EmuProc[] {
  const d = defaults(deps);
  if (d.platform === "win32") return [];
  const out = d.ps();
  return out === null ? [] : parseEmulators(out);
}

/** Waits (up to `ms`) until the pid is gone. */
function gone(d: Required<EmuDeps>, pid: number, ms: number): boolean {
  for (let waited = 0; ; waited += 250) {
    if (!d.alive(pid)) return true;
    if (waited >= ms) return false;
    d.sleep(250);
  }
}

/**
 * Closes the emulators owned by `taskId`: `adb -s emulator-<port> emu kill`, then SIGTERM of that qemu pid, last resort SIGKILL.
 * Other tasks' and unowned emulators are never touched; a missing adb or a failed kill is reported, never thrown.
 */
export function killTaskEmulators(taskId: string, deps: EmuDeps = {}): EmuAction[] {
  const d = defaults(deps);
  const results: EmuAction[] = [];
  for (const e of listEmulators(deps).filter((x) => x.owner === taskId)) {
    try {
      d.adb(["-s", `emulator-${e.port}`, "emu", "kill"]);
      if (gone(d, e.pid, 5000)) { results.push({ port: e.port, pid: e.pid, action: "adb" }); continue; }
      d.kill(e.pid, "SIGTERM");
      if (gone(d, e.pid, 3000)) { results.push({ port: e.port, pid: e.pid, action: "sigterm" }); continue; }
      d.kill(e.pid, "SIGKILL");
      results.push({ port: e.port, pid: e.pid, action: "sigkill" });
    } catch (err) {
      results.push({ port: e.port, pid: e.pid, action: "failed", error: (err as Error).message });
    }
  }
  return results;
}

/** Emulators not bound to an active task (finished task, or no owner) that have been open for at least `minAgeSec`. */
export function orphanEmulators(activeTaskIds: Set<string>, deps: EmuDeps = {}, minAgeSec = ORPHAN_AFTER_SEC): EmuProc[] {
  return listEmulators(deps).filter((e) => (e.owner === null || !activeTaskIds.has(e.owner)) && e.ageSec >= minAgeSec);
}

const ageText = (s: number): string => (s >= 86400 ? `${Math.floor(s / 86400)} gün` : s >= 3600 ? `${Math.floor(s / 3600)} sa` : `${Math.max(1, Math.floor(s / 60))} dk`);

export type EmulatorWarning = { orphans: { port: number; pid: number; ageSec: number; owner: string | null }[]; text: string };

/** One status line for orphaned emulators (port + age); null when there are none. Never closes anything. */
export function emulatorWarning(activeTaskIds: Set<string>, deps: EmuDeps = {}, minAgeSec = ORPHAN_AFTER_SEC): EmulatorWarning | null {
  const orphans = orphanEmulators(activeTaskIds, deps, minAgeSec);
  if (!orphans.length) return null;
  const list = orphans.map((e) => `${e.port} (${ageText(e.ageSec)}${e.owner ? `, ${e.owner} bitti` : ", sahipsiz"})`).join(", ");
  return {
    orphans,
    text: `${orphans.length} sahipsiz emülatör açık: ${list}; kapat: \`adb -s emulator-<port> emu kill\` (görev bitmişse \`vlad task cleanup <id>\` kapatır)`,
  };
}
