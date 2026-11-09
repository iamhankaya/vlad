import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptList, scriptRun, type ScriptDeps } from "../../src/agent/ops/script.js";
import { Journal } from "../../src/agent/journal.js";
import { reconcile } from "../../src/agent/reconcile.js";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import { RemoteError, SCRIPT_RESULT_SENTINEL, type Os, type ScriptEntry } from "../../src/fleet/types.js";
import { entryOf, makeRepo, manifestJson, scriptRepo, sha256, symlinkIn, type Fixture } from "./script-fixture.js";

// script-list / script-run op'ları (T20261109-07): gerçek geçici git deposu, gerçek bash (POSIX). Windows'ta bash testleri atlanır.

const OS: Os = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
const posix = it.skipIf(process.platform === "win32");
const made: string[] = [];
const state = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-st-"))); made.push(d); return d; };
const fixtures: Fixture[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); for (const f of fixtures.splice(0)) rmSync(f.dir, { recursive: true, force: true }); });

const deps = (f: Fixture, o: Partial<ScriptDeps> = {}): ScriptDeps => ({ home: f.dir, platform: OS, machine: "win", roots: ["/r1", "/r2"], stateDir: state(), env: { PATH: process.env.PATH ?? "" }, ...o });
const repo = (content: string, o: Partial<ScriptEntry> = {}) => { const f = scriptRepo(OS, "x", content, o); fixtures.push(f); return f; };
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as RemoteError; } throw new Error("fırlatmadı"); };
const ctx = { opId: "op-1" };

describe("script-list", () => {
  it("yalnız bu platformun girişleri, integrity ile", async () => {
    const other: Os = OS === "darwin" ? "linux" : "darwin";
    const mine = entryOf(OS, "x", "a"), foreign = entryOf(other, "y", "b");
    const f = makeRepo({ "agent-scripts/manifest.json": manifestJson(mine, foreign), [mine.file]: "a" });
    fixtures.push(f); f.withUpstream();
    const r = await scriptList({}, deps(f));
    expect(r.platform).toBe(OS);
    expect(r.scripts.map((s) => [s.name, s.integrity])).toEqual([["x", "ok"]]);
  });
  it("hash tutmayan girişin integrity'si hash_mismatch; agent-scripts kirliyse hepsi dirty", async () => {
    const f = repo("echo a\n", { sha256: sha256("başka") });
    expect((await scriptList({}, deps(f))).scripts[0]!.integrity).toBe("hash_mismatch");
    f.write("agent-scripts/yeni.sh", "x");
    expect((await scriptList({}, deps(f))).scripts[0]!.integrity).toBe("dirty");
  });
  it("bilinmeyen argüman alanı bad_request", async () => {
    expect((await fail(scriptList({ x: 1 }, deps(repo("a"))))).code).toBe("bad_request");
  });
});

describe("script-run: ad ve kayıt", () => {
  it("geçersiz adlar bad_request [bad_name]; manifest hiç okunmaz (home geçersiz olsa da)", async () => {
    const d = { ...deps(repo("a")), home: "/yok/boyle/bir/yer" };
    for (const name of ["rm -rf", "..\\x", "a/b", "x.ps1", "a\0b", "A", "", "a".repeat(49), "__proto__", 5 as never]) {
      const e = await fail(scriptRun({ name }, d, ctx));
      expect(e.code, String(name)).toBe("bad_request");
      expect(e.message, String(name)).toContain("[bad_name]");
    }
  });
  it("kayıtsız ad → not_found [unregistered]; yalnız başka platformda varsa → [no_variant]", async () => {
    const other: Os = OS === "darwin" ? "linux" : "darwin";
    const mine = entryOf(OS, "x", "a"), foreign = entryOf(other, "y", "b");
    const f = makeRepo({ "agent-scripts/manifest.json": manifestJson(mine, foreign), [mine.file]: "a", [foreign.file]: "b" });
    fixtures.push(f); f.withUpstream();
    const e1 = await fail(scriptRun({ name: "zzz" }, deps(f), ctx));
    expect([e1.code, /\[unregistered\]/.test(e1.message)]).toEqual(["not_found", true]);
    const e2 = await fail(scriptRun({ name: "y" }, deps(f), ctx));
    expect([e2.code, /\[no_variant\]/.test(e2.message)]).toEqual(["not_found", true]);
  });
  it("bilinmeyen istek alanı (ör. yol) bad_request", async () => {
    expect((await fail(scriptRun({ name: "x", file: "/etc/passwd" }, deps(repo("a")), ctx))).code).toBe("bad_request");
  });
});

describe("script-run: parametreler", () => {
  const withParams = (params: ScriptEntry["params"]) => repo("echo a\n", { params });
  it("bilinmeyen, eksik zorunlu ve root dışı değer → bad_request [bad_param:<ad>]", async () => {
    const f = withParams([{ name: "need", type: "string", required: true }, { name: "root", type: "root" }]);
    const d = deps(f);
    for (const [p, name] of [[{}, "need"], [{ need: "a", zzz: "1" }, "zzz"], [{ need: "a", root: "/baska" }, "root"]] as const) {
      const e = await fail(scriptRun({ name: "x", params: p }, d, ctx));
      expect(e.code).toBe("bad_request");
      expect(e.message).toContain(`[bad_param:${name}]`);
    }
  });
  posix("geçerli parametre env'den gelir; root config'teki listeden", async () => {
    const f = repo('echo "n=$VLAD_PARAM_NEED r=$VLAD_PARAM_ROOT"\n', { params: [{ name: "need", type: "string", required: true }, { name: "root", type: "root" }] });
    const r = await scriptRun({ name: "x", params: { need: "a1", root: "/r2" } }, deps(f), ctx);
    expect(r.stdout.trim()).toBe("n=a1 r=/r2");
  });
});

describe("script-run: bütünlük", () => {
  it("agent-scripts kirli → forbidden [dirty]", async () => {
    const f = repo("echo a\n");
    f.write("agent-scripts/x.sh", "echo EVIL\n");
    const e = await fail(scriptRun({ name: "x" }, deps(f), ctx));
    expect([e.code, /\[dirty\]/.test(e.message)]).toEqual(["forbidden", true]);
  });
  it("manifest hash'i tutmuyor → forbidden [hash_mismatch]", async () => {
    const e = await fail(scriptRun({ name: "x" }, deps(repo("echo a\n", { sha256: sha256("b") })), ctx));
    expect([e.code, /\[hash_mismatch\]/.test(e.message)]).toEqual(["forbidden", true]);
  });
  it("symlink betik → forbidden [not_regular]", async () => {
    const f = repo("echo a\n");
    symlinkIn(f, "agent-scripts/ln.sh", "x.sh");
    const m = entryOf(OS, "ln", "echo a\n");
    f.write("agent-scripts/manifest.json", manifestJson(f.entry, m));
    f.commit("ln"); f.git("push", "-q");
    const e = await fail(scriptRun({ name: "ln" }, deps(f), ctx));
    expect([e.code, /\[not_regular\]/.test(e.message)]).toEqual(["forbidden", true]);
  });
  it("betik HEAD'de yok → forbidden [not_in_head]", async () => {
    const f = repo("echo a\n");
    f.write("agent-scripts/manifest.json", manifestJson(f.entry, entryOf(OS, "gizli", "x")));
    f.commit("m"); f.git("push", "-q"); // betik dosyası commit'lenmedi: manifest var, blob yok
    const e = await fail(scriptRun({ name: "gizli" }, deps(f), ctx));
    expect([e.code, /\[not_in_head\]/.test(e.message)]).toEqual(["forbidden", true]);
  });
  it("itilmemiş HEAD → [unpushed]; upstream yok → [no_upstream]; requirePushed=false ile geçer", async () => {
    const f = repo("echo a\n");
    f.commit("yerel");
    expect((await fail(scriptRun({ name: "x" }, deps(f), ctx))).message).toContain("[unpushed]");
    const ge = entryOf(OS, "x", "true\n");
    const g = makeRepo({ "agent-scripts/manifest.json": manifestJson(ge), [ge.file]: "true\n" });
    fixtures.push(g);
    expect((await fail(scriptRun({ name: "x" }, deps(g), ctx))).message).toContain("[no_upstream]");
    if (process.platform !== "win32") expect((await scriptRun({ name: "x" }, deps(g, { requirePushed: false }), ctx)).exit).toBe(0);
  });
});

describe("script-run: write onayı (plan-id)", () => {
  const params = [{ name: "m", type: "string" as const, required: false }];
  const mk = () => repo("echo yapildi\n", { class: "write", params });
  const plan = (f: ReturnType<typeof mk>, p: Record<string, string> = {}) => scriptPlanId({ machine: "win", name: "x", platform: OS, sha256: f.entry.sha256, params: p });
  it("onay yok ya da yanlış plan-id → forbidden [approval], betik başlamaz", async () => {
    const f = mk();
    for (const approval of [undefined, { planId: "0123456789abcdef" }, { planId: plan(f, { m: "farkli" }) }]) {
      const e = await fail(scriptRun({ name: "x", params: { m: "a" }, ...(approval ? { approval } : {}) }, deps(f), ctx));
      expect([e.code, /\[approval\]/.test(e.message)]).toEqual(["forbidden", true]);
    }
  });
  posix("doğru plan-id ile çalışır; read sınıfı onay istemez", async () => {
    const f = mk();
    const r = await scriptRun({ name: "x", params: { m: "a" }, approval: { planId: plan(f, { m: "a" }) } }, deps(f), ctx);
    expect(r).toMatchObject({ exit: 0, name: "x", platform: OS, sha256: f.entry.sha256, head: f.head });
    const rd = repo("echo oku\n");
    expect((await scriptRun({ name: "x" }, deps(rd), ctx)).stdout.trim()).toBe("oku");
  });
  it("approval biçimi bozuksa bad_request", async () => {
    expect((await fail(scriptRun({ name: "x", approval: { planId: "a", extra: 1 } }, deps(mk()), ctx))).code).toBe("bad_request");
  });
});

describe("script-run: çalıştırma sonucu", () => {
  posix("betik hatası, sentinel ve süre sonuç alanıdır; fırlatmaz", async () => {
    const f = repo(`echo '${SCRIPT_RESULT_SENTINEL} {"ok":false,"summary":"x"}'; exit 7\n`);
    const r = await scriptRun({ name: "x" }, deps(f), ctx);
    expect(r).toMatchObject({ exit: 7, timedOut: false, data: { ok: false, summary: "x" } });
  });
  posix("zaman aşımı: exit 124, timedOut, fırlatmaz", async () => {
    const f = repo("sleep 30\n", { timeoutSec: 1 });
    const r = await scriptRun({ name: "x" }, deps(f), ctx);
    expect(r).toMatchObject({ exit: 124, timedOut: true });
  });
  posix("tek seferde tek betik: sürerken ikinci çağrı busy, bitince tekrar çalışır", async () => {
    const f = repo("sleep 1\n", { timeoutSec: 20 });
    const first = scriptRun({ name: "x" }, deps(f), { opId: "a" });
    await new Promise((r) => setTimeout(r, 300));
    const e = await fail(scriptRun({ name: "x" }, deps(f), { opId: "b" }));
    expect([e.code, e.transient]).toEqual(["busy", true]);
    await first;
    expect((await scriptRun({ name: "x" }, deps(f), { opId: "c" })).exit).toBe(0);
  });
  posix("çalışan bayt'lar HEAD blob'udur: betik çalışırken değişse de etkilenmez", async () => {
    const f = repo("sleep 1; echo ilk\n");
    const run = scriptRun({ name: "x" }, deps(f), ctx);
    await new Promise((r) => setTimeout(r, 200));
    f.write("agent-scripts/x.sh", "echo EVIL\n");
    expect((await run).stdout.trim()).toBe("ilk");
  });
});

describe("script-run uzlaştırması", () => {
  it("started kalan script-run (read dahil) done+uncertain olur; mevcut HEAD'e güvenilmez", () => {
    const j = new Journal(join(state(), "j.jsonl"), () => 1);
    j.start("o1", "mac", "script-run", "h", { name: "oku" });
    reconcile(j, {});
    expect(j.get("o1")).toMatchObject({ state: "done", meta: { uncertain: true } });
  });
});
