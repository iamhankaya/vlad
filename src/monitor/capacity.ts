import { createTask, getTask, listTasks, logTask, type Task } from "../tasks/index.js";
import { calcTrigger, DAY_MS, isoWeekKey, type TriggerReport } from "./capacity-calc.js";
import { CapacityConfigError, loadCapacityConfig, type CapacityConfig, type CapacityTrigger } from "./capacity-config.js";
import { CapacityFetchError, fetchCapacitySeries } from "./capacity-fetch.js";
import { emptyCapacityServer, loadCapacityState, saveCapacityState, type CapacityServerState } from "./capacity-state.js";
import { parseCapacityMarker, parseCapacityReportMarker, capacityMarker, capacityReportMarker } from "./marker.js";
import type { Notifier } from "./notify.js";
import { KeychainError, keychainService } from "./secret.js";
import { monitorStateDir } from "./state.js";
import { EXIT_BY_CODE, type MonitorError, type MonitorErrorCode, type MonitorServerConfig, type SecretReader } from "./types.js";

/**
 * `vlad monitor capacity` çekirdeği (plan Karar 2–3). Sunucu başına: 30 günlük 1 dk özetini çek → eşik eğilimini hesapla → ISO hafta zaten
 * işlendiyse atla → kalıcı rapor görevinin günlüğüne tablo → `warn`/`over` tetikleyici için `architect` research görevi (tetikleyici başına en çok bir
 * açık; işaret `spc-capacity: <server>/<trigger>`, arşiv dahil taranır) → kb yazmalarından SONRA durum dosyası. Kb'ye commit YOK (D-vlad-085; VLAD sonra
 * `vlad kb commit --push`). Hata/ulaşılamaz sunucu atlanır, diğerleri sürer. `dryRun` hiçbir şey yazmaz (kb, durum, bildirim).
 */
export interface CapacityServerConfig extends MonitorServerConfig { capacity_file?: string }
export interface CapacityDeps {
  home: string;
  config: { servers: CapacityServerConfig[] };
  secrets: SecretReader;
  fetch?: typeof fetch;
  now?: () => number;
  stateDir?: string;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  maxPages?: number;
  schemaDir?: string;
  log?: (line: string) => void;
  notifier?: Notifier;
}
export interface CapacityOptions { server?: string; dryRun?: boolean; force?: boolean }
export interface CapacityServerResult {
  id: string; ok: boolean; week: string;
  skipped: "already_done" | "no_capacity_file" | null;
  reportTask: string | null;
  opened: { trigger: string; task: string }[];
  triggers: TriggerReport[];
  notes: string[];
}
export interface CapacityResult { servers: CapacityServerResult[]; errors: MonitorError[] }

const CLOSED = new Set(["done", "cancelled"]);
const DRY = "(dry-run)";
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const isOpen = (id: string): boolean => { try { return !CLOSED.has(getTask(id).data.state); } catch { return false; } };

/** Başlığı `[spc] ` ile başlayan görevlerde, gövdede tam satır eşleşen işaretin sahipleri (arşiv dahil; başka görevlerin alıntısı eşleşmesin). */
function tasksWithMarker(match: (line: string) => boolean): Task[] {
  return listTasks().filter((t) => t.data.title.startsWith("[spc] ") && t.body.split("\n").some((l) => match(l.trim())));
}

export function remainingText(r: TriggerReport["remaining"]): string {
  switch (r.kind) {
    case "weeks": return `${num(Math.max(0, r.weeks))} hafta`;
    case "flat": return "artmıyor";
    case "exceeded": return "aşıldı";
    case "insufficient": return "yetersiz veri";
  }
}

function row(t: CapacityTrigger, r: TriggerReport): string {
  const v = (x: number | null): string => (x === null ? "-" : `${num(x)} ${t.unit}`.trim());
  const slope = r.slopePerWeek === null ? "-" : `${r.slopePerWeek >= 0 ? "+" : ""}${num(r.slopePerWeek)} ${t.unit}/hafta`.trim();
  return `| ${t.id} | ${v(r.value7d)} | ${v(r.value30d)} | ${t.op} ${num(t.threshold)} ${t.unit} | ${r.pct === null ? "-" : `%${num(r.pct)}`} | ${slope} | ${remainingText(r.remaining)} | ${r.status} |`;
}
const TABLE_HEAD = ["| tetikleyici | 7g zirve | 30g zirve | eşik | % | haftalık artış | kalan süre | durum |", "|---|---|---|---|---|---|---|---|"];

function reportText(week: string, cfg: CapacityConfig, reports: TriggerReport[], oldestTs: number | null, now: number, notes: string[]): string {
  const start = oldestTs === null ? "bilinmiyor" : new Date(oldestTs).toISOString().slice(0, 10);
  const short = oldestTs !== null && oldestTs > now - 30 * DAY_MS ? " (30 günden az veri)" : "";
  return [
    `kapasite raporu ${week} (kaynak ${cfg.source}); veri başlangıcı: ${start}${short}`,
    ...notes.map((n) => `Not: ${n}`),
    ...TABLE_HEAD,
    ...cfg.triggers.map((t) => row(t, reports.find((r) => r.id === t.id)!)),
  ].join("\n");
}

function architectTask(server: string, cfg: CapacityConfig, t: CapacityTrigger, r: TriggerReport, week: string): { title: string; body: string } {
  const title = `[spc] kapasite: ${server}/${t.id} — ${clean(t.title)}`.slice(0, 120);
  const body = [
    "## Tanım",
    `spc kapasite tetikleyicisi eşiğin %${num(cfg.warn_pct)} düzeyini geçti (${r.status}). Sunucu: ${server}. Tetikleyici: ${t.id} — ${clean(t.title)}. Kaynak: ${cfg.source} (${clean(t.source_item)}).`,
    `Ölçü: ${t.measure === "peak" ? "7 günlük zirve" : "günlük ortalamanın 7 günlük zirvesi"}; eşik ${t.op} ${num(t.threshold)} ${t.unit}. Hafta: ${week}.`,
    "",
    ...TABLE_HEAD,
    row(t, r),
    "",
    "Amaç: bu kapasite sinyaline karşı seçenekleri değerlendirmek. **Seçenekler açık uçludur:** kullanıcının verdiği örnekler (sunucu artırma, yük dengeleyici, okuma/yazma DB ayrımı) yalnız örnektir; başka seçenekler (önbellek, bağlantı havuzu/sorgu iyileştirme, ölçek sınırını yeniden değerlendirme, hiçbir şey yapmama) de değerlendirilir.",
    "Çıktı: seçenek başına maliyet / risk / geri dönüş ve bir öneri. Karar kullanıcıdadır; kod yazılmaz. Sonraki haftaların verisi bu görevin `## İlerleme`'sine eklenir.",
    "",
    capacityMarker(server, t.id),
    "",
    "## Kabul kriterleri",
    "- [ ] seçenekler (örnekler dahil, onlarla sınırlı değil) maliyet/risk/geri dönüş ile karşılaştırıldı",
    "- [ ] öneri ve gerekçe; karar kullanıcıya bırakıldı",
    "- [ ] kapanış raporu",
    "",
  ].join("\n");
  return { title, body };
}

function reportTaskBody(server: string, cfg: CapacityConfig): string {
  return [
    "## Tanım",
    `spc haftalık kapasite raporu (sunucu: ${server}; kaynak ${cfg.source}). Her pazartesi \`vlad monitor capacity\` bu görevin \`## İlerleme\` bölümüne bir tablo ekler; bir tetikleyici eşiğin %${num(cfg.warn_pct)} düzeyini geçince ayrı bir architect görevi açılır.`,
    "Kalıcı kayıt görevidir: kapatılırsa sonraki koşuda yenisi açılır.",
    "",
    capacityReportMarker(server),
    "",
    "## Kabul kriterleri",
    "- [ ] tablolar izlenir; eğilim kötüleşirse architect görevi açılır",
    "",
  ].join("\n");
}

class ServerFail extends Error { constructor(readonly code: MonitorErrorCode, message: string) { super(message); } }

export async function runCapacity(deps: CapacityDeps, opts: CapacityOptions = {}): Promise<CapacityResult> {
  const result: CapacityResult = { servers: [], errors: [] };
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    result.errors.push({ server: null, code: "unsupported_platform", message: "vlad monitor capacity yalnız macOS'ta çalışır (Keychain)" });
    return result;
  }
  let servers = deps.config.servers;
  if (opts.server !== undefined) {
    servers = servers.filter((s) => s.id === opts.server);
    if (servers.length === 0) {
      result.errors.push({ server: opts.server, code: "config", message: `bilinmeyen sunucu: ${opts.server}` });
      return result;
    }
  }
  const dir = deps.stateDir ?? monitorStateDir();
  let state;
  try { state = loadCapacityState(dir); } catch (e) {
    result.errors.push({ server: null, code: "config", message: (e as Error).message });
    return result;
  }
  const now = (deps.now ?? Date.now)();
  const dry = opts.dryRun === true;
  const week = isoWeekKey(now);
  const log = deps.log ?? (() => {});

  for (const srv of servers) {
    const res: CapacityServerResult = { id: srv.id, ok: false, week, skipped: null, reportTask: null, opened: [], triggers: [], notes: [] };
    result.servers.push(res);
    if (!srv.capacity_file) {
      res.skipped = "no_capacity_file"; res.ok = true;
      const msg = `sunucu ${srv.id}: capacity_file tanımlı değil, kapasite işinden atlandı (vlad.config.json → monitor.servers[].capacity_file)`;
      if (opts.server !== undefined) { res.ok = false; result.errors.push({ server: srv.id, code: "config", message: msg }); } else log(msg);
      continue;
    }
    const prev = state.servers[srv.id] ?? emptyCapacityServer();
    if (!opts.force && prev.last_week === week) { res.skipped = "already_done"; res.ok = true; continue; }
    let token: string | null = null;
    try {
      let cfg: CapacityConfig;
      try { cfg = loadCapacityConfig(srv.capacity_file, { schemaDir: deps.schemaDir }); } catch (e) {
        if (e instanceof CapacityConfigError) throw new ServerFail("config", e.message);
        throw e;
      }
      if (cfg.server !== srv.id) throw new ServerFail("config", `capacity.yaml sunucusu (${cfg.server}) yapılandırmadaki sunucuyla (${srv.id}) uyuşmuyor`);
      try { token = await deps.secrets.read(keychainService(srv.id)); } catch (e) { throw new ServerFail("keychain", e instanceof KeychainError ? e.message : `Keychain okunamadı: ${(e as Error).name}`); }
      if (token === null) throw new ServerFail("keychain", `Keychain kaydı yok: ${keychainService(srv.id)} (spc_token_<ad>; security add-generic-password ile ekleyin)`);
      let fetched;
      try {
        fetched = await fetchCapacitySeries({ srv, token, triggers: cfg.triggers, now, fetch: deps.fetch, timeoutMs: deps.requestTimeoutMs, maxPages: deps.maxPages });
      } catch (e) {
        if (e instanceof CapacityFetchError) throw new ServerFail(e.code, e.message);
        throw e;
      }
      const next = structuredClone(prev);
      await apply(srv, cfg, fetched.series, fetched.oldestTs, next, res);
      if (!dry) { state.servers[srv.id] = next; saveCapacityState(dir, state); }
      res.ok = true;
    } catch (e) {
      const code: MonitorErrorCode = e instanceof ServerFail ? e.code : "config"; // kb/disk yazma hataları sunucu erişilemezliği değildir
      let message = e instanceof Error ? e.message : String(e);
      if (token) message = message.split(token).join("[belirteç]");
      if (code === "unauthorized") message += " — Keychain kaydını kontrol edin";
      result.errors.push({ server: srv.id, code, message } satisfies MonitorError);
    }
  }
  return result;

  async function apply(srv: CapacityServerConfig, cfg: CapacityConfig, series: Record<string, Record<string, import("./capacity-calc.js").DayBucket[]>>,
    oldestTs: number | null, st: CapacityServerState, res: CapacityServerResult): Promise<void> {
    const reports = cfg.triggers.map((t) => calcTrigger(t, series[t.id] ?? {}, { now, warnPct: cfg.warn_pct }));
    res.triggers = reports;
    const sameWeekRerun = st.last_week === week; // --force: ardışık-hafta sayacı değişmez
    const prevWeekOk = st.last_week === isoWeekKey(now - 7 * DAY_MS);
    if (st.last_week !== null && !sameWeekRerun && !prevWeekOk) res.notes.push(`hafta atlandı (önceki rapor ${st.last_week}); ardışık hafta sayaçları sıfırlandı`);
    const notices: { task: string; trigger: string }[] = [];

    // 1) rapor görevi
    let reportId = st.report_task && isOpen(st.report_task) ? st.report_task : null;
    reportId ??= tasksWithMarker((l) => parseCapacityReportMarker(l)?.server === srv.id).find((t) => !CLOSED.has(t.data.state))?.data.id ?? null;
    if (!reportId) {
      reportId = dry ? DRY : createTask({ project: srv.project, title: `[spc] kapasite raporu: ${srv.id}`, kind: "research", role: "analyst", body: reportTaskBody(srv.id, cfg) }).data.id;
    }
    res.reportTask = reportId;
    st.report_task = reportId === DRY ? st.report_task : reportId;
    const text = reportText(week, cfg, reports, oldestTs, now, res.notes);
    if (!dry) logTask(reportId, text);

    // 2) tetikleyici başına: ardışık over sayacı, architect görevi
    for (const t of cfg.triggers) {
      const r = reports.find((x) => x.id === t.id)!;
      const ts = st.triggers[t.id] ?? (st.triggers[t.id] = { architect_task: null, over_weeks: [] });
      if (!sameWeekRerun) ts.over_weeks = r.status === "over" ? [...(prevWeekOk ? ts.over_weeks : []), week].slice(-cfg.consecutive_weeks) : [];
      const marked = tasksWithMarker((l) => { const m = parseCapacityMarker(l); return m?.server === srv.id && m.trigger === t.id; });
      let open = ts.architect_task && isOpen(ts.architect_task) ? ts.architect_task : (marked.find((x) => !CLOSED.has(x.data.state))?.data.id ?? null);
      let created = false;
      if (!open && (r.status === "over" || (r.status === "warn" && marked.length === 0))) {
        // warn: bir kez (daha önce hiç açılmadıysa); kapatıldıktan sonra yalnız over yeniden açar (Açık sorular 2)
        const txt = architectTask(srv.id, cfg, t, r, week);
        open = dry ? DRY : createTask({ project: srv.project, title: txt.title, kind: "research", role: "architect", body: txt.body }).data.id;
        created = true;
        res.opened.push({ trigger: t.id, task: open });
        notices.push({ task: open, trigger: t.id });
      }
      ts.architect_task = open === DRY ? ts.architect_task : open;
      if (open && !created && !dry) logTask(open, `kapasite ${week}: ${TABLE_HEAD[0]}\n${TABLE_HEAD[1]}\n${row(t, r)}`);
      if (r.status === "over" && ts.over_weeks.length >= cfg.consecutive_weeks) {
        const target = open ?? reportId;
        const msg = `TETİKLEYİCİ: ${t.id} ${cfg.consecutive_weeks} ardışık hafta eşiği aştı (${ts.over_weeks.join(", ")})`;
        res.notes.push(msg);
        if (!dry && target !== DRY) logTask(target, msg);
        if (target !== DRY && !notices.some((n) => n.task === target && n.trigger === t.id)) notices.push({ task: target, trigger: t.id });
      }
    }
    st.last_week = week;

    // 3) bildirim (en iyi çaba; kb yazmalarından sonra, dry-run'da yok)
    if (!dry && deps.notifier) {
      for (const n of notices) {
        try { await deps.notifier.notice({ ts: now, kind: "capacity", server: srv.id, task: n.task, trigger: n.trigger }); } catch (e) { log(`spc ${srv.id}: bildirim gönderilemedi: ${(e as Error).name}`); }
      }
    }
  }
}

/** Çıkış kodu: errors'taki en kötü EXIT_BY_CODE (`pull` ile aynı). */
export function capacityExitCode(r: Pick<CapacityResult, "errors">): 0 | 1 | 2 {
  let worst: 0 | 1 | 2 = 0;
  for (const e of r.errors) worst = Math.max(worst, EXIT_BY_CODE[e.code]) as 0 | 1 | 2;
  return worst;
}
