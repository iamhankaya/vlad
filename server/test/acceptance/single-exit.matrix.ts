// T9 kabul: tek çıkış matrisi ve ortak dünya. Sahibi T9 (plan "Paylaşılan dosyalar"). Yalnız arayüzden beslenir:
//  - HTTP (`buildApp`), `contract/openapi.yaml` (rota envanteri, hata şeması), `contract/signing-vectors.json` (challenge biçimi),
//  - plan "Sistem tasarımı" negatif listeleri,
//  - S9a'nın `AppConfig.actions` arayüzü: sahte `GithubReader` + `executeAction` burada kurulur (S9a'nın kendi testlerinden kopyalama yok).
// Yeni bir `session+approval` ya da eylem uçu satırsız eklenirse `route-inventory.test.ts` kırılır.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { CheckRun, CombinedStatus, GithubReader, PullFacts } from "../../src/actions/github.ts";
import type { ActionDescriptor, ApprovalProof, ExecuteAction, TaskInfo } from "../../src/actions/service.ts";
import type { ProjectInfo } from "../../src/actions/service.ts";
import { ActionError } from "../../src/actions/service.ts";
import {
  CONTRACT, Phone, call, pair, revokeText, rig, signHighS, signLowS, signRawRS, type Clock, type Rig,
} from "./auth-kit.ts";

export { Phone, signLowS, signHighS, signRawRS };

// ---- openapi envanteri --------------------------------------------------------------------------------------------

const doc: any = parse(readFileSync(join(CONTRACT, "openapi.yaml"), "utf8"));
const METHODS = ["get", "post", "put", "delete", "patch"];
export type Op = { id: string; method: string; path: string; auth: string; tags: string[] };
export const OPS: Op[] = Object.entries<any>(doc.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({ id: item[m].operationId as string, method: m.toUpperCase(), path: "/v1" + path, auth: item[m]["x-vlad-auth"] as string, tags: (item[m].tags ?? []) as string[] })),
);

// ---- sahte dünya: GitHub, görevler, proje kartları, yürütücü -------------------------------------------------------

export const REPO = "acme/widgets";
export const PARENT = "T20261024-94";
export const T1 = "T20261025-84"; // faz görevi (merge_phase)
export const T2 = "T20261025-85"; // ikinci faz (ikinci canlı challenge için)
export const T3 = "T20261025-86"; // kök görev (merge_final)
export const sha40 = (c: string) => c.repeat(40).slice(0, 40);
export const HEAD = sha40("a");
export const HEAD_MOVED = sha40("b");
export const MERGE_SHA = sha40("c");

const READS = new Set(["getPull", "getCheckRuns", "getCombinedStatus"]);

export class Gate {
  private open_!: () => void;
  readonly promise = new Promise<void>((r) => (this.open_ = r));
  open = () => this.open_();
}

/** Bir yöntemin ilk çağrısını tutar: `entered` çağrı içeri girince çözülür, `release()` bırakır. */
export type Block = { entered: Promise<void>; release: () => void };

class FakeGh implements GithubReader {
  pulls = new Map<number, PullFacts>();
  runs: CheckRun[] = [{ name: "gate", status: "completed", conclusion: "success" }];
  status: CombinedStatus = { state: "success", total_count: 1 };
  missing = new Set<number>();
  calls: string[] = [];
  /** Okuma arayüzü dışında çağrılan her yöntem (ileride `GithubWriter`): yazma sayılır. */
  strayWrites: string[] = [];
  private blocks = new Map<string, { gate: Gate; enter: () => void }>();

  block(method: "getPull" | "getCheckRuns" | "getCombinedStatus"): Block {
    const gate = new Gate();
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    this.blocks.set(method, { gate, enter });
    return { entered, release: gate.open };
  }
  private async maybeBlock(method: string) {
    const b = this.blocks.get(method);
    if (!b) return;
    this.blocks.delete(method);
    b.enter();
    await b.gate.promise;
  }

  async getPull(_repo: string, pr: number): Promise<PullFacts | null> {
    this.calls.push("getPull");
    await this.maybeBlock("getPull");
    if (this.missing.has(pr)) return null;
    const p = this.pulls.get(pr);
    return p ? structuredClone(p) : null;
  }
  async getCheckRuns(): Promise<CheckRun[]> {
    this.calls.push("getCheckRuns");
    await this.maybeBlock("getCheckRuns");
    return structuredClone(this.runs);
  }
  async getCombinedStatus(): Promise<CombinedStatus> {
    this.calls.push("getCombinedStatus");
    await this.maybeBlock("getCombinedStatus");
    return structuredClone(this.status);
  }
}

export type ExecCall = { action: ActionDescriptor; proof: ApprovalProof };

/** kb tarafı (S10a): `vlad grant add` yerine geçen kayıt defteri; devir kayıtlarını sayar. */
export class FakeGrantKb {
  added: { id: string; device_id: string; signature: string }[] = [];
  async add(rec: { id: string; device_id: string; signature: string }) {
    this.added.push(structuredClone(rec));
  }
  async list() {
    return { grants: [] as { id: string; revoked: boolean }[], warnings: [] as string[] };
  }
  async revoke() {}
}

/** Kontrattaki (`signing-vectors.json` `grant`) imzalı bayt dizisi; sunucu koduna bakılmadan yazıldı. */
export const grantPayload = (g: { id: string; scope: { type: string; ref: string }; action: string; conditions: string[]; created: string; expires: string; max_uses: number }) =>
  ["vlad-grant/v1", `id=${g.id}`, `scope=${g.scope.type}:${g.scope.ref}`, `action=${g.action}`, `conditions=${[...g.conditions].sort().join(",")}`, `created=${g.created}`, `expires=${g.expires}`, `max_uses=${g.max_uses}`].join("\n");

export type WorldOpts = { policy?: { allowBlocked?: boolean; prepareIntervalMs?: number; maxBadSignatures?: number } };

export class World {
  readonly r: Rig;
  readonly gh: FakeGh;
  /** Sunucuya verilen okuyucu: okuma dışı her çağrı `strayWrites`'a düşer. */
  readonly reader: GithubReader;
  readonly tasks = new Map<string, TaskInfo>();
  readonly projects = new Map<string, ProjectInfo>();
  readonly execCalls: ExecCall[] = [];
  readonly kb = new FakeGrantKb();
  /** Yürütücünün yaptığı tek GitHub yazması: PR'ı birleştirir. */
  readonly mergeWrites: string[] = [];
  execGate: Gate | null = null;
  execEntered: (() => void) | null = null;
  execFail: Error | null = null;
  private opened = false;

  constructor(opts: WorldOpts = {}) {
    this.gh = new FakeGh();
    this.reader = new Proxy(this.gh, {
      get: (t, p, rcv) => {
        const v = Reflect.get(t, p, rcv);
        if (typeof v !== "function" || typeof p !== "string") return v;
        if (READS.has(p)) return v.bind(t);
        return (...a: unknown[]) => {
          t.strayWrites.push(p);
          return v.apply(t, a);
        };
      },
    });
    for (const [t, n, base, parent] of [[T1, 42, `vlad/${PARENT}`, PARENT], [T2, 43, `vlad/${PARENT}`, PARENT], [T3, 44, "main", null]] as const) {
      this.tasks.set(t, { id: t, project: "widgets", state: "awaiting_approval", parent, pr: { number: n, repo: REPO, base } });
      this.gh.pulls.set(n, {
        number: n, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "clean",
        head: { sha: HEAD, ref: `vlad/${t}`, repo: REPO }, base: { ref: base, repo: REPO },
      });
    }
    this.projects.set("widgets", { repo: REPO, default_branch: "main" });

    const execute: ExecuteAction = async (action, proof) => {
      this.execCalls.push({ action: structuredClone(action), proof: structuredClone(proof) });
      this.execEntered?.();
      if (this.execGate) await this.execGate.promise;
      if (this.execFail) throw this.execFail;
      this.mergeWrites.push(`merge #${action.pr} sha=${action.head_sha}`);
      const p = this.gh.pulls.get(action.pr);
      if (p) {
        p.merged = true;
        p.state = "closed";
      }
      return { merge_sha: MERGE_SHA };
    };
    this.r = rig(
      {
        limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] },
        actions: {
          reader: this.reader,
          tasks: async (id) => {
            const t = this.tasks.get(id);
            return t ? structuredClone(t) : null;
          },
          projects: async (slug) => {
            const p = this.projects.get(slug);
            return p ? structuredClone(p) : null;
          },
          execute,
          sleep: async () => {},
          policy: { prepareIntervalMs: 0, ...opts.policy },
        },
        grants: { kb: this.kb },
      },
    );
  }

  get clock(): Clock {
    return this.r.clock;
  }
  /** `executeAction` çağrı sayısı. */
  get exec() {
    return this.execCalls.length;
  }
  /** GitHub'a yazan çağrı sayısı: yürütücünün birleştirmeleri + okuma arayüzü dışındaki her çağrı. */
  get writes() {
    return this.mergeWrites.length + this.gh.strayWrites.length;
  }

  async settle() {
    await this.r.app.vladActions?.settled();
  }
  async close() {
    if (this.opened) return;
    this.opened = true;
    await this.r.app.close();
  }

  phone = (name = "Pixel 9") => pair(this.r, new Phone(name));
  advance = (ms: number) => void (this.clock.t += ms);

  /** `kind` verilmezse görevden beklenen tür (parent'lı = merge_phase). */
  prepare(p: Phone, task = T1, o: { kind?: string; body?: unknown } = {}) {
    const kind = o.kind ?? (this.tasks.get(task)?.parent ? "merge_phase" : "merge_final");
    return call(this.r, p, "POST", "/v1/actions/prepare", JSON.stringify(o.body ?? { kind, task_id: task }));
  }
  async prepared(p: Phone, task = T1): Promise<Prepared> {
    const res = await this.prepare(p, task);
    if (res.statusCode !== 200) throw new Error(`prepare failed ${res.statusCode} ${res.body}`);
    return res.json();
  }
  /** Challenge baytları üzerinde `key` ile (varsayılan: cihazın approval anahtarı) low-S imza. */
  sign(p: Phone, ch: { bytes_b64: string }, key: "approval" | "session" = "approval", fn: typeof signLowS = signLowS) {
    return fn(p[key].priv, Buffer.from(ch.bytes_b64, "base64"));
  }
  approve(p: Phone, actionId: string, body: unknown, o?: Parameters<Phone["headers"]>[4]) {
    return call(this.r, p, "POST", `/v1/actions/${actionId}/approve`, typeof body === "string" ? body : JSON.stringify(body), o);
  }
  /** Geçerli onay: cihazın approval anahtarıyla imzalı. */
  approveValid(p: Phone, ch: Prepared, o?: Parameters<Phone["headers"]>[4]) {
    return this.approve(p, ch.action_id, { signature: this.sign(p, ch) }, o);
  }
  /** `p` cihazı adına imzalı devir gövdesi (varsayılan: onun approval anahtarıyla, kapsam proje `widgets`, şimdi → +1 gün). */
  grantBody(p: Phone, over: Record<string, unknown> = {}, key: "approval" | "session" = "approval", fn: typeof signLowS = signLowS) {
    const g: any = {
      id: "G-001", scope: { type: "project", ref: "widgets" }, action: "merge_phase", conditions: ["ci_green"],
      created: new Date(this.clock.t).toISOString(), expires: new Date(this.clock.t + 86_400_000).toISOString(), max_uses: 3, payload_version: "v1", ...over,
    };
    return { ...g, signature: over.signature ?? fn(p[key].priv, grantPayload(g)) };
  }
  postGrant(p: Phone, body: unknown) {
    return call(this.r, p, "POST", "/v1/grants", typeof body === "string" ? body : JSON.stringify(body));
  }
  /** `by` cihazı `target` cihazı iptal eder (iptal imzası `by`'ın approval anahtarıyla). */
  revoke(by: Phone, target: string) {
    const ts = this.clock.t;
    return call(this.r, by, "POST", `/v1/devices/${target}/revoke`, JSON.stringify({ ts_ms: ts, signature: signLowS(by.approval.priv, revokeText(target, by.id, ts)) }), { ts });
  }
  /** `exec` içinde tutar: yürütücü çağrılınca `entered` çözülür, `release()` ile devam eder. */
  holdExec(): Block {
    const gate = new Gate();
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    this.execGate = gate;
    this.execEntered = enter;
    return { entered, release: gate.open };
  }
  pull(task = T1): PullFacts {
    return this.gh.pulls.get(this.tasks.get(task)!.pr!.number)!;
  }
}

export type Prepared = { action_id: string; bytes_b64: string; fields: Record<string, string>; exp: number };
export type Res = Awaited<ReturnType<Rig["app"]["inject"]>>;

// ---- saldırı matrisi ----------------------------------------------------------------------------------------------

export type ReqOpts = Parameters<Phone["headers"]>[4] & { body?: string; unsigned?: boolean; as?: Phone };
export type ExitEndpoint = {
  operationId: string;
  /** Uç gerçekten uygulanmış mı; `false` ise (ör. S10a gelmedi) yalnız "hiçbir yanıt 2xx değil ve çıkış 0" denetlenir. */
  implemented: boolean;
  /** Yasal durumu kurar (örn. challenge hazırlar). `a` istek sahibi cihaz. */
  setup(w: World, a: Phone): Promise<any>;
  /** `a` cihazı adına, `s` yasal durumuyla geçerli bir istek; `o` ile zarf alanları bozulur. */
  fire(w: World, a: Phone, s: any, o?: ReqOpts): Promise<Res>;
  /** Geçerli çağrıda beklenen yürütme sayısı. */
  validExecutions: number;
};

const PREPARE_PATH = "/v1/actions/prepare";

async function send(w: World, a: Phone, method: string, target: string, body: string, o: ReqOpts = {}): Promise<Res> {
  const { unsigned, as, body: _b, ...hdr } = o;
  if (unsigned) return w.r.app.inject({ method: method as "POST", url: target, headers: { "content-type": "application/json" }, payload: body });
  return call(w.r, as ?? a, method, target, body, hdr);
}

export const EXIT_ENDPOINTS: ExitEndpoint[] = [
  {
    operationId: "prepareAction",
    implemented: true,
    validExecutions: 0,
    setup: async () => ({}),
    fire: (w, a, _s, o) => send(w, a, "POST", PREPARE_PATH, o?.body ?? JSON.stringify({ kind: "merge_phase", task_id: T1 }), o),
  },
  {
    operationId: "approveAction",
    implemented: true,
    validExecutions: 1,
    setup: (w, a) => w.prepared(a, T1),
    fire: (w, a, s: Prepared, o) => send(w, a, "POST", `/v1/actions/${s.action_id}/approve`, o?.body ?? JSON.stringify({ signature: w.sign(a, s) }), o),
  },
  {
    // Devir oluşturmak hiçbir şey yürütmez (validExecutions 0): yürütme yalnız sonradan, kart belirince ve tek çıkıştan olur.
    operationId: "createGrant",
    implemented: true,
    validExecutions: 0,
    setup: async () => ({}),
    fire: (w, a, _s, o) => send(w, a, "POST", "/v1/grants", o?.body ?? JSON.stringify(w.grantBody(a)), o),
  },
];

/** Eylem ucu OLMAYAN ama imzalı çağrıda dahi yürütmemesi gereken uçlar; her birinin nedeni yazılı olmak zorunda. */
export const NON_EXIT_REASON: Record<string, string> = {
  getHealth: "genel okuma",
  pairDevice: "eşleştirme; eylem yürütmez",
  getHome: "okuma", getCard: "okuma", getTask: "okuma", listPipelines: "okuma", listProjects: "okuma", getProject: "okuma", listFindings: "okuma",
  searchVault: "okuma", readVaultFile: "okuma", getChatHistory: "okuma", listGrants: "okuma", listDevices: "okuma", listEvents: "okuma", streamEvents: "okuma (SSE)",
  answerCard: "kart cevabı kb'ye yazar; `action_request` kartları /actions/* ile çözülür, GitHub'a yazmaz",
  requestTaskChanges: "görevi değişiklik istendi durumuna alır; GitHub'a yazmaz",
  postChat: "sohbet metni; kalıcı oturuma gider, GitHub'a yazmaz (T11 ayrı sınar)",
  rejectAction: "challenge'ı düşürür; yalnız azaltır",
  revokeGrant: "devri iptal eder; yalnız azaltır",
  takeoverActive: "etkin VLAD kaydı; GitHub'a yazmaz",
  putDeviceFcm: "çağıran cihazın FCM kaydı",
  revokeDevice: "cihaz iptali; yalnız azaltır (session+approval olduğundan ayrıca onay yolunda)",
};

type Envelope = {
  id: string;
  title: string;
  /** Beklenen durumlar; hata kodu alanı varsa listelenenlerden biri. */
  status: number[];
  codes?: string[];
  run(w: World, ep: ExitEndpoint, a: Phone, s: any): Promise<Res>;
};

const UNAUTH = ["unauthorized", "device_revoked"];
const WRONG = "-wrong";

/** Tüm eylem uçlarına uygulanan zarf düzeyi saldırılar: yürütme bu aşamaya gelmeden düşmeli. */
export const ENVELOPE_ATTACKS: Envelope[] = [
  { id: "unsigned", title: "imzasız istek", status: [401], codes: ["unauthorized"], run: (w, ep, a, s) => ep.fire(w, a, s, { unsigned: true }) },
  {
    id: "unpaired", title: "eşleşmemiş cihaz (kendi anahtarlarıyla doğru imzalı)", status: [401], codes: UNAUTH,
    run: (w, ep, a, s) => {
      const ghost = new Phone("ghost");
      ghost.id = "ghost-device-1";
      return ep.fire(w, a, s, { as: ghost });
    },
  },
  {
    id: "bad-envelope-signature", title: "zarf imzası başka mesaja ait (hatalı imza)", status: [401], codes: UNAUTH,
    run: (w, ep, a, s) => ep.fire(w, a, s, { sig: (k, m) => signLowS(k, m + WRONG) }),
  },
  {
    id: "envelope-signed-with-approval-key", title: "zarf approval anahtarıyla imzalı", status: [401], codes: UNAUTH,
    run: (w, ep, a, s) => ep.fire(w, a, s, { key: a.approval.priv }),
  },
  {
    id: "envelope-high-s", title: "zarf imzası yüksek-S", status: [401], codes: UNAUTH,
    run: (w, ep, a, s) => ep.fire(w, a, s, { sig: signHighS }),
  },
  {
    id: "stale-timestamp", title: "zarf zaman damgası 10 dk eski (süresi dolmuş istek)", status: [401], codes: UNAUTH,
    run: (w, ep, a, s) => ep.fire(w, a, s, { ts: w.clock.t - 10 * 60_000 }),
  },
  {
    id: "device-header-of-another", title: "X-Vlad-Device başka eşleşmiş cihazı gösteriyor", status: [401], codes: UNAUTH,
    run: async (w, ep, a, s) => {
      const b = await w.phone("B");
      return ep.fire(w, a, s, { device: b.id });
    },
  },
  {
    id: "revoked-device", title: "iptal edilmiş cihaz", status: [401], codes: UNAUTH,
    run: async (w, ep, a, s) => {
      const b = await w.phone("B");
      const rv = await w.revoke(b, a.id);
      if (rv.statusCode !== 200) throw new Error(`revoke failed ${rv.statusCode} ${rv.body}`);
      await w.settle();
      return ep.fire(w, a, s);
    },
  },
];

type ApprovalAttack = {
  id: string;
  title: string;
  status: number[];
  codes?: string[];
  /** Saldırıdan sonra yasal onay hâlâ çalışmalı mı. */
  survives: boolean;
  run(w: World, a: Phone, ch: Prepared): Promise<Res>;
};

const tampered = (b64: string, from: string, to: string) => Buffer.from(Buffer.from(b64, "base64").toString("utf8").replace(from, to), "utf8");

/** Yalnız `approveAction` için: gövde/imza/challenge/cihaz bağlama saldırıları. */
export const APPROVAL_ATTACKS: ApprovalAttack[] = [
  { id: "empty-body", title: "boş gövde", status: [400], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, "") },
  { id: "no-signature", title: "signature alanı yok", status: [400], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, {}) },
  { id: "signature-not-string", title: "signature sayı", status: [400], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, { signature: 123 }) },
  { id: "extra-device-field", title: "gövdede device_id (cihaz yalnız başlıktan bilinir)", status: [400], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, { signature: w.sign(a, ch), device_id: a.id }) },
  { id: "garbage-signature", title: "çöp imza", status: [401], codes: ["unauthorized"], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, { signature: "AAAA" }) },
  { id: "session-key-signature", title: "challenge session anahtarıyla imzalı", status: [401], codes: ["unauthorized"], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, { signature: w.sign(a, ch, "session") }) },
  {
    id: "tampered-bytes", title: "imza değiştirilmiş baytlar (pr=42→43) üzerinde", status: [401], codes: ["unauthorized"], survives: true,
    run: (w, a, ch) => w.approve(a, ch.action_id, { signature: signLowS(a.approval.priv, tampered(ch.bytes_b64, "pr=42", "pr=43")) }),
  },
  { id: "high-s", title: "approval imzası yüksek-S", status: [401], codes: ["unauthorized"], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, { signature: w.sign(a, ch, "approval", signHighS) }) },
  { id: "raw-rs", title: "approval imzası ham r||s (DER değil)", status: [401], codes: ["unauthorized"], survives: true, run: (w, a, ch) => w.approve(a, ch.action_id, { signature: w.sign(a, ch, "approval", signRawRS) }) },
  {
    id: "other-challenge-signature", title: "başka challenge'ın (başka görev) imzası", status: [401], codes: ["unauthorized"], survives: true,
    run: async (w, a, ch) => {
      const other = await w.prepared(a, T2);
      return w.approve(a, ch.action_id, { signature: w.sign(a, other) });
    },
  },
  {
    id: "signature-of-a-on-b", title: "A'nın geçerli imzası B'nin action id'sine", status: [401], codes: ["unauthorized"], survives: true,
    run: async (w, a, ch) => {
      const other = await w.prepared(a, T2);
      return w.approve(a, other.action_id, { signature: w.sign(a, ch) });
    },
  },
  {
    id: "other-devices-approval-key", title: "challenge başka cihazın approval anahtarıyla imzalı", status: [401], codes: ["unauthorized"], survives: true,
    run: async (w, a, ch) => {
      const b = await w.phone("B");
      return w.approve(a, ch.action_id, { signature: w.sign(b, ch) });
    },
  },
  {
    id: "wrong-device-valid-own-signature", title: "yanlış cihaz kendi geçerli zarf + approval imzasıyla başkasının challenge'ını onaylar", status: [404, 401, 403], survives: true,
    run: async (w, _a, ch) => {
      const b = await w.phone("B");
      return w.approve(b, ch.action_id, { signature: w.sign(b, ch) });
    },
  },
  {
    id: "wrong-device-stolen-signature", title: "yanlış cihaz doğru cihazın geçerli imzasını kendi zarfıyla gönderir", status: [404, 401, 403], survives: true,
    run: async (w, a, ch) => {
      const b = await w.phone("B");
      return w.approve(b, ch.action_id, { signature: w.sign(a, ch) });
    },
  },
  {
    id: "unknown-action", title: "var olmayan action id", status: [404], survives: true,
    run: (w, a, ch) => w.approve(a, "A-NOSUCH0000", { signature: w.sign(a, ch) }),
  },
  {
    id: "expired-challenge", title: "süresi dolmuş challenge (61 sn sonra)", status: [410], codes: ["expired"], survives: false,
    run: (w, a, ch) => {
      w.advance(61_000);
      return w.approveValid(a, ch);
    },
  },
  {
    id: "superseded-challenge", title: "aynı cihazın sonraki prepare'i eskisini geçersiz kıldı", status: [410], codes: ["expired"], survives: false,
    run: async (w, a, ch) => {
      await w.prepared(a, T1);
      await w.settle();
      return w.approveValid(a, ch);
    },
  },
];
