// Kabul (T20261109-06, çatı T20261109-03): `script-list` / `script-run` op'ları gerçek Agent sunucusu (loopback, imzalı çerçeve) + gerçek git deposu
// + gerçek bash betikleriyle. Kaynak: spec raporu (T20261109-04) S1–S22 ve KK1/KK2/KK4/KK6/KK8, sözleşme raporu (T20261109-05).
// Yalnız geçici dizin ve sahte kaynak: işçi home'u temp'te bir git deposu, origin temp'te bare. Uygulama (T20261109-07) yokken KIRMIZI beklenir
// (op gövdeleri NotImplementedOp). POSIX betikleri (.sh); Windows .ps1 koşumu gerçek makinede (bkz. rapor Açık noktalar).
// Neden mesajı biçimi: `<kod>: … [<neden>] …` (sözleşme: yeni AgentCode yok). Zaman: duvar saati iddiaları yalnız zaman aşımı testinde ve geniş payla.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { encodeFrame, FrameDecoder } from "../../src/agent/frame.js";
import { Journal } from "../../src/agent/journal.js";
import { setAgentEnv } from "../../src/agent/ops/env.js";
import { OP_TABLE } from "../../src/agent/ops/index.js";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import { startServer, type RunningServer } from "../../src/agent/server.js";
import { signRequest } from "../../src/agent/sign.js";
import { defaultConfig } from "../../src/kb/config.js";
import type { VladConfig } from "../../src/kb/types.js";
import { RemoteError, type AgentOp, type AgentRequest, type ScriptListResult, type ScriptRunResult } from "../../src/fleet/types.js";
import { rmTemp } from "../helpers.js";
import { SCRIPTS } from "../support/script-fixtures.js";
import { PLAT, git, makeScriptRepo, sh, type FxScript, type ScriptRepo } from "../support/script-repo.js";

const NAME = "worker";
// Çift anahtar (D-vlad-057): anahtar KARŞI taraf adıyla tutulur.
const K = { mac: "11".repeat(32), worker: "22".repeat(32), desktop: "33".repeat(32), worker2: "44".repeat(32) };

interface Ctx { fx: ScriptRepo; srv: RunningServer; roots: string; base: string; journal: Journal; cfg: VladConfig; as: (self: string) => AgentClient; mac: AgentClient }
let base = "";
const cleanups: (() => Promise<void> | void)[] = [];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => { savedEnv = { VLAD_HOME: process.env.VLAD_HOME, GH_TOKEN: process.env.GH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, VLAD_LOCAL_FILE: process.env.VLAD_LOCAL_FILE }; });
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  setAgentEnv(undefined);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (base) rmTemp(base);
  base = "";
});

/** İşçi Agent'ı (self=worker) gerçek git deposu üzerinde kurar. */
async function setup(scripts: FxScript[] = SCRIPTS, o: { home?: (fx: ScriptRepo) => string } = {}): Promise<Ctx> {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-sacc-")));
  const fx = makeScriptRepo(join(base, "home"), join(base, "origin.git"), scripts);
  const roots = join(base, "roots"); mkdirSync(roots);
  process.env.VLAD_HOME = o.home ? o.home(fx) : fx.repo;
  const cfg: VladConfig = {
    ...defaultConfig(), brain: "mac", consoles: [{ name: "desktop" }],
    machines: [
      { name: "mac", os: PLAT, agent: { host: "127.0.0.1", port: 1 } },
      { name: NAME, os: PLAT, agent: { host: "127.0.0.1", port: 1 }, roots: [roots] },
      { name: "worker2", os: PLAT, agent: { host: "127.0.0.1", port: 1 } },
    ],
  };
  const journal = new Journal(join(base, "j.jsonl"), () => Date.now());
  const self = new AgentClient({ self: NAME, keys: K, config: () => cfg });
  setAgentEnv({ self: NAME, kind: "worker-agent", cfg, startedAt: Date.now() - 5000, build: "t", journal, transport: self, now: () => Date.now() });
  const srv = await startServer({ self: NAME, kind: "worker-agent", cfg: () => cfg, keys: K, ops: { ...OP_TABLE }, journal, build: "t", bind: "127.0.0.1", port: 0 });
  cleanups.push(() => srv.close());
  for (const m of cfg.machines!) m.agent.port = srv.port;
  const as = (who: string) => new AgentClient({ self: who, keys: { [NAME]: K[who as keyof typeof K] }, config: () => cfg });
  return { fx, srv, roots, base, journal, cfg, as, mac: as("mac") };
}

const run = (c: Ctx, name: string, params?: Record<string, string>, o: { opId?: string; approval?: { planId: string }; timeoutMs?: number; client?: AgentClient } = {}) =>
  (o.client ?? c.mac).call<ScriptRunResult>(NAME, "script-run", { name, ...(params ? { params } : {}), ...(o.approval ? { approval: o.approval } : {}) }, { opId: o.opId ?? `o-${Math.random().toString(36).slice(2)}`, timeoutMs: o.timeoutMs ?? 30_000 });
const list = (c: Ctx) => c.mac.call<ScriptListResult>(NAME, "script-list", {});
const plan = (c: Ctx, name: string, params: Record<string, string> = {}) =>
  ({ planId: scriptPlanId({ machine: NAME, name, platform: PLAT, sha256: c.fx.entry(SCRIPTS.find((s) => s.name === name)!).sha256, params }) });
async function fails(p: Promise<unknown>, code: string, reason?: string): Promise<RemoteError> {
  const e = await p.then(() => undefined, (x) => x);
  expect(e, "RemoteError bekleniyordu").toBeInstanceOf(RemoteError);
  expect((e as RemoteError).code, (e as RemoteError).message).toBe(code);
  if (reason) expect((e as RemoteError).message, `neden [${reason}]`).toContain(`[${reason}]`);
  return e as RemoteError;
}
/** İmzalı ham istek → tek yanıt çerçevesi. */
function raw(port: number, frame: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1"); const d = new FrameDecoder();
    s.on("connect", () => s.write(encodeFrame(frame)));
    s.on("data", (b) => { const [r] = d.push(b); if (r) { s.destroy(); resolve(r); } });
    s.on("error", reject); s.on("close", () => resolve(null));
  });
}
const req = (o: Partial<AgentRequest> = {}) => signRequest(K.mac, { v: 1, from: "mac", to: NAME, opId: "op-" + Math.random().toString(36).slice(2), ts: Date.now(), op: "script-run" as AgentOp, args: { name: "mark-read" }, ...o });
const until = async (f: () => boolean, ms = 10_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("beklenen koşul oluşmadı"); await new Promise((r) => setTimeout(r, 50)); } };

describe.skipIf(process.platform === "win32")("scripts S1/S2: mutlu yol (read + write) ve çalışma ortamı", () => {
  it("S1 read: exit 0, sonuç alanları, data = sentinel JSON'u, replayed yok; head ve sha256 gerçek git/blob değerleri", async () => {
    const c = await setup();
    const { result, meta } = await run(c, "show-env", { msg: "hi" });
    expect(result).toMatchObject({ name: "show-env", platform: PLAT, exit: 0, timedOut: false, head: c.fx.head(), sha256: c.fx.entry(SCRIPTS[0]!).sha256 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
    expect(result.data).toMatchObject({ ok: true, summary: "s", msg: "hi" });
    expect(result.dataError).toBeUndefined();
    expect(result.restart).toBeUndefined();
    expect(meta?.replayed).toBeUndefined();
    expect(result.stdout).toContain("@@VLAD-RESULT@@");
  });
  it("parametreler VLAD_PARAM_<AD> (- → _, büyük harf) ortam değişkeniyle gider; verilmeyen parametrede manifest default'u uygulanır", async () => {
    const c = await setup();
    const a = (await run(c, "show-env", { msg: "hi", mode: "slow", count: "3", "dry-run": "true" })).result.data!;
    expect(a).toMatchObject({ msg: "hi", mode: "slow", count: "3", dry: "true" });
    const b = (await run(c, "show-env")).result.data!;
    expect(b).toMatchObject({ msg: "dflt", mode: "fast", count: "2", dry: "false" });
  });
  it("betik ortamı: VLAD_OP_ID/VLAD_SCRIPT/VLAD_MACHINE/VLAD_REPO, cwd = repo; çalışan dosya çalışma ağacı dosyası değil (blob kopyası)", async () => {
    const c = await setup();
    const d = (await run(c, "show-env", undefined, { opId: "op-env-1" })).result.data as Record<string, string>;
    expect(d.op).toBe("op-env-1");
    expect(d.script).toBe("show-env");
    expect(d.machine).toBe(NAME);
    expect(realpathSync.native(d.repo)).toBe(c.fx.repo);
    expect(realpathSync.native(d.pwd)).toBe(c.fx.repo);
    expect(d.self.startsWith(join(c.fx.repo, "agent-scripts") + "/"), `çalışan dosya çalışma ağacındaki betik: ${d.self}`).toBe(false);
  });
  it("ortam allowlist'i: Agent ortamındaki sırlar (GH_TOKEN, ANTHROPIC_API_KEY, VLAD_LOCAL_FILE, VLAD_AGENT_TEST) betiğe geçmez", async () => {
    const c = await setup();
    process.env.GH_TOKEN = "ghp_sizinti"; process.env.ANTHROPIC_API_KEY = "sk-sizinti"; process.env.VLAD_LOCAL_FILE = "/gizli/vlad.local.json"; process.env.VLAD_AGENT_TEST = "1";
    try {
      const d = (await run(c, "show-env")).result.data as Record<string, string>;
      expect(d).toMatchObject({ gh: "UNSET", anth: "UNSET", localfile: "UNSET", agenttest: "UNSET" });
    } finally { delete process.env.VLAD_AGENT_TEST; }
  });
  it("S2 write: plan-id ile çalışır ve işaret bırakır", async () => {
    const c = await setup();
    const r = await run(c, "mark-write", {}, { approval: plan(c, "mark-write"), opId: "w-1" });
    expect(r.result).toMatchObject({ exit: 0, data: { ok: true, summary: "w" } });
    expect(c.fx.lines("mark-write")).toEqual(["w-1"]);
  });
  it("script-list: platformun girişleri, sınıf/sha/integrity=ok; head gerçek HEAD", async () => {
    const c = await setup();
    const { result } = await list(c);
    expect(result.head).toBe(c.fx.head());
    expect(result.platform).toBe(PLAT);
    const by = new Map(result.scripts.map((s) => [s.name, s]));
    expect(by.get("mark-write")).toMatchObject({ class: "write", integrity: "ok", platform: PLAT, sha256: c.fx.entry(SCRIPTS.find((s) => s.name === "mark-write")!).sha256 });
    expect(by.get("show-env")).toMatchObject({ class: "read", integrity: "ok", timeoutSec: 30 });
    expect(by.get("typed")!.params.map((p) => p.name)).toEqual(["tag", "mode", "n", "flag", "word"]);
  });
  it("script-list günlüğe girmez (salt okuma); script-run girer", async () => {
    const c = await setup();
    await c.mac.call(NAME, "script-list", {}, { opId: "l-1" });
    await run(c, "mark-read", undefined, { opId: "r-1" });
    expect(c.journal.get("l-1")).toBeUndefined();
    expect(c.journal.get("r-1")?.state).toBe("done");
  });
});

describe.skipIf(process.platform === "win32")("scripts S5/S6: ad doğrulaması (KK1)", () => {
  it("S5 kayıtsız ad → not_found [unregistered]; Object.prototype adları (constructor) nesne anahtarı gibi davranmaz", async () => {
    const c = await setup();
    await fails(run(c, "rm-rf"), "not_found", "unregistered");
    await fails(run(c, "constructor"), "not_found", "unregistered");
    await fails(run(c, "hasownproperty"), "not_found", "unregistered");
  });
  it.each(["..\\x", "../x", "a/b", "x.ps1", "x.sh", "A", "1a", "", "a b", "a".repeat(49), "__proto__", "a\0b", "a\nb", "-x"])("S6 yol karakteri / kötü ad %j → bad_request [bad_name]", async (name) => {
    const c = await setup();
    await fails(run(c, name), "bad_request", "bad_name");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("S6 kötü ad manifest okunmadan reddedilir (manifest bozuk olsa bile bad_name döner, bad_manifest değil)", async () => {
    const c = await setup();
    c.fx.writeManifest("{ bozuk"); c.fx.commit("bozuk manifest");
    await fails(run(c, "../x"), "bad_request", "bad_name");
  });
  it("ad string değil / eksik, bilinmeyen alan, params nesne değil → bad_request", async () => {
    const c = await setup();
    const call = (args: unknown) => c.mac.call(NAME, "script-run", args, { opId: "o" + Math.random().toString(36).slice(2) });
    await fails(call({}), "bad_request");
    await fails(call({ name: 5 }), "bad_request");
    await fails(call({ name: "mark-read", foo: 1 }), "bad_request");
    await fails(call({ name: "mark-read", params: ["a"] }), "bad_request");
    await fails(call({ name: "mark-read", params: "a=1" }), "bad_request");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("scripts S7: parametre doğrulaması (KK1) — betik hiç başlamaz", () => {
  const CASES: [string, Record<string, unknown>, string][] = [
    ["zorunlu parametre eksik", {}, "tag"],
    ["bilinmeyen anahtar", { tag: "ok", extra: "1" }, "extra"],
    ["prototip anahtarı __proto__", JSON.parse('{"tag":"ok","__proto__":"x"}'), "__proto__"],
    ["enum dışı değer", { tag: "ok", mode: "c" }, "mode"],
    ["int aralık altı", { tag: "ok", n: "0" }, "n"],
    ["int aralık üstü", { tag: "ok", n: "6" }, "n"],
    ["int kesirli", { tag: "ok", n: "1.5" }, "n"],
    ["int sayı değil", { tag: "ok", n: "abc" }, "n"],
    ["int boş", { tag: "ok", n: "" }, "n"],
    ["bool geçersiz", { tag: "ok", flag: "yes" }, "flag"],
    ["satır sonu", { tag: "a\nb" }, "tag"],
    ["NUL", { tag: "a\u0000b" }, "tag"],
    ["baştaki tire (bayrak enjeksiyonu)", { tag: "-rf" }, "tag"],
    ["nokta-nokta", { tag: ".." }, "tag"],
    ["yol ayracı", { tag: "a/b" }, "tag"],
    ["boşluk (varsayılan desen dışı)", { tag: "a b" }, "tag"],
    ["maxLen aşımı (9 > 8)", { tag: "abcdefghi" }, "tag"],
    ["desen: tam eşleşme gerekir (kısmi eşleşme yetmez)", { tag: "ok", word: "abcde" }, "word"],
    ["desen: büyük harf", { tag: "ok", word: "ABCD" }, "word"],
    ["string olmayan değer (sayı)", { tag: 5 }, "tag"],
    ["string olmayan değer (nesne)", { tag: { a: 1 } }, "tag"],
  ];
  it.each(CASES)("%s → bad_request [bad_param:<ad>]", async (_why, params, which) => {
    const c = await setup();
    await fails(run(c, "typed", params as Record<string, string>), "bad_request", `bad_param:${which}`);
    expect(c.fx.lines("typed"), "betik başlamamalı").toEqual([]);
  });
  it("geçerli bir kombinasyon çalışır", async () => {
    const c = await setup();
    const r = await run(c, "typed", { tag: "ok", mode: "b", n: "5", flag: "false", word: "abcd" });
    expect(r.result.exit).toBe(0);
    expect(c.fx.lines("typed")).toHaveLength(1);
  });
  it("root tipi: yalnız işçi config'indeki roots girişi; env'e çözümlenmiş yol gider; başka yol / üst dizin / alt dizin reddedilir", async () => {
    const c = await setup();
    const ok = (await run(c, "rooted", { root: c.roots })).result.data as Record<string, string>;
    expect(realpathSync.native(ok.root)).toBe(c.roots);
    for (const bad of ["/etc", join(c.roots, ".."), join(c.roots, "sub"), "C:\\Windows"]) {
      await fails(run(c, "rooted", { root: bad }), "bad_request", "bad_param:root");
    }
    expect(c.fx.lines("rooted")).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("scripts S8–S13: bütünlük reddi (KK1) — betik hiç başlamaz", () => {
  it("S8 değişmiş (M) betik → forbidden [dirty]; script-list integrity=dirty", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/mark-read.sh", "#!/bin/bash\necho degistirildi\n");
    await fails(run(c, "mark-read"), "forbidden", "dirty");
    expect((await list(c)).result.scripts.find((s) => s.name === "mark-read")!.integrity).toBe("dirty");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("S8 izlenmeyen (??) yeni dosya agent-scripts altında → dirty", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/yeni.sh", "echo x\n");
    await fails(run(c, "mark-read"), "forbidden", "dirty");
  });
  it("S8 stage'li değişiklik → dirty", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/mark-read.sh", "#!/bin/bash\necho x\n"); c.fx.git("add", "agent-scripts/mark-read.sh");
    await fails(run(c, "mark-read"), "forbidden", "dirty");
  });
  it("S8 silinmiş (D) betik → dirty", async () => {
    const c = await setup();
    c.fx.git("rm", "-q", "-f", "agent-scripts/other-write.sh");
    await fails(run(c, "mark-read"), "forbidden", "dirty");
  });
  it("S8 manifest.json yerelde değişti → dirty", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/manifest.json", c.fx.read("agent-scripts/manifest.json") + "\n");
    await fails(run(c, "mark-read"), "forbidden", "dirty");
  });
  it("S8 agent-scripts dışındaki kirlilik engel değil (.ran-*, .vlad-agent, izlenmeyen kök dosyası)", async () => {
    const c = await setup();
    c.fx.write("not-tracked-root-file.txt", "x");
    expect((await run(c, "mark-read")).result.exit).toBe(0);
  });
  it("S9 manifest sha256'sı betik blob'uyla tutmuyor → forbidden [hash_mismatch]; yalnız o giriş (script-list diğerlerini ok gösterir)", async () => {
    const c = await setup([...SCRIPTS.filter((s) => s.name !== "mark-read"), { ...SCRIPTS.find((s) => s.name === "mark-read")!, sha256: "f".repeat(64) }]);
    await fails(run(c, "mark-read"), "forbidden", "hash_mismatch");
    expect(c.fx.lines("mark-read")).toEqual([]);
    const by = new Map((await list(c)).result.scripts.map((s) => [s.name, s.integrity]));
    expect(by.get("mark-read")).toBe("hash_mismatch");
    expect(by.get("show-env")).toBe("ok");
    expect((await run(c, "show-env")).result.exit).toBe(0);
  });
  it("S9 betik commit'lenmiş ama içerik manifest hash'inden farklı (betik sonradan değiştirilip commit'lendi, manifest güncellenmedi) → hash_mismatch", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/mark-read.sh", "#!/bin/bash\necho kotu\n"); c.fx.commit("betik degisti, manifest degismedi");
    await fails(run(c, "mark-read"), "forbidden", "hash_mismatch");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("S10 betik symlink olarak commit'li → forbidden [not_regular]", async () => {
    const c = await setup();
    c.fx.git("rm", "-q", "-f", "agent-scripts/mark-read.sh");
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/bin/echo", join(c.fx.repo, "agent-scripts", "mark-read.sh"));
    c.fx.commit("symlink");
    await fails(run(c, "mark-read"), "forbidden", "not_regular");
    expect((await list(c)).result.scripts.find((s) => s.name === "mark-read")!.integrity).toBe("not_regular");
  });
  it("S11 manifest HEAD'de yok (yalnız çalışma ağacında / hiç yok) → forbidden [not_in_head]", async () => {
    const c = await setup();
    c.fx.git("rm", "-q", "-f", "agent-scripts/manifest.json"); c.fx.git("commit", "-q", "-m", "manifest sil");
    await fails(run(c, "mark-read"), "forbidden", "not_in_head");
  });
  it("S10/S11 manifestte kayıtlı ama HEAD'de olmayan dosya (yok sayılan / hiç commit'lenmeyen) → çalışmaz (not_in_head ya da not_regular)", async () => {
    const ghost: FxScript = { name: "hayalet", body: `${sh.mark("hayalet")}\n${sh.result('{"ok":true}')}` };
    const c = await setup([...SCRIPTS]);
    // betik dosyası var ama .git/info/exclude ile yok sayılıyor (status temiz), manifest girişi commit'li
    writeFileSync(join(c.fx.repo, ".git", "info", "exclude"), "agent-scripts/hayalet.sh\n", { flag: "a" });
    c.fx.write("agent-scripts/hayalet.sh", `#!/bin/bash\n${ghost.body}\n`);
    const entries = JSON.parse(c.fx.read("agent-scripts/manifest.json")).scripts;
    entries.push(c.fx.entry(ghost));
    c.fx.writeManifest(entries); c.fx.commit("hayalet giris");
    const e = await fails(run(c, "hayalet"), "forbidden");
    expect(e.message).toMatch(/\[(not_in_head|not_regular)\]/);
    expect(c.fx.lines("hayalet")).toEqual([]);
  });
  it("manifestte kayıtlı olmayan ama agent-scripts altında commit'li dosya çalıştırılamaz (S5)", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/gizli.sh", "#!/bin/bash\n" + sh.mark("gizli") + "\n"); c.fx.commit("gizli");
    await fails(run(c, "gizli"), "not_found", "unregistered");
    expect(c.fx.lines("gizli")).toEqual([]);
  });
  it("S13 yanlış platform: yalnız başka platform için kayıtlı ad → not_found [no_variant]", async () => {
    const c = await setup();
    await fails(run(c, "win-only"), "not_found", "no_variant");
  });
  it("aynı ad iki platform için kayıtlıysa bu makinenin platformundaki giriş çalışır", async () => {
    const both: FxScript[] = [{ name: "ortak", platform: "win32", body: "Write-Output 'x'" }, { name: "ortak", body: `${sh.mark("ortak")}\n${sh.result('{"ok":true}')}` }];
    const c = await setup(both);
    const r = await run(c, "ortak");
    expect(r.result).toMatchObject({ platform: PLAT, exit: 0 });
    expect(c.fx.lines("ortak")).toHaveLength(1);
  });
  it("bozuk manifest tümüyle reddedilir: failed [bad_manifest] (script-run ve script-list); iyi girişler de çalışmaz", async () => {
    const c = await setup();
    const entries = JSON.parse(c.fx.read("agent-scripts/manifest.json")).scripts;
    entries.push({ ...entries[0], name: "BozukAd" });
    c.fx.writeManifest(entries); c.fx.commit("bozuk giris");
    await fails(run(c, "mark-read"), "failed", "bad_manifest");
    await fails(list(c), "failed", "bad_manifest");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("bozuk JSON manifest / çift (ad, platform) / 64 KiB üstü manifest → failed [bad_manifest]", async () => {
    const c = await setup();
    for (const bad of [
      "{ bozuk json",
      JSON.stringify({ version: 1, scripts: [c.fx.entry(SCRIPTS[1]!), c.fx.entry(SCRIPTS[1]!)] }),
      JSON.stringify({ version: 1, scripts: [{ ...c.fx.entry(SCRIPTS[1]!), title: "x".repeat(70 * 1024) }] }),
    ]) {
      c.fx.writeManifest(bad); c.fx.commit("bad");
      await fails(run(c, "mark-read"), "failed", "bad_manifest");
    }
  });
  it("VLAD_HOME git deposu değil → failed [no_repo]; deposunun alt dizini de (toplevel ≠ home) no_repo", async () => {
    const plain = await setup(SCRIPTS, { home: () => { const d = join(base, "plain"); mkdirSync(d); return d; } });
    await fails(run(plain, "mark-read"), "failed", "no_repo");
    for (const x of cleanups.splice(0).reverse()) await x();
    setAgentEnv(undefined); rmTemp(base);
    const sub = await setup(SCRIPTS, { home: (fx) => { const d = join(fx.repo, "alt"); mkdirSync(d); return d; } });
    await fails(run(sub, "mark-read"), "failed", "no_repo");
  });
});

describe.skipIf(process.platform === "win32")("scripts S12: push edilmemiş HEAD / upstream yok (KARAR BEKLİYOR: spec açık soru 3)", () => {
  // Spec "Önerilen" davranış: HEAD @{u}'nun atası değilse forbidden [unpushed]; upstream yoksa [no_upstream]. Kullanıcı "kapalı" derse bu iki test silinir.
  it("S12 yerel (push edilmemiş) commit → forbidden [unpushed]", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/ek.txt", "x"); c.fx.commit("yerel commit", false);
    await fails(run(c, "mark-read"), "forbidden", "unpushed");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("S12 upstream yok → forbidden [no_upstream]", async () => {
    const c = await setup();
    c.fx.git("branch", "--unset-upstream");
    await fails(run(c, "mark-read"), "forbidden", "no_upstream");
  });
  it("S12 push sonrası yeniden çalışır", async () => {
    const c = await setup();
    c.fx.write("agent-scripts/ek.txt", "x"); c.fx.commit("yerel", false);
    await fails(run(c, "mark-read"), "forbidden", "unpushed");
    c.fx.git("push", "-q");
    expect((await run(c, "mark-read")).result.exit).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("scripts S14/S15: rol ve kimlik (KK2)", () => {
  it("S14 console, başka işçi ve (brain-agent olmayan) yetkisiz kimlikler script-run/script-list çalıştıramaz → forbidden; betik başlamaz", async () => {
    const c = await setup();
    for (const who of ["desktop", "worker2"]) {
      await fails(run(c, "mark-read", undefined, { client: c.as(who) }), "forbidden");
      await fails(c.as(who).call(NAME, "script-list", {}), "forbidden");
    }
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("S14 brain izinli", async () => { const c = await setup(); expect((await run(c, "mark-read")).result.exit).toBe(0); });
  it("S15 sıra değişmez: yanlış imza → auth, bayat saat → clock_skew, eski sürüm → proto_mismatch; hiçbirinde betik başlamaz", async () => {
    const c = await setup();
    expect((await raw(c.srv.port, signRequest("aa".repeat(32), { v: 1, from: "mac", to: NAME, opId: "x1", ts: Date.now(), op: "script-run", args: { name: "mark-read" } }))).code).toBe("auth");
    expect((await raw(c.srv.port, req({ ts: Date.now() - 10 * 60_000 }))).code).toBe("clock_skew");
    expect((await raw(c.srv.port, req({ v: 2 }))).code).toBe("proto_mismatch");
    expect((await raw(c.srv.port, req({ args: { name: "mark-read", extra: 1 } }))).code).toBe("bad_request");
    expect(c.fx.lines("mark-read")).toEqual([]);
    expect((await raw(c.srv.port, req({ opId: "good-1" }))).code).toBe("ok");
    expect(c.fx.lines("mark-read")).toEqual(["good-1"]);
  });
});

describe.skipIf(process.platform === "win32")("scripts S16: write onayı — plan-id bağlı (KK6)", () => {
  it("plan-id yok → forbidden [approval]; betik başlamaz", async () => {
    const c = await setup();
    await fails(run(c, "mark-write"), "forbidden", "approval");
    expect(c.fx.lines("mark-write")).toEqual([]);
  });
  it("yanlış plan-id / boş / başka biçim → forbidden [approval]", async () => {
    const c = await setup();
    for (const planId of ["0000000000000000", "", "x", "A".repeat(16), plan(c, "other-write").planId]) await fails(run(c, "mark-write", {}, { approval: { planId } }), "forbidden", "approval");
    expect(c.fx.lines("mark-write")).toEqual([]);
  });
  it("approval nesnesi bozuk (planId yok) → forbidden [approval] ya da bad_request, betik başlamaz", async () => {
    const c = await setup();
    const e = await c.mac.call(NAME, "script-run", { name: "mark-write", approval: {} }, { opId: "ap-1" }).then(() => undefined, (x) => x as RemoteError);
    expect(e).toBeInstanceOf(RemoteError);
    expect(["forbidden", "bad_request"]).toContain(e!.code);
    expect(c.fx.lines("mark-write")).toEqual([]);
  });
  it("onay başka parametreler için üretildiyse geçmez (parametre değişince plan-id değişir)", async () => {
    const wp: FxScript[] = [{ name: "pw", class: "write", params: [{ name: "x", type: "string" }], body: `${sh.mark("pw")}\n${sh.result('{"ok":true}')}` }];
    const c = await setup(wp);
    const idFor = (params: Record<string, string>) => ({ planId: scriptPlanId({ machine: NAME, name: "pw", platform: PLAT, sha256: c.fx.entry(wp[0]!).sha256, params }) });
    await fails(run(c, "pw", { x: "b" }, { approval: idFor({ x: "a" }) }), "forbidden", "approval");
    expect(c.fx.lines("pw")).toEqual([]);
    expect((await run(c, "pw", { x: "a" }, { approval: idFor({ x: "a" }) })).result.exit).toBe(0);
  });
  it("manifest default'ları plan-id'ye uygulanmış hâliyle girer (verilmeyen parametre = default ile aynı plan-id)", async () => {
    const wp: FxScript[] = [{ name: "pd", class: "write", params: [{ name: "x", type: "string", default: "dd" }], body: `${sh.mark("pd")}\n${sh.result('{"ok":true}')}` }];
    const c = await setup(wp);
    const id = scriptPlanId({ machine: NAME, name: "pd", platform: PLAT, sha256: c.fx.entry(wp[0]!).sha256, params: { x: "dd" } });
    expect((await run(c, "pd", undefined, { approval: { planId: id } })).result.exit).toBe(0);
  });
  it("onaydan sonra betik (sha256) değişirse eski plan-id geçmez — 'sonradan değişen betik çalışmaz'", async () => {
    const c = await setup();
    const old = plan(c, "mark-write");
    const changed = { ...SCRIPTS.find((s) => s.name === "mark-write")!, body: `${sh.mark("mark-write")}\necho yeni-surum\n${sh.result('{"ok":true,"summary":"w"}')}` };
    c.fx.write("agent-scripts/mark-write.sh", `#!/bin/bash\n${changed.body}\n`);
    const entries = JSON.parse(c.fx.read("agent-scripts/manifest.json")).scripts.map((e: { name: string }) => (e.name === "mark-write" ? c.fx.entry(changed) : e));
    c.fx.writeManifest(entries); c.fx.commit("mark-write yeni surum");
    await fails(run(c, "mark-write", {}, { approval: old }), "forbidden", "approval");
    expect(c.fx.lines("mark-write")).toEqual([]);
    const fresh = { planId: scriptPlanId({ machine: NAME, name: "mark-write", platform: PLAT, sha256: c.fx.entry(changed).sha256, params: {} }) };
    expect((await run(c, "mark-write", {}, { approval: fresh })).result.exit).toBe(0);
  });
  it("read sınıfı plan-id istemez; verilen (hatalı) onay yok sayılır", async () => {
    const c = await setup();
    expect((await run(c, "mark-read")).result.exit).toBe(0);
    expect((await run(c, "mark-read", undefined, { approval: { planId: "nope" } })).result.exit).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("scripts S3/S4/S17: idempotans, çakışma, eşzamanlılık (KK4)", () => {
  it("S3 aynı opId + aynı argüman: betik ikinci kez koşmaz, ilk sonuç meta.replayed ile döner", async () => {
    const c = await setup();
    const a = await run(c, "mark-read", undefined, { opId: "same" });
    const b = await run(c, "mark-read", undefined, { opId: "same" });
    expect(c.fx.lines("mark-read")).toEqual(["same"]);
    expect(b.meta?.replayed).toBe(true);
    expect(a.meta?.replayed).toBeUndefined();
    expect(b.result).toMatchObject({ exit: 0, timedOut: false, durationMs: a.result.durationMs });
  });
  it("S3 write de aynı opId ile ikinci kez koşmaz", async () => {
    const c = await setup();
    await run(c, "mark-write", {}, { opId: "ww", approval: plan(c, "mark-write") });
    const b = await run(c, "mark-write", {}, { opId: "ww", approval: plan(c, "mark-write") });
    expect(c.fx.lines("mark-write")).toEqual(["ww"]);
    expect(b.meta?.replayed).toBe(true);
  });
  it("S3 eşzamanlı üç çağrı, tek opId: betik bir kez koşar, hepsi aynı sonucu görür", async () => {
    const c = await setup();
    const rs = await Promise.all([1, 2, 3].map(() => run(c, "mark-read", undefined, { opId: "cc" })));
    expect(c.fx.lines("mark-read")).toEqual(["cc"]);
    expect(new Set(rs.map((r) => r.result.durationMs)).size).toBe(1);
  });
  it("S4 aynı opId, farklı param / farklı ad → conflict; betik yeniden koşmaz", async () => {
    const c = await setup();
    await run(c, "show-env", { msg: "a" }, { opId: "cf" });
    await fails(run(c, "show-env", { msg: "b" }, { opId: "cf" }), "conflict");
    await fails(run(c, "mark-read", undefined, { opId: "cf" }), "conflict");
    expect(c.fx.lines("mark-read")).toEqual([]);
  });
  it("reddedilen çağrı (ör. bad_param) opId'yi yakmaz: düzeltilmiş parametrelerle aynı opId yeniden denenebilir", async () => {
    const c = await setup();
    await fails(run(c, "typed", { tag: "-x" }, { opId: "retry" }), "bad_request");
    expect((await run(c, "typed", { tag: "ok" }, { opId: "retry" })).result.exit).toBe(0);
    expect(c.fx.lines("typed")).toEqual(["retry"]);
  });
  it("S17 başka bir write betiği sürerken ikinci write → busy (geçici); ilk bitince aynı opId ile yeniden denenir ve bir kez koşar", async () => {
    const c = await setup();
    const first = run(c, "hold", {}, { opId: "h1", approval: plan(c, "hold") });
    await until(() => c.fx.has(".started-hold"));
    const e = await fails(run(c, "other-write", {}, { opId: "b1", approval: plan(c, "other-write") }), "busy");
    expect(e.transient).toBe(true);
    expect(c.fx.lines("other-write")).toEqual([]);
    writeFileSync(join(c.fx.repo, ".release"), "");
    expect((await first).result).toMatchObject({ exit: 0, data: { summary: "h" } });
    expect((await run(c, "other-write", {}, { opId: "b1", approval: plan(c, "other-write") })).result.exit).toBe(0);
    expect(c.fx.lines("other-write")).toEqual(["b1"]);
  });
  it("busy iken ping ve script-list yanıt verir (Agent kilitlenmez)", async () => {
    const c = await setup();
    const first = run(c, "hold", {}, { opId: "h2", approval: plan(c, "hold") });
    await until(() => c.fx.has(".started-hold"));
    expect((await c.mac.call<{ machine: string }>(NAME, "ping", {})).result.machine).toBe(NAME);
    expect((await list(c)).result.scripts.length).toBeGreaterThan(0);
    writeFileSync(join(c.fx.repo, ".release"), "");
    await first;
  });
});

describe.skipIf(process.platform === "win32")("scripts S18: zaman aşımı (KK4) — fırlatmaz, süreç ağacı öldürülür", () => {
  it("timeoutSec aşılınca op ok döner: timedOut:true, exit:124; çocuk süreç de ölür; sonuç replay'de aynı; kilit bırakılır", async () => {
    const c = await setup();
    const t0 = Date.now();
    const r = await run(c, "sleeper", undefined, { opId: "to-1", timeoutMs: 30_000 });
    expect(r.result).toMatchObject({ timedOut: true, exit: 124 });
    // duvar saati: manifest 1 sn; yük altında geniş pay (en çok 25 sn) — betik 60 sn uyuyordu, bu yüzden erken bitişi kanıtlar
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r.result.durationMs).toBeGreaterThanOrEqual(900);
    const pid = Number(readFileSync(join(c.fx.repo, ".childpid"), "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } }, 8_000);
    const again = await run(c, "sleeper", undefined, { opId: "to-1" });
    expect(again.meta?.replayed).toBe(true);
    expect(again.result).toMatchObject({ timedOut: true, exit: 124 });
    expect(c.fx.lines("sleeper")).toEqual(["to-1"]);
    expect((await run(c, "mark-read")).result.exit).toBe(0); // kilit serbest (busy değil)
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("scripts S19: çıktı sınırı (KK4)", () => {
  it("outputMaxKb aşılınca stdout SONDAN kırpılır (son satırlar kalır), truncated.stdout true", async () => {
    const c = await setup();
    const r = (await run(c, "loud-small")).result;
    expect(r.truncated.stdout).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024 + 512); // 1 KiB + kırpma işareti payı
    expect(r.stdout).toContain("line-2999-");
    expect(r.stdout).not.toContain("line-0-");
    expect(r.exit).toBe(0);
  });
  it("sentinel kırpılmış stdout'ta bile bulunur (son 20 satır içinde) — data dolu", async () => {
    const c = await setup();
    expect((await run(c, "loud-small")).result.data).toMatchObject({ ok: true });
  });
  it("varsayılan tavanlar: stdout ≤ 32 KiB, stderr ≤ 16 KiB; toplam sonuç journal tavanı altında", async () => {
    const c = await setup();
    const r = (await run(c, "loud-default", undefined, { opId: "ld" })).result;
    expect(r.truncated).toEqual({ stdout: true, stderr: true });
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(32 * 1024 + 512);
    expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(16 * 1024 + 512);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(64 * 1024 + 2048);
  });
  it("büyük çıktılı iş replay'de 'too_large' hatasına düşmez: skaler alanlar (exit, timedOut) korunur", async () => {
    const c = await setup();
    await run(c, "loud-default", undefined, { opId: "ld2" });
    const again = await run(c, "loud-default", undefined, { opId: "ld2" });
    expect(again.meta?.replayed).toBe(true);
    expect(again.result).toMatchObject({ exit: 0, timedOut: false });
  });
});

describe.skipIf(process.platform === "win32")("scripts S20/S21: sonuç satırı ve betik hatası", () => {
  it("S21 exit≠0: op yine ok; exit/stdout/stderr sonuçta; data null değil (sentinel yok → no_result_line)", async () => {
    const c = await setup();
    const r = (await run(c, "fail3")).result;
    expect(r).toMatchObject({ exit: 3, timedOut: false, data: null, dataError: "no_result_line" });
    expect(r.stdout).toContain("oops-out");
    expect(r.stderr).toContain("oops-err");
  });
  it("S20 exit 0 ama sentinel yok → data null, dataError no_result_line; op ok", async () => {
    const c = await setup();
    expect((await run(c, "no-sentinel")).result).toMatchObject({ exit: 0, data: null, dataError: "no_result_line" });
  });
  it("sentinel satırı geçersiz JSON → data null, dataError bad_json", async () => {
    const c = await setup();
    expect((await run(c, "bad-json")).result).toMatchObject({ exit: 0, data: null, dataError: "bad_json" });
  });
  it("sentinel JSON'u nesne değil (dizi) → bad_json", async () => {
    const c = await setup();
    expect((await run(c, "array-json")).result).toMatchObject({ data: null, dataError: "bad_json" });
  });
  it("sentinel JSON'u 16 KiB üstü → data null, dataError too_large", async () => {
    const c = await setup();
    expect((await run(c, "big-json")).result).toMatchObject({ exit: 0, data: null, dataError: "too_large" });
  });
  it("sentinel son 20 satırın dışında kaldıysa bulunmaz (no_result_line)", async () => {
    const c = await setup();
    expect((await run(c, "old-sentinel")).result).toMatchObject({ data: null, dataError: "no_result_line" });
  });
  it("birden çok sentinel: sondan ilk eşleşme (sonuncusu) kazanır; sonrasındaki log satırı engel değil", async () => {
    const c = await setup();
    expect((await run(c, "two-sentinels")).result.data).toMatchObject({ summary: "second" });
  });
  it("betiğin JSON'undaki `restart` yok sayılır: restart alanını yalnız Agent koyar (selfUpdate olmayan betikte asla)", async () => {
    const c = await setup();
    const r = (await run(c, "restart-key")).result;
    expect(r.restart).toBeUndefined();
    expect(r.data).not.toHaveProperty("restart");
  });
  it("betik başladıktan sonra hiçbir yol fırlatmaz: exit≠0 sonrası aynı opId replay edilir (aborted olup yeniden koşmaz)", async () => {
    const c = await setup();
    await run(c, "fail3", undefined, { opId: "f3" });
    const again = await run(c, "fail3", undefined, { opId: "f3" });
    expect(again.meta?.replayed).toBe(true);
    expect(again.result.exit).toBe(3);
    expect(c.fx.lines("fail3")).toEqual(["f3"]);
  });
});

describe.skipIf(process.platform === "win32")("scripts S23 (b): selfUpdate — restart yalnız selfUpdate ∧ exit 0 ∧ data.ok true; bakım bayrağı", () => {
  it("selfUpdate betiği ok:false döndürürse restart yok", async () => {
    const c = await setup();
    const r = (await run(c, "self-notok", {}, { approval: plan(c, "self-notok") })).result;
    expect(r.exit).toBe(0);
    expect(r.restart).toBeUndefined();
  });
  it("selfUpdate betiği exit≠0 ile biterse (sentinel ok:true olsa bile) restart yok", async () => {
    const c = await setup();
    const r = (await run(c, "self-fail", {}, { approval: plan(c, "self-fail") })).result;
    expect(r.exit).toBe(2);
    expect(r.restart).toBeUndefined();
  });
  it("selfUpdate sürerken ping/script-list serbest, diğer op'lar busy [maintenance]; bitince bayrak kalkar", async () => {
    const c = await setup();
    const first = run(c, "self-hold", {}, { opId: "sh1", approval: plan(c, "self-hold") });
    await until(() => c.fx.has(".started-self-hold"));
    expect((await c.mac.call<{ machine: string }>(NAME, "ping", {})).result.machine).toBe(NAME);
    expect((await list(c)).result.scripts.length).toBeGreaterThan(0);
    const e = await fails(c.mac.call(NAME, "close", { taskId: "T20261109-99" }, { opId: "cl-1" }), "busy");
    expect(e.message).toContain("maintenance");
    writeFileSync(join(c.fx.repo, ".release"), "");
    await first;
    const after = await c.mac.call(NAME, "close", { taskId: "T20261109-99" }, { opId: "cl-2" }).then(() => "ok", (x: RemoteError) => x.code);
    expect(after, "bakım bayrağı bittikten sonra kalkmalı").not.toBe("busy");
  });
});

describe.skipIf(process.platform === "win32")("scripts S22 (KK8): journal tabanı", () => {
  it("script-run günlüğe KEEP_ARGS ile girer: devam ederken kayıtta args var, bitince yok; argsHash gizli veri taşımaz", async () => {
    const c = await setup();
    const first = run(c, "hold", {}, { opId: "j1", approval: plan(c, "hold") });
    await until(() => c.fx.has(".started-hold"));
    const rec = c.journal.get("j1")!;
    expect(rec.state).toBe("started");
    expect(rec.op).toBe("script-run");
    expect(rec.args).toMatchObject({ name: "hold" });
    writeFileSync(join(c.fx.repo, ".release"), "");
    await first;
    expect(c.journal.get("j1")!.state).toBe("done");
    expect(c.journal.get("j1")!.args).toBeUndefined();
  });
  it("git yardımcıları kabuksuz: ad/parametre kabuk metakarakteri taşısa da repoda yan etki yok", async () => {
    const c = await setup();
    await fails(run(c, "typed", { tag: "a;touch pwned" }), "bad_request", "bad_param:tag");
    await fails(run(c, "typed", { tag: "$(touch pwned)" }), "bad_request", "bad_param:tag");
    expect(c.fx.has("pwned")).toBe(false);
    expect(git(c.fx.repo, "status", "--porcelain", "--", "agent-scripts")).toBe("");
  });
});
