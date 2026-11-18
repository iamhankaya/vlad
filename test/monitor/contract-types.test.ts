import { describe, expect, it } from "vitest";
import { ALERT_MARKER_RE, alertMarker, parseAlertMarker } from "../../src/monitor/marker.js";
import { keychainService } from "../../src/monitor/secret.js";
import { EMPTY_STATE, EXIT_BY_CODE, MONITOR_ERROR_CODES, MONITOR_EXIT, MONITOR_LIMITS, MONITOR_SERVER_ID_RE, type PullResult } from "../../src/monitor/types.js";
import { MONITOR_DIRNAME, monitorStatePath, monitorStateDir } from "../../src/monitor/state.js";
import { MONITOR_LABEL } from "../../src/monitor/launchd.js";
import * as pull from "../../src/monitor/pull.js";
import * as state from "../../src/monitor/state.js";
import * as secret from "../../src/monitor/secret.js";
import * as config from "../../src/monitor/config.js";
import * as taskText from "../../src/monitor/task-text.js";
import * as launchd from "../../src/monitor/launchd.js";

// monitor sözleşmesi (T20261119-20): şekil = sabitler, işaret biçimi, JSON çıktı şekli, imzalar. İş mantığı uygulama fazında; burada gövdeye bağlı iddia yok.
describe("monitor sözleşmesi: MONITOR_LIMITS ve çıkış kodları", () => {
  it("kapı kararı değerleri birebir (değişirse sözleşme itirazı: vlad task ask)", () => {
    expect(MONITOR_LIMITS).toEqual({ maxNewTasksPerPull: 5, failStreakWarn: 3, requestTimeoutMs: 10_000, pageLimit: 500, maxPages: 20, titleMax: 120, launchdIntervalSec: 300 });
  });
  it("çıkış kodları 0/1/2; her hata kodunun eşlemesi var", () => {
    expect(MONITOR_EXIT).toEqual({ ok: 0, serverError: 1, infra: 2 });
    expect(Object.keys(EXIT_BY_CODE).sort()).toEqual([...MONITOR_ERROR_CODES].sort());
    for (const c of ["unreachable", "unauthorized", "schema_mismatch"] as const) expect(EXIT_BY_CODE[c]).toBe(1);
    for (const c of ["config", "keychain", "kb_busy", "unsupported_platform"] as const) expect(EXIT_BY_CODE[c]).toBe(2);
  });
});

describe("monitor sözleşmesi: işaret satırı (idempotans anahtarı)", () => {
  it("biçim `spc-alert: <server>/<alert_id>`; gidiş-dönüş", () => {
    const id = "medialog-app-down.44136fa355b3.1760000000000";
    expect(alertMarker("medialog", id)).toBe(`spc-alert: medialog/${id}`);
    expect(parseAlertMarker(alertMarker("medialog", id))).toEqual({ server: "medialog", alertId: id });
  });
  it("işaret olmayan satırlar ve enjekte edilmiş varyantlar null", () => {
    for (const l of ["", "spc-alert:medialog/x", "spc-alert: Medialog/x", "spc-alert: a/b c", "- spc-alert: a/b", "spc-alert: a/b\nspc-alert: c/d", "spc-alert: a/"]) expect(parseAlertMarker(l), JSON.stringify(l)).toBeNull();
    expect(ALERT_MARKER_RE.test("spc-alert: a/b")).toBe(true);
  });
});

describe("monitor sözleşmesi: Keychain kaydı ve sunucu kimliği", () => {
  it("hizmet adı spc run-health.sh ile aynı: spc_token_<id>, - → _", () => {
    expect(keychainService("medialog")).toBe("spc_token_medialog");
    expect(keychainService("my-server-1")).toBe("spc_token_my_server_1");
  });
  it("geçersiz kimlik reddedilir (komut/argüman enjeksiyonu yok)", () => {
    for (const id of ["", "A", "-x", "a b", "a;b", "a/../b", "$(x)"]) expect(() => keychainService(id), id).toThrow();
    expect(MONITOR_SERVER_ID_RE.test("a-1")).toBe(true);
  });
});

describe("monitor sözleşmesi: durum dosyası konumu ve şeması", () => {
  it("~/.vlad-monitor/state.json; boş durum v1", () => {
    expect(MONITOR_DIRNAME).toBe(".vlad-monitor");
    expect(monitorStateDir("/h")).toBe("/h/.vlad-monitor");
    expect(monitorStatePath("/h/.vlad-monitor")).toBe("/h/.vlad-monitor/state.json");
    expect(EMPTY_STATE).toEqual({ v: 1, servers: {} });
  });
});

describe("monitor sözleşmesi: --json çıktı şekli (tip düzeyi + örnek)", () => {
  it("PullResult: servers[] + errors[]; belirteç alanı yok", () => {
    const r: PullResult = {
      servers: [{ id: "medialog", ok: true, fetched: 1, opened: [{ alert_id: "a", task: "T1" }], noted: [], logged: [{ alert_id: "b", severity: "warning" }], skipped: 0 }],
      errors: [{ server: "medialog", code: "unreachable", message: "x" }],
    };
    expect(Object.keys(r).sort()).toEqual(["errors", "servers"]);
    expect(JSON.stringify(r)).not.toMatch(/token|secret/i);
  });
});

describe("monitor sözleşmesi: dışa aktarılan imzalar (ad + arite)", () => {
  const fn = (m: Record<string, unknown>, name: string, arity: number) => {
    expect(typeof m[name], name).toBe("function");
    expect((m[name] as (...a: unknown[]) => unknown).length, `${name}.length`).toBe(arity);
  };
  it("pull.ts, state.ts, secret.ts, config.ts, task-text.ts, launchd.ts", () => {
    fn(pull, "pullAlerts", 1); // ikinci parametre varsayılanlı (opts = {}) → length 1
    fn(pull, "exitCodeOf", 1); fn(pull, "monitorStatus", 1);
    fn(state, "createStateStore", 1);
    fn(secret, "createKeychainReader", 1); fn(secret, "keychainService", 1);
    fn(config, "loadMonitorConfig", 1);
    fn(taskText, "buildAlertTask", 2); fn(taskText, "buildResolvedNote", 1);
    fn(launchd, "monitorPlist", 2); fn(launchd, "createMonitorInstaller", 1);
    expect(MONITOR_LABEL).toBe("com.vlad.monitor");
  });
  it("gövdeler henüz yok: not implemented (uygulama fazı kaldırır; kabul testleri kırmızı başlar)", async () => {
    await expect(pull.pullAlerts({} as never)).rejects.toThrow("not implemented");
    expect(() => config.loadMonitorConfig("/x")).toThrow("not implemented");
  });
});
