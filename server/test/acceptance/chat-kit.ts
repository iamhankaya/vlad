// T11 kabul testleri için ortak yardımcılar. Arayüzden beslenir: `buildApp` (HTTP), `contract/openapi.yaml` ve S11a'nın
// `ChatTurnRunner`/`TurnClient` arayüzü. S11b'nin uygulama içi kablolaması henüz yok; TEK varsayım noktası `chatRig`:
// `AppConfig.chat = { runner }`. S11b farklı bir ad seçerse yalnız bu dosya uyarlanır, testler değişmez.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll } from "vitest";
import type { ExecuteAction } from "../../src/actions/service.ts";
import { ClaudeCliClient, SessionStore, sessionFileFor } from "../../src/chat/sessionClient.ts";
import { ChatTurnRunner, type RunnerOptions } from "../../src/chat/turnRunner.ts";
import { EventLedger } from "../../src/events/ledger.ts";
import type { AppConfig } from "../../src/http/app.ts";
import { makeFakeClaude, type FakeStep } from "../helpers/fakeClaude.ts";
import { call, pair, rig, type Phone, type Rig } from "./auth-kit.ts";

export const SID1 = "00000000-0000-4000-8000-000000000001"; // single-turn / resume-turn2 fixture oturumu
export const OK: FakeStep = { fixture: "single-turn.jsonl" };
export const CRASH: FakeStep = { exit: 1, stderr: "boom" };
export const TURN_TIMEOUT = 777_000;
export const BASE = 1_000;
export const MAX = 8_000;

/** Elle ateşlenen zamanlayıcılar: gerçek bekleme yok. */
export class FakeTimers {
  private next = 1;
  readonly items = new Map<number, { fn: () => void; ms: number }>();
  private readonly clock: { t: number };
  constructor(clock: { t: number }) { this.clock = clock; }
  setTimeout(fn: () => void, ms: number) { const id = this.next++; this.items.set(id, { fn, ms }); return id; }
  clearTimeout(h: unknown) { this.items.delete(h as number); }
  pending(ms: number) { return [...this.items.values()].some((t) => t.ms === ms); }
  fire(ms: number) {
    const hit = [...this.items.entries()].find(([, t]) => t.ms === ms);
    if (!hit) throw new Error(`no timer of ${ms} ms; pending: ${[...this.items.values()].map((t) => t.ms)}`);
    this.items.delete(hit[0]);
    this.clock.t += ms;
    hit[1].fn();
  }
}

/** Süreç başlatma gerçek G/Ç'dir; yalnız koşul önemlidir, 10 sn yalnız takılma bekçisi. */
export async function waitFor(cond: () => boolean, what: string) {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`never became true: ${what}`);
}

let root = "";
const savedEnv = { ...process.env };
const live: ChatTurnRunner[] = [];
const rigs: Rig[] = [];
let n = 0;

/** describe düzeyinde bir kez çağrılır: geçici kök + temizlik. */
export function useChatTmp() {
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "vlad-chat-acc-")); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  afterEach(async () => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    for (const r of live.splice(0)) r.stop();
    for (const r of rigs.splice(0)) await r.app.close();
  });
}

export function mkChat(over: Partial<RunnerOptions> = {}, steps: FakeStep[] = [OK], dir = join(root, `t${++n}`)) {
  mkdirSync(dir, { recursive: true });
  const claude = makeFakeClaude(join(dir, "bin"));
  claude.setSteps(steps);
  const clock = { t: Date.now() };
  const timers = new FakeTimers(clock);
  const state = join(dir, "state");
  const ledger = new EventLedger(state);
  const kb = join(dir, "kb");
  mkdirSync(kb, { recursive: true });
  const sessions = new SessionStore(sessionFileFor(state));
  const make = () => {
    const r = new ChatTurnRunner({
      client: new ClaudeCliClient({ bin: claude.bin, cwd: kb, protect: [state] }),
      sessions, ledger, stateDir: state, now: () => clock.t, timers,
      turnTimeoutMs: TURN_TIMEOUT, backoffBaseMs: BASE, backoffMaxMs: MAX, ...over,
    });
    live.push(r);
    return r;
  };
  return { dir, kb, state, claude, timers, clock, ledger, sessions, runner: make(), make };
}

export type Chat = ReturnType<typeof mkChat>;
export const setCards = (c: Chat, cards: object[]) => writeFileSync(join(c.dir, "cards.json"), JSON.stringify(cards));
/** Sahte CLI'nin gördüğü argv'ler. */
export const cliCalls = (c: Chat): string[][] => {
  try { return readFileSync(join(c.dir, "cli-calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
export const events = (l: EventLedger, type?: string) => l.after(0, 500).filter((e) => !type || e.type === type);

/** `executeAction`'ın tek yürütme sayacı ve her şeyi reddeden GitHub okuyucusu (sohbet yolu GitHub'a hiç dokunmamalı). */
export function execSpy() {
  const calls: unknown[] = [];
  const execute: ExecuteAction = async (action) => { calls.push(structuredClone(action)); return { merge_sha: "f".repeat(40) }; };
  const reads: string[] = [];
  const reader = new Proxy({}, { get: (_t, p) => (...a: unknown[]) => { reads.push(String(p)); void a; throw new Error("github touched by chat"); } });
  return { calls, reads, actions: { reader: reader as never, tasks: async () => null, projects: async () => null, execute, sleep: async () => {} } };
}

/** Sohbet uçları + eşleşmiş telefon. `AppConfig.chat` S11b'ye kadar bilinmeyen anahtardır (bkz. dosya başı). */
export async function chatRig(c: Chat, over: Partial<AppConfig> = {}) {
  // Sahte `vlad` CLI: her çağrının argv'sini `cli-calls.jsonl`'a yazar; `card show/list` yanıtı `cards.json`'dan gelir (S11b'nin kb'ye yazdığı
  // kartları taklit eder), diğer komutlar boş kb gösterir.
  const stub = join(c.dir, "stub-cli.js");
  writeFileSync(stub, `const fs=require("fs"),path=require("path");const a=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,"cli-calls.jsonl"),JSON.stringify(a)+"\\n");
let cards=[];try{cards=JSON.parse(fs.readFileSync(path.join(__dirname,"cards.json"),"utf8"))}catch{}
if(a[0]==="card"&&a[1]==="show"){const k=cards.find(x=>x.id===a[2]);if(!k){process.stderr.write(JSON.stringify({error:"kart bulunamadı"}));process.exit(1)}process.stdout.write(JSON.stringify(k))}
else if(a[0]==="card"&&a[1]==="list")process.stdout.write(JSON.stringify({cards:cards.filter(x=>x.state==="open"),warnings:[]}));
else{const o={task:{tasks:[],warnings:[]},quota:{limited:false,until:null,warnings:[]},active:{active:null,mine:false,warnings:[]}}[a[0]];process.stdout.write(JSON.stringify(o??{ok:true}))}`);
  process.env.VLAD_HOME = c.dir;
  process.env.VLAD_CLI = stub;
  const spy = execSpy();
  const cfg = {
    limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] },
    actions: spy.actions,
    chat: { runner: c.runner },
    ...over,
  } as unknown as Partial<AppConfig>;
  const r = rig(cfg);
  rigs.push(r);
  const phone = await pair(r);
  const post = (text: unknown, clientMsgId: unknown = `m-${++n}`) =>
    call(r, phone, "POST", "/v1/chat", JSON.stringify({ client_msg_id: clientMsgId, text }));
  const home = () => call(r, phone, "GET", "/v1/home");
  const history = (q = "") => call(r, phone, "GET", `/v1/chat/history${q}`);
  return { r, phone: phone as Phone, post, home, history, spy };
}
