import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCliClient, childEnv, CHILD_ENV_KEYS, LineSplitter, MAX_LINE_BYTES, SessionStore, sessionFileFor, chatPermissions, TurnParser, turnArgs } from "../../src/chat/sessionClient.ts";
import { BadChatRequest, ChatTurnRunner, type RunnerOptions } from "../../src/chat/turnRunner.ts";
import { EventLedger } from "../../src/events/ledger.ts";
import { registerReadRoutes } from "../../src/read/routes.ts";
import { makeFakeClaude, type FakeStep } from "../helpers/fakeClaude.ts";
import { validator } from "../helpers/openapi.ts";

const SID1 = "00000000-0000-4000-8000-000000000001"; // single-turn / resume-turn2 fixtures
const SID4 = "00000000-0000-4000-8000-000000000004"; // partial-messages fixture
const SID_OLD = "00000000-0000-4000-8000-0000000000aa";
const OK: FakeStep = { fixture: "single-turn.jsonl" };
const CRASH: FakeStep = { exit: 1, stderr: "boom" };

/** Timers the test fires by hand: no real delay anywhere. */
class FakeTimers {
  private next = 1;
  private readonly clock: { t: number };
  constructor(clock: { t: number }) { this.clock = clock; }
  readonly items = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number) { const id = this.next++; this.items.set(id, { fn, ms }); return id; }
  clearTimeout(h: unknown) { this.items.delete(h as number); }
  pending(ms: number) { return [...this.items.values()].some((t) => t.ms === ms); }
  fire(ms: number) {
    const hit = [...this.items.entries()].find(([, t]) => t.ms === ms);
    if (!hit) throw new Error(`no timer of ${ms} ms; pending: ${[...this.items.values()].map((t) => t.ms)}`);
    this.items.delete(hit[0]);
    this.clock.t += ms; // firing a timer is the time passing
    hit[1].fn();
  }
}

const TURN_TIMEOUT = 777_000;
const BASE = 1_000;
const MAX = 8_000;
let root: string;
const saved = { ...process.env };
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "vlad-chat-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

let n = 0;
const live: ChatTurnRunner[] = [];
afterEach(() => {
  for (const r of live.splice(0)) r.stop();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
});

function mk(over: Partial<RunnerOptions> = {}, steps: FakeStep[] = [OK], dir = join(root, `t${++n}`)) {
  mkdirSync(dir, { recursive: true });
  const claude = makeFakeClaude(join(dir, "bin"));
  claude.setSteps(steps);
  const clock = { t: Date.now() };
  const timers = new FakeTimers(clock);
  const ledger = new EventLedger(join(dir, "state"));
  const kb = join(dir, "kb");
  mkdirSync(kb, { recursive: true });
  const sessions = new SessionStore(sessionFileFor(join(dir, "state")));
  const make = () => {
    const r = new ChatTurnRunner({
      client: new ClaudeCliClient({ bin: claude.bin, cwd: kb, protect: [join(dir, "state")] }),
      sessions, ledger, stateDir: join(dir, "state"), now: () => clock.t, timers,
      turnTimeoutMs: TURN_TIMEOUT, backoffBaseMs: BASE, backoffMaxMs: MAX, ...over,
    });
    live.push(r);
    return r;
  };
  return { dir, kb, claude, timers, clock, ledger, sessions, runner: make(), make };
}

const events = (l: EventLedger, type?: string) => l.after(0, 500).filter((e) => !type || e.type === type);
const fixtureResult = (name: string) => {
  const line = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "contract", "fixtures", "external", "claude-stream-json", name), "utf8").split("\n").filter((l) => l.includes('"type": "result"')).pop()!;
  return JSON.parse(line).result as string;
};
async function waitFor(cond: () => boolean, what: string) {
  // Process start-up is real I/O; only the condition matters, the 10 s bound is just a hang guard.
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`never became true: ${what}`);
}

describe("server: chat turn runner", () => {
  it("server: chat turn replays real stream-json fixture", async () => {
    const t = mk({}, [OK, { fixture: "resume-turn2.jsonl" }]);
    const a = t.runner.submit({ clientMsgId: "m1", text: "selam" });
    await t.runner.whenIdle();
    expect(t.runner.get(a.chat_id)).toMatchObject({ status: "done", reply: fixtureResult("single-turn.jsonl") });
    expect(t.sessions.get()).toBe(SID1);
    const b = t.runner.submit({ clientMsgId: "m2", text: "bir daha" });
    await t.runner.whenIdle();
    expect(t.runner.get(b.chat_id)?.status).toBe("done");

    const [c1, c2] = t.claude.calls();
    expect(c1!.argv).not.toContain("--resume");
    expect(c1!.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--permission-mode", "auto"]));
    expect(c1!.stdin).toBe("selam");
    expect(c2!.argv.slice(c2!.argv.indexOf("--resume"))).toEqual(["--resume", SID1]);

    const done = events(t.ledger, "chat.done");
    expect(done.map((e) => e.data)).toEqual([{ chat_id: a.chat_id, status: "done" }, { chat_id: b.chat_id, status: "done" }]);
    const deltas = events(t.ledger, "chat.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    for (const e of [...deltas, ...done]) {
      expect(validator({ $ref: "#/components/schemas/Event" })(e)).toEqual([]);
      expect(JSON.stringify(e.data)).not.toContain("Merhaba"); // hint only by default (F-vlad-022)
    }
  });

  it("server: partial messages stream as deltas once, text only when deltaText is on", async () => {
    const t = mk({ deltaText: true, flushChars: 1 }, [{ fixture: "partial-messages.jsonl" }]);
    const a = t.runner.submit({ clientMsgId: "p1", text: "selam" });
    await t.runner.whenIdle();
    expect(t.sessions.get()).toBe(SID4);
    expect(events(t.ledger, "chat.delta").map((e) => e.data.text).join("")).toBe("Hi, hello there!");
    expect(t.runner.get(a.chat_id)?.reply).toBe("Hi, hello there!");
  });

  it("server: unknown/partial/over-1MB line, utf8 chunk boundary", async () => {
    const p = new TurnParser();
    expect(p.line('{"type":"zzz","subtype":"new"}')).toEqual([]);
    expect(p.line("not json")).toEqual([]);
    expect(p.line("[1,2]")).toEqual([]);
    expect(p.line('{"type":"system","subtype":"init","session_id":"--evil"}')).toEqual([]); // not an id

    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "şçğ 🙂 ü" }] } });
    const bytes = Buffer.from(line + "\n");
    for (let cut = 1; cut < bytes.length; cut++) {
      const s = new LineSplitter();
      expect([...s.push(bytes.subarray(0, cut)), ...s.push(bytes.subarray(cut))], `cut at ${cut}`).toEqual([line]);
    }
    const s = new LineSplitter();
    expect(s.push("abc")).toEqual([]); // unfinished line waits for its newline
    expect(s.push("\r\ndef\n")).toEqual(["abc", "def"]);
    expect(s.push("tail without newline")).toEqual([]);

    const big = new LineSplitter();
    expect(big.push("y".repeat(MAX_LINE_BYTES + 10))).toEqual([]);
    expect(big.push("z".repeat(50) + "\nok\n")).toEqual(["ok"]); // rest of the oversized line is dropped, the next line survives
    expect(new LineSplitter().push(`${"w".repeat(MAX_LINE_BYTES + 1)}\nok\n`)).toEqual(["ok"]);

    // end to end: a 1.1 MB junk line, an unknown event and half a JSON line around a real recording
    const t = mk({}, [{ bigLine: 1_100_000, lines: ['{"type":"brand_new_event"}', '{"type":"assis'], ...OK }]);
    const a = t.runner.submit({ clientMsgId: "big", text: "x" });
    await t.runner.whenIdle();
    expect(t.runner.get(a.chat_id)).toMatchObject({ status: "done", reply: "Merhaba" });
  });

  it("server: exit codes and hung turn timeout", async () => {
    const lim = mk({}, [{ lines: [JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "boom" })] }, OK]);
    // exit 0 but an error result, then success on the retry
    const a = lim.runner.submit({ clientMsgId: "e1", text: "x" });
    await lim.runner.whenIdle();
    expect(lim.runner.state()).toMatchObject({ status: "backoff", failures: 1, queued: 1, last_error: "result_error" });
    expect(lim.runner.get(a.chat_id)?.status).toBe("queued");
    lim.timers.fire(BASE);
    await lim.runner.whenIdle();
    expect(lim.runner.get(a.chat_id)?.status).toBe("done");
    expect(lim.runner.state()).toMatchObject({ status: "idle", failures: 0, last_error: null });

    const nz = mk({ maxAttempts: 1 }, [{ ...OK, exit: 3 }]); // non-zero exit even though a result line came
    const b = nz.runner.submit({ clientMsgId: "e2", text: "x" });
    await nz.runner.whenIdle();
    expect(nz.runner.get(b.chat_id)).toMatchObject({ status: "not_delivered", reason: "exit_3" });

    const nores = mk({ maxAttempts: 1 }, [{ lines: [] }]);
    const c = nores.runner.submit({ clientMsgId: "e3", text: "x" });
    await nores.runner.whenIdle();
    expect(nores.runner.get(c.chat_id)).toMatchObject({ status: "not_delivered", reason: "no_result" });

    const spawnFail = mk({ maxAttempts: 1 });
    const bad = new ChatTurnRunner({ client: new ClaudeCliClient({ bin: join(spawnFail.dir, "nope"), cwd: spawnFail.kb }), sessions: spawnFail.sessions, ledger: spawnFail.ledger, stateDir: join(spawnFail.dir, "s2"), now: () => 1, timers: spawnFail.timers, maxAttempts: 1 });
    live.push(bad);
    const d = bad.submit({ clientMsgId: "e4", text: "x" });
    await bad.whenIdle();
    expect(bad.get(d.chat_id)).toMatchObject({ status: "not_delivered", reason: "spawn" });

    const hung = mk({ maxAttempts: 1 }, [{ lines: ['{"type":"system","subtype":"init","session_id":"' + SID1 + '"}'], hang: true }]);
    const h = hung.runner.submit({ clientMsgId: "h1", text: "x" });
    await waitFor(() => hung.claude.startedPid() !== null, "fake claude started");
    const pid = hung.claude.startedPid()!;
    expect(hung.timers.pending(TURN_TIMEOUT)).toBe(true);
    hung.timers.fire(TURN_TIMEOUT);
    await hung.runner.whenIdle();
    expect(hung.runner.get(h.chat_id)).toMatchObject({ status: "not_delivered", reason: "timeout" });
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "hung child killed");
    expect(hung.timers.pending(TURN_TIMEOUT)).toBe(false); // the timeout timer is cleared
  });

  it("server: crash loop backoff then session_down state reflected in /home", async () => {
    const t = mk({ downAfter: 3, maxAttempts: 5 }, [CRASH, CRASH, CRASH, CRASH, OK]);
    const stub = join(t.dir, "stub-cli.js");
    writeFileSync(stub, `const a=process.argv.slice(2)[0];const o={task:{tasks:[],warnings:[]},card:{cards:[],warnings:[]},quota:{limited:false,until:null,warnings:[]},active:{active:null,mine:false,warnings:[]}}[a];process.stdout.write(JSON.stringify(o));`);
    process.env.VLAD_HOME = t.dir;
    process.env.VLAD_CLI = stub;
    const app = Fastify();
    registerReadRoutes(app, async () => undefined, { warnings: () => t.runner.warnings() });
    await app.ready();
    const home = async () => (await app.inject({ method: "GET", url: "/v1/home" })).json();

    const m1 = t.runner.submit({ clientMsgId: "c1", text: "x" });
    await t.runner.whenIdle();
    expect(t.runner.state()).toMatchObject({ status: "backoff", failures: 1 });
    expect(Date.parse(t.runner.state().retry_at!) - t.clock.t).toBe(BASE); // 1x
    t.timers.fire(BASE);
    await t.runner.whenIdle();
    expect(Date.parse(t.runner.state().retry_at!) - t.clock.t).toBe(2 * BASE); // 2x
    expect((await home()).warnings).toEqual([]);
    t.timers.fire(2 * BASE);
    await t.runner.whenIdle();

    expect(t.runner.state()).toMatchObject({ status: "session_down", failures: 3, queued: 0, last_error: "exit_1" });
    expect(t.runner.get(m1.chat_id)).toMatchObject({ status: "not_delivered", reason: "session_down" });
    const h = await home();
    expect(validator({ $ref: "#/components/schemas/Home" })(h)).toEqual([]);
    expect(h.warnings.some((w: string) => w.includes("session_down"))).toBe(true);
    expect(t.claude.calls().length).toBe(3);

    // while down (cool-down not over) a new message is refused at once, no process starts
    const m2 = t.runner.submit({ clientMsgId: "c2", text: "y" });
    expect(m2.status).toBe("not_delivered");
    expect(t.claude.calls().length).toBe(3);
    expect(events(t.ledger, "chat.done").map((e) => e.data.status)).toEqual(["not_delivered", "not_delivered"]);

    // after the cool-down one probe goes through; a failing probe re-opens the cool-down
    t.clock.t += MAX;
    const probe = t.runner.submit({ clientMsgId: "c3", text: "z" });
    await t.runner.whenIdle();
    expect(t.runner.get(probe.chat_id)).toMatchObject({ status: "not_delivered", reason: "session_down" });
    expect(t.runner.state().status).toBe("session_down");
    expect(t.claude.calls().length).toBe(4);

    t.clock.t += MAX;
    const ok = t.runner.submit({ clientMsgId: "c4", text: "w" });
    await t.runner.whenIdle();
    expect(t.runner.get(ok.chat_id)?.status).toBe("done");
    expect(t.runner.state()).toMatchObject({ status: "idle", failures: 0 });
    expect((await home()).warnings).toEqual([]);
    await app.close();
  });

  it("server: backoff doubles and is capped", async () => {
    const t = mk({ downAfter: 20, maxAttempts: 20 }, [CRASH]);
    t.runner.submit({ clientMsgId: "b1", text: "x" });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      await t.runner.whenIdle();
      const ms = Date.parse(t.runner.state().retry_at!) - t.clock.t;
      seen.push(ms);
      t.timers.fire(ms);
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("server: message not lost or marked not_delivered", async () => {
    // a crash left one message running and one queued
    const dir = join(root, `t${++n}`);
    mkdirSync(join(dir, "state"), { recursive: true });
    const msg = (i: number, status: string) => JSON.stringify({ t: "msg", chat_id: `chat-${i}`, client_msg_id: `old${i}`, text: `m${i}`, at: new Date().toISOString(), status });
    writeFileSync(join(dir, "state", "chat.jsonl"), [msg(1, "running"), msg(2, "queued"), '{"t":"set","chat_id":"chat-2","status":"queu'].join("\n"));
    const t = mk({}, [OK], dir);
    await t.runner.whenIdle();
    expect(t.runner.get("chat-1")).toMatchObject({ status: "not_delivered", reason: "restart" });
    expect(t.runner.get("chat-2")).toMatchObject({ status: "done" });
    expect(t.claude.calls().map((c) => c.stdin)).toEqual(["m2"]);
    expect(events(t.ledger, "chat.done").map((e) => e.data)).toEqual([{ chat_id: "chat-1", status: "not_delivered", reason: "restart" }, { chat_id: "chat-2", status: "done" }]);

    // a second restart repeats nothing and ids continue
    const again = t.make();
    expect(events(t.ledger, "chat.done").length).toBe(2);
    expect(again.submit({ clientMsgId: "new", text: "x" }).chat_id).toBe("chat-3");
    await again.whenIdle();

    // serial order, and every message ends in a terminal state
    const s = mk({}, [OK, { fixture: "resume-turn2.jsonl" }]);
    const ids = ["a", "b", "c"].map((x) => s.runner.submit({ clientMsgId: x, text: x }).chat_id);
    await s.runner.whenIdle();
    expect(s.claude.calls().map((c) => c.stdin)).toEqual(["a", "b", "c"]);
    expect(s.claude.calls().slice(1).every((c) => c.argv.includes(SID1))).toBe(true); // b and c started after a had stored the session
    expect(ids.map((i) => s.runner.get(i)?.status)).toEqual(["done", "done", "done"]);

    // a full queue refuses with an explicit status, not silence
    const q = mk({ maxQueue: 1 }, [{ hang: true }]);
    q.runner.submit({ clientMsgId: "q1", text: "x" });
    const over = q.runner.submit({ clientMsgId: "q2", text: "y" });
    expect(q.runner.get(over.chat_id)).toMatchObject({ status: "not_delivered", reason: "queue_full" });
    await waitFor(() => q.claude.startedPid() !== null, "started");
    q.runner.stop();
    await q.runner.whenIdle();
    expect(q.runner.messages().every((m) => m.status === "queued" || m.status === "not_delivered")).toBe(true);
  });

  it("server: client_msg_id deduped", async () => {
    const t = mk({}, [OK]);
    const a = t.runner.submit({ clientMsgId: "same", text: "bir" });
    const dup = t.runner.submit({ clientMsgId: "same", text: "bir" }); // while it runs
    expect(dup).toMatchObject({ chat_id: a.chat_id, duplicate: true });
    await t.runner.whenIdle();
    expect(t.runner.submit({ clientMsgId: "same", text: "farklı metin" })).toMatchObject({ chat_id: a.chat_id, duplicate: true, status: "done" });
    expect(t.claude.calls().length).toBe(1);
    expect(t.runner.submit({ clientMsgId: "other", text: "bir" }).duplicate).toBe(false);
    await t.runner.whenIdle();
    // survives a restart
    expect(t.make().submit({ clientMsgId: "same", text: "bir" })).toMatchObject({ chat_id: a.chat_id, duplicate: true });
    expect(t.claude.calls().length).toBe(2);
    for (const bad of ["", "a b", "x".repeat(65), "../x"]) expect(() => t.runner.submit({ clientMsgId: bad, text: "x" })).toThrow(BadChatRequest);
    for (const text of ["", "x".repeat(4001)]) expect(() => t.runner.submit({ clientMsgId: "ok1", text })).toThrow(BadChatRequest);
  });

  it("server: resume fallback when session id invalid", async () => {
    const t = mk({}, [{ fixture: "resume-invalid-session.jsonl", exit: 1, stderr: "No conversation found with session ID: x" }, OK]);
    t.sessions.set(SID_OLD);
    const a = t.runner.submit({ clientMsgId: "r1", text: "selam" });
    await t.runner.whenIdle();
    const [c1, c2] = t.claude.calls();
    expect(c1!.argv).toContain(SID_OLD);
    expect(c2!.argv).not.toContain("--resume");
    expect(c2!.stdin).toBe("selam");
    expect(t.runner.get(a.chat_id)).toMatchObject({ status: "done", reply: "Merhaba" });
    expect(t.sessions.get()).toBe(SID1);
    expect(t.runner.state()).toMatchObject({ status: "idle", failures: 0 }); // not a crash

    // the fallback happens once per attempt: a second invalid answer is an ordinary failure, no loop
    const loop = mk({ maxAttempts: 1 }, [{ fixture: "resume-invalid-session.jsonl", exit: 1, stderr: "No conversation found" }]);
    loop.sessions.set(SID_OLD);
    const b = loop.runner.submit({ clientMsgId: "r2", text: "x" });
    await loop.runner.whenIdle();
    expect(loop.claude.calls().length).toBe(2);
    expect(loop.runner.get(b.chat_id)).toMatchObject({ status: "not_delivered", reason: "exit_1" });
  });

  it("server: usage limit is not_delivered without backoff", async () => {
    const t = mk({}, [{ fixture: "limit-event.synthetic.jsonl" }]); // SYNTHETIC recording (MANIFEST)
    const a = t.runner.submit({ clientMsgId: "l1", text: "x" });
    await t.runner.whenIdle();
    expect(t.runner.get(a.chat_id)).toMatchObject({ status: "not_delivered", reason: "limit" });
    expect(t.runner.state()).toMatchObject({ status: "idle", failures: 0, queued: 0 });
  });

  it("server: argv injection (; rm -rf, leading -) safe", async () => {
    const dangerous = "--dangerously-skip-" + "permissions"; // spelled in two parts so the repo grep below has nothing to find here
    const texts = ["; rm -rf /", dangerous, "-p evil", "--resume ../../x", "$(touch pwned)", "`id`", "a\nb && curl x | sh", "-"];
    const t = mk({}, [OK, { fixture: "resume-turn2.jsonl" }]);
    process.env.SECRET_TOKEN = "s3cret";
    process.env.CLAUDE_CODE_SESSION_ID = "inherited";
    process.env.VLAD_HOME = "/vlad";
    texts.forEach((x, i) => t.runner.submit({ clientMsgId: `i${i}`, text: x }));
    await t.runner.whenIdle();
    const calls = t.claude.calls();
    expect(calls.map((c) => c.stdin)).toEqual(texts); // the prompt travels on stdin, verbatim
    for (const c of calls) {
      for (const x of texts) expect(c.argv).not.toContain(x);
      expect(c.argv).not.toContain(dangerous);
      expect(c.argv.filter((a) => a.startsWith("-") || a === SID1).every((a) => a === SID1 || /^--?[A-Za-z][A-Za-z-]*$/.test(a))).toBe(true);
      expect(c.env.every((k) => (CHILD_ENV_KEYS as readonly string[]).includes(k))).toBe(true); // no SECRET_TOKEN, no CLAUDE_CODE_*
    }
    expect(existsSync(join(t.dir, "pwned"))).toBe(false);
    expect(childEnv({ PATH: "/bin", HOME: "/h", SECRET_TOKEN: "x", CLAUDE_CODE_SESSION_ID: "y", VLAD_KB_DIR: "/kb" })).toEqual({ PATH: "/bin", HOME: "/h", VLAD_KB_DIR: "/kb" });

    // a poisoned session file never reaches argv
    for (const bad of ["--evil", "x; rm -rf /", "abc", "-----------------", "a b c d e f g h"]) {
      writeFileSync(t.sessions.path, bad);
      expect(t.sessions.get(), bad).toBeNull();
    }
    expect(() => turnArgs("--evil", "/kb")).toThrow();
    expect(() => turnArgs("abcdefgh; rm -rf /", "/kb")).toThrow();
    expect(() => turnArgs(null, "kb")).toThrow(/absolute/);
    const argv = turnArgs(SID1, "/kb");
    expect(argv.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "auto"]);
    expect(argv.slice(-2)).toEqual(["--resume", SID1]);
  });

  it("server: chat permissions are fixed inline, narrow, and passed twice", async () => {
    const t = mk({}, [OK]);
    t.runner.submit({ clientMsgId: "s1", text: "x" });
    await t.runner.whenIdle();
    const argv = t.claude.calls()[0]!.argv;
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    const perm = chatPermissions(t.kb, [join(t.dir, "state")]);
    expect(settings).toEqual({ permissions: perm }); // inline JSON, no file path
    expect(argv[argv.indexOf("--settings") + 1]!.startsWith("{")).toBe(true); // JSON text, not a path to a file the agent could edit
    const dis = argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--resume") === -1 ? undefined : argv.indexOf("--resume"));
    expect(dis.slice(0, perm.deny.length)).toEqual(perm.deny); // same deny list as a flag: it holds even if settings were lost
    const kbGlob = `/${t.kb}/**`;
    expect(perm.allow).toEqual([`Read(${kbGlob})`, `Grep(${kbGlob})`, `Glob(${kbGlob})`, "Bash(vlad *)"]);
    // no unscoped read tool: a read of any absolute path outside the kb has no allow rule
    expect(perm.allow.filter((a) => /^(Read|Grep|Glob)$/.test(a))).toEqual([]);
    expect(perm.allow.every((a) => a === "Bash(vlad *)" || a.endsWith(`(${kbGlob})`))).toBe(true);
    expect(chatPermissions("/srv/other-kb").allow).toContain("Read(//srv/other-kb/**)");
    for (const r of ["Bash(git push*)", "Bash(gh *)", "WebFetch", "Bash(rm:*)", "Bash(find * -delete*)", "Bash(python* -c*)", "Bash(node -e*)", "Bash(curl*)", "Bash(wget*)",
      "Edit(**/deploy/**)", "Write(**/deploy/**)", "Write(**/worker-settings.json)", "Read(//var/lib/vladapi/**)", "Edit(~/.vlad-server/**)", "Write(~/.claude/**)", "Read(~/.claude/**)",
      `Edit(/${join(t.dir, "state")}/**)`, `Read(/${join(t.dir, "state")}/**)`]) {
      expect(perm.deny, r).toContain(r);
    }
    expect(perm.allow.some((a) => /^(node|npx|Edit|Write)/.test(a) || a.startsWith("Bash(node") || a.startsWith("Bash(npx"))).toBe(false);
    expect(t.claude.calls()[0]!.cwd).toBe(t.kb);
    expect(existsSync(join(t.dir, "state", "chat-session.txt"))).toBe(true); // state dir, not the kb the agent works in
    expect(existsSync(join(t.kb, "logs"))).toBe(false);
  });

  it("server: cwd is required, absolute and existing", async () => {
    const t = mk();
    expect(() => new ClaudeCliClient({ cwd: "kb" })).toThrow(/cwd/);
    expect(() => new ClaudeCliClient({ cwd: join(t.dir, "nope") })).toThrow(/cwd/);
    expect(() => new ClaudeCliClient({} as never)).toThrow(/cwd/);
    expect(() => new ClaudeCliClient({ cwd: t.kb, protect: ["rel"] })).toThrow(/protect/);
    const gone = join(t.dir, "gone");
    mkdirSync(gone);
    const c = new ClaudeCliClient({ bin: t.claude.bin, cwd: gone });
    rmSync(gone, { recursive: true });
    const out = await c.run({ sessionId: null, text: "x" }, () => {}, new AbortController().signal);
    expect(out).toEqual({ kind: "spawn", error: "cwd" });
    expect(t.claude.calls().length).toBe(0);
  });

  it("server: a turn that already ran is never retried automatically", async () => {
    // tools/model ran, then the process failed: reported, not repeated
    const t = mk({ maxAttempts: 3 }, [{ ...OK, exit: 3 }, OK]);
    const a = t.runner.submit({ clientMsgId: "n1", text: "x" });
    await t.runner.whenIdle();
    expect(t.runner.get(a.chat_id)).toMatchObject({ status: "not_delivered", reason: "exit_3" });
    expect(t.claude.calls().length).toBe(1);
    expect(t.runner.state()).toMatchObject({ status: "backoff", failures: 1, queued: 0 });

    // a hang after output is the same
    const h = mk({ maxAttempts: 3 }, [{ fixture: "ask-turn.jsonl", hang: true }, OK]);
    const b = h.runner.submit({ clientMsgId: "n2", text: "x" });
    await waitFor(() => h.claude.startedPid() !== null, "started");
    h.timers.fire(TURN_TIMEOUT);
    await h.runner.whenIdle();
    expect(h.runner.get(b.chat_id)).toMatchObject({ status: "not_delivered", reason: "timeout" });
    expect(h.claude.calls().length).toBe(1);

    // a hang before any model output (only init) is retried
    const r = mk({ maxAttempts: 3 }, [{ lines: ['{"type":"system","subtype":"init"}'], hang: true }, OK]);
    const c = r.runner.submit({ clientMsgId: "n3", text: "x" });
    await waitFor(() => r.claude.startedPid() !== null, "started");
    r.timers.fire(TURN_TIMEOUT);
    await r.runner.whenIdle();
    expect(r.runner.get(c.chat_id)?.status).toBe("queued");
    r.timers.fire(BASE);
    await r.runner.whenIdle();
    expect(r.runner.get(c.chat_id)?.status).toBe("done");
    expect(r.claude.calls().length).toBe(2);
  });

  it("server: delta events are capped per turn, the reply is not", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `p${i} ` } } }));
    const t = mk({ maxDeltas: 3, flushChars: 1, deltaText: true }, [{ lines: [...lines, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: null, session_id: SID1 })] }]);
    const a = t.runner.submit({ clientMsgId: "d1", text: "x" });
    await t.runner.whenIdle();
    expect(events(t.ledger, "chat.delta").length).toBe(3);
    expect(t.runner.get(a.chat_id)?.reply).toBe(Array.from({ length: 12 }, (_, i) => `p${i} `).join(""));
    // past 64 KB nothing more is kept or announced
    const big = "z".repeat(40_000);
    const bl = Array.from({ length: 4 }, () => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: big } } }));
    const u = mk({ flushChars: 1 }, [{ lines: [...bl, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: null })] }]);
    const b = u.runner.submit({ clientMsgId: "d2", text: "x" });
    await u.runner.whenIdle();
    expect(u.runner.get(b.chat_id)?.reply?.length).toBe(64 * 1024);
    expect(events(u.ledger, "chat.delta").length).toBe(2); // 2 x 40 KB crosses the cap, the rest is dropped
  });

  it("server: the process group dies when the turn ends normally", async () => {
    const t = mk({}, [{ ...OK, bg: true }]);
    t.runner.submit({ clientMsgId: "g1", text: "x" });
    await t.runner.whenIdle();
    const pid = t.claude.bgPid()!;
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "background child killed");
  });

  it("server: log compaction uses a private temp file", () => {
    const dir = join(root, `t${++n}`);
    mkdirSync(join(dir, "state"), { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 2100; i++) lines.push(JSON.stringify({ t: "msg", chat_id: `chat-${i}`, client_msg_id: `k${i}`, text: "x", at: new Date().toISOString(), status: "done" }));
    writeFileSync(join(dir, "state", "chat.jsonl"), lines.join("\n") + "\n");
    const t = mk({}, [OK], dir);
    expect(readFileSync(join(dir, "state", "chat.jsonl"), "utf8").split("\n").filter(Boolean).length).toBe(500);
    expect(readdirSync(join(dir, "state")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(statSync(join(dir, "state", "chat.jsonl")).mode & 0o777).toBe(0o600);
    // pruned messages are still deduplicated (in memory)
    expect(t.runner.submit({ clientMsgId: "k1", text: "x" })).toMatchObject({ chat_id: "chat-1", duplicate: true });
  });

  it("server: no skip-permissions flag anywhere in the code", () => {
    const flag = "--dangerously-skip-" + "permissions";
    const repo = resolve(import.meta.dirname, "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|json|sh|service|md|yaml|yml)$/.test(e.name) && readFileSync(p, "utf8").includes(flag)) hits.push(p.slice(repo.length + 1));
      }
    };
    for (const d of ["server/src", "src", "deploy"]) if (existsSync(join(repo, d))) walk(join(repo, d));
    expect(hits).toEqual([]);
  });
});

