import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendDurable, ensureDir, fsyncDir } from "../auth/files.ts";
import { SESSION_ID, type ChatStreamEvent, type SessionStore, type TurnClient, type TurnOutcome } from "./sessionClient.ts";

export type MsgStatus = "queued" | "running" | "done" | "not_delivered";

/** One chat message and the assistant's reply to it. `reason` is a stable key (never process output) when `not_delivered`. */
export interface ChatRecord {
  chat_id: string;
  client_msg_id: string;
  text: string;
  at: string;
  status: MsgStatus;
  reason?: string;
  reply?: string;
  reply_at?: string;
}

export type RunnerStatus = "idle" | "busy" | "backoff" | "session_down";
export interface ChatState {
  status: RunnerStatus;
  queued: number;
  /** Consecutive failed attempts (0 after any success). */
  failures: number;
  retry_at: string | null;
  down_since: string | null;
  last_error: string | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** The slice of the S6d ledger the runner writes: `chat.*` events only. */
export interface ChatLedger {
  append(type: "chat.delta" | "chat.done", data: Record<string, unknown>, key?: string): unknown;
}

export interface RunnerOptions {
  client: TurnClient;
  sessions: SessionStore;
  ledger: ChatLedger;
  /** API state directory; the message log `chat.jsonl` lives here (0600). */
  stateDir: string;
  now: () => number;
  timers: Timers;
  /** A turn that has not finished by then is killed and counts as a failure. */
  turnTimeoutMs?: number;
  /** Attempts per message before it is `not_delivered`. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Consecutive failed attempts that open `session_down`. */
  downAfter?: number;
  /** Characters of reply text gathered into one `chat.delta` event (every delta is an fsync'd ledger line). */
  flushChars?: number;
  /**
   * Whether `chat.delta` carries the text (`text` field). Default false: the event is a hint `{chat_id, n}` and the client reads the
   * reply from history. Open decision, finding F-vlad-022 (chat content on lock screen / in event payloads).
   */
  deltaText?: boolean;
  maxQueue?: number;
  /** `chat.delta` events per turn (each is an fsync'd ledger line); further text still lands in the reply. */
  maxDeltas?: number;
}

export const MAX_TEXT = 4000;
export const MAX_REPLY = 64 * 1024;
const MAX_KEPT = 500;
/** `client_msg_id`s remembered for dedup (outlives the message records; not across a restart beyond the retained log). */
const MAX_DEDUP = 5000;
const MAX_LOG_LINES = 2000;
const CLIENT_MSG_ID = /^[A-Za-z0-9._-]{1,64}$/;
const NO_SESSION = /No conversation found/i;

type LogLine =
  | ({ t: "msg" } & ChatRecord)
  | { t: "set"; chat_id: string; status: MsgStatus; reason?: string }
  | { t: "reply"; chat_id: string; text: string; at: string };

export class BadChatRequest extends Error {
  readonly field: "client_msg_id" | "text";
  constructor(field: "client_msg_id" | "text") {
    super(`invalid ${field}`);
    this.field = field;
    this.name = "BadChatRequest";
  }
}

/**
 * Runs chat messages through `claude -p --resume <id>`, one at a time. Every message ends `done` or `not_delivered`; none vanishes:
 * the log is durable and a restart turns a half-run message into `not_delivered` and re-queues the rest. A failed turn is retried
 * with exponential backoff; enough consecutive failures open `session_down` (reflected in {@link warnings}) until a probe turn
 * succeeds. No wall clock: `now` and `timers` are injected.
 */
export class ChatTurnRunner {
  private readonly file: string;
  private readonly records = new Map<string, ChatRecord>();
  private readonly byClientId = new Map<string, string>();
  private readonly queue: string[] = [];
  private lines = 0;
  private counter = 0;
  private running = false;
  private stopped = false;
  private failures = 0;
  private retryAt: number | null = null;
  private retryTimer: unknown = null;
  private downSince: number | null = null;
  private lastError: string | null = null;
  private abort: AbortController | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly o: Required<Omit<RunnerOptions, "client" | "sessions" | "ledger" | "stateDir" | "now" | "timers">>;

  private readonly opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.o = {
      turnTimeoutMs: opts.turnTimeoutMs ?? 10 * 60_000,
      maxAttempts: opts.maxAttempts ?? 3,
      backoffBaseMs: opts.backoffBaseMs ?? 2_000,
      backoffMaxMs: opts.backoffMaxMs ?? 5 * 60_000,
      downAfter: opts.downAfter ?? 5,
      flushChars: opts.flushChars ?? 160,
      deltaText: opts.deltaText ?? false,
      maxQueue: opts.maxQueue ?? 50,
      maxDeltas: opts.maxDeltas ?? 100,
    };
    ensureDir(opts.stateDir);
    this.file = join(opts.stateDir, "chat.jsonl");
    this.load();
    for (const r of this.records.values()) {
      if (r.status === "running") this.finish(r, "not_delivered", "restart"); // outcome unknown: the user must see it and resend
    }
    for (const r of this.records.values()) if (r.status === "queued") this.queue.push(r.chat_id);
    this.pump();
  }

  /**
   * Accepts a message. A known `client_msg_id` returns the original `chat_id` and queues nothing. While `session_down`, a message
   * is `not_delivered` at once, except the first one after the cool-down, which is the probe.
   */
  submit(msg: { clientMsgId: string; text: string }): { chat_id: string; duplicate: boolean; status: MsgStatus } {
    if (!CLIENT_MSG_ID.test(msg.clientMsgId)) throw new BadChatRequest("client_msg_id");
    if (typeof msg.text !== "string" || msg.text.length < 1 || msg.text.length > MAX_TEXT) throw new BadChatRequest("text");
    const known = this.byClientId.get(msg.clientMsgId);
    if (known) return { chat_id: known, duplicate: true, status: this.records.get(known)?.status ?? "done" };
    const rec: ChatRecord = {
      chat_id: `chat-${++this.counter}`, client_msg_id: msg.clientMsgId, text: msg.text,
      at: new Date(this.opts.now()).toISOString(), status: "queued",
    };
    this.log({ t: "msg", ...rec });
    this.records.set(rec.chat_id, rec);
    this.byClientId.set(rec.client_msg_id, rec.chat_id);
    const cooling = this.downSince !== null && (this.opts.now() < this.downSince + this.o.backoffMaxMs || this.running || this.queue.length > 0);
    if (cooling) this.finish(rec, "not_delivered", "session_down");
    else if (this.queue.length >= this.o.maxQueue) this.finish(rec, "not_delivered", "queue_full");
    else {
      this.queue.push(rec.chat_id);
      this.pump();
    }
    this.trim();
    return { chat_id: rec.chat_id, duplicate: false, status: rec.status };
  }

  state(): ChatState {
    const now = this.opts.now();
    const status: RunnerStatus = this.isDown() ? "session_down" : this.running ? "busy" : this.retryAt !== null && now < this.retryAt ? "backoff" : "idle";
    return {
      status, queued: this.queue.length, failures: this.failures,
      retry_at: this.retryAt !== null && now < this.retryAt ? new Date(this.retryAt).toISOString() : null,
      down_since: this.downSince !== null ? new Date(this.downSince).toISOString() : null,
      last_error: this.lastError,
    };
  }

  /** Lines for `Home.warnings` (the contract has no chat field; a dead chat session must still be visible on the home screen). */
  warnings(): string[] {
    return this.isDown() ? [`sohbet: oturum kapalı (session_down; ${this.lastError ?? "bilinmiyor"})`] : [];
  }

  get(chatId: string): ChatRecord | undefined {
    return this.records.get(chatId);
  }

  /** Retained messages, oldest first. */
  messages(): ChatRecord[] {
    return [...this.records.values()];
  }

  /** Resolves when no turn runs and the queue is empty or waiting for a retry timer. */
  whenIdle(): Promise<void> {
    return this.idle() ? Promise.resolve() : new Promise((res) => this.idleWaiters.push(res));
  }

  /** Stops the retry timer and kills the running turn; its message stays `queued` for the next start. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) this.opts.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.abort?.abort();
  }

  private isDown() {
    return this.downSince !== null;
  }
  private idle() {
    return !this.running && (this.queue.length === 0 || this.retryTimer !== null || this.stopped);
  }
  private notifyIdle() {
    if (!this.idle()) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private pump(): void {
    if (this.running || this.stopped || this.queue.length === 0 || this.retryTimer !== null) return this.notifyIdle();
    const now = this.opts.now();
    if (this.retryAt !== null && now < this.retryAt) {
      this.retryTimer = this.opts.timers.setTimeout(() => { this.retryTimer = null; this.pump(); }, this.retryAt - now);
      return this.notifyIdle();
    }
    void this.runNext();
  }

  private async runNext(): Promise<void> {
    const rec = this.records.get(this.queue[0]!)!;
    this.running = true;
    this.setStatus(rec, "running");
    let outcome: "done" | "failed" | "ran" | "limit" | "stopped" = "failed";
    try {
      outcome = await this.turn(rec);
    } catch (e) {
      this.lastError = "internal";
      outcome = "failed";
    }
    this.running = false;
    this.abort = null;
    if (outcome === "stopped") { this.setStatus(rec, "queued"); return this.notifyIdle(); }
    if (outcome === "done" || outcome === "limit") {
      this.queue.shift();
    } else if (outcome === "ran") {
      // The turn had started (model or tools ran) and then failed: repeating it would repeat its side effects. Report, never retry.
      this.failures++;
      this.queue.shift();
      this.finish(rec, "not_delivered", this.lastError ?? "failed");
      this.registerFailure();
    } else {
      this.failures++;
      if (!this.registerFailure()) {
        if (this.attempts.get(rec.chat_id)! >= this.o.maxAttempts) {
          this.queue.shift();
          this.finish(rec, "not_delivered", this.lastError ?? "failed");
        } else {
          this.setStatus(rec, "queued"); // stays at the head, retried after the backoff
        }
      }
    }
    this.trim();
    this.pump();
  }

  /** Sets the next retry time, or opens `session_down` (queue refused) after enough consecutive failures. Returns whether it opened. */
  private registerFailure(): boolean {
    this.retryAt = this.opts.now() + Math.min(this.o.backoffBaseMs * 2 ** (this.failures - 1), this.o.backoffMaxMs);
    if (this.failures < this.o.downAfter) return false;
    this.downSince = this.opts.now();
    this.retryAt = null;
    for (const id of this.queue.splice(0)) this.finish(this.records.get(id)!, "not_delivered", "session_down");
    return true;
  }

  private readonly attempts = new Map<string, number>();

  /** One attempt (plus the fresh-session fallback). Finishes the record itself when it is `done` or hit the limit. */
  private async turn(rec: ChatRecord): Promise<"done" | "failed" | "ran" | "limit" | "stopped"> {
    this.attempts.set(rec.chat_id, (this.attempts.get(rec.chat_id) ?? 0) + 1);
    for (let pass = 0; pass < 2; pass++) {
      const sessionId = this.opts.sessions.get();
      let text = "";
      let pending = "";
      let n = 0;
      let seenSession = null as string | null;
      const st: { result: Extract<ChatStreamEvent, { kind: "result" }> | null; limit: { until: string | null } | null; active: boolean } = { result: null, limit: null, active: false };
      const fail = () => (st.active ? "ran" as const : "failed" as const);
      const flush = () => {
        if (!pending) return;
        if (n >= this.o.maxDeltas) { pending = ""; return; } // text still reaches the reply; only the events stop
        const data: Record<string, unknown> = { chat_id: rec.chat_id, n: ++n };
        if (this.o.deltaText) data.text = pending.slice(0, 1500);
        pending = "";
        try { this.opts.ledger.append("chat.delta", data); } catch { /* the event is a hint; the reply is in the log */ }
      };
      const onEvent = (e: ChatStreamEvent) => {
        if (e.kind === "session") seenSession = e.sessionId;
        else if (e.kind === "activity") st.active = true;
        else if (e.kind === "delta") {
          st.active = true;
          if (text.length >= MAX_REPLY) return; // nothing more to keep or announce
          text += e.text;
          pending += e.text;
          if (pending.length >= this.o.flushChars) flush();
        } else if (e.kind === "limit") st.limit = { until: e.until };
        else st.result = e;
      };
      const ac = (this.abort = new AbortController());
      let timedOut = false;
      const t = this.opts.timers.setTimeout(() => { timedOut = true; ac.abort(); }, this.o.turnTimeoutMs);
      let out: TurnOutcome;
      try {
        out = await this.opts.client.run({ sessionId, text: rec.text }, onEvent, ac.signal);
      } finally {
        this.opts.timers.clearTimeout(t);
      }
      flush();
      if (out.kind === "spawn") { this.lastError = "spawn"; return "failed"; }
      if (out.kind === "aborted") {
        if (timedOut) { this.lastError = "timeout"; return fail(); }
        return "stopped";
      }
      const res = st.result;
      const lim = res?.limit ?? st.limit;
      if (lim && !(out.exitCode === 0 && res?.ok)) {
        this.lastError = "limit";
        this.finish(rec, "not_delivered", "limit");
        return "limit";
      }
      if (sessionId && pass === 0 && !(out.exitCode === 0 && res?.ok) && (res?.errors.some((x) => NO_SESSION.test(x)) || NO_SESSION.test(out.stderr))) {
        this.opts.sessions.clear(); // the saved session is gone: this turn starts a new one
        continue;
      }
      if (out.exitCode !== 0) { this.lastError = out.signal ? `signal_${out.signal}` : `exit_${out.exitCode}`; return fail(); }
      if (!res) { this.lastError = "no_result"; return fail(); }
      if (!res.ok) { this.lastError = "result_error"; return fail(); }
      const sid: string | null = seenSession;
      if (sid && SESSION_ID.test(sid) && sid !== this.opts.sessions.get()) this.opts.sessions.set(sid);
      const reply = (res.text ?? text).slice(0, MAX_REPLY);
      rec.reply = reply;
      rec.reply_at = new Date(this.opts.now()).toISOString();
      this.log({ t: "reply", chat_id: rec.chat_id, text: reply, at: rec.reply_at });
      this.failures = 0;
      this.retryAt = null;
      this.downSince = null;
      this.lastError = null;
      this.finish(rec, "done");
      return "done";
    }
    this.lastError = "resume_failed";
    return "failed";
  }

  private setStatus(rec: ChatRecord, status: MsgStatus, reason?: string): void {
    rec.status = status;
    if (reason) rec.reason = reason;
    this.log({ t: "set", chat_id: rec.chat_id, status, ...(reason ? { reason } : {}) });
  }

  /** Terminal state: persisted, then announced once (`chat.done`, keyed so a restart never repeats it). */
  private finish(rec: ChatRecord, status: "done" | "not_delivered", reason?: string): void {
    this.setStatus(rec, status, reason);
    this.attempts.delete(rec.chat_id);
    try {
      this.opts.ledger.append("chat.done", { chat_id: rec.chat_id, status, ...(reason ? { reason } : {}) }, `chat.done:${rec.chat_id}`);
    } catch { /* ledger trouble never loses the message: it is in the log */ }
  }

  // --- persistence -------------------------------------------------------------------------------------------------

  private log(line: LogLine): void {
    appendDurable(this.file, JSON.stringify(line) + "\n");
    this.lines++;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    for (const raw of readFileSync(this.file, "utf8").split("\n")) {
      if (!raw) continue;
      this.lines++;
      try {
        const l = JSON.parse(raw) as LogLine;
        if (l.t === "msg") {
          const { t: _t, ...rec } = l;
          this.records.set(rec.chat_id, rec);
          this.byClientId.set(rec.client_msg_id, rec.chat_id);
          const n = Number(/^chat-(\d+)$/.exec(rec.chat_id)?.[1]);
          if (n > this.counter) this.counter = n;
        } else {
          const rec = this.records.get(l.chat_id);
          if (!rec) continue;
          if (l.t === "set") { rec.status = l.status; if (l.reason) rec.reason = l.reason; }
          else if (l.t === "reply") { rec.reply = l.text; rec.reply_at = l.at; }
        }
      } catch { /* torn last line after a crash */ }
    }
    this.trim();
  }

  /** Keeps the newest {@link MAX_KEPT} finished messages in memory and rewrites the log once it is far longer than that. */
  private trim(): void {
    if (this.records.size > MAX_KEPT) {
      for (const [id, r] of this.records) {
        if (this.records.size <= MAX_KEPT) break;
        if (r.status === "done" || r.status === "not_delivered") this.records.delete(id);
      }
    }
    while (this.byClientId.size > MAX_DEDUP) this.byClientId.delete(this.byClientId.keys().next().value!);
    if (this.lines <= MAX_LOG_LINES) return;
    const tmp = join(dirname(this.file), `.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      let n = 0;
      for (const r of this.records.values()) {
        const { reply, reply_at, ...base } = r;
        writeSync(fd, JSON.stringify({ t: "msg", ...base } satisfies LogLine) + "\n");
        n++;
        if (reply !== undefined) { writeSync(fd, JSON.stringify({ t: "reply", chat_id: r.chat_id, text: reply, at: reply_at ?? r.at } satisfies LogLine) + "\n"); n++; }
      }
      fsyncSync(fd);
      this.lines = n;
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    fsyncDir(dirname(this.file));
  }
}
