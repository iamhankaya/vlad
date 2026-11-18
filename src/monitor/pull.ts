import { createTask, getTask, listTasks, logTask } from "../tasks/index.js";
import { parseAlertsResponse, SpcSchemaMismatchError, type AlertItem, type AlertsResponse } from "./contract.js";
import { parseAlertMarker, MARKER_PREFIX } from "./marker.js";
import { keychainService } from "./secret.js";
import { createStateStore, monitorStateDir } from "./state.js";
import { buildAlertTask, buildResolvedNote } from "./task-text.js";
import {
  EXIT_BY_CODE, MONITOR_LIMITS,
  type MonitorError, type MonitorErrorCode, type MonitorState, type MonitorStatus, type MonitorServerConfig,
  type PullDeps, type PullOptions, type PullResult, type ServerPullResult, type ServerState,
} from "./types.js";

/** Bu hata sınıfları "sunucu erişilemiyor/bozuk" sayılır: ardışık hata sayacı (`fail_streak`) artar. */
const STREAK_CODES: readonly MonitorErrorCode[] = ["unreachable", "unauthorized", "schema_mismatch"];

class ServerError extends Error {
  constructor(readonly code: MonitorErrorCode, message: string) { super(message); }
}

const emptyServer = (): ServerState => ({ epoch: null, cursor: null, last_ok: null, fail_streak: 0, tasks: {} });
const CLOSED = new Set(["done", "cancelled"]);

/** Görev gövdesindeki işaret satırlarından `server/alert_id → görev` haritası (arşiv dahil; yalnız kendi sunucumuz). */
function markerIndex(server: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of listTasks()) {
    if (!t.body.includes(MARKER_PREFIX)) continue;
    for (const line of t.body.split("\n")) {
      const p = parseAlertMarker(line.trim());
      if (p && p.server === server && !m.has(p.alertId)) m.set(p.alertId, t.data.id);
    }
  }
  return m;
}

/**
 * `vlad monitor pull` çekirdeği. Kural (D-server-pulse-counter-004): `severity === "critical" && state === "firing"` (suppressed dahil) → bir
 * `research`/`analyst` görevi (queued, başlatılmaz); diğerleri log; `vlad` alanı yalnız bastırma (`none` → log yok). `resolved` → açık görevin
 * `## İlerleme`'sine tek not (görev kapanmaz; kapalı/yok → yazma yok). İdempotans: durum dosyası + gövde işareti (arşiv dahil).
 * Şema/yetki/erişim hatası o sunucuyu atlar (imleç ilerlemez), diğerleri sürer.
 */
export async function pullAlerts(deps: PullDeps, opts: PullOptions = {}): Promise<PullResult> {
  const result: PullResult = { servers: [], errors: [] };
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    result.errors.push({ server: null, code: "unsupported_platform", message: "vlad monitor pull yalnız macOS'ta çalışır (Keychain)" });
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
  const store = createStateStore(deps.stateDir ?? monitorStateDir());
  let state: MonitorState;
  try { state = store.load(); } catch (e) {
    result.errors.push({ server: null, code: "config", message: (e as Error).message });
    return result;
  }
  const dry = opts.dryRun === true;
  for (const srv of servers) {
    const st = state.servers[srv.id] ?? (state.servers[srv.id] = emptyServer());
    const work = dry ? structuredClone(st) : st; // dry-run: durum bellekte oynar, diske yazılmaz
    const res: ServerPullResult = { id: srv.id, ok: false, fetched: 0, opened: [], noted: [], logged: [], skipped: 0 };
    result.servers.push(res);
    let token: string | null = null;
    try {
      try { token = await deps.secrets.read(keychainService(srv.id)); } catch (e) { throw new ServerError("keychain", `Keychain okunamadı: ${(e as Error).name}`); }
      if (token === null) throw new ServerError("keychain", `Keychain kaydı yok: ${keychainService(srv.id)} (spc_token_<ad>; security add-generic-password ile ekleyin)`);
      await pullServer(srv, work, token, deps, dry, res, () => { if (!dry) store.save(state); });
      res.ok = true;
      work.fail_streak = 0;
      work.last_ok = (deps.now ?? Date.now)();
    } catch (e) {
      const code: MonitorErrorCode = e instanceof ServerError ? e.code : e instanceof SpcSchemaMismatchError ? "schema_mismatch" : "unreachable";
      let message = e instanceof Error ? e.message : String(e);
      if (token) message = message.split(token).join("[belirteç]");
      if (code === "unauthorized") message += " — Keychain kaydını kontrol edin";
      result.errors.push({ server: srv.id, code, message } satisfies MonitorError);
      if (STREAK_CODES.includes(code)) work.fail_streak += 1;
    }
    if (!dry) store.save(state);
  }
  return result;
}

async function fetchPage(srv: MonitorServerConfig, token: string, cursor: string | null, deps: PullDeps): Promise<{ status: number; body: unknown }> {
  const q = new URLSearchParams({ limit: String(MONITOR_LIMITS.pageLimit), state: cursor === null ? "firing" : "all" });
  if (cursor !== null) q.set("cursor", cursor);
  const url = `${srv.agent_url.replace(/\/+$/, "")}/spc/v1/alerts?${q}`;
  let r: Response;
  try {
    r = await (deps.fetch ?? fetch)(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", // belirteç yönlendirmeyle başka adrese gitmesin
      signal: AbortSignal.timeout(deps.requestTimeoutMs ?? MONITOR_LIMITS.requestTimeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new ServerError("unreachable", name === "TimeoutError" || name === "AbortError" ? "ajan zaman aşımı" : "ajana bağlanılamadı");
  }
  let body: unknown = null;
  try { body = await r.json(); } catch { /* gövde JSON değil: durum koduna göre aşağıda */ }
  return { status: r.status, body };
}

async function pullServer(
  srv: MonitorServerConfig, st: ServerState, token: string, deps: PullDeps, dry: boolean, res: ServerPullResult, save: () => void,
): Promise<void> {
  const log = deps.log ?? (() => {});
  let index: Map<string, string> | null = null;
  const taskFor = (alertId: string): string | undefined => {
    const known = st.tasks[alertId]?.task;
    if (known) return known;
    index ??= markerIndex(srv.id);
    const found = index.get(alertId);
    if (found) st.tasks[alertId] = { task: found, firing_noted: true, resolved_noted: false };
    return found;
  };
  let cursor = st.cursor, pages = 0, restarted = false;
  for (;;) {
    if (pages >= MONITOR_LIMITS.maxPages) throw new ServerError("page_limit", `sayfa tavanı aşıldı (${MONITOR_LIMITS.maxPages}); imleç ilerlemedi`);
    const { status, body } = await fetchPage(srv, token, cursor, deps);
    if (status === 410 && !restarted) {
      restarted = true; cursor = null; st.cursor = null; st.epoch = null;
      log(`spc ${srv.id}: imleç geçersiz (epoch değişti), baştan başlanıyor`);
      continue;
    }
    if (status === 401 || status === 403) throw new ServerError("unauthorized", `ajan kimlik doğrulamayı reddetti (HTTP ${status})`);
    if (status !== 200) throw new ServerError("unreachable", `ajan beklenmeyen yanıt verdi (HTTP ${status})`);
    const page: AlertsResponse = parseAlertsResponse(body, srv.id);
    if (st.epoch !== null && st.epoch !== page.epoch) log(`spc ${srv.id}: epoch değişti`);
    try {
      for (const a of page.items) handle(a);
    } finally {
      if (res.opened.length || res.noted.length) save(); // yarım sayfada da açılan görevlerin eşlemesi kaybolmasın
    }
    res.fetched += page.items.length;
    st.cursor = page.next_cursor; st.epoch = page.epoch; // görev/not yazıldıktan SONRA
    save();
    pages++;
    if (!page.has_more) return;
    cursor = page.next_cursor;
  }

  function handle(a: AlertItem): void {
    if (a.vlad === "none") { res.skipped++; return; }
    if (a.state === "resolved") {
      const id = taskFor(a.alert_id);
      const e = st.tasks[a.alert_id];
      if (!id || !e) { logAlert(a); return; } // eşleme yok: görev açılmamış
      if (e.resolved_noted) { res.skipped++; return; }
      e.resolved_noted = true;
      if (dry && id === DRY_TASK) return;
      let open = false;
      try { open = !CLOSED.has(getTask(id).data.state); } catch { open = false; }
      if (!open) { log(`spc ${srv.id}: ${a.alert_id} çözüldü, görev ${id} kapalı/yok: not yazılmadı`); return; }
      if (!dry) logTask(id, buildResolvedNote(a));
      res.noted.push({ alert_id: a.alert_id, task: id });
      return;
    }
    if (a.severity !== "critical") { logAlert(a); return; }
    if (taskFor(a.alert_id)) { res.skipped++; return; }
    if (res.opened.length >= MONITOR_LIMITS.maxNewTasksPerPull) {
      throw new ServerError("task_limit", `bir çekişte en çok ${MONITOR_LIMITS.maxNewTasksPerPull} yeni görev açılır; kalanlar sonraki çekişe bırakıldı (görev seli sınırı)`);
    }
    let taskId = DRY_TASK;
    if (!dry) {
      const text = buildAlertTask(srv.id, a);
      taskId = createTask({ project: srv.project, title: text.title, kind: "research", role: "analyst", body: text.description }).data.id;
      index?.set(a.alert_id, taskId);
    }
    st.tasks[a.alert_id] = { task: taskId, firing_noted: true, resolved_noted: false };
    res.opened.push({ alert_id: a.alert_id, task: taskId });
  }

  function logAlert(a: AlertItem): void {
    res.logged.push({ alert_id: a.alert_id, severity: a.severity });
    log(`spc ${srv.id}: ${a.severity} ${a.state} ${a.alert_id}`);
  }
}

const DRY_TASK = "(dry-run)";

/** Çıkış kodu: errors'taki en kötü EXIT_BY_CODE. */
export function exitCodeOf(r: PullResult): 0 | 1 | 2 {
  let worst: 0 | 1 | 2 = 0;
  for (const e of r.errors) worst = Math.max(worst, EXIT_BY_CODE[e.code]) as 0 | 1 | 2;
  return worst;
}

/** `vlad monitor status` verisi (salt okuma). */
export async function monitorStatus(deps: Omit<PullDeps, "secrets" | "fetch">): Promise<MonitorStatus> {
  const state = createStateStore(deps.stateDir ?? monitorStateDir()).load();
  const closed = (id: string): boolean => { try { return CLOSED.has(getTask(id).data.state); } catch { return true; } };
  return {
    servers: deps.config.servers.map((s) => {
      const st = state.servers[s.id] ?? emptyServer();
      return {
        id: s.id, project: s.project, cursor: st.cursor, last_ok: st.last_ok, fail_streak: st.fail_streak,
        unreachable: st.fail_streak >= MONITOR_LIMITS.failStreakWarn,
        open_tasks: Object.entries(st.tasks).filter(([, e]) => !closed(e.task)).map(([alert_id, e]) => ({ alert_id, task: e.task })),
      };
    }),
    service: null,
  };
}
