// vlad history ↔ hunter sarmalayıcısı (T20261127-21). hunter gerçek ikili değil: sahte koşucu ya da geçici dizindeki sahte betik.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureRoot } from "../helpers.js";
import {
  HistoryError,
  STALE_AFTER_S,
  historySearch,
  historyShow,
  locateHunter,
  triggerHunterIndex,
  type HunterRun,
} from "../../src/history/hunter.js";

const SEARCH = {
  schema: 1, query: "adb port", took_ms: 7, total_hits: 1, returned: 1,
  last_indexed: "2026-11-27T20:05:11.000Z", index_age_s: 3600, warnings: [],
  results: [{ id: "-Users-u-dev-app/s.jsonl:412", score: 11.8, ts: "2026-11-26T14:03:22.120Z", project: "app", task: null, session: "s",
    role: "assistant", kind: "text", tool: null, sidechain: false, source_deleted: false, path: "-Users-u-dev-app/s.jsonl", line: 412, cwd: "/Users/u/dev/app", snippet: "… «adb» …" }],
};
const SHOW = { schema: 1, id: "a.jsonl:3", path: "a.jsonl", session: "s", project: "app", task: null, sidechain: false, source_deleted: false,
  messages: [{ line: 3, ts: "2026-11-26T14:03:22.120Z", target: true, blocks: [{ block: 0, role: "user", kind: "text", tool: null, text: "merhaba" }] }] };

/** Fake runner: records argv, returns the given result. */
function fake(result: Partial<ReturnType<HunterRun>>) {
  const calls: string[][] = [];
  const run: HunterRun = (bin, args) => { calls.push([bin, ...args]); return { status: 0, stdout: "", stderr: "", ...result }; };
  return { calls, run };
}
const bin = "/fake/hunter";

function exe(dir: string, name: string, body = ""): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("locateHunter", () => {
  it("PATH'teki çalıştırılabilir hunter'ı bulur; hunterPath'ten önce gelir", () => {
    const root = makeFixtureRoot();
    const onPath = exe(join(root, "bin"), "hunter");
    const cfg = exe(join(root, "cfg"), "hunter");
    const r = locateHunter({ env: { PATH: [join(root, "yok"), join(root, "bin")].join(delimiter) }, hunterPath: cfg, vladHome: root });
    expect(r.bin).toBe(onPath);
  });
  it("PATH'te yoksa hunterPath (VLAD_HOME'a göre göreli ya da mutlak)", () => {
    const root = makeFixtureRoot();
    const cfg = exe(join(root, "cfg"), "hunter");
    expect(locateHunter({ env: { PATH: join(root, "bos") }, hunterPath: cfg, vladHome: root }).bin).toBe(cfg);
    expect(locateHunter({ env: { PATH: "" }, hunterPath: "cfg/hunter", vladHome: root }).bin).toBe(cfg);
  });
  it("çalıştırılamaz dosya ve dizin sayılmaz; hiçbiri yoksa bin null ve denenenler listelenir", () => {
    if (process.platform === "win32") return; // yürütme biti POSIX'e özgü
    const root = makeFixtureRoot();
    mkdirSync(join(root, "a", "hunter"), { recursive: true }); // dizin
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "b", "hunter"), "x"); // yürütme biti yok
    const r = locateHunter({ env: { PATH: [join(root, "a"), join(root, "b")].join(delimiter) }, hunterPath: join(root, "nerede", "hunter"), vladHome: root });
    expect(r.bin).toBeNull();
    expect(r.tried.join("\n")).toMatch(/PATH/);
    expect(r.tried.join("\n")).toContain(join(root, "nerede", "hunter"));
  });
});

describe("historySearch", () => {
  it("hunter'ı search --json ve süzgeç bayraklarıyla çağırır, sorgu `--` sonrasında tek argüman", () => {
    const f = fake({ stdout: JSON.stringify(SEARCH) });
    historySearch({ query: "-x adb", project: "app", task: "T20261126-29", since: "2026-11-01", until: "2026-11-27", limit: "5", all: true }, { bin, run: f.run });
    expect(f.calls).toEqual([[bin, "search", "--json", "--project", "app", "--task", "T20261126-29", "--since", "2026-11-01", "--until", "2026-11-27", "--limit", "5", "--all", "--", "-x adb"]]);
  });
  it("verilmeyen bayraklar geçmez; çıktı hunter JSON'ı aynen (+warnings)", () => {
    const f = fake({ stdout: JSON.stringify(SEARCH) });
    const out = historySearch({ query: "adb" }, { bin, run: f.run });
    expect(f.calls[0]).toEqual([bin, "search", "--json", "--", "adb"]);
    expect(out).toEqual(SEARCH);
  });
  it("dizin 24 saatten eskiyse warnings'e uyarı eklenir; hunter'ın kendi uyarıları korunur", () => {
    const f = fake({ stdout: JSON.stringify({ ...SEARCH, index_age_s: STALE_AFTER_S + 1, warnings: ["dengesiz tırnak"] }) });
    const out = historySearch({ query: "adb" }, { bin, run: f.run });
    expect(out.warnings[0]).toBe("dengesiz tırnak");
    expect(out.warnings[1]).toMatch(/24 saatten eski.*hunter index/);
  });
  it("tam 24 saat uyarı vermez; last_indexed null ise uyarı verir", () => {
    const ok = historySearch({ query: "a" }, { bin, run: fake({ stdout: JSON.stringify({ ...SEARCH, index_age_s: STALE_AFTER_S }) }).run });
    expect(ok.warnings).toEqual([]);
    const none = historySearch({ query: "a" }, { bin, run: fake({ stdout: JSON.stringify({ ...SEARCH, last_indexed: null, index_age_s: null }) }).run });
    expect(none.warnings.join()).toMatch(/hunter index/);
  });
  it("hunter yoksa HistoryError + kurulum ipucu (cargo install, hunterPath)", () => {
    let e: unknown;
    try { historySearch({ query: "a" }, { bin: null, tried: ["PATH: hunter yok"], run: fake({}).run }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(HistoryError);
    expect((e as Error).message).toMatch(/hunter bulunamadı/);
    expect((e as HistoryError).details.join("\n")).toMatch(/cargo install --path/);
    expect((e as HistoryError).details.join("\n")).toMatch(/hunterPath/);
  });
  it("hunter no_index → açık hata + `hunter index` ipucu; hunter'ın code'u details'te", () => {
    const stderr = JSON.stringify({ error: "dizin yok: /c/hunter (önce `hunter index`)", code: "no_index", details: [] }) + "\n";
    let e: HistoryError | undefined;
    try { historySearch({ query: "a" }, { bin, run: fake({ status: 1, stderr }).run }); } catch (x) { e = x as HistoryError; }
    expect(e).toBeInstanceOf(HistoryError);
    expect(e!.message).toMatch(/dizin yok/);
    expect(e!.details).toContain("code: no_index");
    expect(e!.details.join("\n")).toMatch(/hunter index/);
  });
  it("JSON olmayan stderr (clap kullanım hatası, çıkış 2) metniyle hata olur", () => {
    let e: Error | undefined;
    try { historySearch({ query: "a", since: "dun" }, { bin, run: fake({ status: 2, stderr: "error: invalid value 'dun' for '--since'\n\nFor more information, try '--help'.\n" }).run }); } catch (x) { e = x as Error; }
    expect(e).toBeInstanceOf(HistoryError);
    expect(e!.message).toMatch(/invalid value 'dun'/);
  });
  it("çalıştırılamayan ikili, bozuk JSON ve beklenmeyen şema sürümü hata olur", () => {
    expect(() => historySearch({ query: "a" }, { bin, run: fake({ status: null, error: new Error("spawn EACCES") }).run })).toThrow(/hunter çalıştırılamadı.*EACCES/);
    expect(() => historySearch({ query: "a" }, { bin, run: fake({ stdout: "{yarım" }).run })).toThrow(/hunter çıktısı okunamadı/);
    expect(() => historySearch({ query: "a" }, { bin, run: fake({ stdout: JSON.stringify({ ...SEARCH, schema: 2 }) }).run })).toThrow(/şema/);
  });
});

describe("historyShow", () => {
  it("hunter show <id> --json çağırır; --context geçer", () => {
    const f = fake({ stdout: JSON.stringify(SHOW) });
    expect(historyShow("a.jsonl:3", {}, { bin, run: f.run })).toEqual(SHOW);
    historyShow("a.jsonl:3", { context: "2" }, { bin, run: f.run });
    expect(f.calls).toEqual([[bin, "show", "--json", "--", "a.jsonl:3"], [bin, "show", "--json", "--context", "2", "--", "a.jsonl:3"]]);
  });
  it("hunter not_found → HistoryError", () => {
    const stderr = JSON.stringify({ error: "kayıt yok: a.jsonl:3", code: "not_found", details: [] });
    expect(() => historyShow("a.jsonl:3", {}, { bin, run: fake({ status: 1, stderr }).run })).toThrow(/kayıt yok/);
  });
});

describe("triggerHunterIndex", () => {
  it("hunter varsa index --if-exists --quiet'i ayrık (detached, stdio ignore) başlatır ve unref eder", () => {
    const calls: { bin: string; args: string[]; opts: any }[] = [];
    let unref = 0;
    const pid = triggerHunterIndex({ locate: () => "/x/hunter", spawn: (b, a, o) => { calls.push({ bin: b, args: a, opts: o }); return { pid: 42, unref: () => { unref++; }, on: () => {} } as any; } });
    expect(pid).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["index", "--if-exists", "--quiet"]);
    expect(calls[0]!.opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toBe(1);
  });
  it("hunter yoksa sessiz: spawn yok, null", () => {
    let n = 0;
    expect(triggerHunterIndex({ locate: () => null, spawn: () => { n++; return {} as any; } })).toBeNull();
    expect(n).toBe(0);
  });
  it("spawn hatası (senkron atma) yutulur", () => {
    expect(triggerHunterIndex({ locate: () => "/x/hunter", spawn: () => { throw new Error("EAGAIN"); } })).toBeNull();
  });
  it("gerçek süreç: ayrık hunter çocuğu çağıran beklemeden çalışmayı sürdürür (sahte betik, geçici dizin)", async () => {
    if (process.platform === "win32") return;
    const root = makeFixtureRoot();
    const marker = join(root, "started");
    const done = join(root, "done");
    const script = exe(join(root, "bin"), "hunter", [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));`,
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(done)}, "1"), 3000);`,
    ].join("\n").replace(/require\(/g, "process.getBuiltinModule("));
    const pid = triggerHunterIndex({ locate: () => script });
    expect(pid).toBeGreaterThan(0);
    expect(existsSync(done)).toBe(false); // çağıran çocuğu beklemedi
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(marker, "utf8")).toBe("index --if-exists --quiet");
    try { process.kill(pid!); } catch { /* zaten bitti */ }
  });
});
