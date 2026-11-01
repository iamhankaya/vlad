// F-vlad-096 doğrulama (tester, T20261101-14): kilit düzeltmesini bağımsız zorlar.
// Her şey makeHome() geçici dizininde ve sahte kb ile koşar; gerçek kb/ (C:\dev\vlad-kb) ve ~/.claude'a dokunulmaz.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";

const cli = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
let home: string;
beforeEach(() => {
  home = makeHome();
  // gerçek kaynak koruması: kb gerçekten geçici dizinde olmalı
  expect(realpathSync.native(home).startsWith(realpathSync.native(tmpdir()))).toBe(true);
});

type Res = { code: number | null; out: string; err: string };
function spawnVlad(args: string[], input = "", env: Record<string, string> = {}) {
  const p = spawn("node", [cli, ...args], { env: { ...process.env, VLAD_HOME: home, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise<Res>((r) => p.on("close", (code) => r({ code, out, err })));
  p.stdin.end(input);
  return { p, done };
}
const vlad = (a: string[], i = "", e: Record<string, string> = {}) => spawnVlad(a, i, e).done;
const kb = () => join(home, "kb");

const CARD = `---
slug: alpha
name: Alpha
path: "C:\\\\x"
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x

## Çalışma notları
`;

async function setup() {
  writeFileSync(join(home, "card.md"), CARD);
  expect((await vlad(["project", "write", "alpha", "--file", join(home, "card.md")])).code).toBe(0);
}
const newTask = async (title: string, env = {}) => {
  const r = await vlad(["task", "new", "--project", "alpha", "--title", title, "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n", env);
  return { r, id: r.code === 0 ? (JSON.parse(r.out).id as string) : "" };
};

/** Kilit artıkları: .vlad.lock, .break, .stale-*, atomik yazım tmp'leri. */
const leftovers = (dir: string): string[] => {
  const acc: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) acc.push(...leftovers(join(dir, e.name)));
    else if (/\.vlad\.lock|\.tmp|\.stale-/.test(e.name)) acc.push(join(dir, e.name));
  }
  return acc;
};

describe("F-vlad-096 doğrulama: yük altında eşzamanlılık", { timeout: 300_000 }, () => {
  it("8 süreç × 4 tur karışık yazma: kayıp yok, çift ID yok, dosyalar geçerli, artık kilit yok", async () => {
    await setup();
    const env = { VLAD_LOCK_TIMEOUT_MS: "240000" }; // yük altında geniş bekleme payı (duvar saati iddiası yok; yalnız zaman aşımı payı)
    const W = 8, R = 4;
    const taskIds: string[] = [], findingIds: string[] = [], decisionIds: string[] = [], failures: string[] = [];
    const worker = async (w: number) => {
      for (let i = 0; i < R; i++) {
        const tag = `w${w}-i${i}`;
        const t = await newTask(`t-${tag}`, env);
        if (t.r.code !== 0) { failures.push(`task new: ${t.r.err.trim()}`); continue; }
        taskIds.push(t.id);
        const f = await vlad(["finding", "add", "--project", "alpha", "--severity", "düşük", "--source", t.id, "--title", `f-${tag}`, "--json"], "", env);
        const d = await vlad(["decision", "add", "--project", "alpha", "--title", `d-${tag}`, "--body-file", "-", "--json"], `karar ${tag}\n`, env);
        const rs: Res[] = [
          f, d,
          await vlad(["journal", "append", "2026-11-01", "--file", "-"], `## alpha\n- ${tag}\n`, env),
          await vlad(["task", "log", t.id, `log-${tag}`], "", env),
          await vlad(["project", "note", "alpha", `not-${tag}`], "", env),
        ];
        if (f.code === 0) { findingIds.push(JSON.parse(f.out).id); rs.push(await vlad(["finding", "set", JSON.parse(f.out).id, "deferred"], "", env)); }
        if (d.code === 0) decisionIds.push(JSON.parse(d.out).id);
        rs.push(await vlad(["task", "set", t.id, "cancelled"], "", env));
        for (const r of rs) if (r.code !== 0) failures.push(r.err.trim());
      }
    };
    await Promise.all(Array.from({ length: W }, (_, w) => worker(w)));

    const n = W * R;
    expect(failures).toEqual([]);
    expect(new Set(taskIds).size).toBe(n);
    expect(new Set(findingIds).size).toBe(n);
    expect(new Set(decisionIds).size).toBe(n);
    // dosyalar CLI'dan okunabilir (şema geçerli) ve sayılar tam
    const tl = (JSON.parse((await vlad(["task", "list", "--json"])).out) as { tasks: { id: string; state: string }[] }).tasks;
    expect(tl.filter((t) => t.state === "cancelled")).toHaveLength(n);
    const fl = (JSON.parse((await vlad(["finding", "list", "--project", "alpha", "--json"])).out) as { findings: { id: string; state: string }[] }).findings;
    expect(fl).toHaveLength(n);
    expect(fl.every((f) => f.state === "deferred")).toBe(true);
    const dlRaw = JSON.parse((await vlad(["decision", "list", "--project", "alpha", "--json"])).out) as { decisions: unknown[] };
    const dl = dlRaw.decisions;
    expect(dl).toHaveLength(n);
    const journal = readFileSync(join(kb(), "journal", "2026-11-01.md"), "utf8");
    expect(journal.match(/- w\d+-i\d+/g)).toHaveLength(n);
    const card = readFileSync(join(kb(), "projects", "alpha.md"), "utf8");
    expect(card.match(/not-w\d+-i\d+/g)).toHaveLength(n);
    for (const id of taskIds) {
      const body = readFileSync(join(kb(), "tasks", `${id}.md`), "utf8");
      expect(body.match(/log-w\d+-i\d+/g)).toHaveLength(1);
    }
    expect(leftovers(kb())).toEqual([]);
  });
});

describe("F-vlad-096 doğrulama: sahibi ölen kilit", { timeout: 300_000 }, () => {
  const sleeper = () => {
    const p = spawn("node", ["-e", "setTimeout(()=>{},600000)"], { stdio: "ignore" });
    return p;
  };
  // F-vlad-107: taskkill yalnız Windows'ta var; diğer platformlarda SIGKILL (ağaç gerekmez: süreçler doğrudan `node`)
  const kill = (pid: number) => {
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
    else try { process.kill(pid, "SIGKILL"); } catch { /* zaten çıkmış */ }
  };

  it("ölü pid'li kilit varken 4 yazan makul sürede devam eder ve kilit kırılır", async () => {
    await setup();
    const { id } = await newTask("T");
    const s = sleeper();
    const dead = s.pid!;
    kill(dead);
    await new Promise((r) => s.on("close", r));
    writeFileSync(join(kb(), ".vlad.lock"), JSON.stringify({ pid: dead, started: Date.now(), token: "dead" }));
    const env = { VLAD_LOCK_TIMEOUT_MS: "20000" }; // bayat kırma olmadan bu süre dolardı; geçmesi kırmanın çalıştığını gösterir
    const rs = await Promise.all([0, 1, 2, 3].map((i) => vlad(["task", "log", id, `dead-${i}`], "", env)));
    expect(rs.map((r) => r.err.trim())).toEqual(["", "", "", ""]);
    expect(rs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(readFileSync(join(kb(), "tasks", `${id}.md`), "utf8").match(/dead-\d/g)).toHaveLength(4);
    expect(leftovers(kb())).toEqual([]);
  });

  it("yazma sırasında rastgele süreçler zorla (taskkill /F, SIGKILL) öldürülünce: sağ kalanlar tamamlanır, dosyalar bozulmaz, kilit artığı kalmaz", async () => {
    await setup();
    const env = { VLAD_LOCK_TIMEOUT_MS: "120000" };
    const { id } = await newTask("T", env);
    const N = 24;
    const procs = Array.from({ length: N }, (_, i) =>
      spawnVlad(i % 2 ? ["task", "log", id, `k-${i}`] : ["journal", "append", "2026-11-01", "--file", "-"], i % 2 ? "" : `## alpha\n- k-${i}\n`, env));
    // 25 ms aralıkla yarısını öldür; kimin kilidi tuttuğu belirsiz, bu istenen durum
    const victims = new Set<number>();
    for (let i = 0; i < N; i += 3) { await new Promise((r) => setTimeout(r, 25)); victims.add(i); kill(procs[i].p.pid!); }
    const results = await Promise.all(procs.map((x) => x.done));
    const survivors = results.map((r, i) => ({ r, i })).filter(({ i }) => !victims.has(i));
    // öldürülmeyen hiçbir süreç hata vermemeli
    expect(survivors.filter(({ r }) => r.code !== 0).map(({ i, r }) => `${i}: ${r.err.trim()}`)).toEqual([]);
    // her sağ kalanın yazısı dosyada tam olarak bir kez
    const task = readFileSync(join(kb(), "tasks", `${id}.md`), "utf8");
    const journalPath = join(kb(), "journal", "2026-11-01.md");
    const journal = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "";
    for (const { i } of survivors) {
      const [src, re] = i % 2 ? [task, new RegExp(`k-${i}\\b`, "g")] : [journal, new RegExp(`- k-${i}\\b`, "g")];
      expect(src.match(re), `k-${i}`).toHaveLength(1);
    }
    // dosyalar bozulmadı: CLI hâlâ okuyup yazabiliyor
    expect((await vlad(["task", "list", "--json"])).code).toBe(0);
    expect((await vlad(["task", "log", id, "sonra"], "", { VLAD_LOCK_TIMEOUT_MS: "20000" })).code).toBe(0);
    expect(leftovers(kb()).filter((f) => !/\.tmp/.test(f))).toEqual([]);
  });
});

describe("F-vlad-096 doğrulama: zaman aşımı ve okuma", { timeout: 120_000 }, () => {
  it("kilit canlı sahipteyken her yazma komutu JSON hata + çıkış 1 verir ve hiçbir şeyi değiştirmez; okumalar etkilenmez", async () => {
    await setup();
    const { id } = await newTask("T");
    const lock = join(kb(), ".vlad.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: Date.now(), token: "held" }));
    const env = { VLAD_LOCK_TIMEOUT_MS: "300" };
    const before = readFileSync(join(kb(), "tasks", `${id}.md`), "utf8");
    const writes: [string[], string][] = [
      [["task", "log", id, "x", "--json"], ""],
      [["task", "new", "--project", "alpha", "--title", "N", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n"],
      [["finding", "add", "--project", "alpha", "--severity", "düşük", "--source", id, "--title", "F", "--json"], ""],
      [["decision", "add", "--project", "alpha", "--title", "D", "--body-file", "-", "--json"], "k\n"],
      [["journal", "append", "2026-11-01", "--file", "-"], "## alpha\n- x\n"],
      [["project", "note", "alpha", "n", "--json"], ""],
      [["task", "set", id, "cancelled", "--json"], ""],
    ];
    for (const [a, input] of writes) {
      const aj = a.includes("--json") ? a : [...a, "--json"]; // hata JSON biçimi yalnız --json ile
      const r = await vlad(aj, input, env);
      expect(r.code, a.join(" ")).toBe(1);
      expect(JSON.parse(r.err).error, a.join(" ")).toMatch(/^kb kilidi alınamadı/);
    }
    expect(readFileSync(join(kb(), "tasks", `${id}.md`), "utf8")).toBe(before);
    expect(readdirSync(join(kb(), "tasks")).filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect(existsSync(join(kb(), "findings"))).toBe(false);
    // okuma komutları kilidi görmezden gelir
    for (const a of [["task", "list", "--json"], ["project", "list", "--json"], ["project", "status", "alpha", "--json"], ["finding", "list", "--json"], ["decision", "list", "--json"], ["kb", "search", "alpha", "--json"], ["kb", "get", id, "--json"], ["status", "--no-mark", "--json"]]) {
      const r = await vlad(a, "", env);
      expect(r.code, `${a.join(" ")}: ${r.err}`).toBe(0);
    }
    // kilit dosyasına dokunulmadı (zaman aşımı kilidi çalmaz)
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("held");
  });
});
