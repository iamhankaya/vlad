// `vlad monitor pull` KABUL harness'i (T20261119-21). Yalnız sözleşmeden (T20261119-20 raporu, src/monitor/{types,contract,marker}.ts imzaları) ve
// tasarım raporundan (T20261119-19) yazıldı; uygulama gövdelerine bakılmadı.
// Gerçek kaynak koruması: ajan = loopback'te test içi sahte HTTP sunucusu; Keychain = sahte SecretReader; kb/VLAD_HOME ve durum dizini geçici;
// gerçek `security`, launchctl, ~/.vlad-monitor ve ağ HİÇ kullanılmaz. `http.createServer` yalnız test kodunda (üretim kodunda dinleyen soket yok).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AlertItem } from "../../src/monitor/contract.js";
import type { MonitorConfig, MonitorServerConfig, PullDeps, SecretReader } from "../../src/monitor/types.js";
import { monitorStatePath } from "../../src/monitor/state.js";
import { listTasks } from "../../src/tasks/store.js";
import type { Task } from "../../src/tasks/store.js";
import { makeFixtureRoot, makeHome } from "../helpers.js";

export const TOKEN = "SECRET-TOKEN-xyz-9f3a1c";
export const FIXTURES = join(import.meta.dirname, "..", "fixtures", "spc");
export const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

/** Geçerli bir AlertItem; zaman alanları "şimdi"ye göreli (sabit takvim tarihi yok). */
let seqCounter = 0;
export function alertItem(over: Partial<AlertItem> & { rule_id?: string } = {}): AlertItem {
  const rule = over.rule_id ?? "medialog-app-down";
  const firedAt = over.fired_at ?? Date.now() - 600_000;
  const hex = (++seqCounter).toString(16).padStart(12, "0");
  return {
    seq: 0,
    alert_id: `${rule}.${hex}.${firedAt}`,
    rule_id: rule,
    title: `${rule} title`,
    severity: "critical",
    labels: {},
    state: "firing",
    fired_at: firedAt,
    resolved_at: null,
    resolve_reason: null,
    value: 97.5,
    op: ">",
    threshold: 90,
    for_ms: 300_000,
    suppressed: false,
    notified: { firing: true, resolved: false },
    vlad: "task",
    ref: `servers/medialog/rules.yml#${rule}`,
    ...over,
  };
}

export interface AgentRequest { path: string; query: URLSearchParams; auth: string | undefined }

/** spc FakeAgentServer'ın davranış alt kümesi: seq'li alarm deposu, opak imleç, epoch, 401/410. İmleç = base64url({e,k:"alerts",s}). */
export class FakeAgent {
  // Yanıttaki `server` alanı; yapılandırmadaki sunucu id'siyle eşleşmeli (T20261119-51).
  serverId = "medialog";
  readonly requests: AgentRequest[] = [];
  epoch = "epoch-aaaaaaaa";
  /** Sunucunun tanıdığı belirteç. */
  token = TOKEN;
  /** true: imleci yok sayıp her seferinde tüm alarmları döner (aynı alarm tekrar gelir). */
  replayAll = false;
  /** Doluysa sıradaki yanıt bunu ezer (tek seferlik). */
  forced: Array<{ status: number; body: unknown }> = [];
  /** Tüm yanıt gövdelerini dönüştürmek için (şema bozma). */
  mutate: ((body: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Dolu ise her istek bu sabit yanıtla karşılanır (fixture tekrarı); imleç/durum yok sayılır. */
  respond: ((q: URLSearchParams) => { status: number; body: unknown }) | null = null;
  private store = new Map<string, AlertItem>();
  private seq = 0;
  private server!: http.Server;
  url = "";

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  /** Ekle/güncelle: her yazma yeni seq alır (firing ve resolved geçişleri akışta ayrı görünür). */
  upsert(a: AlertItem): AlertItem {
    const item = { ...a, seq: ++this.seq };
    this.store.set(item.alert_id, item);
    return item;
  }
  resolve(alertId: string, reason: AlertItem["resolve_reason"] = "condition_cleared"): AlertItem {
    const cur = this.store.get(alertId);
    if (!cur) throw new Error(`bilinmeyen alarm: ${alertId}`);
    return this.upsert({ ...cur, state: "resolved", resolved_at: Date.now() - 60_000, resolve_reason: reason, notified: { firing: true, resolved: true } });
  }
  resetEpoch(): void { this.epoch = `epoch-${Math.random().toString(36).slice(2, 10)}`; }
  cursorFor(seq: number): string { return Buffer.from(JSON.stringify({ e: this.epoch, k: "alerts", s: seq })).toString("base64url"); }
  private decode(c: string): number | null {
    try {
      const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { e?: string; k?: string; s?: number };
      return o.e === this.epoch && o.k === "alerts" && typeof o.s === "number" ? o.s : null;
    } catch { return null; }
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const u = new URL(req.url ?? "/", "http://x");
    this.requests.push({ path: u.pathname, query: u.searchParams, auth: req.headers.authorization });
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const forced = this.forced.shift();
    if (forced) return send(forced.status, forced.body);
    // 401: gövde, istemcinin gönderdiği değeri iletiye geri yazar (sızıntı testi: istemci bunu maskelemeli)
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      return send(401, { error: { code: "unauthorized", message: `bad token ${req.headers.authorization ?? ""}`, details: {} } });
    }
    if (u.pathname !== "/spc/v1/alerts") return send(404, { error: { code: "not_found", message: "yol yok", details: {} } });
    if (this.respond) { const r = this.respond(u.searchParams); return send(r.status, r.body); }
    const cursor = u.searchParams.get("cursor");
    let after = 0;
    if (cursor !== null && !this.replayAll) {
      const s = this.decode(cursor);
      if (s === null) return send(410, { error: { code: "cursor_invalid", message: "imleç geçersiz", details: { epoch: this.epoch } } });
      after = s;
    }
    const want = u.searchParams.get("state");
    const limit = Math.min(Number(u.searchParams.get("limit") ?? 500) || 500, 500);
    const all = [...this.store.values()].filter((a) => a.seq > after && (want === null || want === "all" || a.state === want)).sort((x, y) => x.seq - y.seq);
    const items = all.slice(0, limit);
    const hasMore = all.length > items.length;
    const last = items.length ? items[items.length - 1]!.seq : Math.max(after, hasMore ? after : this.seq);
    let body: Record<string, unknown> = { server: this.serverId, epoch: this.epoch, items, next_cursor: this.cursorFor(hasMore ? last : Math.max(last, this.seq)), has_more: hasMore };
    if (this.mutate) body = this.mutate(body);
    send(200, body);
  }
}

/** Dinleyen kimse olmayan bir loopback adresi (bağlantı reddedilir). */
export async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

export interface FakeSecrets extends SecretReader { calls: string[]; store: Map<string, string> }
export function fakeSecrets(map: Record<string, string> = {}): FakeSecrets {
  const store = new Map(Object.entries(map));
  const calls: string[] = [];
  return { calls, store, async read(service: string) { calls.push(service); return store.get(service) ?? null; } };
}

export interface World {
  home: string;
  stateDir: string;
  logs: string[];
  clock: { t: number };
  secrets: FakeSecrets;
  deps: (servers: MonitorServerConfig[], over?: Partial<PullDeps>) => PullDeps;
  statePath: string;
  readState: () => { v: number; servers: Record<string, { epoch: string | null; cursor: string | null; last_ok: number | null; fail_streak: number; tasks: Record<string, { task: string; firing_noted: boolean; resolved_noted: boolean }> }> };
}

/** Geçici VLAD_HOME + kb (proje kartlarıyla) + geçici durum dizini. */
export function makeWorld(projects: string[] = ["vlad"], secretIds: string[] = ["medialog"]): World {
  const home = makeHome();
  cpSync(join(import.meta.dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true }); // createTask role: analyst için roller gerekir
  for (const p of projects) writeFileSync(join(home, "kb", "projects", `${p}.md`), `---\nslug: ${p}\n---\n`);
  const stateDir = join(makeFixtureRoot(), "vlad-monitor");
  const secrets = fakeSecrets(Object.fromEntries(secretIds.map((id) => [`spc_token_${id.replace(/-/g, "_")}`, TOKEN])));
  const logs: string[] = [];
  const clock = { t: Date.now() };
  const statePath = monitorStatePath(stateDir);
  return {
    home, stateDir, logs, clock, secrets, statePath,
    deps: (servers, over = {}) => ({
      home, config: { servers } satisfies MonitorConfig, secrets, stateDir, platform: "darwin", now: () => clock.t, log: (l) => logs.push(l), ...over,
    }),
    readState: () => JSON.parse(readFileSync(statePath, "utf8")),
  };
}

export const server = (id: string, agent_url: string, project = "vlad"): MonitorServerConfig => ({ id, agent_url, project });

export const tasksFor = (project: string): Task[] => listTasks({ project });
/** Görev gövdesindeki `## İlerleme` bölümü. */
export function progressOf(t: Task): string {
  const m = /## İlerleme\n([\s\S]*?)(?=\n## |$)/.exec(t.body);
  return m?.[1] ?? "";
}
/** Görevin güncel (diskten okunmuş) hali. */
export const fresh = (id: string): Task => listTasks().find((t) => t.data.id === id)!;

/** Bir dizin ağacındaki tüm dosyaların metni (sızıntı taraması için). Yalnız verilen kökün altına iner. */
export function allText(root: string): string {
  if (!existsSync(root)) return "";
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 5_000_000) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return out.join("\n");
}
export const ensureDir = (p: string): void => { mkdirSync(p, { recursive: true }); };

/** `fn` gerçekten (uygulanmış koddan) fırlatmalı: gövdesiz iskeletin "not implemented" hatası geçerli bir fırlatma sayılmaz (yanlış-yeşil önlemi). */
export function throwsReal(fn: () => unknown, re?: RegExp): void {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  if (err === undefined) throw new Error("fırlatması bekleniyordu");
  const msg = err instanceof Error ? err.message : String(err);
  if (/not implemented/.test(msg)) throw new Error(`iskelet hatası, gerçek doğrulama hatası değil: ${msg}`);
  if (re && !re.test(msg)) throw new Error(`ileti ${re} ile eşleşmiyor: ${msg}`);
}
