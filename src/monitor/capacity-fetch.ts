import { checkAgentUrl } from "./config.js";
import { DAY_MS, type DayBucket } from "./capacity-calc.js";
import type { CapacityTrigger } from "./capacity-config.js";
import { MONITOR_LIMITS, type MonitorErrorCode, type MonitorServerConfig } from "./types.js";

/**
 * `/spc/v1/since?resolution=1m` istemcisi (plan Karar 3): son 30 günü sayfalar ve YALNIZ tetikleyici seçicilerine (metrik + etiketler) uyan
 * öğeleri akış hâlinde günlük (UTC) kovalara indirger (bellek: seri × 30 gün). İstek kuralları `pull`'daki gibi: Bearer, `redirect: "error"`,
 * zaman aşımı; 401/403 unauthorized, diğer ≠200 ve ağ hatası unreachable, şekil/sürüm uyuşmazlığı schema_mismatch. 410 → baştan bir kez.
 * Sayfa tavanı aşılırsa `page_limit` (kısmi veri raporlanmaz). Hata iletilerinde ajan değeri ve belirteç yok.
 */
export class CapacityFetchError extends Error {
  constructor(readonly code: MonitorErrorCode, message: string) { super(message); this.name = "CapacityFetchError"; }
}

export const CAPACITY_LIMITS = { windowDays: 30, pageLimit: 5000, maxPages: 2000 } as const;

export interface CapacitySeries {
  /** tetikleyici kimliği → seri anahtarı → günlük kovalar (gün artan). */
  series: Record<string, Record<string, DayBucket[]>>;
  items: number;
  /** Ajanın en eski örnek zamanı (son sayfadan; epoch ms); veri başlangıcı notu için. */
  oldestTs: number | null;
}

export interface CapacityFetchOpts {
  srv: MonitorServerConfig; token: string; triggers: CapacityTrigger[]; now: number;
  fetch?: typeof fetch; timeoutMs?: number; maxPages?: number;
}

interface MinItem { ts: number; metric: string; labels: Record<string, string>; n: number; max: number; avg: number }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parsePage(body: unknown, server: string): { items: MinItem[]; next: string; more: boolean; oldest: number | null } {
  const bad = (what: string): never => { throw new CapacityFetchError("schema_mismatch", `spc şema uyumsuz: sunucu=${server}, geçersiz şekil (${what}); vendored sözleşmeyi güncelleyin`); };
  if (!isObj(body)) return bad("gövde");
  if (body.server !== server) return bad("server");
  if (body.schema !== undefined && body.schema !== 1) throw new CapacityFetchError("schema_mismatch", `spc şema uyumsuz: sunucu=${server}, beklenen=1, gelen=${typeof body.schema === "number" ? body.schema : "?"}`);
  if (body.resolution !== "1m") return bad("resolution");
  if (!Array.isArray(body.items)) return bad("items");
  if (typeof body.next_cursor !== "string" || typeof body.has_more !== "boolean") return bad("sayfalama");
  const items: MinItem[] = body.items.map((it: unknown, i) => {
    if (!isObj(it) || !isNum(it.ts) || typeof it.metric !== "string" || !isObj(it.labels) || !isNum(it.n) || !isNum(it.max) || !isNum(it.avg)) return bad(`items[${i}]`);
    const o = it as Record<string, unknown>;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) { if (typeof v !== "string") return bad(`items[${i}].labels`); labels[k] = v; }
    return { ts: o.ts as number, metric: o.metric as string, labels, n: o.n as number, max: o.max as number, avg: o.avg as number };
  });
  return { items, next: body.next_cursor, more: body.has_more, oldest: isNum(body.oldest_ts) ? body.oldest_ts : null };
}

const matches = (t: CapacityTrigger, it: MinItem): boolean =>
  it.metric === t.metric && Object.entries(t.labels ?? {}).every(([k, v]) => it.labels[k] === v);
const seriesKey = (it: MinItem): string => `${it.metric}|${Object.keys(it.labels).sort().map((k) => `${k}=${it.labels[k]}`).join(",")}`;

export async function fetchCapacitySeries(o: CapacityFetchOpts): Promise<CapacitySeries> {
  const badUrl = checkAgentUrl(o.srv.agent_url);
  if (badUrl) throw new CapacityFetchError("config", `monitor: sunucu ${o.srv.id}: agent_url ${badUrl}`);
  const doFetch = o.fetch ?? fetch;
  const base = o.srv.agent_url.replace(/\/+$/, "");
  const from = o.now - CAPACITY_LIMITS.windowDays * DAY_MS;
  const maxPages = o.maxPages ?? CAPACITY_LIMITS.maxPages;
  const acc: Record<string, Map<string, Map<number, DayBucket>>> = Object.fromEntries(o.triggers.map((t) => [t.id, new Map()]));
  let items = 0, oldest: number | null = null;

  const get = async (q: URLSearchParams): Promise<{ status: number; body: unknown }> => {
    let r: Response;
    try {
      r = await doFetch(`${base}/spc/v1/since?${q}`, {
        headers: { authorization: `Bearer ${o.token}`, accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? MONITOR_LIMITS.requestTimeoutMs),
      });
    } catch (e) {
      const n = (e as Error).name;
      throw new CapacityFetchError("unreachable", n === "TimeoutError" || n === "AbortError" ? "ajan zaman aşımı" : "ajana bağlanılamadı");
    }
    let body: unknown = null;
    try { body = await r.json(); } catch { /* gövde JSON değil: durum koduna göre */ }
    return { status: r.status, body };
  };
  const firstQuery = (): URLSearchParams => new URLSearchParams({ resolution: "1m", limit: String(CAPACITY_LIMITS.pageLimit), from: String(from) });

  const reset = (): void => { for (const m of Object.values(acc)) m.clear(); items = 0; oldest = null; };
  let q = firstQuery(), pages = 0, restarted = false;
  for (;;) {
    if (pages >= maxPages) throw new CapacityFetchError("page_limit", `sayfa tavanı aşıldı (${maxPages}); kısmi veri raporlanmadı`);
    const { status, body } = await get(q);
    pages++;
    if (status === 410) {
      if (restarted) throw new CapacityFetchError("unreachable", "ajan imleci tekrar geçersiz (HTTP 410)");
      restarted = true; reset(); q = firstQuery(); continue;
    }
    if (status === 401 || status === 403) throw new CapacityFetchError("unauthorized", `ajan kimlik doğrulamayı reddetti (HTTP ${status})`);
    if (status !== 200) throw new CapacityFetchError("unreachable", `ajan beklenmeyen yanıt verdi (HTTP ${status})`);
    const page = parsePage(body, o.srv.id);
    items += page.items.length;
    oldest = page.oldest ?? oldest;
    for (const it of page.items) {
      for (const t of o.triggers) {
        if (!matches(t, it)) continue;
        const key = seriesKey(it);
        const days = acc[t.id]!.get(key) ?? acc[t.id]!.set(key, new Map()).get(key)!;
        const day = Math.floor(it.ts / DAY_MS);
        const b = days.get(day) ?? { day, n: 0, max: -Infinity, sum: 0 };
        b.n += it.n; b.sum += it.avg * it.n; b.max = Math.max(b.max, it.max);
        days.set(day, b);
      }
    }
    if (!page.more) break;
    q = new URLSearchParams({ resolution: "1m", limit: String(CAPACITY_LIMITS.pageLimit), cursor: page.next });
  }
  const series: CapacitySeries["series"] = {};
  for (const [id, m] of Object.entries(acc)) {
    series[id] = Object.fromEntries([...m].map(([k, days]) => [k, [...days.values()].sort((a, b) => a.day - b.day)]));
  }
  return { series, items, oldestTs: oldest };
}
