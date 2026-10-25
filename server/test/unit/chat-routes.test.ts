import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubReader } from "../../src/actions/github.ts";
import type { ExecuteAction } from "../../src/actions/service.ts";
import type { ChatStreamEvent, TurnClient, TurnOutcome } from "../../src/chat/sessionClient.ts";
import { SessionStore } from "../../src/chat/sessionClient.ts";
import { ChatTurnRunner } from "../../src/chat/turnRunner.ts";
import { EventLedger } from "../../src/events/ledger.ts";
import { chatHandlers, type VladRunner } from "../../src/http/routes-chat.ts";
import { VladError } from "../../src/vlad/cli.ts";
import { pairDevice, rig, signedCall, type Rig, type TestDevice } from "../helpers/client.ts";
import { validator } from "../helpers/openapi.ts";

const SRC = resolve(import.meta.dirname, "..", "..", "src");
const OKRESULT = (text: string): ChatStreamEvent => ({ kind: "result", ok: true, text, errors: [], limit: null });
const EXIT0: TurnOutcome = { kind: "exit", exitCode: 0, signal: null, stderr: "" };

/** Stand-in for `claude`: answers every turn with `reply` and counts the turns. */
class StubClient implements TurnClient {
  turns: string[] = [];
  reply = "tamam";
  hold: Promise<void> | null = null;
  async run(req: { text: string }, onEvent: (e: ChatStreamEvent) => void): Promise<TurnOutcome> {
    this.turns.push(req.text);
    await this.hold;
    onEvent({ kind: "activity" });
    onEvent({ kind: "delta", text: this.reply });
    onEvent(OKRESULT(this.reply));
    return EXIT0;
  }
}

type Reply = unknown | ((args: string[]) => unknown);
/** Records every `vlad` call; `script` maps "<group> <command>" to the reply (a function may throw a VladError). */
class FakeVlad implements VladRunner {
  calls: string[][] = [];
  script: Record<string, Reply> = {};
  private answer(args: string[]): unknown {
    const r = this.script[args.slice(0, 2).join(" ")];
    if (r === undefined) return {};
    return typeof r === "function" ? (r as (a: string[]) => unknown)(args) : r;
  }
  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    this.answer(args);
    return "";
  }
  async json<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    return this.answer(args) as T;
  }
  /** Calls that change the kb. */
  get writes() {
    const reads = new Set(["card show", "task show", "quota show", "active show"]);
    return this.calls.filter((c) => !reads.has(c.slice(0, 2).join(" ")));
  }
  names() {
    return this.calls.map((c) => c.slice(0, 2).join(" "));
  }
}

const dirs: string[] = [];
const rigs: Rig[] = [];
const runners: ChatTurnRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) r.stop();
  for (const r of rigs.splice(0)) await r.app.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CARD = "C-20261025-01";
const TASK = "T20261025-86";

function world(opts: { maxQueue?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vlad-chatr-"));
  dirs.push(dir);
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  const client = new StubClient();
  const vlad = new FakeVlad();
  vlad.script = {
    "quota show": { limited: false, until: null },
    "active show": { active: null, mine: false },
    "card show": { id: CARD, kind: "vlad_question", state: "open", task: TASK, options: [{ id: "yes", label: "Evet" }, { id: "no", label: "Hayır" }], answer: null },
    "task show": { task: { id: TASK, state: "blocked", kind: "dev", host: "box" }, report: null },
  };
  const runner = new ChatTurnRunner({
    client, sessions: new SessionStore(join(state, "chat-session.txt")), ledger: new EventLedger(state), stateDir: state,
    now: Date.now, timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) }, ...opts,
  });
  runners.push(runner);
  // Anything on the approval path is a spy: chat must never reach it.
  const exec = { executes: 0, reads: 0 };
  const execute: ExecuteAction = async () => { exec.executes++; throw new Error("execute must not run"); };
  const reader = new Proxy({}, { get: () => async () => { exec.reads++; throw new Error("github read"); } }) as unknown as GithubReader;
  const log: string[] = [];
  const r = rig({
    chat: { runner, vlad, log: (m) => log.push(m) },
    actions: { reader, tasks: async () => null, projects: async () => null, execute },
  });
  rigs.push(r);
  return { r, client, vlad, runner, exec, log, dir };
}

const post = (w: ReturnType<typeof world>, d: TestDevice, path: string, body: unknown) => signedCall(w.r, d, "POST", `/v1${path}`, typeof body === "string" ? body : JSON.stringify(body));
const chat = (w: ReturnType<typeof world>, d: TestDevice, text: string, id = `m-${Math.random().toString(36).slice(2, 10)}`) => post(w, d, "/chat", { client_msg_id: id, text });

describe("server: chat routes", () => {
  it('server: chat "evet" never calls executeAction', async () => {
    const w = world();
    const d = await pairDevice(w.r);
    // an open merge offer and an agent that claims to be merging: none of it may reach the approval path
    w.client.reply = "Merge ediyorum.";
    for (const t of ["evet", "Evet, onaylıyorum", "yes", "merge et"]) {
      const res = await chat(w, d, t);
      expect(res.statusCode).toBe(202);
    }
    await w.runner.whenIdle();
    expect(w.client.turns).toEqual(["evet", "Evet, onaylıyorum", "yes", "merge et"]);
    expect(w.exec).toEqual({ executes: 0, reads: 0 });
    expect(w.vlad.writes).toEqual([]); // the route itself only reads quota/active
    expect(w.r.app.vladActions).toBeDefined();
  });

  it("server: chat empty/too long/duplicate bounded", async () => {
    const w = world({ maxQueue: 2 });
    const d = await pairDevice(w.r);
    const bad = async (body: unknown, field?: string) => {
      const res = await post(w, d, "/chat", body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(validator({ $ref: "#/components/schemas/Error" })(res.json())).toEqual([]);
      if (field) expect(res.json().error.details.field).toBe(field);
    };
    await bad({ client_msg_id: "a", text: "" }, "text");
    await bad({ client_msg_id: "a", text: "  \n " }, "text");
    await bad({ client_msg_id: "a", text: "x".repeat(4001) }, "text");
    await bad({ client_msg_id: "a", text: "bir\u0000iki" }, "text");
    await bad({ client_msg_id: "a", text: 5 }, "text");
    await bad({ client_msg_id: "a b", text: "x" }, "client_msg_id");
    await bad({ client_msg_id: "x".repeat(65), text: "x" }, "client_msg_id");
    await bad({ text: "x" }, "client_msg_id");
    await bad({ client_msg_id: "a", text: "x", by_device: "pixel" });
    await bad("not json");
    await bad("[]");
    expect(w.client.turns).toEqual([]);

    expect((await chat(w, d, "x".repeat(4000), "big")).statusCode).toBe(202);
    // a repeat is the same message: same chat_id, no second turn, no CLI preflight
    const a = await chat(w, d, "bir", "dup");
    const callsBefore = w.vlad.calls.length;
    const b = await chat(w, d, "bir", "dup");
    expect(b.statusCode).toBe(202);
    expect(b.json().chat_id).toBe(a.json().chat_id);
    expect(w.vlad.calls.length).toBe(callsBefore);
    await w.runner.whenIdle();
    expect(w.client.turns.filter((t) => t === "bir")).toHaveLength(1);
    expect(validator({ $ref: "#/components/schemas/ChatAccepted" })(a.json())).toEqual([]);

    // a body past the limit never reaches the runner
    const huge = await signedCall(w.r, d, "POST", "/v1/chat", JSON.stringify({ client_msg_id: "h", text: "y".repeat(2 * 1024 * 1024) }));
    expect(huge.statusCode).toBe(413);

    // the queue is bounded: with a stuck turn, messages beyond it end as not_delivered instead of piling up
    let release!: () => void;
    w.client.hold = new Promise<void>((res) => (release = res));
    for (let i = 0; i < 6; i++) await chat(w, d, `q${i}`, `q${i}`);
    const pending = w.runner.messages().filter((m) => m.status === "queued" || m.status === "running");
    expect(pending.length).toBeLessThanOrEqual(3);
    expect(w.runner.messages().some((m) => m.reason === "queue_full")).toBe(true);
    release();
    await w.runner.whenIdle();
  });

  it("server: chat answers quota_hold and active_elsewhere before queueing", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    w.vlad.script["quota show"] = { limited: true, until: "2026-10-25T18:00:00Z" };
    const q = await chat(w, d, "selam");
    expect(q.statusCode).toBe(503);
    expect(q.json().error.code).toBe("quota_hold");
    w.vlad.script["quota show"] = { limited: false, until: null };
    w.vlad.script["active show"] = { active: { machine: "baska" }, mine: false };
    const a = await chat(w, d, "selam");
    expect(a.statusCode).toBe(409);
    expect(a.json().error.code).toBe("active_elsewhere");
    expect(w.client.turns).toEqual([]);
  });

  it("server: chat history is newest first, paged by whole records, and matches the contract", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    const get = (q = "") => signedCall(w.r, d, "GET", `/v1/chat/history${q}`);
    for (let i = 1; i <= 30; i++) {
      await chat(w, d, `soru ${i}`, `h${i}`);
      await w.runner.whenIdle();
    }
    const p1 = await get();
    expect(p1.statusCode).toBe(200);
    expect(validator({ $ref: "#/components/schemas/ChatHistory" })(p1.json())).toEqual([]);
    const m1 = p1.json().messages as { chat_id: string; role: string; text: string }[];
    expect(m1).toHaveLength(50);
    expect(m1.slice(0, 2).map((m) => [m.chat_id, m.role])).toEqual([["chat-30", "assistant"], ["chat-30", "user"]]);
    expect(p1.json().has_more).toBe(true);
    const last = m1[m1.length - 1]!.chat_id;
    const p2 = await get(`?before=${last}`);
    const m2 = p2.json().messages as { chat_id: string }[];
    expect(m2.every((m) => m.chat_id < last || Number(m.chat_id.slice(5)) < Number(last.slice(5)))).toBe(true);
    expect(p2.json().has_more).toBe(false);
    expect(m1.length + m2.length).toBe(60);
    expect((await get("?before=nope")).statusCode).toBe(400);
    expect((await get("?x=1")).statusCode).toBe(400);
    expect((await get("?before=chat-1")).json()).toEqual({ messages: [], has_more: false });
  });

  it("server: chat routes are 501 without a runner (production until S14a) but card routes still work", async () => {
    const w = world();
    const r2 = rig({ chat: { vlad: w.vlad } });
    rigs.push(r2);
    const d = await pairDevice(r2);
    expect((await signedCall(r2, d, "POST", "/v1/chat", JSON.stringify({ client_msg_id: "a", text: "x" }))).statusCode).toBe(501);
    expect((await signedCall(r2, d, "GET", "/v1/chat/history")).statusCode).toBe(501);
    expect((await signedCall(r2, d, "POST", `/v1/cards/${CARD}/answer`, JSON.stringify({ option: "yes" }))).statusCode).toBe(200);
  });
});

describe("server: card answer and change request", () => {
  it("server: card answer runs task answer then relaunch", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    const res = await post(w, d, `/cards/${CARD}/answer`, { option: "yes", text: "Ama önce testleri koş" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(w.vlad.writes).toEqual([
      ["card", "answer", CARD, "--option=yes", "--text=Ama önce testleri koş", "--by-device", d.id],
      ["task", "answer", TASK, "--", `(kart ${CARD}) Evet: Ama önce testleri koş`],
      ["task", "relaunch", TASK],
      ["card", "resolve", CARD],
    ]);
    // the order that matters: the answer is on file before the worker is started again
    const n = w.vlad.names();
    expect(n.indexOf("task answer")).toBeLessThan(n.indexOf("task relaunch"));
    expect(n.indexOf("card answer")).toBeLessThan(n.indexOf("task answer"));
  });

  it("server: card answer does not relaunch a worker that is not ours, and reports a failing relaunch", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    w.vlad.script["task show"] = { task: { id: TASK, state: "blocked", kind: "dev", host: null }, report: null };
    expect((await post(w, d, `/cards/${CARD}/answer`, { text: "devam" })).statusCode).toBe(200);
    expect(w.vlad.names()).not.toContain("task relaunch");
    expect(w.vlad.names()).toContain("task answer");

    const w2 = world();
    const d2 = await pairDevice(w2.r);
    w2.vlad.script["task relaunch"] = () => { throw new VladError("failed", "launcher başarısız"); };
    const rl = await post(w2, d2, `/cards/${CARD}/answer`, { option: "no" });
    expect(rl.statusCode).toBe(503); // F1: not swallowed; the answer stays on file
    expect(rl.json().error.details.reason).toBe("relaunch_failed");
    expect(w2.log).toEqual(["relaunch T20261025-86: failed"]);
    expect(w2.vlad.names()).toContain("task answer");
    expect(w2.vlad.names()).not.toContain("card resolve");

    // a task that is not waiting for an answer is left alone
    const w3 = world();
    const d3 = await pairDevice(w3.r);
    w3.vlad.script["task show"] = { task: { id: TASK, state: "running", kind: "dev", host: "box" }, report: null };
    expect((await post(w3, d3, `/cards/${CARD}/answer`, { option: "yes" })).statusCode).toBe(200);
    expect(w3.vlad.names()).not.toContain("task answer");
    expect(w3.vlad.names()).not.toContain("task relaunch");
  });

  it("server: F1 retry finishes a half-done card answer (task answer, relaunch, resolve) and never re-answers the card", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    // first attempt: card answered, then the task step failed
    let boom = true;
    w.vlad.script["task answer"] = () => { if (boom) throw new VladError("failed", "disk"); };
    const first = await post(w, d, `/cards/${CARD}/answer`, { option: "yes", text: "ama dikkat" });
    expect(first.statusCode).toBe(503);
    expect(w.vlad.names().filter((n) => n === "card answer")).toHaveLength(1);
    // the kb now shows an answered, still open card and a blocked task
    boom = false;
    w.vlad.script["card show"] = { id: CARD, kind: "vlad_question", state: "open", task: TASK, options: [{ id: "yes", label: "Evet" }], answer: { option: "yes", text: "ama dikkat", by_device: d.id, at: "t" } };
    w.vlad.calls.length = 0;
    const retry = await post(w, d, `/cards/${CARD}/answer`, { text: "başka bir şey" });
    expect(retry.statusCode).toBe(200);
    expect(w.vlad.writes).toEqual([
      ["task", "answer", TASK, "--", `(kart ${CARD}) Evet: ama dikkat`], // what is on file, not the retry's body
      ["task", "relaunch", TASK],
      ["card", "resolve", CARD],
    ]);
    // task already answered meanwhile: only the closing is left
    w.vlad.calls.length = 0;
    w.vlad.script["task show"] = { task: { id: TASK, state: "running", kind: "dev", host: "box" }, report: null };
    expect((await post(w, d, `/cards/${CARD}/answer`, { text: "x" })).statusCode).toBe(200);
    expect(w.vlad.writes).toEqual([["card", "resolve", CARD]]);
  });

  it("server: F2 only a vlad_question card speaks for its task", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    for (const kind of ["ci_red", "conflict", "kb_conflict"]) {
      w.vlad.calls.length = 0;
      w.vlad.script["card show"] = { id: CARD, kind, state: "open", task: TASK, options: [{ id: "yes", label: "Evet" }], answer: null };
      expect((await post(w, d, `/cards/${CARD}/answer`, { option: "yes" })).statusCode, kind).toBe(200);
      expect(w.vlad.names(), kind).toEqual(["card show", "card answer", "card resolve"]);
    }
  });

  it("server: card answer refuses bad bodies, answered/closed cards and unknown options without writing", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    const ans = (b: unknown) => post(w, d, `/cards/${CARD}/answer`, b);
    for (const b of [{}, { option: "x y" }, { option: "nope" }, { text: "" }, { text: "a".repeat(2001) }, { text: "a\u0000b" }, { option: "yes", extra: 1 }, "x", []]) {
      const res = await ans(b);
      expect(res.statusCode, JSON.stringify(b).slice(0, 60)).toBe(400);
    }
    expect((await post(w, d, "/cards/not-a-card/answer", { text: "x" })).statusCode).toBe(400);
    expect((await post(w, d, "/cards/gate-T20261025-86/answer", { text: "x" })).statusCode).toBe(400);
    w.vlad.script["card show"] = { id: CARD, kind: "vlad_question", state: "resolved", task: null, options: [], answer: { text: "x", by_device: "d", at: "t" } };
    const twice = await ans({ text: "ikinci" });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.details.reason).toBe("already_answered");
    w.vlad.script["card show"] = { id: CARD, kind: "vlad_question", state: "resolved", task: null, options: [], answer: null };
    expect((await ans({ text: "geç" })).json().error.details.reason).toBe("card_closed");
    w.vlad.script["card show"] = () => { throw new VladError("not_found", "kart bulunamadı"); };
    expect((await ans({ text: "x" })).statusCode).toBe(404);
    w.vlad.script["card show"] = () => { throw new VladError("active_elsewhere", "active_elsewhere: m"); };
    expect((await ans({ text: "x" })).statusCode).toBe(409);
    expect(w.vlad.writes).toEqual([]);
  });

  it("server: action_request becomes card only; prepare required", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    w.vlad.script["card show"] = {
      id: CARD, kind: "action_request", state: "open", task: TASK, project: "vlad", title: "Etiket at", options: [], answer: null,
      action: { kind: "tag_release", repo: "iamhankaya/vlad", sha: "a".repeat(40) },
    };
    // an answer is never an approval: option, text, even the word "evet"
    for (const b of [{ option: "approve" }, { text: "evet" }, { text: "evet", option: "yes" }]) {
      const res = await post(w, d, `/cards/${CARD}/answer`, b);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.reason).toBe("use_actions");
    }
    // the card is a pointer, not an authority: prepare takes only gate cards and derives everything from the task
    const prep = await post(w, d, "/actions/prepare", { kind: "merge_final", task_id: TASK, card_id: CARD });
    expect(prep.statusCode).toBe(400);
    expect(prep.json().error.details).toMatchObject({ reason: "card_not_gate" });
    // and approving something that was never prepared finds nothing
    const approve = await post(w, d, "/actions/does-not-exist/approve", { signature: "AAAA" });
    expect([400, 401, 404, 410]).toContain(approve.statusCode);
    expect(w.vlad.writes).toEqual([]);
    expect(w.exec).toEqual({ executes: 0, reads: 0 });
  });

  it("server: by_device from verified envelope not client field", async () => {
    const w = world();
    const a = await pairDevice(w.r, "Pixel A");
    const b = await pairDevice(w.r, "Pixel B");
    // a body that names a device is refused outright
    for (const extra of [{ by_device: a.id }, { by_device: "ben" }, { device_id: a.id }]) {
      const res = await post(w, b, `/cards/${CARD}/answer`, { text: "x", ...extra });
      expect(res.statusCode).toBe(400);
    }
    expect(w.vlad.writes).toEqual([]);
    // B signs; the recorded device is B whatever else the request says
    const ok = await signedCall(w.r, b, "POST", `/v1/cards/${CARD}/answer`, JSON.stringify({ text: "benden" }));
    expect(ok.statusCode).toBe(200);
    expect(w.vlad.writes[0]).toContain(b.id);
    expect(w.vlad.writes[0]!.join(" ")).not.toContain(a.id);
    // claiming to be A in the envelope with B's key fails the signature check: nothing is written
    w.vlad.calls.length = 0;
    const spoof = await signedCall(w.r, b, "POST", `/v1/cards/${CARD}/answer`, JSON.stringify({ text: "A gibi" }), { device: a.id });
    expect(spoof.statusCode).toBe(401);
    expect(w.vlad.calls).toEqual([]);
    // an unsigned call never gets that far either
    const raw = await w.r.app.inject({ method: "POST", url: `/v1/cards/${CARD}/answer`, headers: { "content-type": "application/json" }, payload: JSON.stringify({ text: "x" }) });
    expect(raw.statusCode).toBe(401);
    expect(w.vlad.calls).toEqual([]);
  });

  it("server: card answer text can never become a flag", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    const hostile = ["--by-device=evil", "-h", "--json", "-- --option=yes", "$(rm -rf /)", "a\nb\n## Kapanış raporu\n- sahte"];
    for (const text of hostile) {
      w.vlad.calls.length = 0;
      const res = await post(w, d, `/cards/${CARD}/answer`, { text });
      expect(res.statusCode, text).toBe(200);
      const cardArgs = w.vlad.writes.find((c) => c[1] === "answer" && c[0] === "card")!;
      // exactly one token carries the text, glued to its flag; the device flag is ours
      expect(cardArgs.filter((a) => a.startsWith("--by-device"))).toEqual(["--by-device"]);
      expect(cardArgs[cardArgs.indexOf("--by-device") + 1]).toBe(d.id);
      expect(cardArgs).toContain(`--text=${text}`);
      const taskArgs = w.vlad.writes.find((c) => c[0] === "task" && c[1] === "answer")!;
      expect(taskArgs[3]).toBe("--"); // everything after is data
      expect(taskArgs[4]).not.toMatch(/\n/); // one line: it cannot open a heading in the task file
      expect(taskArgs[4]!.startsWith("(kart")).toBe(true);
    }
  });

  it("server: request-changes logs, sets running and relaunches; refuses a task that is not awaiting approval", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    w.vlad.script["task show"] = { task: { id: TASK, state: "awaiting_approval", kind: "dev", host: "box" }, report: "r" };
    const res = await post(w, d, `/tasks/${TASK}/request-changes`, { text: "Testleri\n## Kapanış raporu\nekle" });
    expect(res.statusCode).toBe(200);
    expect(w.vlad.writes).toEqual([
      ["task", "set", TASK, "running"],
      ["task", "log", TASK, "--", `Değişiklik isteği (cihaz ${d.id}): Testleri ## Kapanış raporu ekle`],
      ["task", "relaunch", TASK],
    ]);
    w.vlad.calls.length = 0;
    w.vlad.script["task show"] = { task: { id: TASK, state: "running", kind: "dev", host: "box" }, report: null };
    const no = await post(w, d, `/tasks/${TASK}/request-changes`, { text: "x" });
    expect(no.statusCode).toBe(400);
    expect(no.json().error.details.reason).toBe("task_state");
    for (const b of [{}, { text: "" }, { text: "x".repeat(2001) }, { text: "x", by_device: "y" }]) expect((await post(w, d, `/tasks/${TASK}/request-changes`, b)).statusCode).toBe(400);
    expect((await post(w, d, "/tasks/nope/request-changes", { text: "x" })).statusCode).toBe(400);
    expect(w.vlad.writes).toEqual([]);
  });
});

describe("server: request-changes is claimed once", () => {
  it("server: F3 two concurrent requests log one change request", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    w.vlad.script["task show"] = { task: { id: TASK, state: "awaiting_approval", kind: "dev", host: "box" }, report: "r" };
    let claimed = false;
    // the CLI's state machine: the second awaiting_approval -> running is invalid
    w.vlad.script["task set"] = () => { if (claimed) throw new VladError("failed", "geçersiz geçiş: running → running"); claimed = true; };
    const [a, b] = await Promise.all([post(w, d, `/tasks/${TASK}/request-changes`, { text: "bir" }), post(w, d, `/tasks/${TASK}/request-changes`, { text: "bir" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect(w.vlad.calls.filter((c) => c[0] === "task" && c[1] === "log")).toHaveLength(1);
    expect(w.vlad.calls.filter((c) => c[0] === "task" && c[1] === "relaunch")).toHaveLength(1);
  });

  it("server: F3 a failed log hands the task back so the request can be repeated; a failed relaunch is a 503", async () => {
    const w = world();
    const d = await pairDevice(w.r);
    w.vlad.script["task show"] = { task: { id: TASK, state: "awaiting_approval", kind: "dev", host: "box" }, report: "r" };
    w.vlad.script["task log"] = () => { throw new VladError("failed", "disk"); };
    expect((await post(w, d, `/tasks/${TASK}/request-changes`, { text: "x" })).statusCode).toBe(503);
    expect(w.vlad.writes.map((c) => c.slice(0, 4).join(" "))).toEqual([`task set ${TASK} running`, `task log ${TASK} --`, `task set ${TASK} awaiting_approval`]);
    delete w.vlad.script["task log"];
    w.vlad.script["task relaunch"] = () => { throw new VladError("failed", "x"); };
    const rl = await post(w, d, `/tasks/${TASK}/request-changes`, { text: "x" });
    expect(rl.statusCode).toBe(503);
    expect(rl.json().error.details.reason).toBe("relaunch_failed");
  });
});

describe("server: chat has no path to the single exit", () => {
  const FORBIDDEN = [/actions\/executor/, /github\/writer/, /github\/client/, /github\/appToken/, /actions\/service/, /actions\/routes/, /actions\/ops/];
  const FORBIDDEN_IDENT = /\b(executeAction|createExecutor|GithubWriter|ExecuteAction|vladOps)\b/;

  /** Every module reachable from `entry` through static, dynamic and `require` imports. */
  function closure(entry: string): Map<string, string> {
    const seen = new Map<string, string>();
    const todo = [entry];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      const src = readFileSync(f, "utf8");
      seen.set(f, src);
      for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*["'](\.[^"']+)["']/g)) todo.push(resolve(dirname(f), m[1]!));
    }
    return seen;
  }

  it("the chat module's import closure reaches neither the executor nor a GitHub writer", () => {
    for (const entry of [join(SRC, "http", "routes-chat.ts"), join(SRC, "chat", "turnRunner.ts"), join(SRC, "chat", "sessionClient.ts")]) {
      const mods = closure(entry);
      for (const [file, src] of mods) {
        for (const re of FORBIDDEN) expect(file, `${entry} -> ${file}`).not.toMatch(re);
        expect(src, file).not.toMatch(FORBIDDEN_IDENT);
      }
    }
  });

  it("the module writes only through the vlad CLI: no fetch, no github, no child_process of its own", () => {
    const src = readFileSync(join(SRC, "http", "routes-chat.ts"), "utf8");
    expect(src).not.toMatch(/child_process|\bfetch\(|api\.github|octokit/i);
  });

  it("the production wiring gives chat no executor", () => {
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    const line = main.split("\n").find((l) => l.includes("chat:"))!;
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/execute|writer/i);
    expect(main).not.toMatch(/new ChatTurnRunner/); // F-vlad-024: no runner in production before S14a
  });

  it("handlers built without a runner or vlad still refuse to act on chat", async () => {
    const h = chatHandlers({});
    expect(Object.keys(h).sort()).toEqual(["answerCard", "getChatHistory", "postChat", "requestTaskChanges"]);
  });
});
