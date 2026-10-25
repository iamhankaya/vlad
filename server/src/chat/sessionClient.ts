import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensureDir, fsyncDir } from "../auth/files.ts";

/** A line longer than this is dropped whole (same limit as the worker tap, src/launcher/stream.ts). */
export const MAX_LINE_BYTES = 1024 * 1024;
/** What `--resume <id>` may be given: no leading `-`, no shell/argv metacharacters. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
/** Variables the child `claude` gets; nothing else leaks in (S6c `runVlad` principle). The inherited `CLAUDE_CODE_*` ones would bind its session to the parent's (D0A). */
export const CHILD_ENV_KEYS = ["PATH", "HOME", "VLAD_HOME", "VLAD_KB_DIR"] as const;
const STDERR_TAIL = 4096;

export type ChatStreamEvent =
  | { kind: "session"; sessionId: string }
  /** A piece of the assistant's reply text (partial delta, or a whole text block when no partials were streamed). */
  | { kind: "delta"; text: string }
  /** The model or a tool ran (assistant/stream/tool-result line). Before the first one a failed turn has had no side effects. */
  | { kind: "activity" }
  /** `limit` is set when the turn ended on the subscription limit. */
  | { kind: "result"; ok: boolean; text: string | null; errors: string[]; limit: { until: string | null } | null }
  | { kind: "limit"; until: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const epochIso = (sec: unknown): string | null =>
  typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null;

/**
 * SYNTHETIC: the only `rate_limit_info.status` ever captured is `allowed` (D0A); these are guesses, like in
 * src/launcher/stream.ts. An unknown value is ignored, never invents a limit.
 */
const LIMIT_STATUSES = new Set(["rejected", "blocked", "exceeded", "limit_reached"]);
const LIMIT_TEXT = /usage limit reached(?:\|(\d{9,11}))?/i;

/** Per-turn interpreter of stream-json lines. Unknown `type`/`subtype` and malformed lines yield nothing (versions differ). */
export class TurnParser {
  private partialSeen = false;

  line(raw: string): ChatStreamEvent[] {
    let j: unknown;
    try { j = JSON.parse(raw); } catch { return []; }
    if (!isObj(j)) return [];
    const out: ChatStreamEvent[] = [];
    const sid = j.session_id;
    if (typeof sid === "string" && SESSION_ID.test(sid) && (j.type === "result" || (j.type === "system" && j.subtype === "init"))) {
      out.push({ kind: "session", sessionId: sid });
    }
    if (j.type === "assistant" || j.type === "stream_event" || j.type === "user") out.push({ kind: "activity" });
    if (j.type === "stream_event" && isObj(j.event) && j.event.type === "content_block_delta" && isObj(j.event.delta)) {
      const d = j.event.delta;
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        this.partialSeen = true;
        out.push({ kind: "delta", text: d.text });
      }
    } else if (j.type === "assistant" && isObj(j.message) && Array.isArray(j.message.content)) {
      // With partials the text already streamed as deltas; the whole block would duplicate it.
      if (!this.partialSeen) {
        for (const b of j.message.content) if (isObj(b) && b.type === "text" && typeof b.text === "string" && b.text) out.push({ kind: "delta", text: b.text });
      }
      this.partialSeen = false;
    } else if (j.type === "rate_limit_event" && isObj(j.rate_limit_info)) {
      const info = j.rate_limit_info;
      if (typeof info.status === "string" && LIMIT_STATUSES.has(info.status)) {
        const win = isObj(info.unifiedWindows) && typeof info.rateLimitType === "string" ? info.unifiedWindows[info.rateLimitType] : undefined;
        out.push({ kind: "limit", until: epochIso(info.resetsAt) ?? (isObj(win) ? epochIso(win.resetsAt) : null) });
      }
    } else if (j.type === "result") {
      const text = typeof j.result === "string" ? j.result : null;
      const errors = Array.isArray(j.errors) ? j.errors.filter((e): e is string => typeof e === "string").slice(0, 5) : [];
      const m = j.is_error === true && text ? LIMIT_TEXT.exec(text) : null;
      out.push({
        kind: "result",
        ok: j.subtype === "success" && j.is_error !== true,
        text, errors,
        limit: m ? { until: m[1] ? epochIso(Number(m[1])) : null } : null,
      });
    }
    return out;
  }
}

/**
 * Incremental line splitter. Bytes may split anywhere, even inside a UTF-8 sequence (StringDecoder holds the partial
 * bytes); an unfinished last line waits for its newline and is ignored at the end; a line over MAX_LINE_BYTES is dropped up to its newline.
 */
export class LineSplitter {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  private skipping = false;

  push(chunk: Buffer | string): string[] {
    const lines: string[] = [];
    const parts = (this.buf + (typeof chunk === "string" ? chunk : this.decoder.write(chunk))).split("\n");
    this.buf = parts.pop() ?? "";
    for (const raw of parts) {
      if (this.skipping) { this.skipping = false; continue; } // tail of an oversized line
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      lines.push(line);
    }
    if (Buffer.byteLength(this.buf) > MAX_LINE_BYTES) { this.buf = ""; this.skipping = true; }
    return lines;
  }
}

/** The chat's `claude` session id on disk, in the API state directory (the agent must not be able to write it). Anything that is not a plain id reads as "no session". */
export class SessionStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  get(): string | null {
    try {
      const id = readFileSync(this.path, "utf8").trim();
      return SESSION_ID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  set(id: string): void {
    if (!SESSION_ID.test(id)) throw new Error("invalid session id");
    ensureDir(dirname(this.path));
    const tmp = join(dirname(this.path), `.chat-session.${randomBytes(4).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, `${id}\n`); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
    fsyncDir(dirname(this.path));
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export const sessionFileFor = (stateDir: string) => join(stateDir, "chat-session.txt");

export interface TurnRequest {
  /** Resume this session; null starts a new one. Must match {@link SESSION_ID}. */
  sessionId: string | null;
  text: string;
}

export type TurnOutcome =
  | { kind: "exit"; exitCode: number | null; signal: string | null; stderr: string }
  | { kind: "aborted"; stderr: string }
  | { kind: "spawn"; error: string };

/** One chat turn = one child process. The runner depends on this interface only; S11x can put a persistent process behind it. */
export interface TurnClient {
  run(req: TurnRequest, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal): Promise<TurnOutcome>;
}

export interface ClaudeClientOptions {
  /** Executable (default `claude`). Never run through a shell. */
  bin?: string;
  /** Working directory of every turn = the kb root, the only tree the agent may read: required, absolute, existing. Checked at construction and before each turn. */
  cwd: string;
  /** Absolute directories the agent must not read or write (API state dir, ...); added to the fixed deny list. */
  protect?: string[];
  /** Environment to pick {@link CHILD_ENV_KEYS} from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** The chat agent's fixed deny list, applied twice (`--settings` and `--disallowedTools`): a settings file it could edit would not hold. */
const DENY = [
  "Bash(git push*)", "Bash(git -C*push*)", "Bash(gh *)", "WebFetch", "Bash(rm:*)", "Bash(rm *)", "Bash(find * -delete*)",
  "Bash(python* -c*)", "Bash(node -e*)", "Bash(node *)", "Bash(npx *)", "Bash(curl*)", "Bash(wget*)", "Bash(env *)",
  "Bash(*/var/lib/vladapi*)", "Bash(*~/.vlad-server*)", "Bash(*~/.claude*)", "Bash(cat *.env*)", "Bash(* .env*)",
  "Edit(**/deploy/**)", "Write(**/deploy/**)", "Edit(**/worker-settings.json)", "Write(**/worker-settings.json)",
  "Edit(**/.claude/**)", "Write(**/.claude/**)", "Edit(**/.mcp.json)", "Write(**/.mcp.json)",
];
const PROTECTED = ["//var/lib/vladapi/**", "~/.vlad-server/**", "~/.claude/**"];

/** Permission rules of a chat turn: read tools and `vlad *` only; everything that edits, publishes or reaches the network is denied. */
const absGlob = (d: string) => `/${d.replace(/\/+$/, "")}/**`; // `//abs/path/**`: the rule syntax for an absolute path

export function chatPermissions(kbDir: string, protect: string[] = []): { allow: string[]; deny: string[] } {
  // Reads are scoped to the kb root (the turn's cwd): a read of any other absolute path is not allowed.
  const kb = absGlob(kbDir);
  const allow = [`Read(${kb})`, `Grep(${kb})`, `Glob(${kb})`, "Bash(vlad *)"];
  const dirs = [...PROTECTED, ...protect.map(absGlob)];
  const deny = [...DENY];
  for (const d of dirs) for (const t of ["Read", "Edit", "Write"]) deny.push(`${t}(${d})`);
  return { allow, deny };
}

/**
 * The argv of a turn (exported for tests). The prompt is not in it: it goes to stdin, so no text can ever be parsed as an option.
 * Permissions are built here, not read from a file the agent could edit: inline `--settings` JSON plus `--disallowedTools`.
 */
export function turnArgs(sessionId: string | null, kbDir: string, protect: string[] = []): string[] {
  if (!isAbsolute(kbDir)) throw new Error("chat: kb dir must be absolute");
  if (sessionId !== null && !SESSION_ID.test(sessionId)) throw new Error("invalid session id");
  const perm = chatPermissions(kbDir, protect);
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "auto",
    "--settings", JSON.stringify({ permissions: perm }),
    "--disallowedTools", ...perm.deny,
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function childEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_KEYS) if (src[k]) env[k] = src[k];
  return env;
}

/** `claude -p --resume <id> --output-format stream-json` as a child process without a shell; stdin carries the prompt. */
export class ClaudeCliClient implements TurnClient {
  private readonly opts: ClaudeClientOptions;
  constructor(opts: ClaudeClientOptions) {
    if (typeof opts.cwd !== "string" || !isAbsolute(opts.cwd) || !isDir(opts.cwd)) throw new Error("chat: cwd must be an absolute, existing directory");
    for (const d of opts.protect ?? []) if (!isAbsolute(d)) throw new Error("chat: protect paths must be absolute");
    this.opts = opts;
  }

  run(req: TurnRequest, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal): Promise<TurnOutcome> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ kind: "aborted", stderr: "" });
      let argv: string[];
      if (!isDir(this.opts.cwd)) return resolve({ kind: "spawn", error: "cwd" });
      try { argv = turnArgs(req.sessionId, this.opts.cwd, this.opts.protect); } catch (e) { return resolve({ kind: "spawn", error: (e as Error).message }); }
      const child = spawn(this.opts.bin ?? "claude", argv, {
        cwd: this.opts.cwd, env: childEnv(this.opts.env), stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true,
      });
      const split = new LineSplitter();
      const parser = new TurnParser();
      let stderr = "";
      let aborted = false;
      let settled = false;
      const done = (o: TurnOutcome) => { if (!settled) { settled = true; signal.removeEventListener("abort", kill); resolve(o); } };
      // The whole group: tools the turn started must not outlive it, on abort and on a normal end alike.
      const killGroup = () => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ESRCH: nothing left */ } }
      };
      const kill = () => { aborted = true; killGroup(); };
      child.on("exit", killGroup);
      signal.addEventListener("abort", kill, { once: true });
      child.on("error", (e) => done({ kind: "spawn", error: (e as NodeJS.ErrnoException).code ?? e.message }));
      child.stdin.on("error", () => { /* child exited before reading the prompt */ });
      child.stdin.end(req.text);
      child.stdout.on("data", (c: Buffer) => {
        for (const line of split.push(c)) for (const ev of parser.line(line)) {
          try { onEvent(ev); } catch { /* a consumer bug never kills the turn */ }
        }
      });
      child.stderr.on("data", (c: Buffer) => { stderr = (stderr + c.toString("utf8")).slice(-STDERR_TAIL); });
      child.on("close", (code, sig) => done(aborted ? { kind: "aborted", stderr } : { kind: "exit", exitCode: code, signal: sig, stderr }));
    });
  }
}
