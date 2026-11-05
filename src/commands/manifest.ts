import type { CommandSpec, ConsolePolicy } from "./types.js";

/**
 * Single definition of every CLI command's policy (layer L1p: pure data, no handlers, no config reads).
 * KB_WRITES / REFRESH_KEYS / WORKER_LOCAL / FORWARD / INNER_LOCK / the console catalog are all derived from here (accessors.ts).
 * A new command needs one line; validateManifest + the Commander-tree completeness test fail without it.
 *
 * Defaults are the safe ones: no lock, no refresh, rejected on workers (fail-closed), json on. `console` has no default.
 * Deliberate pairings kept as they were before U1:
 *  - `mode status`: console `read` yet lock "outer" (it writes only as a side effect, an expired mode window).
 *  - `vlad status`: console `read`, exec "status" (own lock/mark branch in the CLI), no outer lock.
 *  - `task release`, `audit setup`: not in the console catalog and rejected on workers, now stated explicitly (was an implicit gap).
 */
const LOCAL = { kind: "local" } as const;
const none = (reason: string): ConsolePolicy => ({ kind: "none", reason });
const c = (path: readonly string[], o: Partial<Omit<CommandSpec, "path">> & Pick<CommandSpec, "console">): CommandSpec => ({
  path, registration: "def", exec: "standard", lock: "none", refresh: false, worker: { kind: "reject" }, json: true, ...o,
});

export const COMMANDS: readonly CommandSpec[] = [
  c(["scan"], { worker: LOCAL, console: { kind: "read" } }),
  c(["project", "write"], { lock: "outer", refresh: true, console: { kind: "write", fileFlags: ["--file"] } }),
  c(["project", "set"], { lock: "outer", console: { kind: "write" } }),
  c(["project", "note"], { lock: "outer", console: { kind: "write", fileFlags: ["--file"] } }),
  c(["project", "status"], { worker: LOCAL, console: { kind: "read" } }),
  c(["project", "summary"], { lock: "outer", console: { kind: "write", fileFlags: ["--file"] } }),
  c(["project", "refresh"], { lock: "outer", console: { kind: "write" } }),
  c(["project", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["finding", "add"], { lock: "outer", refresh: true, console: { kind: "write", fileFlags: ["--detail-file"] } }),
  c(["finding", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["finding", "set"], { lock: "outer", refresh: true, console: { kind: "write" } }),
  c(["role", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["task", "new"], { lock: "outer", console: { kind: "write", fileFlags: ["--body-file"] } }),
  c(["task", "launch"], { console: { kind: "write" } }),
  c(["task", "release"], { console: none("konsol kataloğunda yoktu (U1 öncesi de); konsolda açmak ayrı karar") }),
  c(["task", "ingest"], { lock: "outer", console: { kind: "write", fileFlags: ["--events-file","--file"] } }),
  c(["task", "log"], { lock: "outer", worker: { kind: "forward", op: "task.log" }, console: { kind: "write" } }),
  c(["task", "ask"], { lock: "outer", worker: { kind: "forward", op: "task.ask" }, console: { kind: "write" } }),
  c(["task", "answer"], { lock: "outer", console: { kind: "write" } }),
  c(["task", "report"], { lock: "outer", worker: { kind: "forward", op: "task.report" }, console: { kind: "write", fileFlags: ["--file"] } }),
  c(["task", "set"], { lock: "outer", refresh: true, console: { kind: "write" } }),
  c(["task", "deps"], { lock: "outer", console: { kind: "write" } }),
  c(["task", "resume"], { lock: "phased", console: { kind: "write" } }),
  c(["task", "close-window"], { worker: LOCAL, console: { kind: "write" } }),
  c(["task", "cleanup"], { lock: "phased", console: { kind: "write" } }),
  c(["task", "gate"], { console: { kind: "write", timeoutMs: 31 * 60_000 } }),
  c(["task", "merge-preview"], { console: { kind: "read" } }),
  c(["task", "merge"], { console: { kind: "write", timeoutMs: 6 * 60_000 } }),
  c(["task", "digested"], { lock: "outer", console: { kind: "write" } }),
  c(["task", "session"], { lock: "outer", worker: { kind: "forward", op: "task.session" }, console: { kind: "write" } }),
  c(["task", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["task", "idle"], { worker: LOCAL, console: { kind: "read" } }),
  c(["task", "ready"], { worker: LOCAL, console: { kind: "read" } }),
  c(["status"], { exec: "status", worker: LOCAL, console: { kind: "read" } }),
  c(["mode", "night"], { lock: "outer", console: { kind: "write" } }),
  c(["mode", "watch"], { lock: "outer", console: { kind: "write" } }),
  c(["mode", "off"], { lock: "outer", console: { kind: "write" } }),
  c(["mode", "status"], { lock: "outer", console: { kind: "read" } }),
  c(["audit", "skills"], { worker: LOCAL, console: { kind: "read" } }),
  c(["audit", "setup"], { console: none("konsol kataloğunda yoktu (U1 öncesi de); konsolda açmak ayrı karar") }),
  c(["inbox", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["inbox", "count"], { worker: LOCAL, console: { kind: "read" } }),
  c(["inbox", "done"], { lock: "outer", console: { kind: "write" } }),
  c(["digest", "pending", "add"], { lock: "outer", console: { kind: "write" } }),
  c(["digest", "pending", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["digest", "pending", "done"], { lock: "outer", console: { kind: "write" } }),
  c(["decision", "add"], { lock: "outer", refresh: true, console: { kind: "write", fileFlags: ["--body-file"] } }),
  c(["decision", "list"], { worker: LOCAL, console: { kind: "read" } }),
  c(["decision", "set"], { lock: "outer", refresh: true, console: { kind: "write" } }),
  c(["decision", "migrate"], { lock: "outer", console: { kind: "write" } }),
  c(["journal", "append"], { lock: "outer", console: { kind: "write", fileFlags: ["--file"] } }),
  c(["journal", "get"], { worker: LOCAL, console: { kind: "read" } }),
  c(["kb", "commit"], { console: { kind: "write" } }),
  c(["kb", "maintain"], { lock: "outer", console: { kind: "write" } }),
  c(["kb", "get"], { worker: LOCAL, console: { kind: "read" } }),
  c(["kb", "search"], { worker: LOCAL, console: { kind: "read" } }),
  c(["kb", "refs"], { worker: LOCAL, console: { kind: "read" } }),
  c(["kb", "lint"], { console: { kind: "read" } }),
  c(["kb", "check"], { worker: LOCAL, console: { kind: "read" } }),
  c(["session", "register"], { lock: "outer", console: { kind: "write" } }),
  c(["session", "name"], { worker: LOCAL, console: { kind: "read" } }),
  c(["agent", "start"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["agent", "status"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["agent", "keygen"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["agent", "setkey"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["agent", "install"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["queue", "list"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["queue", "flush"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["queue", "drop"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["remote"], { registration: "plain", console: none("konsolun kendi komutu; beyinde yeniden çalıştırılmaz"), json: false }),
  c(["machine", "list"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["machine", "ping"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["machine", "probe-window"], { worker: LOCAL, console: none("yerel makine yönetimi; konsol kataloğundan hariç") }),
  c(["send"], { worker: LOCAL, console: none("yerel pano/dosya aktarımı; konsol kataloğunda yok") }),
  c(["clip", "on"], { worker: LOCAL, console: none("yerel pano/dosya aktarımı; konsol kataloğunda yok") }),
  c(["clip", "off"], { worker: LOCAL, console: none("yerel pano/dosya aktarımı; konsol kataloğunda yok") }),
  c(["clip", "status"], { worker: LOCAL, console: none("yerel pano/dosya aktarımı; konsol kataloğunda yok") }),
  c(["clip", "get"], { worker: LOCAL, console: none("yerel pano/dosya aktarımı; konsol kataloğunda yok") }),
  c(["clip", "set"], { worker: LOCAL, console: none("yerel pano/dosya aktarımı; konsol kataloğunda yok") }),
  c(["install"], { worker: LOCAL, console: none("yerel kurulum; konsol kataloğundan hariç") }),
];
