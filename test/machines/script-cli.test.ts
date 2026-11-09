import { describe, expect, it } from "vitest";
import { RemoteError, type AgentOp, type RemoteTransport, type ScriptInfo, type ScriptListResult, type ScriptRunResult } from "../../src/fleet/types.js";
import { scriptPlanId } from "../../src/agent/scripts/manifest.js";
import { formatPlan, formatRun, formatScripts, parseParamFlags, runRemoteScript, stripCtl } from "../../src/machines/script-cli.js";

// `vlad machine scripts|run` mantığı (T20261109-07): sahte taşıma ile çağrı sırası, plan-id ve hata biçimleri.

const H = "a".repeat(64);
const info = (o: Partial<ScriptInfo> = {}): ScriptInfo => ({
  name: "repo-guncelle", title: "Repo güncelle", platform: "win32", file: "agent-scripts/repo-guncelle.ps1", sha256: H, class: "write",
  timeoutSec: 900, outputMaxKb: 32, selfUpdate: false, params: [{ name: "root", type: "root", required: false }, { name: "n", type: "int", default: 3 }], integrity: "ok", ...o,
});
const list = (...s: ScriptInfo[]): ScriptListResult => ({ head: "b".repeat(40), platform: "win32", scripts: s });
const res = (o: Partial<ScriptRunResult> = {}): ScriptRunResult => ({
  name: "repo-guncelle", platform: "win32", head: "b".repeat(40), sha256: H, exit: 0, timedOut: false, durationMs: 5, stdout: "tamam\n", stderr: "",
  truncated: { stdout: false, stderr: false }, data: { ok: true, summary: "7 repo" }, ...o,
});

function fake(l: ScriptListResult, run: (args: unknown) => ScriptRunResult | Error = () => res()) {
  const calls: { to: string; op: AgentOp; args: unknown; o?: { opId?: string; timeoutMs?: number } }[] = [];
  const t: RemoteTransport = {
    async call(to, op, args, o) {
      calls.push({ to, op, args, o });
      if (op === "script-list") return { opId: "l", result: l as never };
      const r = run(args);
      if (r instanceof Error) throw r;
      return { opId: o?.opId ?? "r", result: r as never, meta: { replayed: false } };
    },
  };
  return { t, calls };
}

describe("parseParamFlags", () => {
  it("ilk '=' böler; boş değere izin verir", () => {
    expect(parseParamFlags(["a=1", "b=x=y", "c="])).toEqual({ a: "1", b: "x=y", c: "" });
    expect(parseParamFlags(undefined)).toEqual({});
  });
  it("kopya anahtar ve '=' içermeyen değer reddedilir", () => {
    expect(() => parseParamFlags(["a=1", "a=2"])).toThrow(/kopya/);
    expect(() => parseParamFlags(["a"])).toThrow(/k=v/);
    expect(() => parseParamFlags(["=1"])).toThrow(/k=v/);
  });
});

describe("runRemoteScript", () => {
  it("--plan: yalnız script-list çağrılır; betik, sürüm, sınıf, çözümlenmiş parametreler ve plan-id döner", async () => {
    const { t, calls } = fake(list(info()));
    const r = await runRemoteScript(t, "windows", "repo-guncelle", { params: { root: "C:\\dev" }, plan: true });
    expect(calls.map((c) => c.op)).toEqual(["script-list"]);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.params).toEqual({ root: "C:\\dev", n: "3" });
    expect(r.planId).toBe(scriptPlanId({ machine: "windows", name: "repo-guncelle", platform: "win32", sha256: H, params: { root: "C:\\dev", n: "3" } }));
    expect(r).toMatchObject({ class: "write", sha256: H, name: "repo-guncelle" });
  });
  it("belirsiz tekrar (sonuçsuz yanıt) TypeError değil uncertain RemoteError verir", async () => {
    const t: RemoteTransport = { async call(_to, op, _a, o) { return op === "script-list" ? { opId: "l", result: list(info({ class: "read" })) as never } : { opId: o?.opId ?? "r", meta: { replayed: true, uncertain: true } } as never; } };
    const e = await runRemoteScript(t, "windows", "repo-guncelle", { params: {}, opId: "op-9" }).catch((x) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect(e.code).toBe("uncertain");
    expect(e.message).toContain("op-9");
  });
  it("write sınıfı --confirmed olmadan çağrı yapmaz (önce --plan)", async () => {
    const { t, calls } = fake(list(info()));
    await expect(runRemoteScript(t, "windows", "repo-guncelle", { params: {} })).rejects.toThrow(/--plan/);
    expect(calls.map((c) => c.op)).toEqual(["script-list"]);
  });
  it("write + --confirmed: script-run ham parametreler ve approval ile, zaman aşımı = timeoutSec + 30 sn, verilen opId", async () => {
    const { t, calls } = fake(list(info()));
    const r = await runRemoteScript(t, "windows", "repo-guncelle", { params: { root: "C:\\dev" }, confirmed: "0123456789abcdef", opId: "op-9" });
    expect(calls.map((c) => c.op)).toEqual(["script-list", "script-run"]);
    expect(calls[1]).toMatchObject({ to: "windows", args: { name: "repo-guncelle", params: { root: "C:\\dev" }, approval: { planId: "0123456789abcdef" } }, o: { opId: "op-9", timeoutMs: 930_000 } });
    expect(r).toMatchObject({ kind: "result", opId: "op-9", result: { exit: 0 } });
  });
  it("read sınıfı onay istemez, --confirmed verilse bile approval göndermez", async () => {
    const { t, calls } = fake(list(info({ class: "read" })));
    await runRemoteScript(t, "windows", "repo-guncelle", { params: {}, confirmed: "0123456789abcdef" });
    expect(calls[1]!.args).toEqual({ name: "repo-guncelle", params: {} });
    expect(typeof calls[1]!.o?.opId).toBe("string");
  });
  it("kayıtsız betik adı ve yerel parametre ihlali çağrı yapmadan hata", async () => {
    const { t, calls } = fake(list(info()));
    await expect(runRemoteScript(t, "windows", "yok", { params: {} })).rejects.toThrow(/kayıtlı betik değil/);
    await expect(runRemoteScript(t, "windows", "repo-guncelle", { params: { n: "abc" }, plan: true })).rejects.toThrow(/bad_param:n/);
    expect(calls.every((c) => c.op === "script-list")).toBe(true);
  });
  it("zaman aşımında hata kodu korunur ve aynı --op-id ile tekrar önerilir", async () => {
    const { t } = fake(list(info({ class: "read" })), () => new RemoteError("timeout", "timeout: windows yanıt vermedi", "windows"));
    const e = await runRemoteScript(t, "windows", "repo-guncelle", { params: {}, opId: "op-7" }).catch((x: RemoteError) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect((e as RemoteError).code).toBe("timeout");
    expect((e as RemoteError).message).toMatch(/--op-id op-7/);
  });
  it("busy gibi diğer RemoteError'lar aynen yükselir", async () => {
    const { t } = fake(list(info({ class: "read" })), () => new RemoteError("busy", "busy: x", "windows"));
    const e = await runRemoteScript(t, "windows", "repo-guncelle", { params: {} }).catch((x: RemoteError) => x);
    expect((e as RemoteError).code).toBe("busy");
    expect((e as RemoteError).message).toBe("busy: x");
  });
});

describe("formatScripts", () => {
  it("ad, sınıf, parametreler, süre, kısa sha ve integrity; integrity≠ok uyarılır", () => {
    const txt = formatScripts(list(info(), info({ name: "baska", integrity: "hash_mismatch", class: "read", params: [] })));
    expect(txt).toContain("repo-guncelle");
    expect(txt).toContain("write");
    expect(txt).toContain("root?");
    expect(txt).toContain("aaaaaaaa");
    expect(txt).toMatch(/baska[^\n]*hash_mismatch[^\n]*UYARI/);
    expect(txt.split("\n").find((l) => l.startsWith("repo-guncelle"))).not.toContain("UYARI");
  });
  it("kayıtlı betik yoksa bunu söyler", () => {
    expect(formatScripts(list())).toMatch(/kayıtlı betik yok/);
  });
});

describe("stripCtl / formatRun", () => {
  it("ESC ve kontrol karakterleri ayıklanır; \n ve \t kalır, tek \r satır başı olur", () => {
    expect(stripCtl("a\x1b[31mkırmızı\x1b]0;başlık\x07b\tc\nd\re\0")).toBe("a[31mkırmızı]0;başlıkb\tc\nd\ne");
  });
  it("formatRun uzak çıktının kontrol karakterlerini terminale taşımaz", () => {
    const out = formatRun({ kind: "result", opId: "o", replayed: false, uncertain: false, result: res({ stdout: "x\x1b[2Jy\n", data: null }) });
    expect(out).not.toContain("\x1b");
  });
});

describe("formatPlan: önerilen onay komutu yerel kabuğa göre tırnaklanır (Codex P2)", () => {
  const plan = (params: Record<string, string>) => ({ kind: "plan" as const, machine: "windows", name: "repo-guncelle", platform: "win32" as const, head: "b".repeat(40), sha256: H, class: "write" as const, integrity: "ok" as const, timeoutSec: 900, params, planId: "p".repeat(16) });
  const cmd = (t: string) => t.split("\n").find((l) => l.startsWith("onaydan sonra:"))!;
  it("POSIX: tek tırnak; ters bölü ve boşluk bölünmez, gömülü tek tırnak kaçar", () => {
    expect(cmd(formatPlan(plan({ root: "C:\\dev" }), "darwin"))).toContain("--param 'root=C:\\dev'");
    expect(cmd(formatPlan(plan({ root: "/a b/c" }), "darwin"))).toContain("--param 'root=/a b/c'");
    expect(cmd(formatPlan(plan({ x: "it's" }), "darwin"))).toContain("--param 'x=it'\\''s'");
  });
  it("Windows: çift tırnak", () => {
    expect(cmd(formatPlan(plan({ root: "C:\\my dev" }), "win32"))).toContain('--param "root=C:\\my dev"');
  });
  it("güvenli değerler tırnaksız kalır", () => {
    expect(cmd(formatPlan(plan({ n: "3" }), "darwin"))).toContain("--param n=3 --confirmed");
  });
});
