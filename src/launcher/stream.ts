import { StringDecoder } from "node:string_decoder";

/** A line longer than this is dropped whole (design: tap discards >1 MB lines). */
export const MAX_LINE_BYTES = 1024 * 1024;
const MAX_LABEL = 160;
/** What `--resume <id>` may be given: no leading `-`, no shell/argv metacharacters. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export type TapEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "step"; label: string }
  /** `until` is ISO 8601 (from `resetsAt`); null = the stream gave no reset time. */
  | { kind: "limit"; until: string | null; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
};

/** Label of one assistant content block: tool use (`Bash: <command>`) or the first text line; thinking is skipped. */
function blockLabel(b: unknown): string | null {
  if (!isObj(b)) return null;
  if (b.type === "tool_use" && typeof b.name === "string") {
    const inp = isObj(b.input) ? b.input : {};
    const arg = [inp.description, inp.command, inp.file_path, inp.path, inp.pattern, inp.url].find((v) => typeof v === "string" && v.trim());
    return oneLine(typeof arg === "string" ? `${b.name}: ${arg}` : b.name);
  }
  if (b.type === "text" && typeof b.text === "string" && b.text.trim()) return oneLine(b.text.trim().split("\n")[0]);
  return null;
}

/**
 * Limit statuses in `rate_limit_event.rate_limit_info.status`. The only value ever captured is `allowed`
 * (fixtures/external, D0A); `rejected`/`blocked`/`exceeded` are SYNTHETIC guesses. Any other unknown value is
 * ignored, so a wrong guess never invents a quota marker (the user can still `vlad quota set` by hand).
 */
const LIMIT_STATUSES = new Set(["rejected", "blocked", "exceeded", "limit_reached"]);
/** Marker text of the CLI's own usage-limit result (`... usage limit reached|<epoch seconds>`); SYNTHETIC, not captured. */
const LIMIT_TEXT = /usage limit reached(?:\|(\d{9,11}))?/i;

const epochIso = (sec: unknown): string | null =>
  typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null;

/** Events one stream-json line carries; unknown shapes yield nothing. */
export function parseStreamLine(line: string): TapEvent[] {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return []; }
  if (!isObj(j)) return [];
  const evs: TapEvent[] = [];
  const sid = j.session_id;
  if (typeof sid === "string" && SESSION_ID.test(sid) && (j.type === "result" || (j.type === "system" && j.subtype === "init"))) {
    evs.push({ kind: "session", sessionId: sid });
  }
  if (j.type === "assistant" && isObj(j.message) && Array.isArray(j.message.content)) {
    const labels = j.message.content.map(blockLabel).filter((l): l is string => l !== null);
    if (labels.length) evs.push({ kind: "step", label: labels[labels.length - 1] });
  }
  if (j.type === "rate_limit_event" && isObj(j.rate_limit_info)) {
    const info = j.rate_limit_info;
    const status = typeof info.status === "string" ? info.status : "";
    if (LIMIT_STATUSES.has(status)) {
      const win = isObj(info.unifiedWindows) && typeof info.rateLimitType === "string" ? info.unifiedWindows[info.rateLimitType] : undefined;
      const until = epochIso(info.resetsAt) ?? (isObj(win) ? epochIso(win.resetsAt) : null);
      evs.push({ kind: "limit", until, reason: `rate_limit_event ${status}${typeof info.rateLimitType === "string" ? ` (${info.rateLimitType})` : ""}` });
    }
  }
  if (j.type === "result" && j.is_error === true && typeof j.result === "string") {
    const m = LIMIT_TEXT.exec(j.result);
    if (m) evs.push({ kind: "limit", until: m[1] ? epochIso(Number(m[1])) : null, reason: "result: usage limit reached" });
  }
  return evs;
}

/**
 * Incremental line splitter + parser for a `claude -p --output-format stream-json` pipe. Bytes may split
 * anywhere, even inside a UTF-8 sequence; a partial last line is held until its newline (and ignored at `end`);
 * a line over MAX_LINE_BYTES is discarded up to its newline.
 */
export class StreamTap {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  private skipping = false;

  /** Returns the raw complete lines (for the worker log) and the events they carry. */
  push(chunk: Buffer | string): { lines: string[]; events: TapEvent[] } {
    const lines: string[] = [];
    const events: TapEvent[] = [];
    const parts = (this.buf + (typeof chunk === "string" ? chunk : this.decoder.write(chunk))).split("\n");
    this.buf = parts.pop() ?? "";
    for (const raw of parts) {
      if (this.skipping) { this.skipping = false; continue; } // tail of an oversized line
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      lines.push(line);
      events.push(...parseStreamLine(line));
    }
    if (Buffer.byteLength(this.buf) > MAX_LINE_BYTES) { this.buf = ""; this.skipping = true; }
    return { lines, events };
  }
}
