import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCapacityConfig, CapacityConfigError } from "../../src/monitor/capacity-config.js";

const root = join(__dirname, "..", "..");
const real = join(root, "test", "fixtures", "spc", "capacity-medialog.yaml");
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vlad-capcfg-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
const put = (yaml: string): string => { const f = join(tmp, "capacity.yaml"); writeFileSync(f, yaml); return f; };
const load = (f: string) => loadCapacityConfig(f, { schemaDir: join(root, "schemas") });

describe("capacity.yaml yükleyici", () => {
  it("gerçek medialog fixture'ını doğrular: 5 eski + 8 yeni (1.1.0) tetikleyici; eşikler D-medialog-062 / D-server-pulse-counter-012 birebir", () => {
    const c = load(real);
    expect(c).toMatchObject({ version: 1, server: "medialog", source: "D-medialog-062", warn_pct: 70, consecutive_weeks: 2 });
    expect(c.triggers.map((t) => [t.id, t.metric, t.measure, t.op, t.threshold])).toEqual([
      ["ws-concurrent", "app.ws_connections", "peak", ">=", 300],
      ["proc-cpu", "docker.container.cpu_pct", "daily_avg_peak", ">", 60],
      ["proc-mem", "docker.container.mem_pct", "daily_avg_peak", ">", 60],
      ["db-pool-waiting", "app.db_pool_waiting", "peak", ">=", 1],
      ["http-p95", "app.http_p95_ms", "peak", ">", 1000],
      ["sys-load5", "system.load5", "daily_avg_peak", ">", 2],
      ["sys-swap", "system.swap.used_pct", "peak", ">", 50],
      ["sys-inode", "system.disk.inode_used_pct", "peak", ">", 80],
      ["http-rate", "http.req_rate", "peak", ">", 50],
      ["http-5xx", "http.err5xx_pct", "daily_avg_peak", ">", 1],
      ["pg-cache", "pg.cache_hit_pct", "daily_avg_peak", "<", 95],
      ["tmdb-p95", "app.ext_tmdb_p95_ms_5m", "daily_avg_peak", ">", 1500],
      ["product-active", "app.product_active_7d", "daily_avg_peak", undefined, undefined], // kind: trend (eşiksiz)
    ]);
    expect(c.triggers.at(-1)).toMatchObject({ kind: "trend", unit: "kişi" });
    expect(c.triggers[1]!.labels).toEqual({ name: "medialog-app-1" });
    expect(c.manual?.map((m) => m.id)).toEqual(["item-2", "item-3"]);
  });
  it("eşikler spc rules.yaml ile aynı kalır (fixture ↔ vendored kural değerleri)", () => {
    const y = readFileSync(real, "utf8");
    expect(y).toContain("threshold: 300");
    expect(y).toContain("threshold: 1000");
  });
  it("op '<' ve '<=' kabul edilir; trend tetikleyicisi eşiksiz kabul, eşikli/op'lu reddedilir; trend dışı op+threshold ister", () => {
    const head = "version: 1\nserver: x\nsource: s\nwarn_pct: 70\nconsecutive_weeks: 2\ntriggers:\n";
    const t = (extra: string) => `  - id: a\n    title: t\n    metric: m\n    measure: daily_avg_peak\n    unit: u\n    source_item: 1\n${extra}`;
    expect(load(put(head + t("    op: '<'\n    threshold: 95\n"))).triggers[0]).toMatchObject({ op: "<", threshold: 95 });
    expect(() => load(put(head + t("    op: '<='\n    threshold: 95\n")))).not.toThrow();
    expect(load(put(head + t("    kind: trend\n"))).triggers[0]).toMatchObject({ kind: "trend" });
    expect(() => load(put(head + t("    kind: trend\n    threshold: 5\n")))).toThrow(CapacityConfigError);
    expect(() => load(put(head + t("    kind: trend\n    op: '>'\n")))).toThrow(CapacityConfigError);
    expect(() => load(put(head + t("")))).toThrow(CapacityConfigError); // eşik tetikleyicisi op/threshold'suz olamaz
    expect(() => load(put(head + t("    kind: threshold\n    op: '!='\n    threshold: 1\n")))).toThrow(CapacityConfigError);
  });
  it("dosya yok → CapacityConfigError", () => {
    expect(() => load(join(tmp, "yok.yaml"))).toThrow(CapacityConfigError);
  });
  it("bozuk YAML → CapacityConfigError", () => {
    expect(() => load(put("a: [1, 2"))).toThrow(CapacityConfigError);
  });
  it("ek alan, eksik alan, eşik ≤ 0, bilinmeyen ölçü reddedilir", () => {
    const base = (t: string) => `version: 1\nserver: x\nsource: s\nwarn_pct: 70\nconsecutive_weeks: 2\ntriggers:\n  - id: a\n    title: t\n    metric: m\n    measure: peak\n    op: ">"\n    threshold: 5\n    unit: u\n    source_item: 1\n${t}`;
    expect(() => load(put(base("")))).not.toThrow();
    expect(() => load(put(base("    extra: 1\n")))).toThrow(CapacityConfigError);
    expect(() => load(put(base("").replace("threshold: 5", "threshold: 0")))).toThrow(/threshold/);
    expect(() => load(put(base("").replace("measure: peak", "measure: median")))).toThrow(CapacityConfigError);
    expect(() => load(put(base("").replace("    unit: u\n", "")))).toThrow(CapacityConfigError);
    expect(() => load(put(base("").replace("version: 1", "version: 2")))).toThrow(CapacityConfigError);
  });
  it("yinelenen tetikleyici kimliği reddedilir", () => {
    const t = "  - id: a\n    title: t\n    metric: m\n    measure: peak\n    op: \">\"\n    threshold: 5\n    unit: u\n    source_item: 1\n";
    expect(() => load(put(`version: 1\nserver: x\nsource: s\nwarn_pct: 70\nconsecutive_weeks: 2\ntriggers:\n${t}${t}`))).toThrow(/yinelenen/);
  });
});
