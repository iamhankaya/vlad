import type { FastifyReply, FastifyRequest } from "fastify";
import { BadChatRequest, MAX_TEXT, type ChatRecord, type ChatTurnRunner } from "../chat/turnRunner.ts";
import { runVlad, runVladJson, VladError, type RunOptions } from "../vlad/cli.ts";

/**
 * S11b (GÜVENLİK): chat, card answers and change requests. Nothing here can execute an external action: this module imports no
 * executor and no GitHub writer (a static test walks the import graph to keep it so). A card of kind `action_request` is only
 * ever read here; it is resolved through `/actions/prepare` + a device-signed `/actions/{id}/approve`, never by an answer.
 *
 * Every write goes through the `vlad` CLI, the only kb writer. Client text reaches argv in single tokens that cannot be read as a
 * flag (`--text=<value>`, or after `--`) and is size-capped; the device id comes from the verified envelope, never from the body.
 */

/** The `vlad` CLI as this module uses it; tests substitute a recorder. */
export interface VladRunner {
  run(args: string[], opts?: RunOptions): Promise<string>;
  json<T>(args: string[], opts?: RunOptions): Promise<T>;
}
export const realVlad: VladRunner = { run: runVlad, json: runVladJson };

export interface ChatDeps {
  /** The S11a runner. Without a real `claude` sandbox (S14a) `main.ts` does not create one (F-vlad-024): the routes then answer 501. */
  runner?: ChatTurnRunner;
  vlad?: VladRunner;
  /** Failures worth a log line that are not the client's (relaunch). */
  log?: (msg: string) => void;
  /** Per-call timeout for `vlad` runs. */
  timeoutMs?: number;
}

const CARD_ID = /^C-[0-9]{8}-[0-9]{2,}$/;
const TASK_ID = /^T[0-9]{8}-[0-9]{2,}$/;
const CHAT_ID = /^chat-[0-9]{1,12}$/;
const OPTION = /^[A-Za-z0-9._-]{1,40}$/;
export const MAX_ANSWER = 2000;
const PAGE = 50;
/** C0 controls except tab and newline, and DEL. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const RELAUNCH_TIMEOUT_MS = 60_000;

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const fail = (reply: FastifyReply, status: number, code: string, message_tr: string, details?: object) =>
  reply.code(status).type("application/json").send({ error: { code, message_tr, ...(details ? { details } : {}) } });
const bad = (reply: FastifyReply, details: object, message = "Geçersiz istek.") => fail(reply, 400, "bad_request", message, details);
const notFound = (reply: FastifyReply, what: string) => fail(reply, 404, "bad_request", `${what} bulunamadı.`, { reason: "not_found" });
const notWired = (reply: FastifyReply) => fail(reply, 501, "bad_request", "Henüz uygulanmadı.", { reason: "not_implemented" });

function body(req: FastifyRequest): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A user text field: 1..max characters after trimming, no control characters. */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string" || CONTROL.test(v)) return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

/** Text that lands in a markdown task file: one line, so it can never open a heading or a list item of its own. */
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

function vladFailure(reply: FastifyReply, e: unknown) {
  if (e instanceof VladError) {
    if (e.kind === "active_elsewhere") return fail(reply, 409, "active_elsewhere", "Etkin VLAD başka makinede.");
    if (e.kind === "not_found") return notFound(reply, "Kayıt");
    // The CLI's text stays server-side; the client gets a key.
    if (/zaten cevaplandı/.test(e.message)) return bad(reply, { reason: "already_answered" }, "Zaten cevaplandı.");
    if (/kart açık değil|kart zaten kapalı/.test(e.message)) return bad(reply, { reason: "card_closed" }, "Kart kapalı.");
    if (/geçersiz seçenek/.test(e.message)) return bad(reply, { field: "option" }, "Geçersiz seçenek.");
    if (/geçersiz geçiş/.test(e.message)) return bad(reply, { reason: "task_state" }, "Görev bu durumda değil.");
    return fail(reply, 503, "bad_request", "VLAD şu an yazamıyor.", { reason: "vlad_failed", kind: e.kind });
  }
  throw e;
}

const record = (r: ChatRecord) => Number(/^chat-(\d+)$/.exec(r.chat_id)?.[1] ?? 0);

/** Handlers of `postChat`, `getChatHistory`, `answerCard` and `requestTaskChanges`, mounted by `buildApp` behind the signature check. */
export function chatHandlers(deps: ChatDeps = {}): Record<"postChat" | "getChatHistory" | "answerCard" | "requestTaskChanges", Handler> {
  const vlad = deps.vlad ?? realVlad;
  const opts = { timeoutMs: deps.timeoutMs };

  const postChat: Handler = async (req, reply) => {
    const runner = deps.runner;
    if (!runner) return notWired(reply);
    const b = body(req);
    if (!b || Object.keys(b).some((k) => k !== "client_msg_id" && k !== "text")) return bad(reply, {});
    const text = cleanText(b.text, MAX_TEXT);
    if (text === null) return bad(reply, { field: "text" });
    if (typeof b.client_msg_id !== "string") return bad(reply, { field: "client_msg_id" });
    // A repeat of a known message is answered from the log without asking the CLI anything.
    try {
      if (!runner.hasClientId(b.client_msg_id)) {
        const q = await vlad.json<{ limited: boolean; until: string | null }>(["quota", "show"], opts).catch(() => null);
        if (q?.limited) return fail(reply, 503, "quota_hold", "Abonelik kotası dolu.", q.until ? { until: q.until } : undefined);
        const a = await vlad.json<{ active: unknown; mine: boolean }>(["active", "show"], opts).catch(() => null);
        if (a?.active && !a.mine) return fail(reply, 409, "active_elsewhere", "Etkin VLAD başka makinede.");
      }
      const r = runner.submit({ clientMsgId: b.client_msg_id, text });
      return reply.code(202).send({ chat_id: r.chat_id });
    } catch (e) {
      if (e instanceof BadChatRequest) return bad(reply, { field: e.field });
      throw e;
    }
  };

  const getChatHistory: Handler = async (req, reply) => {
    const runner = deps.runner;
    if (!runner) return notWired(reply);
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (Object.keys(q).some((k) => k !== "before")) return bad(reply, {});
    const before = q.before;
    if (before !== undefined && (typeof before !== "string" || !CHAT_ID.test(before))) return bad(reply, { field: "before" });
    const limit = before === undefined ? Infinity : Number((before as string).slice(5));
    // Newest first; a record yields its reply (newer) and then the message it answers.
    const recs = runner.messages().filter((r) => record(r) < limit).sort((a, b) => record(b) - record(a));
    const messages: { chat_id: string; role: "user" | "assistant"; text: string; at: string }[] = [];
    let i = 0;
    for (; i < recs.length && messages.length < PAGE; i++) {
      const r = recs[i]!;
      if (r.reply !== undefined) messages.push({ chat_id: r.chat_id, role: "assistant", text: r.reply, at: r.reply_at ?? r.at });
      messages.push({ chat_id: r.chat_id, role: "user", text: r.text, at: r.at });
    }
    // A page ends on a whole record, so `before` of the next page is the last chat_id here and nothing is cut in half.
    return { messages, has_more: i < recs.length };
  };

  const answerCard: Handler = async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!CARD_ID.test(id)) return bad(reply, { field: "id" }, "Geçersiz kart kimliği.");
    const b = body(req);
    if (!b || Object.keys(b).length === 0 || Object.keys(b).some((k) => k !== "option" && k !== "text")) return bad(reply, {});
    let option: string | undefined;
    let text: string | undefined;
    if (b.option !== undefined) {
      if (typeof b.option !== "string" || !OPTION.test(b.option)) return bad(reply, { field: "option" });
      option = b.option;
    }
    if (b.text !== undefined) {
      const t = cleanText(b.text, MAX_ANSWER);
      if (t === null) return bad(reply, { field: "text" });
      text = t;
    }
    // The verified envelope's device. The body has no such field and a body that tries to carry one was refused above.
    const deviceId = req.vladDevice?.device_id;
    if (!deviceId) return fail(reply, 500, "bad_request", "Sunucu hatası.");
    try {
      const card = await vlad.json<{ id: string; kind: string; state: string; task: string | null; options: { id: string; label: string }[]; answer: unknown }>(["card", "show", id], opts);
      if (card.kind === "action_request") return bad(reply, { reason: "use_actions" }, "Bu kart yalnız onay yoluyla çözülür.");
      if (card.answer) return bad(reply, { reason: "already_answered" }, "Zaten cevaplandı.");
      if (card.state !== "open") return bad(reply, { reason: "card_closed" }, "Kart kapalı.");
      const picked = option === undefined ? undefined : card.options.find((o) => o.id === option);
      if (option !== undefined && !picked) return bad(reply, { field: "option" }, "Geçersiz seçenek.");

      // `=` forms: the value is one argv token and can never be taken for a flag.
      await vlad.run(["card", "answer", id, ...(option !== undefined ? [`--option=${option}`] : []), ...(text !== undefined ? [`--text=${text}`] : []), `--by-device=${deviceId}`], opts);

      if (card.task && TASK_ID.test(card.task)) {
        const { task } = await vlad.json<{ task: { state: string; kind: string; host?: string | null } }>(["task", "show", card.task], opts);
        if (task.state === "blocked") {
          const said = [picked?.label, text].filter((x): x is string => !!x).join(": ");
          await vlad.run(["task", "answer", card.task, "--", oneLine(`(kart ${id}) ${said}`)], opts);
          if (task.kind === "dev" && task.host) await relaunch(card.task);
        }
      }
      // The answer is on file; a card that could not be closed only shows up once more and refuses a second answer.
      await vlad.run(["card", "resolve", id], opts).catch((e) => deps.log?.(`card resolve ${id}: ${e instanceof VladError ? e.kind : "error"}`));
      return { ok: true };
    } catch (e) {
      return vladFailure(reply, e);
    }
  };

  /** The worker is started again where it ran. Best effort: the answer is already on file, and `stalled` detection shows a worker that did not come back. */
  async function relaunch(taskId: string): Promise<void> {
    try {
      await vlad.run(["task", "relaunch", taskId], { ...opts, timeoutMs: RELAUNCH_TIMEOUT_MS });
    } catch (e) {
      deps.log?.(`relaunch ${taskId}: ${e instanceof VladError ? e.kind : "error"}`);
    }
  }

  const requestTaskChanges: Handler = async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!TASK_ID.test(id)) return bad(reply, { field: "id" }, "Geçersiz görev kimliği.");
    const b = body(req);
    if (!b || Object.keys(b).some((k) => k !== "text")) return bad(reply, {});
    const text = cleanText(b.text, MAX_ANSWER);
    if (text === null) return bad(reply, { field: "text" });
    const deviceId = req.vladDevice?.device_id;
    if (!deviceId) return fail(reply, 500, "bad_request", "Sunucu hatası.");
    try {
      const { task } = await vlad.json<{ task: { state: string; kind: string; host?: string | null } }>(["task", "show", id], opts);
      if (task.state !== "awaiting_approval") return bad(reply, { reason: "task_state" }, "Görev onay beklemiyor.");
      await vlad.run(["task", "log", id, "--", oneLine(`Değişiklik isteği (cihaz ${deviceId}): ${text}`)], opts);
      await vlad.run(["task", "set", id, "running"], opts);
      if (task.kind === "dev" && task.host) await relaunch(id);
      return { ok: true };
    } catch (e) {
      return vladFailure(reply, e);
    }
  };

  return { postChat, getChatHistory, answerCard, requestTaskChanges };
}
