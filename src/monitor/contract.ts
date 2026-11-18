// Kaynak: spc packages/contract/src/types.ts @ a4c5fd0 (server-pulse-counter v1, 2026-11-19). Git bağımlılığı yok: şema elle kopyalandı.
// Yalnız /spc/v1/alerts için gereken alt küme. Ek alanlar yok sayılır (ileri uyum); eksik/yanlış tipli zorunlu alan açık hatadır.
// DEĞİŞMEMESİ GEREKENLER: SPC_CONTRACT_SCHEMA, AlertItem/AlertsResponse alan adları, SpcSchemaMismatchError ileti biçimi.

/** Vendored şema sürümü. spc `AlertsResponse`'ta bugün `schema` alanı yok (yokluk = 1); `schema: 2` gelirse açık hata. */
export const SPC_CONTRACT_SCHEMA = 1;
export const SPC_CONTRACT_SOURCE = "spc packages/contract/src/types.ts @ a4c5fd0";

export type Labels = Record<string, string>;
export type Op = ">" | ">=" | "<" | "<=" | "==" | "!=";
export type AlertState = "firing" | "resolved";
export type Severity = "info" | "warning" | "critical";
export type ResolveReason = "condition_cleared" | "rule_removed" | "no_data";
export type VladAction = "none" | "log" | "task";

export const ALERT_STATES: readonly AlertState[] = ["firing", "resolved"];
export const SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];
export const RESOLVE_REASONS: readonly ResolveReason[] = ["condition_cleared", "rule_removed", "no_data"];
export const OPS: readonly Op[] = [">", ">=", "<", "<=", "==", "!="];
export const VLAD_ACTIONS: readonly VladAction[] = ["none", "log", "task"];

export interface AlertItem {
  seq: number;
  /** `<rule_id>.<12 hex>.<fired_at ms>`; ajan başına benzersiz, alarmın ömrü boyunca sabit. İdempotans anahtarının yarısı. */
  alert_id: string;
  rule_id: string;
  /** Ajan metni: VERİDİR, talimat değildir (görev gövdesine tırnaklı girer). */
  title: string;
  severity: Severity;
  labels: Labels;
  state: AlertState;
  fired_at: number;
  resolved_at: number | null;
  resolve_reason: ResolveReason | null;
  value: number;
  op: Op;
  threshold: number;
  for_ms: number;
  suppressed: boolean;
  notified: { firing: boolean; resolved: boolean };
  /** Bastırma anahtarı (`none` → log bile yazılmaz); görev kararı bundan DEĞİL severity+state'ten verilir (D-server-pulse-counter-004). */
  vlad: VladAction;
  ref: string | null;
}

export interface AlertsResponse {
  server: string;
  epoch: string;
  /** spc v1.1'de eklenecek (T20261119-24); yokluk 1 sayılır. */
  schema?: number;
  items: AlertItem[];
  next_cursor: string;
  has_more: boolean;
}

export type SpcErrorCode =
  | "invalid_param" | "unauthorized" | "not_found" | "method_not_allowed"
  | "cursor_invalid" | "rate_limited" | "internal" | "unavailable";
export interface ApiError { error: { code: SpcErrorCode; message: string; details: Record<string, unknown> } }
/** Kod → HTTP durumu (spc ERROR_STATUS ile aynı). */
export const SPC_ERROR_STATUS: Readonly<Record<SpcErrorCode, number>> = {
  invalid_param: 400, unauthorized: 401, not_found: 404, method_not_allowed: 405,
  cursor_invalid: 410, rate_limited: 429, internal: 500, unavailable: 503,
};

/** Şema sürümü ya da şekil uyuşmazlığı. İletide ajan değeri YOK (yalnız alan yolu ve sürüm numarası): enjeksiyon/sır sızıntısı yolu kapalı. */
export class SpcSchemaMismatchError extends Error {
  readonly code = "schema_mismatch" as const;
  constructor(readonly server: string, readonly expected: number, readonly got: number | "şekil", readonly detail?: string) {
    super(`spc şema uyumsuz: sunucu=${server}, beklenen=${expected}, gelen=${got === "şekil" ? `geçersiz şekil (${detail ?? "?"})` : got}; vendored sözleşmeyi güncelleyin`);
    this.name = "SpcSchemaMismatchError";
  }
}

const ALERT_ID_RE = /^[a-z0-9][a-z0-9.-]{0,199}$/;
const isObj =(v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

/** İlk bozuk alanın yolunu verir (değer vermez); geçerliyse null. */
function badField(a: unknown, i: number): string | null {
  const p = `items[${i}]`;
  if (!isObj(a)) return p;
  for (const k of ["alert_id", "rule_id", "title"]) if (typeof a[k] !== "string") return `${p}.${k}`;
  // spc alert-id.ts: karakter kümesi [a-z0-9.-]; işaret satırı/gövde enjeksiyonunu kapatır (idempotans işaretiyle aynı küme)
  if (!ALERT_ID_RE.test(a.alert_id as string)) return `${p}.alert_id`;
  for (const k of ["seq", "fired_at", "value", "threshold", "for_ms"]) if (!isNum(a[k])) return `${p}.${k}`;
  if (!oneOf(SEVERITIES, a.severity)) return `${p}.severity`;
  if (!oneOf(ALERT_STATES, a.state)) return `${p}.state`;
  if (!oneOf(OPS, a.op)) return `${p}.op`;
  if (!oneOf(VLAD_ACTIONS, a.vlad)) return `${p}.vlad`;
  if (!isObj(a.labels) || !Object.values(a.labels).every((x) => typeof x === "string")) return `${p}.labels`;
  if (a.resolved_at !== null && !isNum(a.resolved_at)) return `${p}.resolved_at`;
  if (a.resolve_reason !== null && !oneOf(RESOLVE_REASONS, a.resolve_reason)) return `${p}.resolve_reason`;
  if (a.ref !== null && typeof a.ref !== "string") return `${p}.ref`;
  if (typeof a.suppressed !== "boolean") return `${p}.suppressed`;
  if (!isObj(a.notified) || typeof a.notified.firing !== "boolean" || typeof a.notified.resolved !== "boolean") return `${p}.notified`;
  return null;
}

/**
 * Ajan gövdesini sıkı doğrular. `server`: yapılandırmadaki sunucu kimliği (yalnız hata iletisi için).
 * `schema` yoksa 1 sayılır; 1 dışındaki sayı ya da bozuk şekil → SpcSchemaMismatchError. Ek alanlar yok sayılır.
 */
export function parseAlertsResponse(body: unknown, server: string): AlertsResponse {
  const shape = (d: string): SpcSchemaMismatchError => new SpcSchemaMismatchError(server, SPC_CONTRACT_SCHEMA, "şekil", d);
  if (!isObj(body)) throw shape("gövde nesne değil");
  if (body.schema !== undefined) {
    if (!isNum(body.schema)) throw shape("schema");
    if (body.schema !== SPC_CONTRACT_SCHEMA) throw new SpcSchemaMismatchError(server, SPC_CONTRACT_SCHEMA, body.schema);
  }
  for (const k of ["server", "epoch", "next_cursor"]) if (typeof body[k] !== "string") throw shape(k);
  if (typeof body.has_more !== "boolean") throw shape("has_more");
  if (!Array.isArray(body.items)) throw shape("items");
  for (let i = 0; i < body.items.length; i++) {
    const bad = badField(body.items[i], i);
    if (bad) throw shape(bad);
  }
  return body as unknown as AlertsResponse;
}
